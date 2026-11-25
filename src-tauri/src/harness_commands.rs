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
use std::sync::{Mutex, OnceLock};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Pasted images are removed after two weeks, at the next paste
const PASTED_IMAGE_KEPT: std::time::Duration = std::time::Duration::from_secs(14 * 86_400);
const MAX_PASTED_IMAGE: usize = 30 * 1024 * 1024;

#[derive(Default)]
pub struct HarnessState {
    views: Mutex<BTreeMap<u64, (Stream, String)>>,
    next_view: AtomicU64,
    told: Told,
    /// Sessions whose input box may hold a line the person has not sent (MCR-85)
    drafts: std::sync::Arc<Mutex<BTreeMap<String, Draft>>>,
}

/// Whether a session's input box may hold text the person typed and has not
/// sent, told from the keys `terminal_input` writes (MCR-85): the harness
/// service types notices and tasks into idle sessions and never sees a key, so
/// the app is the witness. It errs towards "unsent": a notice typed into a
/// half-written line is submitted with it.
#[derive(Default)]
struct Draft {
    /// Printable characters typed and not taken back with Backspace
    chars: usize,
    /// Something happened that the count cannot follow (a paste, a recalled
    /// line, a word deleted): unsent until Enter or Ctrl+C
    unknown: bool,
    /// Earlier lines stepped back to with Up from an empty box and not yet
    /// stepped forward again with Down
    recalled: usize,
    /// When the service was last told of this line
    told: Option<std::time::Instant>,
    /// A thread is telling the service again after a call that failed
    retrying: bool,
    /// When the last key reached this count (ms since 1970), for `prune`
    last_key: u64,
}

/// While the person types on, the service is told again this often. It may
/// have dropped the word (a key that answered a question is no line, and
/// only the service knows that a session asks), or have been away.
const DRAFT_RETELL: std::time::Duration = std::time::Duration::from_secs(1);

impl Draft {
    fn unsent(&self) -> bool {
        self.unknown || self.chars > 0 || self.recalled > 0
    }

    /// What xterm sends by itself and nobody typed: focus and mouse reports,
    /// and its answers to the agent's questions (cursor position `CSI … R`,
    /// device attributes `CSI … c`, mode and status reports `CSI … y` and
    /// `CSI … n`, window reports `CSI … t`, colours `OSC`, `DCS`).
    fn report(data: &str) -> bool {
        data == "\x1b[I"
            || data == "\x1b[O"
            || ["\x1b[<", "\x1b[M", "\x1b]", "\x1bP"].iter().any(|start| data.starts_with(start))
            || (data.starts_with("\x1b[") && data.len() > 3 && data.ends_with(['R', 'c', 'y', 'n', 't']))
    }

    /// One chunk as xterm sends it: a key, a key's escape sequence or a paste.
    fn key(&mut self, data: &str) {
        // Enter sends the line; Ctrl+C empties the box in Claude Code and Codex
        if data == "\r" || data == "\x03" {
            *self = Draft { told: self.told, retrying: self.retrying, ..Draft::default() };
        } else if let Some(pasted) = data.strip_prefix("\x1b[200~") {
            self.unknown |= pasted != "\x1b[201~";
        } else if Self::report(data) {
            // Nobody typed it
        } else if data.starts_with('\x1b') {
            // Up recalls an earlier line into an empty box and Down steps
            // forward again, to the empty box after as many (xterm also sends
            // them for the wheel on an alternate screen: scrolling back and
            // forth must not leave a line). Any other sequence in a line that
            // has text may move or delete more than the count knows
            // (Alt+Backspace); Escape too, which empties the box only when
            // pressed twice and only in some agents
            let stepping = self.chars == 0 && !self.unknown;
            match data {
                "\x1b[A" | "\x1bOA" if stepping => self.recalled += 1,
                "\x1b[B" | "\x1bOB" if stepping => self.recalled = self.recalled.saturating_sub(1),
                _ => self.unknown |= self.unsent(),
            }
        } else {
            // Text typed into a recalled line: no longer a matter of stepping
            self.unknown |= self.recalled > 0;
            for c in data.chars() {
                match c {
                    '\x7f' | '\x08' => self.chars = self.chars.saturating_sub(1),
                    c if c >= ' ' => self.chars += 1,
                    // A line break inside a chunk is pasted text
                    '\r' | '\n' => self.unknown = true,
                    // Ctrl+U, Ctrl+W, Tab and the like: only a line with text can change
                    _ => self.unknown |= self.unsent(),
                }
            }
        }
    }
}

/// The service's word on a line the app told it of (MCR-122). Where the app
/// said "unsent" and the service keeps no draft, the keys answered a question
/// the session asked (a digit at a permission menu): the app forgets its
/// count, or it would tell the same line again at the next key and hold every
/// message and task until Enter. Keys typed while the call was under way are
/// forgotten with it; the next key is told anew. A service of an earlier
/// build answers without `draft`, and nothing changes.
fn settle(drafts: &mut BTreeMap<String, Draft>, id: &str, told_unsent: bool, answer: &serde_json::Value) {
    if told_unsent && answer["draft"] == false {
        drafts.remove(id);
    }
}

/// After a word about an unsent line did not reach the service (it restarts
/// at every rebuild): say it again every `pause` while the line is unsent,
/// until a call succeeds or `tries` are used up. Without it a first key told
/// to nobody, followed by a pause, would leave no hold.
fn retell(drafts: std::sync::Arc<Mutex<BTreeMap<String, Draft>>>, id: String, pause: std::time::Duration, tries: usize, call: impl Fn(&str) -> bool + Send + 'static) {
    let begun = drafts.lock().is_ok_and(|mut drafts| drafts.get_mut(&id).is_some_and(|draft| draft.unsent() && !std::mem::replace(&mut draft.retrying, true)));
    if !begun {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..tries {
            std::thread::sleep(pause);
            let unsent = drafts.lock().is_ok_and(|drafts| drafts.get(&id).is_some_and(Draft::unsent));
            if !unsent || call(&id) {
                break;
            }
        }
        if let Ok(mut drafts) = drafts.lock() {
            if let Some(draft) = drafts.get_mut(&id) {
                draft.retrying = false;
            }
        }
    });
}

/// The word to the service about what the person did in a session's terminal
/// (pressed Enter; has an unsent line or no longer has), kept off the command
/// that wrote the key: one worker thread makes the calls, and a session that
/// already waits to be told is not queued twice (an Enter among the keys is
/// kept). A session is taken off the waiting list before its call starts, so
/// a key during the call is told again. The worker ends when the state is dropped.
#[derive(Default)]
struct Told {
    queue: Mutex<Option<std::sync::mpsc::Sender<String>>>,
    /// Session id to whether an Enter is among what is to be told
    waiting: std::sync::Arc<Mutex<BTreeMap<String, bool>>>,
}

impl Told {
    /// Never blocks on `call`, which runs on the worker (and is used only by the first one started).
    fn tell(&self, id: String, enter: bool, call: impl Fn(&str, bool) + Send + 'static) {
        let Ok(mut queue) = self.queue.lock() else { return };
        let Ok(mut waiting) = self.waiting.lock() else { return };
        if let Some(entered) = waiting.get_mut(&id) {
            *entered |= enter;
            return;
        }
        waiting.insert(id.clone(), enter);
        let id = match queue.as_ref().map(|tx| tx.send(id.clone())) {
            Some(Ok(())) => return,
            // The worker is gone, and what it had queued with it
            Some(Err(unsent)) => {
                waiting.clear();
                waiting.insert(id, enter);
                unsent.0
            }
            None => id,
        };
        drop(waiting);
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let _ = tx.send(id);
        *queue = Some(tx);
        let waiting = self.waiting.clone();
        std::thread::spawn(move || {
            for id in rx {
                let enter = waiting.lock().ok().and_then(|mut waiting| waiting.remove(&id)).unwrap_or(false);
                call(&id, enter);
            }
        });
    }
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

static WINDOW_GENERATION: OnceLock<Option<u64>> = OnceLock::new();

// The clock is shared by app processes on this boot. Wall time can step back,
// and Rust's Instant does not expose a value to compare across processes.
#[cfg(unix)]
fn monotonic_ticks() -> Option<u64> {
    let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    (unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } == 0)
        .then(|| time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64)
}

#[cfg(windows)]
fn monotonic_ticks() -> Option<u64> {
    use windows_sys::Win32::System::Performance::QueryPerformanceCounter;
    let mut ticks = 0;
    (unsafe { QueryPerformanceCounter(&mut ticks) } != 0).then_some(ticks as u64)
}

fn with_window_generation(mut req: Value) -> Value {
    if let Some(generation) = *WINDOW_GENERATION.get_or_init(monotonic_ticks) {
        req["windowGeneration"] = json!(generation);
    }
    req
}

/// Tell a running harness as soon as this window starts. Opening the app does
/// not start the background units. If the harness is away, its first ordinary
/// draft request carries the same generation.
pub fn window_opened() {
    let req = with_window_generation(json!({"op": "window_opened"}));
    std::thread::spawn(move || {
        if let Ok(mut client) = config_dir().and_then(|dir| Client::connect(&harness::socket(&dir))) {
            let _ = client.call(req);
        }
    });
}

/// Sessions, their state and resuming go through the harness service.
fn service(req: Value) -> Result<Value, String> {
    harness::call(&config_dir()?, with_window_generation(req))
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
        // Agent profiles for the start menu (MCR-126 P2): ids only reach the service, which loads and checks them itself
        let agent_profiles = crate::profiles::picker(&config_dir()?, &preferences);
        Ok(json!({ "runner": hello, "service": service_info, "profiles": preferences.profiles(), "agentProfiles": agent_profiles, "supervisorProfile": preferences.supervisor_profile, "home": home, "supervisorCommand": supervisor, "outsideSupervisors": settings["outsideSupervisors"], "codexHooks": settings["codexHooks"], "codexHooksReporting": settings["codexHooksReporting"], "programQuery": settings["programQuery"], "storeNotice": settings["storeNotice"] }))
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
            let message = format!("Agent MCR runs your agents in two background processes of its own, so they keep working when you close or update the app:\n\n\u{2022} the runner holds the terminals\n\u{2022} the harness service tracks sessions and gives agents their tools\n\n{start} They listen only on sockets private to your user, never on the network, and exit on their own ten minutes after the last session ends.\n\nYou can see, stop and remove them at any time under Background in the Live view.", start = if cfg!(windows) { "They are ordinary processes of your user that Agent MCR starts itself; nothing is installed in Windows." } else { "macOS starts them through two files in ~/Library/LaunchAgents and may show a \"Background Items Added\" notice." });
            if !confirmed(&app, "Let Agent MCR run in the background?", message, "Allow", false) {
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
        let (title, rest, ok) = if uninstall && cfg!(windows) {
            ("Remove Agent MCR's background items?", "The runner and the harness service are stopped and Agent MCR forgets that you allowed them; nothing was installed in Windows. Session history and settings stay; to remove those too, delete %LOCALAPPDATA%\\agent-mcr after quitting.", "Stop and Remove")
        } else if uninstall {
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

/// Start Codex sessions with the harness's hooks, or stop that (MCR-74).
/// Turning it on is confirmed in a native dialog, never by the page alone:
/// from then on Codex asks the person to trust the hooks, and a Codex
/// session nobody watches stops at that question until they have.
#[tauri::command]
pub async fn harness_codex_hooks(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    blocking(move || {
        if on {
            let mut dialog = app
                .dialog()
                .message("New Codex sessions will be started with four hooks that call Agent MCR and report the session's state: when it starts, takes a prompt, asks for approval and has used a tool. They never answer a prompt for you.\n\nCodex asks once to review them (\"Hooks need review\"). Start a Codex session yourself next and choose \"Trust all and continue\". Until you have, every new Codex session stops at that question, also one started by another agent. Codex asks again when Agent MCR runs from another location.\n\nRunning sessions are not changed.")
                .title("Start Codex with Agent MCR's hooks?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Use hooks".to_string(), "Cancel".to_string()));
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.parent(&window);
            }
            if !dialog.blocking_show() {
                return Ok(false);
            }
        }
        service(json!({"op": "settings", "codexHooks": on})).map(|s| s["codexHooks"] == true)
    })
    .await
}

/// Answer a program's OSC 7501 feature query, or stop that (MCR-115).
/// Turning it on is confirmed in a native dialog, never by the page alone:
/// the answer is written to the session's input, and any output can ask.
#[tauri::command]
pub async fn harness_program_query(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    blocking(move || {
        if on {
            let mut dialog = app
                .dialog()
                .message("A program can ask its terminal whether it reads program status reports (OSC 7501). With this on, Agent MCR answers with a fixed line that lists the states it knows, written to the session's input like a terminal's own answer. It holds nothing from any report and is never written into a line you have not sent.\n\nAny output can ask, a file shown in the terminal too: a program that did not ask then finds that line in its input. Leave this off unless a program you run needs the answer.\n\nReports are shown either way, and never change a session's state.")
                .title("Answer program status queries?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Answer".to_string(), "Cancel".to_string()));
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.parent(&window);
            }
            if !dialog.blocking_show() {
                return Ok(false);
            }
        }
        service(json!({"op": "settings", "programQuery": on})).map(|s| s["programQuery"] == true)
    })
    .await
}

/// Let agents outside the harness use the supervisor tools, or stop that.
/// Turning it on is confirmed in a native dialog, never by the page alone.
/// The person has read what the service left out of its state file (MCR-99).
/// Answers the notice as it is afterwards: one the service still has to say stays.
#[tauri::command]
pub async fn harness_store_notice_seen() -> Result<Value, String> {
    blocking(|| service(json!({"op": "settings", "storeNoticeSeen": true})).map(|s| s["storeNotice"].clone())).await
}

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
pub async fn harness_list(state: State<'_, HarnessState>) -> Result<Value, String> {
    let drafts = state.drafts.clone();
    blocking(move || read_list(&drafts)).await
}

fn read_list(drafts: &Mutex<BTreeMap<String, Draft>>) -> Result<Value, String> {
    let list = service(json!({"op": "sessions"}))?;
    if let Ok(mut drafts) = drafts.lock() {
        prune(&mut drafts, &list);
    }
    Ok(list)
}

#[tauri::command]
pub async fn harness_list_since(stamp: Option<String>, state: State<'_, HarnessState>) -> Result<Value, String> {
    let drafts = state.drafts.clone();
    blocking(move || list_since(read_list(&drafts)?, stamp.as_deref())).await
}

fn list_since(mut list: Value, held: Option<&str>) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    let mut sessions = list["sessions"].take();
    for row in sessions.as_array_mut().into_iter().flatten().filter_map(Value::as_object_mut) {
        // Terminal traffic changes this timestamp without changing anything the Live view shows.
        row.remove("lastOutput");
    }
    let bytes = serde_json::to_vec(&sessions).map_err(|e| e.to_string())?;
    let stamp: String = Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect();
    Ok(json!({ "sessions": (held != Some(stamp.as_str())).then_some(sessions), "stamp": stamp }))
}

/// The app's count of a line the service has since ended by itself
/// (MCR-122): the prompt it answered moved on, or the screen showed the box
/// empty. The list says the session holds no draft and that this changed
/// after the last key the app saw there; the count goes, or the next key
/// (Up in an empty box, a letter typed and deleted) would raise the same
/// hold again, and an agent whose screen cannot prove an empty box would
/// stay held until Enter. A count the service has not heard of yet (its
/// change is older than the last key) stays.
fn prune(drafts: &mut BTreeMap<String, Draft>, list: &Value) {
    for session in list["sessions"].as_array().into_iter().flatten() {
        let (Some(id), h) = (session["id"].as_str(), &session["harness"]) else { continue };
        if h["draft"] == false && h["typed"].as_u64().is_some_and(|changed| drafts.get(id).is_some_and(|d| changed > d.last_key)) {
            drafts.remove(id);
        }
    }
}

/// Dismiss an empty-box hold the operator checked in the cockpit.
#[tauri::command]
pub async fn harness_clear_draft(id: String, since: u64, state: State<'_, HarnessState>) -> Result<(), String> {
    valid_id(&id)?;
    let drafts = state.drafts.clone();
    blocking(move || {
        let seen = runner::lock(&drafts).get(&id).map(|draft| draft.last_key);
        service(json!({"op": "clear_draft", "id": id, "since": since}))?;
        let mut drafts = runner::lock(&drafts);
        if drafts.get(&id).map(|draft| draft.last_key) == seen {
            drafts.remove(&id);
        }
        Ok(())
    }).await
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

/// The cockpit (MCR-95): what sessions published for the person,
/// joined with what the service knows. Text only: the page shows it.
#[tauri::command]
pub async fn harness_cockpit() -> Result<Value, String> {
    blocking(|| service(json!({"op": "cockpit"}))).await
}

/// A click in the cockpit (MCR-97). The page names the action (`by`, `id`,
/// the stamp it showed) and what was clicked; it supplies no text, no
/// session, no link and no command. The service resolves all of those from
/// what is stored and checks them again.
///
/// * `place`, `choose`, `ask`: the service puts a line in a session's input
///   box, unsent. Answers `{placed: session}`.
/// * `link`: answers the link's parts as the parser reads them, for the
///   question the page shows. Opens nothing.
/// * `open`: asks the service for the same link again and opens the
///   parser's own serialisation in the browser. Answers `{opened: host}`.
/// * `copy`: puts the stored command on the clipboard. Answers `{copied: true}`.
#[tauri::command]
pub async fn harness_cockpit_act(app: tauri::AppHandle, state: tauri::State<'_, HarnessState>, by: String, id: String, updated: u64, act: String, option: Option<u64>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let drafts = state.drafts.clone();
    blocking(move || {
        let ask = |act: &str| service(json!({"op": "cockpit_act", "by": by, "id": id, "updated": updated, "act": act, "option": option}));
        match act.as_str() {
            "place" | "choose" | "ask" => {
                let out = ask(&act)?;
                // The box now holds text no key of the person's put there: the
                // witness cannot count it back with Backspace, so it stays an
                // unsent line until Enter or Ctrl+C (MCR-85)
                if let Some(session) = out["placed"].as_str() {
                    runner::lock(&drafts).entry(session.to_string()).or_default().unknown = true;
                }
                Ok(json!({ "placed": out["placed"] }))
            }
            "link" => Ok(json!({ "link": ask("link")?["link"] })),
            "open" => {
                let link = ask("link")?["link"].clone();
                let href = link["href"].as_str().ok_or("The service named no link")?;
                app.opener().open_url(href, None::<&str>).map_err(|e| format!("The link could not be opened: {e}"))?;
                Ok(json!({ "opened": link["host"] }))
            }
            "copy" => {
                let out = ask("copy")?;
                to_clipboard(out["copy"].as_str().ok_or("The service named no command")?)?;
                Ok(json!({ "copied": true }))
            }
            _ => Err("Unknown click".into()),
        }
    })
    .await
}

/// "Copy as task" (MCR-125 v0): the operator's instruction and a passage
/// they selected in a session's terminal, as one task text on the clipboard,
/// to paste into a session they start themselves. Nothing is started, sent
/// or stored; no agent can call this. The excerpt is quoted as data after
/// the operator's words (`task_copy::task_text`).
#[tauri::command]
pub async fn harness_copy_as_task(source: String, instruction: String, excerpt: String) -> Result<(), String> {
    let text = crate::task_copy::task_text(&source, &instruction, &excerpt, crate::secret_shape::looks_secret)?;
    blocking(move || to_clipboard(&text)).await
}

/// The operator's own copy of a terminal selection (the Copy item of the
/// terminal's right-click menu, Ctrl+Shift+C on Windows and Linux): through
/// the platform's tool like every other copy of the app, not the webview's
/// clipboard API, which the app's webviews do not all grant (MCR-125 review L1).
#[tauri::command]
pub async fn harness_copy_text(text: String) -> Result<(), String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("The selection is too large to copy.".into());
    }
    blocking(move || to_clipboard(&text)).await
}

/// Text to the system clipboard, through the platform's own tool: the app
/// has no clipboard library, and the page is not given the text to copy.
fn to_clipboard(text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let feed = |mut command: Command, bytes: &[u8]| -> Result<(), String> {
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        child.stdin.take().ok_or("no input")?.write_all(bytes).map_err(|e| e.to_string())?;
        match child.wait() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("it ended with {status}")),
            Err(e) => Err(e.to_string()),
        }
    };
    let done = if cfg!(target_os = "macos") {
        feed(Command::new("/usr/bin/pbcopy"), text.as_bytes())
    } else if cfg!(windows) {
        // clip.exe reads UTF-16 with a byte order mark; anything else goes through the console's code page
        let wide: Vec<u8> = std::iter::once(0xFEFFu16).chain(text.encode_utf16()).flat_map(u16::to_le_bytes).collect();
        feed(Command::new("clip.exe"), &wide)
    } else {
        feed(Command::new("wl-copy"), text.as_bytes()).or_else(|_| {
            let mut xclip = Command::new("xclip");
            xclip.args(["-selection", "clipboard"]);
            feed(xclip, text.as_bytes())
        })
    };
    done.map_err(|e| format!("Could not copy to the clipboard: {e}"))
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

// ---- Memory server (docs/AGENT_HARNESS_DESIGN.md, D16) ----
// The service holds the sign-in. The page can ask where it stands; connecting
// and disconnecting are confirmed in a native dialog, never granted by the
// page alone, and the page never sees the address the browser is sent to.

#[tauri::command]
pub async fn memory_status() -> Result<Value, String> {
    blocking(|| service(json!({"op": "memory_status"}))).await
}

/// Ask the person, then let the service start the sign-in and open the
/// browser at the authorization server's page. Returns the status either way.
#[tauri::command]
pub async fn memory_connect(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    blocking(move || {
        let now = service(json!({"op": "memory_status"}))?;
        let message = format!(
            "Agent MCR signs in to {} in your browser, as you. The sign-in is kept in the macOS Keychain on this Mac by the background service, and is shown to no agent.\n\nEvery agent session Agent MCR starts then has the memory tools without a question per call: it can read what your account reaches there and write to it. What memory returns is data for the agent, not an instruction. Sessions that run now get the tools at their next restart.",
            now["endpoint"].as_str().unwrap_or("the memory service")
        );
        if !confirmed(&app, "Connect memory?", message, "Sign in", false) {
            return Ok(now);
        }
        let mut started = service(json!({"op": "memory_connect"}))?;
        let url = started.as_object_mut().and_then(|s| s.remove("url")).and_then(|u| u.as_str().map(str::to_string)).unwrap_or_default();
        // The service only names https pages; a browser that cannot be opened ends the sign-in
        let opened = if url.starts_with("https://") { app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string()) } else { Err("no https page to sign in at".to_string()) };
        if let Err(e) = opened {
            let _ = service(json!({"op": "memory_disconnect"}));
            return Err(format!("The browser could not be opened for the sign-in: {e}"));
        }
        Ok(started)
    })
    .await
}

/// Revoke the sign-in and take it out of the Keychain. A sign-in that is
/// only under way is called off without a question: nothing is kept yet.
#[tauri::command]
pub async fn memory_disconnect(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(move || {
        let now = service(json!({"op": "memory_status"}))?;
        if now["state"] != "connecting" && !confirmed(&app, "Disconnect memory?", "The sign-in is revoked at the memory service and removed from the Keychain. Agent sessions keep the memory server, which then tells them it is not connected.".to_string(), "Disconnect", true) {
            return Ok(now);
        }
        service(json!({"op": "memory_disconnect"}))
    })
    .await
}

// ---- Slack connector (docs/AGENT_HARNESS_DESIGN.md, D14) ----
// Everything that widens what Slack may do is confirmed in a native dialog,
// never granted by the page alone.

#[tauri::command]
pub async fn slack_status() -> Result<Value, String> {
    blocking(|| service(json!({"op": "slack"}))).await
}

#[tauri::command]
pub async fn slack_waiting() -> Result<u64, String> {
    blocking(|| {
        let waiting = service(json!({"op": "slack", "waitingOnly": true}))?;
        // An older service ignores the new field and returns the full status.
        waiting.as_u64().or_else(|| waiting["counts"]["waiting"].as_u64())
            .ok_or_else(|| "The harness returned no Slack approval count".into())
    })
    .await
}

/// Check the tokens with Slack, ask the person, then keep the tokens in the Keychain.
/// Returns null when the person said no.
#[tauri::command]
pub async fn slack_connect(app: tauri::AppHandle, bot: String, app_token: String, operator: String) -> Result<Value, String> {
    blocking(move || {
        let found = service(json!({"op": "slack_probe", "bot": bot, "app": app_token, "operator": operator}))?;
        let text = |key: &str| found[key].as_str().unwrap_or("").to_string();
        let message = format!(
            "Workspace: {}\nBot: {}\n\n{} ({}) is recorded as you. Only this Slack user's button presses can approve or deny a post, and this is the first sender whose messages reach a session.\n\nThe two tokens are kept in {store} on this computer and are shown to no agent. Nothing is listened to and nothing can be posted until you set a channel's policy.",
            text("team"), text("botName"), text("operatorName"), text("operator"),
            store = if cfg!(windows) { "Windows Credential Manager" } else { "the macOS Keychain" }
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
        if !confirmed(&app, "Disconnect Slack?", "The tokens are removed from the secret store, listening stops and posts that wait are cancelled. Channel policies are kept for the next time.".to_string(), "Disconnect", true) {
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

/// Change a channel's policy. Posting without approval, messages reaching the
/// Supervisor, and letting other people's messages reach an agent, are asked about first.
#[tauri::command]
pub async fn slack_policy(app: tauri::AppHandle, channel: String, policy: Value) -> Result<Value, String> {
    valid_id(&channel)?;
    blocking(move || {
        let now = service(json!({"op": "slack"}))?;
        let current = now["channels"].as_array().and_then(|all| all.iter().find(|c| c["id"] == channel.as_str())).cloned().ok_or("No such channel")?;
        for (title, message) in policy_questions(&now, &current, &policy) {
            if !confirmed(&app, title, message, "Allow", true) {
                return Ok(now);
            }
        }
        service(json!({"op": "slack_policy", "channel": channel, "policy": policy}))
    })
    .await
}

/// What the person is asked in a native dialog before a channel's policy
/// changes from `current` to what `policy` sets: a title and a text each, in
/// the order they are asked. One "no" leaves the policy as it is.
fn policy_questions(now: &Value, current: &Value, policy: &Value) -> Vec<(&'static str, String)> {
    let mut ask = Vec::new();
    let name = current["name"].as_str().unwrap_or("");
    if let Some(posting @ ("auto" | "thread")) = policy["posting"].as_str().filter(|p| current["posting"] != *p) {
        ask.push(("Post without your approval?", if posting == "auto" {
            format!("Sessions that may post to #{name} will post there without asking you. An agent can post anything it has read: file contents, credentials it came across, what other channels said.")
        } else {
            format!("A session will answer in #{name} without asking you, in threads where a sender on the channel's list addressed it. An agent can put anything it has read into such an answer. New messages outside those threads still wait for your approval.")
        }));
    }
    // Where posts go without approval, more sessions posting or another session answering is asked about too
    let posting = policy["posting"].as_str().or(current["posting"].as_str()).unwrap_or("never");
    if posting == "auto" || posting == "thread" {
        let had: Vec<&str> = current["posters"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        let more = policy["posters"].as_array().is_some_and(|a| a.iter().filter_map(|v| v.as_str()).any(|p| !had.contains(&p)));
        let other = policy["route"].as_str().is_some_and(|kind| kind != "none" && (current["route"]["kind"] != kind || (kind == "session" && current["route"]["session"] != policy["session"])));
        if more || other {
            let what = if more { "More sessions" } else { "Another session" };
            ask.push(("Let it post without your approval?", format!("{what} will be able to post to #{name} without asking you: this channel's policy sends posts {}.", if posting == "auto" { "at once" } else { "in threads at once" })));
        }
    }
    let operator = now["connection"]["operator"].as_str().unwrap_or("");
    let listed = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default() };
    let had = listed(&current["senders"]);
    // The Supervisor's session and task tools are allowed without prompts: what lands in
    // its inbox is asked about, whoever is on the list now (MCR-38, finding 3)
    if policy["route"] == "supervisor" && current["route"]["kind"] != "supervisor" {
        let senders = if policy["senders"].is_array() { listed(&policy["senders"]) } else { had.clone() };
        let others = senders.iter().filter(|u| u.as_str() != operator).count();
        let who = match others {
            0 => "Only you are on the channel's sender list now; anyone you add later reaches the Supervisor too.".to_string(),
            1 => "One person besides you is on the channel's sender list, and their messages reach it as well.".to_string(),
            n => format!("{n} people besides you are on the channel's sender list, and their messages reach it as well."),
        };
        ask.push(("Deliver Slack messages to the Supervisor?", format!("Messages from #{name} will land in the inbox of the Supervisor session. The Supervisor starts sessions and gives them tasks without asking you, so what is written in this channel can set agents to work on this Mac. {who}")));
    }
    let added: Vec<&str> = policy["senders"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).filter(|u| *u != operator && !had.iter().any(|h| h == u)).collect()).unwrap_or_default();
    if !added.is_empty() {
        let to = if policy["route"] == "supervisor" || (policy["route"].is_null() && current["route"]["kind"] == "supervisor") { "the Supervisor session, which starts sessions and gives them tasks without asking you" } else { "an agent session" };
        ask.push(("Let other people's messages reach an agent?", format!("Messages from {} in #{name} will reach {to}. That agent can run commands as you, and it reads their messages as requests from Slack. Add only people you would let type into its terminal.", added.join(", "))));
    }
    ask
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
    blocking(move || service(json!({"op": "forget_ended", "id": id})).map(drop)).await
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
pub async fn terminal_attach(id: String, since: Option<u64>, output: Channel<InvokeResponseBody>, state: State<'_, HarnessState>) -> Result<u64, String> {
    valid_id(&id)?;
    let view_id = id.clone();
    let (mut reader, writer, reply) = blocking(move || {
        let socket = socket()?;
        runner::ensure(&socket)?;
        let mut req = json!({"op": "attach", "id": id});
        if let Some(since) = since {
            req["since"] = json!(since);
        }
        runner::open_stream_reply(&socket, req)
    })
    .await?;
    // Where the bytes start in all the session's output; a runner before MCR-139 does not say
    let from = reply["from"].as_u64();
    let handle = state.next_view.fetch_add(1, Ordering::SeqCst) + 1;
    state.views.lock().map_err(|_| "View state unavailable")?.insert(handle, (writer, view_id));
    // One thread reads the runner, the other gathers what it read into frames for the web view
    let (chunks, gathered) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if chunks.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        // The first frame says where the bytes start, before any of them
        if output.send(InvokeResponseBody::Raw(start_frame(from))).is_err() {
            return;
        }
        gather(&gathered, GATHER, |data| output.send(InvokeResponseBody::Raw(frame(data))).is_ok());
        // The end of the stream: a frame with nothing in it
        let _ = output.send(InvokeResponseBody::Raw(frame(&[])));
    });
    Ok(handle)
}

/// Output that arrives this soon after the first part of it goes to the web view with it.
const GATHER: std::time::Duration = std::time::Duration::from_millis(6);
/// The most one frame gathers.
const GATHER_BYTES: usize = 256 * 1024;
/// The least a frame takes. Tauri sends a channel message shorter than 1024
/// bytes as JavaScript source text, a JSON array of its numbers that the web
/// view parses and compiles; anything longer is fetched as bytes. An agent at
/// work writes hundreds of small repaints a minute, and as source text each
/// left garbage that only the web view's full collections free: 300 MB and
/// more under load (MCR-139). A frame is never shorter, so terminal output
/// never takes that way.
pub const FRAME_MIN: usize = 1024;

/// A frame for the web view: the length (u32, little-endian), the bytes, and
/// zeros up to `FRAME_MIN`. Length 0 is the end of the stream.
pub fn frame(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity((data.len() + 4).max(FRAME_MIN));
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_le_bytes());
    out.extend_from_slice(data);
    if out.len() < FRAME_MIN {
        out.resize(FRAME_MIN, 0);
    }
    out
}

/// The length that marks a start frame: it is followed by the offset (u64,
/// little-endian) of the first byte the view gets, `u64::MAX` when unknown.
pub const START: u32 = u32::MAX;

/// The first frame of a view: where its bytes start in all the output.
pub fn start_frame(from: Option<u64>) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_MIN);
    out.extend_from_slice(&START.to_le_bytes());
    out.extend_from_slice(&from.unwrap_or(u64::MAX).to_le_bytes());
    out.resize(FRAME_MIN, 0);
    out
}

/// Hands on what arrives in `chunks`: each time the first chunk and whatever
/// follows it within `window`, up to `GATHER_BYTES`, as one piece, in order.
/// Ends when the chunks end or `send` says the view is gone.
pub fn gather(chunks: &std::sync::mpsc::Receiver<Vec<u8>>, window: std::time::Duration, mut send: impl FnMut(&[u8]) -> bool) {
    use std::sync::mpsc::RecvTimeoutError;
    while let Ok(first) = chunks.recv() {
        let mut data = first;
        let until = std::time::Instant::now() + window;
        let mut ended = false;
        while data.len() < GATHER_BYTES {
            let left = until.saturating_duration_since(std::time::Instant::now());
            match chunks.recv_timeout(left) {
                Ok(more) => data.extend_from_slice(&more),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    ended = true;
                    break;
                }
            }
        }
        if !send(&data) || ended {
            return;
        }
    }
}

#[tauri::command]
pub fn terminal_input(view: u64, data: String, state: State<'_, HarnessState>) -> Result<(), String> {
    let mut views = state.views.lock().map_err(|_| "View state unavailable")?;
    let (stream, id) = views.get_mut(&view).ok_or("The terminal is detached")?;
    if let Err(e) = stream.write_all(data.as_bytes()) {
        views.remove(&view);
        return Err(format!("The terminal is detached: {e}"));
    }
    let id = id.clone();
    drop(views);
    // Only the attached human view types here; harness injections use runner write
    let enter = data == "\r";
    let tell = state.drafts.lock().is_ok_and(|mut drafts| {
        let draft = drafts.entry(id.clone()).or_default();
        let was = draft.unsent();
        draft.key(&data);
        draft.last_key = runner::now_ms();
        let unsent = draft.unsent();
        let tell = enter || was != unsent || (unsent && draft.told.is_none_or(|at| at.elapsed() >= DRAFT_RETELL));
        if !unsent {
            drafts.remove(&id);
        } else if tell {
            draft.told = Some(std::time::Instant::now());
        }
        tell
    });
    if tell {
        // The key is written: a service that is slow or away must not hold the
        // terminal or show as its error. The worker reads the draft when it
        // calls, so a late call tells the latest
        let drafts = state.drafts.clone();
        state.told.tell(id, enter, move |id, enter| {
            let draft = drafts.lock().is_ok_and(|drafts| drafts.get(id).is_some_and(Draft::unsent));
            // Two ops: a service of the build before takes every `operator_input` for an Enter
            let op = if enter { "operator_input" } else { "operator_draft" };
            match service(json!({"op": op, "id": id, "draft": draft})) {
                Ok(answer) => {
                    if let Ok(mut drafts) = drafts.lock() {
                        settle(&mut drafts, id, draft, &answer);
                    }
                }
                Err(_) if draft => retell(drafts.clone(), id.to_string(), std::time::Duration::from_secs(2), 30, |id| service(json!({"op": "operator_draft", "id": id, "draft": true})).is_ok()),
                Err(_) => {}
            }
        });
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
    fn live_list_sends_visible_changes_and_ignores_terminal_output() {
        let list = |last, state| json!({"sessions": [{"id": "a", "lastOutput": last, "harness": {"state": state}}]});
        let initial = list_since(list(1, "working"), None).unwrap();
        let stamp = initial["stamp"].as_str();
        assert_eq!(initial["sessions"], json!([{"id": "a", "harness": {"state": "working"}}]));
        assert!(list_since(list(2, "working"), stamp).unwrap()["sessions"].is_null());
        assert_eq!(list_since(list(3, "idle"), stamp).unwrap()["sessions"][0]["harness"]["state"], "idle");
        assert_eq!(list_since(json!({"sessions": []}), stamp).unwrap()["sessions"], json!([]));
    }

    #[test]
    fn a_frame_is_never_short_enough_to_go_as_source_text_and_says_its_length() {
        for data in [&b""[..], b"x", &[7u8; 1019], &[7u8; 1020], &[7u8; 5000]] {
            let f = frame(data);
            assert!(f.len() >= FRAME_MIN, "{} bytes", data.len());
            assert_eq!(u32::from_le_bytes(f[..4].try_into().unwrap()) as usize, data.len());
            assert_eq!(&f[4..4 + data.len()], data);
            assert!(f[4 + data.len()..].iter().all(|b| *b == 0));
        }
        assert_eq!(frame(&[7u8; 5000]).len(), 5004);
    }

    #[test]
    fn a_start_frame_says_where_the_bytes_start_or_that_it_is_not_known() {
        let f = start_frame(Some(4_294_967_301));
        assert_eq!(f.len(), FRAME_MIN);
        assert_eq!(u32::from_le_bytes(f[..4].try_into().unwrap()), START);
        assert_eq!(u64::from_le_bytes(f[4..12].try_into().unwrap()), 4_294_967_301);
        assert_eq!(u64::from_le_bytes(start_frame(None)[4..12].try_into().unwrap()), u64::MAX);
        // No data frame can say START: a frame never holds 4 GiB
        assert!(GATHER_BYTES < START as usize);
    }

    #[test]
    fn output_is_gathered_in_order_and_handed_on_when_it_pauses_or_ends() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        // What arrives together goes together, in order
        for part in [&b"ab"[..], b"cd", b"ef"] {
            tx.send(part.to_vec()).unwrap();
        }
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            tx.send(b"later".to_vec()).unwrap();
            // The stream ends
        });
        let mut sent: Vec<Vec<u8>> = Vec::new();
        gather(&rx, std::time::Duration::from_millis(50), |d| {
            sent.push(d.to_vec());
            true
        });
        writer.join().unwrap();
        assert_eq!(sent, vec![b"abcdef".to_vec(), b"later".to_vec()]);
    }

    #[test]
    fn gathering_stops_when_the_view_is_gone() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        tx.send(b"one".to_vec()).unwrap();
        let mut calls = 0;
        let late = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = tx.send(b"two".to_vec());
            tx
        });
        gather(&rx, std::time::Duration::from_millis(10), |_| {
            calls += 1;
            false
        });
        assert_eq!(calls, 1);
        drop(late.join());
    }

    #[test]
    fn a_frame_gathers_no_more_than_its_limit() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        for _ in 0..5 {
            tx.send(vec![1u8; GATHER_BYTES / 2]).unwrap();
        }
        drop(tx);
        let mut sizes = Vec::new();
        gather(&rx, std::time::Duration::from_secs(5), |d| {
            sizes.push(d.len());
            true
        });
        assert_eq!(sizes, vec![GATHER_BYTES, GATHER_BYTES, GATHER_BYTES / 2]);
    }

    #[test]
    fn a_hold_the_service_ended_is_not_raised_again_by_the_next_key() {
        // A digit at Codex's question, told before the service knew it asked: the service
        // then ended the hold itself (the question was answered), the app still counts the digit
        let mut drafts: BTreeMap<String, Draft> = BTreeMap::new();
        let d = drafts.entry("s".into()).or_default();
        d.key("2");
        d.last_key = 1_000;
        let list = |draft: bool, typed: u64| json!({"sessions": [{"id": "s", "harness": {"draft": draft, "typed": typed}}]});
        // Without the list's word: a letter typed and deleted leaves the hold up
        let mut stale = Draft { chars: 1, last_key: 1_000, ..Draft::default() };
        stale.key("x");
        stale.key("\x7f");
        assert!(stale.unsent(), "the count of the digit stays");
        // The service holds a draft, or changed it before the last key: the count stays
        prune(&mut drafts, &list(true, 2_000));
        prune(&mut drafts, &list(false, 500));
        assert!(drafts.contains_key("s"));
        // The service ended it after the last key: the count goes, and the next keys count alone
        prune(&mut drafts, &list(false, 2_000));
        assert!(!drafts.contains_key("s"));
        let fresh = drafts.entry("s".into()).or_default();
        fresh.key("x");
        fresh.key("\x7f");
        assert!(!fresh.unsent());
        // Up from the empty box and Down again leave nothing either
        fresh.key("\x1b[A");
        fresh.key("\x1b[B");
        assert!(!fresh.unsent());
        // Sessions the app has no count for, and lists without sessions, change nothing
        prune(&mut drafts, &json!({"error": "x"}));
        prune(&mut drafts, &json!({"sessions": [{"id": "other", "harness": {"draft": false, "typed": 9}}]}));
    }

    #[test]
    fn a_key_the_service_takes_for_an_answer_is_forgotten_by_the_app() {
        // A digit pressed at Claude Code's permission menu: the app counts it as a line
        let mut drafts: BTreeMap<String, Draft> = BTreeMap::new();
        drafts.entry("s".into()).or_default().key("2");
        assert!(drafts["s"].unsent());
        // An older service answers nothing about the line: the count stays
        settle(&mut drafts, "s", true, &json!({}));
        assert!(drafts.contains_key("s"));
        // The service keeps a draft: so does the app
        settle(&mut drafts, "s", true, &json!({"draft": true}));
        assert!(drafts.contains_key("s"));
        // The service keeps none (the session asks): the app forgets the key, so it is not told again
        settle(&mut drafts, "s", true, &json!({"draft": false}));
        assert!(!drafts.contains_key("s"));
        // A word the app sent about an empty box changes nothing here
        drafts.entry("t".into()).or_default().key("x");
        settle(&mut drafts, "t", false, &json!({"draft": false}));
        assert!(drafts.contains_key("t"));
    }

    #[test]
    fn a_draft_follows_the_keys_and_errs_towards_unsent() {
        let after = |keys: &[&str]| {
            let mut draft = Draft::default();
            for key in keys {
                draft.key(key);
            }
            draft.unsent()
        };
        // Typing starts a line; Enter and Ctrl+C end it
        assert!(!after(&[]));
        assert!(after(&["h"]));
        assert!(after(&["h", "i", " "]));
        assert!(after(&["\u{43f}"]));
        assert!(!after(&["h", "i", "\r"]));
        assert!(!after(&["h", "i", "\x03"]));
        // Backspace takes back what was typed, and no more than that
        assert!(!after(&["h", "i", "\x7f", "\x7f"]));
        assert!(after(&["h", "i", "\x7f"]));
        assert!(!after(&["\x7f", "\x7f"]));
        assert!(after(&["\x7f", "\x7f", "h"]));
        // A paste, also one without the markers, cannot be counted back
        assert!(after(&["\x1b[200~two\nlines\x1b[201~", "\x7f", "\x7f", "\x7f"]));
        assert!(!after(&["\x1b[200~\x1b[201~"]));
        assert!(after(&["a\rb"]));
        assert!(!after(&["\x1b[200~text\x1b[201~", "\r"]));
        // Keys that are not text start nothing: arrows aside, focus and mouse reports, Tab, Ctrl+U, Escape
        for key in ["\x1b[D", "\x1b[C", "\x1b[B", "\x1b[I", "\x1b[O", "\x1b[<0;10;5M", "\t", "\x15", "\x1b", "\x04"] {
            assert!(!after(&[key]), "{key:?}");
        }
        // Up recalls an earlier line into an empty box; Down as many times gives the empty box back
        assert!(after(&["\x1b[A"]));
        assert!(after(&["\x1bOA"]));
        assert!(!after(&["\x1b[A", "\r"]));
        assert!(!after(&["\x1b[A", "\x1b[B"]));
        assert!(after(&["\x1b[A", "\x1b[A", "\x1bOB"]));
        assert!(!after(&["\x1b[A", "\x1b[A", "\x1b[B", "\x1b[B", "\x1b[B"]));
        // A recalled line that was edited is a line: stepping no longer ends it
        assert!(after(&["\x1b[A", "x", "\x7f", "\x1b[B"]));
        assert!(after(&["\x1b[A", "\x7f", "\x1b[B"]));
        // Up in a line with text moves the cursor, it recalls nothing; Down does not end the line
        assert!(after(&["h", "\x1b[A", "\x1b[B", "\x7f"]));
        // The terminal's own answers to the agent are not keys, also in the middle of a line
        for reply in ["\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP1$r0m\x1b\\", "\x1b[?2026;2$y", "\x1b[0n", "\x1b[8;24;80t"] {
            assert!(!after(&[reply]), "{reply:?}");
            assert!(!after(&["h", reply, "\x7f"]), "{reply:?}");
        }
        // Escape twice empties the box in Claude Code only: it stays a line here, and the hold is told
        assert!(after(&["h", "\x1b", "\x1b", "\x7f"]));
        // In a line with text, a key that deletes or moves by more than one
        // character ends the count: Backspace to "empty" no longer proves it
        for key in ["\x1b\x7f", "\x17", "\x15", "\x1b[D", "\t"] {
            assert!(after(&["h", key, "\x7f"]), "{key:?}");
        }
        // A focus report in the middle of a line changes nothing
        assert!(!after(&["h", "\x1b[O", "\x1b[I", "\x7f"]));
    }

    #[test]
    fn a_word_about_a_line_that_did_not_reach_the_service_is_said_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let pause = std::time::Duration::from_millis(5);
        let drafts: std::sync::Arc<Mutex<BTreeMap<String, Draft>>> = Default::default();
        let line = |id: &str| drafts.lock().unwrap().entry(id.into()).or_default().key("h");
        let wait = |until: &dyn Fn() -> bool| {
            let start = std::time::Instant::now();
            while !until() && start.elapsed() < std::time::Duration::from_secs(5) {
                std::thread::sleep(pause);
            }
            assert!(until());
        };
        let idle = |id: &str| drafts.lock().unwrap().get(id).is_none_or(|d| !d.retrying);
        // The service comes back at the third call: no call after it
        line("a");
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        retell(drafts.clone(), "a".into(), pause, 30, move |_| counted.fetch_add(1, Ordering::SeqCst) + 1 >= 3);
        // One thread per session
        retell(drafts.clone(), "a".into(), pause, 30, |_| panic!("a second thread"));
        wait(&|| idle("a"));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // The line was sent meanwhile: nothing more to say
        line("b");
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        retell(drafts.clone(), "b".into(), std::time::Duration::from_millis(50), 30, move |_| counted.fetch_add(1, Ordering::SeqCst) > 100);
        drafts.lock().unwrap().get_mut("b").unwrap().key("\r");
        assert!(drafts.lock().unwrap()["b"].retrying, "Enter keeps the thread known");
        wait(&|| idle("b"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // It gives up after its tries, and no thread starts for a session without a line
        line("c");
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        retell(drafts.clone(), "c".into(), pause, 4, move |_| counted.fetch_add(1, Ordering::SeqCst) > 100);
        wait(&|| idle("c"));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        retell(drafts.clone(), "nobody".into(), pause, 4, |_| panic!("no line"));
    }

    #[test]
    fn an_enter_among_the_words_to_tell_is_kept() {
        use std::sync::mpsc::channel;
        let told = Told::default();
        let (started_tx, started) = channel::<(String, bool)>();
        let (release, released) = channel::<()>();
        let released = Mutex::new(released);
        let call = move |id: &str, enter: bool| {
            started_tx.send((id.to_string(), enter)).unwrap();
            released.lock().unwrap().recv().unwrap();
        };
        let wait = std::time::Duration::from_secs(5);
        // A first key is not an Enter
        told.tell("a".into(), false, call);
        assert_eq!(started.recv_timeout(wait).unwrap(), ("a".to_string(), false));
        // During the call: a key, an Enter, a key. One call, and it says Enter
        for enter in [false, true, false] {
            told.tell("a".into(), enter, |_: &str, _: bool| panic!("a second worker"));
        }
        release.send(()).unwrap();
        assert_eq!(started.recv_timeout(wait).unwrap(), ("a".to_string(), true));
        release.send(()).unwrap();
        assert!(started.recv_timeout(std::time::Duration::from_millis(100)).is_err());
    }

    #[test]
    fn enter_is_told_to_the_service_off_the_command_and_repeats_are_dropped() {
        use std::sync::mpsc::channel;
        let told = Told::default();
        let (started_tx, started) = channel::<String>();
        let (release, released) = channel::<()>();
        let released = Mutex::new(released);
        // A service that answers only when the test lets it
        let call = move |id: &str, _: bool| {
            started_tx.send(id.to_string()).unwrap();
            released.lock().unwrap().recv().unwrap();
        };
        let wait = std::time::Duration::from_secs(5);
        // Returns although the call has not ended
        told.tell("a".into(), true, call);
        assert_eq!(started.recv_timeout(wait).unwrap(), "a");
        // Enters during the call: told once more, not three times; another session keeps its own
        for id in ["a", "a", "a", "b", "b"] {
            told.tell(id.into(), true, |_: &str, _: bool| panic!("a second worker"));
        }
        assert_eq!(told.waiting.lock().unwrap().keys().cloned().collect::<Vec<_>>(), ["a", "b"]);
        release.send(()).unwrap();
        assert_eq!(started.recv_timeout(wait).unwrap(), "a");
        release.send(()).unwrap();
        assert_eq!(started.recv_timeout(wait).unwrap(), "b");
        assert!(told.waiting.lock().unwrap().is_empty());
        release.send(()).unwrap();
        // Nothing queued is left over, and a later Enter is told again
        assert!(started.recv_timeout(std::time::Duration::from_millis(100)).is_err());
        told.tell("a".into(), true, |_: &str, _: bool| panic!("a second worker"));
        assert_eq!(started.recv_timeout(wait).unwrap(), "a");
        release.send(()).unwrap();
        // The worker ends with the state
        drop(told);
        assert!(started.recv_timeout(wait).is_err());
    }

    #[test]
    fn a_channel_policy_that_widens_what_slack_may_do_is_asked_about_first() {
        let now = json!({"connection": {"operator": "UOP"}});
        let current = json!({"id": "C1", "name": "ops", "posting": "approve", "posters": [], "senders": ["UOP"], "route": {"kind": "session", "session": "s1"}});
        let titles = |current: &Value, policy: Value| policy_questions(&now, current, &policy).into_iter().map(|q| q.0).collect::<Vec<_>>();
        // Nothing that widens: no question
        assert!(titles(&current, json!({"listen": "mentions"})).is_empty());
        assert!(titles(&current, json!({"route": "session", "session": "s2"})).is_empty());
        assert!(titles(&current, json!({"route": "none"})).is_empty());
        assert!(titles(&current, json!({"posting": "never", "senders": ["UOP"]})).is_empty());
        // A route to the Supervisor is asked about, also when only the operator is a sender (MCR-38, finding 3)
        assert_eq!(titles(&current, json!({"route": "supervisor"})), ["Deliver Slack messages to the Supervisor?"]);
        let with_ann = json!({"id": "C1", "name": "ops", "posting": "approve", "posters": [], "senders": ["UOP", "UANN"], "route": {"kind": "none", "session": ""}});
        let asked = policy_questions(&now, &with_ann, &json!({"route": "supervisor"}));
        assert!(asked[0].1.contains("#ops") && asked[0].1.contains("One person besides you"), "{}", asked[0].1);
        // Not asked again while it stays the route; a new sender then is, and the text names the Supervisor
        let to_supervisor = json!({"id": "C1", "name": "ops", "posting": "approve", "posters": [], "senders": ["UOP"], "route": {"kind": "supervisor", "session": ""}});
        assert!(titles(&to_supervisor, json!({"route": "supervisor"})).is_empty());
        let asked = policy_questions(&now, &to_supervisor, &json!({"senders": ["UOP", "UANN"]}));
        assert_eq!(asked.len(), 1);
        assert!(asked[0].0 == "Let other people's messages reach an agent?" && asked[0].1.contains("the Supervisor session") && asked[0].1.contains("UANN"));
        // The questions that were there before are still asked, in the same order
        assert_eq!(titles(&current, json!({"posting": "auto"})), ["Post without your approval?"]);
        assert_eq!(titles(&current, json!({"senders": ["UOP", "UANN"]})), ["Let other people's messages reach an agent?"]);
        let auto = json!({"id": "C1", "name": "ops", "posting": "auto", "posters": [], "senders": ["UOP"], "route": {"kind": "session", "session": "s1"}});
        assert_eq!(titles(&auto, json!({"posters": ["*"]})), ["Let it post without your approval?"]);
        assert_eq!(titles(&auto, json!({"route": "supervisor", "senders": ["UOP", "UANN"]})), ["Let it post without your approval?", "Deliver Slack messages to the Supervisor?", "Let other people's messages reach an agent?"]);
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
