//! One adapter per agent program. Everything the harness has to know about a
//! particular agent is here: how it is launched and resumed, which files its
//! launch reads, how its conversation is found again, how a turn is stopped
//! and how it reports. The harness service asks the adapter and never names
//! an agent itself, so another agent is another adapter.

use crate::harness::{claude_mcp, claude_plugin, claude_settings, Resumable, Subagent, AGENT_SERVER, PEER_NOTE, PROFILES};
use serde_json::json;
use std::io::Read;
use std::path::Path;

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
        || t.starts_with("Another Claude session")
        || t.starts_with("The coordinator sent")
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
        guard.insert(path.to_path_buf(), (mtime, summary.clone()));
    }
    summary
}

/// What a launch needs besides the profile.
#[derive(Default)]
pub struct Launch<'a> {
    pub profile: &'a str,
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
    /// The profile id (`PROFILES`)
    fn id(&self) -> &'static str;
    /// The command run in the login shell; `base` is the profile's command (D7)
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String>;
    /// Files the launch reads, as paths under the config dir. Written before
    /// every launch, so a restart picks up what a new build wants in them.
    fn files(&self, _exe: &str, _supervisor: bool) -> Vec<(String, String)> {
        Vec::new()
    }
    /// Takes prompts and ends turns (a shell does neither)
    fn is_agent(&self) -> bool {
        true
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
    /// The input box is on screen (the markers depend on the agent's version)
    fn at_prompt(&self, _screen: &str) -> bool {
        true
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
pub struct Antigravity;
pub struct Shell;

impl Adapter for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }
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
    fn id(&self) -> &'static str {
        "codex"
    }
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

impl Adapter for Antigravity {
    fn id(&self) -> &'static str {
        "antigravity"
    }
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let mut cmd = format!("exec {base}");
        if let Some(id) = l.resume {
            cmd += &format!(" --conversation {id}");
        }
        if let Some(t) = l.task {
            cmd += &format!(" --prompt-interactive {}", sh(t));
        }
        Ok(cmd)
    }
    fn interrupt(&self) -> Interrupt {
        Interrupt::Key("\x1b")
    }
    fn takes_note(&self, _home: &Path) -> bool {
        false
    }
}

impl Adapter for Shell {
    fn id(&self) -> &'static str {
        "shell"
    }
    fn command_line(&self, _base: &str, l: &Launch) -> Result<String, String> {
        if l.resume.is_some() || l.task.is_some() {
            return Err("A shell has no session to resume and takes no task".into());
        }
        Ok(String::new())
    }
    fn is_agent(&self) -> bool {
        false
    }
}

pub const ADAPTERS: &[&dyn Adapter] = &[&Claude, &Codex, &Antigravity, &Shell];

/// The adapter of a profile; anything unknown is treated as a plain shell.
pub fn adapter(profile: &str) -> &'static dyn Adapter {
    ADAPTERS.iter().copied().find(|a| a.id() == profile).unwrap_or(&Shell)
}

/// The command line run in the login shell (empty for a plain shell).
pub fn command_line(l: &Launch) -> Result<String, String> {
    let p = PROFILES.iter().find(|p| p.id == l.profile).ok_or_else(|| format!("Unknown profile {}", l.profile))?;
    if l.resume.is_some_and(|id| !is_uuid(id)) {
        return Err("Invalid session id to resume".into());
    }
    let task = l.task.map(str::trim).filter(|t| !t.is_empty());
    adapter(p.id).command_line(p.command, &Launch { task, ..*l })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_profile_has_an_adapter_and_only_agents_take_prompts() {
        for p in PROFILES {
            assert_eq!(adapter(p.id).id(), p.id);
        }
        assert_eq!(adapter("something new").id(), "shell", "an unknown profile is never typed into as an agent");
        assert!(adapter("claude").is_agent() && adapter("codex").is_agent() && adapter("antigravity").is_agent() && !adapter("shell").is_agent());
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
    fn claude_launch_files_are_written_under_the_config_dir() {
        let names: Vec<String> = Claude.files("/x/agent-mcr", false).into_iter().map(|(name, _)| name).collect();
        assert!(names.starts_with(&["claude-hooks.json".to_string(), "claude-mcp.json".to_string()]));
        assert!(names.iter().skip(2).all(|n| n.starts_with("claude-plugin/")));
        assert!(Claude.files("/x/agent-mcr", true)[0].0.contains("supervisor"));
        assert!(Codex.files("/x/agent-mcr", false).is_empty() && Shell.files("/x", false).is_empty());
    }
}
