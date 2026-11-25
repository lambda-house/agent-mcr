//! The launch check for the Codex socket profile (MCR-162, review 17269 P1).
//!
//! The profile (`agents::codex_socket_words`) turns a Codex session's network
//! on so that Seatbelt passes its Unix sockets, and relies on Codex's managed
//! proxy to keep everything else closed. The words alone do not prove that:
//! a Codex without the `network_proxy` feature, a managed requirement that
//! turns the proxy off, a structured proxy table in a config layer or a saved
//! domain rule can each leave the network wider than the words say. So before
//! every such launch the harness runs Codex itself, through the same login
//! shell, with the same words, in the same folder (`codex sandbox
//! --include-managed-config`), around this program's probe
//! (`agent-mcr --codex-sockets-probe`), which looks at what it was given:
//!
//! - the proxy is running (`CODEX_NETWORK_PROXY_ACTIVE` and loopback proxy
//!   addresses in its environment);
//! - a direct connection to an outside address is refused by Seatbelt itself
//!   (`EPERM`), so no full-network branch was taken;
//! - binding TCP on 127.0.0.1 and 0.0.0.0 is refused (review 17269 P2);
//! - a Unix socket binds in `CODEX_SOCKETS` and not in `/tmp` or `$TMPDIR`;
//! - the proxy answers 403 to CONNECT for an unknown host, for 127.0.0.1
//!   and for github.com;
//! - and, for what that run cannot show (`codex sandbox` does not apply saved
//!   exec-policy domain rules, and no probe lists an allowlist), no config
//!   layer, rules file or managed file that Codex would read for this folder
//!   could add a domain or reshape the proxy (`refusal`).
//!
//! Anything else, a timeout or a Codex that cannot run the probe included,
//! refuses the profile, and the session starts with plain workspace-write
//! (network off), which `effectiveMode` says. Cost: one `codex sandbox` run,
//! about 0.15 s on the owner's Mac (25 Nov), at most `CHECK_TIMEOUT`.
//! What no probe here can see: a domain that a cloud-managed requirement
//! allows (the probe asks three hosts, not the list).

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The flag the probe runs under (branches in `main` before Tauri starts)
pub const PROBE_FLAG: &str = "--codex-sockets-probe";
const PROBE_OK: &str = "agent-mcr sockets probe ok";
const PROBE_REFUSED: &str = "agent-mcr sockets probe refused: ";
/// The longest a launch waits for the check: a restart decides before it
/// hangs up, inside the control client's ten seconds
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(2);
/// An address of TEST-NET-1 (RFC 5737): nothing answers there, so a probe
/// that the sandbox did not stop sends one SYN and waits
const OUTSIDE: &str = "192.0.2.1:9";
const MAX_CONFIG: u64 = 1 << 20;

/// What the check decided, as `effectiveMode` words or nothing
pub type Verdict = Result<(), String>;

/// The command line that runs the probe under Codex, for the login shell:
/// `codex sandbox` with the socket profile selected (`-P`, managed
/// requirements included, as a session has them) and the launch's words
#[cfg(unix)]
pub fn command(exe: &str, cwd: &Path, nonce: &str) -> String {
    use crate::agents::{codex_socket_words, sh, CODEX_SOCKET_PROFILE};
    let words: Vec<String> = codex_socket_words().iter().map(|w| sh(w)).collect();
    format!(
        "exec codex sandbox -P {} --include-managed-config -C {} {} -- {} {PROBE_FLAG} {nonce} \"${{CODEX_HOME:-$HOME/.codex}}\"",
        sh(CODEX_SOCKET_PROFILE),
        sh(&cwd.display().to_string()),
        words.join(" "),
        sh(exe),
    )
}

/// Runs the check: `argv` is the login-shell line around `command`
#[cfg(unix)]
#[cfg_attr(test, allow(dead_code))]
pub fn check(argv: &[String], nonce: &str) -> Verdict {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    prepare_socket_dir()?;
    let (program, args) = argv.split_first().ok_or("No shell to run the check")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("the check could not start: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("the check has no output")?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.by_ref().take(64 * 1024).read_to_string(&mut out);
        out
    });
    let until = Instant::now() + CHECK_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.success()),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    verdict(status, &out, nonce)
}

/// What a run of the check says. `exited`: None when it timed out, else
/// whether it exited with success. Only the probe's own line with this
/// launch's nonce passes; Codex's error output is never repeated (it may
/// quote a config value)
pub fn verdict(exited: Option<bool>, out: &str, nonce: &str) -> Verdict {
    let Some(success) = exited else {
        return Err(format!("the check did not finish within {} s", CHECK_TIMEOUT.as_secs()));
    };
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix(PROBE_OK) {
            if success && rest.trim() == nonce {
                return Ok(());
            }
        }
        if let Some(reason) = line.strip_prefix(PROBE_REFUSED) {
            return Err(shown(reason));
        }
    }
    Err(if success { "codex sandbox did not run the probe".into() } else { "codex sandbox could not run the probe with these words".into() })
}

/// A reason as it may stand in `effectiveMode`: one line, no controls, short
fn shown(reason: &str) -> String {
    let clean: String = reason.chars().filter(|c| !c.is_control()).take(200).collect();
    clean.trim().to_string()
}

/// The sockets folder exists and is this user's: Codex refuses a socket
/// folder that does not exist, and one that another user made is not ours
#[cfg(unix)]
#[cfg_attr(test, allow(dead_code))]
pub fn prepare_socket_dir() -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let dir = Path::new(crate::agents::CODEX_SOCKETS);
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot make {}: {e}", dir.display())),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    // SAFETY: getuid has no preconditions
    let me = unsafe { libc::getuid() };
    if !meta.is_dir() || meta.uid() != me {
        return Err(format!("{} is not a folder of this user", dir.display()));
    }
    Ok(())
}

/// The probe's entry (`agent-mcr --codex-sockets-probe <nonce> <codex home>`),
/// run inside the sandbox; prints one line and returns the exit code
#[cfg(unix)]
pub fn probe_main(nonce: &str, codex_home: &str) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    match probe(nonce, Path::new(codex_home), &cwd) {
        Ok(()) => {
            println!("{PROBE_OK} {nonce}");
            0
        }
        Err(reason) => {
            println!("{PROBE_REFUSED}{}", shown(&reason));
            3
        }
    }
}

#[cfg(unix)]
fn probe(nonce: &str, codex_home: &Path, cwd: &Path) -> Verdict {
    if nonce.is_empty() || !nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("the probe was given no nonce".into());
    }
    let proxy = proxy_from_env(|k| std::env::var(k).ok())?;
    direct_refused()?;
    tcp_refused()?;
    unix_sockets(nonce)?;
    proxy_refuses(proxy, nonce)?;
    match refusal(&Sources::for_launch(codex_home, cwd)) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// The managed proxy's HTTP address from the environment Codex gave the
/// command, which it sets only when the proxy runs
pub fn proxy_from_env(var: impl Fn(&str) -> Option<String>) -> Result<std::net::SocketAddr, String> {
    if var("CODEX_NETWORK_PROXY_ACTIVE").is_none_or(|v| v.trim().is_empty()) {
        return Err("Codex's managed network proxy is not running".into());
    }
    let mut http = None;
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"] {
        let Some(value) = var(key).filter(|v| !v.is_empty()) else { continue };
        let addr = loopback_url(&value).ok_or_else(|| format!("{key} does not point at this Mac's loopback"))?;
        if key.eq_ignore_ascii_case("https_proxy") {
            http = Some(addr);
        }
    }
    http.ok_or_else(|| "Codex set no HTTPS proxy address".into())
}

fn loopback_url(url: &str) -> Option<std::net::SocketAddr> {
    let rest = url.split_once("://")?.1.trim_end_matches('/');
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let addr: std::net::SocketAddr = rest.replace("localhost", "127.0.0.1").parse().ok()?;
    addr.ip().is_loopback().then_some(addr)
}

#[cfg(unix)]
fn refused_by_sandbox(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES))
}

#[cfg(unix)]
fn direct_refused() -> Verdict {
    let to: std::net::SocketAddr = OUTSIDE.parse().map_err(|_| "bad probe address")?;
    match std::net::TcpStream::connect_timeout(&to, Duration::from_millis(700)) {
        Err(e) if refused_by_sandbox(&e) => Ok(()),
        Err(e) => Err(format!("the sandbox did not refuse a direct connection to {OUTSIDE} ({})", e.kind())),
        Ok(_) => Err(format!("a direct connection to {OUTSIDE} went through")),
    }
}

#[cfg(unix)]
fn tcp_refused() -> Verdict {
    for at in ["127.0.0.1:0", "0.0.0.0:0"] {
        match std::net::TcpListener::bind(at) {
            Err(e) if refused_by_sandbox(&e) => {}
            Err(e) => return Err(format!("binding TCP on {at} failed but not by the sandbox ({})", e.kind())),
            Ok(_) => return Err(format!("the sandbox let a command listen on TCP {at}")),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn unix_sockets(nonce: &str) -> Verdict {
    use std::os::unix::net::{UnixListener, UnixStream};
    let inside = Path::new(crate::agents::CODEX_SOCKETS).join(format!("probe-{nonce}.sock"));
    let bound = UnixListener::bind(&inside).map_err(|e| format!("a Unix socket in {} was refused ({})", crate::agents::CODEX_SOCKETS, e.kind()));
    let reached = bound.as_ref().ok().map(|_| UnixStream::connect(&inside));
    let _ = std::fs::remove_file(&inside);
    bound?;
    reached.unwrap_or_else(|| Err(std::io::ErrorKind::Other.into())).map_err(|e| format!("a Unix socket in {} could not be reached ({})", crate::agents::CODEX_SOCKETS, e.kind()))?;
    for dir in [PathBuf::from("/private/tmp"), std::env::temp_dir()] {
        let outside = dir.join(format!("amcr-probe-{nonce}.sock"));
        match UnixListener::bind(&outside) {
            Err(e) if refused_by_sandbox(&e) => {}
            Err(e) => return Err(format!("a Unix socket in {} failed but not by the sandbox ({})", dir.display(), e.kind())),
            Ok(_) => {
                let _ = std::fs::remove_file(&outside);
                return Err(format!("the sandbox let a command bind a Unix socket in {}", dir.display()));
            }
        }
    }
    Ok(())
}

/// The proxy must refuse what it was given no domain for: a name nobody
/// allows, a local address and a host an allowlist would likely hold
#[cfg(unix)]
fn proxy_refuses(proxy: std::net::SocketAddr, nonce: &str) -> Verdict {
    use std::io::{Read, Write};
    for target in [format!("amcr-probe-{nonce}.invalid:443"), "127.0.0.1:9".into(), "github.com:443".into()] {
        let mut stream = std::net::TcpStream::connect_timeout(&proxy, Duration::from_millis(500)).map_err(|e| format!("the proxy could not be reached ({})", e.kind()))?;
        stream.set_read_timeout(Some(Duration::from_millis(1500))).ok();
        write!(stream, "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").map_err(|e| format!("the proxy could not be asked ({})", e.kind()))?;
        let mut head = [0u8; 64];
        let n = stream.read(&mut head).unwrap_or(0);
        let status = String::from_utf8_lossy(&head[..n]);
        if !status.starts_with("HTTP/1.1 403") {
            return Err(format!("the proxy did not refuse CONNECT {target}"));
        }
    }
    Ok(())
}

/// The files Codex reads for a launch in `cwd` that can add a domain, change
/// the proxy or redefine our profile: its config layers (system, the
/// operator's `CODEX_HOME`, and every `.codex` from the folder up), their
/// `rules` folders, and the managed files
pub struct Sources {
    pub config_dirs: Vec<PathBuf>,
    pub managed: Vec<PathBuf>,
}

impl Sources {
    pub fn for_launch(codex_home: &Path, cwd: &Path) -> Self {
        let mut config_dirs = vec![PathBuf::from("/etc/codex"), codex_home.to_path_buf()];
        config_dirs.extend(cwd.ancestors().map(|dir| dir.join(".codex")));
        let mut seen = std::collections::BTreeSet::new();
        config_dirs.retain(|d| seen.insert(d.clone()));
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
        Self { config_dirs, managed }
    }
}

/// Why the profile may not be trusted for these sources, or nothing.
/// Conservative: a file that cannot be read refuses, a structured
/// `network_proxy` feature table refuses whatever it holds, and any
/// `network_rule` in a rules file refuses whether it allows or denies
pub fn refusal(sources: &Sources) -> Option<String> {
    for file in &sources.managed {
        match std::fs::symlink_metadata(file) {
            Ok(_) => return Some(format!("managed Codex settings in {} are not checked", file.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Some(format!("cannot look at {} ({})", file.display(), e.kind())),
        }
    }
    for dir in &sources.config_dirs {
        if let Some(reason) = config_refusal(&dir.join("config.toml")).or_else(|| rules_refusal(&dir.join("rules"))) {
            return Some(reason);
        }
    }
    None
}

fn read_small(path: &Path) -> Result<Option<String>, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => return Ok(None),
        Err(e) => return Err(format!("cannot read {} ({})", path.display(), e.kind())),
    };
    let mut text = String::new();
    file.take(MAX_CONFIG + 1).read_to_string(&mut text).map_err(|e| format!("cannot read {} ({})", path.display(), e.kind()))?;
    if text.len() as u64 > MAX_CONFIG {
        return Err(format!("{} is larger than the check reads", path.display()));
    }
    Ok(Some(text))
}

fn config_refusal(path: &Path) -> Option<String> {
    let text = match read_small(path) {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(reason) => return Some(reason),
    };
    let Ok(table) = text.parse::<toml::Table>() else {
        return Some(format!("{} is not valid TOML", path.display()));
    };
    let mut places = vec![(String::new(), &table)];
    if let Some(toml::Value::Table(profiles)) = table.get("profiles") {
        places.extend(profiles.iter().filter_map(|(name, v)| v.as_table().map(|t| (format!("profiles.{name}."), t))));
    }
    for (prefix, t) in places {
        if t.get("features").and_then(|f| f.get("network_proxy")).is_some_and(toml::Value::is_table) {
            return Some(format!("{} sets {prefix}features.network_proxy as a table", path.display()));
        }
        if t.get("permissions").and_then(|p| p.get(crate::agents::CODEX_SOCKET_PROFILE)).is_some() {
            return Some(format!("{} defines {prefix}permissions.{}", path.display(), crate::agents::CODEX_SOCKET_PROFILE));
        }
    }
    None
}

fn rules_refusal(dir: &Path) -> Option<String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => return None,
        Err(e) => return Some(format!("cannot list {} ({})", dir.display(), e.kind())),
    };
    for entry in entries.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "rules")) {
        match read_small(&entry.path()) {
            Ok(Some(text)) if text.contains("network_rule") => return Some(format!("{} holds a saved network rule", entry.path().display())),
            Ok(_) => {}
            Err(reason) => return Some(reason),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_probes_own_line_with_this_nonce_passes() {
        let nonce = "a1b2c3";
        assert_eq!(verdict(Some(true), &format!("noise\n{PROBE_OK} {nonce}\n"), nonce), Ok(()));
        // Another launch's nonce, a failed exit, a timeout
        assert!(verdict(Some(true), &format!("{PROBE_OK} zzz\n"), nonce).is_err());
        assert!(verdict(Some(false), &format!("{PROBE_OK} {nonce}\n"), nonce).is_err());
        assert!(verdict(None, &format!("{PROBE_OK} {nonce}\n"), nonce).unwrap_err().contains("did not finish"));
        // The probe's own refusal is passed on, cleaned
        assert_eq!(verdict(Some(false), &format!("{PROBE_REFUSED}Codex's managed network proxy is not running\u{1b}[0m\n"), nonce).unwrap_err(), "Codex's managed network proxy is not running[0m");
        // Codex refused the words (a Codex without the feature, a bad -c):
        // nothing it printed is repeated
        assert_eq!(verdict(Some(false), "Error: Unknown feature flag network_proxy token=abc\n", nonce).unwrap_err(), "codex sandbox could not run the probe with these words");
        assert_eq!(verdict(Some(true), "", nonce).unwrap_err(), "codex sandbox did not run the probe");
    }

    /// Absent, removed or ineffective proxy support all reach the probe as
    /// a command without the proxy's environment, or with an address that
    /// is not loopback
    #[test]
    fn a_missing_or_strange_proxy_environment_refuses() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string());
        // No proxy (feature absent, removed, or turned off by a requirement)
        assert!(proxy_from_env(env(&[])).unwrap_err().contains("not running"));
        assert!(proxy_from_env(env(&[("HTTPS_PROXY", "http://127.0.0.1:5")])).unwrap_err().contains("not running"));
        // Running but pointing elsewhere (a non-loopback proxy)
        assert!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTPS_PROXY", "http://10.0.0.2:3128")])).unwrap_err().contains("loopback"));
        assert!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTPS_PROXY", "http://127.0.0.1:5"), ("ALL_PROXY", "socks5h://proxy.example:1080")])).unwrap_err().contains("ALL_PROXY"));
        assert!(proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1")])).unwrap_err().contains("no HTTPS proxy"));
        let addr = proxy_from_env(env(&[("CODEX_NETWORK_PROXY_ACTIVE", "1"), ("HTTP_PROXY", "http://127.0.0.1:62842"), ("HTTPS_PROXY", "http://127.0.0.1:62842"), ("ALL_PROXY", "socks5h://127.0.0.1:62843")])).unwrap();
        assert_eq!(addr, "127.0.0.1:62842".parse().unwrap());
        assert!(loopback_url("http://[::1]:8080/").is_some() && loopback_url("http://localhost:1").is_some());
    }

    #[test]
    fn config_rules_and_managed_files_that_could_widen_the_proxy_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex-home");
        let cwd = dir.path().join("work/repo");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(cwd.join(".codex")).unwrap();
        let sources = || Sources { config_dirs: Sources::for_launch(&home, &cwd).config_dirs.into_iter().filter(|d| d.starts_with(dir.path())).collect(), managed: vec![dir.path().join("etc/requirements.toml")] };
        // The layers: the operator's home and every .codex from the folder up
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
        assert!(refusal(&sources()).unwrap().contains("features.network_proxy"));
        std::fs::write(home.join("config.toml"), "[profiles.p.features.network_proxy]\nenabled = true\n").unwrap();
        assert!(refusal(&sources()).unwrap().contains("profiles.p.features.network_proxy"));
        std::fs::write(home.join("config.toml"), "").unwrap();
        // A repository's own .codex that redefines our profile's network
        std::fs::write(cwd.join(".codex/config.toml"), "[permissions.agent-mcr-sockets.network.domains]\n\"evil.example\" = \"allow\"\n").unwrap();
        assert!(refusal(&sources()).unwrap().contains("permissions.agent-mcr-sockets"));
        std::fs::write(cwd.join(".codex/config.toml"), "not toml [").unwrap();
        assert!(refusal(&sources()).unwrap().contains("not valid TOML"));
        std::fs::remove_file(cwd.join(".codex/config.toml")).unwrap();
        // A saved domain rule (an operator's "always allow")
        std::fs::write(home.join("rules/default.rules"), "network_rule(host=\"github.com\", protocol=\"https\", decision=\"allow\")\n").unwrap();
        assert!(refusal(&sources()).unwrap().contains("saved network rule"));
        std::fs::remove_file(home.join("rules/default.rules")).unwrap();
        assert_eq!(refusal(&sources()), None);
        // Managed requirements
        std::fs::create_dir_all(dir.path().join("etc")).unwrap();
        std::fs::write(dir.path().join("etc/requirements.toml"), "").unwrap();
        assert!(refusal(&sources()).unwrap().contains("managed Codex settings"));
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_config_refuses() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads anything; the refusal is for everyone else
        if std::fs::read(&file).is_err() {
            assert!(refusal(&Sources { config_dirs: vec![dir.path().into()], managed: vec![] }).unwrap().contains("cannot read"));
        }
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// The whole check against the Codex installed here, through the login
    /// shell, as a launch runs it. Not in the gate (CI has no Codex):
    /// `AMCR_PROBE_EXE=target/debug/agent-mcr cargo test live_codex -- --ignored`
    #[test]
    #[ignore]
    #[cfg(unix)]
    fn live_codex_check_passes_here_and_refuses_a_proxy_table() {
        let exe = std::env::var("AMCR_PROBE_EXE").expect("AMCR_PROBE_EXE: the built agent-mcr");
        let cwd = std::env::current_dir().unwrap();
        let run = |prefix: &str| {
            let nonce = crate::runner::random_id()[..16].to_string();
            let argv = vec![crate::harness::login_shell(), "-l".into(), "-i".into(), "-c".into(), format!("{prefix}{}", command(&exe, &cwd, &nonce))];
            let started = std::time::Instant::now();
            let verdict = check(&argv, &nonce);
            eprintln!("check took {:?}: {verdict:?}", started.elapsed());
            verdict
        };
        assert_eq!(run(""), Ok(()));
        // An operator config with a structured proxy table
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("config.toml"), "[features.network_proxy]\nenabled = true\n").unwrap();
        let reason = run(&format!("export CODEX_HOME={}; ", crate::agents::sh(&home.path().display().to_string()))).unwrap_err();
        assert!(reason.contains("features.network_proxy"), "{reason}");
        // A saved domain rule
        std::fs::write(home.path().join("config.toml"), "").unwrap();
        std::fs::create_dir_all(home.path().join("rules")).unwrap();
        std::fs::write(home.path().join("rules/default.rules"), "network_rule(host=\"github.com\", protocol=\"https\", decision=\"allow\")\n").unwrap();
        let reason = run(&format!("export CODEX_HOME={}; ", crate::agents::sh(&home.path().display().to_string()))).unwrap_err();
        assert!(reason.contains("saved network rule"), "{reason}");
    }

    /// The probe runs the launch's words, never a `--sandbox` beside them
    /// (Codex would drop the profile without a word), in the launch's
    /// folder, with managed requirements, and hands it the operator's
    /// CODEX_HOME as the login shell has it
    #[test]
    #[cfg(unix)]
    fn the_check_runs_the_launch_words_under_codex_sandbox() {
        let line = command("/Apps/agent mcr", Path::new("/Users/me/work/repo"), "n0nce");
        assert!(line.starts_with("exec codex sandbox -P 'agent-mcr-sockets' --include-managed-config -C '/Users/me/work/repo' '--enable' 'network_proxy' "), "{line}");
        for word in crate::agents::codex_socket_words() {
            assert!(line.contains(&crate::agents::sh(&word)), "{word}: {line}");
        }
        assert!(!line.contains("--sandbox ") && !line.contains("workspace-write"), "{line}");
        assert!(line.ends_with(" -- '/Apps/agent mcr' --codex-sockets-probe n0nce \"${CODEX_HOME:-$HOME/.codex}\""), "{line}");
    }
}
