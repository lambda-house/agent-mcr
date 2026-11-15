//! Hosted terminals, app side. Terminal bytes go straight to the runner;
//! sessions, their state and resuming go through the harness service. The
//! webview starts sessions only from launch profiles — never raw argv — in a directory the
//! user opened, a directory from session history, or the home folder
//! (docs/AGENT_HARNESS_DESIGN.md, 05 · Trust).

use crate::harness;
use crate::runner::{self, Client};
use crate::session_commands::SessionState;
use crate::AccessState;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

const MAX_PASTED_IMAGE: usize = 30 * 1024 * 1024;

#[derive(Default)]
pub struct HarnessState {
    views: Mutex<BTreeMap<u64, UnixStream>>,
    next_view: AtomicU64,
}

fn socket() -> Result<PathBuf, String> {
    crate::get_config_dir().map(|d| d.join("runner.sock")).map_err(|e| e.message)
}

fn config_dir() -> Result<PathBuf, String> {
    crate::get_config_dir().map_err(|e| e.message)
}

/// Socket I/O off the async runtime (and never on the main thread).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Terminal plumbing goes straight to the runner.
fn call(req: Value) -> Result<Value, String> {
    let socket = socket()?;
    runner::ensure(&socket)?;
    Client::connect(&socket)?.call(req)
}

/// Sessions, their state and resuming go through the harness service.
fn service(req: Value) -> Result<Value, String> {
    harness::call(&config_dir()?, req)
}

#[tauri::command]
pub async fn harness_status() -> Result<Value, String> {
    blocking(|| {
        let hello = runner::ensure(&socket()?)?;
        let service = harness::ensure(&config_dir()?)?;
        let home = dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default();
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string();
        // What the user runs once to give an outside agent the supervisor tools
        let supervisor = format!("claude mcp add --scope user agent-mcr-supervisor -- '{}' --supervise", exe.replace('\'', "'\\''"));
        Ok(json!({ "runner": hello, "service": service, "profiles": harness::PROFILES, "home": home, "supervisorCommand": supervisor }))
    })
    .await
}

#[tauri::command]
pub async fn harness_list() -> Result<Value, String> {
    blocking(|| service(json!({"op": "sessions"}))).await
}

/// Earlier Claude and Codex sessions that can continue here (ids, folders, times).
#[tauri::command]
pub async fn harness_resumable(access: State<'_, AccessState>) -> Result<Value, String> {
    if !access.access.lock().map(|a| a.session_workspace).unwrap_or(false) {
        return Err("Turn on the Sessions workspace to resume earlier sessions".into());
    }
    blocking(|| service(json!({"op": "resumable", "days": 7}))).await
}

#[tauri::command]
pub async fn harness_ack(id: String) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || service(json!({"op": "ack", "id": id})).map(drop)).await
}

#[tauri::command]
pub async fn harness_spawn(
    profile: String,
    cwd: String,
    cols: u16,
    rows: u16,
    resume: Option<String>,
    access: State<'_, AccessState>,
    sessions: State<'_, SessionState>,
) -> Result<Value, String> {
    // Resuming: the service takes the agent and the folder from the transcript itself
    if let Some(id) = resume.filter(|r| !r.is_empty()) {
        if !access.access.lock().map(|a| a.session_workspace).unwrap_or(false) {
            return Err("Turn on the Sessions workspace to resume earlier sessions".into());
        }
        return blocking(move || service(json!({"op": "create", "resume": id, "cols": cols, "rows": rows}))).await;
    }
    let dir = dunce::canonicalize(&cwd).map_err(|e| format!("{cwd}: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }
    let home = dirs::home_dir().and_then(|h| dunce::canonicalize(h).ok());
    let known = access.may_list(&dir)
        || home.as_deref() == Some(dir.as_path())
        || sessions.index.lock().map(|i| i.knows_directory(&dir)).unwrap_or(false);
    if !known {
        return Err("Start sessions in a folder you opened, your home folder, or a folder an agent worked in".into());
    }
    blocking(move || service(json!({"op": "create", "profile": profile, "cwd": dir.display().to_string(), "cols": cols, "rows": rows}))).await
}

/// Open the hosted supervisor session (the running one, or a new one).
#[tauri::command]
pub async fn harness_supervisor(cols: u16, rows: u16) -> Result<Value, String> {
    blocking(move || service(json!({"op": "supervisor", "cols": cols, "rows": rows}))).await
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid session id".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn harness_signal(id: String, signal: String) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || call(json!({"op": "signal", "id": id, "signal": signal})).map(drop)).await
}

#[tauri::command]
pub async fn harness_forget(id: String) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || call(json!({"op": "forget", "id": id})).map(drop)).await
}

#[tauri::command]
pub async fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || call(json!({"op": "resize", "id": id, "cols": cols, "rows": rows})).map(drop)).await
}

/// Attach a view: output (scrollback, then live) arrives on `output` as raw
/// bytes; an empty message means the stream ended. Returns the view handle
/// used for input and detaching.
#[tauri::command]
pub async fn terminal_attach(id: String, output: Channel<InvokeResponseBody>, state: State<'_, HarnessState>) -> Result<u64, String> {
    valid_id(&id)?;
    let (mut reader, writer) = blocking(move || {
        let socket = socket()?;
        runner::ensure(&socket)?;
        runner::open_stream(&socket, json!({"op": "attach", "id": id}))
    })
    .await?;
    let handle = state.next_view.fetch_add(1, Ordering::SeqCst) + 1;
    state.views.lock().map_err(|_| "View state unavailable")?.insert(handle, writer);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if output.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = output.send(InvokeResponseBody::Raw(Vec::new()));
    });
    Ok(handle)
}

#[tauri::command]
pub fn terminal_input(view: u64, data: String, state: State<'_, HarnessState>) -> Result<(), String> {
    let mut views = state.views.lock().map_err(|_| "View state unavailable")?;
    let stream = views.get_mut(&view).ok_or("The terminal is detached")?;
    if let Err(e) = stream.write_all(data.as_bytes()) {
        views.remove(&view);
        return Err(format!("The terminal is detached: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_detach(view: u64, state: State<'_, HarnessState>) {
    if let Ok(mut views) = state.views.lock() {
        if let Some(stream) = views.remove(&view) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// An image pasted into a terminal: saved under the cache dir, and its path
/// is what gets typed (agents accept image paths). Raw request body; the
/// session id travels in the `session` header.
#[tauri::command]
pub fn terminal_save_image(request: Request<'_>) -> Result<String, String> {
    let id = request.headers().get("session").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    valid_id(&id)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected image bytes".into());
    };
    if bytes.len() > MAX_PASTED_IMAGE {
        return Err("The image is larger than 30 MB".into());
    }
    let ext = image_extension(bytes).ok_or("Not a PNG, JPEG, GIF or WebP image")?;
    // ~/Library/Caches has no space in its path (Application Support does), so
    // the typed path needs no quoting in most agents' prompts.
    let dir = dirs::cache_dir().ok_or("Cache directory unavailable")?.join("agent-mcr/attachments").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let path = dir.join(format!("pasted-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_images_are_recognised_by_content() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_extension(b"#!/bin/sh"), None);
        assert!(valid_id("../etc").is_err());
    }
}
