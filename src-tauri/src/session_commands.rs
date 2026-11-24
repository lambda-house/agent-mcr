use crate::{sessions, AccessState};

use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
pub struct SessionState {
    pub index: Arc<Mutex<sessions::Index>>,
    journal: Arc<Mutex<JournalStamps>>,
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
    let journal = state.journal.clone();
    let cache = crate::get_config_dir()
        .map_err(|e| e.message)?
        .join("sessions/index.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index
            .lock()
            .map_err(|_| "Index lock poisoned".to_string())?;
        journal.lock().map_err(|_| "Journal lock poisoned")?.0.clear();
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
/// What the Journal asks every few seconds: the snapshot, or nothing when its
/// content has the stamp the Journal already holds (MCR-141). The whole
/// snapshot was 2.9 MB of JSON on the owner's Mac, parsed by the web view
/// every five seconds while the Journal was shown, almost always unchanged.
#[derive(serde::Serialize)]
pub struct SnapshotSince {
    pub stamp: String,
    pub snapshot: Option<sessions::Snapshot>,
}

/// A digest of what a snapshot shows, without the scan's own figures (the
/// time it ran, the bytes it read), which change at every scan.
pub fn stamp(snapshot: &sessions::Snapshot) -> String {
    let shown = (&snapshot.sessions, &snapshot.errors, snapshot.pending_files, snapshot.scanned_files, &snapshot.cache_path, &snapshot.current_directory);
    let mut digest = std::io::BufWriter::new(Sha256::new());
    let result = serde_json::to_writer(&mut digest, &shown).and_then(|()|
        digest.into_inner().map_err(|e| serde_json::Error::io(e.into_error())));
    stamp_hex(result.unwrap_or_default())
}

fn stamp_hex(digest: Sha256) -> String {
    digest.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// The snapshot to send for a holder of `held`: none when nothing it shows changed.
pub fn since(snapshot: sessions::Snapshot, held: Option<&str>) -> SnapshotSince {
    let stamp = stamp(&snapshot);
    let snapshot = (held != Some(stamp.as_str())).then_some(snapshot);
    SnapshotSince { stamp, snapshot }
}

/// `sessions_snapshot` for a reader that holds one: the same scan, answered
/// with the stamp alone when nothing changed.
#[tauri::command]
pub async fn sessions_snapshot_since(
    stamp: Option<String>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<SnapshotSince, String> {
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
        Ok(since(i.scan(&home, None), stamp.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct JournalSince {
    stamp: String,
    snapshot: Option<sessions::Snapshot>,
    /// In a delta, the positions of the supplied sessions in the new snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    positions: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    removed: Vec<String>,
}

type RowStamps = HashMap<String, [u8; 32]>;

/// Recent revisions retain only source paths and hashes, never summaries or events.
#[derive(Default)]
struct JournalStamps(VecDeque<(String, RowStamps)>);

impl JournalStamps {
    fn since(&mut self, mut snapshot: sessions::Snapshot, held: Option<&str>) -> Result<JournalSince, serde_json::Error> {
        let mut rows = RowStamps::with_capacity(snapshot.sessions.len());
        let mut encoded = Vec::new();
        let mut digest = Sha256::new();
        for session in &snapshot.sessions {
            encoded.clear();
            serde_json::to_writer(&mut encoded, session)?;
            let hash: [u8; 32] = Sha256::digest(&encoded).into();
            digest.update(hash);
            rows.insert(session.source.clone(), hash);
        }
        serde_json::to_writer(&mut digest, &(
            &snapshot.errors, snapshot.pending_files, snapshot.scanned_files,
            &snapshot.cache_path, &snapshot.current_directory,
        ))?;
        let stamp = stamp_hex(digest);
        let mut positions = None;
        let mut removed = Vec::new();
        // The scan has one row per source file. If two paths stringify to the
        // same source, send a full snapshot so both rows survive the update.
        if rows.len() == snapshot.sessions.len() {
            if held == Some(stamp.as_str()) {
                return Ok(JournalSince { stamp, snapshot: None, positions, removed });
            }
            if let Some((_, prior)) = self.0.iter().find(|(key, _)| Some(key.as_str()) == held) {
                removed.extend(prior.keys().filter(|source| !rows.contains_key(*source)).cloned());
                removed.sort_unstable();
                let changed = positions.insert(Vec::new());
                snapshot.sessions = snapshot.sessions.into_iter().enumerate().filter_map(|(position, session)| {
                    if prior.get(&session.source) != rows.get(&session.source) {
                        changed.push(position);
                        Some(session)
                    } else {
                        None
                    }
                }).collect();
            }
            if !self.0.iter().any(|(key, _)| *key == stamp) {
                const RETAINED_REVISIONS: usize = 4;
                if self.0.len() >= RETAINED_REVISIONS {
                    self.0.pop_front();
                }
                self.0.push_back((stamp.clone(), rows));
            }
        }
        Ok(JournalSince { stamp, snapshot: Some(snapshot), positions, removed })
    }
}

/// Journal polling with an additive delta response. An absent or evicted
/// stamp starts from a full snapshot, including after an app restart.
#[tauri::command]
pub async fn sessions_journal_since(
    stamp: Option<String>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<JournalSince, String> {
    allowed(&access)?;
    let index = state.index.clone();
    let journal = state.journal.clone();
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let cache = crate::get_config_dir().map_err(|e| e.message)?.join("sessions/index.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = index.lock().map_err(|_| "Index lock poisoned".to_string())?;
        i.open_cache(&cache)?;
        journal.lock().map_err(|_| "Journal lock poisoned")?
            .since(i.scan(&home, None), stamp.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Most sessions one `sessions_pick` call names: the Live list's hosted ones.
pub const MAX_PICKED: usize = 200;

/// Whether a session is one of the `provider:id` keys.
pub fn named(keys: &std::collections::HashSet<String>) -> impl Fn(&sessions::Session) -> bool + '_ {
    move |s| keys.contains(&format!("{}:{}", s.provider, s.id))
}

/// The same scan as `sessions_snapshot`, answered with the named sessions only
/// (MCR-139). The Live list colours its few hosted rows by their prompt cache;
/// the whole snapshot (1,221 sessions, 2.9 MB of JSON on the owner's Mac) sent
/// every ten seconds for that was parsed and dropped by the web view each time.
#[tauri::command]
pub async fn sessions_pick(
    keys: Vec<String>,
    access: State<'_, AccessState>,
    state: State<'_, SessionState>,
) -> Result<Vec<sessions::Session>, String> {
    allowed(&access)?;
    if keys.len() > MAX_PICKED {
        return Err(format!("At most {MAX_PICKED} sessions at a time"));
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
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
        // Only the named sessions are summarised; the scan still brings the whole index up to date
        let keys: std::collections::HashSet<String> = keys.into_iter().collect();
        Ok(i.scan_where(&home, None, named(&keys)).sessions)
    })
    .await
    .map_err(|e| e.to_string())?
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
            .detail(&provider, &id)?
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
                    .summary_of(&provider, &id)
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
        let session=if let (Some(provider),Some(id))=(provider,id) {Some(index.lock().map_err(|_|"Index lock poisoned")?.summary_of(&provider,&id).ok_or("Session not indexed")?)}else{None};
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
    if document.provenance != key || std::path::Path::new(&key).extension().is_none_or(|ext| ext != "md") {
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

#[cfg(test)]
mod picked_tests {
    use super::{named, JournalStamps};
    use crate::sessions::{Session, Snapshot};

    fn session(provider: &str, id: &str) -> Session {
        let mut s = Session::default();
        s.provider = provider.into();
        s.id = id.into();
        s.source = format!("/home/w/{provider}/{id}.jsonl");
        s
    }

    fn snapshot(sessions: Vec<Session>, indexed_at: u64, bytes_read: u64) -> Snapshot {
        Snapshot {
            sessions, errors: Vec::new(), scanned_files: 2, indexed_at, pending_files: 0,
            cache_path: None, restored_files: 0, bytes_read, current_directory: "/home/w".into(),
        }
    }

    #[test]
    fn a_snapshot_is_sent_again_only_when_what_it_shows_changed() {
        use super::since;
        let first = since(snapshot(vec![session("claude", "a")], 1, 10), None);
        assert!(first.snapshot.is_some());
        // Another scan, nothing new: the scan's own figures do not count
        let again = since(snapshot(vec![session("claude", "a")], 2, 99), Some(&first.stamp));
        assert_eq!(again.stamp, first.stamp);
        assert!(again.snapshot.is_none());
        // A changed session is sent
        let mut changed = session("claude", "a");
        changed.title = "new title".into();
        let next = since(snapshot(vec![changed], 3, 10), Some(&first.stamp));
        assert_ne!(next.stamp, first.stamp);
        assert!(next.snapshot.is_some());
        // A holder of an unknown stamp gets it all
        assert!(since(snapshot(vec![session("claude", "a")], 4, 10), Some("old")).snapshot.is_some());
    }

    #[test]
    fn journal_sends_only_updates_and_removals_against_a_held_revision() {
        let mut journal = JournalStamps::default();
        let a = session("claude", "a");
        let b = session("codex", "b");
        let c = session("codex", "c");
        let initial = journal.since(snapshot(vec![a.clone(), b.clone(), c.clone()], 1, 10), None).unwrap();
        assert!(initial.positions.is_none());
        assert_eq!(initial.snapshot.unwrap().sessions.len(), 3);
        let held = Some(initial.stamp.as_str());
        let unchanged = journal.since(snapshot(vec![a.clone(), b.clone(), c.clone()], 2, 0), held).unwrap();
        assert_eq!(unchanged.stamp, initial.stamp);
        assert!(unchanged.snapshot.is_none());

        let mut b = b;
        b.modified = 3;
        let delta = journal.since(snapshot(vec![b.clone(), a.clone()], 3, 10), held).unwrap();
        assert_eq!(delta.positions, Some(vec![0]));
        assert_eq!(delta.removed, vec![c.source]);
        let changed = delta.snapshot.unwrap().sessions;
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].source, b.source);
        assert_eq!(changed[0].modified, 3);

        let mut metadata = snapshot(vec![b, a], 4, 0);
        metadata.pending_files = 1;
        let delta = journal.since(metadata, Some(&delta.stamp)).unwrap();
        assert_eq!(delta.positions, Some(vec![]));
        assert_eq!(delta.snapshot.unwrap().pending_files, 1);
    }

    #[test]
    fn journal_resets_after_a_stamp_is_evicted() {
        let mut journal = JournalStamps::default();
        let mut a = session("codex", "a");
        let initial = journal.since(snapshot(vec![a.clone()], 1, 10), None).unwrap();
        for modified in 1..=4 {
            a.modified = modified;
            journal.since(snapshot(vec![a.clone()], modified, 10), None).unwrap();
        }
        let reset = journal.since(snapshot(vec![a], 5, 0), Some(&initial.stamp)).unwrap();
        assert!(reset.positions.is_none());
        assert_eq!(reset.snapshot.unwrap().sessions[0].modified, 4);
    }

    #[test]
    fn picks_only_the_named_sessions_by_provider_and_id() {
        let all = [session("claude", "a"), session("codex", "a"), session("claude", "b"), session("claude", "c")];
        let keys: std::collections::HashSet<String> = ["claude:a", "claude:c", "codex:zz"].map(String::from).into();
        let got: Vec<String> = all.iter().filter(|s| named(&keys)(s)).map(|s| format!("{}:{}", s.provider, s.id)).collect();
        assert_eq!(got, vec!["claude:a", "claude:c"]);
        assert!(!named(&std::collections::HashSet::new())(&session("claude", "a")));
    }
}
