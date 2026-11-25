//! The launch check for the Codex socket profile (MCR-162, reviews 17269
//! and 17282, owner's decision 17284). macOS only: the profile is passed on
//! `agents::CODEX_SOCKETS_OS` alone.
//!
//! The profile (`agents::codex_socket_words`) turns a Codex session's network
//! on so that Seatbelt passes its Unix sockets (codex-cli 0.172 passes them
//! no other way, 17285), and relies on Codex's managed proxy to keep
//! everything else closed. With the macOS application firewall on, it also
//! lets commands listen on TCP (`allow_local_binding`), which Seatbelt can
//! only grant on every address: the owner accepts that a listener is
//! reachable from the network and takes the firewall as the mitigation
//! (17284). The words alone prove none of it, so before every such launch
//! the harness, within one `DEADLINE`:
//!
//! 1. reads the firewall's global state (`socketfilterfw --getglobalstate`,
//!    no admin rights): ports only when it says on;
//! 2. runs Codex itself, through the session's login shell, in the
//!    session's folder, with the session's terminal environment (`check`):
//!    `codex sandbox -P agent-mcr-sockets --include-managed-config` with the
//!    launch's words around this program's probe (`--codex-sockets-probe`).
//!
//! The probe passes only when the proxy runs, Seatbelt itself refuses a
//! direct connection out, TCP listening is allowed or refused exactly as the
//! firewall decided, Unix sockets bind in `CODEX_SOCKETS` and nowhere else,
//! the proxy answers 403 for hosts it was given no domain for, and no config
//! layer, rules file or managed file that Codex reads could widen the proxy
//! (`refusal`). It answers with a code; what the harness shows is the fixed
//! message for that code (`MESSAGES`), never the probe's or Codex's text.
//!
//! What it cannot prove: a domain that a cloud-managed requirement grants
//! (the probe asks two hosts, not the list), and exec rules that a running
//! session saves or loads later. Whatever the owner's own shell startup
//! prints is trusted: agents run as the owner, so a shell that forges the
//! probe's line is the owner's own code, outside the threat model (as for
//! operator profiles). Cost: about 0.12 to 0.4 s per launch, 1.1 s on the
//! first run after a rebuild.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The flag the probe runs under (branches in `main` before Tauri starts)
pub const PROBE_FLAG: &str = "--codex-sockets-probe";
const PROBE_OK: &str = "agent-mcr sockets probe ok";
const PROBE_REFUSED: &str = "agent-mcr sockets probe refused";
/// The whole check, firewall included: a restart decides before it hangs
/// up, and also waits up to 7 s for the old process, inside the control
/// client's ten seconds
pub const DEADLINE: Duration = Duration::from_secs(2);
const FIREWALL: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
/// An address of TEST-NET-1 (RFC 5737): nothing answers there, so a probe
/// that the sandbox did not stop sends one SYN and waits
const OUTSIDE: &str = "192.0.2.1:9";
const MAX_CONFIG: u64 = 1 << 20;
const MAX_OUTPUT: usize = 64 * 1024;

/// Every reason the check gives, by the probe's code. `effectiveMode` shows
/// these words only
const MESSAGES: &[(&str, &str)] = &[
    ("proxy", "Codex's managed network proxy is not running"),
    ("proxy-address", "Codex's proxy address is not on loopback"),
    ("direct", "the sandbox did not refuse a direct connection out"),
    ("tcp-open", "the sandbox let a command listen on TCP"),
    ("tcp-closed", "the sandbox refused the TCP listening the profile asks for"),
    ("unix-closed", "Unix sockets in the socket folder were refused"),
    ("unix-wide", "Unix sockets outside the socket folder were allowed"),
    ("proxy-open", "the proxy let a request through"),
    ("managed", "managed Codex settings are present"),
    ("proxy-table", "a Codex config layer sets network_proxy as a table"),
    ("profile", "a Codex config layer defines the agent-mcr-sockets profile"),
    ("rule", "a Codex rules file holds a saved network rule"),
    ("unreadable", "a Codex config or rules file cannot be read"),
    ("invalid", "a Codex config file is not valid TOML"),
    ("nonce", "the probe was given no nonce"),
];
pub const TIMEOUT: &str = "the check did not finish within 2 s";
pub const NOT_STARTED: &str = "the check could not start";
pub const FOLDER: &str = "the socket folder is not this user's";
const NO_ANSWER: &str = "codex sandbox did not run the probe";
const CODEX_REFUSED: &str = "codex sandbox could not run the probe with these words";
const UNKNOWN: &str = "the probe's answer was not understood";
pub const FIREWALL_OFF: &str = "the macOS firewall is off";
pub const FIREWALL_UNKNOWN: &str = "the macOS firewall state is unknown";

/// What a launch gets: Unix sockets, and ports or the fixed reason why not
#[derive(Debug, PartialEq, Eq)]
pub struct Grant {
    pub ports: bool,
    pub no_ports: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Firewall {
    On,
    Off,
    Unknown,
}

/// The firewall's global state from `socketfilterfw --getglobalstate`:
/// state 1 (on) and 2 (essential services only) are on
pub fn firewall_from(success: bool, out: &str) -> Firewall {
    let state = out.split_once("(State = ").and_then(|(_, rest)| rest.split(')').next()).map(str::trim);
    match (success, state) {
        (true, Some("1" | "2")) => Firewall::On,
        (true, Some("0")) => Firewall::Off,
        _ => Firewall::Unknown,
    }
}

/// The command line that runs the probe under Codex, for the login shell:
/// `codex sandbox` with the socket profile selected (`-P`, managed
/// requirements included, as a session has them) and the launch's words
pub fn command(exe: &str, cwd: &Path, nonce: &str, ports: bool) -> String {
    use crate::agents::{codex_socket_words, sh, CODEX_SOCKET_PROFILE};
    let words: Vec<String> = codex_socket_words(ports).iter().map(|w| sh(w)).collect();
    format!(
        "exec codex sandbox -P {} --include-managed-config -C {} {} -- {} {PROBE_FLAG} {nonce} {} \"${{CODEX_HOME:-$HOME/.codex}}\"",
        sh(CODEX_SOCKET_PROFILE),
        sh(&cwd.display().to_string()),
        words.join(" "),
        sh(exe),
        if ports { "ports" } else { "sockets" },
    )
}

/// The whole check for a launch in `cwd`: `login` wraps a command line as
/// the session's login shell runs it, `env` is what the session's terminal
/// adds to this process's environment
#[cfg_attr(test, allow(dead_code))]
pub fn check(login: impl Fn(String) -> Vec<String>, exe: &str, cwd: &Path, env: &[(String, String)], nonce: &str) -> Result<Grant, &'static str> {
    let until = Instant::now() + DEADLINE;
    prepare_socket_dir()?;
    let firewall = match run_bounded(&[FIREWALL.into(), "--getglobalstate".into()], None, &[], until) {
        Ok(ran) => firewall_from(ran.success, &ran.out),
        Err(TIMEOUT) => return Err(TIMEOUT),
        Err(_) => Firewall::Unknown,
    };
    let ports = firewall == Firewall::On;
    let ran = run_bounded(&login(command(exe, cwd, nonce, ports)), Some(cwd), env, until)?;
    verdict(ran.success, &ran.out, nonce)?;
    Ok(Grant {
        ports,
        no_ports: match firewall {
            Firewall::On => None,
            Firewall::Off => Some(FIREWALL_OFF),
            Firewall::Unknown => Some(FIREWALL_UNKNOWN),
        },
    })
}

/// What a run of the check says: only the probe's own line with this
/// launch's nonce counts, and a refusal is shown as its fixed message
pub fn verdict(success: bool, out: &str, nonce: &str) -> Result<(), &'static str> {
    for line in out.lines() {
        let mut words = line.rsplitn(2, ' ');
        let (Some(last), Some(head)) = (words.next(), words.next()) else { continue };
        if last != nonce {
            continue;
        }
        if head == PROBE_OK {
            return if success { Ok(()) } else { Err(CODEX_REFUSED) };
        }
        if let Some(code) = head.strip_prefix(PROBE_REFUSED).and_then(|c| c.strip_prefix(' ')) {
            return Err(MESSAGES.iter().find(|(c, _)| *c == code).map_or(UNKNOWN, |(_, m)| m));
        }
    }
    Err(if success { NO_ANSWER } else { CODEX_REFUSED })
}

struct Ran {
    success: bool,
    out: String,
}

/// Runs `argv` in a process group of its own and gives up at `until`,
/// output included: the group is killed when the leader ends or the time is
/// up, and nothing is left waiting on a pipe a descendant keeps open
fn run_bounded(argv: &[String], cwd: Option<&Path>, env: &[(String, String)], until: Instant) -> Result<Ran, &'static str> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let (program, args) = argv.split_first().ok_or(NOT_STARTED)?;
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    command.envs(env.iter().map(|(k, v)| (k, v)));
    let mut child = command.spawn().map_err(|_| NOT_STARTED)?;
    let group = child.id() as libc::pid_t;
    let kill_group = || {
        // SAFETY: killpg has no memory preconditions; the leader is not yet
        // reaped, so the group id is still this one
        unsafe { libc::killpg(group, libc::SIGKILL) };
    };
    let Some(mut stdout) = child.stdout.take() else {
        kill_group();
        let _ = child.wait();
        return Err(NOT_STARTED);
    };
    let fd = stdout.as_raw_fd();
    // SAFETY: fd is the open read end of the pipe owned by `stdout`
    unsafe { libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK) };
    let mut out = Vec::new();
    let (mut eof, mut ended) = (false, false);
    while !(eof && ended) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            kill_group();
            let _ = child.wait();
            return Err(TIMEOUT);
        }
        if !eof {
            let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let wait = left.min(Duration::from_millis(20)).as_millis() as libc::c_int;
            // SAFETY: one valid pollfd for the duration of the call
            unsafe { libc::poll(&mut poll, 1, wait) };
            let mut chunk = [0u8; 4096];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(n) if out.len() + n <= MAX_OUTPUT => out.extend_from_slice(&chunk[..n]),
                    Ok(_) => {
                        eof = true;
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        eof = true;
                        break;
                    }
                }
            }
        } else {
            std::thread::sleep(left.min(Duration::from_millis(10)));
        }
        if !ended && leader_ended(group) {
            // What it left behind goes with it, so the pipe closes
            ended = true;
            kill_group();
        }
    }
    kill_group();
    let success = child.wait().map(|s| s.success()).unwrap_or(false);
    Ok(Ran { success, out: String::from_utf8_lossy(&out).into_owned() })
}

/// Whether the process `pid` has ended, without reaping it
fn leader_ended(pid: libc::pid_t) -> bool {
    // SAFETY: a zeroed siginfo_t is a valid out parameter for waitid
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: waitid writes only into `info`; WNOWAIT leaves the child unreaped
    let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    r == 0 && info.si_pid == pid
}

/// The sockets folder exists and is this user's: Codex refuses a socket
/// folder that does not exist, and one that another user made is not ours
fn prepare_socket_dir() -> Result<(), &'static str> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let dir = Path::new(crate::agents::CODEX_SOCKETS);
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(FOLDER),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|_| FOLDER)?;
    // SAFETY: getuid has no preconditions
    let me = unsafe { libc::getuid() };
    if !meta.is_dir() || meta.uid() != me {
        return Err(FOLDER);
    }
    Ok(())
}

/// The probe's entry (`agent-mcr --codex-sockets-probe <nonce> <ports|sockets>
/// <codex home>`), run inside the sandbox; prints one line, returns the exit code
pub fn probe_main(nonce: &str, mode: &str, codex_home: &str) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    let ports = mode == "ports";
    match probe(nonce, ports, Path::new(codex_home), &cwd) {
        Ok(()) => {
            println!("{PROBE_OK} {nonce}");
            0
        }
        Err(code) => {
            println!("{PROBE_REFUSED} {code} {nonce}");
            3
        }
    }
}

fn probe(nonce: &str, ports: bool, codex_home: &Path, cwd: &Path) -> Result<(), &'static str> {
    if nonce.is_empty() || !nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("nonce");
    }
    let proxy = proxy_from_env(|k| std::env::var(k).ok())?;
    direct_refused()?;
    tcp(ports)?;
    unix_sockets(nonce)?;
    proxy_refuses(proxy, nonce, ports)?;
    match refusal(&Sources::for_launch(codex_home, cwd)) {
        Some(code) => Err(code),
        None => Ok(()),
    }
}

/// The managed proxy's HTTPS address from the environment Codex gave the
/// command, which it sets only when the proxy runs
pub fn proxy_from_env(var: impl Fn(&str) -> Option<String>) -> Result<std::net::SocketAddr, &'static str> {
    if var("CODEX_NETWORK_PROXY_ACTIVE").is_none_or(|v| v.trim().is_empty()) {
        return Err("proxy");
    }
    let mut https = None;
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"] {
        let Some(value) = var(key).filter(|v| !v.is_empty()) else { continue };
        let addr = loopback_url(&value).ok_or("proxy-address")?;
        if key.eq_ignore_ascii_case("https_proxy") {
            https = Some(addr);
        }
    }
    https.ok_or("proxy")
}

fn loopback_url(url: &str) -> Option<std::net::SocketAddr> {
    let rest = url.split_once("://")?.1.trim_end_matches('/');
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let addr: std::net::SocketAddr = rest.replace("localhost", "127.0.0.1").parse().ok()?;
    addr.ip().is_loopback().then_some(addr)
}

fn refused_by_sandbox(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES))
}

fn direct_refused() -> Result<(), &'static str> {
    let to: std::net::SocketAddr = OUTSIDE.parse().map_err(|_| "direct")?;
    match std::net::TcpStream::connect_timeout(&to, Duration::from_millis(700)) {
        Err(e) if refused_by_sandbox(&e) => Ok(()),
        _ => Err("direct"),
    }
}

/// TCP listening as the firewall decided: on 127.0.0.1 and 0.0.0.0 both
/// allowed (and the loopback one reachable), or both refused by Seatbelt
fn tcp(ports: bool) -> Result<(), &'static str> {
    for at in ["127.0.0.1:0", "0.0.0.0:0"] {
        match (ports, std::net::TcpListener::bind(at)) {
            (true, Ok(listener)) => {
                let port = listener.local_addr().map_err(|_| "tcp-closed")?.port();
                std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).map_err(|_| "tcp-closed")?;
            }
            (true, Err(_)) => return Err("tcp-closed"),
            (false, Err(e)) if refused_by_sandbox(&e) => {}
            (false, _) => return Err("tcp-open"),
        }
    }
    Ok(())
}

fn unix_sockets(nonce: &str) -> Result<(), &'static str> {
    use std::os::unix::net::{UnixListener, UnixStream};
    let inside = Path::new(crate::agents::CODEX_SOCKETS).join(format!("probe-{nonce}.sock"));
    let reached = UnixListener::bind(&inside).and_then(|_listener| UnixStream::connect(&inside));
    let _ = std::fs::remove_file(&inside);
    reached.map_err(|_| "unix-closed")?;
    for dir in [PathBuf::from("/private/tmp"), std::env::temp_dir()] {
        let outside = dir.join(format!("amcr-probe-{nonce}.sock"));
        match UnixListener::bind(&outside) {
            Err(e) if refused_by_sandbox(&e) => {}
            Err(_) => return Err("unix-wide"),
            Ok(_) => {
                let _ = std::fs::remove_file(&outside);
                return Err("unix-wide");
            }
        }
    }
    Ok(())
}

/// The proxy must refuse what it was given no domain for: a name nobody
/// allows and a host an allowlist would likely hold; without ports also a
/// local address (with ports Seatbelt lets loopback through directly)
fn proxy_refuses(proxy: std::net::SocketAddr, nonce: &str, ports: bool) -> Result<(), &'static str> {
    use std::io::{Read, Write};
    let mut targets = vec![format!("amcr-probe-{nonce}.invalid:443"), "github.com:443".to_owned()];
    if !ports {
        targets.push("127.0.0.1:9".into());
    }
    for target in targets {
        let mut stream = std::net::TcpStream::connect_timeout(&proxy, Duration::from_millis(500)).map_err(|_| "proxy")?;
        stream.set_read_timeout(Some(Duration::from_millis(1000))).ok();
        write!(stream, "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").map_err(|_| "proxy")?;
        let mut head = [0u8; 64];
        let n = stream.read(&mut head).unwrap_or(0);
        if !head[..n].starts_with(b"HTTP/1.1 403") {
            return Err("proxy-open");
        }
    }
    Ok(())
}

/// The files Codex reads for a launch in `cwd` that can add a domain, change
/// the proxy or redefine our profile: its config layers (system, the
/// operator's `CODEX_HOME` with its `<name>.config.toml` profile layers, and
/// every `.codex` from the folder up), their `rules` folders, and the
/// managed files
pub struct Sources {
    pub config_dirs: Vec<PathBuf>,
    pub layers: Vec<PathBuf>,
    pub managed: Vec<PathBuf>,
}

impl Sources {
    pub fn for_launch(codex_home: &Path, cwd: &Path) -> Self {
        let mut config_dirs = vec![PathBuf::from("/etc/codex"), codex_home.to_path_buf()];
        config_dirs.extend(cwd.ancestors().map(|dir| dir.join(".codex")));
        let mut seen = std::collections::BTreeSet::new();
        config_dirs.retain(|d| seen.insert(d.clone()));
        let layers = match std::fs::read_dir(codex_home) {
            Ok(entries) => entries.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".config.toml"))).collect(),
            Err(_) => Vec::new(),
        };
        let mut managed = vec![
            PathBuf::from("/etc/codex/requirements.toml"),
            PathBuf::from("/etc/codex/managed_config.toml"),
            codex_home.join("managed_config.toml"),
        ];
        let prefs = Path::new("/Library/Managed Preferences");
        managed.push(prefs.join("com.openai.codex.plist"));
        if let Ok(users) = std::fs::read_dir(prefs) {
            managed.extend(users.flatten().map(|u| u.path().join("com.openai.codex.plist")));
        }
        Self { config_dirs, layers, managed }
    }
}

/// The code of the first reason the profile may not be trusted for these
/// sources, or nothing. Conservative: a file that cannot be read refuses, a
/// structured `network_proxy` feature table refuses whatever it holds, and
/// any `network_rule` in a rules file refuses whether it allows or denies
pub fn refusal(sources: &Sources) -> Option<&'static str> {
    for file in &sources.managed {
        match std::fs::symlink_metadata(file) {
            Ok(_) => return Some("managed"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Some("unreadable"),
        }
    }
    for layer in &sources.layers {
        if let Some(code) = config_refusal(layer) {
            return Some(code);
        }
    }
    for dir in &sources.config_dirs {
        if let Some(code) = config_refusal(&dir.join("config.toml")).or_else(|| rules_refusal(&dir.join("rules"))) {
            return Some(code);
        }
    }
    None
}

fn read_small(path: &Path) -> Result<Option<String>, &'static str> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => return Ok(None),
        Err(_) => return Err("unreadable"),
    };
    let mut text = String::new();
    file.take(MAX_CONFIG + 1).read_to_string(&mut text).map_err(|_| "unreadable")?;
    if text.len() as u64 > MAX_CONFIG {
        return Err("unreadable");
    }
    Ok(Some(text))
}

fn config_refusal(path: &Path) -> Option<&'static str> {
    let text = match read_small(path) {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(code) => return Some(code),
    };
    let Ok(table) = text.parse::<toml::Table>() else {
        return Some("invalid");
    };
    let mut places = vec![&table];
    if let Some(toml::Value::Table(profiles)) = table.get("profiles") {
        places.extend(profiles.values().filter_map(toml::Value::as_table));
    }
    for t in places {
        if t.get("features").and_then(|f| f.get("network_proxy")).is_some_and(toml::Value::is_table) {
            return Some("proxy-table");
        }
        if t.get("permissions").and_then(|p| p.get(crate::agents::CODEX_SOCKET_PROFILE)).is_some() {
            return Some("profile");
        }
    }
    None
}

fn rules_refusal(dir: &Path) -> Option<&'static str> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => return None,
        Err(_) => return Some("unreadable"),
    };
    for entry in entries.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "rules")) {
        match read_small(&entry.path()) {
            Ok(Some(text)) if text.contains("network_rule") => return Some("rule"),
            Ok(_) => {}
            Err(code) => return Some(code),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(code: &str) -> &'static str {
        MESSAGES.iter().find(|(c, _)| *c == code).unwrap().1
    }

    #[test]
    fn only_the_probes_own_line_with_this_nonce_counts_and_reasons_are_fixed() {
        let nonce = "a1b2c3";
        assert_eq!(verdict(true, &format!("noise\n{PROBE_OK} {nonce}\n"), nonce), Ok(()));
        // Another launch's nonce, a failed exit
        assert_eq!(verdict(true, &format!("{PROBE_OK} zzz\n"), nonce), Err(NO_ANSWER));
        assert_eq!(verdict(false, &format!("{PROBE_OK} {nonce}\n"), nonce), Err(CODEX_REFUSED));
        // The probe's refusal becomes its fixed message; text around it never passes
        assert_eq!(verdict(false, &format!("{PROBE_REFUSED} proxy {nonce}\n"), nonce), Err(message("proxy")));
        assert_eq!(verdict(false, &format!("{PROBE_REFUSED} token=abc {nonce}\n"), nonce), Err(UNKNOWN));
        assert_eq!(verdict(false, &format!("{PROBE_REFUSED} proxy\n"), nonce), Err(CODEX_REFUSED), "a refusal without the nonce is no answer");
        // Codex refused the words (a Codex without the feature, a bad -c):
        // nothing it printed is repeated
        assert_eq!(verdict(false, "Error: Unknown feature flag network_proxy token=abc\n", nonce), Err(CODEX_REFUSED));
        assert_eq!(verdict(true, "", nonce), Err(NO_ANSWER));
        // Every message is fixed text without a place for a value
        for (_, m) in MESSAGES {
            assert!(!m.contains('{') && !m.contains('/') && m.len() < 80, "{m}");
        }
    }

    #[test]
    fn the_firewall_is_on_only_when_it_says_so() {
        assert_eq!(firewall_from(true, "Firewall is enabled. (State = 1)\n"), Firewall::On);
        assert_eq!(firewall_from(true, "Firewall is set to block all non-essential incoming connections. (State = 2)\n"), Firewall::On);
        assert_eq!(firewall_from(true, "Firewall is disabled. (State = 0)\n"), Firewall::Off);
        assert_eq!(firewall_from(false, "Firewall is enabled. (State = 1)\n"), Firewall::Unknown);
        assert_eq!(firewall_from(true, "something else\n"), Firewall::Unknown);
        assert_eq!(firewall_from(true, "(State = 7)"), Firewall::Unknown);
    }

    /// Absent, removed or ineffective proxy support all reach the probe as
    /// a command without the proxy's environment, or with an address that
    /// is not loopback
    #[test]
    fn a_missing_or_strange_proxy_environment_refuses() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string());
        assert_eq!(proxy_from_env(env(&[])), Err("proxy"));
        assert_eq!(proxy_from_env(env(&[("HTTPS_PROXY", "http://127.0.0.1:5")])), Err("proxy"));
        assert_eq!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTPS_PROXY", "http://10.0.0.2:3128")])), Err("proxy-address"));
        assert_eq!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTPS_PROXY", "http://127.0.0.1:5"), ("ALL_PROXY", "socks5h://proxy.example:1080")])), Err("proxy-address"));
        assert_eq!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1")])), Err("proxy"));
        let addr = proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTP_PROXY", "http://127.0.0.1:62842"), ("HTTPS_PROXY", "http://127.0.0.1:62842"), ("ALL_PROXY", "socks5h://127.0.0.1:62843")])).unwrap();
        assert_eq!(addr, "127.0.0.1:62842".parse().unwrap());
        assert!(loopback_url("http://[::1]:8080/").is_some() && loopback_url("http://localhost:1").is_some());
    }

    #[test]
    fn config_layers_rules_and_managed_files_that_could_widen_the_proxy_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex-home");
        let cwd = dir.path().join("work/repo");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(cwd.join(".codex")).unwrap();
        let sources = || {
            let all = Sources::for_launch(&home, &cwd);
            Sources { config_dirs: all.config_dirs.into_iter().filter(|d| d.starts_with(dir.path())).collect(), layers: all.layers, managed: vec![dir.path().join("etc/requirements.toml")] }
        };
        let dirs = sources().config_dirs;
        assert!(dirs.contains(&home) && dirs.contains(&cwd.join(".codex")) && dirs.contains(&dir.path().join("work/.codex")));
        assert!(Sources::for_launch(&home, &cwd).config_dirs.contains(&PathBuf::from("/etc/codex")));
        // Clean: an ordinary config and command rules
        std::fs::write(home.join("config.toml"), "model = \"x\"\n[features]\nnetwork_proxy = true\n[permissions.mine.network]\nenabled = true\n").unwrap();
        std::fs::create_dir_all(home.join("rules")).unwrap();
        std::fs::write(home.join("rules/default.rules"), "prefix_rule(pattern=[\"ls\"], decision=\"allow\")\n").unwrap();
        assert_eq!(refusal(&sources()), None);
        // A structured proxy table, at the top or in a config profile
        std::fs::write(home.join("config.toml"), "[features.network_proxy]\nenabled = true\n").unwrap();
        assert_eq!(refusal(&sources()), Some("proxy-table"));
        std::fs::write(home.join("config.toml"), "[profiles.p.features.network_proxy]\nenabled = true\n").unwrap();
        assert_eq!(refusal(&sources()), Some("proxy-table"));
        std::fs::write(home.join("config.toml"), "").unwrap();
        // A separate `<name>.config.toml` layer, as `-p <name>` or a wrapper selects
        std::fs::write(home.join("fast.config.toml"), "[permissions.agent-mcr-sockets.network]\nenabled = true\n").unwrap();
        assert_eq!(sources().layers, vec![home.join("fast.config.toml")]);
        assert_eq!(refusal(&sources()), Some("profile"));
        std::fs::write(home.join("fast.config.toml"), "[features.network_proxy]\ndomains = {}\n").unwrap();
        assert_eq!(refusal(&sources()), Some("proxy-table"));
        std::fs::write(home.join("fast.config.toml"), "model = \"y\"\n").unwrap();
        assert_eq!(refusal(&sources()), None);
        // A repository's own .codex that redefines our profile's network
        std::fs::write(cwd.join(".codex/config.toml"), "[permissions.agent-mcr-sockets.network.domains]\n\"evil.example\" = \"allow\"\n").unwrap();
        assert_eq!(refusal(&sources()), Some("profile"));
        std::fs::write(cwd.join(".codex/config.toml"), "not toml [").unwrap();
        assert_eq!(refusal(&sources()), Some("invalid"));
        std::fs::remove_file(cwd.join(".codex/config.toml")).unwrap();
        // A saved domain rule (an operator's "always allow")
        std::fs::write(home.join("rules/default.rules"), "network_rule(host=\"github.com\", protocol=\"https\", decision=\"allow\")\n").unwrap();
        assert_eq!(refusal(&sources()), Some("rule"));
        std::fs::remove_file(home.join("rules/default.rules")).unwrap();
        assert_eq!(refusal(&sources()), None);
        // Managed requirements
        std::fs::create_dir_all(dir.path().join("etc")).unwrap();
        std::fs::write(dir.path().join("etc/requirements.toml"), "").unwrap();
        assert_eq!(refusal(&sources()), Some("managed"));
    }

    #[test]
    fn an_unreadable_config_refuses() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads anything; the refusal is for everyone else
        if std::fs::read(&file).is_err() {
            assert_eq!(refusal(&Sources { config_dirs: vec![dir.path().into()], layers: vec![], managed: vec![] }), Some("unreadable"));
        }
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// The deadline holds for the output too: a descendant that keeps the
    /// pipe open after its leader ended is killed with the group, and one
    /// that outlives the deadline is cut off at it
    #[test]
    fn the_deadline_covers_output_and_the_whole_group() {
        let sh = |script: &str| vec!["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()];
        let started = Instant::now();
        let ran = run_bounded(&sh("echo one; sleep 30 & exit 0"), None, &[], Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(ran.success && ran.out == "one\n" && started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        let started = Instant::now();
        assert_eq!(run_bounded(&sh("sleep 30"), None, &[], Instant::now() + Duration::from_millis(300)).err(), Some(TIMEOUT));
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        // The environment and folder are the session's
        let dir = tempfile::tempdir().unwrap();
        let ran = run_bounded(&sh("echo \"$AGENT_MCR_PROFILE $TERM\"; pwd -P"), Some(dir.path()), &[("AGENT_MCR_PROFILE".into(), "codex".into()), ("TERM".into(), "xterm-256color".into())], Instant::now() + Duration::from_secs(2)).unwrap();
        assert_eq!(ran.out, format!("codex xterm-256color\n{}\n", dunce::canonicalize(dir.path()).unwrap().display()));
        assert_eq!(run_bounded(&["/nonexistent/program".to_owned()], None, &[], Instant::now() + Duration::from_secs(1)).err(), Some(NOT_STARTED));
    }

    /// The whole check against the Codex installed here, through the login
    /// shell, as a launch runs it. Not in the gate (CI has no Codex):
    /// `AMCR_PROBE_EXE=target/debug/agent-mcr cargo test live_codex -- --ignored`
    #[test]
    #[ignore]
    fn live_codex_check_passes_here_and_refuses_widening_layers() {
        let exe = std::env::var("AMCR_PROBE_EXE").expect("AMCR_PROBE_EXE: the built agent-mcr");
        let cwd = std::env::current_dir().unwrap();
        let env: Vec<(String, String)> = crate::runner::pty_env().into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect();
        let run = |prefix: &str| {
            let nonce = crate::runner::random_id()[..16].to_string();
            let login = |cmd: String| vec![crate::harness::login_shell(), "-l".into(), "-i".into(), "-c".into(), format!("{prefix}{cmd}")];
            let started = Instant::now();
            let verdict = check(login, &exe, &cwd, &env, &nonce);
            eprintln!("check took {:?}: {verdict:?}", started.elapsed());
            verdict
        };
        let firewall = run_bounded(&[FIREWALL.into(), "--getglobalstate".into()], None, &[], Instant::now() + DEADLINE).map(|r| firewall_from(r.success, &r.out)).unwrap();
        let grant = run("").unwrap();
        assert_eq!(grant.ports, firewall == Firewall::On);
        let home = tempfile::tempdir().unwrap();
        let in_home = format!("export CODEX_HOME={}; ", crate::agents::sh(&home.path().display().to_string()));
        std::fs::write(home.path().join("config.toml"), "[features.network_proxy]\nenabled = true\n").unwrap();
        assert_eq!(run(&in_home), Err(message("proxy-table")));
        std::fs::write(home.path().join("config.toml"), "").unwrap();
        std::fs::write(home.path().join("work.config.toml"), "[permissions.agent-mcr-sockets.network]\nenabled = true\n").unwrap();
        assert_eq!(run(&in_home), Err(message("profile")));
        std::fs::remove_file(home.path().join("work.config.toml")).unwrap();
        std::fs::create_dir_all(home.path().join("rules")).unwrap();
        std::fs::write(home.path().join("rules/default.rules"), "network_rule(host=\"github.com\", protocol=\"https\", decision=\"allow\")\n").unwrap();
        assert_eq!(run(&in_home), Err(message("rule")));
    }

    /// The probe runs the launch's words, never a `--sandbox` beside them
    /// (Codex would drop the profile without a word), in the launch's
    /// folder, with managed requirements, ports as the firewall decided, and
    /// hands it the operator's CODEX_HOME as the login shell has it
    #[test]
    fn the_check_runs_the_launch_words_under_codex_sandbox() {
        for ports in [false, true] {
            let line = command("/Apps/agent mcr", Path::new("/Users/me/work/repo"), "n0nce", ports);
            assert!(line.starts_with("exec codex sandbox -P 'agent-mcr-sockets' --include-managed-config -C '/Users/me/work/repo' '--enable' 'network_proxy' "), "{line}");
            for word in crate::agents::codex_socket_words(ports) {
                assert!(line.contains(&crate::agents::sh(&word)), "{word}: {line}");
            }
            assert_eq!(line.contains("allow_local_binding=true"), ports, "{line}");
            assert!(!line.contains("--sandbox ") && !line.contains("workspace-write"), "{line}");
            let mode = if ports { "ports" } else { "sockets" };
            assert!(line.ends_with(&format!(" -- '/Apps/agent mcr' --codex-sockets-probe n0nce {mode} \"${{CODEX_HOME:-$HOME/.codex}}\"")), "{line}");
        }
    }
}
