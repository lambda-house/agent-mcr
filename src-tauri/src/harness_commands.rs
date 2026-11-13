//! Hosted terminals, app side (delivery step 1, before the harness service
//! exists): the app talks to the runner directly. The webview starts sessions
//! only from launch profiles held here — never raw argv — in a directory the
//! user opened, a directory from session history, or the home folder
//! (docs/AGENT_HARNESS_DESIGN.md, 05 · Trust).

use crate::runner::{self, Client};
use crate::session_commands::SessionState;
use crate::AccessState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    id: &'static str,
    label: &'static str,
    /// What runs inside the user's login shell
    command: &'static str,
}

/// D7: agents start in their own permission modes that keep prompts to shell
/// commands and network access.
const PROFILES: &[Profile] = &[
    Profile { id: "claude", label: "Claude Code", command: "claude --permission-mode acceptEdits" },
    Profile { id: "codex", label: "Codex", command: "codex --sandbox workspace-write --ask-for-approval on-request" },
    Profile { id: "shell", label: "Shell", command: "" },
];

fn socket() -> Result<PathBuf, String> {
    crate::get_config_dir().map(|d| d.join("runner.sock")).map_err(|e| e.message)
}

/// The user's login shell from the account database: GUI apps and launchd
/// jobs don't reliably have `$SHELL`.
fn login_shell() -> String {
    // SAFETY: getpwuid returns a pointer into static storage or null; we copy
    // the string out immediately and don't call it concurrently from here.
    let from_passwd = unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            None
        } else {
            std::ffi::CStr::from_ptr((*pw).pw_shell).to_str().ok().map(str::to_owned)
        }
    };
    from_passwd
        .filter(|s| Path::new(s).is_file())
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".into())
}

/// Every profile runs in a login shell, so agents see the PATH, keys and
/// version managers the user has in Terminal.
pub fn argv_for(profile: &str) -> Result<Vec<String>, String> {
    let p = PROFILES.iter().find(|p| p.id == profile).ok_or_else(|| format!("Unknown profile {profile}"))?;
    let shell = login_shell();
    Ok(if p.command.is_empty() {
        vec![shell, "-l".into()]
    } else {
        vec![shell, "-l".into(), "-i".into(), "-c".into(), format!("exec {}", p.command)]
    })
}

/// Socket I/O off the async runtime (and never on the main thread).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn call(req: Value) -> Result<Value, String> {
    let socket = socket()?;
    runner::ensure(&socket)?;
    Client::connect(&socket)?.call(req)
}

#[tauri::command]
pub async fn harness_status() -> Result<Value, String> {
    blocking(|| {
        let hello = runner::ensure(&socket()?)?;
        let home = dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default();
        Ok(json!({ "runner": hello, "profiles": PROFILES, "home": home }))
    })
    .await
}

#[tauri::command]
pub async fn harness_list() -> Result<Value, String> {
    blocking(|| call(json!({"op": "list"}))).await
}

#[tauri::command]
pub async fn harness_spawn(
    profile: String,
    cwd: String,
    cols: u16,
    rows: u16,
    access: State<'_, AccessState>,
    sessions: State<'_, SessionState>,
) -> Result<Value, String> {
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
    let argv = argv_for(&profile)?;
    let label = PROFILES.iter().find(|p| p.id == profile).map(|p| p.label).unwrap_or_default();
    blocking(move || {
        call(json!({
            "op": "spawn",
            "argv": argv,
            "cwd": dir.display().to_string(),
            "env": { "AGENT_MCR_PROFILE": profile },
            "meta": { "profile": profile, "label": label },
            "cols": cols,
            "rows": rows,
        }))
    })
    .await
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
    fn profiles_run_in_a_login_shell_with_their_permission_modes() {
        let claude = argv_for("claude").unwrap();
        assert_eq!(&claude[1..4], &["-l", "-i", "-c"]);
        assert_eq!(claude[4], "exec claude --permission-mode acceptEdits");
        assert!(argv_for("codex").unwrap()[4].contains("--sandbox workspace-write"));
        assert_eq!(argv_for("shell").unwrap()[1..], ["-l"]);
        assert!(argv_for("rm -rf /").is_err());
    }

    #[test]
    fn pasted_images_are_recognised_by_content() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_extension(b"#!/bin/sh"), None);
        assert!(valid_id("../etc").is_err());
    }
}
