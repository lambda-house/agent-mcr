//! The runner (`agent-mcr --runner`): owns agent terminals so they outlive the
//! app (docs/AGENT_HARNESS_DESIGN.md, D1 and "Runtime units"). It holds PTYs,
//! scrollback and exit codes, and nothing else: no policy, no MCP, no SQLite.
//! A runner crash ends every hosted agent, so keep it small and change its
//! protocol rarely (and only compatibly: the app and service speak N−1).
//!
//! Protocol, over a Unix socket in the config dir (directory 0700, socket 0600).
//! A connection starts with JSON lines:
//! - Control: one request line → one reply line, repeatedly. `hello`, `spawn`,
//!   `list`, `resize`, `write`, `signal`, `forget`. A reply is the result object,
//!   or `{"error": "..."}`.
//! - `{"op":"attach","id":...}` → `{"ok":true}`, then the connection carries raw
//!   bytes: the scrollback, then live output. Bytes the client sends are typed
//!   into the terminal. A view that falls too far behind is disconnected and
//!   reattaches (at most once per view; the child never waits for a viewer).
//! - `{"op":"watch"}` → `{"ok":true}`, then one JSON event per line.
//!
//! Anyone who can reach the socket is the user (same OS user, 0700 directory);
//! the runner does no authorization of its own.

use crate::ipc::{self, Listener, Stream};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PROTOCOL: u32 = 1;
const SCROLLBACK: usize = 4 * 1024 * 1024;
/// Output chunks queued per attached view before the view is dropped.
const VIEW_QUEUE: usize = 2048;
/// Exit when nothing runs and nobody is connected for this long.
const IDLE_EXIT: Duration = Duration::from_secs(600);
const MAX_REQUEST: u64 = 1024 * 1024;
const MAX_OSC: usize = 4096;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    pub code: u32,
    pub signal: Option<String>,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub pid: Option<u32>,
    pub argv: Vec<String>,
    pub cwd: String,
    pub started: u64,
    pub cols: u16,
    pub rows: u16,
    pub title: String,
    pub last_output: u64,
    pub exit: Option<Exit>,
    /// Opaque labels from the caller (profile, group); the runner doesn't interpret them.
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Finds terminal notifications in the output stream: BEL, and OSC 0/2
/// (title), OSC 9 and OSC 777 (desktop notifications). Agent-independent
/// signals for the attention queue.
#[derive(Default)]
struct Scanner {
    state: ScanState,
    osc: Vec<u8>,
}
#[derive(Default, PartialEq)]
enum ScanState {
    #[default]
    Ground,
    Esc,
    Osc,
    OscEsc,
}
#[derive(Debug, PartialEq)]
enum Signal {
    Bell,
    Title(String),
    Notify(String, String),
}

impl Scanner {
    fn feed(&mut self, bytes: &[u8], out: &mut Vec<Signal>) {
        for &b in bytes {
            match self.state {
                ScanState::Ground => match b {
                    0x1b => self.state = ScanState::Esc,
                    0x07 => out.push(Signal::Bell),
                    _ => {}
                },
                ScanState::Esc => {
                    if b == b']' {
                        self.osc.clear();
                        self.state = ScanState::Osc;
                    } else {
                        self.state = if b == 0x1b { ScanState::Esc } else { ScanState::Ground };
                    }
                }
                ScanState::Osc => match b {
                    0x07 => {
                        self.finish(out);
                        self.state = ScanState::Ground;
                    }
                    0x1b => self.state = ScanState::OscEsc,
                    _ if self.osc.len() < MAX_OSC => self.osc.push(b),
                    _ => {}
                },
                ScanState::OscEsc => {
                    if b == b'\\' {
                        self.finish(out);
                        self.state = ScanState::Ground;
                    } else if b == b']' {
                        // An aborted OSC followed by a new one
                        self.osc.clear();
                        self.state = ScanState::Osc;
                    } else {
                        self.state = if b == 0x1b { ScanState::Esc } else { ScanState::Ground };
                    }
                }
            }
        }
    }

    fn finish(&mut self, out: &mut Vec<Signal>) {
        let text = String::from_utf8_lossy(&self.osc).into_owned();
        let (code, rest) = text.split_once(';').unwrap_or((text.as_str(), ""));
        match code {
            "0" | "2" => out.push(Signal::Title(rest.to_string())),
            // OSC 9;4;… is a progress report (ConEmu, Windows Terminal), not a notification
            "9" if !rest.starts_with("4;") && !rest.is_empty() => out.push(Signal::Notify(String::new(), rest.to_string())),
            "777" => {
                let mut parts = rest.splitn(3, ';');
                if parts.next() == Some("notify") {
                    let title = parts.next().unwrap_or("").to_string();
                    out.push(Signal::Notify(title, parts.next().unwrap_or("").to_string()));
                }
            }
            _ => {}
        }
        self.osc.clear();
    }
}

struct DsrScanner {
    matched: usize,
}

impl DsrScanner {
    const NEEDLE: &'static [u8] = b"\x1b[6n";

    fn feed(&mut self, bytes: &[u8]) -> usize {
        let mut count = 0;
        for &b in bytes {
            if b == Self::NEEDLE[self.matched] {
                self.matched += 1;
                if self.matched == Self::NEEDLE.len() {
                    count += 1;
                    self.matched = 0;
                }
            } else {
                self.matched = usize::from(b == Self::NEEDLE[0]);
            }
        }
        count
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn handle_dsr(
    dsr: &mut DsrScanner,
    chunk: &[u8],
    has_views: bool,
    writer: &Mutex<Option<Box<dyn Write + Send>>>,
) {
    let count = dsr.feed(chunk);
    if count > 0 && !has_views {
        if let Some(w) = lock(writer).as_mut() {
            for _ in 0..count {
                let _ = w.write_all(b"\x1b[1;1R");
            }
            let _ = w.flush();
        }
    }
}

struct Output {
    ring: VecDeque<u8>,
    views: Vec<SyncSender<Arc<[u8]>>>,
    scanner: Scanner,
    last_bell: u64,
    closed: bool,
}

struct Session {
    info: Mutex<Info>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[cfg(windows)]
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    #[cfg(windows)]
    job: Mutex<Option<WinJob>>,
    output: Mutex<Output>,
}

#[cfg(windows)]
struct WinJob(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: Win32 job object handle is thread-safe for TerminateJobObject / CloseHandle.
#[cfg(windows)]
unsafe impl Send for WinJob {}

#[cfg(windows)]
impl Drop for WinJob {
    fn drop(&mut self) {
        // SAFETY: owned handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn assign_job(pid: Option<u32>) -> Result<WinJob, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    let pid = pid.ok_or("Child process id unknown")?;
    // SAFETY: creating an anonymous job object.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!("Cannot create job object: {}", std::io::Error::last_os_error()));
    }
    let job = WinJob(job);
    // SAFETY: opening child process to assign to job.
    let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if proc.is_null() {
        return Err(format!("Cannot open child process {pid}: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: both handles are valid.
    let ok = unsafe { AssignProcessToJobObject(job.0, proc) } != 0;
    let err = std::io::Error::last_os_error();
    // SAFETY: closing temporary process handle.
    unsafe { CloseHandle(proc) };
    if !ok {
        return Err(format!("Cannot assign process {pid} to job object: {err}"));
    }
    Ok(job)
}

#[derive(Default)]
pub struct Runner {
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    watchers: Mutex<Vec<SyncSender<Value>>>,
    connections: AtomicUsize,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn random_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    #[cfg(windows)]
    let ok = {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        // SAFETY: `bytes` is a 16-byte writable buffer; system-preferred RNG needs no handle.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        status == 0
    };
    #[cfg(not(any(unix, windows)))]
    let ok = false;
    if !ok {
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        bytes[..8].copy_from_slice(&seq.to_le_bytes());
        bytes[8..12].copy_from_slice(&std::process::id().to_le_bytes());
        bytes[12..16].copy_from_slice(&(now_ms() as u32).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panicking reader thread must not take every other session down with it
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Runner {
    fn broadcast(&self, event: Value) {
        lock(&self.watchers).retain(|w| match w.try_send(event.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        });
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        lock(&self.sessions).get(id).cloned().ok_or_else(|| format!("No session {id}"))
    }

    fn live(&self) -> usize {
        lock(&self.sessions).values().filter(|s| lock(&s.info).exit.is_none()).count()
    }

    pub fn spawn(self: &Arc<Self>, req: SpawnRequest) -> Result<Info, String> {
        let id = req.id.clone().unwrap_or_else(random_id);
        if !valid_id(&id) {
            return Err("Session ids are 1–64 letters, digits, '-' or '_'".into());
        }
        if req.argv.is_empty() || req.argv[0].is_empty() {
            return Err("Nothing to run".into());
        }
        if !Path::new(&req.cwd).is_dir() {
            return Err(format!("Not a directory: {}", req.cwd));
        }
        let (cols, rows) = (req.cols.clamp(10, 1000), req.rows.clamp(2, 500));
        if lock(&self.sessions).contains_key(&id) {
            return Err(format!("Session {id} exists"));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Cannot open a terminal: {e}"))?;
        let mut cmd = CommandBuilder::new(&req.argv[0]);
        cmd.args(&req.argv[1..]);
        cmd.cwd(&req.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "AgentMCR");
        if std::env::var_os("LANG").is_none() {
            // launchd starts the runner without a locale; agents print UTF-8
            cmd.env("LANG", "en_US.UTF-8");
        }
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Cannot start {}: {e}", req.argv[0]))?;
        drop(pair.slave);
        #[cfg(windows)]
        let killer = child.clone_killer();
        // Note: portable-pty spawns the child before AssignProcessToJobObject runs;
        // a descendant spawned in those microseconds before assignment is still
        // covered by ClosePseudoConsole when master/writer are dropped on signal.
        #[cfg(windows)]
        let job = match assign_job(child.process_id()) {
            Ok(job) => Some(job),
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let info = Info {
            id: id.clone(),
            pid: child.process_id(),
            argv: req.argv,
            cwd: req.cwd,
            started: now_ms(),
            cols,
            rows,
            title: String::new(),
            last_output: 0,
            exit: None,
            meta: req.meta,
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            #[cfg(windows)]
            killer: Mutex::new(killer),
            #[cfg(windows)]
            job: Mutex::new(job),
            output: Mutex::new(Output {
                ring: VecDeque::new(),
                views: Vec::new(),
                scanner: Scanner::default(),
                last_bell: 0,
                closed: false,
            }),
        });
        lock(&self.sessions).insert(id.clone(), session.clone());
        self.broadcast(json!({"event": "spawned", "session": info}));

        let runner = self.clone();
        let reading = session.clone();
        std::thread::spawn(move || runner.pump(&reading, reader));

        let runner = self.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let exit = match status {
                Ok(s) => Exit { code: s.exit_code(), signal: s.signal().map(str::to_owned), at: now_ms() },
                Err(_) => Exit { code: u32::MAX, signal: None, at: now_ms() },
            };
            lock(&session.info).exit = Some(exit.clone());
            runner.broadcast(json!({"event": "exited", "id": id, "exit": exit}));
        });
        Ok(info)
    }

    /// Terminal output → scrollback, attached views and notification events.
    fn pump(&self, session: &Session, mut reader: Box<dyn Read + Send>) {
        let id = lock(&session.info).id.clone();
        let mut buf = vec![0u8; 64 * 1024];
        #[cfg(windows)]
        let mut dsr = DsrScanner { matched: 0 };
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
            let mut signals = Vec::new();
            let has_views;
            {
                let mut out = lock(&session.output);
                out.ring.extend(chunk.iter());
                let excess = out.ring.len().saturating_sub(SCROLLBACK);
                out.ring.drain(..excess);
                out.views.retain(|v| v.try_send(chunk.clone()).is_ok());
                has_views = !out.views.is_empty();
                out.scanner.feed(&chunk, &mut signals);
                let now = now_ms();
                // Agents ring often; one bell event per second per session is enough
                signals.retain(|s| {
                    if *s != Signal::Bell {
                        return true;
                    }
                    let keep = now.saturating_sub(out.last_bell) >= 1000;
                    if keep {
                        out.last_bell = now;
                    }
                    keep
                });
            }
            #[cfg(windows)]
            handle_dsr(&mut dsr, &chunk, has_views, &session.writer);
            #[cfg(not(windows))]
            let _ = has_views;
            lock(&session.info).last_output = now_ms();
            for signal in signals {
                match signal {
                    Signal::Bell => self.broadcast(json!({"event": "bell", "id": id})),
                    Signal::Title(title) => {
                        lock(&session.info).title = title.clone();
                        self.broadcast(json!({"event": "title", "id": id, "title": title}));
                    }
                    Signal::Notify(title, body) => {
                        self.broadcast(json!({"event": "notify", "id": id, "title": title, "body": body}))
                    }
                }
            }
        }
        let mut out = lock(&session.output);
        out.closed = true;
        out.views.clear();
    }

    #[cfg(unix)]
    fn signal(&self, id: &str, name: &str) -> Result<(), String> {
        let session = self.get(id)?;
        let pid = {
            let info = lock(&session.info);
            // Its process id may belong to an unrelated process by now
            if info.exit.is_some() {
                return Err("The session has ended".into());
            }
            info.pid.ok_or("Process id unknown")? as libc::pid_t
        };
        let sig = match name {
            "INT" => libc::SIGINT,
            "TERM" => libc::SIGTERM,
            "HUP" => libc::SIGHUP,
            "KILL" => libc::SIGKILL,
            _ => return Err(format!("Unknown signal {name}")),
        };
        // Ctrl-C semantics: the terminal's foreground process group. Otherwise the
        // whole group the child leads (it is a session leader in its own PTY).
        let group = if sig == libc::SIGINT {
            lock(&session.master)
                .as_ref()
                .and_then(|m| m.process_group_leader())
                .unwrap_or(pid)
        } else {
            pid
        };
        // SAFETY: plain syscall; group ids come from our own child
        if unsafe { libc::killpg(group, sig) } != 0 && unsafe { libc::kill(pid, sig) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    #[cfg(windows)]
    fn signal(&self, id: &str, name: &str) -> Result<(), String> {
        let session = self.get(id)?;
        if lock(&session.info).exit.is_some() {
            return Err("The session has ended".into());
        }
        match name {
            "INT" => {
                let mut writer = lock(&session.writer);
                let Some(writer) = writer.as_mut() else {
                    return Err("The session has ended".into());
                };
                writer.write_all(&[0x03]).and_then(|_| writer.flush()).map_err(|e| e.to_string())
            }
            "TERM" | "HUP" | "KILL" => {
                // Close ConPTY handles and terminate the entire job tree; fail if TerminateJobObject fails.
                let job_res = match lock(&session.job).take() {
                    Some(job) => {
                        // SAFETY: `job.0` is a valid job object handle.
                        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job.0, 1) } == 0 {
                            Err(std::io::Error::last_os_error().to_string())
                        } else {
                            Ok(())
                        }
                    }
                    None => Err("Job object unavailable for process-tree termination".into()),
                };
                let kill_res = lock(&session.killer).kill().map_err(|e| e.to_string());
                lock(&session.writer).take();
                lock(&session.master).take();
                // TerminateJobObject kills the child too, so killer.kill() may see an already-exited process.
                if job_res.is_ok() {
                    Ok(())
                } else {
                    job_res.and(kill_res)
                }
            }
            _ => Err(format!("Unknown signal {name}")),
        }
    }

    fn control(self: &Arc<Self>, req: &Value) -> Result<Value, String> {
        let id = || req["id"].as_str().ok_or_else(|| "Missing id".to_string());
        match req["op"].as_str().unwrap_or("") {
            "hello" => Ok(json!({
                "protocol": PROTOCOL,
                "pid": std::process::id(),
                "version": env!("CARGO_PKG_VERSION"),
                "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
            })),
            "spawn" => {
                let spawn: SpawnRequest = serde_json::from_value(req.clone()).map_err(|e| e.to_string())?;
                serde_json::to_value(self.spawn(spawn)?).map_err(|e| e.to_string())
            }
            "list" => {
                let sessions: Vec<Info> = lock(&self.sessions).values().map(|s| lock(&s.info).clone()).collect();
                Ok(json!({ "sessions": sessions }))
            }
            "resize" => {
                let session = self.get(id()?)?;
                let cols = req["cols"].as_u64().unwrap_or(80).clamp(10, 1000) as u16;
                let rows = req["rows"].as_u64().unwrap_or(24).clamp(2, 500) as u16;
                let master = lock(&session.master);
                let Some(master) = master.as_ref() else {
                    return Err("The session has ended".into());
                };
                master
                    .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                    .map_err(|e| e.to_string())?;
                let mut info = lock(&session.info);
                (info.cols, info.rows) = (cols, rows);
                Ok(json!({}))
            }
            "write" => {
                let session = self.get(id()?)?;
                let data = req["data"].as_str().ok_or("Missing data")?;
                let mut writer = lock(&session.writer);
                let Some(writer) = writer.as_mut() else {
                    return Err("The session has ended".into());
                };
                writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "signal" => {
                self.signal(id()?, req["signal"].as_str().unwrap_or(""))?;
                Ok(json!({}))
            }
            "forget" => {
                let id = id()?;
                let session = self.get(id)?;
                if lock(&session.info).exit.is_none() {
                    return Err("The session is still running".into());
                }
                lock(&self.sessions).remove(id);
                Ok(json!({}))
            }
            other => Err(format!("Unknown request {other:?}")),
        }
    }

    fn attach(&self, id: &str, mut stream: Stream) -> std::io::Result<()> {
        let session = match self.get(id) {
            Ok(s) => s,
            Err(e) => return writeln!(stream, "{}", json!({ "error": e })),
        };
        let (tx, rx) = sync_channel::<Arc<[u8]>>(VIEW_QUEUE);
        let scrollback: Vec<u8> = {
            let mut out = lock(&session.output);
            if !out.closed {
                out.views.push(tx);
            }
            out.ring.iter().copied().collect()
        };
        writeln!(stream, "{}", json!({"ok": true}))?;
        stream.write_all(&scrollback)?;

        let mut input = stream.try_clone()?;
        let typing = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = input.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut writer = lock(&typing.writer);
                let Some(writer) = writer.as_mut() else {
                    break;
                };
                if writer.write_all(&buf[..n]).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
            let _ = input.shutdown(std::net::Shutdown::Both);
        });
        for chunk in rx {
            if stream.write_all(&chunk).is_err() {
                break;
            }
        }
        stream.shutdown(std::net::Shutdown::Both)
    }

    /// The scrollback as it is now: a length line, then that many raw bytes.
    fn snapshot(&self, id: &str, mut stream: Stream) -> std::io::Result<()> {
        let session = match self.get(id) {
            Ok(s) => s,
            Err(e) => return writeln!(stream, "{}", json!({ "error": e })),
        };
        let bytes: Vec<u8> = lock(&session.output).ring.iter().copied().collect();
        writeln!(stream, "{}", json!({"ok": true, "len": bytes.len()}))?;
        stream.write_all(&bytes)?;
        stream.shutdown(std::net::Shutdown::Both)
    }

    fn watch(&self, mut stream: Stream) -> std::io::Result<()> {
        let (tx, rx) = sync_channel::<Value>(1024);
        lock(&self.watchers).push(tx);
        writeln!(stream, "{}", json!({"ok": true}))?;
        for event in rx {
            writeln!(stream, "{event}")?;
        }
        Ok(())
    }

    /// Terminals are driven only by Agent MCR itself: the app and the harness
    /// service. A hosted session, or any other program, gets nothing but
    /// `hello`: typing into a terminal answers its prompts, and `spawn` runs
    /// a command outside every agent's sandbox.
    fn trusts(&self, peer: &crate::peer::Peer) -> bool {
        if !peer.is_this_program() {
            return false;
        }
        let children: Vec<i32> = lock(&self.sessions).values().filter_map(|s| { let info = lock(&s.info); info.pid.filter(|_| info.exit.is_none()).map(|p| p as i32) }).collect();
        matches!(peer.ancestor_among(&children), crate::peer::Ancestry::Outside)
    }

    fn handle(self: &Arc<Self>, stream: Stream, accepted_at: u64) -> std::io::Result<()> {
        let Some(peer) = crate::peer::Peer::open(&stream, accepted_at) else {
            return Ok(());
        };
        if !peer.same_user() {
            return Ok(());
        }
        let trusted = self.trusts(&peer);
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut writer = stream;
        loop {
            let mut line = Vec::new();
            if (&mut reader).take(MAX_REQUEST).read_until(b'\n', &mut line)? == 0 {
                return Ok(());
            }
            let req: Value = match serde_json::from_slice(&line) {
                Ok(v) => v,
                Err(_) => {
                    writeln!(writer, "{}", json!({"error": "Invalid request"}))?;
                    return Ok(());
                }
            };
            if !trusted && req["op"] != "hello" {
                return writeln!(writer, "{}", json!({"error": "Refused: terminals take requests only from Agent MCR itself"}));
            }
            match req["op"].as_str() {
                // Both turn the connection into a stream; nothing was read past the line
                Some("attach") => return self.attach(req["id"].as_str().unwrap_or(""), writer),
                Some("watch") => return self.watch(writer),
                Some("snapshot") => return self.snapshot(req["id"].as_str().unwrap_or(""), writer),
                _ => {
                    let reply = self.control(&req).unwrap_or_else(|e| json!({ "error": e }));
                    writeln!(writer, "{reply}")?;
                }
            }
        }
    }
}

/// Serve until idle. Refuses to start if another runner answers on `socket`.
pub fn serve(socket: &Path) -> Result<(), String> {
    let dir = socket.parent().ok_or("Invalid socket path")?;
    ipc::private_dir(dir)?;
    if let Ok(meta) = std::fs::symlink_metadata(socket) {
        if Stream::connect(socket).is_ok() {
            return Err("A runner is already listening".into());
        }
        if !ipc::is_socket(socket, &meta) {
            return Err("Refusing to replace a non-socket file".into());
        }
        std::fs::remove_file(socket).map_err(|e| e.to_string())?;
    }
    let listener = Listener::bind(socket).map_err(|e| format!("Cannot listen on {}: {e}", socket.display()))?;
    ipc::private_file(socket)?;
    let runner = Arc::new(Runner::default());

    let idle = runner.clone();
    let path = socket.to_path_buf();
    std::thread::spawn(move || {
        let mut since: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_secs(15));
            if idle.live() == 0 && idle.connections.load(Ordering::SeqCst) == 0 {
                let start = *since.get_or_insert_with(Instant::now);
                if start.elapsed() >= IDLE_EXIT {
                    let _ = std::fs::remove_file(&path);
                    std::process::exit(0);
                }
            } else {
                since = None;
            }
        }
    });

    for stream in listener.incoming() {
        let accepted_at = crate::peer::accept_time();
        let Ok(stream) = stream else { continue };
        let runner = runner.clone();
        runner.connections.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            let _ = runner.handle(stream, accepted_at);
            runner.connections.fetch_sub(1, Ordering::SeqCst);
        });
    }
    Ok(())
}

/// A control connection.
pub struct Client {
    reader: BufReader<Stream>,
    writer: Stream,
}

impl Client {
    pub fn connect(socket: &Path) -> Result<Self, String> {
        let stream = Stream::connect(socket).map_err(|e| format!("Runner unavailable: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
        stream.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
        Ok(Self { reader: BufReader::new(stream.try_clone().map_err(|e| e.to_string())?), writer: stream })
    }

    pub fn call(&mut self, req: Value) -> Result<Value, String> {
        writeln!(self.writer, "{req}").map_err(|e| format!("Runner: {e}"))?;
        let mut line = Vec::new();
        (&mut self.reader).take(64 * 1024 * 1024).read_until(b'\n', &mut line).map_err(|e| format!("Runner: {e}"))?;
        if line.last() != Some(&b'\n') {
            return Err("The runner closed the connection".into());
        }
        let reply: Value = serde_json::from_slice(&line).map_err(|_| "Invalid runner reply")?;
        match reply["error"].as_str() {
            Some(e) => Err(e.to_string()),
            None => Ok(reply),
        }
    }
}

/// Open a stream connection (`attach` or `watch`). Returns the reader, which
/// may already hold stream bytes past the handshake, and a writer.
pub fn open_stream(socket: &Path, req: Value) -> Result<(BufReader<Stream>, Stream), String> {
    let mut stream = Stream::connect(socket).map_err(|e| format!("Runner unavailable: {e}"))?;
    writeln!(stream, "{req}").map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = Vec::new();
    (&mut reader).take(64 * 1024).read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_slice(&line).map_err(|_| "The runner refused the stream")?;
    if let Some(e) = reply["error"].as_str() {
        return Err(e.to_string());
    }
    Ok((reader, stream))
}

/// A session's scrollback bytes (what a new view would be replayed).
pub fn snapshot(socket: &Path, id: &str) -> Result<Vec<u8>, String> {
    let (mut reader, _stream) = open_stream(socket, json!({"op": "snapshot", "id": id}))?;
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Connect to the runner, starting it if needed. Returns its `hello`.
pub fn ensure(socket: &Path) -> Result<Value, String> {
    ensure_unit(socket, &RUNNER, PROTOCOL)
}

/// A background unit of this binary, started by launchd outside the app's
/// process tree: the runner (`--runner`) or the harness service (`--harness`).
pub struct Unit {
    pub label: &'static str,
    pub flag: &'static str,
    pub name: &'static str,
}

pub const RUNNER: Unit = Unit { label: LAUNCH_LABEL, flag: "--runner", name: "runner" };

/// Connect to a unit's socket, starting the unit if needed. Returns its `hello`.
pub fn ensure_unit(socket: &Path, unit: &Unit, protocol: u32) -> Result<Value, String> {
    let hello = |socket: &Path| Client::connect(socket).and_then(|mut c| c.call(json!({"op": "hello"})));
    if let Ok(h) = hello(socket) {
        return check_protocol(h, unit, protocol);
    }
    start(socket, unit)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match hello(socket) {
            Ok(h) => return check_protocol(h, unit, protocol),
            Err(e) if Instant::now() >= deadline => return Err(format!("The {} did not start: {e}", unit.name)),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn check_protocol(hello: Value, unit: &Unit, protocol: u32) -> Result<Value, String> {
    match hello["protocol"].as_u64() {
        Some(p) if p == protocol as u64 || p + 1 == protocol as u64 => Ok(hello),
        Some(p) => Err(format!("The running {} speaks protocol {p}, this app {protocol}. Stop it, then start again.", unit.name)),
        None => Err(format!("The {} did not identify itself", unit.name)),
    }
}

pub const LAUNCH_LABEL: &str = "cc.lambdahouse.agent-mcr.runner";

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The LaunchAgent that runs the runner outside the app's process tree, so
/// quitting or updating the app leaves agents running.
#[cfg(target_os = "macos")]
pub fn launch_agent_plist(unit: &Unit, exe: &Path, log: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>{flag}</string></array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        label = unit.label,
        flag = unit.flag,
        exe = xml_escape(&exe.display().to_string()),
        log = xml_escape(&log.display().to_string()),
    )
}

#[cfg(target_os = "macos")]
fn start(socket: &Path, unit: &Unit) -> Result<(), String> {
    use std::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let log = socket.with_extension("log");
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let agents = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents).map_err(|e| e.to_string())?;
    let plist = agents.join(format!("{}.plist", unit.label));
    let content = launch_agent_plist(unit, &exe, &log);
    // SAFETY: getuid has no preconditions
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let service = format!("{domain}/{}", unit.label);
    if std::fs::read_to_string(&plist).ok().as_deref() != Some(content.as_str()) {
        // Another build (dev or release) registered itself; it isn't running, or
        // `ensure` would have connected. Re-register this executable.
        let _ = Command::new("launchctl").args(["bootout", &service]).output();
        std::fs::write(&plist, &content).map_err(|e| e.to_string())?;
    }
    // Fails harmlessly when already loaded
    let _ = Command::new("launchctl").arg("bootstrap").arg(&domain).arg(&plist).output();
    let out = Command::new("launchctl").args(["kickstart", &service]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("launchctl kickstart failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn start(socket: &Path, unit: &Unit) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(socket.with_extension("log"))
        .map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg(unit.flag)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map(drop)
        .map_err(|e| format!("Cannot start the {}: {e}", unit.name))
}

#[cfg(windows)]
fn start(socket: &Path, unit: &Unit) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    };
    let _ = unit.label;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = socket.parent() {
        ipc::private_dir(dir)?;
    }
    let log_path = socket.with_extension("log");
    let open_log = || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| e.to_string())
    };
    let spawn_with = |flags: u32| -> Result<(), String> {
        let log = open_log()?;
        Command::new(&exe)
            .arg(unit.flag)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .creation_flags(flags)
            .spawn()
            .map(drop)
            .map_err(|e| format!("Cannot start the {}: {e}", unit.name))
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    spawn_with(base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn_with(base))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_socket(name: &str) -> std::path::PathBuf {
        // Socket paths are limited to ~100 bytes; keep them short
        let root = if cfg!(unix) {
            std::path::PathBuf::from("/tmp")
        } else {
            std::env::temp_dir()
        };
        let dir = root.join(format!("amcr-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("r.sock")
    }

    fn serve_in_background(socket: &Path) {
        let path = socket.to_path_buf();
        std::thread::spawn(move || serve(&path).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Stream::connect(socket).is_err() {
            assert!(Instant::now() < deadline, "runner did not listen");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn read_until(reader: &mut impl Read, needle: &str) -> String {
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&seen).contains(needle) {
            assert!(Instant::now() < deadline, "timed out waiting for {needle:?}; got {:?}", String::from_utf8_lossy(&seen));
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => seen.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => panic!("{e}"),
            }
        }
        String::from_utf8_lossy(&seen).into_owned()
    }

    #[test]
    fn scanner_finds_bells_titles_and_notifications_across_chunks() {
        let mut scanner = Scanner::default();
        let mut out = Vec::new();
        scanner.feed(b"hello\x07\x1b]0;my ti", &mut out);
        scanner.feed(b"tle\x07\x1b]9;Claude needs your permission\x1b\\", &mut out);
        scanner.feed(b"\x1b]9;4;1;50\x07\x1b]777;notify;Codex;Approve?\x07\x1b[31mred\x1b[0m", &mut out);
        assert_eq!(
            out,
            vec![
                Signal::Bell,
                Signal::Title("my title".into()),
                Signal::Notify(String::new(), "Claude needs your permission".into()),
                Signal::Notify("Codex".into(), "Approve?".into()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_attach_type_replay_and_exit() {
        let socket = temp_socket("attach");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        assert_eq!(control.call(json!({"op": "hello"})).unwrap()["protocol"], PROTOCOL);
        let (mut events, _keep) = open_stream(&socket, json!({"op": "watch"})).unwrap();

        let info = control
            .call(json!({"op": "spawn", "id": "t1", "argv": ["/bin/sh", "-c", "printf 'ready\\n'; read line; printf 'got %s\\n' \"$line\"; printf '\\033]9;done\\007'; exit 3"], "cwd": "/tmp", "cols": 80, "rows": 24}))
            .unwrap();
        assert_eq!(info["id"], "t1");
        assert!(info["pid"].as_u64().is_some());
        assert!(control.call(json!({"op": "spawn", "id": "t1", "argv": ["/bin/true"], "cwd": "/tmp", "cols": 80, "rows": 24})).is_err());

        let (mut out, mut input) = open_stream(&socket, json!({"op": "attach", "id": "t1"})).unwrap();
        read_until(&mut out, "ready");
        input.write_all(b"hello runner\n").unwrap();
        read_until(&mut out, "got hello runner");

        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !(seen.contains("\"notify\"") && seen.contains("\"exited\"")) {
            assert!(Instant::now() < deadline, "events: {seen}");
            let mut line = String::new();
            events.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        assert!(seen.contains("\"body\":\"done\""));
        assert!(seen.contains("\"code\":3"));

        // A late view gets the scrollback, then the end of the stream
        let (mut late, _w) = open_stream(&socket, json!({"op": "attach", "id": "t1"})).unwrap();
        let replay = read_until(&mut late, "got hello runner");
        assert!(replay.contains("ready"));

        let list = control.call(json!({"op": "list"})).unwrap();
        assert_eq!(list["sessions"][0]["exit"]["code"], 3);
        control.call(json!({"op": "forget", "id": "t1"})).unwrap();
        assert_eq!(control.call(json!({"op": "list"})).unwrap()["sessions"].as_array().unwrap().len(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn spawn_attach_type_replay_and_exit() {
        let socket = temp_socket("attach");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        assert_eq!(control.call(json!({"op": "hello"})).unwrap()["protocol"], PROTOCOL);
        let cwd = std::env::temp_dir().display().to_string();

        let info = control
            .call(json!({
                "op": "spawn",
                "id": "t1",
                "argv": ["cmd.exe", "/v:on", "/c", "echo ready& set /p line=& echo got !line!& exit /b 3"],
                "cwd": cwd,
                "cols": 80,
                "rows": 24
            }))
            .unwrap();
        assert_eq!(info["id"], "t1");
        assert!(info["pid"].as_u64().is_some());
        assert!(control.call(json!({"op": "spawn", "id": "t1", "argv": ["cmd.exe", "/c", "exit 0"], "cwd": cwd, "cols": 80, "rows": 24})).is_err());

        let (mut out, mut input) = open_stream(&socket, json!({"op": "attach", "id": "t1"})).unwrap();
        read_until(&mut out, "ready");
        input.write_all(b"hello runner\r\n").unwrap();
        read_until(&mut out, "got hello runner");

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let list = control.call(json!({"op": "list"})).unwrap();
            if !list["sessions"][0]["exit"].is_null() {
                assert_eq!(list["sessions"][0]["exit"]["code"], 3);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(50));
        }

        let (mut late, _w) = open_stream(&socket, json!({"op": "attach", "id": "t1"})).unwrap();
        let replay = read_until(&mut late, "got hello runner");
        assert!(replay.contains("ready"));

        control.call(json!({"op": "forget", "id": "t1"})).unwrap();
        assert_eq!(control.call(json!({"op": "list"})).unwrap()["sessions"].as_array().unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn control_writes_resizes_and_signals() {
        let socket = temp_socket("control");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        control
            .call(json!({"op": "spawn", "id": "cat", "argv": ["/bin/cat"], "cwd": "/tmp", "cols": 80, "rows": 24}))
            .unwrap();
        let (mut out, _w) = open_stream(&socket, json!({"op": "attach", "id": "cat"})).unwrap();
        control.call(json!({"op": "write", "id": "cat", "data": "typed by the service\n"})).unwrap();
        read_until(&mut out, "typed by the service");
        control.call(json!({"op": "resize", "id": "cat", "cols": 120, "rows": 40})).unwrap();
        assert!(control.call(json!({"op": "forget", "id": "cat"})).is_err(), "a running session can't be forgotten");
        control.call(json!({"op": "signal", "id": "cat", "signal": "TERM"})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let list = control.call(json!({"op": "list"})).unwrap();
            let s = &list["sessions"][0];
            if !s["exit"].is_null() {
                assert_eq!(s["cols"], 120);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(control.call(json!({"op": "spawn", "argv": [], "cwd": "/tmp", "cols": 80, "rows": 24})).is_err());
        assert!(control.call(json!({"op": "spawn", "id": "../x", "argv": ["/bin/true"], "cwd": "/tmp", "cols": 80, "rows": 24})).is_err());
        assert!(control.call(json!({"op": "nope"})).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn control_writes_resizes_and_signals() {
        let socket = temp_socket("control");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        let cwd = std::env::temp_dir().display().to_string();
        control
            .call(json!({"op": "spawn", "id": "cmd", "argv": ["cmd.exe", "/k"], "cwd": cwd, "cols": 80, "rows": 24}))
            .unwrap();
        let (mut out, _w) = open_stream(&socket, json!({"op": "attach", "id": "cmd"})).unwrap();
        control.call(json!({"op": "write", "id": "cmd", "data": "echo typed by the service\r\n"})).unwrap();
        read_until(&mut out, "typed by the service");
        control.call(json!({"op": "resize", "id": "cmd", "cols": 120, "rows": 40})).unwrap();
        // Spawn a descendant process inside the job; wait for a complete PID=<digits> line so cmd echo cannot match.
        control.call(json!({"op": "write", "id": "cmd", "data": "powershell -NoProfile -Command \"$p = Start-Process -PassThru -WindowStyle Hidden powershell '-NoProfile -Command Start-Sleep 30'; Write-Output ('PID' + '=' + $p.Id)\"\r\n"})).unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(10);
        let desc_pid: u32 = loop {
            if let Some(pid) = String::from_utf8_lossy(&seen).lines().find_map(|line| {
                let rest = line.trim().strip_prefix("PID=")?;
                (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| rest.parse().ok())
                    .flatten()
            }) {
                break pid;
            }
            assert!(Instant::now() < deadline, "timed out waiting for PID= line; got {:?}", String::from_utf8_lossy(&seen));
            match out.read(&mut buf) {
                Ok(0) => panic!("EOF waiting for PID= line; got {:?}", String::from_utf8_lossy(&seen)),
                Ok(n) => seen.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => panic!("{e}"),
            }
        };
        // Open the descendant handle before TERM so an OpenProcess failure cannot be mistaken for exit.
        let desc_proc = unsafe {
            use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
            use windows_sys::Win32::System::Threading::OpenProcess;
            OpenProcess(SYNCHRONIZE, 0, desc_pid)
        };
        assert!(!desc_proc.is_null(), "could not open descendant process {desc_pid}");
        assert!(control.call(json!({"op": "forget", "id": "cmd"})).is_err(), "a running session can't be forgotten");
        control.call(json!({"op": "signal", "id": "cmd", "signal": "TERM"})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let list = control.call(json!({"op": "list"})).unwrap();
            let s = &list["sessions"][0];
            if !s["exit"].is_null() {
                assert_eq!(s["cols"], 120);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            let waited = WaitForSingleObject(desc_proc, 5000);
            CloseHandle(desc_proc);
            assert_eq!(waited, WAIT_OBJECT_0, "descendant process {desc_pid} survived TERM");
        }
        assert!(control.call(json!({"op": "spawn", "argv": [], "cwd": cwd, "cols": 80, "rows": 24})).is_err());
        assert!(control.call(json!({"op": "spawn", "id": "../x", "argv": ["cmd.exe", "/c", "exit 0"], "cwd": cwd, "cols": 80, "rows": 24})).is_err());
        assert!(control.call(json!({"op": "nope"})).is_err());
    }

    #[test]
    fn a_second_runner_refuses_the_socket_and_plist_escapes_paths() {
        let socket = temp_socket("twice");
        serve_in_background(&socket);
        assert!(serve(&socket).unwrap_err().contains("already listening"));
        #[cfg(target_os = "macos")]
        {
            let plist = launch_agent_plist(&RUNNER, Path::new("/A & B/Agent MCR.app/Contents/MacOS/agent-mcr"), Path::new("/tmp/r.log"));
            assert!(plist.contains("<string>/A &amp; B/Agent MCR.app/Contents/MacOS/agent-mcr</string>"));
            assert!(plist.contains("<string>--runner</string>"));
        }
    }
    /// Any other program of the same user is told the version and nothing else.
    /// Unix-only: uses `/usr/bin/nc -U` to connect as a foreign process.
    #[cfg(unix)]
    #[test]
    fn another_program_gets_hello_only() {
        if !Path::new("/usr/bin/nc").is_file() {
            return;
        }
        let socket = temp_socket("foreign");
        let serving = socket.clone();
        std::thread::spawn(move || serve(&serving));
        let deadline = Instant::now() + Duration::from_secs(5);
        while Client::connect(&socket).is_err() {
            assert!(Instant::now() < deadline, "runner did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
        let ask = |line: &str| {
            use std::process::{Command, Stdio};
            let mut nc = Command::new("/usr/bin/nc").arg("-U").arg(&socket).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
            writeln!(nc.stdin.as_mut().unwrap(), "{line}").unwrap();
            let mut first = String::new();
            BufReader::new(nc.stdout.take().unwrap()).read_line(&mut first).unwrap();
            let _ = nc.kill();
            let _ = nc.wait();
            first
        };
        assert!(ask(r#"{"op":"hello"}"#).contains("protocol"));
        for op in [r#"{"op":"list"}"#, r#"{"op":"spawn","argv":["/bin/true"],"cwd":"/tmp","cols":80,"rows":24}"#, r#"{"op":"write","id":"x","data":"y"}"#, r#"{"op":"attach","id":"x"}"#, r#"{"op":"snapshot","id":"x"}"#, r#"{"op":"watch"}"#] {
            assert!(ask(op).contains("Refused"), "{op}");
        }
        assert_eq!(Client::connect(&socket).unwrap().call(json!({"op": "list"})).unwrap()["sessions"].as_array().unwrap().len(), 0, "nothing was started");
    }

    #[test]
    fn random_id_is_unique_across_rapid_calls() {
        let mut prefixes = std::collections::BTreeSet::new();
        for _ in 0..64 {
            let id = random_id();
            assert_eq!(id.len(), 32);
            assert!(prefixes.insert(id[..10].to_string()), "duplicate random_id prefix");
        }
    }

    #[test]
    fn dsr_handles_split_chunks_and_view_attachment() {
        #[derive(Clone, Default)]
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let sink = Sink::default();
        let writer: Mutex<Option<Box<dyn Write + Send>>> =
            Mutex::new(Some(Box::new(sink.clone())));
        let mut dsr = DsrScanner { matched: 0 };

        // Split across read chunks without a view attached -> answered once.
        handle_dsr(&mut dsr, b"hello\x1b[", false, &writer);
        assert!(sink.0.lock().unwrap().is_empty());
        handle_dsr(&mut dsr, b"6nworld", false, &writer);
        assert_eq!(&*sink.0.lock().unwrap(), b"\x1b[1;1R");

        // Preceding ESC before ESC[6n still matches.
        sink.0.lock().unwrap().clear();
        handle_dsr(&mut dsr, b"\x1b\x1b[6n", false, &writer);
        assert_eq!(&*sink.0.lock().unwrap(), b"\x1b[1;1R");

        // With a view attached -> runner does not answer.
        sink.0.lock().unwrap().clear();
        handle_dsr(&mut dsr, b"\x1b[6n", true, &writer);
        assert!(sink.0.lock().unwrap().is_empty());
    }
}
