//! Operator-owned roots and the Claude Code workspace trust record (MCR-152).
//! A root also gives Codex sessions Unix sockets in one folder (MCR-162).

use serde::Deserialize;
use serde_json::value::{to_raw_value, RawValue};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const CONFIG: &str = "auto-mode.json";
const ACCEPTED: &str = "hasTrustDialogAccepted";

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Settings {
    roots: Vec<String>,
}

#[derive(Default)]
pub struct RootMatch {
    pub root: Option<String>,
    pub rejected: Vec<String>,
}

/// `cwd` is the canonical path given to the runner. Keep the operator's
/// spelling and record rejected roots even if another root matches. Claude
/// and Codex sessions match (what a match does is the adapter's, in
/// `agents::Launch`); the root Supervisor and other agents never do.
pub fn matching_root(
    config_dir: &Path,
    home: &Path,
    cwd: &Path,
    adapter: &str,
    supervisor: bool,
) -> Result<RootMatch, String> {
    let mut matched = RootMatch::default();
    if !matches!(adapter, "claude" | "codex") || supervisor {
        return Ok(matched);
    }
    let path = config_dir.join(CONFIG);
    let Some(bytes) = read_config(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))? else {
        return Ok(matched);
    };
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid {}: {e}", path.display()))?;
    if settings.roots.is_empty() {
        return Ok(matched);
    }
    let canonical_home = dunce::canonicalize(home).map_err(|e| format!("Cannot resolve home for auto-mode roots: {e}"))?;
    let canonical_config = dunce::canonicalize(config_dir).map_err(|e| format!("Cannot resolve Agent MCR config directory for auto-mode roots: {e}"))?;
    for root in settings.roots {
        let as_path = Path::new(&root);
        let expanded = match as_path.strip_prefix("~") {
            Ok(rest) if rest.as_os_str().is_empty() => home.to_path_buf(),
            Ok(rest) => home.join(rest),
            Err(_) if as_path.is_absolute() => as_path.to_path_buf(),
            Err(_) => return Err(format!("Invalid root {root:?} in {CONFIG}: use an absolute path or ~/")),
        };
        let path = match dunce::canonicalize(&expanded) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => continue,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot resolve auto-mode root {root:?}: {e}")),
        };
        let reason = if canonical_home.starts_with(&path) {
            Some("it is the home folder or an ancestor")
        } else if canonical_config.starts_with(&path) {
            Some("it contains the Agent MCR config directory")
        } else {
            None
        };
        if let Some(reason) = reason {
            let note = format!("ignored auto-mode root {root:?} because {reason}");
            eprintln!("harness: {note}");
            matched.rejected.push(note);
        } else if matched.root.is_none() && cwd.starts_with(&path) {
            matched.root = Some(root);
        }
    }
    Ok(matched)
}

pub fn claude_config(home: &Path, config_dir: Option<&Path>) -> Result<PathBuf, String> {
    match config_dir {
        Some(dir) if dir.is_absolute() => Ok(dir.join(".claude.json")),
        Some(_) => Err("CLAUDE_CONFIG_DIR must be absolute for auto-mode folder trust".into()),
        None => Ok(home.join(".claude.json")),
    }
}

pub fn trust_cwd(config: &Path, cwd: &Path) -> Result<(), String> {
    let key = cwd.to_str().ok_or("Claude workspace path is not UTF-8")?;
    // Claude uses slash-separated project keys on Windows.
    let key = if cfg!(windows) { key.replace('\\', "/") } else { key.to_owned() };
    update_trust(config, &key).map_err(|e| format!("Cannot record Claude folder trust in {}: {e}", config.display()))
}

// Claude Code acquires <config>.lock with mkdir, then reloads the config
// under the lock. Share that protocol across MCR launches and Claude writers.
// Never steal a lock: a busy writer can finish and the launch can be retried.
struct ConfigLock {
    path: PathBuf,
    modified: SystemTime,
    since: Instant,
}

impl ConfigLock {
    fn acquire(config: &Path) -> io::Result<Self> {
        let mut name = config.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match fs::create_dir(&path) {
                Ok(()) => {
                    let since = Instant::now();
                    let modified = fs::symlink_metadata(&path).and_then(|m| m.modified()).inspect_err(|_| {
                        let _ = fs::remove_dir(&path);
                    })?;
                    return Ok(Self { path, modified, since });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "Claude config lock was busy for 2 seconds"));
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(25)));
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn still_held(&self) -> bool {
        // Keep the write well inside Claude's stale-lock interval.
        self.since.elapsed() < Duration::from_secs(5)
            && fs::symlink_metadata(&self.path)
                .is_ok_and(|m| m.is_dir() && m.modified().is_ok_and(|t| t == self.modified))
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        if self.still_held() {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn read_config(config: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(config) {
        Ok(meta) if meta.is_file() => fs::read(config).map(Some),
        Ok(_) => Err(io::Error::other("expected a regular file")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn update_trust(config: &Path, key: &str) -> io::Result<()> {
    // An atomic read is enough when the exact cwd is already trusted.
    // A new entry still requires a fresh read under Claude's lock.
    if read_config(config).is_ok_and(|bytes| {
        trust_fields(bytes.as_deref(), key).is_ok_and(|(_, _, project)| trust_is_set(&project))
    }) {
        return Ok(());
    }
    let lock = ConfigLock::acquire(config)?;
    let before = read_config(config)?;
    let (mut all, mut projects, mut project) = trust_fields(before.as_deref(), key)?;
    if trust_is_set(&project) {
        return Ok(());
    }
    project.insert(ACCEPTED.into(), to_raw_value(&true)?);
    projects.insert(key.into(), to_raw_value(&project)?);
    all.insert("projects".into(), to_raw_value(&projects)?);

    let parent = config.parent().ok_or_else(|| io::Error::other("missing config directory"))?;
    let mut tmp = tempfile::Builder::new().prefix(".claude-trust-").tempfile_in(parent)?;
    serde_json::to_writer_pretty(tmp.as_file_mut(), &all)?;
    tmp.write_all(b"\n")?;
    tmp.as_file().sync_all()?;
    // Also catch changes by a writer that does not follow Claude's lock.
    if read_config(config)? != before || !lock.still_held() {
        return Err(io::Error::other("config changed during the write, retry the launch"));
    }
    if before.is_some() {
        tmp.persist(config)?;
    } else {
        tmp.persist_noclobber(config)?;
    }
    Ok(())
}

type Fields = BTreeMap<String, Box<RawValue>>;

fn trust_fields(bytes: Option<&[u8]>, key: &str) -> serde_json::Result<(Fields, Fields, Fields)> {
    // Raw values preserve unknown fields and large numbers from Claude.
    let all = serde_json::from_slice(bytes.unwrap_or(b"{}"))?;
    let projects = fields(&all, "projects")?;
    let project = fields(&projects, key)?;
    Ok((all, projects, project))
}

fn trust_is_set(project: &Fields) -> bool {
    project.get(ACCEPTED).is_some_and(|raw| raw.get() == "true")
}

fn fields(parent: &Fields, name: &str) -> serde_json::Result<Fields> {
    parent.get(name).map_or_else(|| Ok(Fields::new()), |raw| serde_json::from_str(raw.get()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_are_off_by_default_and_canonicalized_on_both_sides() {
        let home = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(home.path()).unwrap();
        let cwd = home.join("work/wt/new");
        let outside = home.join("workshop");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir(&outside).unwrap();
        let root = |cwd: &Path| matching_root(&home, &home, cwd, "claude", false).unwrap().root;
        assert_eq!(root(&cwd), None);

        let settings = home.join(CONFIG);
        fs::write(&settings, br#"{"roots":[]}"#).unwrap();
        assert_eq!(root(&cwd), None);
        fs::write(&settings, br#"{"roots":["~/missing","~/work"]}"#).unwrap();
        assert_eq!(root(&cwd).as_deref(), Some("~/work"));
        assert_eq!(root(&home.join("work")).as_deref(), Some("~/work"));
        assert_eq!(root(&outside), None);
        assert_eq!(matching_root(&home, &home, &cwd, "claude", true).unwrap().root, None);
        assert_eq!(matching_root(&home, &home, &cwd, "codex", false).unwrap().root.as_deref(), Some("~/work"));
        assert_eq!(matching_root(&home, &home, &cwd, "codex", true).unwrap().root, None);
        assert_eq!(matching_root(&home, &home, &cwd, "shell", false).unwrap().root, None);
        assert_eq!(matching_root(&home, &home, &cwd, "antigravity", false).unwrap().root, None);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.join("work"), home.join("root-link")).unwrap();
            std::os::unix::fs::symlink(outside, home.join("work/escape")).unwrap();
            fs::write(&settings, br#"{"roots":["~/root-link"]}"#).unwrap();
            assert_eq!(root(&cwd).as_deref(), Some("~/root-link"));
            assert_eq!(root(&dunce::canonicalize(home.join("work/escape")).unwrap()), None);
        }
    }

    #[test]
    fn rejects_home_its_ancestors_and_the_config_directory_tree() {
        let fixture = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(fixture.path()).unwrap();
        let home = base.join("home");
        let work = home.join("work");
        let config_parent = home.join("config");
        let config_dir = config_parent.join("agent-mcr");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&config_dir).unwrap();
        let settings = config_dir.join(CONFIG);
        fs::write(&settings, serde_json::json!({"roots": ["~", base, "~/config", "~/config/agent-mcr"]}).to_string()).unwrap();
        let matching = matching_root(&config_dir, &home, &work, "claude", false).unwrap();
        assert_eq!(matching.root, None);
        assert_eq!(matching.rejected.len(), 4);
        assert!(matching.rejected[..2].iter().all(|reason| reason.contains("the home folder or an ancestor")));
        assert!(matching.rejected[2..].iter().all(|reason| reason.contains("contains the Agent MCR config directory")));

        fs::write(&settings, br#"{"roots":["~/work","~/config"]}"#).unwrap();
        let matching = matching_root(&config_dir, &home, &work, "claude", false).unwrap();
        assert_eq!(matching.root.as_deref(), Some("~/work"));
        assert_eq!(matching.rejected.len(), 1);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&home, home.join("home-link")).unwrap();
            fs::write(&settings, br#"{"roots":["~/home-link"]}"#).unwrap();
            let matching = matching_root(&config_dir, &home, &work, "claude", false).unwrap();
            assert_eq!(matching.root, None);
            assert!(matching.rejected[0].contains("the home folder or an ancestor"));
        }
    }

    #[test]
    fn windows_launch_uses_the_same_mode_and_tool_rules() {
        use crate::agents::{windows_args, Launch};
        let fixture = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(fixture.path()).unwrap();
        let worktree = home.join("work/wt/new");
        let outside = home.join("workshop");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(home.join(CONFIG), br#"{"roots":["~/work"]}"#).unwrap();

        let lead = crate::profiles::choose(&home, "lead@claude-opus").unwrap();
        let implementer = crate::profiles::choose(&home, "implementer@claude-opus").unwrap();
        let (executor, _) = crate::profiles::lower_of(&implementer, &lead.profile).unwrap();
        let validator = crate::profiles::choose(&home, "validator@claude-opus").unwrap();
        let (validator, _) = crate::profiles::lower_of(&validator, &lead.profile).unwrap();
        let sre = crate::profiles::choose(&home, "sre@claude-sonnet").unwrap();
        let backlog = crate::profiles::choose(&home, "backlog@claude-opus").unwrap();
        let custom = |mode| crate::profiles::parse(&format!("id = \"custom@mode\"\nversion = 1\nrole = \"custom\"\nadapter = \"claude\"\n[permissions]\nmode = \"{mode}\""), crate::profiles::Origin::Operator).unwrap();
        let custom_plan = custom("plan");
        let custom_edit = custom("acceptEdits");
        for (profile, cwd, mode, expect_delivery) in [
            (Some(&lead.profile), &worktree, "auto", true),
            (Some(&executor.profile), &worktree, "auto", false),
            (None, &worktree, "auto", false),
            (Some(&lead.profile), &outside, "acceptEdits", true),
            (Some(&validator.profile), &worktree, "auto", false),
            (Some(&sre.profile), &worktree, "auto", false),
            (Some(&sre.profile), &outside, "manual", false),
            (Some(&backlog.profile), &worktree, "auto", false),
            (Some(&backlog.profile), &outside, "manual", false),
            (Some(&custom_plan), &worktree, "plan", false),
            (Some(&custom_edit), &worktree, "auto", false),
        ] {
            let matched = matching_root(&home, &home, cwd, "claude", false).unwrap();
            assert_eq!(matched.root.is_some(), cwd == &worktree);
            let launch = Launch { profile: "claude", agent: profile, auto_root: matched.root.as_deref(), settings: "claude-hooks.json", ..Default::default() };
            let args = windows_args(&launch).unwrap();
            assert_eq!(&args[1..3], ["--permission-mode", mode]);
            let reason = match mode {
                "auto" => "root ~/work",
                "plan" => "profile mode kept under root ~/work",
                _ => "profile",
            };
            assert_eq!(launch.effective_mode(&[]).unwrap(), format!("{mode} ({reason})"));
            assert_eq!(args.iter().filter(|arg| *arg == "--permission-mode").count(), 1);
            let allowed: Vec<_> = args.iter().skip_while(|arg| *arg != "--allowedTools").skip(1)
                .take_while(|arg| !arg.starts_with("--")).map(String::as_str).collect();
            let mut expected = Vec::new();
            if expect_delivery {
                expected.extend(["Bash(git push origin *)", "Bash(gh pr merge --merge -- *)"]);
                assert!(args.iter().any(|arg| arg == "Bash(git push * --exec*)"));
            }
            if mode == "auto" {
                expected.extend(["mcp__teob-memory", "mcp__teob-harness", "mcp__mcr-memory", "mcp__atlassian"]);
            }
            assert_eq!(allowed, expected);
            if let Some(profile) = profile {
                assert!(profile.tools.deny.iter().all(|rule| args.contains(rule)));
            }
        }
    }

    #[test]
    fn trust_merges_after_a_claude_writer_and_keeps_other_fields() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".claude.json");
        let lock = ConfigLock::acquire(&config).unwrap();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| update_trust(&config, "/work/lead").unwrap());
            let second = scope.spawn(|| update_trust(&config, "/work/executor").unwrap());
            fs::write(&config, br#"{"other":123456789012345678901234567890,"projects":{"/work/executor":{"hasTrustDialogAccepted":false,"someFutureField":[1,2]},"/other":{"existing":true}}}"#).unwrap();
            drop(lock);
            first.join().unwrap();
            second.join().unwrap();
        });
        let bytes = fs::read(&config).unwrap();
        let all: Fields = serde_json::from_slice(&bytes).unwrap();
        let projects = fields(&all, "projects").unwrap();
        let executor = fields(&projects, "/work/executor").unwrap();
        assert_eq!(all["other"].get(), "123456789012345678901234567890");
        assert_eq!(projects["/other"].get(), r#"{"existing":true}"#);
        assert_eq!(executor["someFutureField"].get(), "[1,2]");
        assert_eq!(executor[ACCEPTED].get(), "true");
        assert_eq!(fields(&projects, "/work/lead").unwrap()[ACCEPTED].get(), "true");
        let lock = ConfigLock::acquire(&config).unwrap();
        update_trust(&config, "/work/executor").unwrap();
        assert_eq!(fs::read(&config).unwrap(), bytes);
        drop(lock);
        assert_eq!(fs::read_dir(home.path()).unwrap().count(), 1);
    }

    #[test]
    fn trust_leaves_an_unreadable_shape_in_place_and_creates_a_missing_config() {
        let home = tempfile::tempdir().unwrap();
        let config = claude_config(home.path(), None).unwrap();
        update_trust(&config, "/work").unwrap();
        let contents: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(contents, serde_json::json!({"projects":{"/work":{ACCEPTED:true}}}));
        for damaged in [r#"{"projects":["new-format"]}"#, r#"{"projects":{"/work":false}}"#, "{truncated", "[]"] {
            fs::write(&config, damaged).unwrap();
            assert!(update_trust(&config, "/work").is_err(), "{damaged}");
            assert_eq!(fs::read_to_string(&config).unwrap(), damaged);
            assert_eq!(fs::read_dir(home.path()).unwrap().count(), 1);
        }
    }
}
