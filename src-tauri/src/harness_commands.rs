//! Hosted terminals, app side. Terminal bytes go straight to the runner;
//! sessions, their state and resuming go through the harness service. The
//! webview starts sessions only from launch profiles — never raw argv — in a directory the
//! user opened, a directory from session history, or the home folder
//! (docs/AGENT_HARNESS_DESIGN.md, 05 · Trust).

use crate::harness;
use crate::ipc::Stream;
use crate::runner::{self, Client};
use crate::session_commands::SessionState;
use crate::AccessState;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Pasted images are removed after two weeks, at the next paste
const PASTED_IMAGE_KEPT: std::time::Duration = std::time::Duration::from_secs(14 * 86_400);
const MAX_PASTED_IMAGE: usize = 30 * 1024 * 1024;

#[derive(Default)]
pub struct HarnessState {
    views: Mutex<BTreeMap<u64, (Stream, String)>>,
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
        let service_info = harness::ensure(&config_dir()?)?;
        let home = dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default();
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string();
        // What the user runs once to give an outside agent the supervisor tools
        let supervisor = format!("claude mcp add --scope user agent-mcr-supervisor -- '{}' --supervise", exe.replace('\'', "'\\''"));
        let settings = service(json!({"op": "settings"}))?;
        // The service can outlive an app update and return an older settings shape.
        let preferences = crate::harness_preferences::HarnessPreferences::load(&config_dir()?)?;
        Ok(json!({ "runner": hello, "service": service_info, "profiles": preferences.profiles(), "supervisorProfile": preferences.supervisor_profile, "home": home, "supervisorCommand": supervisor, "outsideSupervisors": settings["outsideSupervisors"] }))
    })
    .await
}

#[tauri::command]
pub async fn harness_preferences(app: tauri::AppHandle, preferences: Option<crate::harness_preferences::HarnessPreferences>) -> Result<Value, String> {
    blocking(move || {
        if let Some(next) = &preferences {
            let current = crate::harness_preferences::HarnessPreferences::load(&config_dir()?)?;
            if next.supervisor_profile != current.supervisor_profile {
                if let Some(profile) = next.supervisor_profile.as_deref() {
                    let label = crate::agents::profiles().into_iter().find(|p| p.id == profile).map(|p| p.label).unwrap_or(profile);
                    let message = format!(
                        "Use {label} for the next Supervisor session?\n\nThe Supervisor session can create, inspect, and manage agent sessions in Agent MCR. Only choose a harness you trust with those tools."
                    );
                    if !confirmed(&app, "Change Supervisor harness?", message, "Change Supervisor", true) {
                        return Ok(json!({
                            "profiles": crate::agents::profiles(),
                            "enabledProfiles": current.enabled_profiles,
                            "supervisorProfile": current.supervisor_profile,
                        }));
                    }
                }
            }
        }
        service(json!({"op": "harness_preferences", "preferences": preferences}))
    })
    .await
}

/// The background processes and whether the person allowed them. Starts nothing.
#[tauri::command]
pub async fn harness_background() -> Result<Value, String> {
    blocking(|| Ok(harness::background(&config_dir()?))).await
}

fn confirmed(app: &tauri::AppHandle, title: &str, message: String, ok: &str, warn: bool) -> bool {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(if warn { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::OkCancelCustom(ok.to_string(), "Cancel".to_string()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.blocking_show()
}

/// Allow the runner and the harness service to be installed and started.
/// Asked in a native dialog, never granted by the page alone.
#[tauri::command]
pub async fn harness_background_allow(app: tauri::AppHandle) -> Result<bool, String> {
    blocking(move || {
        let dir = config_dir()?;
        if runner::consent(&dir) != Some(true) {
            let message = "Agent MCR runs your agents in two background processes of its own, so they keep working when you close or update the app:\n\n\u{2022} the runner holds the terminals\n\u{2022} the harness service tracks sessions and gives agents their tools\n\nmacOS starts them through two files in ~/Library/LaunchAgents and may show a \"Background Items Added\" notice. They listen only on sockets private to your user, never on the network, and exit on their own ten minutes after the last session ends.\n\nYou can see, stop and remove them at any time under Background in the Live view.";
            if !confirmed(&app, "Let Agent MCR run in the background?", message.to_string(), "Allow", false) {
                return Ok(false);
            }
            runner::set_consent(&dir, true)?;
        }
        Ok(true)
    })
    .await
}

/// The person's off switch: end every session and both background processes;
/// with `uninstall`, remove their LaunchAgent files as well.
#[tauri::command]
pub async fn harness_background_stop(app: tauri::AppHandle, uninstall: bool) -> Result<bool, String> {
    blocking(move || {
        let dir = config_dir()?;
        let live = harness::live_sessions(&dir).len();
        let sessions = match live {
            0 => "No session is running.".to_string(),
            1 => "1 running session will be ended; unsaved work in it is lost.".to_string(),
            n => format!("{n} running sessions will be ended; unsaved work in them is lost."),
        };
        let (title, rest, ok) = if uninstall {
            ("Remove Agent MCR's background items?", "The runner and the harness service are stopped and their two files in ~/Library/LaunchAgents are removed. Session history and settings stay; to remove those too, delete ~/Library/Application Support/agent-mcr after quitting.", "Stop and Remove")
        } else {
            ("Stop all sessions and background processes?", "The runner and the harness service are stopped. Nothing starts them again until you allow it here.", "Stop Everything")
        };
        if !confirmed(&app, title, format!("{sessions}\n\n{rest}"), ok, true) {
            return Ok(false);
        }
        harness::stop_background(&dir, true, uninstall)?;
        Ok(true)
    })
    .await
}

/// Quit from the menu. Sessions keep running by design: say so when there are
/// any, and offer to stop them. Nothing is asked when none runs.
pub fn quit(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Manager;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
        const KEEP: &str = "Quit";
        const STOP: &str = "Quit and Stop Them";
        let dir = config_dir().ok();
        let live = dir.as_deref().map(|d| harness::live_sessions(d).len()).unwrap_or(0);
        if live > 0 {
            let message = format!(
                "{} in the background after Agent MCR quits. Open the app again to see {}.",
                if live == 1 { "1 session keeps running".to_string() } else { format!("{live} sessions keep running") },
                if live == 1 { "it" } else { "them" }
            );
            let mut dialog = app
                .dialog()
                .message(message)
                .title("Quit Agent MCR?")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::YesNoCancelCustom(KEEP.to_string(), STOP.to_string(), "Cancel".to_string()));
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.parent(&window);
            }
            match dialog.blocking_show_with_result() {
                MessageDialogResult::Yes => {}
                MessageDialogResult::Custom(choice) if choice == KEEP => {}
                MessageDialogResult::No => stop_for_quit(dir.as_deref()),
                MessageDialogResult::Custom(choice) if choice == STOP => stop_for_quit(dir.as_deref()),
                _ => return,
            }
        }
        app.exit(0);
    });
}

/// The permission to run in the background stays: the next launch starts as usual.
fn stop_for_quit(dir: Option<&std::path::Path>) {
    if let Some(dir) = dir {
        if let Err(e) = harness::stop_background(dir, false, false) {
            eprintln!("{e}");
        }
    }
}

/// Let agents outside the harness use the supervisor tools, or stop that.
/// Turning it on is confirmed in a native dialog, never by the page alone.
#[tauri::command]
pub async fn harness_outside_supervisors(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    blocking(move || {
        if on {
            let mut dialog = app
                .dialog()
                .message("Any agent you run outside Agent MCR and connect with the supervisor command will be able to start, read, direct and end every hosted session.\n\nA program started by a hosted agent that detaches from its session counts as outside too. Leave this off while agents work in folders you don't trust.")
                .title("Give outside agents the supervisor tools?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Allow".to_string(), "Cancel".to_string()));
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.parent(&window);
            }
            if !dialog.blocking_show() {
                return Ok(false);
            }
        }
        service(json!({"op": "settings", "outsideSupervisors": on})).map(|s| s["outsideSupervisors"] == true)
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
    blocking(|| service(json!({"op": "resumable", "days": 14}))).await
}

/// What sessions reported to the person, and the live notes of the bulletin board.
#[tauri::command]
pub async fn harness_board() -> Result<Value, String> {
    blocking(|| service(json!({"op": "board"}))).await
}

/// A note from the person on the bulletin board: `folder` empty means every session.
#[tauri::command]
pub async fn harness_note_post(text: String, hours: u64, folder: Option<String>) -> Result<(), String> {
    blocking(move || service(json!({"op": "note_post", "text": text, "hours": hours, "folder": folder.unwrap_or_default()})).map(drop)).await
}

#[tauri::command]
pub async fn harness_note_remove(note: String) -> Result<(), String> {
    valid_id(&note)?;
    blocking(move || service(json!({"op": "note_remove", "note": note})).map(drop)).await
}

#[tauri::command]
pub async fn harness_ack(id: String, since: Option<u64>) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || service(json!({"op": "ack", "id": id, "since": since})).map(drop)).await
}

// One argument per field the page sends: Tauri passes them by name
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn harness_spawn(
    profile: String,
    cwd: String,
    cols: u16,
    rows: u16,
    resume: Option<String>,
    supervisor: Option<String>,
    access: State<'_, AccessState>,
    sessions: State<'_, SessionState>,
) -> Result<Value, String> {
    // The session the new one works for (MCR-41): an id the service checks
    let supervisor = supervisor.filter(|s| !s.is_empty());
    if let Some(id) = &supervisor {
        valid_id(id)?;
    }
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
    blocking(move || service(json!({"op": "create", "profile": profile, "cwd": dir.display().to_string(), "cols": cols, "rows": rows, "supervisor": supervisor, "role": if supervisor.is_some() { "executor" } else { "" }}))).await
}

/// Connect a running session to a supervising one, or detach it (`supervisor` empty).
/// Connecting gives the supervising session tools over the other, so the person is asked.
#[tauri::command]
pub async fn harness_bind(app: tauri::AppHandle, id: String, supervisor: Option<String>) -> Result<Value, String> {
    valid_id(&id)?;
    let supervisor = supervisor.filter(|s| !s.is_empty());
    if let Some(up) = &supervisor {
        valid_id(up)?;
    }
    blocking(move || {
        if let Some(up) = &supervisor {
            let sessions = service(json!({"op": "sessions"}))?;
            // Names are chosen by agents: the folder and the id say which session it really is
            let name = |id: &str| {
                sessions["sessions"].as_array().and_then(|all| all.iter().find(|s| s["id"] == id)).map(|s| {
                    let h = &s["harness"];
                    let name = h["name"].as_str().filter(|n| !n.is_empty()).or(h["title"].as_str().filter(|n| !n.is_empty())).unwrap_or("unnamed");
                    format!("\u{201c}{name}\u{201d}\n    {} \u{00b7} {id}", s["cwd"].as_str().unwrap_or(""))
                }).unwrap_or_else(|| id.to_string())
            };
            let message = format!("{}\n\nwill supervise\n\n{}\n\nIt can give it tasks, read its terminal and its results, and gets its reports. It cannot type into it or answer its permission prompts.", name(up), name(&id));
            if !confirmed(&app, "Connect to this supervisor?", message, "Connect", false) {
                return service(json!({"op": "sessions"})).map(|_| Value::Null);
            }
        }
        service(json!({"op": "bind", "id": id, "supervisor": supervisor}))
    })
    .await
}

/// Open the hosted supervisor session (the running one, or a new one).
#[tauri::command]
pub async fn harness_supervisor(cols: u16, rows: u16) -> Result<Value, String> {
    blocking(move || service(json!({"op": "supervisor", "cols": cols, "rows": rows}))).await
}

/// End a session's agent and continue its conversation in a new process.
#[tauri::command]
pub async fn harness_restart(id: String) -> Result<Value, String> {
    valid_id(&id)?;
    // The person chose it in the session's menu, so a running turn may be cut off
    blocking(move || service(json!({"op": "restart", "id": id, "force": true}))).await
}

// ---- Slack connector (docs/AGENT_HARNESS_DESIGN.md, D14) ----
// Everything that widens what Slack may do is confirmed in a native dialog,
// never granted by the page alone.

#[tauri::command]
pub async fn slack_status() -> Result<Value, String> {
    blocking(|| service(json!({"op": "slack"}))).await
}

/// Check the tokens with Slack, ask the person, then keep the tokens in the Keychain.
/// Returns null when the person said no.
#[tauri::command]
pub async fn slack_connect(app: tauri::AppHandle, bot: String, app_token: String, operator: String) -> Result<Value, String> {
    blocking(move || {
        let found = service(json!({"op": "slack_probe", "bot": bot, "app": app_token, "operator": operator}))?;
        let text = |key: &str| found[key].as_str().unwrap_or("").to_string();
        let message = format!(
            "Workspace: {}\nBot: {}\n\n{} ({}) is recorded as you. Only this Slack user's button presses can approve or deny a post, and this is the first sender whose messages reach a session.\n\nThe two tokens are kept in the macOS Keychain on this Mac and are shown to no agent. Nothing is listened to and nothing can be posted until you set a channel's policy.",
            text("team"), text("botName"), text("operatorName"), text("operator")
        );
        if !confirmed(&app, "Connect Slack?", message, "Connect", false) {
            return Ok(Value::Null);
        }
        service(json!({"op": "slack_connect", "bot": bot, "app": app_token, "operator": operator}))
    })
    .await
}

#[tauri::command]
pub async fn slack_disconnect(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(move || {
        if !confirmed(&app, "Disconnect Slack?", "The tokens are removed from the Keychain, listening stops and posts that wait are cancelled. Channel policies are kept for the next time.".to_string(), "Disconnect", true) {
            return service(json!({"op": "slack"}));
        }
        service(json!({"op": "slack_disconnect"}))
    })
    .await
}

/// The off switch. Turning it off needs no question; turning it on again does.
#[tauri::command]
pub async fn slack_enable(app: tauri::AppHandle, on: bool) -> Result<Value, String> {
    blocking(move || {
        if on && !confirmed(&app, "Switch Slack on again?", "Channels are listened to and sessions can post again, each under the policy you set for it. Messages that arrived meanwhile are read back.".to_string(), "Switch On", false) {
            return service(json!({"op": "slack"}));
        }
        service(json!({"op": "slack_enable", "on": on}))
    })
    .await
}

/// Approval in Slack makes the person's Slack account a second place where posts are approved.
#[tauri::command]
pub async fn slack_approval(app: tauri::AppHandle, on: bool) -> Result<Value, String> {
    blocking(move || {
        if on {
            let now = service(json!({"op": "slack"}))?;
            let who = now["connection"]["operatorName"].as_str().unwrap_or("you").to_string();
            let message = format!("The bot will send {who} a direct message with Approve and Deny for every post that waits. Whoever controls that Slack account can then approve posts. The text of each post that waits is kept in that direct message, also when it is denied.");
            if !confirmed(&app, "Approve posts in Slack too?", message, "Allow", true) {
                return Ok(now);
            }
        }
        service(json!({"op": "slack_approval", "on": on}))
    })
    .await
}

#[tauri::command]
pub async fn slack_refresh() -> Result<Value, String> {
    blocking(|| service(json!({"op": "slack_refresh"}))).await
}

/// Change a channel's policy. Posting without approval, and letting other
/// people's messages reach an agent, are asked about first.
#[tauri::command]
pub async fn slack_policy(app: tauri::AppHandle, channel: String, policy: Value) -> Result<Value, String> {
    valid_id(&channel)?;
    blocking(move || {
        let now = service(json!({"op": "slack"}))?;
        let current = now["channels"].as_array().and_then(|all| all.iter().find(|c| c["id"] == channel.as_str())).cloned().ok_or("No such channel")?;
        let name = current["name"].as_str().unwrap_or("").to_string();
        if let Some(posting @ ("auto" | "thread")) = policy["posting"].as_str().filter(|p| current["posting"] != *p) {
            let what = if posting == "auto" {
                format!("Sessions that may post to #{name} will post there without asking you. An agent can post anything it has read: file contents, credentials it came across, what other channels said.")
            } else {
                format!("A session will answer in #{name} without asking you, in threads where a sender on the channel's list addressed it. An agent can put anything it has read into such an answer. New messages outside those threads still wait for your approval.")
            };
            if !confirmed(&app, "Post without your approval?", what, "Allow", true) {
                return Ok(now);
            }
        }
        // Where posts go without approval, more sessions posting or another session answering is asked about too
        let posting = policy["posting"].as_str().or(current["posting"].as_str()).unwrap_or("never");
        if posting == "auto" || posting == "thread" {
            let had: Vec<&str> = current["posters"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            let more = policy["posters"].as_array().is_some_and(|a| a.iter().filter_map(|v| v.as_str()).any(|p| !had.contains(&p)));
            let other = policy["route"].as_str().is_some_and(|kind| kind != "none" && (current["route"]["kind"] != kind || (kind == "session" && current["route"]["session"] != policy["session"])));
            if more || other {
                let what = if more { "More sessions" } else { "Another session" };
                if !confirmed(&app, "Let it post without your approval?", format!("{what} will be able to post to #{name} without asking you: this channel's policy sends posts {}.", if posting == "auto" { "at once" } else { "in threads at once" }), "Allow", true) {
                    return Ok(now);
                }
            }
        }
        let operator = now["connection"]["operator"].as_str().unwrap_or("");
        let had: Vec<&str> = current["senders"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        let added: Vec<&str> = policy["senders"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).filter(|u| *u != operator && !had.contains(u)).collect()).unwrap_or_default();
        if !added.is_empty() {
            let message = format!("Messages from {} in #{name} will reach an agent session. That agent can run commands as you, and it reads their messages as requests from Slack. Add only people you would let type into its terminal.", added.join(", "));
            if !confirmed(&app, "Let other people's messages reach an agent?", message, "Allow", true) {
                return Ok(now);
            }
        }
        service(json!({"op": "slack_policy", "channel": channel, "policy": policy}))
    })
    .await
}

/// The person's decision on a post that waits: approve (with the text as they left it) or deny.
#[tauri::command]
pub async fn slack_decide(post: String, approve: bool, text: Option<String>, reason: Option<String>) -> Result<Value, String> {
    valid_id(&post)?;
    blocking(move || service(json!({"op": "slack_decide", "post": post, "approve": approve, "text": text, "reason": reason}))).await
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid id".into());
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
    let view_id = id.clone();
    let (mut reader, writer) = blocking(move || {
        let socket = socket()?;
        runner::ensure(&socket)?;
        runner::open_stream(&socket, json!({"op": "attach", "id": id}))
    })
    .await?;
    let handle = state.next_view.fetch_add(1, Ordering::SeqCst) + 1;
    state.views.lock().map_err(|_| "View state unavailable")?.insert(handle, (writer, view_id));
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
    let (stream, id) = views.get_mut(&view).ok_or("The terminal is detached")?;
    if let Err(e) = stream.write_all(data.as_bytes()) {
        views.remove(&view);
        return Err(format!("The terminal is detached: {e}"));
    }
    if data == "\r" {
        let id = id.clone();
        drop(views);
        // Only the attached human view submits here; harness injections use runner write.
        service(json!({"op": "operator_input", "id": id}))?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_detach(view: u64, state: State<'_, HarnessState>) {
    if let Ok(mut views) = state.views.lock() {
        if let Some((stream, _)) = views.remove(&view) {
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
    let cache_root = dirs::cache_dir().ok_or("Cache directory unavailable")?.join("agent-mcr");
    crate::ipc::private_dir(&cache_root)?;
    let root = cache_root.join("attachments");
    crate::ipc::private_dir(&root)?;
    // Screenshots can show anything: the user's alone, and not kept for good
    let old = |p: &std::path::Path| p.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age > PASTED_IMAGE_KEPT));
    for session in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for file in std::fs::read_dir(session.path()).into_iter().flatten().flatten().filter(|f| old(&f.path())) {
            let _ = std::fs::remove_file(file.path());
        }
        // Fails, as it should, while the folder still holds images
        let _ = std::fs::remove_dir(session.path());
    }
    let dir = root.join(&id);
    crate::ipc::private_dir(&dir)?;
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
