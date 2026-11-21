//! Agent profiles (MCR-126; design in Jira comments 16639 and 16647, the
//! owner's decision in 16651). A profile names an adapter and says how to run
//! it: inference, permissions, tools, context, the role's contract and limits.
//! Its id is `<role>@<variant>`.
//!
//! P1 (this module): the type, the loader, validation, levels and the facts
//! the tools show. Nothing is launched from a profile yet (P2), and nothing
//! here reads transcripts (usage facts are P4).
//!
//! Profiles come from two places only: the built-ins compiled in below, and
//! TOML files directly in `<config dir>/profiles/`. Never from a repository or
//! a session's folder: a link in that folder is refused, and so is the folder
//! itself when it is a link. No tool writes a profile. Validation is an
//! allow-list (M1): there is no field that passes words through to an agent's
//! command line, every field must be one the adapter can pass (`Expresses`),
//! and the bypass and danger modes are not in any adapter's list.
//!
//! Every agent runs as the owner's user and can write that folder, so an
//! operator file is used only when its content hash was approved in the app's
//! native dialog (owner's decision 16697 A; `APPROVALS`). A new or changed file
//! is shown as not approved and not used. This stops accidental and
//! cooperative writes, not a hostile agent: the real boundary is the OS user.

use crate::agents::{adapters, Adapter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

/// The owner's words (MCR-126 L1, MCR-124): a go for any of these is the
/// owner's own, typed or confirmed in the acting session. One list for the
/// cockpit and the profiles; a profile adds words and never removes one.
/// A secret is a risk, not a word.
pub const OWNER_WORDS: [&str; 6] = ["merge", "push", "build", "release", "spend", "paid"];

/// Said wherever the ceiling is shown (L9): it bounds what the harness passes.
pub const CEILING_NOTE: &str = "The ceiling bounds what the harness passes to an agent. The operator's own ~/.claude/settings.json allow rules and ~/.codex/config.toml still apply under any profile, and a command-line flag wins over a config file where both set the same thing. Deny lists are best-effort: the real boundaries are branch protection, read-only credentials and the operator's prompts.";

/// Said with every list until P2: profiles are checked and shown only.
pub const NOT_LAUNCHED: &str = "Agent profiles are listed and checked; sessions are not started from them yet (MCR-126 P2). A session's profile is its adapter (bare) until then.";

/// The content hashes of operator profile files the operator approved, in the
/// config folder. Written only by `approve`, which the app's native dialog calls
const APPROVALS: &str = "profile-approvals.json";
const MAX_APPROVALS_FILE: u64 = 256 * 1024;

const MAX_FILE: u64 = 64 * 1024;
const MAX_FILES: usize = 64;
const MAX_LIST: usize = 32;
const MAX_ITEM: usize = 200;
const MAX_SUMMARY: usize = 200;
const MAX_EXTRA_WORDS: usize = 8;

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The root Supervisor only (C3 and `supervisor_safe`)
    Supervisor,
    /// Supervises executors below the root through the `mcr` task tools (C2;
    /// owner's decision 16697 B)
    Lead,
    Sre,
    Backlog,
    Implementer,
    Validator,
    Custom,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Supervisor => "supervisor",
            Role::Lead => "lead",
            Role::Sre => "sre",
            Role::Backlog => "backlog",
            Role::Implementer => "implementer",
            Role::Validator => "validator",
            Role::Custom => "custom",
        }
    }
}

/// How well the harness knows a program (16639 section 3, as corrected in 16647 L3).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    /// No state; tools by the command form at most
    C0,
    /// Proves its input box on screen: notices, no tasks
    C1,
    /// A turn end from a process it starts, and the `mcr` tools: tasks, executors, reports
    C2,
    /// Hooks from its first moment: exact prompts
    C3,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::C0 => "C0",
            Level::C1 => "C1",
            Level::C2 => "C2",
            Level::C3 => "C3",
        }
    }
}

/// The level of an adapter, from its code alone.
pub fn level(a: &dyn Adapter) -> Level {
    match (a.is_agent(), a.reports_from_start(), a.sees_prompt()) {
        (true, true, _) => Level::C3,
        (true, false, _) => Level::C2,
        (false, _, true) => Level::C1,
        (false, _, false) => Level::C0,
    }
}

/// The level of a running session: Codex becomes C3 once its own hooks
/// reported (MCR-74), which is a fact of the session, not of the adapter.
pub fn session_level(profile: &str, own_hooks: bool) -> Level {
    let a = crate::agents::adapter(profile);
    match level(a) {
        Level::C2 if own_hooks => Level::C3,
        l => l,
    }
}

/// The supervisor role's adapter must leave `terminal_write` to the operator's prompt (MCR-76).
fn supervisor_safe(a: &dyn Adapter) -> bool {
    a.asks_before_terminal_write()
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Own,
    Gateway,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Push {
    #[default]
    None,
    FeatureBranches,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Worktree {
    Scratch,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DoneField {
    Refs,
    Gates,
    Verdict,
    Unverified,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Inference {
    #[serde(default)]
    pub source: Source,
    /// Omitted: the agent's own default
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    /// A Claude permission mode or a Codex sandbox, from the adapter's list:
    /// required where the adapter has modes, refused where it has none
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub push: Push,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Tools {
    /// Best-effort (M2): prefix rules an agent can step around
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Mcp {
    /// The operator's own servers the role expects; asked in the role guide, never added
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub require: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Context {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp: Mcp,
}

/// The role's contract. `[contract]` in the file: 16639's examples wrote it
/// as a `[role]` table, which TOML refuses next to the `role` key.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    /// What its `done` report must carry
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub done: Vec<DoneField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_status_every_min: Option<u32>,
    /// Owner words added to `OWNER_WORDS` for sessions of this profile
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owner_words: Vec<String>,
    /// Never validates its own lineage (validator only)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub independent: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executors: Option<u32>,
    /// A soft cap that never interrupts; measured from P4 on
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_soft: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reservations: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentProfile {
    pub id: String,
    pub version: u32,
    pub role: Role,
    pub adapter: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub inference: Inference,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub tools: Tools,
    #[serde(default)]
    pub context: Context,
    #[serde(default)]
    pub contract: Contract,
    #[serde(default)]
    pub limits: Limits,
}

impl AgentProfile {
    /// The core words and the ones this profile adds
    pub fn owner_words(&self) -> Vec<String> {
        let mut words: Vec<String> = OWNER_WORDS.iter().map(|w| w.to_string()).collect();
        for w in &self.contract.owner_words {
            if !words.contains(w) {
                words.push(w.clone());
            }
        }
        words
    }
}

/// What a session records of the profile it was launched with (P2 sets it).
/// Stored in the harness's state, so it takes what a later build wrote: the
/// role is text, not `Role` (a later build may know more roles), and missing
/// fields are empty (review 16715 M2)
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileRef {
    pub id: String,
    pub version: u32,
    pub role: String,
    pub digest: String,
}

/// `Tracked.agent_profile` as stored: anything this build cannot read as a
/// `ProfileRef` is none, so the session itself is never lost (M2)
pub fn lenient_ref<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ProfileRef>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).ok())
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Builtin,
    Operator,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub profile: AgentProfile,
    pub origin: Origin,
    /// The file name under `profiles/` (operator profiles)
    pub file: Option<String>,
    /// SHA-256 of the file's bytes
    pub digest: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Invalid {
    pub file: String,
    pub error: String,
}

/// A valid operator file whose content the operator has not approved
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NotApproved {
    pub file: String,
    pub id: String,
    pub digest: String,
}

#[derive(Default, Debug)]
pub struct Loaded {
    pub profiles: Vec<Entry>,
    pub invalid: Vec<Invalid>,
    pub not_approved: Vec<NotApproved>,
}

/// One approval: the hash of a file's content, with what it was when approved
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Approval {
    pub file: String,
    pub id: String,
    pub at: u64,
}

/// The approved content hashes. A file that cannot be read approves nothing
fn approvals(config_dir: &Path) -> Result<BTreeMap<String, Approval>, String> {
    let path = config_dir.join(APPROVALS);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() > MAX_APPROVALS_FILE {
        return Err("not a regular file of at most 256 KB".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("not readable at line {}", e.line()))
}

/// Approve the content of an operator profile file: the app calls this after
/// the operator said yes in a native dialog (the app slice brings the dialog).
/// The approval is of the bytes now in the file; a later change needs another
#[cfg_attr(not(test), allow(dead_code))]
pub fn approve(config_dir: &Path, file: &str, now: u64) -> Result<Approval, String> {
    let path = config_dir.join("profiles").join(file);
    if file.contains(['/', '\\']) || file.starts_with('.') || !file.ends_with(".toml") {
        return Err("Not a profile file name".into());
    }
    if std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("A link is never approved".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Not UTF-8 text")?;
    let profile = parse(text, Origin::Operator)?;
    let mut all = approvals(config_dir).unwrap_or_default();
    // The newest approval of a file or an id is the only one (review 16715 M1):
    // bringing back the bytes of an earlier version must not make it count again
    all.retain(|_, a| a.file != file && a.id != profile.id);
    let approval = Approval { file: file.to_string(), id: profile.id, at: now };
    all.insert(digest(&bytes), approval.clone());
    let json = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    write_private(config_dir, APPROVALS, json.as_bytes())?;
    Ok(approval)
}

/// Replaces a file in the config folder whole, readable by the owner only
#[cfg_attr(not(test), allow(dead_code))]
fn write_private(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = dir.join(format!("{name}.tmp"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(name)).map_err(|e| e.to_string())
}

impl Loaded {
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.profiles.iter().find(|e| e.profile.id == id)
    }
}

const BUILT_INS: [(&str, &str); 8] = [
    ("supervisor-claude-opus.toml", include_str!("profiles/supervisor-claude-opus.toml")),
    ("lead-claude-opus.toml", include_str!("profiles/lead-claude-opus.toml")),
    ("lead-codex.toml", include_str!("profiles/lead-codex.toml")),
    ("sre-claude-sonnet.toml", include_str!("profiles/sre-claude-sonnet.toml")),
    ("backlog-claude-opus.toml", include_str!("profiles/backlog-claude-opus.toml")),
    ("implementer-claude-opus.toml", include_str!("profiles/implementer-claude-opus.toml")),
    ("validator-codex.toml", include_str!("profiles/validator-codex.toml")),
    ("validator-claude-opus.toml", include_str!("profiles/validator-claude-opus.toml")),
];

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Parsed and checked; the error names the field.
pub fn parse(text: &str, origin: Origin) -> Result<AgentProfile, String> {
    let profile: AgentProfile = toml::from_str(text).map_err(|e| match e.span() {
        Some(at) => format!("line {}: {}", text.as_bytes()[..at.start.min(text.len())].iter().filter(|b| **b == b'\n').count() + 1, e.message()),
        None => e.message().to_string(),
    })?;
    check(&profile, origin)?;
    Ok(profile)
}

/// The built-ins and the operator's files. A file that cannot be read or is
/// refused costs that file only and is listed with its reason.
pub fn load(config_dir: &Path) -> Loaded {
    let mut loaded = Loaded::default();
    for (file, text) in BUILT_INS {
        match parse(text, Origin::Builtin) {
            Ok(profile) => loaded.profiles.push(Entry { profile, origin: Origin::Builtin, file: None, digest: digest(text.as_bytes()) }),
            Err(error) => loaded.invalid.push(Invalid { file: format!("built-in {file}"), error }),
        }
    }
    let dir = config_dir.join("profiles");
    let Ok(meta) = std::fs::symlink_metadata(&dir) else { return loaded };
    let approved = approvals(config_dir).unwrap_or_else(|error| {
        loaded.invalid.push(Invalid { file: APPROVALS.into(), error: format!("{error}; no operator profile is approved until it is fixed") });
        BTreeMap::new()
    });
    if !meta.is_dir() {
        loaded.invalid.push(Invalid { file: "profiles".into(), error: "Not a folder: profiles are read only from a real folder in the config folder, never through a link".into() });
        return loaded;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { return loaded };
    let mut names: Vec<String> = entries.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(".toml") && !n.starts_with('.')).collect();
    names.sort();
    for (i, name) in names.into_iter().enumerate() {
        let refuse = |error: String| Invalid { file: name.clone(), error };
        if i >= MAX_FILES {
            loaded.invalid.push(refuse(format!("More than {MAX_FILES} profile files; this one is not read")));
            continue;
        }
        let path = dir.join(&name);
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                loaded.invalid.push(refuse("A link: profiles are read only from files in this folder, never from a repository".into()));
                continue;
            }
            Ok(m) if !m.is_file() => continue,
            Ok(m) if m.len() > MAX_FILE => {
                loaded.invalid.push(refuse(format!("Larger than {} KB", MAX_FILE / 1024)));
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                loaded.invalid.push(refuse(e.to_string()));
                continue;
            }
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                loaded.invalid.push(refuse(e.to_string()));
                continue;
            }
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            loaded.invalid.push(refuse("Not UTF-8 text".into()));
            continue;
        };
        let profile = match parse(text, Origin::Operator) {
            Ok(p) => p,
            Err(error) => {
                loaded.invalid.push(refuse(error));
                continue;
            }
        };
        if loaded.get(&profile.id).is_some_and(|e| e.origin == Origin::Builtin) {
            loaded.invalid.push(refuse(format!("id {:?} is already defined by a built-in profile; copy it under another variant", profile.id)));
            continue;
        }
        let hash = digest(&bytes);
        // Approved for this file: the same bytes under another name are not
        if !approved.get(&hash).is_some_and(|a| a.file == name && a.id == profile.id) {
            loaded.not_approved.push(NotApproved { file: name.clone(), id: profile.id, digest: hash });
            continue;
        }
        if let Some(other) = loaded.get(&profile.id) {
            let by = other.file.clone().unwrap_or_default();
            loaded.invalid.push(refuse(format!("id {:?} is already defined by the file {by}", profile.id)));
            continue;
        }
        loaded.profiles.push(Entry { profile, origin: Origin::Operator, file: Some(name.clone()), digest: hash });
    }
    loaded
}

fn ident(s: &str, max: usize, extra: &str) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// A model id: letters, digits and `._:-`, plus the `[…]` of a context variant (`opus[1m]`)
fn model_id(s: &str) -> bool {
    ident(s, 64, "._:-[]")
}

/// Text shown as written: no control, format or direction characters
fn shown(s: &str) -> bool {
    !s.chars().any(|c| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
}

/// A tool rule becomes one argv word in P2, also on Windows (`cmd_line`)
fn tool_rule(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= MAX_ITEM && shown(s) && !s.starts_with('-') && !s.contains(['"', '%', '\''])
}

fn list(field: &str, items: &[String], max: usize, ok: impl Fn(&str) -> bool) -> Result<(), String> {
    if items.len() > max {
        return Err(format!("{field}: at most {max} entries"));
    }
    match items.iter().find(|i| !ok(i.as_str())) {
        Some(bad) => Err(format!("{field}: {bad:?} is not allowed here")),
        None => Ok(()),
    }
}

/// The ceiling and every rule of 16639/16647/16651 that P1 can check without
/// launching. The first fault is returned, with the field it is in.
pub fn check(p: &AgentProfile, origin: Origin) -> Result<(), String> {
    // Identity
    let (role, variant) = p.id.split_once('@').ok_or("id: must be <role>@<variant>, for example implementer@claude-opus")?;
    if role != p.role.as_str() {
        return Err(format!("id: begins with {role:?}, but role is {:?}", p.role.as_str()));
    }
    if !(ident(variant, 40, ".-") && variant.chars().all(|c| !c.is_ascii_uppercase())) {
        return Err("id: the variant is lower-case letters, digits, '.' and '-', at most 40".into());
    }
    if p.version == 0 {
        return Err("version: starts at 1".into());
    }
    if p.summary.chars().count() > MAX_SUMMARY || !shown(&p.summary) {
        return Err(format!("summary: one line of at most {MAX_SUMMARY} characters"));
    }
    let a = adapters().find(|a| a.id() == p.adapter).ok_or_else(|| format!("adapter: no adapter {:?} in this build", p.adapter))?;
    let can = a.expresses();
    let lvl = level(a);

    // Role against the adapter's level (16639 section 3; 16647 M5)
    match p.role {
        Role::Supervisor if lvl < Level::C3 || !supervisor_safe(a) => {
            return Err(format!("role: supervisor needs C3 and an agent that asks the operator before terminal_write; {} is {} and does not", p.adapter, lvl.as_str()));
        }
        Role::Custom => {}
        _ if lvl < Level::C2 => {
            return Err(format!("role: {} needs C2 (tasks and reports); {} is {}: use role custom", p.role.as_str(), p.adapter, lvl.as_str()));
        }
        _ => {}
    }

    // Inference: only what the adapter passes (M1)
    if p.inference.source == Source::Gateway {
        return Err("inference.source: gateway inference is parked (owner's decision 7); use own".into());
    }
    if let Some(m) = &p.inference.model {
        if !can.model {
            return Err(format!("inference.model: {} takes no model", p.adapter));
        }
        if !model_id(m) {
            return Err("inference.model: letters, digits and ._:-[] only, at most 64".into());
        }
    }
    if let Some(m) = &p.inference.fallback_model {
        if !can.fallback_model {
            return Err(format!("inference.fallback_model: {} has no fallback model", p.adapter));
        }
        if !model_id(m) {
            return Err("inference.fallback_model: letters, digits and ._:-[] only, at most 64".into());
        }
    }
    if let Some(e) = &p.inference.effort {
        if !can.efforts.contains(&e.as_str()) {
            return Err(format!("inference.effort: {} takes {}", p.adapter, choices(can.efforts)));
        }
    }

    // Permissions: the allow-list ceiling (M1, M8, decision 3)
    let mode = p.permissions.mode.as_deref();
    match mode {
        Some(_) if can.modes.is_empty() => {
            return Err(format!("permissions.mode: {} is started as its adapter says; a profile cannot set its mode", p.adapter));
        }
        None if !can.modes.is_empty() => {
            return Err(format!("permissions.mode: {} needs one of {}", p.adapter, choices(can.modes)));
        }
        Some(m) if !can.modes.contains(&m) => {
            return Err(format!("permissions.mode: {} takes {}; bypass and danger modes are never allowed", p.adapter, choices(can.modes)));
        }
        _ => {}
    }
    if mode == Some("auto") {
        return Err(match p.role {
            Role::Supervisor | Role::Validator => format!("permissions.mode: never auto for the {} (MCR-126 M8)", p.role.as_str()),
            // Allowed for other roles only through the operator's native dialog, which comes with the app's profile editor
            _ => "permissions.mode: auto needs the operator's approval in the app, which is not built yet (MCR-126 P2)".into(),
        });
    }
    if p.permissions.push == Push::FeatureBranches {
        return Err(match origin {
            Origin::Builtin => "permissions.push: built-in profiles never push".into(),
            Origin::Operator => "permissions.push: feature-branches needs the operator's approval in the app, which is not built yet (MCR-126 P2)".into(),
        });
    }
    if p.permissions.worktree.is_some() && lvl < Level::C2 {
        return Err("permissions.worktree: only for an agent that takes tasks".into());
    }

    // Tools: deny and only lists, best-effort (M2), never an allow list
    if (!p.tools.deny.is_empty() || p.tools.only.is_some()) && !can.tools {
        return Err(format!("tools: {} has no tool lists", p.adapter));
    }
    list("tools.deny", &p.tools.deny, MAX_LIST, tool_rule)?;
    if let Some(only) = &p.tools.only {
        list("tools.only", only, MAX_LIST, tool_rule)?;
    }

    // Context: names only
    list("context.skills", &p.context.skills, 16, |s| ident(s, 64, ":_.-"))?;
    list("context.mcp.require", &p.context.mcp.require, 16, |s| ident(s, 64, ":_.-"))?;

    // Contract
    list("contract.owner_words", &p.contract.owner_words, MAX_EXTRA_WORDS, |w| {
        ident(w, 24, "-") && w.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && w.chars().all(|c| !c.is_ascii_uppercase()) && w != "none"
    })?;
    if let Some(m) = p.contract.report_status_every_min {
        if !(5..=1440).contains(&m) {
            return Err("contract.report_status_every_min: 5 to 1440".into());
        }
    }
    if p.role == Role::Validator {
        if !p.contract.independent {
            return Err("contract.independent: a validator is always independent of what it validates".into());
        }
        if !p.contract.done.contains(&DoneField::Verdict) {
            return Err("contract.done: a validator's done carries its verdict".into());
        }
    } else if p.contract.independent {
        return Err("contract.independent: for the validator role only".into());
    }

    // Limits
    if let Some(n) = p.limits.max_executors {
        if n as usize > crate::harness::MAX_EXECUTORS {
            return Err(format!("limits.max_executors: at most {}", crate::harness::MAX_EXECUTORS));
        }
        if n > 0 && lvl < Level::C2 {
            return Err("limits.max_executors: only an agent that takes tasks has executors".into());
        }
    }
    if let Some(t) = p.limits.tokens_soft {
        if !(100_000..=1_000_000_000).contains(&t) {
            return Err("limits.tokens_soft: 100000 to 1000000000".into());
        }
    }
    list("limits.reservations", &p.limits.reservations, 8, |s| ident(s, 32, "-"))?;
    Ok(())
}

fn choices(list: &[&str]) -> String {
    match list {
        [] => "nothing".into(),
        [one] => one.to_string(),
        _ => format!("{} or {}", list[..list.len() - 1].join(", "), list[list.len() - 1]),
    }
}

/// One adapter as the profiles see it.
pub fn adapter_facts(a: &dyn Adapter, enabled: bool) -> Value {
    json!({ "id": a.id(), "level": level(a).as_str(), "supervisorSafe": supervisor_safe(a), "mcp": a.takes_mcp(), "enabled": enabled })
}

/// One profile in `profiles_list`.
pub fn summary(e: &Entry, usable: Result<(), String>) -> Value {
    let p = &e.profile;
    let a = crate::agents::adapter(&p.adapter);
    let mut out = json!({
        "id": p.id, "version": p.version, "role": p.role, "adapter": p.adapter, "summary": p.summary,
        "origin": e.origin, "digest": e.digest,
        "level": level(a).as_str(), "supervisorSafe": supervisor_safe(a),
        "model": p.inference.model, "effort": p.inference.effort, "mode": p.permissions.mode, "push": p.permissions.push,
        "ownerWords": p.owner_words(), "usable": usable.is_ok(),
    });
    if let Some(f) = &e.file {
        out["file"] = json!(f);
    }
    if let Err(why) = usable {
        out["why"] = json!(why);
    }
    out
}

/// Every leaf of a profile under its dotted path, for `compare`.
fn leaves(prefix: &str, v: &Value, out: &mut BTreeMap<String, Value>) {
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                leaves(&if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") }, v, out);
            }
        }
        other => {
            out.insert(prefix.to_string(), other.clone());
        }
    }
}

/// The fields in which two profiles differ, a missing field shown as null.
pub fn compare(a: &Entry, b: &Entry) -> Value {
    let flat = |e: &Entry| {
        let mut m = BTreeMap::new();
        leaves("", &serde_json::to_value(&e.profile).unwrap_or(Value::Null), &mut m);
        m.insert("digest".into(), json!(e.digest));
        m
    };
    let (fa, fb) = (flat(a), flat(b));
    let keys: std::collections::BTreeSet<&String> = fa.keys().chain(fb.keys()).collect();
    let differences: Vec<Value> = keys
        .into_iter()
        .filter(|k| fa.get(*k) != fb.get(*k))
        .map(|k| json!({ "field": k, "a": fa.get(k).cloned().unwrap_or(Value::Null), "b": fb.get(k).cloned().unwrap_or(Value::Null) }))
        .collect();
    json!({ "a": a.profile.id, "b": b.profile.id, "differences": differences })
}

/// The supervisor tool `profiles_list` (v2). `profiles` stays the launch
/// profiles it always was; the rest is new: every adapter with its level, the
/// agent profiles with whether their adapter is turned on, the files that
/// were refused and why, and with `compare: [a, b]` the fields that differ.
pub fn list_tool(config_dir: &Path, args: &Value) -> Result<Value, String> {
    let prefs = crate::harness_preferences::HarnessPreferences::load(config_dir)?;
    let loaded = load(config_dir);
    let mut out = json!({
        "profiles": prefs.profiles(),
        "adapters": adapters().map(|a| adapter_facts(a, prefs.require_enabled(a.id()).is_ok())).collect::<Vec<_>>(),
        "agentProfiles": loaded.profiles.iter().map(|e| summary(e, prefs.require_enabled(&e.profile.adapter))).collect::<Vec<_>>(),
        "invalid": loaded.invalid,
        "notApproved": loaded.not_approved,
        "notApprovedNote": "A profile file in the config folder is used only after the operator approved its content in the app; a new or changed file waits here. Any agent can write that folder, so an approval is of the exact bytes.",
        "ceiling": CEILING_NOTE,
        "note": NOT_LAUNCHED,
    });
    if let Some(pair) = args.get("compare").filter(|v| !v.is_null()) {
        let ids: Vec<&str> = pair.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let [a, b] = ids[..] else { return Err("compare: give two agent profile ids".into()) };
        let find = |id: &str| loaded.get(id).ok_or_else(|| format!("compare: no valid agent profile {id:?}"));
        out["compare"] = compare(find(a)?, find(b)?);
    }
    Ok(out)
}

/// What a session shows of its profile, from the harness's own record of it
/// (`h` is a session's `harness` object): never from what the agent says.
/// `profile` stays the adapter id it always was; `agentProfile` is the
/// profile it was launched with (none before P2: bare); `part` is the free
/// text that was the role.
/// `root`: the runner says this is the root Supervisor (`meta.role`). Without a
/// profile it is a bare Supervisor: role kind `supervisor`, and `reduced` when
/// its adapter does not leave `terminal_write` to the operator (16647 M5).
pub fn session_facts(h: &Value, root: bool) -> Map<String, Value> {
    let profile = h["profile"].as_str().unwrap_or("");
    let level = session_level(profile, h["ownHooks"] == true);
    let agent_profile = h.get("agentProfile").filter(|v| v.is_object()).cloned().unwrap_or(Value::Null);
    let role_kind = match agent_profile["role"].as_str().filter(|r| !r.is_empty()) {
        Some(r) => r.to_string(),
        None if root => "supervisor".to_string(),
        None => "custom".to_string(),
    };
    let mut m = Map::new();
    if root && agent_profile.is_null() && !supervisor_safe(crate::agents::adapter(profile)) {
        m.insert("reduced".into(), json!(true));
    }
    m.insert("agentProfile".into(), agent_profile);
    m.insert("roleKind".into(), json!(role_kind));
    m.insert("part".into(), h["role"].clone());
    m.insert("level".into(), json!(level.as_str()));
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(adapter: &str, role: &str, mode: &str) -> String {
        format!("id = \"{role}@x\"\nversion = 1\nrole = \"{role}\"\nadapter = \"{adapter}\"\n[permissions]\nmode = \"{mode}\"\n{}", if role == "validator" { "[contract]\ndone = [\"verdict\"]\nindependent = true\n" } else { "" })
    }

    fn refused(text: &str) -> String {
        parse(text, Origin::Operator).expect_err("should be refused")
    }

    #[test]
    fn every_built_in_is_valid_and_every_role_has_one() {
        let loaded = load(Path::new("/nonexistent-config-dir"));
        assert!(loaded.invalid.is_empty(), "{:?}", loaded.invalid);
        assert_eq!(loaded.profiles.len(), BUILT_INS.len());
        for role in [Role::Supervisor, Role::Lead, Role::Sre, Role::Backlog, Role::Implementer, Role::Validator] {
            assert!(loaded.profiles.iter().any(|e| e.profile.role == role), "{role:?}");
        }
        for e in &loaded.profiles {
            assert_eq!(e.origin, Origin::Builtin);
            assert_eq!(e.digest.len(), 64);
            let mode = e.profile.permissions.mode.as_deref();
            assert!(mode.is_some() && mode != Some("auto") && mode != Some("plan"), "{}: no built-in uses auto, nor plan until it is verified (M3)", e.profile.id);
            assert_eq!(e.profile.permissions.push, Push::None);
        }
        // The validator for Claude-made work is another kind (decision 5, 11)
        assert_eq!(loaded.get("validator@codex").unwrap().profile.inference.model, None);
        assert_eq!(loaded.get("supervisor@claude-opus").unwrap().profile.adapter, "claude");
        // A lead needs only C2: Codex qualifies, the supervisor role does not (16697 B)
        assert_eq!(loaded.get("lead@codex").unwrap().profile.role, Role::Lead);
    }

    #[test]
    fn levels_are_computed_from_the_adapters() {
        let of = |id: &str| level(crate::agents::adapter(id));
        // 16647 L3: shell, pi, opencode C0; antigravity C1; codex C2; claude C3
        assert_eq!(of("shell"), Level::C0);
        assert_eq!(of("pi"), Level::C0);
        assert_eq!(of("opencode"), Level::C0);
        assert_eq!(of("antigravity"), Level::C1);
        assert_eq!(of("codex"), Level::C2);
        assert_eq!(of("claude"), Level::C3);
        // Codex with its own hooks reporting is C3 for that session only
        assert_eq!(session_level("codex", true), Level::C3);
        assert_eq!(session_level("claude", false), Level::C3);
        assert_eq!(session_level("pi", true), Level::C0);
        assert_eq!(session_level("unknown-later-agent", false), Level::C0);
        // Only Claude is safe as the supervisor (MCR-76)
        for a in adapters() {
            assert_eq!(supervisor_safe(a), a.id() == "claude", "{}", a.id());
            assert_eq!(a.takes_mcp(), a.is_agent(), "{}: the agents take the mcr server, the others the command form", a.id());
        }
    }

    #[test]
    fn bypass_danger_and_unknown_modes_are_refused_for_every_adapter() {
        for adapter in ["claude", "codex"] {
            for mode in ["bypassPermissions", "dontAsk", "danger-full-access", "never", "default", "yolo", ""] {
                assert!(refused(&base(adapter, "implementer", mode)).contains("permissions.mode"), "{adapter} {mode}");
            }
        }
        // Each adapter takes only its own kind of mode
        assert!(refused(&base("codex", "implementer", "acceptEdits")).contains("codex takes read-only or workspace-write"));
        assert!(refused(&base("claude", "implementer", "workspace-write")).contains("claude takes"));
        assert!(parse(&base("claude", "implementer", "acceptEdits"), Origin::Operator).is_ok());
        assert!(parse(&base("codex", "implementer", "workspace-write"), Origin::Operator).is_ok());
    }

    #[test]
    fn no_field_passes_words_through_to_a_command_line() {
        // M1: no extra_args, raw -c, config profile, settings, agents, added dirs or allow lists
        let head = "id = \"implementer@x\"\nversion = 1\nrole = \"implementer\"\nadapter = \"claude\"\n";
        let perms = "[permissions]\nmode = \"acceptEdits\"\n";
        for text in [
            format!("{head}extra_args = [\"--dangerously-skip-permissions\"]\n{perms}"),
            format!("{head}args = \"--approve-for-me\"\n{perms}"),
            format!("{head}{perms}config = \"approval_policy=never\"\n"),
            format!("{head}{perms}codex_profile = \"yolo\"\n"),
            format!("{head}{perms}settings = \"/tmp/s.json\"\n"),
            format!("{head}{perms}add_dir = [\"/\"]\n"),
            format!("{head}{perms}[tools]\nallow = [\"Bash(git push:*)\"]\n"),
            format!("{head}{perms}[inference]\nflags = [\"-c\", \"sandbox_mode=danger-full-access\"]\n"),
            format!("{head}{perms}[context]\nagents = \"{{}}\"\n"),
        ] {
            let error = refused(&text);
            assert!(error.contains("unknown field"), "{text}: {error}");
        }
    }

    #[test]
    fn auto_is_never_for_the_supervisor_or_validator_and_needs_the_app_elsewhere() {
        let sup = refused(&base("claude", "supervisor", "auto"));
        assert!(sup.contains("never auto for the supervisor"), "{sup}");
        let val = refused(&base("claude", "validator", "auto"));
        assert!(val.contains("never auto for the validator"), "{val}");
        for role in ["implementer", "backlog", "sre"] {
            assert!(refused(&base("claude", role, "auto")).contains("approval in the app"), "{role}");
        }
    }

    #[test]
    fn the_role_needs_its_level() {
        assert!(refused(&base("codex", "supervisor", "workspace-write")).contains("supervisor needs C3"));
        assert!(parse(&base("codex", "lead", "workspace-write"), Origin::Operator).is_ok());
        assert!(refused(&base("pi", "lead", "x")).contains("lead needs C2"));
        assert!(refused(&base("pi", "implementer", "x")).contains("needs C2"));
        assert!(refused(&base("antigravity", "validator", "x")).contains("needs C2"));
        // An agent below C2 can only be custom, and a profile cannot set its mode
        assert!(refused(&base("pi", "custom", "x")).contains("cannot set its mode"));
        assert!(refused(&base("nonesuch", "custom", "x")).contains("no adapter"));
    }

    #[test]
    fn every_field_must_be_one_the_adapter_can_pass() {
        let codex = base("codex", "implementer", "workspace-write");
        assert!(refused(&format!("{codex}[tools]\ndeny = [\"Edit\"]\n")).contains("codex has no tool lists"));
        assert!(refused(&format!("{codex}[inference]\nfallback_model = \"o3\"\n")).contains("no fallback model"));
        assert!(refused(&format!("{codex}[inference]\neffort = \"max\"\n")).contains("codex takes low, medium or high"));
        let claude = base("claude", "implementer", "acceptEdits");
        assert!(parse(&format!("{claude}[inference]\nmodel = \"opus[1m]\"\neffort = \"max\"\nfallback_model = \"sonnet\"\n"), Origin::Operator).is_ok());
        assert!(refused(&format!("{claude}[inference]\nmodel = \"opus --dangerously-skip-permissions\"\n")).contains("inference.model"));
        assert!(refused(&format!("{claude}[inference]\nsource = \"gateway\"\n")).contains("parked"));
    }

    #[test]
    fn tool_rules_cannot_become_flags_or_break_a_windows_command_line() {
        let claude = base("claude", "implementer", "acceptEdits");
        for rule in ["--allowedTools", "Bash(\"x\")", "Bash(%PATH%)", "Bash('x')", "a\nb", ""] {
            assert!(refused(&format!("{claude}[tools]\ndeny = [{}]\n", serde_json::to_string(rule).unwrap())).contains("tools.deny"), "{rule:?}");
        }
        assert!(parse(&format!("{claude}[tools]\ndeny = [\"Bash(git push:*)\"]\nonly = [\"Read\", \"Bash\"]\n"), Origin::Operator).is_ok());
    }

    #[test]
    fn owner_words_are_the_shared_list_plus_additions_and_never_less() {
        assert!(OWNER_WORDS.contains(&"build"), "L1: build is an owner word");
        let sre = load(Path::new("/nonexistent-config-dir")).get("sre@claude-sonnet").unwrap().profile.owner_words();
        for w in OWNER_WORDS {
            assert!(sre.contains(&w.to_string()));
        }
        assert!(sre.contains(&"restart".to_string()) && sre.contains(&"scale".to_string()));
        let claude = base("claude", "implementer", "acceptEdits");
        assert!(refused(&format!("{claude}[contract]\nowner_words = [\"none\"]\n")).contains("contract.owner_words"));
        assert!(refused(&format!("{claude}[contract]\nowner_words = [\"Merge Now\"]\n")).contains("contract.owner_words"));
    }

    #[test]
    fn push_beyond_none_waits_for_the_app() {
        let text = base("claude", "implementer", "acceptEdits").replace("mode = \"acceptEdits\"\n", "mode = \"acceptEdits\"\npush = \"feature-branches\"\n");
        assert!(refused(&text).contains("approval in the app"));
        assert!(parse(&text, Origin::Builtin).unwrap_err().contains("never push"));
    }

    #[test]
    fn the_validator_is_independent_and_reports_a_verdict() {
        let v = "id = \"validator@x\"\nversion = 1\nrole = \"validator\"\nadapter = \"codex\"\n[permissions]\nmode = \"workspace-write\"\n";
        assert!(refused(v).contains("contract.independent"));
        assert!(refused(&format!("{v}[contract]\nindependent = true\n")).contains("verdict"));
        assert!(refused(&format!("{}[contract]\nindependent = true\n", base("claude", "implementer", "acceptEdits"))).contains("validator role only"));
    }

    #[test]
    fn ids_versions_and_limits_are_checked() {
        let ok = base("claude", "implementer", "acceptEdits");
        assert!(refused(&ok.replace("implementer@x", "implementer")).contains("<role>@<variant>"));
        assert!(refused(&ok.replace("implementer@x", "backlog@x")).contains("but role is"));
        assert!(refused(&ok.replace("implementer@x", "implementer@X Y")).contains("variant"));
        assert!(refused(&ok.replace("version = 1", "version = 0")).contains("version"));
        assert!(refused(&format!("{ok}[limits]\nmax_executors = 13\n")).contains("at most 12"));
        assert!(refused(&format!("{ok}[limits]\ntokens_soft = 5\n")).contains("tokens_soft"));
        assert!(refused(&format!("{ok}[limits]\nreservations = [\"mac gate\"]\n")).contains("reservations"));
        assert!(refused(&format!("summary = \"a\\u202eb\"\n{ok}")).contains("summary"));
        assert!(refused("id = \"x@y\"").contains("missing field"));
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("amcr-profiles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        dir
    }

    #[test]
    fn operator_files_load_and_a_bad_one_costs_only_itself() {
        let dir = temp_dir("load");
        let p = dir.join("profiles");
        std::fs::write(p.join("mine.toml"), base("claude", "implementer", "acceptEdits")).unwrap();
        std::fs::write(p.join("bad.toml"), base("claude", "implementer", "bypassPermissions").replace("@x", "@y")).unwrap();
        std::fs::write(p.join("zcopy.toml"), base("claude", "implementer", "acceptEdits")).unwrap();
        std::fs::write(p.join("shadow.toml"), base("claude", "backlog", "manual").replace("backlog@x", "backlog@claude-opus")).unwrap();
        std::fs::write(p.join("notes.txt"), "not a profile").unwrap();
        std::fs::write(p.join(".hidden.toml"), "garbage").unwrap();
        std::fs::write(p.join("new.toml"), base("codex", "lead", "workspace-write")).unwrap();
        // Only approved content is used (16697 A), and only under the file it
        // was approved for: zcopy has mine's bytes and is not approved
        approve(&dir, "mine.toml", 1).unwrap();
        let loaded = load(&dir);
        let mine = loaded.get("implementer@x").expect("loaded");
        assert_eq!((mine.origin, mine.file.as_deref()), (Origin::Operator, Some("mine.toml")));
        let errors: BTreeMap<&str, &str> = loaded.invalid.iter().map(|i| (i.file.as_str(), i.error.as_str())).collect();
        assert!(errors["bad.toml"].contains("permissions.mode"));
        assert!(errors["shadow.toml"].contains("built-in"));
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert_eq!(loaded.profiles.len(), BUILT_INS.len() + 1);
        let waiting = |l: &Loaded| l.not_approved.iter().map(|n| n.file.clone()).collect::<Vec<_>>();
        assert_eq!(waiting(&loaded), ["new.toml", "zcopy.toml"]);
        // A changed file is not approved any more, until it is approved again
        let v1 = std::fs::read(p.join("mine.toml")).unwrap();
        std::fs::write(p.join("mine.toml"), base("claude", "implementer", "acceptEdits").replace("version = 1", "version = 2")).unwrap();
        let loaded = load(&dir);
        assert!(loaded.get("implementer@x").is_none());
        assert!(waiting(&loaded).contains(&"mine.toml".to_string()));
        approve(&dir, "mine.toml", 2).unwrap();
        assert_eq!(load(&dir).get("implementer@x").unwrap().profile.version, 2);
        // M1 (review 16715): the newest approval of a file and of an id is the
        // only one, so v1's bytes brought back are not approved any more
        std::fs::write(p.join("mine.toml"), &v1).unwrap();
        let loaded = load(&dir);
        assert!(loaded.get("implementer@x").is_none(), "an earlier approved version counts again");
        assert!(waiting(&loaded).contains(&"mine.toml".to_string()));
        // ... also when the old bytes come back under another file name
        std::fs::write(p.join("mine.toml"), base("claude", "implementer", "acceptEdits").replace("version = 1", "version = 2")).unwrap();
        std::fs::write(p.join("old.toml"), &v1).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.get("implementer@x").unwrap().profile.version, 2);
        assert!(waiting(&loaded).contains(&"old.toml".to_string()));
        // Approving the same id in another file takes the approval from the first
        approve(&dir, "old.toml", 3).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.get("implementer@x").unwrap().file.as_deref(), Some("old.toml"));
        assert!(waiting(&loaded).contains(&"mine.toml".to_string()));
        let kept = approvals(&dir).unwrap();
        assert_eq!(kept.len(), 1, "one approval per id: {kept:?}");
        std::fs::remove_file(p.join("old.toml")).unwrap();
        // Nothing but a valid profile file in the folder is approved
        assert!(approve(&dir, "bad.toml", 3).unwrap_err().contains("permissions.mode"));
        assert!(approve(&dir, "../x.toml", 3).is_err());
        assert!(approve(&dir, "notes.txt", 3).is_err());
        // An approvals file that cannot be read approves nothing, and says so
        std::fs::write(dir.join(APPROVALS), "{not json").unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.profiles.len(), BUILT_INS.len());
        assert!(loaded.invalid.iter().any(|i| i.file == APPROVALS));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn profiles_are_never_read_through_a_link() {
        let dir = temp_dir("links");
        let outside = dir.join("repo");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("x.toml"), base("claude", "implementer", "acceptEdits")).unwrap();
        std::os::unix::fs::symlink(outside.join("x.toml"), dir.join("profiles/x.toml")).unwrap();
        let loaded = load(&dir);
        assert!(loaded.get("implementer@x").is_none());
        assert!(loaded.invalid.iter().any(|i| i.file == "x.toml" && i.error.contains("link")));
        assert!(approve(&dir, "x.toml", 1).unwrap_err().contains("link"));
        // The folder itself as a link into a repository
        std::fs::remove_dir_all(dir.join("profiles")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("profiles")).unwrap();
        let loaded = load(&dir);
        assert!(loaded.get("implementer@x").is_none());
        assert!(loaded.invalid.iter().any(|i| i.file == "profiles"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compare_names_the_fields_that_differ() {
        let loaded = load(Path::new("/nonexistent-config-dir"));
        let out = compare(loaded.get("validator@codex").unwrap(), loaded.get("validator@claude-opus").unwrap());
        let fields: Vec<&str> = out["differences"].as_array().unwrap().iter().map(|d| d["field"].as_str().unwrap()).collect();
        for f in ["adapter", "id", "inference.model", "inference.effort", "permissions.mode", "digest"] {
            assert!(fields.contains(&f), "{f} in {fields:?}");
        }
        assert!(!fields.contains(&"role") && !fields.contains(&"contract.independent"));
        let same = compare(loaded.get("validator@codex").unwrap(), loaded.get("validator@codex").unwrap());
        assert_eq!(same["differences"], json!([]));
    }

    #[test]
    fn a_session_shows_its_profile_from_the_harness_record() {
        let bare = session_facts(&json!({ "profile": "codex", "ownHooks": true, "role": "reviewer of MCR-1" }), false);
        assert_eq!(bare["agentProfile"], Value::Null);
        assert_eq!(bare["roleKind"], "custom");
        assert_eq!(bare["part"], "reviewer of MCR-1");
        assert_eq!(bare["level"], "C3");
        let launched = session_facts(&json!({ "profile": "claude", "role": "", "agentProfile": { "id": "implementer@claude-opus", "version": 1, "role": "implementer", "digest": "d" } }), false);
        assert_eq!(launched["roleKind"], "implementer");
        assert_eq!(launched["agentProfile"]["id"], "implementer@claude-opus");
        // What a stored record says round-trips
        let r: ProfileRef = serde_json::from_value(launched["agentProfile"].clone()).unwrap();
        assert_eq!(r.role, "implementer");
        // L2 (review 16715): the bare root Supervisor is a supervisor, reduced
        // where its adapter does not leave terminal_write to the operator
        let root = session_facts(&json!({ "profile": "claude", "role": "" }), true);
        assert_eq!(root["roleKind"], "supervisor");
        assert!(root.get("reduced").is_none());
        let root = session_facts(&json!({ "profile": "codex", "role": "" }), true);
        assert_eq!(root["roleKind"], "supervisor");
        assert_eq!(root["reduced"], true);
    }

    #[test]
    fn a_stored_profile_ref_from_a_later_build_is_read_or_left_out_never_fatal() {
        // M2 (review 16715): a role this build does not know, extra and missing fields
        let r: ProfileRef = serde_json::from_value(json!({ "id": "auditor@x", "role": "auditor", "later": 1 })).unwrap();
        assert_eq!((r.role.as_str(), r.version), ("auditor", 0));
        assert_eq!(session_facts(&json!({ "profile": "claude", "agentProfile": { "id": "auditor@x", "role": "auditor" } }), false)["roleKind"], "auditor");
        // A shape this build cannot read is no profile
        #[derive(Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "lenient_ref")]
            p: Option<ProfileRef>,
        }
        for shape in [json!("implementer@claude-opus"), json!(42), json!({ "id": 7 }), json!(null)] {
            let h: Holder = serde_json::from_value(json!({ "p": shape })).unwrap();
            assert!(h.p.is_none(), "{shape}");
        }
        assert_eq!(session_facts(&json!({ "profile": "claude", "agentProfile": "weird" }), false)["roleKind"], "custom");
    }

    #[test]
    fn custom_profiles_fit_agents_below_c2() {
        // L1 (review 16715): an adapter without modes takes a profile without permissions
        let pi = "id = \"custom@pi\"\nversion = 1\nrole = \"custom\"\nadapter = \"pi\"\nsummary = \"Pi as a terminal agent\"\n";
        assert!(parse(pi, Origin::Operator).is_ok());
        let agy = pi.replace("custom@pi", "custom@agy").replace("adapter = \"pi\"", "adapter = \"antigravity\"");
        assert!(parse(&agy, Origin::Operator).is_ok());
        // ... and nothing it cannot pass
        assert!(refused(&format!("{pi}[permissions]\nmode = \"manual\"\n")).contains("cannot set its mode"));
        assert!(refused(&format!("{pi}[inference]\nmodel = \"m\"\n")).contains("takes no model"));
        assert!(refused(&format!("{pi}[limits]\nmax_executors = 1\n")).contains("max_executors"));
        // An adapter with modes still needs one
        let claude = "id = \"implementer@m\"\nversion = 1\nrole = \"implementer\"\nadapter = \"claude\"\n";
        assert!(refused(claude).contains("claude needs one of"));
    }
}
