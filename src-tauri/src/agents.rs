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
    scope_counts.sort_by_key(|a| std::cmp::Reverse(a.0));
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
    /// Pass the hooks that the agent runs only after the person trusted them
    /// in the agent itself (Codex, MCR-74). Unix only for now: see
    /// docs/WINDOWS_PORT.md, "Not on Windows yet"
    #[cfg_attr(windows, allow(dead_code))]
    pub own_hooks: bool,
    /// The agent profile it is launched with (MCR-126 P2): its fields reach
    /// the command line only through the adapter's fixed mapping
    /// (`profile_words`). None: today's line (a bare launch)
    pub agent: Option<&'a crate::profiles::AgentProfile>,
    /// Set only by the harness after matching an operator-configured root
    /// (MCR-152 for Claude, MCR-162 for Codex).
    pub auto_root: Option<&'a str>,
    /// Why the Codex socket profile is not passed although a root matched:
    /// the harness's launch check (`codex_sockets::check`) could not
    /// establish its policy, so the session gets plain workspace-write with
    /// its network explicitly off (MCR-162 reviews 17269 P1, 17282 P1). A
    /// fixed message, never text from the check
    pub sockets_refused: Option<&'a str>,
    /// With the socket profile: commands may also listen on TCP, because
    /// the macOS firewall was on at the check (owner's decision 17284)
    pub codex_ports: bool,
    /// With the socket profile and no ports: the fixed reason why not
    pub ports_refused: Option<&'a str>,
    /// With a refusal: the plain line it falls back to was run under Codex
    /// and showed no network (review 17287 P1). Otherwise Codex's managed
    /// policy decides, as for any plain line, and `effectiveMode` says so
    pub network_off_checked: bool,
}

// The root override promotes acceptEdits and manual. Plan keeps its mode (MCR-160).
const CLAUDE_AUTO_FROM_MODES: &[&str] = &["acceptEdits", "manual"];

/// The only system where the Codex socket profile is passed (MCR-162):
/// verified there against Seatbelt with codex-cli 0.172. Elsewhere a Codex
/// session under a root keeps plain workspace-write.
pub const CODEX_SOCKETS_OS: &str = "macos";

/// The permission profile a Codex session under a root runs in, defined on
/// its command line. A name of our own, so it does not take the operator's;
/// a config file that defines it makes the launch check refuse it.
pub const CODEX_SOCKET_PROFILE: &str = "agent-mcr-sockets";

/// The one folder where a Codex session under a root may bind and connect
/// Unix sockets (MCR-162). The canonical path: Codex refuses `/tmp` for a
/// folder that does not exist yet. The tests put their sockets below it
/// (`ipc::test_socket_dir`), so `cargo test` needs no prompt there. The other
/// sockets in `/tmp` and `$TMPDIR` (a browser's, an agent daemon's, a JVM's)
/// stay closed.
pub const CODEX_SOCKETS: &str = "/private/tmp/agent-mcr-sockets";

impl Launch<'_> {
    fn claude_mode(&self) -> &str {
        if self.claude_uses_auto() { "auto" } else { self.profile_mode().unwrap_or("acceptEdits") }
    }

    pub fn claude_uses_auto(&self) -> bool {
        self.profile == "claude"
            && self.auto_root.is_some()
            && CLAUDE_AUTO_FROM_MODES.contains(&self.profile_mode().unwrap_or("acceptEdits"))
    }

    /// A Codex session in workspace-write that a root would give Unix
    /// sockets on `os` (MCR-162), before the root is known: the harness reads
    /// auto-mode.json for Codex only then (review 17269 P3). Read-only, the
    /// root Supervisor and other systems keep their line.
    pub fn codex_could_take_sockets(&self, os: &str) -> bool {
        self.profile == "codex" && !self.supervisor && os == CODEX_SOCKETS_OS && self.codex_mode() == "workspace-write"
    }

    /// A Codex session under a root in workspace-write gets Unix sockets
    /// (MCR-162) unless the launch check refused them; read-only keeps its mode
    pub fn codex_sockets(&self) -> bool {
        self.profile == "codex" && self.auto_root.is_some() && self.sockets_refused.is_none() && self.codex_mode() == "workspace-write"
    }

    fn codex_mode(&self) -> &str {
        self.profile_mode().unwrap_or("workspace-write")
    }

    /// Whether the socket profile reaches the command line on `os`
    fn codex_sockets_on(&self, os: &str) -> bool {
        self.codex_sockets() && os == CODEX_SOCKETS_OS
    }

    fn profile_mode(&self) -> Option<&str> {
        self.agent.and_then(|p| p.permissions.mode.as_deref())
    }

    pub fn effective_mode(&self, notes: &[String]) -> Option<String> {
        self.effective_mode_on(notes, std::env::consts::OS)
    }

    fn effective_mode_on(&self, notes: &[String], os: &str) -> Option<String> {
        let mode = match self.profile {
            "claude" => self.claude_mode(),
            "codex" if self.codex_sockets_on(os) && self.codex_ports => "workspace-write + unix sockets + ports",
            "codex" if self.codex_sockets_on(os) => "workspace-write + unix sockets",
            "codex" => self.profile_mode().unwrap_or("workspace-write"),
            "antigravity" => "accept-edits",
            _ => return None,
        };
        let mut reason = match self.auto_root {
            Some(root) if self.codex_sockets_on(os) && self.codex_ports => format!("root {root}, macOS firewall on at launch"),
            Some(root) if self.codex_sockets_on(os) => format!("root {root}, no ports: {}", self.ports_refused.unwrap_or("not checked")),
            Some(root) if self.claude_uses_auto() => format!("root {root}"),
            Some(root) if self.codex_sockets() => format!("root {root}, unix sockets are passed on {CODEX_SOCKETS_OS} only"),
            Some(root) if self.profile == "codex" && self.codex_mode() == "workspace-write" && self.sockets_refused.is_some() => {
                let network = if self.network_off_checked { CODEX_OFF_CHECKED } else { CODEX_OFF_UNCHECKED };
                format!("root {root}, {network}, unix sockets refused: {}", self.sockets_refused.unwrap_or(""))
            }
            Some(root) => format!("profile mode kept under root {root}"),
            None if self.profile_mode().is_some() => "profile".into(),
            None => "adapter default".into(),
        };
        for note in notes {
            reason.push_str(", ");
            reason.push_str(note);
        }
        Some(format!("{mode} ({reason})"))
    }
}

/// What an agent profile may set for a program (MCR-126). Each of these is
/// passed by one fixed flag of the adapter in a later slice; a profile that
/// sets anything the adapter cannot pass is refused, never dropped.
#[derive(Default, Clone, Copy)]
pub struct Expresses {
    pub model: bool,
    pub fallback_model: bool,
    pub efforts: &'static [&'static str],
    /// Permission modes (Claude) or sandboxes (Codex) it can be started in.
    /// Only modes that keep the human answering prompts, or that a profile
    /// check refuses by role; never a bypass or a danger mode
    pub modes: &'static [&'static str],
    /// Tool deny and only lists
    pub tools: bool,
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
    /// A plain terminal: the program that reads its input is whatever the
    /// person runs in it, not an agent's screen. Not the same as `!is_agent`:
    /// an agent without state tracking (Antigravity, OpenCode, Pi) is a screen
    /// with an input box all the same (MCR-115)
    fn is_plain_terminal(&self) -> bool {
        false
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
    /// Positive proof that the agent's input box is on screen, for a line the
    /// operator's click places there (MCR-97). Stricter than `at_prompt` and
    /// apart from it, so that tasks and notices keep their own rule. False
    /// when unsure: in a menu the characters of a line act as keys
    fn input_box(&self, _screen: &str) -> bool {
        false
    }
    /// Positive proof that the agent's input box is on screen and empty
    /// (MCR-122): a hold for an unsent line that is not there ends. False
    /// when unsure; an agent whose empty box shows suggestions cannot say
    fn empty_input_box(&self, _screen: &str) -> bool {
        false
    }
    /// Whether `empty_input_box` can ever be true; where not, no screen is read for it
    fn shows_empty_input_box(&self) -> bool {
        false
    }
    /// Whether `at_prompt` knows this program's input box at all. Where it
    /// doesn't, the answer is always no and the screen is not read to ask
    fn sees_prompt(&self) -> bool {
        false
    }
    /// Launched as Supervisor so that `terminal_write` is the one tool left to
    /// its own permission prompt: the operator approves each call (Claude:
    /// `claude_settings` pre-approves every other supervisor tool). Only such
    /// a Supervisor is listed that tool and may call it
    fn asks_before_terminal_write(&self) -> bool {
        false
    }
    /// Whether the terminal title says that the agent waits for the operator's
    /// answer. `None`: its title says nothing about that
    fn title_asks(&self, _title: &str) -> Option<bool> {
        None
    }
    /// The question on screen, when the screen ends in one of the agent's own
    /// prompts with numbered answers. Read from the terminal, so a guess: the
    /// wording depends on the agent's version
    fn question(&self, _screen: &str) -> Option<String> {
        None
    }
    /// Whether a notification the agent sent to its terminal says that it
    /// waits for an approval (for agents that report no prompts through hooks)
    fn announces_approval(&self, body: &str) -> bool {
        body.to_lowercase().contains("approv")
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
    /// What an agent profile may set for it (MCR-126): nothing by default
    fn expresses(&self) -> Expresses {
        Expresses::default()
    }
    /// The words a profile puts on the command line, through a fixed mapping
    /// of validated fields only (16647 M1): no field passes words through.
    /// They stand where the bare launch has its mode flags. An adapter that
    /// takes nothing from a profile refuses any field that is set, never
    /// dropping one
    fn profile_words(&self, p: &crate::profiles::AgentProfile) -> Result<Vec<String>, String> {
        let i = &p.inference;
        if i.model.is_some() || i.fallback_model.is_some() || i.effort.is_some() || p.permissions.mode.is_some() || !p.tools.deny.is_empty() || p.tools.only.is_some() {
            return Err(format!("{} takes no model, effort, mode or tool list from a profile", self.id()));
        }
        Ok(Vec::new())
    }
    /// It is started with the `mcr` MCP server; otherwise it reaches the
    /// harness tools through the command form (`--harness-tool`) only
    fn takes_mcp(&self) -> bool {
        false
    }
}

/// The last question on a screen that is followed by numbered answers: the
/// question and what stands between it and the first answer (the command, the
/// reason), on one line. Nothing when no answers follow, as then the agent
/// only quoted the words.
fn asked(screen: &str, is_question: impl Fn(&str) -> bool) -> Option<String> {
    let lines: Vec<&str> = screen.lines().map(|l| l.trim_matches(|c: char| c.is_whitespace() || "\u{2502}\u{2503}|".contains(c))).collect();
    let at = lines.iter().rposition(|l| is_question(l))?;
    let answers = lines[at..].iter().take(40).position(|l| l.trim_start_matches(['\u{203a}', '\u{276f}', '>', ' ']).starts_with("1."))?;
    let text = lines[at..at + answers].iter().filter(|l| !l.is_empty()).copied().collect::<Vec<_>>().join(" ");
    Some(text.chars().filter(|c| !c.is_control()).take(300).collect())
}

/// The event name Codex's own hooks report under (`--harness-hook`); which
/// hook it was is in the payload's `hook_event_name`.
pub const CODEX_HOOK: &str = "codex-hook";

/// The Codex hooks the harness asks for (Unix launches only, like `own_hooks`).
#[cfg_attr(windows, allow(dead_code))]
pub const CODEX_HOOKS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse"];

pub struct Claude;
pub struct Codex;
pub struct Shell;

/// Claude Code's empty input box at the bottom of the screen, as recorded on
/// 2026-11-19 from three idle sessions: a rule, the prompt mark alone on its
/// line, a rule, then the mode line. The upper rule may carry the session's
/// name before its last dash; that name is text a session chooses, so it
/// neither makes nor breaks the match. A menu draws no such box, and where
/// it marks its choice with the same mark ("❯ 1. Yes") the last line that
/// starts with the mark is not the mark alone. Output above that only draws
/// a box does not count: the box must be the last thing but two lines.
fn claude_input_box(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
    let Some(last) = lines.iter().rposition(|l| !l.is_empty()) else { return false };
    let lines = &lines[..=last];
    let Some(at) = lines.iter().rposition(|l| l.trim_start().starts_with('\u{276f}')) else { return false };
    let rule = |l: &str| l.chars().count() >= 20 && l.chars().all(|c| c == '\u{2500}');
    let named_rule = |l: &str| l.starts_with("\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}") && l.ends_with('\u{2500}') && l.chars().count() >= 20;
    lines[at] == "\u{276f}" && at >= 1 && named_rule(lines[at - 1]) && lines.get(at + 1).is_some_and(|l| rule(l)) && lines.len() - (at + 2) <= 2
}

impl Adapter for Claude {
    fn profile(&self) -> Profile {
        Profile { id: "claude", label: "Claude Code", command: "claude --permission-mode acceptEdits", optional: false, can_supervise: true, task_tracking: true }
    }
    fn input_box(&self, screen: &str) -> bool {
        claude_input_box(screen)
    }
    /// The prompt mark alone between the rules is an empty box
    fn empty_input_box(&self, screen: &str) -> bool {
        claude_input_box(screen)
    }
    fn shows_empty_input_box(&self) -> bool {
        true
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let mut cmd = if l.agent.is_some() || l.auto_root.is_some() {
            format!("exec {} {}", base.split(' ').next().unwrap_or(base), self.launch_words(l).iter().map(|w| sh(w)).collect::<Vec<_>>().join(" "))
        } else {
            format!("exec {base}")
        };
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
    fn asks_before_terminal_write(&self) -> bool {
        true
    }
    fn reports_from_start(&self) -> bool {
        true
    }
    fn question(&self, screen: &str) -> Option<String> {
        const TRUST: &str = "Is this a project you created or one you trust?";
        asked(screen, |l| l.starts_with("Do you want to") || l.starts_with("Do you trust") || l.contains(TRUST)).or_else(|| {
            // The folder question at start, whose answers are not numbered in every version
            (screen.contains(TRUST) && screen.contains("Yes, I trust this folder")).then(|| TRUST.to_string())
        })
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
    /// `--model`, `--fallback-model`, `--effort`, `--permission-mode`,
    /// `--tools` and `--disallowedTools` (Claude Code 2.1.330). Profile
    /// authors cannot supply `--allowedTools`: it skips the operator's prompt.
    /// The launcher supplies allow rules for delivery leads (MCR-143) and
    /// auto-mode roots (MCR-152).
    fn expresses(&self) -> Expresses {
        Expresses {
            model: true,
            fallback_model: true,
            efforts: &["low", "medium", "high", "xhigh", "max"],
            modes: &["plan", "manual", "acceptEdits", "auto"],
            tools: true,
        }
    }
    fn profile_words(&self, p: &crate::profiles::AgentProfile) -> Result<Vec<String>, String> {
        Ok(self.profile_launch_words(p, p.permissions.mode.as_deref().unwrap_or("acceptEdits")))
    }
    fn takes_mcp(&self) -> bool {
        true
    }
}

impl Claude {
    /// The mode first, in place of the bare `--permission-mode acceptEdits`.
    /// The tool lists are variadic flags: each rule is a word of its own, and
    /// the harness's own flags (`--settings` always) follow them, so nothing
    /// after a list is taken as a rule. A rule never starts with `-`
    fn profile_launch_words(&self, p: &crate::profiles::AgentProfile, mode: &str) -> Vec<String> {
        let mut w = vec!["--permission-mode".into(), mode.into()];
        let i = &p.inference;
        for (flag, value) in [("--model", &i.model), ("--fallback-model", &i.fallback_model), ("--effort", &i.effort)] {
            if let Some(v) = value {
                w.extend([flag.to_string(), v.clone()]);
            }
        }
        if let Some(only) = &p.tools.only {
            w.push("--tools".into());
            if only.is_empty() {
                w.push(String::new());
            }
            w.extend(only.iter().cloned());
        }
        let delivers = p.delivers();
        if delivers || !p.tools.deny.is_empty() {
            w.push("--disallowedTools".into());
            w.extend(p.tools.deny.iter().cloned());
            if delivers {
                // Protect the pre-approved commands even with an older pinned profile.
                for rule in [
                    "Bash(gh pr merge --admin*)",
                    "Bash(gh pr merge * --admin*)",
                    "Bash(gh pr merge -F*)",
                    "Bash(gh pr merge * -F*)",
                    "Bash(gh pr merge --body-file*)",
                    "Bash(gh pr merge * --body-file*)",
                    "Bash(git push --receive-pack*)",
                    "Bash(git push * --receive-pack*)",
                    "Bash(git push --exec*)",
                    "Bash(git push * --exec*)",
                    // Git accepts unique long-option prefixes. Keep --end-of-options usable.
                    "Bash(git push --rece*)",
                    "Bash(git push * --rece*)",
                    "Bash(git push --ex*)",
                    "Bash(git push * --ex*)",
                    "Bash(git push --e=*)",
                    "Bash(git push * --e=*)",
                    "Bash(git push --e *)",
                    "Bash(git push * --e *)",
                    // An explicit ext destination names a command when the transport is enabled.
                    // End in two wildcards so Claude keeps both literal colons
                    // instead of treating the last colon and star as `:*`.
                    "Bash(git push ext::**)",
                    "Bash(git push * ext::**)",
                    "Bash(git push --repo=ext::**)",
                    "Bash(git push * --repo=ext::**)",
                    "Bash(git push --rep=ext::**)",
                    "Bash(git push * --rep=ext::**)",
                ] {
                    if !p.tools.deny.iter().any(|deny| deny == rule) {
                        w.push(rule.into());
                    }
                }
            }
        }
        if delivers {
            // The merge wildcard follows the end of option parsing. It can
            // supply a PR selector but cannot supply a flag to gh.
            w.extend(["--allowedTools", "Bash(git push origin *)", "Bash(gh pr merge --merge -- *)"].map(String::from));
        }
        w
    }

    fn launch_words(&self, l: &Launch) -> Vec<String> {
        let mode = l.claude_mode();
        let mut words = match l.agent {
            Some(p) => self.profile_launch_words(p, mode),
            None => vec!["--permission-mode".into(), mode.into()],
        };
        if l.claude_uses_auto() {
            if !l.agent.is_some_and(crate::profiles::AgentProfile::delivers) {
                words.push("--allowedTools".into());
            }
            words.extend(["mcp__teob-memory", "mcp__teob-harness", "mcp__mcr-memory", "mcp__atlassian"].map(String::from));
        }
        words
    }
}

impl Adapter for Codex {
    fn profile(&self) -> Profile {
        Profile { id: "codex", label: "Codex", command: "codex --sandbox workspace-write --ask-for-approval on-request", optional: false, can_supervise: true, task_tracking: true }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let (head, flags) = base.split_once(' ').unwrap_or((base, ""));
        let worded;
        let flags = if l.agent.is_some() || l.codex_sockets_on(std::env::consts::OS) || l.sockets_refused.is_some() {
            worded = self.sandbox_words(l, std::env::consts::OS)?.iter().map(|w| sh(w)).collect::<Vec<_>>().join(" ");
            worded.as_str()
        } else {
            flags
        };
        let notify = format!("notify={}", json!([l.exe, "--harness-hook", "codex-notify"]));
        // The harness tools and the memory server, for this launch only (values are TOML; a JSON string is one)
        let memory = crate::memory::SERVER;
        let tools = format!(
            "-c {} -c {} -c {} -c {}",
            sh(&format!("mcp_servers.{AGENT_SERVER}.command={}", json!(l.exe))),
            sh(&format!("mcp_servers.{AGENT_SERVER}.args=[\"--harness-mcp\"]")),
            sh(&format!("mcp_servers.{memory}.command={}", json!(l.exe))),
            sh(&format!("mcp_servers.{memory}.args=[\"--memory-mcp\"]"))
        );
        let mut cmd = format!("exec {head}");
        if l.resume.is_some() {
            cmd += " resume";
        }
        cmd += &format!(" {flags} -c {} -c tui.notifications=true {tools}", sh(&notify));
        // Codex's own hooks (MCR-74). Codex runs them only after the person
        // trusted them in Codex; until then it asks at start, so they are
        // passed only when the person turned them on. No Stop hook: the turn
        // end stays with `notify`, which needs no trust, and must not be
        // reported twice. The trust bypass flag is never passed
        if l.own_hooks {
            let command = json!(format!("{} --harness-hook {CODEX_HOOK}", sh(l.exe)));
            for event in CODEX_HOOKS {
                cmd += &format!(" -c {}", sh(&format!("hooks.{event}=[{{hooks=[{{type=\"command\",command={command},timeout=5}}]}}]")));
            }
        }
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
    /// As for a task. Codex shows a suggestion in an empty box, so the line
    /// after the mark proves nothing about emptiness: that is the app's witness
    fn input_box(&self, screen: &str) -> bool {
        self.at_prompt(screen)
    }
    fn sees_prompt(&self) -> bool {
        true
    }
    /// Codex sets "[ ! ] Action Required" as the title while it waits for an answer
    /// (after a glyph that blinks, before the folder). Nothing else: a
    /// conversation may be titled with these words and more
    fn title_asks(&self, title: &str) -> Option<bool> {
        Some(title.trim_start_matches(|c: char| !c.is_alphanumeric()).split(" | ").next().unwrap_or("").trim() == "Action Required")
    }
    /// The wording of codex-cli 0.170; a turn's last message is announced the
    /// same way and may hold any word
    fn announces_approval(&self, body: &str) -> bool {
        body.starts_with("Approval requested")
    }
    fn question(&self, screen: &str) -> Option<String> {
        asked(screen, |l| l.starts_with("Would you like to") || l.ends_with("needs your approval.") || l.starts_with("Do you trust") || l.starts_with("Trust this folder?") || l.starts_with("Hooks need review")).or_else(|| {
            // The folder question at start (0.170 wording), whose answers may not be numbered
            if self.at_prompt(screen) {
                return None;
            }
            // Codex's review of hooks it has not run before, ours among them (MCR-74)
            if screen.contains("Hooks need review") && screen.contains("Trust all and continue") {
                return Some("Hooks need review: Codex asks whether to trust the hooks it was started with".into());
            }
            let trust = screen.lines().map(str::trim).find(|l| l.starts_with("Trust this folder?"))?;
            Some(trust.chars().filter(|c| !c.is_control()).take(300).collect())
        })
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
    /// `-m`, `-c model_reasoning_effort` and `-s` with `-a on-request`
    /// (codex-cli 0.170; the effort key is still to verify live). No
    /// fallback model and no tool lists: Codex has no flag for them
    fn expresses(&self) -> Expresses {
        Expresses { model: true, fallback_model: false, efforts: &["low", "medium", "high"], modes: &["read-only", "workspace-write"], tools: false }
    }
    /// The sandbox with `on-request` in place of the bare pair, then `-m` and
    /// the effort as a TOML literal (`model_reasoning_effort` is a config key
    /// of codex-cli 0.170, and the operator's own config.toml sets it): one
    /// word without `"` or `%`, so it is the same on Windows
    ///
    /// Delivery keeps `on-request` (MCR-143). Codex's `prefix_rule` allows
    /// commands outside the sandbox through shared config layers. The
    /// harness's `PermissionRequest` hook reports the prompt. Only the
    /// operator decides it (D6 in docs/AGENT_HARNESS_DESIGN.md).
    fn profile_words(&self, p: &crate::profiles::AgentProfile) -> Result<Vec<String>, String> {
        if p.inference.fallback_model.is_some() || !p.tools.deny.is_empty() || p.tools.only.is_some() {
            return Err("codex takes no fallback model and no tool lists".into());
        }
        let mode = p.permissions.mode.clone().unwrap_or_else(|| "workspace-write".into());
        let mut w: Vec<String> = vec!["--sandbox".into(), mode, "--ask-for-approval".into(), "on-request".into()];
        if let Some(m) = &p.inference.model {
            w.extend(["-m".into(), m.clone()]);
        }
        if let Some(e) = &p.inference.effort {
            w.extend(["-c".into(), format!("model_reasoning_effort='{e}'")]);
        }
        Ok(w)
    }
    fn takes_mcp(&self) -> bool {
        true
    }
}

/// What `effectiveMode` says of the fallback's network: checked under Codex
/// in the same deadline, or left to Codex's managed policy, as for any
/// plain line (review 17287 P1)
pub const CODEX_OFF_CHECKED: &str = "network off (checked)";
pub const CODEX_OFF_UNCHECKED: &str = "network not checked: Codex's managed policy applies";

/// What a refused check adds after `--sandbox workspace-write` (MCR-162)
pub const CODEX_NETWORK_OFF: [&str; 2] = ["-c", "sandbox_workspace_write.network_access=false"];

/// The bare Codex line's sandbox and approvals (its `Profile.command` after the program)
const CODEX_BARE: [&str; 4] = ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];

impl Codex {
    /// The sandbox and approval words of a launch: the profile's, or the bare
    /// line's. Under an auto-mode root on `CODEX_SOCKETS_OS` the socket
    /// profile takes the place of `--sandbox workspace-write` (MCR-162);
    /// `--ask-for-approval on-request` and everything else stay
    fn sandbox_words(&self, l: &Launch, os: &str) -> Result<Vec<String>, String> {
        let mut words = match l.agent {
            Some(p) => self.profile_words(p)?,
            None => CODEX_BARE.map(str::to_owned).to_vec(),
        };
        let at = words.windows(2).position(|w| w[0] == "--sandbox" && w[1] == "workspace-write");
        if l.codex_sockets_on(os) {
            let at = at.ok_or("The Codex line has no workspace-write sandbox to give Unix sockets")?;
            words.splice(at..at + 2, codex_socket_words(l.codex_ports));
        } else if let (Some(at), Some(_), Some(_)) = (at, l.auto_root, l.sockets_refused) {
            // The check refused: workspace-write with its network off, whatever
            // `[sandbox_workspace_write].network_access` a config layer says
            // (review 17282 P1)
            words.splice(at + 2..at + 2, CODEX_NETWORK_OFF.map(str::to_owned));
        }
        one_sandbox(&words)?;
        Ok(words)
    }
}

/// Codex ignores `default_permissions` without a word when a `--sandbox` is
/// given too, and the session would run without the profile the harness
/// reports: the two never go together on a line the harness builds
fn one_sandbox(words: &[String]) -> Result<(), String> {
    if words.iter().any(|w| w == "--sandbox" || w.starts_with("--sandbox=")) && words.iter().any(|w| w.starts_with("default_permissions=")) {
        return Err("The Codex line has both --sandbox and a permission profile".into());
    }
    Ok(())
}

/// Codex's workspace-write with Unix sockets in one folder (MCR-162;
/// codex-cli 0.172).
///
/// A command-line `--sandbox` wins over `default_permissions`, which is then
/// ignored without a word, so it is left out: `default_permissions` names a
/// permission profile defined here. Its filesystem is workspace-write's as
/// Codex renders it (read everywhere; write the folder, `/tmp` and `$TMPDIR`;
/// the folder's `.git`, `.codex`, `.agents` and `.aws` read-only): the
/// built-in `:workspace` leaves `.git` and `.codex` writable.
///
/// Seatbelt passes a profile's Unix sockets only with its network on and
/// Codex's managed proxy running (the `network_proxy` feature, still
/// experimental in 0.172; `--enable` fails at start on a name Codex does not
/// know). The proxy has no allowed domain, so anything outside goes to the
/// operator as before. Without the proxy, `network.enabled` would be the
/// whole network and every Unix socket, which is why the harness runs
/// `codex_sockets::check` before every such launch and falls back to plain
/// workspace-write when it fails.
///
/// TCP listening (`ports`) only while the macOS firewall is on: Seatbelt's
/// `network-bind (local ip "*:*")` is the only grant there is, and a
/// listener on `0.0.0.0` answered a connection to the Mac's en0 address
/// (review 17269 P2, measured 25 Nov); the owner accepts that with the
/// firewall as the mitigation (17284). Without it, `allow_local_binding` is
/// false. Both ways it is set here, with the two `dangerously_*` switches
/// false, so a lower config layer cannot set them for this profile.
pub fn codex_socket_words(ports: bool) -> Vec<String> {
    let p = CODEX_SOCKET_PROFILE;
    [
        "--enable".to_owned(),
        "network_proxy".to_owned(),
        "-c".to_owned(),
        format!("default_permissions=\"{p}\""),
        "-c".to_owned(),
        format!(
            "permissions.{p}.filesystem={{\":root\"=\"read\", \":project_roots\"={{\".\"=\"write\", \".git\"=\"read\", \".codex\"=\"read\", \".agents\"=\"read\", \".aws\"=\"read\"}}, \":slash_tmp\"=\"write\", \":tmpdir\"=\"write\"}}"
        ),
        "-c".to_owned(),
        format!("permissions.{p}.network.enabled=true"),
        "-c".to_owned(),
        format!("permissions.{p}.network.allow_local_binding={ports}"),
        "-c".to_owned(),
        format!("permissions.{p}.network.dangerously_allow_all_unix_sockets=false"),
        "-c".to_owned(),
        format!("permissions.{p}.network.dangerously_allow_non_loopback_proxy=false"),
        "-c".to_owned(),
        format!("permissions.{p}.network.unix_sockets={{\"{CODEX_SOCKETS}\"=\"allow\"}}"),
    ]
    .to_vec()
}

impl Adapter for Shell {
    fn profile(&self) -> Profile {
        Profile { id: "shell", label: "Terminal", command: "", optional: false, can_supervise: false, task_tracking: false }
    }
    fn is_plain_terminal(&self) -> bool {
        true
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

/// Whether a session of this profile is a plain terminal (`is_plain_terminal`).
/// Only for a profile this build knows: an unknown one is a shell elsewhere,
/// but it may be an agent a later build added, so here it is not.
pub fn plain_terminal(profile: &str) -> bool {
    adapters().find(|a| a.id() == profile).is_some_and(|a| a.is_plain_terminal())
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
    profile_fits(agent, l)?;
    let task = l.task.map(str::trim).filter(|t| !t.is_empty());
    agent.command_line(agent.profile().command, &Launch { task, ..*l })
}

/// A profile is launched only by its own adapter and only as the checks
/// allow it now: a pinned copy is checked again by this build's ceiling.
/// Bare launches have no agent profile to check.
fn profile_fits(agent: &dyn Adapter, l: &Launch) -> Result<(), String> {
    let Some(p) = l.agent else { return Ok(()) };
    if p.adapter != agent.id() {
        return Err(format!("The profile {} is for {}, not {}", p.id, p.adapter, agent.id()));
    }
    crate::profiles::check(p, crate::profiles::Origin::Operator)?;
    if l.supervisor != (p.role == crate::profiles::Role::Supervisor) {
        return Err("A supervisor profile starts the root Supervisor only, and the root Supervisor only a supervisor profile".into());
    }
    Ok(())
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
    profile_fits(agent, l)?;
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
            args.push("claude".into());
            args.extend(Claude.launch_words(l));
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
            // The Windows sandbox is not Seatbelt and its managed network is
            // not verified: under a root it keeps plain workspace-write (MCR-162)
            args.extend(Codex.sandbox_words(l, "windows")?);
            let exe_lit = toml_literal(l.exe)?;
            args.extend(["-c".into(), format!("notify=[{exe_lit},'--harness-hook','codex-notify']")]);
            args.extend(["-c".into(), "tui.notifications=true".into()]);
            args.extend(["-c".into(), format!("mcp_servers.{AGENT_SERVER}.command={exe_lit}")]);
            args.extend(["-c".into(), format!("mcp_servers.{AGENT_SERVER}.args=['--harness-mcp']")]);
            // The memory server, as on the other systems: a program and one flag, no credential
            let memory = crate::memory::SERVER;
            args.extend(["-c".into(), format!("mcp_servers.{memory}.command={exe_lit}")]);
            args.extend(["-c".into(), format!("mcp_servers.{memory}.args=['--memory-mcp']")]);
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
    fn claudes_input_box_is_proved_by_its_frame_at_the_bottom_and_by_nothing_else() {
        let rule = "\u{2500}".repeat(80);
        let named = |name: &str| format!("{} {name} \u{2500}", "\u{2500}".repeat(76 - name.chars().count()));
        let mode = "  \u{23f5}\u{23f5} auto mode on (shift+tab to cycle)";
        let idle = |upper: &str| format!("(text)\n\u{273b} Brewed for 34s \u{b7} done 4:37 PM\n\n                                        \u{2714} Update installed \u{b7} /restart to apply\n{upper}\n\u{276f}\n{rule}\n{mode}\n");
        // As recorded from three idle sessions on 2026-11-19: with and without a name in the upper rule
        for upper in [rule.clone(), named("EVSE fix"), named("TEOB Rust Workspace")] {
            assert!(claude_input_box(&idle(&upper)), "{upper}");
            assert!(Claude.input_box(&idle(&upper)));
        }
        // A name a session chose cannot make a box where there is none, or hide one
        assert!(claude_input_box(&idle(&named("\u{276f} 1. Yes"))));
        // Text in the box, or a suggestion drawn in it: not an empty box
        assert!(!claude_input_box(&idle(&rule).replace("\n\u{276f}\n", "\n\u{276f} half a line\n")));
        // A menu: its choice carries the same mark
        let menu = format!("(text)\n{rule}\n Bash command\n   cargo test\n Do you want to proceed?\n \u{276f} 1. Yes\n   2. No\n\n Esc to cancel\n");
        assert!(!claude_input_box(&menu));
        // Output that draws a box, with a menu under it
        assert!(!claude_input_box(&format!("{rule}\n\u{276f}\n{rule}\n{menu}")));
        // Output that draws a box, with more than the mode line under it
        assert!(!claude_input_box(&format!("{rule}\n\u{276f}\n{rule}\n one\n two\n three\n")));
        // No rules, a short rule, another mark, nothing
        assert!(!claude_input_box("\u{276f}\n"));
        assert!(!claude_input_box(&format!("{}\n\u{276f}\n{}\n", "\u{2500}".repeat(5), "\u{2500}".repeat(5))));
        assert!(!claude_input_box(&idle(&rule).replace('\u{276f}', ">")));
        assert!(!claude_input_box(""));
        // Other programs: Codex by its own marks, a shell never
        assert!(Codex.input_box("\u{203a} Ask Codex to do anything\n\n  ? for shortcuts\n") && !Codex.input_box(&idle(&rule)));
        assert!(!Shell.input_box(&idle(&rule)) && !adapter("agy").input_box(&idle(&rule)));
    }

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
    }

    #[test]
    fn a_prompt_is_recognised_from_the_title_and_the_screen() {
        let codex = adapter("codex");
        assert_eq!(codex.title_asks("[ ! ] Action Required | teob-ai"), Some(true));
        assert_eq!(codex.title_asks("[ . ] Action Required | teob-ai"), Some(true));
        // As recorded on 2026-11-18: the conversation's title stands between the words and the folder
        assert_eq!(codex.title_asks("[ ! ] Action Required | Run ls and touch probe.txt | folder"), Some(true));
        assert_eq!(codex.title_asks("\u{280f} Run ls and touch probe.txt | folder"), Some(false));
        assert_eq!(codex.title_asks("\u{2807} Memory answer grounding | teob-ai"), Some(false));
        // A conversation's own title may hold the words
        assert_eq!(codex.title_asks("Action Required review | teob-ai"), Some(false));
        assert_eq!(codex.title_asks("Review of Action Required"), Some(false));
        assert_eq!(codex.title_asks("Action Required"), Some(true));
        // What Codex announces to its terminal: an approval by its form, never by a word in a last message
        assert!(codex.announces_approval("Approval requested: git push") && codex.announces_approval("Approval requested by reviewer"));
        assert!(!codex.announces_approval("Done. The change is approved and merged.") && !codex.announces_approval("Agent turn complete"));
        assert!(adapter("antigravity").announces_approval("Needs your approval"));
        // Claude Code's title says nothing about prompts: its hooks do
        assert_eq!(adapter("claude").title_asks("\u{2733} Action Required"), None);
        assert_eq!(adapter("shell").title_asks("Action Required"), None);

        let screen = "\u{2022} I will rebase first.\n\n  Would you like to run the following command?\n\n  Reason: the branch is behind\n\n  $ git rebase origin/main\n\n\u{203a} 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `git rebase` (p)\n  3. No, and tell Codex what to do differently (esc)\n";
        assert_eq!(codex.question(screen).as_deref(), Some("Would you like to run the following command? Reason: the branch is behind $ git rebase origin/main"));
        // Words the agent only quoted, with no answers under them, are not a prompt
        assert_eq!(codex.question("\u{2022} Earlier I asked: Would you like to run the following command?\n\n\u{203a} Explain this codebase\n\n  ? for shortcuts"), None);
        assert_eq!(codex.question("  Would you like to run the following command?\n  $ ls\n"), None);
        assert_eq!(codex.question("\u{203a} Explain this codebase\n\n  ? for shortcuts"), None);
        // The folder question at start, in the newer and the older wording
        assert_eq!(codex.question("  Trust this folder? Codex can read, edit, and run files here.\n\n  Yes, continue\n  No, quit\n").as_deref(), Some("Trust this folder? Codex can read, edit, and run files here."));
        assert_eq!(codex.question("Do you trust the contents of this directory?\n\n\u{203a} 1. Yes, continue\n  2. No, quit").as_deref(), Some("Do you trust the contents of this directory?"));
        // As seen on 2026-11-18 (codex-cli 0.170): numbered answers
        assert_eq!(codex.question("  Trust this folder? Codex can read, edit, and run files here.\n\n\u{203a} 1. Trust and continue\n  2. Back to Agent Command Center\n").as_deref(), Some("Trust this folder? Codex can read, edit, and run files here."));
        assert_eq!(codex.question("\u{2022} Trust this folder? was asked before\n\u{203a} Explain this codebase\n\n  ? for shortcuts"), None);
        // Codex's own review of hooks, as recorded on 2026-11-18 (it does not set the title)
        let review = "  Hooks need review\n  4 hooks are new or changed.\n  Hooks can run outside the sandbox after you trust them.\n\n\u{203a} 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n";
        assert_eq!(codex.question(review).as_deref(), Some("Hooks need review 4 hooks are new or changed. Hooks can run outside the sandbox after you trust them."));
        // Long commands are cut, and control characters never get into a notice
        let long = format!("Would you like to run the following command?\n$ echo {}\u{7}\n1. Yes, proceed (y)", "x".repeat(600));
        let text = codex.question(&long).unwrap();
        assert!(text.chars().count() == 300 && !text.contains('\u{7}'));

        let claude = adapter("claude");
        let trust = "\u{256d}\u{2500}\u{2500}\u{256e}\n\u{2502} Do you trust the files in this folder?   \u{2502}\n\u{2502} /Users/x/work                            \u{2502}\n\u{2502} \u{276f} 1. Yes, proceed                        \u{2502}\n\u{2502}   2. No, exit                            \u{2502}\n";
        assert_eq!(claude.question(trust).as_deref(), Some("Do you trust the files in this folder? /Users/x/work"));
        let edit = "Do you want to make this edit to main.rs?\n\u{276f} 1. Yes\n  2. Yes, allow all edits during this session\n  3. No";
        assert_eq!(claude.question(edit).as_deref(), Some("Do you want to make this edit to main.rs?"));
        assert_eq!(claude.question("> Do you want to know more?\n"), None);
        // The folder question at start as seen on 2026-11-18, with and without numbers
        let safety = "Quick safety check: Is this a project you created or one you trust?\n\n/Users/x/work\n\n\u{276f} 1. Yes, I trust this folder\n  2. No, exit\n";
        assert_eq!(claude.question(safety).as_deref(), Some("Quick safety check: Is this a project you created or one you trust? /Users/x/work"));
        assert_eq!(claude.question("Quick safety check: Is this a project you created or one you trust?\n\n  No, exit\n\u{276f} Yes, I trust this folder\n").as_deref(), Some("Is this a project you created or one you trust?"));
        assert_eq!(claude.question("\u{23fa} I asked: Is this a project you created or one you trust?\n"), None);
        assert_eq!(adapter("shell").question(screen), None);
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
        // Only the shell is a plain terminal: every agent, with state tracking or without, is a screen
        // with an input box, and a profile this build does not know may be one (MCR-115)
        assert_eq!(profiles().iter().filter(|p| plain_terminal(p.id)).map(|p| p.id).collect::<Vec<_>>(), ["shell"]);
        assert!(!plain_terminal("an-agent-of-a-later-build") && !plain_terminal(""));
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
        // The memory server comes with a Windows launch too
        assert!(codex.contains(&"mcp_servers.mcr-memory.command='C:\\Program Files\\Agent MCR\\agent-mcr.exe'".to_string()));
        assert!(codex.contains(&"mcp_servers.mcr-memory.args=['--memory-mcp']".to_string()));
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

    /// The words of a Unix command line, as the shell would split it (only
    /// the quoting `sh` writes: single quotes and `'\''`)
    fn shell_words(line: &str) -> Vec<String> {
        let (mut words, mut word, mut quoted, mut any, mut escaped) = (Vec::new(), String::new(), false, false, false);
        for c in line.chars() {
            if escaped {
                word.push(c);
                escaped = false;
                continue;
            }
            match c {
                '\'' => {
                    quoted = !quoted;
                    any = true;
                }
                '\\' if !quoted => {
                    escaped = true;
                    any = true;
                }
                ' ' if !quoted => {
                    if any || !word.is_empty() {
                        words.push(std::mem::take(&mut word));
                    }
                    any = false;
                }
                c => word.push(c),
            }
        }
        if any || !word.is_empty() {
            words.push(word);
        }
        words
    }

    /// Flags and values forbidden in profile input (16647 M1)
    fn refused_words(words: &[String]) -> Vec<String> {
        const REFUSED: [&str; 17] = [
            "--allowedTools", "--allowed-tools", "--agents", "--add-dir", "--dangerously-skip-permissions", "bypassPermissions", "dontAsk",
            "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "-p", "--profile",
            "danger-full-access", "never", "--strict-mcp-config", "--yolo", "--full-auto",
        ];
        let mut bad: Vec<String> = words.iter().filter(|w| REFUSED.contains(&w.as_str()) || w.contains("approval_policy") || w.contains("sandbox_mode")).cloned().collect();
        if words.iter().filter(|w| *w == "--settings").count() > 1 {
            bad.push("a second --settings".into());
        }
        bad
    }

    fn full_claude() -> crate::profiles::AgentProfile {
        crate::profiles::parse(
            "id = \"custom@all\"\nversion = 2\nrole = \"custom\"\nadapter = \"claude\"\n[inference]\nmodel = \"opus[1m]\"\nfallback_model = \"sonnet\"\neffort = \"max\"\n[permissions]\nmode = \"manual\"\n[tools]\ndeny = [\"Bash(git push:*)\", \"Bash(gh pr merge:*)\", \"Edit\", \"mcp__x__y\", \"Bash(echo $HOME; rm -rf *)\"]\nonly = [\"Bash\", \"Read\"]\n",
            crate::profiles::Origin::Operator,
        )
        .unwrap()
    }

    #[test]
    fn profiles_reach_both_launch_paths_through_the_mapping_only() {
        use crate::profiles::{choose, lower_of, Push};

        let id = "11111111-2222-3333-4444-555555555555";
        let config = Path::new("/nonexistent-config-dir");
        let loaded = crate::profiles::load(config);
        let full = full_claude();
        let codex_full = crate::profiles::parse("id = \"custom@cx\"\nversion = 1\nrole = \"custom\"\nadapter = \"codex\"\n[inference]\nmodel = \"gpt-6.1-sol\"\neffort = \"low\"\n[permissions]\nmode = \"read-only\"\n", crate::profiles::Origin::Operator).unwrap();
        let lead = choose(config, "lead@claude-opus").unwrap();
        let implementer = choose(config, "implementer@claude-opus").unwrap();
        let (lowered_lead, _) = lower_of(&lead, &lead.profile).unwrap();
        let (lowered_implementer, _) = lower_of(&implementer, &lead.profile).unwrap();
        assert_eq!(lead.profile.permissions.push, Push::Delivery);
        assert_eq!(lowered_lead.profile.permissions.push, Push::None);
        assert_eq!(lowered_implementer.profile.permissions.push, Push::None);
        let mut all: Vec<&crate::profiles::AgentProfile> = loaded.profiles.iter().map(|e| &e.profile).collect();
        all.extend([&full, &codex_full, &lowered_lead.profile, &lowered_implementer.profile]);
        for p in all {
            let supervisor = p.role == crate::profiles::Role::Supervisor;
            for (resume, session) in [(None, Some(id)), (Some(id), None)] {
                let l = Launch { profile: &p.adapter, agent: Some(p), supervisor, exe: "/x/mcr", settings: "/cfg/claude-hooks.json", mcp: "/cfg/claude-mcp.json", plugin: "/cfg/claude-plugin", note: true, resume, agent_session: session, ..Default::default() };
                let unix = shell_words(&command_line(&l).unwrap());
                let win = windows_args(&l).unwrap();
                assert!(cmd_line(&win).is_ok(), "{}", p.id);
                for words in [&unix[1..], &win[..]] {
                    let refused = refused_words(words);
                    if p.adapter == "claude" && p.delivers() {
                        assert_eq!(refused, ["--allowedTools"], "{}", p.id);
                        let at = words.iter().position(|w| w == "--allowedTools").unwrap();
                        assert_eq!(&words[at + 1..at + 3], ["Bash(git push origin *)", "Bash(gh pr merge --merge -- *)"]);
                        assert_eq!(words[at + 3], "--mcp-config");
                    } else {
                        assert!(refused.is_empty(), "{}: {refused:?}", p.id);
                    }
                    let mode = p.permissions.mode.as_deref().unwrap();
                    let flag = if p.adapter == "claude" { "--permission-mode" } else { "--sandbox" };
                    assert_eq!(words.iter().filter(|w| *w == flag).count(), 1, "{}", p.id);
                    assert_eq!(words[words.iter().position(|w| w == flag).unwrap() + 1], mode, "{}", p.id);
                    if let Some(m) = &p.inference.model {
                        let flag = if p.adapter == "claude" { "--model" } else { "-m" };
                        assert_eq!(words[words.iter().position(|w| w == flag).unwrap() + 1], *m);
                    }
                    if let Some(e) = &p.inference.effort {
                        assert!(words.iter().any(|w| *w == *e || *w == format!("model_reasoning_effort='{e}'")), "{}", p.id);
                    }
                    // Each deny rule is one word, right after the flag and before the harness's own flags
                    if !p.tools.deny.is_empty() {
                        let at = words.iter().position(|w| w == "--disallowedTools").unwrap();
                        let end = at + 1 + p.tools.deny.len();
                        assert_eq!(&words[at + 1..end], &p.tools.deny[..]);
                        if p.adapter == "claude" && p.delivers() {
                            let allow = words.iter().position(|w| w == "--allowedTools").unwrap();
                            let added_denies = &words[end..allow];
                            for (command, arguments) in [
                                ("gh pr merge", &["--admin", "-F", "--body-file"][..]),
                                ("git push", &["--receive-pack", "--exec", "--rece", "--ex", "--e=", "--e ", "ext::*", "--repo=ext::*", "--rep=ext::*"][..]),
                            ] {
                                for argument in arguments {
                                    for position in ["", "* "] {
                                        let rule = format!("Bash({command} {position}{argument}*)");
                                        assert!(added_denies.contains(&rule), "{} missing {rule}", p.id);
                                    }
                                }
                            }
                        } else {
                            assert!(words[end].starts_with("--"));
                        }
                    }
                    if p.adapter == "codex" {
                        assert_eq!(words[words.iter().position(|w| w == "--ask-for-approval").unwrap() + 1], "on-request");
                    }
                }
                // The Unix line runs the program first, the profile's words next
                assert_eq!(unix[0], "exec");
                assert_eq!(unix[1], p.adapter);
            }
        }
        // A bare launch is today's line
        let bare = command_line(&Launch { profile: "claude", settings: "/s", ..Default::default() }).unwrap();
        assert!(bare.starts_with("exec claude --permission-mode acceptEdits --settings"));
        assert_eq!(&windows_args(&Launch { profile: "codex", exe: "/x", ..Default::default() }).unwrap()[1..5], ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
    }

    #[test]
    fn a_profile_the_ceiling_or_its_adapter_refuses_starts_nothing() {
        let full = full_claude();
        let check = |p: &crate::profiles::AgentProfile, profile: &str, supervisor: bool| {
            let l = Launch { profile, agent: Some(p), supervisor, exe: "/x", settings: "/s", ..Default::default() };
            (command_line(&l).unwrap_err(), windows_args(&l).unwrap_err())
        };
        // Built from code, past the parser: the launch checks again
        for mode in ["bypassPermissions", "dontAsk", "auto", "default"] {
            let mut p = full.clone();
            p.permissions.mode = Some(mode.into());
            check(&p, "claude", false);
        }
        let mut p = full.clone();
        p.tools.deny.push("--dangerously-skip-permissions".into());
        check(&p, "claude", false);
        let mut p = full.clone();
        p.inference.model = Some("opus --dangerously-skip-permissions".into());
        check(&p, "claude", false);
        // Another adapter's profile, and a profile for an adapter that takes no fields
        let (unix, _) = check(&full, "codex", false);
        assert!(unix.contains("is for claude"), "{unix}");
        let mut p = full.clone();
        p.adapter = "codex".into();
        check(&p, "codex", false);
        let loaded = crate::profiles::load(Path::new("/nonexistent-config-dir"));
        // A delivery lead cannot supply its own allow flag either
        let mut lead = loaded.get("lead@claude-opus").unwrap().profile.clone();
        for flag in ["--allowedTools", "--allowed-tools"] {
            lead.tools.only = Some(vec![flag.into()]);
            let (unix, windows) = check(&lead, "claude", false);
            assert!(unix.contains("tools.only") && windows.contains("tools.only"), "{flag}: {unix}, {windows}");
        }
        // The supervisor profile is for the root only, and the root takes no other
        check(&loaded.get("supervisor@claude-opus").unwrap().profile, "claude", false);
        check(&loaded.get("implementer@claude-opus").unwrap().profile, "claude", true);
    }

    /// MCR-162: under an auto-mode root, a Codex session in workspace-write
    /// gets the socket profile in place of `--sandbox workspace-write` on
    /// macOS, profile or bare, new or resumed, with ports only when the
    /// check found the firewall on; `on-request` stays. A refused check gives
    /// workspace-write with its network explicitly off (review 17282 P1).
    /// Read-only, outside a root and the Windows path keep today's words.
    #[test]
    fn codex_under_a_root_gets_unix_sockets_on_macos_only() {
        let loaded = crate::profiles::load(Path::new("/nonexistent-config-dir"));
        let implementer = loaded.get("implementer@codex").unwrap().profile.clone();
        let lead = loaded.get("lead@codex").unwrap().profile.clone();
        let validator = loaded.get("validator@codex").unwrap().profile.clone();
        let mut read_only = implementer.clone();
        read_only.permissions.mode = Some("read-only".into());
        let resume = "019a3c48-7d0e-7d61-b1f5-6a1f0c6d2b3e";
        for ports in [false, true] {
            let sockets = codex_socket_words(ports);
            assert_eq!(sockets[..4], ["--enable", "network_proxy", "-c", "default_permissions=\"agent-mcr-sockets\""]);
            let filesystem = &sockets[5];
            for rule in [r#"":root"="read""#, r#""."="write""#, r#"".git"="read""#, r#"".codex"="read""#, r#"".agents"="read""#, r#"":slash_tmp"="write""#, r#"":tmpdir"="write""#] {
                assert!(filesystem.contains(rule), "{filesystem}");
            }
            for word in ["network.enabled=true".to_owned(), format!("network.allow_local_binding={ports}"), "network.dangerously_allow_all_unix_sockets=false".into(), "network.dangerously_allow_non_loopback_proxy=false".into()] {
                assert!(sockets.contains(&format!("permissions.agent-mcr-sockets.{word}")), "{word}");
            }
            assert_eq!(sockets.last().unwrap(), &format!("permissions.agent-mcr-sockets.network.unix_sockets={{\"{CODEX_SOCKETS}\"=\"allow\"}}"));
            assert!(sockets.iter().all(|w| !w.contains("network_access") && !w.contains("domains") && !w.contains('\'') && !w.contains("--sandbox")));
            assert_eq!(sockets.iter().filter(|w| w.ends_with("=true")).count(), 1 + usize::from(ports));
            // The two never stand together on a line
            assert!(one_sandbox(&sockets).is_ok());
            let mut both = sockets.clone();
            both.extend(["--sandbox".to_owned(), "workspace-write".to_owned()]);
            assert!(one_sandbox(&both).unwrap_err().contains("both"));
            both.truncate(sockets.len());
            both.push("--sandbox=workspace-write".into());
            assert!(one_sandbox(&both).is_err());
        }
        #[cfg(unix)]
        assert_eq!(CODEX_SOCKETS, format!("/private{}", crate::ipc::TEST_SOCKETS));

        let refusal = "Codex's managed network proxy is not running";
        let firewall_off = "the macOS firewall is off";
        for agent in [None, Some(&implementer), Some(&lead), Some(&validator), Some(&read_only)] {
            let mode = agent.and_then(|p| p.permissions.mode.as_deref()).unwrap_or("workspace-write");
            for root in [None, Some("~/work")] {
                for (refused, ports, checked) in [(None, false, false), (None, true, false), (Some(refusal), false, true), (Some(refusal), false, false)] {
                    for resumed in [None, Some(resume)] {
                        let ports_refused = (refused.is_none() && !ports).then_some(firewall_off);
                        let l = Launch { profile: "codex", exe: "/x", agent, auto_root: root, sockets_refused: refused, codex_ports: ports, ports_refused, network_off_checked: checked, resume: resumed, ..Default::default() };
                        let eligible = root.is_some() && mode == "workspace-write";
                        let widened = eligible && refused.is_none();
                        let fallback = eligible && refused.is_some();
                        assert_eq!(l.codex_sockets(), widened);
                        // Whether the harness reads the roots and runs the check at all
                        assert_eq!(l.codex_could_take_sockets("macos"), mode == "workspace-write");
                        assert!(!l.codex_could_take_sockets("windows") && !l.codex_could_take_sockets("linux"));
                        // The words on each system
                        let mac = Codex.sandbox_words(&l, "macos").unwrap();
                        let linux = Codex.sandbox_words(&l, "linux").unwrap();
                        let windows = Codex.sandbox_words(&l, "windows").unwrap();
                        let plain = match agent {
                            Some(p) => Codex.profile_words(p).unwrap(),
                            None => CODEX_BARE.map(str::to_owned).to_vec(),
                        };
                        let mut off = plain.clone();
                        if fallback {
                            off.splice(2..2, CODEX_NETWORK_OFF.map(str::to_owned));
                        }
                        // A refusal is only ever set on macOS; the words would hold elsewhere too
                        assert_eq!(linux, off);
                        assert_eq!(windows, off);
                        if widened {
                            let mut expected = codex_socket_words(ports);
                            expected.extend(plain[2..].iter().cloned());
                            assert_eq!(mac, expected);
                            assert!(!mac.contains(&"--sandbox".to_owned()));
                        } else {
                            assert_eq!(mac, off);
                            assert!(!mac.iter().any(|w| w.contains("network_proxy") || w.contains("default_permissions")));
                        }
                        assert_eq!(mac.contains(&"sandbox_workspace_write.network_access=false".to_owned()), fallback);
                        assert_eq!(mac.windows(2).filter(|w| w[0] == "--ask-for-approval" && w[1] == "on-request").count(), 1);
                        // What each says of itself
                        let reason = match (root, agent) {
                            (Some(_), _) if widened && ports => "root ~/work, macOS firewall on at launch".to_owned(),
                            (Some(_), _) if widened => format!("root ~/work, no ports: {firewall_off}"),
                            (Some(_), _) if eligible && checked => format!("root ~/work, network off (checked), unix sockets refused: {refusal}"),
                            (Some(_), _) if eligible => format!("root ~/work, network not checked: Codex's managed policy applies, unix sockets refused: {refusal}"),
                            (Some(_), _) => "profile mode kept under root ~/work".to_owned(),
                            (None, Some(_)) => "profile".to_owned(),
                            (None, None) => "adapter default".to_owned(),
                        };
                        let on_mac = match (widened, ports) {
                            (true, true) => "workspace-write + unix sockets + ports".to_owned(),
                            (true, false) => "workspace-write + unix sockets".to_owned(),
                            _ => mode.to_owned(),
                        };
                        assert_eq!(l.effective_mode_on(&[], "macos").unwrap(), format!("{on_mac} ({reason})"));
                        let elsewhere = if widened { "root ~/work, unix sockets are passed on macos only".to_owned() } else { reason };
                        assert_eq!(l.effective_mode_on(&[], "windows").unwrap(), format!("{mode} ({elsewhere})"));
                        // The launch paths: Unix as this system does it
                        let line = command_line(&l).unwrap();
                        let here = std::env::consts::OS == CODEX_SOCKETS_OS && widened;
                        assert_eq!(line.contains("'default_permissions=\"agent-mcr-sockets\"'"), here, "{line}");
                        assert_eq!(line.contains("network_proxy"), here, "{line}");
                        assert_eq!(line.contains("allow_local_binding=true"), here && ports, "{line}");
                        assert_eq!(line.contains("workspace-write"), mode == "workspace-write" && !here, "{line}");
                        assert_eq!(line.contains("network_access=false"), fallback, "{line}");
                        assert_eq!(line.starts_with("exec codex resume "), resumed.is_some(), "{line}");
                        assert_eq!(line.ends_with(&format!(" {resume}")), resumed.is_some(), "{line}");
                        let args = windows_args(&l).unwrap();
                        let at = if resumed.is_some() { 2 } else { 1 };
                        assert_eq!(args[at..at + off.len()], off[..]);
                        assert!(!args.iter().any(|a| a.contains("network_proxy") || a.contains("default_permissions")), "{args:?}");
                    }
                }
            }
        }
        // The root Supervisor never takes them
        let supervisor = Launch { profile: "codex", supervisor: true, ..Default::default() };
        assert!(!supervisor.codex_could_take_sockets("macos"));
        // A Claude launch under a root is not a Codex one
        let claude = Launch { profile: "claude", auto_root: Some("~/work"), settings: "/s", ..Default::default() };
        assert!(!claude.codex_sockets() && claude.claude_uses_auto());
        let codex = Launch { profile: "codex", auto_root: Some("~/work"), ..Default::default() };
        assert!(!codex.claude_uses_auto());
    }
}
