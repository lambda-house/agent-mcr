//! One adapter per agent program. Everything the harness has to know about a
//! particular agent is here: how it is launched and resumed, which files its
//! launch reads, how its conversation is found again, how a turn is stopped
//! and how it reports. The harness service asks the adapter and never names
//! an agent itself, so another agent is another adapter.

use crate::harness::{claude_mcp, claude_plugin, claude_settings, Resumable, Subagent, AGENT_SERVER, PEER_NOTE};
use serde::Serialize;
#[cfg(any(unix, test))]
use serde_json::json;
use std::io::Read;
use std::path::Path;

mod plugins;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub optional: bool,
    pub can_supervise: bool,
    pub task_tracking: bool,
}

pub fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

pub fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The first JSON string value of `key` in the head of a transcript. Lines
/// can be megabytes long, so this never parses whole lines.
pub fn head_value(path: &Path, key: &str, limit: u64) -> Option<String> {
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(limit).read_to_end(&mut head).ok()?;
    let needle = format!("\"{key}\":\"");
    let at = head.windows(needle.len()).position(|w| w == needle.as_bytes())? + needle.len() - 1;
    serde_json::Deserializer::from_slice(&head[at..]).into_iter::<String>().next()?.ok()
}

fn clean_title(raw: &str) -> Option<String> {
    let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.len() < 4
        || t.starts_with('<')
        || t.starts_with("[SYSTEM")
        || t.starts_with('#')
    {
        return None;
    }
    Some(t.chars().take(120).collect())
}

fn extract_text(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return clean_title(s);
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = item.get("text").and_then(|t| t.as_str()).and_then(clean_title) {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[derive(Clone, Default)]
struct TranscriptSummary {
    title: Option<String>,
    role: Option<String>,
    tags: Vec<String>,
}

fn transcript_summary(path: &Path, is_claude: bool) -> TranscriptSummary {
    use std::collections::HashMap;
    use std::io::BufRead;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, TranscriptSummary)>>> = OnceLock::new();
    let mtime = modified_ms(path);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((cached_mtime, summary)) = guard.get(path) {
            if *cached_mtime == mtime {
                return summary.clone();
            }
        }
    }

    let Ok(file) = std::fs::File::open(path) else { return TranscriptSummary::default() };
    let mut reader = std::io::BufReader::new(file.take(192 * 1024));
    let mut line = String::new();
    let mut custom = None;
    let mut first_user = None;

    let mut reads = 0usize;
    let mut edits = 0usize;
    let mut shell = 0usize;
    let mut tests = 0usize;
    let mut subagents = 0usize;
    let mut ui_hits = 0usize;
    let mut rust_hits = 0usize;
    let mut py_hits = 0usize;
    let mut docs_hits = 0usize;
    let mut data_hits = 0usize;
    let mut test_file_hits = 0usize;

    for _ in 0..120 {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if line.len() <= 32 * 1024 {
            if is_claude {
                if line.contains("\"custom-title\"") || line.contains("\"customTitle\"") || line.contains("\"summary\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        for k in ["customTitle", "summary", "title"] {
                            if let Some(t) = v.get(k).and_then(|x| x.as_str()).and_then(clean_title) {
                                custom = Some(t);
                            }
                        }
                    }
                } else if first_user.is_none() && line.contains("\"type\":\"user\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                            first_user = v.get("message").and_then(|m| m.get("content")).and_then(extract_text);
                        }
                    }
                }
            } else if line.contains("\"thread_name\"") || line.contains("\"user_message\"") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(t) = v.get("payload").and_then(|p| p.get("thread_name")).and_then(|x| x.as_str()).and_then(clean_title) {
                        custom = Some(t);
                    } else if first_user.is_none() && v.get("payload").and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message") {
                        first_user = v.get("payload").and_then(|p| p.get("message")).and_then(|x| x.as_str()).and_then(clean_title);
                    }
                }
            }
        }

        // Activity & scope fingerprinting from tool calls (0 LLM tokens)
        if line.contains("\"tool_use\"") || line.contains("\"function_call\"") || line.contains("\"apply_patch\"") {
            if ["\"Read\"", "\"Grep\"", "\"Glob\"", "\"WebSearch\"", "\"WebFetch\"", "\"read_file\"", "\"grep_search\""]
                .iter().any(|k| line.contains(k))
            {
                reads += 1;
            }
            if ["\"Edit\"", "\"Write\"", "\"MultiEdit\"", "\"apply_patch\""].iter().any(|k| line.contains(k)) {
                edits += 1;
            }
            if line.contains("\"Bash\"") || line.contains("\"exec_command\"") {
                shell += 1;
                if ["cargo test", "vitest", "jest", "pytest", "npm test", "playwright"].iter().any(|k| line.contains(k)) {
                    tests += 1;
                }
            }
            if line.contains("\"Agent\"") || line.contains("\"Task\"") || line.contains("\"subagent_type\"") {
                subagents += 1;
            }
            if [".css", ".scss", ".tsx", ".jsx"].iter().any(|ext| line.contains(ext)) {
                ui_hits += 1;
            }
            if line.contains(".rs") {
                rust_hits += 1;
            }
            if line.contains(".py") {
                py_hits += 1;
            }
            if line.contains(".md") {
                docs_hits += 1;
            }
            if line.contains(".sql") || line.contains(".prisma") {
                data_hits += 1;
            }
            if line.contains(".test.") || line.contains(".spec.") || line.contains("/tests/") {
                test_file_hits += 1;
            }
        }
    }

    let role = if subagents > 0 && edits == 0 {
        Some("Orchestrator")
    } else if tests > 0 && edits == 0 {
        Some("Tester")
    } else if tests > 0 && edits > 0 {
        Some("Builder · Tests")
    } else if edits == 0 && reads >= 3 {
        Some("Researcher")
    } else if edits > 0 && ui_hits > rust_hits + py_hits + data_hits {
        Some("UI Builder")
    } else if edits > 0 && rust_hits + py_hits + data_hits > ui_hits {
        Some("Backend")
    } else if edits > 0 {
        Some("Builder")
    } else if shell > 0 {
        Some("Runner")
    } else {
        None
    }.map(str::to_string);

    let mut scope_counts = [
        (ui_hits, "UI"),
        (rust_hits, "Rust"),
        (test_file_hits + tests, "Tests"),
        (py_hits, "Python"),
        (docs_hits, "Docs"),
        (data_hits, "Data"),
    ];
    scope_counts.sort_by(|a, b| b.0.cmp(&a.0));
    let tags = scope_counts
        .into_iter()
        .filter(|(c, _)| *c > 0)
        .take(2)
        .map(|(_, label)| label.to_string())
        .collect();

    let summary = TranscriptSummary { title: custom.or(first_user), role, tags };
    if let Ok(mut guard) = cache.lock() {
        // chisle: drop all at the cap; an LRU only if rescans show up in profiles
        if guard.len() >= 4096 {
            guard.clear();
        }
        guard.insert(path.to_path_buf(), (mtime, summary.clone()));
    }
    summary
}

/// What a launch needs besides the profile.
#[derive(Default)]
pub struct Launch<'a> {
    pub profile: &'a str,
    pub supervisor: bool,
    pub exe: &'a str,
    /// Claude settings file carrying the hooks
    pub settings: &'a str,
    /// Claude MCP config file carrying the harness tools
    pub mcp: &'a str,
    /// Claude plugin folder carrying the peers skill
    pub plugin: &'a str,
    /// Tell the agent about its peers (`PEER_NOTE`)
    pub note: bool,
    /// A new conversation id chosen by the harness, so the transcript link is exact
    pub agent_session: Option<&'a str>,
    pub resume: Option<&'a str>,
    pub task: Option<&'a str>,
}

/// How the current turn of an agent is stopped.
pub enum Interrupt {
    /// Typed into the terminal
    Key(&'static str),
    /// Sent to the foreground process
    Signal(&'static str),
}

pub trait Adapter: Sync {
    fn profile(&self) -> Profile;
    fn id(&self) -> &'static str { self.profile().id }
    /// The command run in the login shell; `base` is the profile's command (D7)
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String>;
    /// Files the launch reads, as paths under the config dir. Written before
    /// every launch, so a restart picks up what a new build wants in them.
    fn files(&self, _exe: &str, _supervisor: bool) -> Vec<(String, String)> {
        Vec::new()
    }
    /// Takes prompts and ends turns (a shell does neither)
    fn is_agent(&self) -> bool {
        self.profile().task_tracking
    }
    /// The harness chooses the conversation id at launch; otherwise the agent reports it
    fn names_conversation(&self) -> bool {
        false
    }
    /// Reports through hooks from its first moment: its state is exact, its
    /// terminal notifications only repeat the hooks, and one that went quiet
    /// without a single hook is asking a start-up question
    fn reports_from_start(&self) -> bool {
        false
    }
    /// Reports nothing until its first turn ends; until then only the screen
    /// tells whether it is at its prompt (`at_prompt`)
    fn silent_until_first_turn(&self) -> bool {
        false
    }
    /// Whether `at_prompt` reliably detects the input box (for queued first-task delivery)
    fn detects_prompt(&self) -> bool {
        self.silent_until_first_turn()
    }
    /// The input box is on screen (the markers depend on the agent's version).
    /// False when unsure: text typed into a menu would answer it
    fn at_prompt(&self, _screen: &str) -> bool {
        false
    }
    fn interrupt(&self) -> Interrupt {
        Interrupt::Signal("INT")
    }
    /// Whether the peers note can be passed without displacing the operator's own instructions
    fn takes_note(&self, _home: &Path) -> bool {
        true
    }
    /// Where its transcripts are under the home folder, and how deep
    fn transcripts(&self) -> Option<(&'static str, usize)> {
        None
    }
    /// A transcript the agent can continue: id, folder and time only
    fn resumable(&self, _path: &Path) -> Option<Resumable> {
        None
    }
    /// The subagents a session started that were active since `since`, from
    /// its files: `transcript` is the path the agent reported, `conversation`
    /// its id. Activity seen in files, not verified liveness.
    fn subagents(&self, _home: &Path, _transcript: Option<&str>, _conversation: Option<&str>, _since: u64) -> Vec<Subagent> {
        Vec::new()
    }
}

pub struct Claude;
pub struct Codex;
pub struct Shell;

impl Adapter for Claude {
    fn profile(&self) -> Profile {
        Profile { id: "claude", label: "Claude Code", command: "claude --permission-mode acceptEdits", optional: false, can_supervise: true, task_tracking: true }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let mut cmd = format!("exec {base}");
        if !l.mcp.is_empty() {
            cmd += &format!(" --mcp-config {}", sh(l.mcp));
        }
        cmd += &format!(" --settings {}", sh(l.settings));
        if !l.plugin.is_empty() {
            cmd += &format!(" --plugin-dir {}", sh(l.plugin));
        }
        if l.note {
            cmd += &format!(" --append-system-prompt {}", sh(PEER_NOTE));
        }
        match (l.resume, l.agent_session) {
            (Some(id), _) => cmd += &format!(" --resume {id}"),
            (None, Some(id)) if is_uuid(id) => cmd += &format!(" --session-id {id}"),
            _ => {}
        }
        if let Some(t) = l.task {
            cmd += &format!(" -- {}", sh(t));
        }
        Ok(cmd)
    }
    fn files(&self, exe: &str, supervisor: bool) -> Vec<(String, String)> {
        let pretty = |v: serde_json::Value| serde_json::to_string_pretty(&v).unwrap_or_default();
        let mut files = vec![
            (if supervisor { "claude-supervisor-hooks.json" } else { "claude-hooks.json" }.to_string(), pretty(claude_settings(exe, supervisor))),
            (if supervisor { "claude-supervisor-mcp.json" } else { "claude-mcp.json" }.to_string(), pretty(claude_mcp(exe, supervisor))),
        ];
        files.extend(claude_plugin().into_iter().map(|(name, content)| (format!("claude-plugin/{name}"), content)));
        files
    }
    fn names_conversation(&self) -> bool {
        true
    }
    fn reports_from_start(&self) -> bool {
        true
    }
    fn interrupt(&self) -> Interrupt {
        Interrupt::Key("\x1b")
    }
    fn transcripts(&self) -> Option<(&'static str, usize)> {
        Some((".claude/projects", 1))
    }
    fn resumable(&self, path: &Path) -> Option<Resumable> {
        let id = path.file_stem()?.to_str()?.to_string();
        if !is_uuid(&id) {
            return None;
        }
        let cwd = head_value(path, "cwd", 1024 * 1024)?;
        let summary = transcript_summary(path, true);
        Some(Resumable {
            agent: self.id(),
            id,
            cwd,
            modified: modified_ms(path),
            title: summary.title,
            role: summary.role,
            tags: summary.tags,
        })
    }
    fn subagents(&self, home: &Path, transcript: Option<&str>, _conversation: Option<&str>, since: u64) -> Vec<Subagent> {
        transcript.map(|t| crate::harness::subagents(home, t, since)).unwrap_or_default()
    }
}

impl Adapter for Codex {
    fn profile(&self) -> Profile {
        Profile { id: "codex", label: "Codex", command: "codex --sandbox workspace-write --ask-for-approval on-request", optional: false, can_supervise: true, task_tracking: true }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let (head, flags) = base.split_once(' ').unwrap_or((base, ""));
        let notify = format!("notify={}", json!([l.exe, "--harness-hook", "codex-notify"]));
        // The harness tools, for this launch only (values are TOML; a JSON string is one)
        let tools = format!(
            "-c {} -c {}",
            sh(&format!("mcp_servers.{AGENT_SERVER}.command={}", json!(l.exe))),
            sh(&format!("mcp_servers.{AGENT_SERVER}.args=[\"--harness-mcp\"]"))
        );
        let mut cmd = format!("exec {head}");
        if l.resume.is_some() {
            cmd += " resume";
        }
        cmd += &format!(" {flags} -c {} -c tui.notifications=true {tools}", sh(&notify));
        if l.supervisor {
            cmd += &format!(" -c {} -c {}", sh(&format!("mcp_servers.supervisor.command={}", json!(l.exe))), sh("mcp_servers.supervisor.args=[\"--supervise\"]"));
        }
        if l.note {
            cmd += &format!(" -c {}", sh(&format!("developer_instructions={}", json!(PEER_NOTE))));
        }
        if let Some(id) = l.resume {
            cmd += &format!(" {id}");
        }
        if let Some(t) = l.task {
            cmd += &format!(" -- {}", sh(t));
        }
        Ok(cmd)
    }
    fn silent_until_first_turn(&self) -> bool {
        true
    }
    fn at_prompt(&self, screen: &str) -> bool {
        screen.contains("for shortcuts") && screen.lines().any(|l| l.starts_with('\u{203a}'))
    }
    /// Codex takes one `developer_instructions` value: the operator's own, if set, stays
    fn takes_note(&self, home: &Path) -> bool {
        !std::fs::read_to_string(home.join(".codex/config.toml")).is_ok_and(|c| c.lines().any(|l| l.trim_start().starts_with("developer_instructions")))
    }
    fn transcripts(&self) -> Option<(&'static str, usize)> {
        Some((".codex/sessions", 3))
    }
    fn resumable(&self, path: &Path) -> Option<Resumable> {
        let stem = path.file_stem()?.to_str()?;
        let id = stem.get(stem.len().checked_sub(36)?..)?.to_string();
        if !is_uuid(&id) || !stem.starts_with("rollout-") {
            return None;
        }
        // Sessions started by other agents (subagents) aren't the user's to resume
        if head_value(path, "thread_source", 8192).is_some_and(|s| s != "user") {
            return None;
        }
        let cwd = head_value(path, "cwd", 8192)?;
        let summary = transcript_summary(path, false);
        Some(Resumable {
            agent: self.id(),
            id,
            cwd,
            modified: modified_ms(path),
            title: summary.title,
            role: summary.role,
            tags: summary.tags,
        })
    }
    fn subagents(&self, home: &Path, _transcript: Option<&str>, conversation: Option<&str>, since: u64) -> Vec<Subagent> {
        conversation.map(|c| crate::harness::codex_subagents(home, c, since)).unwrap_or_default()
    }
}

impl Adapter for Shell {
    fn profile(&self) -> Profile {
        Profile { id: "shell", label: "Terminal", command: "", optional: false, can_supervise: false, task_tracking: false }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, _base: &str, l: &Launch) -> Result<String, String> {
        if l.resume.is_some() || l.task.is_some() {
            return Err("A shell has no session to resume and takes no task".into());
        }
        Ok(String::new())
    }
}

const BUILT_INS: &[&dyn Adapter] = &[&Claude, &Codex, &Shell];

pub fn adapters() -> impl Iterator<Item = &'static dyn Adapter> {
    BUILT_INS.iter().chain(plugins::PLUGINS.iter()).copied()
}

pub fn profiles() -> Vec<Profile> {
    adapters().map(|a| a.profile()).collect()
}

/// The adapter of a profile; anything unknown is treated as a plain shell.
pub fn adapter(profile: &str) -> &'static dyn Adapter {
    adapters().find(|a| a.id() == profile).unwrap_or(&Shell)
}

/// The command line run in the login shell (empty for a plain shell).
#[cfg(any(unix, test))]
pub fn command_line(l: &Launch) -> Result<String, String> {
    let agent = adapters().find(|a| a.id() == l.profile).ok_or_else(|| format!("Unknown profile {}", l.profile))?;
    if l.supervisor && !agent.profile().can_supervise {
        return Err("This harness cannot supervise agents".into());
    }
    if l.resume.is_some_and(|id| !is_uuid(id)) {
        return Err("Invalid session id to resume".into());
    }
    let task = l.task.map(str::trim).filter(|t| !t.is_empty());
    agent.command_line(agent.profile().command, &Launch { task, ..*l })
}

/// A TOML single-quoted literal string (no escapes, no `"` needed).
#[cfg(any(windows, test))]
pub fn toml_literal(s: &str) -> Result<String, String> {
    if s.chars().any(|c| matches!(c, '\'' | '\r' | '\n' | '\0')) {
        return Err("TOML literal string contains an unsupported character".into());
    }
    Ok(format!("'{s}'"))
}

/// Encode `args` for `cmd.exe /d /v:off /c %AMCR_LAUNCH%`.
///
/// Refuses any argument containing `"`, `%`, CR, LF or NUL. Every argument
/// (including the program name) is wrapped in double quotes, with trailing
/// backslash runs doubled for CRT/`CommandLineToArgvW`, and joined by one space.
#[cfg(any(windows, test))]
pub fn cmd_line(args: &[String]) -> Result<String, String> {
    if args.is_empty() {
        return Err("Nothing to run".into());
    }
    let mut inner = String::new();
    for (i, arg) in args.iter().enumerate() {
        if arg.chars().any(|c| matches!(c, '"' | '%' | '\r' | '\n' | '\0')) {
            return Err("Launch argument contains an unsupported character for cmd.exe".into());
        }
        if i > 0 {
            inner.push(' ');
        }
        inner.push('"');
        let mut backslashes = 0usize;
        for ch in arg.chars() {
            if ch == '\\' {
                backslashes += 1;
                inner.push('\\');
            } else {
                backslashes = 0;
                inner.push(ch);
            }
        }
        for _ in 0..backslashes {
            inner.push('\\');
        }
        inner.push('"');
    }
    Ok(inner)
}

/// Raw argument vector for a Windows launch (without `exec` and without free-text tasks).
#[cfg(any(windows, test))]
pub fn windows_args(l: &Launch) -> Result<Vec<String>, String> {
    let agent = adapters().find(|a| a.id() == l.profile).ok_or_else(|| format!("Unknown profile {}", l.profile))?;
    if l.supervisor && !agent.profile().can_supervise {
        return Err("This harness cannot supervise agents".into());
    }
    if l.resume.is_some_and(|id| !is_uuid(id)) {
        return Err("Invalid session id to resume".into());
    }
    let task = l.task.map(str::trim).filter(|t| !t.is_empty());
    let mut args: Vec<String> = Vec::new();
    match l.profile {
        "shell" => {
            if l.resume.is_some() || task.is_some() {
                return Err("A shell has no session to resume and takes no task".into());
            }
            return Ok(vec!["powershell.exe".into(), "-NoLogo".into()]);
        }
        "claude" => {
            args.extend(["claude", "--permission-mode", "acceptEdits"].into_iter().map(str::to_owned));
            if !l.mcp.is_empty() {
                args.extend(["--mcp-config".into(), l.mcp.to_owned()]);
            }
            args.extend(["--settings".into(), l.settings.to_owned()]);
            if !l.plugin.is_empty() {
                args.extend(["--plugin-dir".into(), l.plugin.to_owned()]);
            }
            if l.note {
                args.extend(["--append-system-prompt".into(), PEER_NOTE.to_owned()]);
            }
            match (l.resume, l.agent_session) {
                (Some(id), _) => args.extend(["--resume".into(), id.to_owned()]),
                (None, Some(id)) if is_uuid(id) => args.extend(["--session-id".into(), id.to_owned()]),
                _ => {}
            }
        }
        "codex" => {
            args.push("codex".into());
            if l.resume.is_some() {
                args.push("resume".into());
            }
            args.extend([
                "--sandbox", "workspace-write", "--ask-for-approval", "on-request",
            ].into_iter().map(str::to_owned));
            let exe_lit = toml_literal(l.exe)?;
            args.extend(["-c".into(), format!("notify=[{exe_lit},'--harness-hook','codex-notify']")]);
            args.extend(["-c".into(), "tui.notifications=true".into()]);
            args.extend(["-c".into(), format!("mcp_servers.{AGENT_SERVER}.command={exe_lit}")]);
            args.extend(["-c".into(), format!("mcp_servers.{AGENT_SERVER}.args=['--harness-mcp']")]);
            if l.supervisor {
                args.extend(["-c".into(), format!("mcp_servers.supervisor.command={exe_lit}")]);
                args.extend(["-c".into(), "mcp_servers.supervisor.args=['--supervise']".into()]);
            }
            if l.note {
                args.extend(["-c".into(), format!("developer_instructions={}", toml_literal(PEER_NOTE)?)]);
            }
            if let Some(id) = l.resume {
                args.push(id.to_owned());
            }
        }
        "antigravity" => {
            args.extend(["agy", "--mode", "accept-edits"].into_iter().map(str::to_owned));
            if let Some(id) = l.resume {
                args.extend(["--conversation".into(), id.to_owned()]);
            }
        }
        "opencode" => {
            args.extend(["opencode", "--standalone"].into_iter().map(str::to_owned));
            if let Some(id) = l.resume {
                args.extend(["--session".into(), id.to_owned()]);
            }
        }
        "pi" => {
            args.push("pi".into());
            if let Some(id) = l.resume {
                args.extend(["--session".into(), id.to_owned()]);
            }
        }
        other => return Err(format!("Unknown profile {other}")),
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_summary_takes_title_role_and_tags_from_the_head() {
        let dir = std::env::temp_dir().join(format!("mcr-summary-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("c.jsonl");
        std::fs::write(&claude, concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"<command-name>x</command-name>\"}}\n",
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Fix   the login bug\"}]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{\"file_path\":\"src/a.rs\"}}]}}\n",
        )).unwrap();
        let s = transcript_summary(&claude, true);
        assert_eq!(s.title.as_deref(), Some("Fix the login bug"), "markup is skipped, spaces collapse");
        assert_eq!(s.role.as_deref(), Some("Backend"));
        assert_eq!(s.tags, vec!["Rust".to_string()]);
        let codex = dir.join("x.jsonl");
        std::fs::write(&codex, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Write the docs\"}}\n").unwrap();
        let s = transcript_summary(&codex, false);
        assert_eq!((s.title.as_deref(), s.role, s.tags.len()), (Some("Write the docs"), None, 0));
        assert!(transcript_summary(&dir.join("missing.jsonl"), true).title.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_profile_has_an_adapter_and_only_agents_take_prompts() {
        for p in profiles() {
            assert_eq!(adapter(p.id).id(), p.id);
        }
        assert_eq!(adapter("something new").id(), "shell", "an unknown profile is never typed into as an agent");
        assert!(adapter("claude").is_agent() && adapter("codex").is_agent() && !adapter("antigravity").is_agent() && !adapter("shell").is_agent());
        // Claude reports through hooks from the start; Codex only once a turn has ended
        assert!(adapter("claude").reports_from_start() && !adapter("claude").silent_until_first_turn());
        assert!(adapter("codex").silent_until_first_turn() && !adapter("codex").reports_from_start());
        assert!(adapter("codex").at_prompt("\u{203a} Explain this codebase\n\n  ? for shortcuts"));
        assert!(!adapter("codex").at_prompt("Do you trust the files in this folder?"));
        assert!(matches!(adapter("claude").interrupt(), Interrupt::Key("\x1b")));
        assert!(matches!(adapter("codex").interrupt(), Interrupt::Signal("INT")));
        assert!(matches!(adapter("antigravity").interrupt(), Interrupt::Key("\x1b")));
        let agy_cmd = command_line(&Launch { profile: "antigravity", task: Some("hi"), ..Default::default() }).unwrap();
        assert!(agy_cmd.starts_with("exec agy ") && agy_cmd.contains("--prompt-interactive 'hi'"));
    }

    #[test]
    fn registry_describes_built_ins_and_optional_plugins() {
        let all = profiles();
        let ids: std::collections::BTreeSet<_> = all.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), all.len(), "each adapter is registered once");
        assert_eq!(all.iter().filter(|p| !p.optional).map(|p| p.id).collect::<Vec<_>>(), ["claude", "codex", "shell"]);
        assert_eq!(all.iter().filter(|p| p.optional).map(|p| p.id).collect::<Vec<_>>(), ["antigravity", "pi", "opencode"]);
        for p in all {
            assert_eq!(p.task_tracking, adapter(p.id).is_agent());
            let serialized = serde_json::to_value(&p).unwrap();
            assert_eq!(serialized["canSupervise"], p.can_supervise);
            assert_eq!(serialized["taskTracking"], p.task_tracking);
        }
        assert!(command_line(&Launch { profile: "shell", supervisor: true, ..Default::default() }).is_err());
    }

    #[test]
    fn claude_launch_files_are_written_under_the_config_dir() {
        let names: Vec<String> = Claude.files("/x/agent-mcr", false).into_iter().map(|(name, _)| name).collect();
        assert!(names.starts_with(&["claude-hooks.json".to_string(), "claude-mcp.json".to_string()]));
        assert!(names.iter().skip(2).all(|n| n.starts_with("claude-plugin/")));
        assert!(Claude.files("/x/agent-mcr", true)[0].0.contains("supervisor"));
        assert!(Codex.files("/x/agent-mcr", false).is_empty() && Shell.files("/x", false).is_empty());
    }

    #[test]
    fn every_agent_harness_can_receive_supervisor_tools() {
        let id = "11111111-2222-3333-4444-555555555555";
        for profile in ["pi", "opencode", "antigravity"] {
            let launch = Launch { profile, exe: "/Apps/Agent MCR's.app/mcr", note: true, supervisor: true, task: Some("fix 'quoted' input"), resume: Some(id), ..Default::default() };
            let cmd = command_line(&launch).unwrap();
            assert!(cmd.contains("--supervisor-tool tools_list") && cmd.contains("--harness-tool guide"), "{cmd}");
            assert!(cmd.contains(id) && cmd.contains("fix '\\''quoted'\\'' input"), "{cmd}");
            assert!(!adapter(profile).is_agent(), "no task queue without turn-end hooks");
            let worker = command_line(&Launch { supervisor: false, ..launch }).unwrap();
            assert!(!worker.contains("--supervisor-tool"));
        }
        let supervisor = command_line(&Launch { profile: "codex", exe: "/x/mcr", supervisor: true, ..Default::default() }).unwrap();
        assert!(supervisor.contains("mcp_servers.supervisor.command=\"/x/mcr\"") && supervisor.contains("--supervise"));
        let worker = command_line(&Launch { profile: "codex", exe: "/x/mcr", ..Default::default() }).unwrap();
        assert!(!worker.contains("mcp_servers.supervisor"));
    }

    #[test]
    fn cmd_line_quotes_and_refuses_cmd_metacharacters() {
        let args = vec![
            "C:\\Program Files\\agent-mcr\\agent-mcr.exe".to_string(),
            "".to_string(),
            "C:\\dir with space\\".to_string(),
            "a & b | c < d > e ^ f (g) !h!".to_string(),
        ];
        let encoded = cmd_line(&args).unwrap();
        assert_eq!(
            encoded,
            "\"C:\\Program Files\\agent-mcr\\agent-mcr.exe\" \"\" \"C:\\dir with space\\\\\" \"a & b | c < d > e ^ f (g) !h!\""
        );

        assert!(cmd_line(&[]).is_err());
        for bad in ["has\"quote", "has%PATH%", "line\rbreak", "line\nbreak", "has\0nul"] {
            assert!(cmd_line(&["prog".into(), bad.into()]).is_err(), "must refuse {bad:?}");
        }
    }

    #[test]
    fn windows_args_build_expected_launches_without_exec_or_free_text() {
        let id = "11111111-2222-3333-4444-555555555555";
        let shell = windows_args(&Launch { profile: "shell", ..Default::default() }).unwrap();
        assert_eq!(shell, vec!["powershell.exe", "-NoLogo"]);
        assert!(windows_args(&Launch { profile: "shell", task: Some("hi"), ..Default::default() }).is_err());

        let claude = windows_args(&Launch {
            profile: "claude",
            exe: "C:\\Program Files\\Agent MCR\\agent-mcr.exe",
            settings: "C:\\Users\\u\\AppData\\Local\\agent-mcr\\claude-hooks.json",
            mcp: "C:\\Users\\u\\AppData\\Local\\agent-mcr\\claude-mcp.json",
            plugin: "C:\\Users\\u\\AppData\\Local\\agent-mcr\\claude-plugin",
            note: true,
            agent_session: Some(id),
            task: Some("fix %VAR% & \"quotes\""),
            ..Default::default()
        }).unwrap();
        assert_eq!(claude[0], "claude");
        assert!(claude.contains(&"--session-id".to_string()) && claude.contains(&id.to_string()));
        assert!(!claude.iter().any(|a| a.contains("fix %VAR%")), "task must not go in Windows argv");
        assert!(cmd_line(&claude).is_ok());

        let claude_resume = windows_args(&Launch {
            profile: "claude",
            settings: "C:\\cfg\\claude-hooks.json",
            resume: Some(id),
            ..Default::default()
        }).unwrap();
        assert!(claude_resume.contains(&"--resume".to_string()) && claude_resume.contains(&id.to_string()));

        let codex = windows_args(&Launch {
            profile: "codex",
            exe: "C:\\Program Files\\Agent MCR\\agent-mcr.exe",
            supervisor: true,
            note: true,
            resume: Some(id),
            task: Some("never in argv"),
            ..Default::default()
        }).unwrap();
        assert_eq!(&codex[..2], &["codex", "resume"]);
        assert!(codex.contains(&"notify=['C:\\Program Files\\Agent MCR\\agent-mcr.exe','--harness-hook','codex-notify']".to_string()));
        assert!(codex.contains(&"mcp_servers.supervisor.command='C:\\Program Files\\Agent MCR\\agent-mcr.exe'".to_string()));
        assert!(codex.contains(&"mcp_servers.supervisor.args=['--supervise']".to_string()));
        assert!(codex.iter().any(|a| a.starts_with("developer_instructions='You run in a terminal hosted by Agent MCR")));
        assert!(!codex.iter().any(|a| a.contains("never in argv")));
        assert!(cmd_line(&codex).is_ok());

        let agy = windows_args(&Launch {
            profile: "antigravity",
            task: Some("hi"),
            resume: Some(id),
            ..Default::default()
        }).unwrap();
        assert_eq!(agy, vec!["agy", "--mode", "accept-edits", "--conversation", id]);
        assert!(cmd_line(&agy).is_ok());
    }
}
