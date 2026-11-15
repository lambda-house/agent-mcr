use crate::{sessions, AccessState};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
pub struct SessionState {
    pub index: Arc<Mutex<sessions::Index>>,
}
fn allowed(access: &AccessState) -> Result<(), String> {
    if access
        .access
        .lock()
        .map_err(|_| "Access lock poisoned")?
        .session_workspace
    {
        Ok(())
    } else {
        Err("Enable session access first".into())
    }
}
#[tauri::command]
pub fn session_access(access: State<'_, AccessState>) -> bool {
    access
        .access
        .lock()
        .map(|a| a.session_workspace)
        .unwrap_or(false)
}
#[tauri::command]
pub async fn enable_sessions(
    app: AppHandle,
    access: State<'_, AccessState>,
) -> Result<bool, String> {
    let confirmed=app.dialog().message("Read Codex and Claude session transcripts on this machine?\n\nSessions shows messages, tool activity and token counts for recorded workspaces on this machine. A private local SQLite index retains parsed activity and checkpoints across restarts. Transcript files are never modified. Credentials and agent settings are not read. Remote ticket and memory requests happen only when you use their connection controls.")
        .title("Enable Sessions").buttons(MessageDialogButtons::OkCancel).blocking_show();
    if confirmed {
        let mut a = access.access.lock().map_err(|_| "Access lock poisoned")?;
        a.session_workspace = true;
        access.save(&a);
    }
    Ok(confirmed)
}
#[tauri::command]
pub async fn disable_sessions(
    analysis: State<'_, crate::session_analysis_commands::AnalysisState>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<(), String> {
    {
        let mut a = access.access.lock().map_err(|_| "Access lock poisoned")?;
        a.session_workspace = false;
        a.session_memories = false;
        access.save(&a);
    }
    analysis.0.revoke();
    let index = state.index.clone();
    let cache = crate::get_config_dir()
        .map_err(|e| e.message)?
        .join("sessions/index.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index
            .lock()
            .map_err(|_| "Index lock poisoned".to_string())?;
        i.open_cache(&cache)?;
        i.clear_cache()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sessions_snapshot(
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<sessions::Snapshot, String> {
    allowed(&access)?;
    let index = state.index.clone();
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let cache = crate::get_config_dir()
        .map_err(|e| e.message)?
        .join("sessions/index.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index
            .lock()
            .map_err(|_| "Index lock poisoned".to_string())?;
        i.open_cache(&cache)?;
        Ok(i.scan(&home, None))
    })
    .await
    .map_err(|e| e.to_string())?
}
// Connect ONLY to the existing daemon. Never start/resume another writer against a live transcript.
#[cfg(unix)]
fn codex_request(method: &str, params: Value) -> Result<Value, String> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    let path = dirs::home_dir()
        .ok_or("Home directory unavailable")?
        .join(".codex/app-server-control/app-server-control.sock");
    let mut socket =
        UnixStream::connect(path).map_err(|e| format!("Codex control unavailable: {e}"))?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
    fn receive(reader: &mut BufReader<UnixStream>, id: u64) -> Result<Value, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            let mut line = Vec::new();
            reader
                .by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("Codex control: {e}"))?;
            if line.last() != Some(&b'\n') {
                return Err("Codex closed the connection or sent an oversized response".into());
            }
            let v: Value = serde_json::from_slice(&line).map_err(|_| "Invalid Codex response")?;
            if v["id"] == id {
                if v.get("error").is_some() {
                    return Err(format!("Codex rejected request: {}", v["error"]));
                }
                return Ok(v["result"].clone());
            }
        }
        Err("Codex request timed out".into())
    }
    writeln!(socket,"{}",json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_mcr","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}})).map_err(|e|e.to_string())?;
    receive(&mut reader, 1)?;
    writeln!(socket, "{}", json!({"method":"initialized"})).map_err(|e| e.to_string())?;
    writeln!(
        socket,
        "{}",
        json!({"id":2,"method":method,"params":params})
    )
    .map_err(|e| e.to_string())?;
    receive(&mut reader, 2)
}
#[cfg(not(unix))]
fn codex_request(_: &str, _: Value) -> Result<Value, String> {
    Err("Existing-daemon control is currently supported on macOS and Linux".into())
}
#[tauri::command]
pub async fn session_control(
    action: String,
    id: String,
    turn_id: Option<String>,
    text: Option<String>,
    app: AppHandle,
    access: State<'_, AccessState>,
) -> Result<Value, String> {
    allowed(&access)?;
    if action == "inspect" {
        return tauri::async_runtime::spawn_blocking(move || {
            codex_request("thread/read", json!({"threadId":id,"includeTurns":false}))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if !["steer", "interrupt"].contains(&action.as_str()) {
        return Err("Unsupported control action".into());
    }
    let turn = turn_id
        .filter(|s| !s.is_empty())
        .ok_or("No observed turn id; refresh this session first")?;
    let text = text.unwrap_or_default();
    if action == "steer" && (text.trim().is_empty() || text.len() > 16000) {
        return Err("Enter an instruction of 1–16000 bytes".into());
    }
    let mut dialog = app
        .dialog()
        .message(format!(
            "{} session {}\nTurn {}\n\n{}",
            action,
            id,
            turn,
            if action == "steer" {
                &text
            } else {
                "Interrupt the current turn"
            }
        ))
        .title("Direct this Codex session")
        .buttons(MessageDialogButtons::OkCancel);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.parent(&w);
    }
    if !dialog.blocking_show() {
        return Err("Cancelled; nothing sent".into());
    }
    tauri::async_runtime::spawn_blocking(move|| {
        let current=codex_request("thread/read",json!({"threadId":id,"includeTurns":false}))?;
        if current["thread"]["status"]["type"]!="active" {return Err("Session is not active in this daemon; nothing sent".into());}
        if action=="steer" {codex_request("turn/steer",json!({"threadId":id,"expectedTurnId":turn,"input":[{"type":"text","text":text,"text_elements":[]}]}))}
        else {codex_request("turn/interrupt",json!({"threadId":id,"turnId":turn}))}
    }).await.map_err(|e|e.to_string())?
}

/// Usage, tools and context figures of one session, for the Live view's
/// stats pane. Same grant as the Sessions workspace; no transcript text.
#[tauri::command]
pub async fn session_stats(
    provider: String,
    id: String,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<sessions::Session, String> {
    allowed(&access)?;
    let index = state.index.clone();
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let cache = crate::get_config_dir().map_err(|e| e.message)?.join("sessions/index.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index.lock().map_err(|_| "Index lock poisoned".to_string())?;
        i.open_cache(&cache)?;
        // Newest transcripts are read first, so a live session is current after one pass
        i.scan(&home, None);
        i.summary_of(&provider, &id).ok_or_else(|| "Not indexed yet".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_details(
    provider: String,
    id: String,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<sessions::Session, String> {
    allowed(&access)?;
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        index
            .lock()
            .map_err(|_| "Index lock poisoned".to_string())?
            .detail(&provider, &id)
            .ok_or_else(|| "Session no longer indexed".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_events(
    provider: String,
    id: String,
    before: u64,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<Vec<sessions::Event>, String> {
    allowed(&access)?;
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index
            .lock()
            .map_err(|_| "Index lock poisoned".to_string())?;
        if let Some(events) = i.cached_events(&provider, &id, before)? {
            return Ok(events);
        }
        let path = i.source(&provider, &id)?;
        drop(i);
        sessions::events_before(&path, &provider, before)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn session_memory_access(access: State<'_, AccessState>) -> bool {
    access
        .access
        .lock()
        .map(|a| a.session_workspace && a.session_memories)
        .unwrap_or(false)
}
#[tauri::command]
pub async fn enable_session_memories(
    app: AppHandle,
    access: State<'_, AccessState>,
) -> Result<bool, String> {
    allowed(&access)?;
    let confirmed=app.dialog().message("Show agent memory?\n\nRead user-wide memory/instruction Markdown, memory and instructions associated with recorded project directories, and Codex thread-linked memories from ~/.codex/memories_1.sqlite. Files and databases are read-only. Credentials and agent settings are excluded. Session-scoped and shared memories are labelled separately.").title("Enable memory views").buttons(MessageDialogButtons::OkCancel).blocking_show();
    if confirmed {
        let mut a = access.access.lock().map_err(|_| "Access lock poisoned")?;
        a.session_memories = true;
        access.save(&a);
    }
    Ok(confirmed)
}
fn memory_allowed(access: &AccessState) -> Result<(), String> {
    allowed(access)?;
    if access
        .access
        .lock()
        .map_err(|_| "Access lock poisoned")?
        .session_memories
    {
        Ok(())
    } else {
        Err("Enable memory access first".into())
    }
}
#[tauri::command]
pub async fn session_memories(
    provider: Option<String>,
    id: Option<String>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<crate::session_memory::Catalog, String> {
    memory_allowed(&access)?;
    let index = state.index.clone();
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = if let (Some(provider), Some(id)) = (provider, id) {
            Some(
                index
                    .lock()
                    .map_err(|_| "Index lock poisoned")?
                    .detail(&provider, &id)
                    .ok_or("Session not indexed")?,
            )
        } else {
            None
        };
        Ok(crate::session_memory::catalog(&home, session.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn read_session_memory(
    key: String,
    provider: Option<String>,
    id: Option<String>,
    open_in_documents: Option<bool>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<crate::session_memory::MemoryDocument, String> {
    memory_allowed(&access)?;
    let index = state.index.clone();
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let opened_key = key.clone();
    let document = tauri::async_runtime::spawn_blocking(move|| {
        let session=if let (Some(provider),Some(id))=(provider,id) {Some(index.lock().map_err(|_|"Index lock poisoned")?.detail(&provider,&id).ok_or("Session not indexed")?)}else{None};
        if key=="transcript-memory" {
            let s=session.ok_or("Select a session")?;
            let events=index.lock().map_err(|_|"Index lock poisoned")?.memory_events(&s.provider,&s.id)?;
            return Ok(crate::session_memory::MemoryDocument{title:"Recorded session memory context".into(),content:events.iter().map(|e|format!("## {} · {}\n\n{}",e.at,e.tool.as_deref().unwrap_or("compaction summary"),e.text)).collect::<Vec<_>>().join("\n\n"),provenance:s.source,note:"Latest 200 recorded memory-tool calls and compaction summaries. Tool calls do not establish successful memory writes.".into()});
        }
        crate::session_memory::read(&home,session.as_ref(),&key)
    }).await.map_err(|e|e.to_string())??;
    memory_allowed(&access)?;
    // A clicked Markdown catalog entry is a user-opened document, just like a
    // file selected in the picker. Grant that file so images and tab restore use
    // the existing reader. Generated context never grants its backing DB/log.
    if open_in_documents == Some(true)
        && document.provenance == opened_key
        && std::path::Path::new(&opened_key).extension().is_some_and(|ext| ext == "md")
    {
        access.grant([&opened_key]);
    }
    Ok(document)
}

fn memory_window_location(path: &str) -> (String, std::path::PathBuf) {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    let label = format!("memory-{:016x}", hash.finish());
    let mut url = tauri::Url::parse("tauri://localhost/index.html").expect("static app URL");
    url.query_pairs_mut().append_pair("memoryDocument", path);
    (label, format!("index.html?{}", url.query().unwrap_or_default()).into())
}

#[tauri::command]
pub async fn open_session_memory_window(
    app: AppHandle,
    key: String,
    provider: Option<String>,
    id: Option<String>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<(), String> {
    let document = read_session_memory(key.clone(), provider, id, Some(true), access, state).await?;
    if document.provenance != key || !std::path::Path::new(&key).extension().is_some_and(|ext| ext == "md") {
        return Err("Only Markdown memory files can open in a document window".into());
    }
    let path = std::fs::canonicalize(&key).map_err(|e| e.to_string())?;
    let (label, url) = memory_window_location(&path.to_string_lossy());
    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url))
        .title(format!("{} — Agent MCR", document.title))
        .inner_size(1000.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod memory_window_tests {
    use super::memory_window_location;

    #[test]
    fn file_routes_encode_paths_and_reuse_only_the_same_document() {
        let path = "/Users/test/memory/notes #1 & память?.md";
        let (label, route) = memory_window_location(path);
        assert_eq!(memory_window_location(path).0, label);
        assert_ne!(memory_window_location("/other/MEMORY.md").0, label);
        assert!(label.starts_with("memory-"));
        let url = tauri::Url::parse("tauri://localhost/").unwrap().join(route.to_str().unwrap()).unwrap();
        assert_eq!(url.path(), "/index.html");
        assert_eq!(url.fragment(), None);
        assert_eq!(url.query_pairs().collect::<Vec<_>>(), vec![("memoryDocument".into(), path.into())]);
    }
}
