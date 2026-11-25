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
//! - `{"op":"attach","id":...}` → `{"ok":true,"from":N}`, then the connection carries raw
//!   bytes: the scrollback, then live output. `from` is the offset of the first
//!   byte sent in all the session's output so far. With `"since":N` the
//!   scrollback starts at that offset when the runner still holds it, so a view
//!   that keeps what it showed takes only what it missed (MCR-139); otherwise
//!   it is the whole scrollback, and `from` says so. A runner before this
//!   answers without `from`. Bytes the client sends are typed
//!   into the terminal. A view that falls too far behind is disconnected and
//!   reattaches (at most once per view; the child never waits for a viewer).
//! - `{"op":"watch"}` → `{"ok":true}`, then one JSON event per line.
//!
//! Anyone who can reach the socket is the user (same OS user, 0700 directory);
//! the runner does no authorization of its own.

use crate::ipc::{self, Listener, Stream};
use crate::program::{self, Program, Said};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PROTOCOL: u32 = 1;
const SCROLLBACK: usize = 4 * 1024 * 1024;
/// How often a view with nothing to send looks whether its client went away.
const VIEW_LOOK: Duration = Duration::from_millis(250);
/// Output chunks queued per attached view before the view is dropped.
const VIEW_QUEUE: usize = 2048;
/// Exit when nothing runs and nobody is connected for this long.
const IDLE_EXIT: Duration = Duration::from_secs(600);
const MAX_REQUEST: u64 = 1024 * 1024;
/// How long an ended session's output is still read (`Drained`).
#[cfg(unix)]
const EXIT_DRAIN: Duration = Duration::from_secs(3);
/// How often a reader with nothing to read looks whether it has drained.
#[cfg(unix)]
const READ_LOOK: Duration = Duration::from_millis(250);
/// The soft limit on open files the runner and the service ask for (MCR-151):
/// each live session holds three pty descriptors in the runner and its views
/// three sockets each, and launchd starts both with a soft limit of 256.
#[cfg(unix)]
const OPEN_FILES: libc::rlim_t = 8192;
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
    /// What the program said of itself in its output (OSC 7501, 133, 9;4;
    /// MCR-115). Untrusted: any output can print it.
    #[serde(default, skip_serializing_if = "Program::is_empty")]
    pub program: Program,
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
/// signals for the attention queue. Also what a program says of itself
/// (OSC 7501, 133 and 9;4, read by `program`), and a full reset.
#[derive(Default)]
struct Scanner {
    state: ScanState,
    osc: Vec<u8>,
    /// The OSC ran past `MAX_OSC`: what is kept of it is only its start
    overrun: bool,
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
    Program(Said),
    Reset,
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
                        self.overrun = false;
                        self.state = ScanState::Osc;
                    } else if b == b'c' {
                        out.push(Signal::Reset);
                        self.state = ScanState::Ground;
                    } else {
                        self.state = if b == 0x1b { ScanState::Esc } else { ScanState::Ground };
                    }
                }
                ScanState::Osc => match b {
                    0x07 => {
                        self.finish(1, out);
                        self.state = ScanState::Ground;
                    }
                    0x1b => self.state = ScanState::OscEsc,
                    _ if self.osc.len() < MAX_OSC => self.osc.push(b),
                    _ => self.overrun = true,
                },
                ScanState::OscEsc => {
                    if b == b'\\' {
                        self.finish(2, out);
                        self.state = ScanState::Ground;
                    } else if b == b']' {
                        // An aborted OSC followed by a new one
                        self.osc.clear();
                        self.overrun = false;
                        self.state = ScanState::Osc;
                    } else {
                        self.state = if b == 0x1b { ScanState::Esc } else { ScanState::Ground };
                    }
                }
            }
        }
    }

    /// `terminator` is the length of the ST: 1 for BEL, 2 for ESC \\.
    fn finish(&mut self, terminator: usize, out: &mut Vec<Signal>) {
        // A sequence too long for its whole length to be known is over every limit
        let sequence = if self.overrun { usize::MAX } else { 2 + self.osc.len() + terminator };
        if let Some(said) = program::read(&self.osc, sequence) {
            out.push(Signal::Program(said));
            self.osc.clear();
            return;
        }
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
    writer: &Mutex<Option<impl Write>>,
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

/// What types into a terminal. On unix it is the runner's own copy of the
/// master, not portable-pty's writer: that one's destructor writes a newline
/// and an end-of-file into the terminal and waits for room to do so, which a
/// job that keeps an ended session's terminal open without reading it never
/// makes (review 17215). Closing this one is a plain close.
#[cfg(unix)]
type Writer = std::fs::File;
#[cfg(not(unix))]
type Writer = Box<dyn Write + Send>;

/// A copy of a pty master that the runner owns (unix), close-on-exec like it.
#[cfg(unix)]
fn dup_master(master: &(dyn MasterPty + Send)) -> Result<std::fs::File, String> {
    use std::os::fd::FromRawFd;
    let fd = master.as_raw_fd().ok_or("The terminal has no descriptor")?;
    // SAFETY: duplicates a descriptor the master owns
    let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(format!("Cannot use the terminal: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: `copy` is a fresh descriptor owned by nothing else
    Ok(unsafe { std::fs::File::from_raw_fd(copy) })
}

/// Makes the master non-blocking (unix). The flag is on the open file, which
/// the master, the reader and the writer share: neither a read nor a write
/// then waits inside the kernel, and both wait in `poll`, where they look
/// whether the session has ended (`Drained`, `Session::type_in`).
#[cfg(unix)]
fn nonblocking(file: &std::fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    // SAFETY: plain fcntl calls on a descriptor we own
    let ok = unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Cannot use the terminal: {}", std::io::Error::last_os_error()))
    }
}

/// Waits up to `READ_LOOK` for `events` on `fd` (unix): whether it came, or the
/// error. An interrupted wait counts as a wait that saw nothing.
#[cfg(unix)]
fn wait_for(fd: std::os::fd::RawFd, events: libc::c_short) -> std::io::Result<bool> {
    let mut ready = libc::pollfd { fd, events, revents: 0 };
    // SAFETY: one valid pollfd
    let n = unsafe { libc::poll(&mut ready, 1, READ_LOOK.as_millis() as libc::c_int) };
    if n < 0 {
        let e = std::io::Error::last_os_error();
        return if e.kind() == std::io::ErrorKind::Interrupted { Ok(false) } else { Err(e) };
    }
    if ready.revents & libc::POLLNVAL != 0 {
        return Err(std::io::Error::from_raw_os_error(libc::EBADF));
    }
    // Ready, a hangup or an error: the read or write that follows says which
    Ok(n > 0)
}

/// The terminal's output as the pump reads it (unix). Once the session's
/// process has ended, output is read for `EXIT_DRAIN` more and then the reader
/// ends: something the agent left running in the background that kept the
/// terminal open (a job that ignores hangup) would otherwise hold the reader's
/// descriptor, the pty and the pump's thread for as long as it lives (MCR-151).
#[cfg(unix)]
struct Drained {
    file: std::fs::File,
    session: Arc<Session>,
}

#[cfg(unix)]
impl Read for Drained {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        loop {
            // A monotonic clock: a wall clock set back would keep the reader on (review 17215)
            if lock(&self.session.ended).is_some_and(|at| at.elapsed() >= EXIT_DRAIN) {
                return Ok(0);
            }
            if !wait_for(self.file.as_raw_fd(), libc::POLLIN)? {
                continue;
            }
            match self.file.read(buf) {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                other => return other,
            }
        }
    }
}

struct Output {
    ring: VecDeque<u8>,
    /// All the output so far, in bytes: the ring ends at this offset
    total: u64,
    /// Attached views, each by a number of its own so that one that ends can leave at once
    views: Vec<(u64, SyncSender<Arc<[u8]>>)>,
    next_view: u64,
    scanner: Scanner,
    last_bell: u64,
    /// A program status query is passed on at most once a second
    last_query: u64,
    closed: bool,
}

struct Session {
    info: Mutex<Info>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Writer>>,
    /// When the wait thread saw the process end, on a monotonic clock. Its
    /// lock is held only for a moment: by the exit to publish it, and by
    /// `type_in` around its last look and one non-blocking write, so no byte
    /// is typed once the end is published (review 17220)
    ended: Mutex<Option<Instant>>,
    #[cfg(windows)]
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    #[cfg(windows)]
    job: Mutex<Option<WinJob>>,
    output: Mutex<Output>,
}

impl Session {
    /// Types `bytes` into the terminal: all of them, or an error. On unix a
    /// write waits for room in `poll`, never in the kernel, and gives up when
    /// the process has ended, so a full input queue that nobody reads any more
    /// cannot hold the writer's lock, and with it the end of the session
    /// (review 17215).
    fn type_in(&self, bytes: &[u8]) -> std::io::Result<()> {
        let ended = || std::io::Error::new(std::io::ErrorKind::BrokenPipe, "The session has ended");
        let mut writer = lock(&self.writer);
        let Some(writer) = writer.as_mut() else {
            return Err(ended());
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let mut rest = bytes;
            while !rest.is_empty() {
                if lock(&self.ended).is_some() {
                    return Err(ended());
                }
                if !wait_for(writer.as_raw_fd(), libc::POLLOUT)? {
                    continue;
                }
                // The session may have ended while `poll` waited: the last look
                // and the write are one step against the end's publication. The
                // write cannot block (the master is non-blocking)
                let wrote = {
                    let gate = lock(&self.ended);
                    if gate.is_some() {
                        return Err(ended());
                    }
                    writer.write(rest)
                };
                match wrote {
                    Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                    Ok(n) => rest = &rest[n..],
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        }
        // Windows writes block; the exit takes the writer first and waits for one under way
        #[cfg(not(unix))]
        {
            if lock(&self.ended).is_some() {
                return Err(ended());
            }
            writer.write_all(bytes).and_then(|_| writer.flush())
        }
    }
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

/// The soft limit on open files to ask for, or none when it is high enough:
/// `OPEN_FILES`, never above the hard limit or the per-process ceiling the
/// system names (macOS: `OPEN_MAX` and `kern.maxfilesperproc`).
#[cfg(unix)]
fn open_files_target(soft: libc::rlim_t, hard: libc::rlim_t, ceiling: Option<libc::rlim_t>) -> Option<libc::rlim_t> {
    let target = OPEN_FILES.min(hard).min(ceiling.unwrap_or(libc::RLIM_INFINITY));
    (target > soft).then_some(target)
}

/// Raises this process's soft limit on open files toward the hard limit (MCR-151:
/// launchd's 256 let a runner with some forty sessions refuse to start the next
/// one). Returns the limit before and after.
#[cfg(unix)]
pub fn raise_open_files() -> Result<(libc::rlim_t, libc::rlim_t), String> {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: plain syscall into a local struct
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    #[cfg(target_os = "macos")]
    let ceiling = {
        let mut per_process: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: reads one int into a local of that size
        let read = unsafe {
            libc::sysctlbyname(
                c"kern.maxfilesperproc".as_ptr(),
                (&mut per_process as *mut libc::c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        // OPEN_MAX: setrlimit refuses more on macOS
        let open_max: libc::rlim_t = 10240;
        Some(if read && per_process > 0 { open_max.min(per_process as libc::rlim_t) } else { open_max })
    };
    #[cfg(not(target_os = "macos"))]
    let ceiling = None;
    let before = limit.rlim_cur;
    let Some(target) = open_files_target(before, limit.rlim_max, ceiling) else {
        return Ok((before, before));
    };
    limit.rlim_cur = target;
    // SAFETY: plain syscall with the struct read above
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(format!("{} (asked {target})", std::io::Error::last_os_error()));
    }
    Ok((before, target))
}

/// `raise_open_files` for a unit's start, written to its log (its stderr).
pub fn note_open_files(unit: &str) {
    #[cfg(unix)]
    match raise_open_files() {
        Ok((before, after)) if before == after => eprintln!("{unit}: open files limit {after}"),
        Ok((before, after)) => eprintln!("{unit}: open files limit raised from {before} to {after}"),
        Err(e) => eprintln!("{unit}: open files limit not raised: {e}"),
    }
    #[cfg(not(unix))]
    let _ = unit;
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
        #[cfg(unix)]
        let (reader, writer) = {
            let reader = dup_master(pair.master.as_ref())?;
            nonblocking(&reader)?;
            (reader, dup_master(pair.master.as_ref())?)
        };
        #[cfg(not(unix))]
        let (reader, writer) = (
            pair.master.try_clone_reader().map_err(|e| e.to_string())?,
            pair.master.take_writer().map_err(|e| e.to_string())?,
        );
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
            program: Program::default(),
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            ended: Mutex::new(None),
            #[cfg(windows)]
            killer: Mutex::new(killer),
            #[cfg(windows)]
            job: Mutex::new(job),
            output: Mutex::new(Output {
                ring: VecDeque::new(),
                total: 0,
                views: Vec::new(),
                next_view: 0,
                scanner: Scanner::default(),
                last_bell: 0,
                last_query: 0,
                closed: false,
            }),
        });
        lock(&self.sessions).insert(id.clone(), session.clone());
        self.broadcast(json!({"event": "spawned", "session": info}));

        let runner = self.clone();
        let reading = session.clone();
        #[cfg(unix)]
        let reader: Box<dyn Read + Send> = Box::new(Drained { file: reader, session: session.clone() });
        std::thread::spawn(move || runner.pump(&reading, reader));

        let runner = self.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let exit = match status {
                Ok(s) => Exit { code: s.exit_code(), signal: s.signal().map(str::to_owned), at: now_ms() },
                Err(_) => Exit { code: u32::MAX, signal: None, at: now_ms() },
            };
            {
                let mut info = lock(&session.info);
                info.exit = Some(exit.clone());
                info.program.exited();
            }
            *lock(&session.ended) = Some(Instant::now());
            // Nothing is typed into or resized in an ended terminal: its master
            // and the writer's copy are closed now, not when the session is
            // forgotten, which may be days later or never (MCR-151). The reader
            // keeps its own copy until the output is drained (`Drained`).
            //
            // Unix: the master's lock is held only for an ioctl; the end is told
            // before the writer's lock is taken, which a write under way holds
            // until it sees the end (at most `READ_LOOK`, review 17215). Closing
            // the master is a plain close.
            #[cfg(unix)]
            {
                lock(&session.master).take();
                runner.broadcast(json!({"event": "exited", "id": id, "exit": exit}));
                lock(&session.writer).take();
            }
            // Windows: the writer goes first. Dropping the master calls
            // ClosePseudoConsole, which before Windows 11 24H2 waits until the
            // console host has drained its output; while the synchronous input
            // writer is still open, the pump can block in a DSR answer on that
            // writer (`handle_dsr`) and stop draining, and the close would wait
            // for good (review 17220). No test pins this order or the hang it
            // avoids; CI's Windows job runs the Windows tests, which end their
            // sessions through it.
            #[cfg(not(unix))]
            {
                lock(&session.writer).take();
                lock(&session.master).take();
                runner.broadcast(json!({"event": "exited", "id": id, "exit": exit}));
            }
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
                out.total += n as u64;
                let excess = out.ring.len().saturating_sub(SCROLLBACK);
                out.ring.drain(..excess);
                out.views.retain(|(_, v)| v.try_send(chunk.clone()).is_ok());
                has_views = !out.views.is_empty();
                out.scanner.feed(&chunk, &mut signals);
                let now = now_ms();
                // Agents ring often; one bell event per second per session is enough
                signals.retain(|s| {
                    let last = match s {
                        Signal::Bell => &mut out.last_bell,
                        Signal::Program(Said::Query) => &mut out.last_query,
                        _ => return true,
                    };
                    let keep = now.saturating_sub(*last) >= 1000;
                    if keep {
                        *last = now;
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
                    // Whether to answer is the service's to decide (off unless the operator turned it on)
                    Signal::Program(Said::Query) => self.broadcast(json!({"event": "program_query", "id": id})),
                    // Kept for the session list only: a program can report as fast as it writes
                    Signal::Program(said) => lock(&session.info).program.take(said, now_ms()),
                    Signal::Reset => lock(&session.info).program.reset(),
                }
            }
        }
        {
            let mut out = lock(&session.output);
            out.closed = true;
            out.views.clear();
        }
        // The terminal closed: a working record read from the last chunk after the
        // exit was seen goes too (the wait thread and this one race)
        lock(&session.info).program.exited();
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
                session.type_in(&[0x03]).map_err(|e| e.to_string())
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
                session.type_in(data.as_bytes()).map_err(|e| e.to_string())?;
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

    fn attach(&self, id: &str, since: Option<u64>, mut stream: Stream) -> std::io::Result<()> {
        let session = match self.get(id) {
            Ok(s) => s,
            Err(e) => return writeln!(stream, "{}", json!({ "error": e })),
        };
        let (tx, rx) = sync_channel::<Arc<[u8]>>(VIEW_QUEUE);
        let (view, from, scrollback): (u64, u64, Vec<u8>) = {
            let mut out = lock(&session.output);
            out.next_view += 1;
            let view = out.next_view;
            if !out.closed {
                out.views.push((view, tx));
            }
            let (from, skip) = replay_from(out.total, out.ring.len(), since);
            (view, from, out.ring.iter().skip(skip).copied().collect())
        };
        // However this view ends, a failed handshake included, its sender leaves the session (review 17086)
        let _leave = Leave { session: &session, view };
        writeln!(stream, "{}", json!({"ok": true, "from": from}))?;
        stream.write_all(&scrollback)?;

        let mut input = stream.try_clone()?;
        let typing = session.clone();
        // The client went away: on a quiet session no output would ever wake the
        // loop below to find that out, and each detached view kept a thread and
        // a socket here for as long as the agent said nothing (MCR-139)
        let gone = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let left = gone.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = input.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if typing.type_in(&buf[..n]).is_err() {
                    break;
                }
            }
            left.store(true, Ordering::SeqCst);
            let _ = input.shutdown(std::net::Shutdown::Both);
        });
        loop {
            match rx.recv_timeout(VIEW_LOOK) {
                Ok(chunk) => {
                    if stream.write_all(&chunk).is_err() {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !gone.load(Ordering::SeqCst) => {}
                Err(_) => break,
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
                Some("attach") => return self.attach(req["id"].as_str().unwrap_or(""), req["since"].as_u64(), writer),
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
    open_stream_reply(socket, req).map(|(reader, stream, _)| (reader, stream))
}

/// `open_stream`, with the runner's first reply (an attach says `from` there).
pub fn open_stream_reply(socket: &Path, req: Value) -> Result<(BufReader<Stream>, Stream, Value), String> {
    let mut stream = Stream::connect(socket).map_err(|e| format!("Runner unavailable: {e}"))?;
    writeln!(stream, "{req}").map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = Vec::new();
    (&mut reader).take(64 * 1024).read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_slice(&line).map_err(|_| "The runner refused the stream")?;
    if let Some(e) = reply["error"].as_str() {
        return Err(e.to_string());
    }
    Ok((reader, stream, reply))
}

/// Takes a view's sender out of its session when the view ends, on any path.
struct Leave<'a> {
    session: &'a Session,
    view: u64,
}

impl Drop for Leave<'_> {
    fn drop(&mut self) {
        lock(&self.session.output).views.retain(|(v, _)| *v != self.view);
    }
}

/// Where a new view's replay starts: the offset of its first byte in all the
/// output (`total` bytes, the last `held` of them in the ring), and how many
/// ring bytes to skip. `since` is taken when the ring still holds it.
pub fn replay_from(total: u64, held: usize, since: Option<u64>) -> (u64, usize) {
    let start = total - held as u64;
    match since {
        Some(at) if at >= start && at <= total => (at, (at - start) as usize),
        _ => (start, 0),
    }
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

/// What `ensure_unit` answers while the person has not allowed the background
/// units, or has stopped them. The app shows its question on this text.
pub const NOT_ALLOWED: &str = "Background processes are not allowed";

/// Whether this process may install, start, replace or remove the background
/// units for the folder a socket lives in. Only the app's own config folder
/// qualifies, and never a test: a harness opened in a temporary folder once
/// replaced the person's running runner with a test binary, which ended every
/// hosted session.
fn may_manage(socket: &Path) -> bool {
    socket.parent().is_some_and(own_folder)
}

/// The app's own config folder, outside tests.
fn own_folder(dir: &Path) -> bool {
    !cfg!(test) && crate::get_config_dir().ok().as_deref() == Some(dir)
}

fn consent_file(dir: &Path) -> PathBuf {
    dir.join("background.state")
}

/// What the person decided about the background units kept in `dir`:
/// allowed, stopped, or nothing yet.
pub fn consent(dir: &Path) -> Option<bool> {
    // Units installed by an earlier version count as allowed for the app's own folder only
    decision(dir, own_folder(dir) && installed(&RUNNER))
}

fn decision(dir: &Path, installed: bool) -> Option<bool> {
    match std::fs::read_to_string(consent_file(dir)).ok().as_deref().map(str::trim) {
        Some("allowed") => Some(true),
        Some(_) => Some(false),
        // Installed by a version that did not ask: the person has been running them
        None if installed => {
            let _ = set_consent(dir, true);
            Some(true)
        }
        None => None,
    }
}

/// Record the person's decision. Only ever called after a native dialog, or
/// by their own stop: nothing an agent or the page says sets it.
pub fn set_consent(dir: &Path, allowed: bool) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(consent_file(dir), if allowed { "allowed\n" } else { "stopped\n" }).map_err(|e| e.to_string())
}

/// Forget the decision (uninstall): the next start asks again.
pub fn clear_consent(dir: &Path) {
    let _ = std::fs::remove_file(consent_file(dir));
}

/// The unit's LaunchAgent file; none on systems without launchd.
pub fn plist_path(unit: &Unit) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    dirs::home_dir().map(|h| h.join("Library/LaunchAgents").join(format!("{}.plist", unit.label)))
}

pub fn installed(unit: &Unit) -> bool {
    plist_path(unit).is_some_and(|p| p.exists())
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

#[cfg(windows)]
fn alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid <= 0 {
        return false;
    }
    // SAFETY: the handle is checked for null, used once and closed
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        running
    }
}

/// Ask a process to end (`hard`: force it). Windows has no gentle signal for a
/// background process, so both end it outright.
#[cfg(unix)]
fn end_process(pid: i32, hard: bool) {
    // SAFETY: the pid is the one the unit itself reported a moment ago
    unsafe { libc::kill(pid, if hard { libc::SIGKILL } else { libc::SIGTERM }) };
}

#[cfg(windows)]
fn end_process(pid: i32, _hard: bool) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: the handle is checked for null, used once and closed
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// A leftover socket file of a unit that is gone. Windows AF_UNIX sockets are plain files.
fn is_socket_file(file_type: std::fs::FileType) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::FileTypeExt::is_socket(&file_type)
    }
    #[cfg(not(unix))]
    {
        file_type.is_file()
    }
}

/// What is known of a unit without starting it.
pub fn unit_status(socket: &Path, unit: &Unit) -> Value {
    let hello = Client::connect(socket).and_then(|mut c| c.call(json!({"op": "hello"}))).ok();
    let pid = hello.as_ref().and_then(|h| h["pid"].as_i64());
    // When it started, as `ps` prints it (Windows has no `ps`: unknown there)
    let since = pid.filter(|_| cfg!(unix)).and_then(|pid| std::process::Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    json!({
        "name": unit.name,
        "label": unit.label,
        "plist": plist_path(unit).map(|p| p.display().to_string()),
        "installed": installed(unit),
        "running": hello.is_some(),
        "pid": pid,
        "since": since,
        "version": hello.as_ref().map(|h| h["version"].clone()),
        "exe": hello.as_ref().map(|h| h["exe"].clone()),
    })
}

/// Stop a unit: launchd is told to let it go, and the process is ended. Its
/// LaunchAgent file stays unless `remove` is set. Processes the unit started
/// are not touched: end sessions first.
pub fn stop_unit(socket: &Path, unit: &Unit, remove: bool) -> Result<(), String> {
    let pid = Client::connect(socket).and_then(|mut c| c.call(json!({"op": "hello"}))).ok().and_then(|h| h["pid"].as_i64()).map(|p| p as i32);
    #[cfg(target_os = "macos")]
    {
        // SAFETY: getuid has no preconditions
        let service = format!("gui/{}/{}", unsafe { libc::getuid() }, unit.label);
        // The label may be held by another copy of the app with its own
        // sessions (a build with another config folder): only what launchd
        // runs as this very process, or holds without running, is let go
        let ours = match launchd_pid(&service) {
            None => false,
            Some(running) => running.is_none() || running == pid,
        };
        if ours && may_manage(socket) {
            let _ = std::process::Command::new("launchctl").args(["bootout", &service]).output();
        }
    }
    if let Some(pid) = pid {
        let ended = |wait: Duration| {
            let deadline = Instant::now() + wait;
            while alive(pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            !alive(pid)
        };
        if !ended(Duration::from_millis(500)) {
            end_process(pid, false);
            if !ended(Duration::from_secs(3)) {
                end_process(pid, true);
                if !ended(Duration::from_secs(2)) {
                    return Err(format!("The {} (pid {pid}) did not stop", unit.name));
                }
            }
        }
    }
    if std::fs::symlink_metadata(socket).is_ok_and(|m| is_socket_file(m.file_type())) {
        let _ = std::fs::remove_file(socket);
    }
    if remove && may_manage(socket) {
        if let Some(plist) = plist_path(unit).filter(|p| p.exists()) {
            std::fs::remove_file(&plist).map_err(|e| format!("{}: {e}", plist.display()))?;
        }
    }
    Ok(())
}

/// The process launchd runs for a service: `None` when the service is not
/// registered, `Some(None)` when it is registered and not running.
#[cfg(target_os = "macos")]
fn launchd_pid(service: &str) -> Option<Option<i32>> {
    let out = std::process::Command::new("launchctl").args(["print", service]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(printed_pid(&String::from_utf8_lossy(&out.stdout)))
}

/// The `pid = N` line of `launchctl print`, at the service's own level.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn printed_pid(text: &str) -> Option<i32> {
    text.lines().find_map(|l| l.strip_prefix("\tpid = ").and_then(|p| p.trim().parse().ok()))
}

/// Connect to a unit's socket, starting the unit if needed. Returns its `hello`.
/// A unit that is not running is started only when the person allowed
/// background processes (`consent`).
pub fn ensure_unit(socket: &Path, unit: &Unit, protocol: u32) -> Result<Value, String> {
    let hello = |socket: &Path| Client::connect(socket).and_then(|mut c| c.call(json!({"op": "hello"})));
    if let Ok(h) = hello(socket) {
        return check_protocol(h, unit, protocol);
    }
    // Before anything is read or written about consent: another folder has no say over the units
    if !may_manage(socket) || socket.parent().and_then(consent) != Some(true) {
        return Err(NOT_ALLOWED.into());
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
        // Another build (dev or release) registered itself. It did not answer on
        // this socket, but it may be running for another folder with sessions
        // of its own: a running unit is never taken away from under them.
        if let Some(Some(pid)) = launchd_pid(&service) {
            return Err(format!("The {} is already run by another copy of Agent MCR (pid {pid}). Quit that copy and stop its background processes first.", unit.name));
        }
        // Registered and not running: re-register this executable.
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

    #[test]
    fn units_start_only_after_the_person_allowed_them() {
        let socket = temp_socket("consent");
        let dir = socket.parent().unwrap();
        assert_eq!(decision(dir, false), None, "nothing decided on a fresh install");
        // Nothing listens and nothing was allowed: refused before anything is started
        let unit = Unit { label: "cc.lambdahouse.agent-mcr.test-never-installed", flag: "--none", name: "test unit" };
        if !installed(&RUNNER) {
            assert_eq!(ensure_unit(&socket, &unit, PROTOCOL).unwrap_err(), NOT_ALLOWED);
        }
        set_consent(dir, false).unwrap();
        assert_eq!(decision(dir, true), Some(false), "a stop holds although the units are installed");
        assert_eq!(ensure_unit(&socket, &unit, PROTOCOL).unwrap_err(), NOT_ALLOWED);
        set_consent(dir, true).unwrap();
        assert_eq!(consent(dir), Some(true));
        clear_consent(dir);
        // Units installed by a version that did not ask count as allowed, once
        assert_eq!(decision(dir, true), Some(true));
        assert_eq!(decision(dir, false), Some(true));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_pid_launchd_runs_is_read_at_the_service_level() {
        let printed = "gui/501/x = {\n\tactive count = 1\n\tstate = running\n\tpid = 36842\n\tendpoints = {\n\t\tpid = 7\n\t}\n}\n";
        assert_eq!(printed_pid(printed), Some(36842));
        assert_eq!(printed_pid("gui/501/x = {\n\tstate = not running\n}\n"), None);
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
                // OSC 9;4 is progress, not a notification
                Signal::Program(Said::Progress(Some(program::Progress { state: "normal".into(), value: Some(50), at: 0 }))),
                Signal::Notify("Codex".into(), "Approve?".into()),
            ]
        );
    }

    #[test]
    fn scanner_reads_program_status_split_anywhere_with_either_terminator() {
        let whole = b"\x1b]7501;state=working:progress=40:app=cargo\x1b\\\x1b]7501;state=blocked:id=deploy:kind=permission\x07\x1b]7501;?\x1b\\\x1b]133;D;1\x07\x1b]9;4;1;30\x1b\\\x1bc";
        let mut expected = Vec::new();
        Scanner::default().feed(whole, &mut expected);
        assert_eq!(expected.len(), 6, "{expected:?}");
        assert!(matches!(&expected[0], Signal::Program(Said::Report(r)) if r.state == "working" && r.progress == Some(40) && r.app == "cargo"));
        assert!(matches!(&expected[1], Signal::Program(Said::Report(r)) if r.id == "deploy" && r.kind == "permission"));
        assert_eq!(expected[2], Signal::Program(Said::Query));
        assert_eq!(expected[3], Signal::Program(Said::Prompt("D".into(), Some(1))));
        assert!(matches!(&expected[4], Signal::Program(Said::Progress(Some(p))) if p.value == Some(30)));
        assert_eq!(expected[5], Signal::Reset);
        // Cut at every byte, the stream says the same
        for cut in 1..whole.len() {
            let (mut scanner, mut out) = (Scanner::default(), Vec::new());
            scanner.feed(&whole[..cut], &mut out);
            scanner.feed(&whole[cut..], &mut out);
            assert_eq!(out, expected, "cut at {cut}");
        }
        // And one byte at a time
        let (mut scanner, mut out) = (Scanner::default(), Vec::new());
        whole.iter().for_each(|b| scanner.feed(&[*b], &mut out));
        assert_eq!(out, expected);
    }

    #[test]
    fn scanner_discards_a_program_report_longer_than_a_sequence_may_be() {
        let fits = |len: usize| {
            // ESC ] "7501;state=done:x=" filler ESC \ is `len` bytes in all
            let head = "7501;state=done:x=";
            let body = format!("{head}{}", "a".repeat(len - 2 - head.len() - 2));
            let mut out = Vec::new();
            Scanner::default().feed(format!("\x1b]{body}\x1b\\").as_bytes(), &mut out);
            !out.is_empty()
        };
        assert!(fits(program::MAX_SEQUENCE));
        assert!(!fits(program::MAX_SEQUENCE + 1));
        assert!(!fits(3 * program::MAX_SEQUENCE));
        // A long title is still cut and kept, as before
        let mut out = Vec::new();
        Scanner::default().feed(format!("\x1b]0;{}\x07", "t".repeat(5000)).as_bytes(), &mut out);
        assert!(matches!(&out[..], [Signal::Title(t)] if t.len() == MAX_OSC - 2));
        // The scanner is back on its feet after the long one
        let mut scanner = Scanner::default();
        let mut out = Vec::new();
        scanner.feed(format!("\x1b]7501;state=done:x={}\x07\x1b]7501;state=idle\x07", "a".repeat(5000)).as_bytes(), &mut out);
        assert!(matches!(&out[..], [Signal::Program(Said::Report(r))] if r.state == "idle"));
    }

    #[cfg(unix)]
    #[test]
    fn what_a_program_says_of_itself_is_in_the_list_and_a_query_is_an_event() {
        let socket = temp_socket("program");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        let (mut events, _keep) = open_stream(&socket, json!({"op": "watch"})).unwrap();
        // "cargo build" as title, base64; a query; then the program waits for a line and exits
        // The query three times in a row: passed on once
        let script = "printf '\\033]7501;state=working:progress=40:app=cargo:title=Y2FyZ28gYnVpbGQ\\033\\\\'; printf '\\033]7501;state=done:id=lint\\007'; printf '\\033]7501;?\\033\\\\\\033]7501;?\\007\\033]7501;?\\033\\\\'; read line; exit 0";
        control.call(json!({"op": "spawn", "id": "p1", "argv": ["/bin/sh", "-c", script], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains("\"program_query\"") {
            assert!(Instant::now() < deadline, "events: {seen}");
            let mut line = String::new();
            events.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        let program = &control.call(json!({"op": "list"})).unwrap()["sessions"][0]["program"];
        let records = program["records"].as_array().unwrap();
        assert_eq!((records[0]["state"].as_str(), records[0]["progress"].as_u64(), records[0]["app"].as_str(), records[0]["title"].as_str()), (Some("working"), Some(40), Some("cargo"), Some("cargo build")));
        assert_eq!((records[1]["id"].as_str(), records[1]["state"].as_str()), (Some("lint"), Some("done")));
        // The runner itself answers nothing: that is the service's to decide
        let (mut out, mut input) = open_stream(&socket, json!({"op": "attach", "id": "p1"})).unwrap();
        input.write_all(b"\n").unwrap();
        let _ = read_until(&mut out, "");
        // At the exit the working record goes and the done one stays
        while !seen.contains("\"exited\"") {
            assert!(Instant::now() < deadline, "events: {seen}");
            let mut line = String::new();
            events.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        assert_eq!(seen.matches("\"program_query\"").count(), 1, "one query a second is passed on: {seen}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let list = control.call(json!({"op": "list"})).unwrap();
            if !list["sessions"][0]["exit"].is_null() {
                let records = list["sessions"][0]["program"]["records"].as_array().cloned().unwrap_or_default();
                assert_eq!(records.iter().map(|r| r["id"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["lint"]);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(50));
        }
        control.call(json!({"op": "forget", "id": "p1"})).unwrap();
    }

    #[test]
    fn a_replay_starts_where_the_view_left_off_while_the_ring_holds_it() {
        // 100 bytes so far, all held: from where the view left off
        assert_eq!(replay_from(100, 100, Some(60)), (60, 60));
        assert_eq!(replay_from(100, 100, Some(100)), (100, 100));
        // No offset, or one the ring no longer holds, or one from the future: everything held
        assert_eq!(replay_from(100, 100, None), (0, 0));
        assert_eq!(replay_from(500, 100, Some(399)), (400, 0));
        assert_eq!(replay_from(500, 100, Some(501)), (400, 0));
        assert_eq!(replay_from(500, 100, Some(450)), (450, 50));
    }

    #[cfg(unix)]
    #[test]
    fn a_view_whose_client_went_away_ends_on_a_quiet_session() {
        let runner = Arc::new(Runner::default());
        runner.control(&json!({"op": "spawn", "id": "q1", "argv": ["/bin/sh", "-c", "read line"], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        let session = runner.get("q1").unwrap();
        for _ in 0..3 {
            let (server, client) = Stream::pair().unwrap();
            let (done, ended) = std::sync::mpsc::channel();
            let r = runner.clone();
            std::thread::spawn(move || {
                let _ = r.attach("q1", None, server);
                let _ = done.send(());
            });
            let mut reader = BufReader::new(client.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.contains("\"ok\""), "{line}");
            assert_eq!(lock(&session.output).views.len(), 1);
            // The app detaches; the agent prints nothing
            client.shutdown(std::net::Shutdown::Both).unwrap();
            drop(reader);
            drop(client);
            // It looks every VIEW_LOOK: four of them are plenty, and far less than any output would take on a quiet session
            assert!(ended.recv_timeout(VIEW_LOOK * 4).is_ok(), "the view's thread stays while the session is quiet");
            assert_eq!(lock(&session.output).views.len(), 0, "the view's sender stays in the session");
        }
        runner.control(&json!({"op": "signal", "id": "q1", "signal": "KILL"})).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_view_whose_handshake_fails_leaves_no_sender_behind() {
        let runner = Arc::new(Runner::default());
        runner.control(&json!({"op": "spawn", "id": "h1", "argv": ["/bin/sh", "-c", "read line"], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        let session = runner.get("h1").unwrap();
        for _ in 0..3 {
            let (server, client) = Stream::pair().unwrap();
            // The client is gone before the runner answers: the reply cannot be written
            server.shutdown(std::net::Shutdown::Write).unwrap();
            drop(client);
            assert!(runner.attach("h1", None, server).is_err());
            assert_eq!(lock(&session.output).views.len(), 0, "a sender stays in the session");
        }
        runner.control(&json!({"op": "signal", "id": "h1", "signal": "KILL"})).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_view_that_kept_its_bytes_is_sent_only_what_it_missed() {
        let socket = temp_socket("since");
        serve_in_background(&socket);
        let mut control = Client::connect(&socket).unwrap();
        control.call(json!({"op": "spawn", "id": "s1", "argv": ["/bin/sh", "-c", "printf 'one\\n'; read line; printf 'two\\n'; read line"], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        let (mut first, mut input, reply) = open_stream_reply(&socket, json!({"op": "attach", "id": "s1"})).unwrap();
        assert_eq!(reply["from"], 0);
        let shown = read_until(&mut first, "one");
        // Nothing more comes until a line is typed: the view has every byte so far
        std::thread::sleep(Duration::from_millis(200));
        let had = shown.len() as u64;
        drop(first);
        input.write_all(b"x\n").unwrap();
        drop(input);
        // Shown again from where it left off: what it missed, and not "one" a second time
        let (mut again, _w, reply) = open_stream_reply(&socket, json!({"op": "attach", "id": "s1", "since": had})).unwrap();
        assert_eq!(reply["from"], had);
        let missed = read_until(&mut again, "two");
        assert!(!missed.contains("one"), "{missed:?}");
        // An offset the runner cannot serve gets the whole scrollback, and says where it starts
        let (mut whole, _w, reply) = open_stream_reply(&socket, json!({"op": "attach", "id": "s1", "since": had + 1_000_000})).unwrap();
        assert_eq!(reply["from"], 0);
        let all = read_until(&mut whole, "two");
        assert!(all.contains("one"), "{all:?}");
        control.call(json!({"op": "signal", "id": "s1", "signal": "KILL"})).unwrap();
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

    #[cfg(unix)]
    #[test]
    fn the_open_files_limit_is_raised_toward_the_hard_limit_and_capped() {
        let inf = libc::RLIM_INFINITY;
        assert_eq!(open_files_target(256, inf, None), Some(OPEN_FILES), "launchd's 256 against an unlimited hard limit");
        assert_eq!(open_files_target(256, inf, Some(10240)), Some(OPEN_FILES));
        assert_eq!(open_files_target(256, inf, Some(4096)), Some(4096), "never above the per-process ceiling");
        assert_eq!(open_files_target(256, 1024, None), Some(1024), "never above the hard limit");
        assert_eq!(open_files_target(256, 256, None), None, "nothing to raise");
        assert_eq!(open_files_target(65536, inf, None), None, "a higher limit is never lowered");
        // This process: at least as high as asked afterwards, and asking again changes nothing
        let (_, after) = raise_open_files().unwrap();
        let (before, again) = raise_open_files().unwrap();
        assert_eq!((before, again), (after, after));
    }

    /// What a fixture leaves running, ended also when an assertion fails
    /// first: the release file lets its shell end, and the background job whose
    /// pid it wrote is killed (review 17220).
    #[cfg(unix)]
    struct Leftover {
        release: Option<PathBuf>,
        pidfile: PathBuf,
    }

    #[cfg(unix)]
    impl Leftover {
        fn job(&self) -> Option<i32> {
            std::fs::read_to_string(&self.pidfile).ok()?.trim().parse().ok().filter(|&pid| pid > 0)
        }

        fn alive(&self) -> bool {
            // SAFETY: signal 0 only asks whether the process exists
            self.job().is_some_and(|job| unsafe { libc::kill(job, 0) } == 0)
        }
    }

    #[cfg(unix)]
    impl Drop for Leftover {
        fn drop(&mut self) {
            if let Some(release) = &self.release {
                let _ = std::fs::write(release, "");
            }
            if let Some(job) = self.job() {
                // SAFETY: our own child's child, by the pid it wrote itself
                unsafe { libc::kill(job, libc::SIGKILL) };
            }
            // Killed once: a later drop must not hit a reused pid
            let _ = std::fs::remove_file(&self.pidfile);
        }
    }

    /// A session around a terminal the test holds, with nothing running in it.
    #[cfg(unix)]
    fn bare_session(writer: std::fs::File) -> Session {
        Session {
            info: Mutex::new(Info {
                id: "bare".into(),
                pid: None,
                argv: Vec::new(),
                cwd: "/".into(),
                started: 0,
                cols: 80,
                rows: 24,
                title: String::new(),
                last_output: 0,
                exit: None,
                meta: BTreeMap::new(),
                program: Program::default(),
            }),
            master: Mutex::new(None),
            writer: Mutex::new(Some(writer)),
            ended: Mutex::new(None),
            output: Mutex::new(Output {
                ring: VecDeque::new(),
                total: 0,
                views: Vec::new(),
                next_view: 0,
                scanner: Scanner::default(),
                last_bell: 0,
                last_query: 0,
                closed: false,
            }),
        }
    }

    /// Review 17220: a write waiting for room in a full input queue when the
    /// end is published types nothing more once room comes, and fails.
    #[cfg(unix)]
    #[test]
    fn no_byte_is_typed_once_the_end_is_published() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (mut master, mut slave) = (0, 0);
        // SAFETY: openpty fills two descriptors; the rest may be null
        let opened = unsafe {
            libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        assert_eq!(opened, 0, "{}", std::io::Error::last_os_error());
        // SAFETY: fresh descriptors, each owned once
        let (master, mut slave) = unsafe { (std::fs::File::from_raw_fd(master), std::fs::File::from_raw_fd(slave)) };
        // Raw: the input queue fills without a line, and nothing is echoed back
        // SAFETY: termios calls on our own terminal
        unsafe {
            let mut mode: libc::termios = std::mem::zeroed();
            assert_eq!(libc::tcgetattr(slave.as_raw_fd(), &mut mode), 0);
            libc::cfmakeraw(&mut mode);
            assert_eq!(libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &mode), 0);
        }
        nonblocking(&master).unwrap();
        nonblocking(&slave).unwrap();
        let drain = |slave: &mut std::fs::File| {
            let (mut total, mut buf) = (0, [0u8; 65536]);
            while let Ok(n @ 1..) = slave.read(&mut buf) {
                total += n;
            }
            total
        };

        let session = Arc::new(bare_session(master));
        let typing = {
            let session = session.clone();
            std::thread::spawn(move || session.type_in(&vec![b'x'; 1 << 20]))
        };
        std::thread::sleep(Duration::from_millis(300));
        assert!(!typing.is_finished(), "the terminal's input did not fill up");
        // The end is published while the write waits in poll; then room comes
        *lock(&session.ended) = Some(Instant::now());
        assert!(drain(&mut slave) > 0, "nothing was queued before the end");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !typing.is_finished() {
            assert!(Instant::now() < deadline, "the write did not see the end");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(typing.join().unwrap().is_err(), "a write cut short by the end reports it");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(drain(&mut slave), 0, "bytes were typed after the end was published");
        // And a write that starts after the end types nothing at all
        assert!(session.type_in(b"late").is_err());
        assert_eq!(drain(&mut slave), 0);
    }

    /// Descriptors this process has open: all of them, and those on a pty master.
    #[cfg(unix)]
    fn open_descriptors() -> (usize, usize) {
        let dir = if cfg!(target_os = "linux") { "/proc/self/fd" } else { "/dev/fd" };
        let fds: Vec<i32> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
            .collect();
        // Linux with its own devpts instance names the multiplexer /dev/pts/ptmx
        let ptmx = fds
            .iter()
            .filter(|&&fd| matches!(descriptor_path(fd).as_deref(), Some("/dev/ptmx" | "/dev/pts/ptmx")))
            .count();
        (fds.len(), ptmx)
    }

    #[cfg(target_os = "macos")]
    fn descriptor_path(fd: i32) -> Option<String> {
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes at most PATH_MAX bytes
        if unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) } != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0)?;
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn descriptor_path(fd: i32) -> Option<String> {
        std::fs::read_link(format!("/proc/self/fd/{fd}")).ok().map(|p| p.display().to_string())
    }

    /// MCR-151: the runner held an ended session's pty master and the writer's
    /// copy until the session was forgotten, and the reader's copy for as long
    /// as anything kept the terminal open. Counting descriptors needs a process
    /// of its own (other tests open and close theirs meanwhile), so this test
    /// runs itself again alone and the copy does the counting.
    #[cfg(unix)]
    #[test]
    fn an_ended_session_gives_back_every_descriptor() {
        const PROBE: &str = "AMCR_FD_PROBE";
        if std::env::var_os(PROBE).is_none() {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["runner::tests::an_ended_session_gives_back_every_descriptor", "--exact", "--test-threads=1", "--nocapture"])
                .env(PROBE, "1")
                .output()
                .unwrap();
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            assert!(out.status.success(), "the probe failed:\n{text}");
            assert!(text.contains("1 passed"), "the probe did not run:\n{text}");
            return;
        }
        let socket = temp_socket("fds");
        let path = socket.clone();
        std::thread::spawn(move || serve(&path).unwrap());
        // The first connection that gets through is kept and counted in the
        // baseline: a throwaway one would still be closing on the runner's side
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut control = loop {
            if let Ok(client) = Client::connect(&socket) {
                break client;
            }
            assert!(Instant::now() < deadline, "runner did not listen");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(control.call(json!({"op": "hello"})).unwrap()["protocol"], PROTOCOL);
        let (mut events, keep) = open_stream(&socket, json!({"op": "watch"})).unwrap();
        keep.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let settle = |want: (usize, usize), what: &str| {
            let deadline = Instant::now() + EXIT_DRAIN + Duration::from_secs(10);
            loop {
                let now = open_descriptors();
                if now == want {
                    return;
                }
                assert!(Instant::now() < deadline, "{what}: open (all, ptmx) {now:?}, expected {want:?}");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        // Within `wait`, or the test fails instead of hanging the suite
        let exited = |events: &mut BufReader<Stream>, id: &str, wait: Duration| {
            let needle = format!("\"id\":\"{id}\"");
            let deadline = Instant::now() + wait;
            let mut line = Vec::new();
            loop {
                assert!(Instant::now() < deadline, "no exited event for {id} within {wait:?}");
                match events.read_until(b'\n', &mut line) {
                    Ok(0) => panic!("the event stream ended"),
                    Ok(_) if line.ends_with(b"\n") => {
                        let text = String::from_utf8_lossy(&line);
                        if text.contains("\"exited\"") && text.contains(&needle) {
                            return;
                        }
                        line.clear();
                    }
                    Ok(_) => {}
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(e) => panic!("{e}"),
                }
            }
        };
        let quick = Duration::from_secs(10);
        let base = open_descriptors();

        // A session with a view: three pty descriptors while it runs (the master,
        // the reader's copy and the writer's copy), all back when it has ended
        control
            .call(json!({"op": "spawn", "id": "f1", "argv": ["/bin/sh", "-c", "printf 'ready\\n'; read line; exit 0"], "cwd": "/tmp", "cols": 80, "rows": 24}))
            .unwrap();
        let (mut out, mut input) = open_stream(&socket, json!({"op": "attach", "id": "f1"})).unwrap();
        // `read_until` gives up at its deadline only if a read returns
        input.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        read_until(&mut out, "ready");
        assert_eq!(open_descriptors().1, base.1 + 3, "a live session's pty descriptors");
        input.write_all(b"bye\n").unwrap();
        exited(&mut events, "f1", quick);
        drop((out, input));
        settle(base, "after an ended session, not forgotten");

        // A session that leaves a job behind holding its terminal: the job
        // ignores hangup and outlives the session
        let leftover = Leftover { release: None, pidfile: socket.with_file_name("job.pid") };
        let script = format!("trap '' HUP; sleep 60 & echo $! > {}; exit 0", leftover.pidfile.display());
        control.call(json!({"op": "spawn", "id": "f2", "argv": ["/bin/sh", "-c", script], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        exited(&mut events, "f2", quick);
        let alive = leftover.alive();
        settle(base, "after an ended session whose job keeps the terminal");
        drop(leftover);
        assert!(alive, "the left-behind job was still running while the descriptors were counted");

        // Typing that cannot go on: nobody reads the terminal's input, it is
        // full and a write is pending when the session ends, while a job that
        // ignores hangup keeps the terminal open. The end is still told at once,
        // the pending write fails, and every descriptor comes back (review 17215)
        let go = socket.with_file_name("full.go");
        let leftover = Leftover { release: Some(go.clone()), pidfile: socket.with_file_name("full.pid") };
        // The shell waits for the release file at most about 15 s
        let script = format!(
            "trap '' HUP; stty raw -echo; sleep 60 & echo $! > {}; printf 'ready\\n'; i=0; while [ ! -e {} ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done; exit 0",
            leftover.pidfile.display(),
            go.display()
        );
        control.call(json!({"op": "spawn", "id": "f3", "argv": ["/bin/sh", "-c", script], "cwd": "/tmp", "cols": 80, "rows": 24})).unwrap();
        let (mut out, input) = open_stream(&socket, json!({"op": "attach", "id": "f3"})).unwrap();
        input.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        read_until(&mut out, "ready");
        drop((out, input));
        let typing_socket = socket.clone();
        let typing = std::thread::spawn(move || {
            let mut client = Client::connect(&typing_socket).unwrap();
            client.call(json!({"op": "write", "id": "f3", "data": "x".repeat(512 * 1024)}))
        });
        std::thread::sleep(Duration::from_millis(500));
        assert!(!typing.is_finished(), "the terminal's input did not fill up");
        std::fs::write(&go, "").unwrap();
        exited(&mut events, "f3", Duration::from_secs(3));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !typing.is_finished() {
            assert!(Instant::now() < deadline, "the pending write outlived the session");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(typing.join().unwrap().is_err(), "a write into an ended session reports it");
        let alive = leftover.alive();
        settle(base, "after an ended session with a full input queue");
        drop(leftover);
        assert!(alive, "the left-behind job was still running while the descriptors were counted");

        // Forgetting them changes nothing more
        for id in ["f1", "f2", "f3"] {
            control.call(json!({"op": "forget", "id": id})).unwrap();
        }
        settle(base, "after forgetting");
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

    /// The number after the first `PID=` that is followed by digits and then a
    /// non-digit, so a number split across reads is not taken half-read.
    #[cfg(any(windows, test))]
    fn pid_line(text: &str) -> Option<u32> {
        text.match_indices("PID=").find_map(|(i, _)| {
            let rest = &text[i + 4..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0 && digits < rest.len()).then(|| rest[..digits].parse().ok()).flatten()
        })
    }

    #[test]
    fn pid_line_finds_the_number_after_escape_sequences() {
        assert_eq!(pid_line("\u{1b}[?25hPID=800\r\n"), Some(800));
        assert_eq!(pid_line("('PID' + '=' + $p.Id)\r\nPID=12\r\n"), Some(12));
        assert_eq!(pid_line("PID=80"), None, "the number may continue in the next read");
        assert_eq!(pid_line("PID=\r\n"), None);
        assert_eq!(pid_line("no pid here"), None);
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
        // ConPTY can put the line after escape sequences on the same row, so look
        // for PID= anywhere, and take the number only once a non-digit ends it.
        out.get_ref().set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(10);
        let desc_pid: u32 = loop {
            if let Some(pid) = pid_line(&String::from_utf8_lossy(&seen)) {
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

    /// A unit is installed, started, replaced or removed only for the app's
    /// own config folder, and never from a test. Without this, a harness in a
    /// temporary folder rewrote the real LaunchAgent to run a test binary.
    #[test]
    fn another_folder_or_a_test_never_touches_the_background_units() {
        let dir = std::env::temp_dir().join(format!("mcr-units-{}", random_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("runner.sock");
        let real = plist_path(&RUNNER).and_then(|p| std::fs::read(p).ok());
        assert!(!may_manage(&socket));
        // Even with consent recorded in that folder, nothing is started
        set_consent(&dir, true).unwrap();
        assert_eq!(ensure(&socket).unwrap_err(), NOT_ALLOWED);
        assert_eq!(ensure_unit(&dir.join("harness.sock"), &RUNNER, PROTOCOL).unwrap_err(), NOT_ALLOWED);
        // Stopping and removing leave the real unit's file as it was
        stop_unit(&socket, &RUNNER, true).unwrap();
        assert_eq!(plist_path(&RUNNER).and_then(|p| std::fs::read(p).ok()), real);
        // No consent is written into a folder just because the real units are installed
        let fresh = dir.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(ensure(&fresh.join("runner.sock")).unwrap_err(), NOT_ALLOWED);
        assert_eq!(consent(&fresh), None);
        assert!(!consent_file(&fresh).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

}
