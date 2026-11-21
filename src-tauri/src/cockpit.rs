//! The cockpit document (MCR-94, first slice MCR-95): tracks, items and the
//! operator's actions as hosted sessions publish them, kept in the
//! harness store, and the read that joins them with what the harness knows.
//!
//! Two layers that are never mixed. What a session published is text: it is
//! validated, stored and shown, and nothing here types, runs or opens any of
//! it. What the harness knows (`Facts`: states, prompts, reports, waits) is
//! joined at every read and never stored here, so it cannot go stale and no
//! agent can misstate it. Published text never overrides a fact, and a fact
//! never rewrites published text.
//!
//! Everything in this file is pure: the service hands in `Facts` and the
//! caller (`Who`), both taken from its own store and the caller's process.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// 2: parts hold `needs` (MCR-124). An older build reads a document of a
/// later schema as empty, and the store keeps the file aside first (MCR-99)
pub const SCHEMA: u32 = 2;
/// The key of the root Supervisor's part: it belongs to the role, so a new
/// Supervisor session continues it. Session ids are hexadecimal.
pub const ROOT: &str = "supervisor";

const TRACK_STATES: [&str; 5] = ["moving", "waiting_human", "blocked", "parked", "done"];
const ITEM_STATES: [&str; 5] = ["doing", "review", "ready", "waiting", "done"];
const WAIT_KINDS: [&str; 5] = ["human", "session", "ci", "timer", "external"];
/// The kinds a session may publish. `answer_prompt`, `report`, `held_line`
/// and `human_wait` are built by the service from a session's prompt, its
/// open report, the operator's unsent line there and a human wait past its
/// time (MCR-118), and by nobody else.
const ACTION_KINDS: [&str; 5] = ["typed_word", "decision", "secret_step", "live_check", "external"];
const DERIVED_KINDS: [&str; 4] = ["answer_prompt", "report", "held_line", "human_wait"];
const RISKS: [&str; 3] = ["reversible", "irreversible", "spend"];
const URGENCIES: [&str; 3] = ["now", "today", "whenever"];
/// Fields the service writes. They are taken out of what a session sends, so
/// a document that was read can be published back.
const STAMPS: [&str; 13] = ["updated", "since", "by", "live", "trackMissing", "ownerTyped", "sessionEnded", "unclickable", "closed", "guarded", "attach", "need", "fromAction"];
/// What a session asks of the operator through `report` (MCR-124)
const NEED_KINDS: [&str; 6] = ["decision", "go", "question", "secret_step", "live_check", "external"];
/// What the harness builds from its own facts: never declared by a session
const FACT_KINDS: [&str; 5] = ["prompt", "held_line", "report", "done", "human_wait"];
/// The owner's own words: the answer goes only to the acting session (MCR-124)
const WORDS: [&str; 7] = ["none", "merge", "push", "build", "release", "spend", "paid"];
const CHOICE_RISKS: [&str; 3] = ["reversible", "irreversible", "spend"];
const OUTCOMES: [&str; 4] = ["answered", "done", "obsolete", "withdrawn"];
const MAX_NEEDS: usize = 30;
/// The longest a publisher may promise to look at a need again: two weeks, in minutes
const MAX_CHECK_BY: u64 = 14 * 24 * 60;
/// A closed need stays readable this long ("Closed today")
pub const CLOSED_KEPT_MS: u64 = 24 * 3_600_000;

const MAX_TRACKS: usize = 12;
const MAX_ITEMS: usize = 30;
const MAX_ACTIONS: usize = 20;
const MAX_LIST: usize = 8;
const MAX_OPTIONS: usize = 6;
const MAX_PART_BYTES: usize = 64 * 1024;
const MAX_TITLE: usize = 120;
const MAX_LINE: usize = 200;
const MAX_WHY: usize = 400;
const MAX_DETAIL: usize = 4000;
const MAX_SHORT: usize = 80;
const MAX_REF: usize = 40;
const MAX_LINK: usize = 500;
/// Accepted writes of one session in `WRITE_WINDOW_MS`
const MAX_WRITES: usize = 30;
const WRITE_WINDOW_MS: u64 = 600_000;

fn zero(n: &u64) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WaitsOn {
    /// human | session | ci | timer | external
    pub kind: String,
    /// With kind `session`: its id. Otherwise who or what, in a few words
    #[serde(skip_serializing_if = "String::is_empty")]
    pub who: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub what: String,
    /// When this wait was first published (the service's stamp)
    #[serde(skip_serializing_if = "zero")]
    pub since: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    pub title: String,
    #[serde(rename = "ref", skip_serializing_if = "String::is_empty")]
    pub reference: String,
    /// A session id, or `human`
    pub owner: String,
    /// doing | review | ready | waiting | done
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waits_on: Option<WaitsOn>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub next: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub title: String,
    /// The session that leads it: the publisher or a session below it
    pub lead: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
    /// moving | waiting_human | blocked | parked | done
    pub state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub line: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Item>,
    /// When its publisher last changed it (the service's stamp)
    #[serde(skip_serializing_if = "zero")]
    pub updated: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Where {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub session: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// Shown to copy. Never run by the harness
    #[serde(skip_serializing_if = "String::is_empty")]
    pub command: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    pub id: String,
    /// A track of the publisher's part; with `track_by`, of that part (root only)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub track: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub track_by: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub item: String,
    pub title: String,
    /// typed_word | decision | secret_step | live_check | external
    pub kind: String,
    #[serde(rename = "where")]
    pub place: Where,
    /// `typed_word`: the exact line for the session's input box
    #[serde(skip_serializing_if = "String::is_empty")]
    pub say: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub recommended: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub why: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
    /// reversible | irreversible | spend (then with `amount`)
    pub risk: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub amount: String,
    /// now | today | whenever
    #[serde(skip_serializing_if = "String::is_empty")]
    pub urgency: String,
    /// Ids of the reports, messages or tickets it comes from
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// When an action with this id was first published, and when it last changed
    #[serde(skip_serializing_if = "zero")]
    pub since: u64,
    #[serde(skip_serializing_if = "zero")]
    pub updated: u64,
}

/// One choice of a need (MCR-124).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Choice {
    pub id: String,
    /// What the operator chooses, in the words the session wants back
    pub label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub recommended: bool,
    /// reversible | irreversible | spend (then with `amount`)
    pub risk: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub amount: String,
    /// What happens if it is chosen: shown, never placed
    #[serde(skip_serializing_if = "String::is_empty")]
    pub effect: String,
}

/// How a need ended, by its publisher's word.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Closed {
    /// answered | done | obsolete | withdrawn
    pub outcome: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub chosen: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
    pub at: u64,
}

/// A question a session escalates to the operator with `report` (MCR-124):
/// the answer goes back down to that session, or to the `actor` it names.
/// Stored in its publisher's part like an action, and never run: a click
/// places a line built by the service from ids, unsent.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Need {
    pub id: String,
    /// decision | go | question | secret_step | live_check | external
    pub ask: String,
    /// The question, one line: the report's text
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Choice>,
    /// An owner word the answer is (`none` when it is none)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub word: String,
    /// The placed line is the option's label alone, as a `typed_word`'s `say`
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
    /// The session whose input box gets the answer; the publisher when empty
    #[serde(skip_serializing_if = "String::is_empty")]
    pub actor: String,
    #[serde(rename = "where")]
    pub place: Where,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub track: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub item: String,
    /// `item:<track>/<item>` of the publisher's tracks, or `need:<part>/<id>`
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
    /// `need:<part>/<id>`, `prompt:<session>`, `held:<session>`, `wait:<id>`, `report:<id>`
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cause: Vec<String>,
    /// Ticket keys and links
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub urgency: String,
    /// Minutes: by when the publisher will confirm or change it at the latest
    #[serde(skip_serializing_if = "zero")]
    pub check_by: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub why: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    #[serde(skip_serializing_if = "zero")]
    pub since: u64,
    /// Every declaration is a new one: a click names this stamp
    #[serde(skip_serializing_if = "zero")]
    pub updated: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<Closed>,
}

impl Need {
    /// An answer that is the owner's own word, or a choice that risks more
    /// than a step back: a click never places it in this slice (MCR-124 S1)
    pub fn guarded(&self) -> bool {
        (!self.word.is_empty() && self.word != "none") || self.ask == "secret_step" || self.options.iter().any(|o| o.risk != "reversible")
    }

    /// The highest risk of its choices (MCR-124, L4): not a field anyone sets
    pub fn risk(&self) -> &'static str {
        if self.ask == "secret_step" {
            "secret"
        } else if self.options.iter().any(|o| o.risk == "irreversible") {
            "irreversible"
        } else if self.options.iter().any(|o| o.risk == "spend") {
            "spend"
        } else {
            "reversible"
        }
    }

    fn open(&self) -> bool {
        self.closed.is_none()
    }
}

/// The line a click on a need's choice places, unsent, in the acting
/// session's box: built by the service from ids, so a bare "yes" is never
/// taken for an answer to whatever the session asked last. `part` names the
/// publisher: need ids are its own (MCR-124, M3).
fn need_line(part: &str, need: &Need, choice: &Choice) -> String {
    if need.exact {
        return choice.label.clone();
    }
    let frame = if need.ask == "go" { "Go" } else { "Decision" };
    let amount = if choice.amount.is_empty() { String::new() } else { format!(" ({})", choice.amount) };
    format!("{frame} {part}/{}: {}{amount}", need.id, choice.label)
}

/// What one session published.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Part {
    pub tracks: Vec<Track>,
    pub actions: Vec<Action>,
    /// Asked through `report` (MCR-124), never through `cockpit_publish`
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<Need>,
    pub updated: u64,
}

impl Part {
    fn is_empty(&self) -> bool {
        self.tracks.is_empty() && self.actions.is_empty() && self.needs.is_empty()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct TrackRef {
    pub by: String,
    pub id: String,
}

/// The stored document, by publisher: who wrote a track is where it lies,
/// never a field an agent sets.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Cockpit {
    pub schema: u32,
    /// One up per accepted write
    pub version: u64,
    pub updated: u64,
    /// Tracks in the order the root Supervisor gave; the rest follow
    pub order: Vec<TrackRef>,
    pub parts: BTreeMap<String, Part>,
    /// Accepted writes per session, for the rate limit
    #[serde(skip)]
    writes: BTreeMap<String, VecDeque<u64>>,
}

/// An open wait a session registered with `wait_register`.
#[derive(Clone, Debug, Default)]
pub struct FactWait {
    pub id: String,
    pub kind: String,
    pub on: String,
    pub reference: String,
    pub since: u64,
    pub overdue: bool,
}

/// What the harness knows about one tracked session.
#[derive(Clone, Debug, Default)]
pub struct Fact {
    pub name: String,
    pub state: String,
    pub ended: bool,
    /// It takes prompts and has a state (not a shell)
    pub agent: bool,
    /// Its supervisors, nearest first
    pub above: Vec<String>,
    /// It asks the operator at a prompt (`permission` attention): since when
    pub prompt: Option<u64>,
    /// The operator has an unsent line in its input box that has stood a
    /// while (MCR-85, MCR-118): since when. The line's text is not known here
    pub held: Option<u64>,
    /// Its open `needs_human` report: id, text, when
    pub needs_human: Option<(String, String, u64)>,
    /// Its open `done` report: id, text, when
    pub done: Option<(String, String, u64)>,
    pub waits: Vec<FactWait>,
    /// When the operator last pressed Enter in its terminal, by the app's word
    pub typed: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub sessions: BTreeMap<String, Fact>,
    /// Every report the store still has, and the session that made it
    pub reports: BTreeMap<String, String>,
    /// The hosted Supervisor session, when the caller knows it. The store
    /// alone does not: who is the Supervisor is the runner's word
    pub root: Option<String>,
    /// When the facts were taken (0: unknown, nothing counts as old)
    pub now: u64,
}

/// A published entry not touched for this long may be out of date; the
/// panel marks it so (`STALE_AFTER_MS` in `utils/cockpit.ts`), and the harness
/// merges none of its facts into it (MCR-118).
pub const STALE_AFTER_MS: u64 = 6 * 3_600_000;

/// A published entry whose text the harness knows to be behind (MCR-103): it
/// says the operator is awaited in a session, and the operator has typed
/// there since it was last published, or that session is no more. Made at
/// every read from the facts, never stored and never taken from a publisher.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Outdated {
    /// The part it is in: a session id, or `ROOT`
    pub by: String,
    /// A track; otherwise an action or a need
    pub track: bool,
    /// A need (MCR-124)
    pub need: bool,
    pub id: String,
    /// The entry's stamp this is said about: a publish after it makes it a new entry
    pub updated: u64,
    /// The session the entry points the operator at
    pub session: String,
    /// When the operator typed there; `None`: the session ended or is gone
    pub typed: Option<u64>,
}

/// The document as the store file holds it. Read leniently: a field this
/// build does not know (a later build wrote it) is passed over, and a
/// document it cannot read at all, or one of a later schema, is an empty
/// cockpit. Never an error: an error here would fail the load of the whole
/// store, and the service would start with no relations, messages or reports.
/// Whether `load` takes a stored document as it is. The store asks, so that
/// a document it drops is kept aside with the file first (MCR-99).
pub fn readable(stored: &Value) -> bool {
    Cockpit::deserialize(stored).is_ok_and(|c| c.schema <= SCHEMA)
}

pub fn load(stored: Value) -> Cockpit {
    match serde_json::from_value::<Cockpit>(stored) {
        Ok(cockpit) if cockpit.schema <= SCHEMA => cockpit,
        _ => Cockpit::default(),
    }
}

/// `load` for the store's field (`deserialize_with`).
pub fn stored<'de, D: serde::Deserializer<'de>>(from: D) -> Result<Cockpit, D::Error> {
    Ok(load(Value::deserialize(from)?))
}

/// The caller, as the service knows it from its process.
#[derive(Clone, Copy, Debug)]
pub struct Who<'a> {
    pub id: &'a str,
    /// The hosted Supervisor session
    pub root: bool,
}

impl Who<'_> {
    fn key(&self) -> &str {
        if self.root { ROOT } else { self.id }
    }
}

fn refuse<T>(path: &str, why: impl std::fmt::Display) -> Result<T, String> {
    Err(format!("Refused: {path} {why}"))
}

/// Whether text holds what looks like a credential (MCR-124, M9): the
/// prefixes of the tokens and keys this operator's tools use, followed by
/// enough token characters to be one, and a private key block. Defence in
/// depth beside "no secrets" in the guide: cockpit text is kept on disk and
/// shown. A refusal names the place and never repeats the match.
pub fn looks_secret(s: &str) -> bool {
    let token = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_');
    let run = |rest: &str, ok: &dyn Fn(char) -> bool| rest.chars().take_while(|c| ok(*c)).count();
    const PREFIXES: [&str; 8] = ["xoxb-", "xoxp-", "xapp-", "ghp_", "gho_", "github_pat_", "sk-ant-", "glpat-"];
    for (at, _) in s.char_indices() {
        let rest = &s[at..];
        // A word that starts here, not the middle of one
        let starts = s[..at].chars().next_back().is_none_or(|c| !token(c));
        if starts && PREFIXES.iter().any(|p| rest.starts_with(p) && run(&rest[p.len()..], &token) >= 16) {
            return true;
        }
        if starts && rest.starts_with("sk-") && run(&rest[3..], &|c: char| c.is_ascii_alphanumeric()) >= 20 {
            return true;
        }
        if starts && rest.starts_with("AKIA") && run(&rest[4..], &|c: char| c.is_ascii_uppercase() || c.is_ascii_digit()) >= 16 {
            return true;
        }
        if rest.starts_with("Bearer ") && run(&rest[7..], &|c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')) >= 20 {
            return true;
        }
    }
    s.contains("-----BEGIN") && s.contains("PRIVATE KEY")
}

const SECRET: &str = "holds what looks like a credential (a token or a private key). Cockpit text is shown and kept on disk: never put a secret in it";

/// Text an agent wrote, for a place where it is shown: bounded, and without
/// what would change how it is drawn (control characters, direction overrides).
fn text(path: &str, s: &str, max: usize, lines: bool) -> Result<(), String> {
    if s.chars().count() > max {
        return refuse(path, format!("is longer than {max} characters"));
    }
    if looks_secret(s) {
        return refuse(path, SECRET);
    }
    if s.chars().any(|c| c.is_control() && !(lines && c == '\n')) {
        return refuse(path, if lines { "holds control characters" } else { "holds a line break or control characters" });
    }
    // Separators that break a line unseen, direction overrides and isolates, tag characters
    match s.chars().find(|c| matches!(c, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{e0000}'..='\u{e0fff}')) {
        Some(c) => refuse(path, format!("holds a character that cannot be seen (U+{:04X})", c as u32)),
        None => Ok(()),
    }
}

/// How long a line may be that a click places in an input box (`say`, an
/// option), and a command a click copies. Short on purpose: the operator's
/// check is their eyes, and the whole of it is on the row (MCR-97).
pub const MAX_PLACED: usize = 120;
pub const MAX_COPIED: usize = 200;

/// Typographic marks let through next to letters, digits, the space and
/// ASCII punctuation.
const MARKS: [char; 9] = ['\u{2013}', '\u{2014}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}', '\u{2026}', '\u{20ac}', '\u{a3}'];

/// Letters by `char::is_alphanumeric` that draw nothing (the Hangul fillers).
const BLANK_LETTERS: [char; 4] = ['\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}'];

/// Text that may leave the panel through a click: one line of characters
/// that can all be seen. An allow-list, not a list of what is known to be
/// bad: a letter or digit, the space U+0020, ASCII punctuation, or one of
/// `MARKS`. So no control or format character, no other space, no
/// combining mark, no private-use or unassigned code point. No two spaces
/// in a row (padding pushes text out of sight) and no backslash at the end
/// (before Enter it makes a new line in Claude Code and sends nothing).
/// `Err` says why, without a place.
fn visible_line(s: &str, max: usize) -> Result<(), String> {
    if s.is_empty() || s != s.trim() {
        return Err("must be a line without spaces at its ends".into());
    }
    if s.chars().count() > max {
        return Err(format!("is longer than {max} characters"));
    }
    let allowed = |c: char| (c.is_alphanumeric() && !BLANK_LETTERS.contains(&c)) || c == ' ' || c.is_ascii_punctuation() || MARKS.contains(&c);
    if let Some(c) = s.chars().find(|c| !allowed(*c)) {
        return Err(format!("holds a character that is not let through (U+{:04X}): letters, digits, single spaces and common punctuation only", c as u32));
    }
    if s.contains("  ") {
        return Err("holds two spaces in a row".into());
    }
    if s.ends_with('\\') {
        return Err("ends with a backslash".into());
    }
    if looks_secret(s) {
        return Err(SECRET.into());
    }
    Ok(())
}

/// A line a click may place, unsent, in an agent's input box: `visible_line`,
/// short, and not one that the input box would run as a command. The one
/// function for the publish and for the click.
pub fn placeable(s: &str) -> Result<(), String> {
    visible_line(s, MAX_PLACED)?;
    match s.chars().next() {
        Some(c @ ('!' | '#' | '/')) => Err(format!("can't start with {c:?}: in an agent's input box that runs a command")),
        _ => Ok(()),
    }
}

/// A command a click may copy for the operator. Never run or typed by the harness.
pub fn copyable(s: &str) -> Result<(), String> {
    visible_line(s, MAX_COPIED)
}

/// Hosts whose links open after the plain question. Every other host gets
/// the stronger warning. The owner's list (MCR-97): change it here only.
pub const PLAIN_HOSTS: [&str; 2] = ["teob.atlassian.net", "github.com"];

/// Paths on those hosts that still get the stronger warning: where one signs
/// in, grants an app access or changes an account. The owner's list too.
pub const GUARDED_PATHS: [&str; 4] = ["/login", "/oauth", "/apps", "/settings"];

/// A link as the parser reads it: what is shown and what is opened are these
/// parts, never the stored string.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Link {
    /// The parser's own serialisation: the address that is opened
    pub href: String,
    pub host: String,
    pub path: String,
    pub query: String,
    /// The host is one of `PLAIN_HOSTS`
    pub known: bool,
}

/// A link a click may open in the operator's browser: `https`, a host with a
/// public-looking name, the default port, no user or password. Not an address
/// on this machine or in the operator's network: a click there would act with
/// their browser's own sessions.
pub fn web_link(s: &str) -> Result<Link, String> {
    if s.chars().count() > MAX_LINK || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(format!("must be one link without spaces, at most {MAX_LINK} characters"));
    }
    if looks_secret(s) {
        return Err(SECRET.into());
    }
    let url = tauri::Url::parse(s).map_err(|_| "is not a link".to_string())?;
    if url.scheme() != "https" {
        return Err("must be an https link".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not hold a user or password part".into());
    }
    if url.port().is_some() {
        return Err("must not name a port".into());
    }
    // The question shows host, path and query. A fragment would be opened and not shown
    if url.fragment().is_some() {
        return Err("must not hold a fragment (the part after #)".into());
    }
    // `domain` is the host only when it is a name: a number address has none
    let host = match (url.domain(), url.host_str()) {
        (Some(name), _) => name.trim_end_matches('.').to_ascii_lowercase(),
        (None, Some(_)) => return Err("must name a host, not a number address".into()),
        (None, None) => return Err("has no host".into()),
    };
    let local = host == "localhost" || !host.contains('.') || [".local", ".localhost", ".internal", ".lan", ".home", ".test"].iter().any(|end| host.ends_with(end));
    // A name of digits and dots only is a number address the parser did not take for one
    if local || host.split('.').all(|label| label.bytes().all(|b| b.is_ascii_digit())) {
        return Err("names a host on this machine or in a local network".into());
    }
    let path = url.path().to_string();
    let guarded = GUARDED_PATHS.iter().any(|p| path.to_ascii_lowercase().starts_with(p));
    Ok(Link { href: url.as_str().to_string(), known: PLAIN_HOSTS.contains(&host.as_str()) && !guarded, host, path, query: url.query().unwrap_or("").to_string() })
}

/// What a click in the panel asks for (MCR-97). It names an action by ids;
/// nothing of it is text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Act {
    /// Put a `typed_word`'s line in its session's input box
    Place,
    /// Put the choice of a `decision` in the input box, by the option's place in the list
    Choose(usize),
    /// Put a fixed question about the action in its publisher's input box
    Ask,
    /// The parts of its link, to be shown and then opened
    Link,
    /// Its command, for the clipboard
    Copy,
}

/// What the service is to do for a click, from the stored document alone.
#[derive(Clone, Debug, PartialEq)]
pub enum Deed {
    /// Type this line, unsent, into this session's input box
    Type { session: String, text: String },
    Link(Link),
    Copy(String),
}

/// The line for a chosen option. Made by the service: the action's id says
/// which decision, so that a bare "Yes" is not taken for an answer to
/// whatever the session asked last. The owner's choice of form (MCR-97): change it here only.
fn decision_line(action: &str, option: &str) -> String {
    format!("Decision {action}: {option}")
}

/// The question "Ask more" places. No text of the action is in it, only its id.
fn ask_line(action: &str) -> String {
    format!("Explain cockpit action {action}: what happens if I do it, and what if I do not?")
}

/// A line for a session's input box, checked at the click as at the
/// publish: that session runs, takes lines, and is the publisher or works
/// for it now (the Supervisor reaches every session).
fn type_into(by: &str, session: String, text: String, facts: &Facts) -> Result<Deed, String> {
    let Some(fact) = facts.sessions.get(&session).filter(|f| !f.ended) else {
        return Err("Refused: the session this would be typed into has ended or is gone.".into());
    };
    if !fact.agent {
        return Err("Refused: that session is not an agent with an input box.".into());
    }
    if by != ROOT && session != by && !fact.above.iter().any(|s| s == by) {
        return Err("Refused: that session no longer works for the session that published this.".into());
    }
    placeable(&text).map_err(|why| format!("Refused: the line {why}."))?;
    Ok(Deed::Type { session, text })
}

fn required(path: &str, s: &str, max: usize) -> Result<(), String> {
    if s.trim().is_empty() {
        return refuse(path, "is required");
    }
    text(path, s, max, false)
}

fn ident(path: &str, s: &str) -> Result<(), String> {
    let ok = !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-') && !s.starts_with(['_', '-']);
    if ok { Ok(()) } else { refuse(path, "must be 1 to 40 of a-z, 0-9, - and _, starting with a letter or digit") }
}

fn one_of(path: &str, s: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&s) { Ok(()) } else { refuse(path, format!("must be one of: {}", allowed.join(", "))) }
}

fn list(path: &str, all: &[String], most: usize, max: usize) -> Result<(), String> {
    if all.len() > most {
        return refuse(path, format!("has more than {most} entries"));
    }
    all.iter().enumerate().try_for_each(|(i, s)| required(&format!("{path}[{i}]"), s, max))
}

/// A session id that names a tracked session that has not ended.
fn session<'a>(path: &str, id: &str, facts: &'a Facts) -> Result<&'a Fact, String> {
    match facts.sessions.get(id) {
        None => refuse(path, format!("names {id:?}, which is not a session the harness tracks")),
        Some(f) if f.ended => refuse(path, format!("names session {id}, which has ended")),
        Some(f) => Ok(f),
    }
}

/// A session that is only named (an item's owner, who an item waits on):
/// that gives nobody a right, so a session that has ended stays named, and
/// so does one that was forgotten since it was stored (`kept`). The record
/// of who did an item must not block every later change of the part.
fn mention(path: &str, id: &str, facts: &Facts, kept: &BTreeSet<&str>) -> Result<(), String> {
    if facts.sessions.contains_key(id) || kept.contains(id) {
        Ok(())
    } else {
        refuse(path, format!("names {id:?}, which is not a session the harness tracks"))
    }
}

/// A session the caller may point an action or a track at: itself or one
/// below it. The root Supervisor: any.
fn reach(path: &str, id: &str, who: &Who, facts: &Facts) -> Result<(), String> {
    let fact = session(path, id, facts)?;
    if who.root || id == who.id || fact.above.iter().any(|s| s == who.id) {
        Ok(())
    } else {
        refuse(path, format!("names session {id}, which is not you or one of your executors"))
    }
}

fn check_track(path: &str, t: &Track, old: Option<&Part>, kept: &BTreeSet<&str>, who: &Who, facts: &Facts) -> Result<(), String> {
    ident(&format!("{path}.id"), &t.id)?;
    required(&format!("{path}.title"), &t.title, MAX_TITLE)?;
    // A lead is checked when it is given or changed: a track whose lead has
    // ended since keeps it, or nothing else of the part could be changed
    if !old.is_some_and(|o| o.tracks.iter().any(|b| b.id == t.id && b.lead == t.lead)) {
        reach(&format!("{path}.lead"), &t.lead, who, facts)?;
    }
    list(&format!("{path}.refs"), &t.refs, MAX_LIST, MAX_REF)?;
    one_of(&format!("{path}.state"), &t.state, &TRACK_STATES)?;
    text(&format!("{path}.line"), &t.line, MAX_LINE, false)?;
    if t.items.len() > MAX_ITEMS {
        return refuse(&format!("{path}.items"), format!("has more than {MAX_ITEMS} entries"));
    }
    let mut ids = BTreeSet::new();
    for (i, item) in t.items.iter().enumerate() {
        let path = format!("{path}.items[{i}]");
        ident(&format!("{path}.id"), &item.id)?;
        if !ids.insert(item.id.as_str()) {
            return refuse(&format!("{path}.id"), format!("{:?} is used twice in this track", item.id));
        }
        required(&format!("{path}.title"), &item.title, MAX_TITLE)?;
        text(&format!("{path}.ref"), &item.reference, MAX_REF, false)?;
        if item.owner != "human" {
            if item.owner.is_empty() {
                return refuse(&format!("{path}.owner"), "is required: a session id, or \"human\"");
            }
            mention(&format!("{path}.owner"), &item.owner, facts, kept)?;
        }
        one_of(&format!("{path}.state"), &item.state, &ITEM_STATES)?;
        text(&format!("{path}.next"), &item.next, MAX_LINE, false)?;
        if let Some(w) = &item.waits_on {
            let path = format!("{path}.waitsOn");
            one_of(&format!("{path}.kind"), &w.kind, &WAIT_KINDS)?;
            text(&format!("{path}.who"), &w.who, MAX_SHORT, false)?;
            if w.kind == "session" {
                mention(&format!("{path}.who"), &w.who, facts, kept)?;
            }
            text(&format!("{path}.what"), &w.what, MAX_LINE, false)?;
        }
    }
    Ok(())
}

fn check_action(path: &str, a: &Action, part: &Part, old: Option<&Part>, who: &Who, facts: &Facts, others: &BTreeMap<String, Part>) -> Result<(), String> {
    ident(&format!("{path}.id"), &a.id)?;
    required(&format!("{path}.title"), &a.title, MAX_TITLE)?;
    if DERIVED_KINDS.contains(&a.kind.as_str()) {
        return refuse(&format!("{path}.kind"), format!("{:?} is built by the harness from the session's own prompt or report and cannot be published", a.kind));
    }
    one_of(&format!("{path}.kind"), &a.kind, &ACTION_KINDS)?;
    // The track it belongs to: one of the publisher's own. The root Supervisor
    // may leave it out or name another part's track (a cross-track action)
    let foreign = !a.track_by.is_empty() && a.track_by != who.key();
    if foreign && !who.root {
        return refuse(&format!("{path}.trackBy"), "names another session's part; only the Supervisor adds actions to tracks it did not publish");
    }
    let track = if a.track.is_empty() {
        if !who.root {
            return refuse(&format!("{path}.track"), "is required: the id of one of your tracks");
        }
        if !a.track_by.is_empty() {
            return refuse(&format!("{path}.trackBy"), "is given without track");
        }
        None
    } else {
        let tracks = if foreign { others.get(&a.track_by).map(|p| p.tracks.as_slice()).unwrap_or(&[]) } else { part.tracks.as_slice() };
        match tracks.iter().find(|t| t.id == a.track) {
            Some(t) => Some(t),
            None => return refuse(&format!("{path}.track"), format!("names {:?}, which is not a published track there", a.track)),
        }
    };
    let has = |item: &str| track.is_some_and(|t| t.items.iter().any(|i| i.id == item));
    if !a.item.is_empty() && !has(&a.item) {
        return refuse(&format!("{path}.item"), format!("names {:?}, which is not an item of that track", a.item));
    }
    if a.blocks.len() > MAX_LIST {
        return refuse(&format!("{path}.blocks"), format!("has more than {MAX_LIST} entries"));
    }
    if let Some((i, missing)) = a.blocks.iter().enumerate().find(|(_, b)| !has(b)) {
        return refuse(&format!("{path}.blocks[{i}]"), format!("names {missing:?}, which is not an item of that track"));
    }
    // Like a lead: checked when given or changed. The click checks it again (MCR-97)
    // An unchanged target is passed without it only when that session has
    // ended or is gone, so that the rest of the part can still be changed. A
    // target that still runs is checked at every publish: it may have been
    // bound to another supervisor since (MCR-97)
    let as_stored = old.is_some_and(|o| o.actions.iter().any(|b| b.id == a.id && b.place.session == a.place.session)) && !facts.sessions.get(&a.place.session).is_some_and(|f| !f.ended);
    if !a.place.session.is_empty() && !as_stored {
        let at = format!("{path}.where.session");
        reach(&at, &a.place.session, who, facts)?;
        if !facts.sessions.get(&a.place.session).is_some_and(|f| f.agent) {
            return refuse(&at, "names a session that is not an agent with a state (a shell, or a terminal without one)");
        }
    }
    // What a click may place or copy passes the allow-list here, and again at the click
    if !a.say.is_empty() {
        placeable(&a.say).or_else(|why| refuse(&format!("{path}.say"), why))?;
    }
    if !a.place.command.is_empty() {
        copyable(&a.place.command).or_else(|why| refuse(&format!("{path}.where.command"), why))?;
    }
    text(&format!("{path}.recommended"), &a.recommended, MAX_SHORT, false)?;
    text(&format!("{path}.why"), &a.why, MAX_WHY, false)?;
    text(&format!("{path}.detail"), &a.detail, MAX_DETAIL, true)?;
    list(&format!("{path}.source"), &a.source, MAX_LIST, MAX_REF)?;
    if !a.place.url.is_empty() {
        web_link(&a.place.url).map(|_| ()).or_else(|why| refuse(&format!("{path}.where.url"), why))?;
    }
    // What each kind may carry follows what a click on it will do (MCR-94).
    // The click itself is another slice (MCR-97), and must check again
    let kind = a.kind.as_str();
    let no = |field: &str, value: &str| if value.is_empty() { Ok(()) } else { refuse(&format!("{path}.{field}"), format!("does not go with kind {kind}")) };
    if kind != "typed_word" {
        no("say", &a.say)?;
    }
    if !matches!(kind, "secret_step" | "live_check") {
        no("where.command", &a.place.command)?;
    }
    if kind != "external" {
        no("where.url", &a.place.url)?;
    }
    if kind != "decision" && !(a.options.is_empty() && a.recommended.is_empty()) {
        return refuse(&format!("{path}.options"), format!("do not go with kind {kind}"));
    }
    match kind {
        "typed_word" => {
            if a.place.session.is_empty() {
                return refuse(&format!("{path}.where.session"), "is required for typed_word: the session whose input box gets the line");
            }
            if a.say.is_empty() {
                return refuse(&format!("{path}.say"), "is required");
            }
        }
        "decision" => {
            if a.options.len() < 2 || a.options.len() > MAX_OPTIONS {
                return refuse(&format!("{path}.options"), format!("must hold 2 to {MAX_OPTIONS} choices"));
            }
            for (i, option) in a.options.iter().enumerate() {
                placeable(option).or_else(|why| refuse(&format!("{path}.options[{i}]"), why))?;
                // What a click places is the whole line with the service's frame: it must fit too,
                // or the option would get a button that always refuses
                if decision_line(&a.id, option).chars().count() > MAX_PLACED {
                    return refuse(&format!("{path}.options[{i}]"), format!("is too long: with \"Decision {}: \" before it the line may hold {MAX_PLACED} characters", a.id));
                }
            }
            if !a.recommended.is_empty() && !a.options.contains(&a.recommended) {
                return refuse(&format!("{path}.recommended"), "is not one of the options");
            }
        }
        "secret_step" | "live_check" if a.detail.trim().is_empty() => return refuse(&format!("{path}.detail"), "is required: the steps, one per line"),
        "external" if a.place.url.is_empty() => return refuse(&format!("{path}.where.url"), "is required for external"),
        _ => {}
    }
    one_of(&format!("{path}.risk"), &a.risk, &RISKS)?;
    text(&format!("{path}.amount"), &a.amount, MAX_REF, false)?;
    if (a.risk == "spend") != !a.amount.trim().is_empty() {
        return refuse(&format!("{path}.amount"), "goes with risk spend, and only with it");
    }
    if !a.urgency.is_empty() {
        one_of(&format!("{path}.urgency"), &a.urgency, &URGENCIES)?;
    }
    Ok(())
}

/// Whether one session's part may stand as it is. `others` are the other parts.
/// `old` is what the session has published now: what stands there unchanged
/// is not held against sessions that ended since.
fn check_part(part: &Part, old: Option<&Part>, who: &Who, facts: &Facts, others: &BTreeMap<String, Part>) -> Result<(), String> {
    let kept: BTreeSet<&str> = old
        .into_iter()
        .flat_map(|o| o.tracks.iter())
        .flat_map(|t| t.items.iter())
        .flat_map(|i| [Some(i.owner.as_str()), i.waits_on.as_ref().filter(|w| w.kind == "session").map(|w| w.who.as_str())])
        .flatten()
        .collect();
    if part.tracks.len() > MAX_TRACKS {
        return refuse("tracks", format!("has more than {MAX_TRACKS} entries"));
    }
    if part.actions.len() > MAX_ACTIONS {
        return refuse("actions", format!("has more than {MAX_ACTIONS} entries"));
    }
    let mut ids = BTreeSet::new();
    for (i, t) in part.tracks.iter().enumerate() {
        check_track(&format!("tracks[{i}]"), t, old, &kept, who, facts)?;
        if !ids.insert(t.id.as_str()) {
            return refuse(&format!("tracks[{i}].id"), format!("{:?} is used twice", t.id));
        }
    }
    let mut ids = BTreeSet::new();
    for (i, a) in part.actions.iter().enumerate() {
        check_action(&format!("actions[{i}]"), a, part, old, who, facts, others)?;
        if part.needs.iter().any(|n| n.id == a.id) {
            return refuse(&format!("actions[{i}].id"), format!("{:?} is the id of a need you asked with report", a.id));
        }
        if !ids.insert(a.id.as_str()) {
            return refuse(&format!("actions[{i}].id"), format!("{:?} is used twice", a.id));
        }
    }
    let size = serde_json::to_vec(part).map(|b| b.len()).unwrap_or(usize::MAX);
    if size > MAX_PART_BYTES {
        return refuse("the document", format!("is {size} bytes; a session's part holds at most {MAX_PART_BYTES}"));
    }
    Ok(())
}

/// Where a need's answer goes: its actor, else the session that asked.
fn target<'a>(key: &'a str, need: &'a Need, facts: &'a Facts) -> Option<&'a str> {
    if !need.actor.is_empty() {
        Some(need.actor.as_str())
    } else if key == ROOT {
        facts.root.as_deref()
    } else {
        Some(key)
    }
}

/// The session a need points the operator at: where its answer goes, or
/// for a need without choices the session it names, else the one that asked.
fn need_session<'a>(key: &'a str, need: &'a Need, facts: &'a Facts) -> Option<&'a str> {
    if !need.place.session.is_empty() && need.actor.is_empty() {
        return Some(need.place.session.as_str());
    }
    target(key, need, facts)
}

/// `need:<part>/<id>`: the part and the id.
fn need_ref(r: &str) -> Option<(&str, &str)> {
    r.strip_prefix("need:")?.split_once('/')
}

/// Whether a need may stand as a session declares it (MCR-124). `part` is
/// the publisher's part as it is now, `all` every part.
fn check_need(path: &str, n: &Need, key: &str, part: &Part, who: &Who, facts: &Facts, all: &BTreeMap<String, Part>) -> Result<(), String> {
    ident(&format!("{path}.id"), &n.id)?;
    if part.actions.iter().any(|a| a.id == n.id) {
        return refuse(&format!("{path}.id"), format!("{:?} is the id of one of your cockpit actions", n.id));
    }
    if FACT_KINDS.contains(&n.ask.as_str()) || DERIVED_KINDS.contains(&n.ask.as_str()) {
        return refuse(&format!("{path}.ask"), format!("{:?} is built by the harness from what it knows (a prompt, an unsent line, a report, a wait) and cannot be declared", n.ask));
    }
    one_of(&format!("{path}.ask"), &n.ask, &NEED_KINDS)?;
    required("text", &n.text, MAX_LINE).map_err(|e| format!("{e}. With need, text is the question in one line; put the rest in need.detail"))?;
    let word = if n.word.is_empty() { "none" } else { n.word.as_str() };
    one_of(&format!("{path}.word"), word, &WORDS)?;
    let ask = n.ask.as_str();
    let choices = match ask {
        "decision" => 2..=MAX_OPTIONS,
        "go" => 1..=1,
        _ => 0..=0,
    };
    if !choices.contains(&n.options.len()) {
        return refuse(&format!("{path}.options"), match ask {
            "decision" => format!("must hold 2 to {MAX_OPTIONS} choices"),
            "go" => "must hold exactly one choice: the go".to_string(),
            _ => format!("do not go with ask {ask}: it has no choices"),
        });
    }
    if word != "none" && !matches!(ask, "go" | "decision") {
        return refuse(&format!("{path}.word"), "goes with ask go or decision: an owner word is a choice the operator makes");
    }
    let mut ids = BTreeSet::new();
    for (i, o) in n.options.iter().enumerate() {
        let at = format!("{path}.options[{i}]");
        ident(&format!("{at}.id"), &o.id)?;
        if !ids.insert(o.id.as_str()) {
            return refuse(&format!("{at}.id"), format!("{:?} is used twice", o.id));
        }
        one_of(&format!("{at}.risk"), &o.risk, &CHOICE_RISKS)?;
        text(&format!("{at}.amount"), &o.amount, MAX_REF, false)?;
        if (o.risk == "spend") != !o.amount.trim().is_empty() {
            return refuse(&format!("{at}.amount"), "goes with risk spend, and only with it");
        }
        text(&format!("{at}.effect"), &o.effect, MAX_LINE, false)?;
        // What a click places is the whole line with the service's frame: it must
        // pass and fit, or the choice would get a button that always refuses
        placeable(&o.label).or_else(|why| refuse(&format!("{at}.label"), why))?;
        placeable(&need_line(key, n, o)).or_else(|why| refuse(&format!("{at}.label"), format!("{why} (as the line placed: {})", if n.exact { "the label alone".to_string() } else { format!("\"{} {key}/{}: \" before it", if ask == "go" { "Go" } else { "Decision" }, n.id) })))?;
    }
    if n.options.iter().filter(|o| o.recommended).count() > 1 {
        return refuse(&format!("{path}.options"), "recommend at most one choice");
    }
    if n.exact && !(ask == "go" && word == "none" && n.options.iter().all(|o| o.risk == "reversible")) {
        return refuse(&format!("{path}.exact"), "goes only with ask go, word none and a reversible choice: an owner word is always placed with its frame");
    }
    let agent = |at: &str, id: &str| -> Result<(), String> {
        reach(at, id, who, facts)?;
        if facts.sessions.get(id).is_some_and(|f| f.agent) { Ok(()) } else { refuse(at, "names a session that is not an agent with a state (a shell, or a terminal without one)") }
    };
    if !n.actor.is_empty() {
        agent(&format!("{path}.actor"), &n.actor)?;
    }
    if !n.place.session.is_empty() {
        if matches!(ask, "decision" | "go") {
            return refuse(&format!("{path}.where.session"), "does not go with a choice: its answer goes to actor (you, when it is left out)");
        }
        agent(&format!("{path}.where.session"), &n.place.session)?;
    }
    if !n.place.command.is_empty() {
        if !matches!(ask, "secret_step" | "live_check") {
            return refuse(&format!("{path}.where.command"), format!("does not go with ask {ask}"));
        }
        copyable(&n.place.command).or_else(|why| refuse(&format!("{path}.where.command"), why))?;
    }
    if !n.place.url.is_empty() {
        if ask != "external" {
            return refuse(&format!("{path}.where.url"), format!("does not go with ask {ask}"));
        }
        web_link(&n.place.url).map(|_| ()).or_else(|why| refuse(&format!("{path}.where.url"), why))?;
    }
    match ask {
        "secret_step" | "live_check" if n.detail.trim().is_empty() => return refuse(&format!("{path}.detail"), "is required: the steps, one per line"),
        "external" if n.place.url.is_empty() => return refuse(&format!("{path}.where.url"), "is required for ask external"),
        _ => {}
    }
    // Where it belongs: one of the publisher's own tracks
    let track = if n.track.is_empty() {
        None
    } else {
        match part.tracks.iter().find(|t| t.id == n.track) {
            Some(t) => Some(t),
            None => return refuse(&format!("{path}.track"), format!("names {:?}, which is not one of your tracks", n.track)),
        }
    };
    if !n.item.is_empty() {
        let found = match track {
            Some(t) => t.items.iter().any(|i| i.id == n.item),
            None => part.tracks.iter().any(|t| t.items.iter().any(|i| i.id == n.item)),
        };
        if !found {
            return refuse(&format!("{path}.item"), format!("names {:?}, which is not an item of your tracks", n.item));
        }
    }
    let need_exists = |r: &str| need_ref(r).is_some_and(|(by, id)| (by == key && id == n.id) || all.get(by).is_some_and(|p| p.needs.iter().any(|x| x.id == id)));
    if n.blocks.len() > MAX_LIST {
        return refuse(&format!("{path}.blocks"), format!("has more than {MAX_LIST} entries"));
    }
    for (i, b) in n.blocks.iter().enumerate() {
        let item = b.strip_prefix("item:").and_then(|r| r.split_once('/')).is_some_and(|(t, i)| part.tracks.iter().any(|x| x.id == t && x.items.iter().any(|y| y.id == i)));
        if !item && !(need_exists(b) && need_ref(b) != Some((key, n.id.as_str()))) {
            return refuse(&format!("{path}.blocks[{i}]"), format!("names {b:?}, which is neither item:<track>/<item> of your tracks nor need:<part>/<id> of another need"));
        }
    }
    if n.cause.len() > MAX_LIST {
        return refuse(&format!("{path}.cause"), format!("has more than {MAX_LIST} entries"));
    }
    for (i, c) in n.cause.iter().enumerate() {
        let session = |id: &str| facts.sessions.contains_key(id);
        let ok = match c.split_once(':') {
            Some(("need", _)) => need_exists(c) && need_ref(c) != Some((key, n.id.as_str())),
            Some(("prompt" | "held", id)) => session(id),
            Some(("wait", id)) => facts.sessions.values().any(|f| f.waits.iter().any(|w| w.id == id)),
            Some(("report", id)) => facts.reports.contains_key(id),
            _ => false,
        };
        if !ok {
            return refuse(&format!("{path}.cause[{i}]"), format!("names {c:?}, which is not need:<part>/<id>, prompt:<session>, held:<session>, wait:<id> or report:<id> of something the harness has"));
        }
    }
    if n.refs.len() > MAX_LIST {
        return refuse(&format!("{path}.refs"), format!("has more than {MAX_LIST} entries"));
    }
    for (i, r) in n.refs.iter().enumerate() {
        if r.starts_with("https://") {
            web_link(r).map(|_| ()).or_else(|why| refuse(&format!("{path}.refs[{i}]"), why))?;
        } else {
            required(&format!("{path}.refs[{i}]"), r, MAX_REF)?;
        }
    }
    if !n.urgency.is_empty() {
        one_of(&format!("{path}.urgency"), &n.urgency, &URGENCIES)?;
    }
    if n.check_by > MAX_CHECK_BY {
        return refuse(&format!("{path}.checkBy"), format!("is more than {MAX_CHECK_BY} minutes (two weeks)"));
    }
    text(&format!("{path}.why"), &n.why, MAX_WHY, false)?;
    text(&format!("{path}.detail"), &n.detail, MAX_DETAIL, true)
}

const NEED_FIELDS: [&str; 16] = ["id", "ask", "options", "word", "exact", "actor", "where", "track", "item", "blocks", "cause", "refs", "urgency", "checkBy", "why", "detail"];
const CHOICE_FIELDS: [&str; 6] = ["id", "label", "recommended", "risk", "amount", "effect"];

fn known_need(path: &str, need: &Value) -> Result<(), String> {
    known(path, need, &NEED_FIELDS)?;
    known(&format!("{path}.where"), &need["where"], &WHERE_FIELDS)?;
    need["options"].as_array().into_iter().flatten().enumerate().try_for_each(|(i, o)| known(&format!("{path}.options[{i}]"), o, &CHOICE_FIELDS))
}

/// What a session sent, without the fields the service writes and without
/// what the service derived, so that a read document can be sent back.
fn clean(value: &mut Value) {
    match value {
        Value::Array(all) => {
            all.retain(|v| v.get("derived").is_none());
            all.iter_mut().for_each(clean);
        }
        Value::Object(fields) => {
            fields.retain(|key, v| !STAMPS.contains(&key.as_str()) && v.get("derived").is_none() && !v.is_null());
            fields.values_mut().for_each(clean);
        }
        _ => {}
    }
}

const TRACK_FIELDS: [&str; 7] = ["id", "title", "lead", "refs", "state", "line", "items"];
const ITEM_FIELDS: [&str; 7] = ["id", "title", "ref", "owner", "state", "waitsOn", "next"];
const WAIT_FIELDS: [&str; 3] = ["kind", "who", "what"];
const ACTION_FIELDS: [&str; 17] = ["id", "track", "trackBy", "item", "title", "kind", "where", "say", "options", "recommended", "why", "blocks", "risk", "amount", "urgency", "source", "detail"];
const WHERE_FIELDS: [&str; 3] = ["session", "url", "command"];
const ORDER_FIELDS: [&str; 2] = ["by", "id"];

/// What a session sends has the fields of the schema and no others. The
/// stored types do not say so themselves: they are also read from the store
/// file, which must load whatever a later build wrote (`load`).
fn known(path: &str, value: &Value, fields: &[&str]) -> Result<(), String> {
    match value.as_object().into_iter().flatten().map(|(key, _)| key).find(|key| !fields.contains(&key.as_str())) {
        Some(key) => refuse(path, format!("has no field {key:?}; it has: {}", fields.join(", "))),
        None => Ok(()),
    }
}

fn known_item(path: &str, item: &Value) -> Result<(), String> {
    known(path, item, &ITEM_FIELDS)?;
    known(&format!("{path}.waitsOn"), &item["waitsOn"], &WAIT_FIELDS)
}

fn known_track(path: &str, track: &Value) -> Result<(), String> {
    known(path, track, &TRACK_FIELDS)?;
    track["items"].as_array().into_iter().flatten().enumerate().try_for_each(|(i, item)| known_item(&format!("{path}.items[{i}]"), item))
}

fn known_action(path: &str, action: &Value) -> Result<(), String> {
    known(path, action, &ACTION_FIELDS)?;
    known(&format!("{path}.where"), &action["where"], &WHERE_FIELDS)
}

fn known_order(path: &str, entry: &Value) -> Result<(), String> {
    known(path, entry, &ORDER_FIELDS)
}

/// One entry, or a list of them, as a session sent it: held to the schema's
/// fields (`shape`), then read.
fn parse<T: serde::de::DeserializeOwned>(path: &str, mut value: Value, shape: fn(&str, &Value) -> Result<(), String>) -> Result<T, String> {
    clean(&mut value);
    match &value {
        Value::Array(all) => all.iter().enumerate().try_for_each(|(i, entry)| shape(&format!("{path}[{i}]"), entry))?,
        one => shape(path, one)?,
    }
    serde_json::from_value(value).map_err(|e| format!("Refused: {path} does not fit the schema: {e}"))
}

/// The service's stamps on a part that is about to replace `old`: an entry
/// that did not change keeps its times.
fn stamp(part: &mut Part, old: Option<&Part>, now: u64) {
    part.updated = now;
    for track in &mut part.tracks {
        let before = old.and_then(|o| o.tracks.iter().find(|t| t.id == track.id));
        for item in &mut track.items {
            let was = before.and_then(|t| t.items.iter().find(|i| i.id == item.id)).and_then(|i| i.waits_on.as_ref());
            if let Some(w) = &mut item.waits_on {
                w.since = was.filter(|o| o.kind == w.kind && o.who == w.who && o.what == w.what).map(|o| o.since).unwrap_or(now);
            }
        }
        track.updated = before.filter(|b| Track { updated: 0, ..(*b).clone() } == Track { updated: 0, ..track.clone() }).map(|b| b.updated).unwrap_or(now);
    }
    for action in &mut part.actions {
        let before = old.and_then(|o| o.actions.iter().find(|a| a.id == action.id));
        action.since = before.map(|b| b.since).unwrap_or(now);
        action.updated = before.filter(|b| Action { updated: 0, ..(*b).clone() } == Action { updated: 0, since: b.since, ..action.clone() }).map(|b| b.updated).unwrap_or(now);
    }
}

/// `given` laid over `old`: the fields it names replace, the others stay.
fn overlay(old: Option<Value>, given: &Value) -> Value {
    let mut out = old.filter(Value::is_object).unwrap_or_else(|| json!({}));
    for (key, value) in given.as_object().into_iter().flatten() {
        out[key.as_str()] = value.clone();
    }
    out
}

impl Cockpit {
    /// Any hosted session publishes its own part, with executors or without
    /// (owner's decision of 2026-11-19), as long as it is this structure: the
    /// schema and its checks are the condition, not who asks.
    fn may_write(&mut self, who: &Who, facts: &Facts, now: u64) -> Result<(), String> {
        if !facts.sessions.get(who.id).is_some_and(|f| !f.ended) {
            return Err("Refused: the harness does not track this session as running".into());
        }
        let sent = self.writes.entry(who.id.into()).or_default();
        while sent.front().is_some_and(|t| *t + WRITE_WINDOW_MS <= now) {
            sent.pop_front();
        }
        if sent.len() >= MAX_WRITES {
            return Err(format!("Refused: this session changed the cockpit {MAX_WRITES} times in ten minutes. Publish when something changed for the operator, not at every step."));
        }
        Ok(())
    }

    fn others(&self, key: &str) -> BTreeMap<String, Part> {
        self.parts.iter().filter(|(k, _)| k.as_str() != key).map(|(k, p)| (k.clone(), p.clone())).collect()
    }

    /// Stores a checked part and what follows from it.
    fn accept(&mut self, who: &Who, mut part: Part, now: u64) -> Value {
        let key = who.key().to_string();
        stamp(&mut part, self.parts.get(&key), now);
        if part.is_empty() {
            self.parts.remove(&key);
        } else {
            self.parts.insert(key, part);
        }
        self.wrote(who.id, now)
    }

    fn wrote(&mut self, id: &str, now: u64) -> Value {
        self.tidy();
        self.schema = SCHEMA;
        self.version += 1;
        self.updated = now;
        self.writes.entry(id.into()).or_default().push_back(now);
        json!({ "version": self.version, "tracks": self.parts.values().map(|p| p.tracks.len()).sum::<usize>(), "actions": self.parts.values().map(|p| p.actions.len()).sum::<usize>() })
    }

    /// The order names only tracks that exist.
    fn tidy(&mut self) {
        let parts = &self.parts;
        self.order.retain(|r| parts.get(&r.by).is_some_and(|p| p.tracks.iter().any(|t| t.id == r.id)));
    }

    /// `cockpit_publish`: the caller's tracks and actions, in place of what it
    /// published before. The root Supervisor may also give the order of all tracks.
    pub fn publish(&mut self, who: &Who, facts: &Facts, args: &Value, now: u64) -> Result<Value, String> {
        self.may_write(who, facts, now)?;
        if let Some(extra) = args.as_object().into_iter().flatten().map(|(k, _)| k).find(|k| !matches!(k.as_str(), "tracks" | "actions" | "order")) {
            return refuse(extra, "is not a field of cockpit_publish (tracks, actions, order)");
        }
        let field = |name: &str| args.get(name).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!([]));
        // Needs come through `report`, not here: they stay as they are
        let needs = self.parts.get(who.key()).map(|p| p.needs.clone()).unwrap_or_default();
        let mut part = Part { tracks: parse("tracks", field("tracks"), known_track)?, actions: parse("actions", field("actions"), known_action)?, needs, updated: 0 };
        for track in part.tracks.iter_mut().filter(|t| t.lead.is_empty()) {
            track.lead = who.id.into();
        }
        let others = self.others(who.key());
        check_part(&part, self.parts.get(who.key()), who, facts, &others)?;
        let order: Option<Vec<TrackRef>> = match args.get("order").filter(|v| !v.is_null()) {
            None => None,
            Some(_) if !who.root => return refuse("order", "is the Supervisor's: a session orders nothing but its own tracks, by their place in tracks"),
            // Not through `parse`: `by` is a field here, and a stamp everywhere else
            Some(given) => {
                given.as_array().into_iter().flatten().enumerate().try_for_each(|(i, entry)| known_order(&format!("order[{i}]"), entry))?;
                Some(serde_json::from_value(given.clone()).map_err(|e| format!("Refused: order does not fit the schema: {e}"))?)
            }
        };
        if let Some(order) = &order {
            for (i, r) in order.iter().enumerate() {
                let tracks = if r.by == ROOT { Some(&part.tracks) } else { others.get(&r.by).map(|p| &p.tracks) };
                if !tracks.is_some_and(|all| all.iter().any(|t| t.id == r.id)) {
                    return refuse(&format!("order[{i}]"), format!("names track {:?} of {:?}, which is not published", r.id, r.by));
                }
                if order[..i].contains(r) {
                    return refuse(&format!("order[{i}]"), "is named twice");
                }
            }
        }
        if let Some(order) = order {
            self.order = order;
        }
        Ok(self.accept(who, part, now))
    }

    /// `cockpit_patch`: one track, item or action of the caller's part, set
    /// (the fields given replace, the others stay) or removed.
    pub fn patch(&mut self, who: &Who, facts: &Facts, args: &Value, now: u64) -> Result<Value, String> {
        self.may_write(who, facts, now)?;
        if let Some(extra) = args.as_object().into_iter().flatten().map(|(k, _)| k).find(|k| !matches!(k.as_str(), "track" | "item" | "action" | "of" | "remove" | "id" | "by")) {
            return refuse(extra, "is not a field of cockpit_patch");
        }
        let given: Vec<&str> = ["track", "item", "action", "remove"].into_iter().filter(|k| args.get(*k).is_some_and(|v| !v.is_null())).collect();
        let [what] = given[..] else {
            return Err("Refused: give exactly one of track, item, action or remove".into());
        };
        let word = |key: &str| args[key].as_str().filter(|s| !s.is_empty());
        // The Supervisor clears away what another session left: a track with
        // its publisher's actions on it, or one action. It edits nothing there
        if let Some(by) = word("by").filter(|by| *by != who.key()) {
            if !who.root || what != "remove" {
                return refuse("by", "names another session's part; only the Supervisor may, and only to remove a track or an action");
            }
            let id = word("id").ok_or("Refused: id is required")?;
            let part = self.parts.get_mut(by).ok_or_else(|| format!("Refused: by names {by:?}, which published nothing"))?;
            let before = (part.tracks.len(), part.actions.len());
            match args["remove"].as_str() {
                Some("track") => {
                    part.tracks.retain(|t| t.id != id);
                    part.actions.retain(|a| a.track != id || !(a.track_by.is_empty() || a.track_by == by));
                }
                Some("action") => part.actions.retain(|a| a.id != id),
                _ => return refuse("remove", "must be track or action for another session's part"),
            }
            if before == (part.tracks.len(), part.actions.len()) {
                return refuse("id", format!("names {id:?}, which is not there"));
            }
            part.updated = now;
            if part.is_empty() {
                self.parts.remove(by);
            }
            return Ok(self.wrote(who.id, now));
        }
        let mut part = self.parts.get(who.key()).cloned().unwrap_or_default();
        let entry = |value: &Value| value.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| format!("Refused: {what}.id is required"));
        let own_track = |part: &Part| -> Result<usize, String> {
            let of = word("of").ok_or("Refused: of is required: the id of the track the item is in")?;
            part.tracks.iter().position(|t| t.id == of).ok_or_else(|| format!("Refused: of names {of:?}, which is not one of your tracks"))
        };
        match what {
            "track" => {
                let id = entry(&args["track"])?;
                let at = part.tracks.iter().position(|t| t.id == id);
                let mut track: Track = parse("track", overlay(at.and_then(|i| serde_json::to_value(&part.tracks[i]).ok()), &args["track"]), known_track)?;
                if track.lead.is_empty() {
                    track.lead = who.id.into();
                }
                match at {
                    Some(i) => part.tracks[i] = track,
                    None => part.tracks.push(track),
                }
            }
            "item" => {
                let id = entry(&args["item"])?;
                let track = own_track(&part)?;
                let items = &mut part.tracks[track].items;
                let at = items.iter().position(|i| i.id == id);
                let item: Item = parse("item", overlay(at.and_then(|i| serde_json::to_value(&items[i]).ok()), &args["item"]), known_item)?;
                match at {
                    Some(i) => items[i] = item,
                    None => items.push(item),
                }
            }
            "action" => {
                let id = entry(&args["action"])?;
                let at = part.actions.iter().position(|a| a.id == id);
                let action: Action = parse("action", overlay(at.and_then(|i| serde_json::to_value(&part.actions[i]).ok()), &args["action"]), known_action)?;
                match at {
                    Some(i) => part.actions[i] = action,
                    None => part.actions.push(action),
                }
            }
            _ => {
                let id = word("id").ok_or("Refused: id is required")?;
                let before = (part.tracks.len(), part.actions.len(), part.tracks.iter().map(|t| t.items.len()).sum::<usize>());
                match args["remove"].as_str() {
                    Some("track") => part.tracks.retain(|t| t.id != id),
                    Some("action") => part.actions.retain(|a| a.id != id),
                    Some("item") => {
                        let track = own_track(&part)?;
                        part.tracks[track].items.retain(|i| i.id != id);
                    }
                    _ => return refuse("remove", "must be track, item or action"),
                }
                if before == (part.tracks.len(), part.actions.len(), part.tracks.iter().map(|t| t.items.len()).sum::<usize>()) {
                    return refuse("id", format!("names {id:?}, which is not there"));
                }
            }
        }
        // The whole part must still stand: an action of a removed track is refused here
        check_part(&part, self.parts.get(who.key()), who, facts, &self.others(who.key()))?;
        Ok(self.accept(who, part, now))
    }

    /// `report` with a need (MCR-124): the caller asks the operator. A need of
    /// the same id is replaced, and every declaration is a new one (`updated`).
    /// `text` is the report's text, the question. Checked on its own: the
    /// report is recorded only after this passed, and named with `cite`.
    pub fn declare(&mut self, who: &Who, facts: &Facts, need: &Value, said: &str, now: u64) -> Result<Value, String> {
        self.may_write(who, facts, now)?;
        if !need.is_object() {
            return refuse("need", "must be an object: id, ask and what goes with it");
        }
        let mut n: Need = parse("need", need.clone(), known_need)?;
        n.text = said.trim().to_string();
        let key = who.key().to_string();
        let mut part = self.parts.get(&key).cloned().unwrap_or_default();
        part.needs.retain(|x| x.open() || now.saturating_sub(x.closed.as_ref().map_or(0, |c| c.at)) < CLOSED_KEPT_MS);
        check_need("need", &n, &key, &part, who, facts, &self.parts)?;
        let before = part.needs.iter().position(|x| x.id == n.id);
        n.since = before.map(|i| &part.needs[i]).filter(|x| x.open()).map_or(now, |x| x.since);
        n.updated = now;
        match before {
            Some(i) => part.needs[i] = n,
            None => part.needs.push(n),
        }
        if part.needs.iter().filter(|x| x.open()).count() > MAX_NEEDS {
            return refuse("need", format!("would be your {}th open need; close some first (report kind closed)", MAX_NEEDS + 1));
        }
        let size = serde_json::to_vec(&part).map(|b| b.len()).unwrap_or(usize::MAX);
        if size > MAX_PART_BYTES {
            return refuse("need", format!("would make your part {size} bytes; it holds at most {MAX_PART_BYTES}"));
        }
        part.updated = now;
        self.parts.insert(key, part);
        Ok(self.wrote(who.id, now))
    }

    /// The report a declared need comes from: its first cause, so that the
    /// need stands for that report and no second row is shown for it.
    pub fn cite(&mut self, who: &Who, id: &str, report: &str) {
        if let Some(n) = self.parts.get_mut(who.key()).and_then(|p| p.needs.iter_mut().find(|n| n.id == id && n.open())) {
            n.cause.insert(0, format!("report:{report}"));
        }
    }

    /// The publisher ends one of its needs (`report` kind `closed`, or `done`
    /// with `need`). Its record of how; it is nobody's consent.
    /// `how.at` is now.
    pub fn close(&mut self, who: &Who, facts: &Facts, id: &str, how: Closed) -> Result<Value, String> {
        let now = how.at;
        self.may_write(who, facts, now)?;
        one_of("outcome", &how.outcome, &OUTCOMES)?;
        text("text", &how.note, MAX_LINE, false).map_err(|e| format!("{e}. With kind closed, text is a short note on how it ended"))?;
        let chosen = how.chosen.as_str();
        let need = self.parts.get_mut(who.key()).and_then(|p| p.needs.iter_mut().find(|n| n.id == id && n.open()));
        let Some(need) = need else {
            return refuse("need", format!("names {id:?}, which is not an open need of yours"));
        };
        if !chosen.is_empty() && !need.options.iter().any(|o| o.id == chosen) {
            return refuse("chosen", format!("names {chosen:?}, which is not a choice of that need"));
        }
        need.closed = Some(Closed { note: how.note.trim().into(), ..how });
        if let Some(p) = self.parts.get_mut(who.key()) {
            p.updated = now;
        }
        Ok(self.wrote(who.id, now))
    }

    /// Whether `id` is an open need of the caller.
    pub fn has_need(&self, who: &Who, id: &str) -> bool {
        self.parts.get(who.key()).is_some_and(|p| p.needs.iter().any(|n| n.id == id && n.open()))
    }

    /// A restarted session has a new id: its part and every mention follow it.
    pub fn moved(&mut self, from: &str, to: &str) {
        if let Some(part) = self.parts.remove(from) {
            self.parts.insert(to.into(), part);
        }
        let rename = |s: &mut String| {
            if s == from {
                *s = to.into();
            }
        };
        self.order.iter_mut().for_each(|r| rename(&mut r.by));
        for part in self.parts.values_mut() {
            for track in &mut part.tracks {
                rename(&mut track.lead);
                for item in &mut track.items {
                    rename(&mut item.owner);
                    if let Some(w) = item.waits_on.as_mut().filter(|w| w.kind == "session") {
                        rename(&mut w.who);
                    }
                }
            }
            for action in &mut part.actions {
                rename(&mut action.track_by);
                rename(&mut action.place.session);
            }
            for need in &mut part.needs {
                rename(&mut need.actor);
                rename(&mut need.place.session);
                for r in need.cause.iter_mut().chain(need.blocks.iter_mut()) {
                    let moved = match r.split_once(':') {
                        Some((kind @ ("prompt" | "held"), id)) if id == from => Some(format!("{kind}:{to}")),
                        Some(("need", rest)) => rest.split_once('/').filter(|(by, _)| *by == from).map(|(_, id)| format!("need:{to}/{id}")),
                        _ => None,
                    };
                    if let Some(m) = moved {
                        *r = m;
                    }
                }
            }
        }
        if let Some(sent) = self.writes.remove(from) {
            self.writes.insert(to.into(), sent);
        }
    }

    /// Sessions were forgotten: what they published goes with them. Returns
    /// true when that changed the document.
    pub fn keep(&mut self, tracked: impl Fn(&str) -> bool) -> bool {
        let before = self.parts.len();
        self.parts.retain(|key, _| key == ROOT || tracked(key));
        self.writes.retain(|key, _| tracked(key));
        if self.parts.len() == before {
            return false;
        }
        self.tidy();
        self.version += 1;
        true
    }

    /// What a click on an action is to do (MCR-97), from the stored document
    /// and the facts at this moment. `updated` is the stamp the panel showed:
    /// an action published again since is another action. Everything a
    /// publish checked is checked again, because the world moved since: the
    /// text against the allow-list, the target against who may point at it
    /// now. Whether that session can take a line at this moment (idle, an
    /// empty input box, nothing being typed) is the service's to check: it
    /// needs the terminal.
    pub fn act(&self, by: &str, id: &str, updated: u64, act: Act, facts: &Facts) -> Result<Deed, String> {
        if let Some(n) = self.parts.get(by).and_then(|p| p.needs.iter().find(|n| n.id == id)) {
            return self.act_need(by, n, updated, act, facts);
        }
        let Some(a) = self.parts.get(by).and_then(|p| p.actions.iter().find(|a| a.id == id)) else {
            return Err("Refused: that action is no longer published. Look at the cockpit again.".into());
        };
        if a.updated != updated {
            return Err("Refused: that action was published again since the panel showed it. Look at it again.".into());
        }
        // The publisher's own box: the Supervisor session's for the Supervisor's part
        let publisher = || if by == ROOT { facts.root.clone().ok_or("Refused: the Supervisor session does not run".to_string()) } else { Ok(by.to_string()) };
        let into = |session: String, text: String| -> Result<Deed, String> {
            let Some(fact) = facts.sessions.get(&session).filter(|f| !f.ended) else {
                return Err("Refused: the session this would be typed into has ended or is gone.".into());
            };
            if !fact.agent {
                return Err("Refused: that session is not an agent with an input box.".into());
            }
            // Who may point the operator there, now: the Supervisor anywhere, a session at itself and below
            if by != ROOT && session != by && !fact.above.iter().any(|s| s == by) {
                return Err("Refused: that session no longer works for the session that published this action.".into());
            }
            placeable(&text).map_err(|why| format!("Refused: the line {why}."))?;
            Ok(Deed::Type { session, text })
        };
        match act {
            Act::Place | Act::Choose(_) if self.outdated(facts).iter().any(|o| !o.track && !o.need && o.by == by && o.id == id) => {
                Err("Refused: you typed into that session after this was published, or it has ended. Its publisher has to update the action first.".into())
            }
            Act::Place if a.kind == "typed_word" && !a.place.session.is_empty() => into(a.place.session.clone(), a.say.clone()),
            Act::Choose(n) if a.kind == "decision" => {
                let Some(option) = a.options.get(n) else { return Err("Refused: that action has no such option.".into()) };
                // The option alone must pass: the frame around it is the service's
                placeable(option).map_err(|why| format!("Refused: the option {why}."))?;
                let session = if a.place.session.is_empty() { publisher()? } else { a.place.session.clone() };
                into(session, decision_line(&a.id, option))
            }
            Act::Ask => into(publisher()?, ask_line(&a.id)),
            Act::Link if !a.place.url.is_empty() => web_link(&a.place.url).map(Deed::Link).map_err(|why| format!("Refused: the link {why}.")),
            Act::Copy if !a.place.command.is_empty() => copyable(&a.place.command).map(|()| Deed::Copy(a.place.command.clone())).map_err(|why| format!("Refused: the command {why}.")),
            _ => Err("Refused: that action has nothing of this kind to click.".into()),
        }
    }

    /// A click on a need as the panel shows it (MCR-124). The answer goes to
    /// the acting session as a line the service builds; nothing of the need's
    /// text but a checked label is in it. A guarded need (an owner word, or a
    /// choice that risks more than a step back) is not placed by a click in
    /// this slice: the operator types it in the acting session.
    fn act_need(&self, by: &str, n: &Need, updated: u64, act: Act, facts: &Facts) -> Result<Deed, String> {
        if !n.open() {
            return Err("Refused: that need is closed. Look at the cockpit again.".into());
        }
        if n.updated != updated {
            return Err("Refused: that need was asked again since the panel showed it. Look at it again.".into());
        }
        let publisher = || if by == ROOT { facts.root.clone().ok_or("Refused: the Supervisor session does not run".to_string()) } else { Ok(by.to_string()) };
        let answer = |choice: &Choice| -> Result<Deed, String> {
            if self.outdated(facts).iter().any(|o| o.need && o.by == by && o.id == n.id) {
                return Err("Refused: you typed into that session after this was asked, or it has ended. The session that asked has to ask again or close it.".into());
            }
            if n.guarded() {
                return Err("Refused: this asks for an owner word, or a choice that cannot simply be undone. Type it yourself in the terminal of the session that acts on it; a click does not place it.".into());
            }
            let session = target(by, n, facts).map(str::to_owned).ok_or("Refused: the Supervisor session does not run")?;
            type_into(by, session, need_line(by, n, choice), facts)
        };
        match act {
            Act::Place if n.ask == "go" => answer(&n.options[0]),
            Act::Choose(i) if matches!(n.ask.as_str(), "decision" | "go") => answer(n.options.get(i).ok_or("Refused: that need has no such choice.")?),
            Act::Ask => type_into(by, publisher()?, ask_line(&format!("{by}/{}", n.id)), facts),
            Act::Link if !n.place.url.is_empty() => web_link(&n.place.url).map(Deed::Link).map_err(|why| format!("Refused: the link {why}.")),
            Act::Copy if !n.place.command.is_empty() => copyable(&n.place.command).map(|()| Deed::Copy(n.place.command.clone())).map_err(|why| format!("Refused: the command {why}.")),
            _ => Err("Refused: that need has nothing of this kind to click.".into()),
        }
    }

    /// The entries the harness knows to be behind their text, see `Outdated`:
    /// an action with a session to act in, and a track that says it waits
    /// for the operator, by its lead. An ended lead is not one: the track
    /// may wait for the operator elsewhere.
    pub fn outdated(&self, facts: &Facts) -> Vec<Outdated> {
        let typed_after = |session: &str, updated: u64| facts.sessions.get(session).filter(|f| !f.ended).and_then(|f| f.typed).filter(|at| *at > updated);
        let mut out = Vec::new();
        for (key, part) in &self.parts {
            // The operator talks to the Supervisor in its terminal all day: a
            // line typed there says nothing about an entry of the Supervisor's
            // own that points at the Supervisor itself. Such an entry is never
            // marked as typed for; the Supervisor has read every such line
            let own = |session: &str| key == ROOT && facts.root.as_deref() == Some(session);
            for t in part.tracks.iter().filter(|t| t.state == "waiting_human" && !own(&t.lead)) {
                if let Some(at) = typed_after(&t.lead, t.updated) {
                    out.push(Outdated { by: key.clone(), track: true, need: false, id: t.id.clone(), updated: t.updated, session: t.lead.clone(), typed: Some(at) });
                }
            }
            for a in part.actions.iter().filter(|a| !a.place.session.is_empty()) {
                let session = &a.place.session;
                let typed = match facts.sessions.get(session) {
                    Some(f) if !f.ended => match typed_after(session, a.updated).filter(|_| !own(session)) {
                        Some(at) => Some(at),
                        None => continue,
                    },
                    _ => None,
                };
                out.push(Outdated { by: key.clone(), track: false, need: false, id: a.id.clone(), updated: a.updated, session: session.clone(), typed });
            }
            // A need is behind when the operator typed where its answer goes (the
            // session that asked, by default), or that session is no more
            for n in part.needs.iter().filter(|n| n.open()) {
                let Some(session) = need_session(key, n, facts) else { continue };
                let typed = match facts.sessions.get(session) {
                    Some(f) if !f.ended => match typed_after(session, n.updated).filter(|_| !own(session)) {
                        Some(at) => Some(at),
                        None => continue,
                    },
                    _ => None,
                };
                out.push(Outdated { by: key.clone(), track: false, need: true, id: n.id.clone(), updated: n.updated, session: session.to_string(), typed });
            }
        }
        out
    }

    /// Whether the document points the operator at a session: an action to
    /// do there, or a track it leads that says it waits for them. The
    /// service keeps the time of an Enter there exactly for such a session.
    pub fn points_at(&self, session: &str) -> bool {
        self.parts.iter().any(|(key, p)| {
            p.actions.iter().any(|a| a.place.session == session)
                || p.tracks.iter().any(|t| t.lead == session && t.state == "waiting_human")
                || p.needs.iter().filter(|n| n.open()).any(|n| n.actor == session || n.place.session == session || (n.actor.is_empty() && key == session))
        })
    }

    /// The document as it is shown: the published parts flattened, in order,
    /// joined with what the harness knows. `reader` is a hosted session that
    /// is not the Supervisor: it gets its own part and those of the sessions
    /// below it. `None` reads everything (the app, the Supervisor).
    pub fn read(&self, facts: &Facts, reader: Option<&str>) -> Value {
        let below = |id: &str| reader.is_none_or(|me| id == me || facts.sessions.get(id).is_some_and(|f| f.above.iter().any(|s| s == me)));
        let shown = |key: &str| if key == ROOT { reader.is_none() } else { below(key) };
        // What the harness knows about every session the document names
        let mut named: BTreeSet<&str> = BTreeSet::new();
        let mut tracks: Vec<(usize, Value)> = Vec::new();
        let mut actions: Vec<Value> = Vec::new();
        // A published action stands for a report it names only when its
        // publisher is the reporting session, a session above it or the
        // Supervisor: otherwise any session could make another tree's
        // "needs you" disappear by naming its id
        let stands = |key: &str, report: &str| facts.reports.get(report).is_some_and(|by| key == ROOT || key == by || facts.sessions.get(by).is_some_and(|f| f.above.iter().any(|s| s == key)));
        // A need is shown with its part, and to the session it names as its
        // actor, which acts on the answer (MCR-124, M3)
        let visible = |key: &str, n: &Need| n.open() && (shown(key) || reader.is_some_and(|me| n.actor == me));
        let cited: BTreeSet<&str> = self
            .parts
            .iter()
            .filter(|(k, _)| shown(k))
            .flat_map(|(key, p)| p.actions.iter().flat_map(|a| a.source.iter()).filter(|s| stands(key, s)).map(String::as_str))
            .chain(self.parts.iter().flat_map(|(key, p)| {
                p.needs.iter().filter(|n| visible(key, n)).flat_map(|n| n.cause.iter()).filter_map(|c| c.strip_prefix("report:")).filter(|r| stands(key, r))
            }))
            .collect();
        // What the harness knows better than the text, on the entry itself (MCR-103)
        let outdated = self.outdated(facts);
        let mark = |out: &mut Value, key: &str, track: bool, need: bool, id: &str| {
            // When the operator typed in a session is that session's own to tell:
            // only for the reader's sessions. That a session an entry of the
            // reader's part points at is no more is the reader's to know, also
            // when the harness has forgotten it and can say nothing else of it
            if let Some(o) = outdated.iter().find(|o| o.by == key && o.track == track && o.need == need && o.id == id && (o.typed.is_none() || below(&o.session))) {
                match o.typed {
                    Some(at) => out["ownerTyped"] = json!(at),
                    None => out["sessionEnded"] = json!(true),
                }
            }
        };
        for (key, part) in self.parts.iter().filter(|(k, _)| shown(k)) {
            if key != ROOT {
                named.insert(key.as_str());
            }
            for track in &part.tracks {
                named.insert(track.lead.as_str());
                let mut out = json!(track);
                out["by"] = json!(key);
                mark(&mut out, key, true, false, &track.id);
                for (i, item) in track.items.iter().enumerate() {
                    if item.owner != "human" {
                        named.insert(item.owner.as_str());
                    }
                    match &item.waits_on {
                        Some(w) if w.kind == "session" => {
                            named.insert(w.who.as_str());
                        }
                        Some(_) => {}
                        // Nothing published: what its owner registered with wait_register stands in.
                        // Not on an item that is done: it waits for nothing
                        None if item.state == "done" => {}
                        None => {
                            if let Some(w) = facts.sessions.get(&item.owner).filter(|f| !f.ended && below(&item.owner)).and_then(|f| f.waits.first()) {
                                out["items"][i]["waitsOn"] = json!({ "kind": wait_kind(&w.kind), "what": w.on, "ref": w.reference, "since": w.since, "overdue": w.overdue, "derived": "wait", "wait": w.id });
                            }
                        }
                    }
                }
                let place = self.order.iter().position(|r| r.by == *key && r.id == track.id).unwrap_or(usize::MAX);
                tracks.push((place, out));
            }
            for action in &part.actions {
                let mut out = json!(action);
                out["by"] = json!(key);
                mark(&mut out, key, false, false, &action.id);
                // What of it a click would refuse by its text alone: stored before
                // the allow-list, or under an earlier one. Shown as text, without a button
                let mut unclickable: Vec<&str> = Vec::new();
                if !action.say.is_empty() && placeable(&action.say).is_err() {
                    unclickable.push("say");
                }
                if action.options.iter().any(|o| placeable(o).is_err()) {
                    unclickable.push("options");
                }
                if !action.place.url.is_empty() && web_link(&action.place.url).is_err() {
                    unclickable.push("url");
                }
                if !action.place.command.is_empty() && copyable(&action.place.command).is_err() {
                    unclickable.push("command");
                }
                if !unclickable.is_empty() {
                    out["unclickable"] = json!(unclickable);
                }
                if !action.place.session.is_empty() {
                    named.insert(action.place.session.as_str());
                }
                let by = if action.track_by.is_empty() { key.as_str() } else { action.track_by.as_str() };
                if !action.track.is_empty() && !self.parts.get(by).is_some_and(|p| p.tracks.iter().any(|t| t.id == action.track)) {
                    out["trackMissing"] = json!(true);
                }
                // It says it comes from a report: whether that report is still open
                let own: Vec<&String> = action.source.iter().filter(|s| stands(key, s)).collect();
                if !own.is_empty() {
                    let open = facts.sessions.values().any(|f| f.needs_human.as_ref().is_some_and(|(id, ..)| own.contains(&id)));
                    out["live"] = json!({ "reportOpen": open });
                }
                actions.push(out);
            }
        }
        // Needs (MCR-124): in full for the one view, and as the action they would
        // have been for a panel that knows only actions (M5). The action form
        // points at the session the answer goes to, so the harness's facts of
        // that session join it as they join an action
        let mut asked: BTreeMap<(String, String), Value> = BTreeMap::new();
        for (key, part) in &self.parts {
            for n in part.needs.iter().filter(|n| visible(key, n)) {
                if key != ROOT {
                    named.insert(key.as_str());
                }
                for s in [&n.actor, &n.place.session] {
                    if !s.is_empty() {
                        named.insert(s.as_str());
                    }
                }
                let mut full = json!(n);
                full["by"] = json!(key);
                full["risk"] = json!(n.risk());
                full["guarded"] = json!(n.guarded());
                mark(&mut full, key, false, true, &n.id);
                let mut unclickable: Vec<&str> = Vec::new();
                if n.guarded() || n.options.iter().any(|o| placeable(&need_line(key, n, o)).is_err()) {
                    unclickable.push(if n.exact { "say" } else { "options" });
                }
                if !n.place.url.is_empty() && web_link(&n.place.url).is_err() {
                    unclickable.push("url");
                }
                if !n.place.command.is_empty() && copyable(&n.place.command).is_err() {
                    unclickable.push("command");
                }
                if !unclickable.is_empty() {
                    full["unclickable"] = json!(unclickable);
                }
                let mut compat = compat_action(key, n, facts);
                for stamp in ["ownerTyped", "sessionEnded", "unclickable"] {
                    if let Some(v) = full.get(stamp) {
                        compat[stamp] = v.clone();
                    }
                }
                let reports: Vec<&str> = n.cause.iter().filter_map(|c| c.strip_prefix("report:")).filter(|r| stands(key, r)).collect();
                if !reports.is_empty() {
                    let open = facts.sessions.values().any(|f| f.needs_human.as_ref().is_some_and(|(id, ..)| reports.contains(&id.as_str())));
                    compat["live"] = json!({ "reportOpen": open });
                }
                if let Some(s) = compat["where"]["session"].as_str() {
                    if !s.is_empty() {
                        named.insert(facts.sessions.get_key_value(s).map(|(k, _)| k.as_str()).unwrap_or(""));
                    }
                }
                asked.insert((key.clone(), n.id.clone()), full);
                actions.push(compat);
            }
        }
        named.remove("");
        let mut finished: Vec<Value> = Vec::new();
        // What needs the operator by the harness's own knowledge, whoever published what
        // (MCR-118): a prompt, the operator's unsent line, an open needs_human report and a
        // human wait past its time. All of a session's facts go into a published action that
        // points the operator at that session, when the action still stands and its publisher
        // stands for the session (the session itself, one above it, the Supervisor: as `stands`
        // for reports, so no session can hide another tree's row); otherwise each is a row of its own
        for (id, fact) in facts.sessions.iter().filter(|(id, f)| !f.ended && below(id)) {
            let who = if fact.name.is_empty() { "A session" } else { fact.name.as_str() };
            let mut live = serde_json::Map::new();
            let mut rows = Vec::new();
            if let Some(since) = fact.prompt {
                live.insert("prompt".into(), json!(since));
                rows.push(json!({
                    "id": format!("prompt:{id}"), "kind": "answer_prompt", "derived": "prompt", "where": { "session": id }, "since": since,
                    "title": format!("{who} asks for your answer in its terminal"),
                }));
            }
            // Not the Supervisor's own: its input box is right under the panel, and the owner types there all day
            if let Some(since) = fact.held.filter(|_| facts.root.as_deref() != Some(id.as_str())) {
                live.insert("held".into(), json!(since));
                rows.push(json!({
                    "id": format!("held:{id}"), "kind": "held_line", "derived": "held", "where": { "session": id }, "since": since,
                    "title": format!("Messages and tasks for {who} wait for a line you have not sent there"),
                    "detail": "If its input box is empty, press Enter there: nothing is sent and the hold ends. If it holds text, send it, or delete it.",
                }));
            }
            if let Some((report, said, since)) = fact.needs_human.as_ref().filter(|(report, ..)| !cited.contains(report.as_str())) {
                live.insert("report".into(), json!({ "id": report, "since": since, "text": said }));
                rows.push(json!({
                    "id": format!("report:{report}"), "kind": "report", "derived": "report", "where": { "session": id }, "since": since, "source": [report],
                    "title": format!("{who} needs you"), "detail": said,
                }));
            }
            let late: Vec<&FactWait> = fact.waits.iter().filter(|w| w.overdue && w.kind == "human").collect();
            if !late.is_empty() {
                live.insert("waits".into(), json!(late.iter().map(|w| json!({ "id": w.id, "on": w.on, "ref": w.reference, "since": w.since })).collect::<Vec<_>>()));
                rows.extend(late.iter().map(|w| json!({
                    "id": format!("wait:{}", w.id), "kind": "human_wait", "derived": "wait", "where": { "session": id }, "since": w.since,
                    "title": format!("{who} waits for you, past the time it expected"), "detail": w.on,
                })));
            }
            // A finished piece of work: quiet, in the one view only (MCR-124, Q6)
            if let Some((report, said, since)) = &fact.done {
                named.insert(id.as_str());
                finished.push(json!({
                    "id": format!("done:{report}"), "ask": "done", "derived": "done", "where": { "session": id }, "since": since, "cause": [format!("report:{report}")],
                    "text": format!("{who} finished a piece of work"), "detail": said, "urgency": "whenever",
                }));
            }
            if rows.is_empty() {
                continue;
            }
            named.insert(id.as_str());
            // Not into an action that may be out of date, or whose publisher ended:
            // today's prompt would read under an old title
            let fresh = |a: &Value| facts.now == 0 || a["updated"].as_u64().is_some_and(|at| facts.now.saturating_sub(at) <= STALE_AFTER_MS);
            let publisher_runs = |key: &str| key == ROOT || facts.sessions.get(key).is_some_and(|f| !f.ended);
            let standing_for = |a: &Value| {
                a.get("derived").is_none()
                    && a.get("ownerTyped").is_none()
                    && a.get("sessionEnded").is_none()
                    && fresh(a)
                    && a["where"]["session"] == id.as_str()
                    && a["by"].as_str().is_some_and(|key| publisher_runs(key) && (key == ROOT || key == id || fact.above.iter().any(|s| s == key)))
            };
            match actions.iter_mut().find(|a| standing_for(a)) {
                Some(host) => {
                    if !host["live"].is_object() {
                        host["live"] = json!({});
                    }
                    if let Some(merged) = host["live"].as_object_mut() {
                        merged.extend(live);
                    }
                }
                None => actions.extend(rows),
            }
        }
        tracks.sort_by_key(|(place, _)| *place);
        let tracks: Vec<Value> = tracks.into_iter().map(|(_, t)| t).collect();
        // The one view (MCR-124): every entry as a need, each where it belongs
        let mut needs: Vec<Value> = actions
            .iter()
            .map(|a| match (a["by"].as_str(), a["id"].as_str()) {
                (Some(by), Some(id)) if a["need"] == true => {
                    let mut full = asked.remove(&(by.to_string(), id.to_string())).unwrap_or_else(|| json!({}));
                    if let Some(live) = a.get("live") {
                        full["live"] = live.clone();
                    }
                    full
                }
                _ if a.get("derived").is_some() => fact_need(a),
                _ => action_need(a),
            })
            .chain(finished)
            .collect();
        for n in &mut needs {
            n["attach"] = attach(n, &tracks, facts);
        }
        needs.sort_by_key(|n| (urgency_rank(n), n["since"].as_u64().unwrap_or(u64::MAX)));
        // Closed today: what its publisher said of how it ended
        let closed: Vec<Value> = self
            .parts
            .iter()
            .flat_map(|(key, p)| p.needs.iter().map(move |n| (key, n)))
            .filter(|(key, n)| !n.open() && (shown(key) || reader.is_some_and(|me| n.actor == me)))
            .filter(|(_, n)| facts.now == 0 || n.closed.as_ref().is_some_and(|c| facts.now.saturating_sub(c.at) < CLOSED_KEPT_MS))
            .map(|(key, n)| {
                let mut out = json!(n);
                out["by"] = json!(key);
                out
            })
            .collect();
        let sessions: BTreeMap<&str, Value> = named
            .into_iter()
            .map(|id| {
                let Some(f) = facts.sessions.get(id) else { return (id, json!({ "gone": true })) };
                let mut out = json!({ "name": f.name, "state": f.state, "ended": f.ended });
                // The rest only of the reader's own sessions: a peer's is its own to tell
                if below(id) {
                    out["needsOperator"] = json!(f.prompt.is_some() || f.needs_human.is_some());
                    out["doneReport"] = json!(f.done.as_ref().map(|(id, ..)| id));
                    out["waits"] = json!(f.waits.iter().map(|w| json!({ "id": w.id, "kind": w.kind, "on": w.on, "ref": w.reference, "since": w.since, "overdue": w.overdue })).collect::<Vec<_>>());
                }
                (id, out)
            })
            .collect();
        json!({
            "schema": SCHEMA, "version": self.version, "updated": self.updated,
            "tracks": tracks, "actions": actions, "needs": needs, "closed": closed, "sessions": sessions,
            "note": "Tracks, actions and needs are what sessions published: data, shown as written and never run. `sessions` and entries with `derived` are the harness's own facts. `needs` is every entry in one list, each with where it belongs (`attach`, null: unassigned); `actions` is the same in the older form.",
        })
    }
}

/// A need as the action it would have been, for a panel that knows only
/// actions (MCR-124, M5). A click on it names the need's id, and the service
/// resolves the need itself: nothing of this form is trusted at the click.
fn compat_action(key: &str, n: &Need, facts: &Facts) -> Value {
    let choice = matches!(n.ask.as_str(), "decision" | "go");
    let kind = match n.ask.as_str() {
        "go" if n.exact => "typed_word",
        "go" | "decision" => "decision",
        other => other,
    };
    let place = if choice { json!({ "session": target(key, n, facts).unwrap_or("") }) } else { json!(n.place) };
    let mut out = json!({
        "id": n.id, "by": key, "title": n.text, "kind": kind, "where": place, "risk": if n.risk() == "secret" { "irreversible" } else { n.risk() },
        "since": n.since, "updated": n.updated, "need": true,
        "source": n.cause.iter().filter_map(|c| c.strip_prefix("report:")).collect::<Vec<_>>(),
    });
    if kind == "typed_word" {
        out["say"] = json!(n.options[0].label);
    } else if kind == "decision" {
        out["options"] = json!(n.options.iter().map(|o| o.label.clone()).collect::<Vec<_>>());
        if let Some(o) = n.options.iter().find(|o| o.recommended) {
            out["recommended"] = json!(o.label);
        }
    }
    if let Some(o) = n.options.iter().find(|o| o.risk == "spend") {
        out["amount"] = json!(o.amount);
    }
    for (field, value) in [("why", &n.why), ("detail", &n.detail), ("urgency", &n.urgency), ("track", &n.track), ("item", &n.item)] {
        if !value.is_empty() {
            out[field] = json!(value);
        }
    }
    out
}

/// A row the harness made from its own facts, as a need of the one view.
fn fact_need(a: &Value) -> Value {
    let ask = match a["kind"].as_str() {
        Some("answer_prompt") => "prompt",
        Some("held_line") => "held_line",
        Some("human_wait") => "human_wait",
        _ => "question",
    };
    let mut out = json!({
        "id": a["id"], "ask": ask, "derived": a["derived"], "text": a["title"], "where": a["where"], "since": a["since"],
        "urgency": if ask == "prompt" { "now" } else { "today" },
        "cause": a["source"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|r| format!("report:{r}")).collect::<Vec<_>>(),
    });
    if let Some(d) = a.get("detail") {
        out["detail"] = d.clone();
    }
    out
}

/// A published action as a need of the one view: the same entry, in the
/// newer words (MCR-124). `fromAction` says it came through cockpit_publish.
fn action_need(a: &Value) -> Value {
    let kind = a["kind"].as_str().unwrap_or("");
    let risk = a["risk"].as_str().unwrap_or("reversible");
    let amount = a["amount"].clone();
    let choice = |id: String, label: &Value, recommended: bool| {
        let mut o = json!({ "id": id, "label": label, "risk": risk });
        if recommended {
            o["recommended"] = json!(true);
        }
        if risk == "spend" {
            o["amount"] = amount.clone();
        }
        o
    };
    let (ask, options) = match kind {
        "typed_word" => ("go", vec![choice("go".into(), &a["say"], false)]),
        "decision" => ("decision", a["options"].as_array().into_iter().flatten().enumerate().map(|(i, o)| choice(format!("o{}", i + 1), o, a["recommended"] == *o)).collect()),
        other => (other, Vec::new()),
    };
    let mut out = json!({ "id": a["id"], "by": a["by"], "ask": ask, "text": a["title"], "options": options, "exact": kind == "typed_word", "where": a["where"], "risk": risk, "fromAction": true });
    for field in ["track", "trackBy", "item", "why", "detail", "urgency", "since", "updated", "live", "ownerTyped", "sessionEnded", "unclickable", "trackMissing", "blocks"] {
        if let Some(v) = a.get(field) {
            out[field] = v.clone();
        }
    }
    out["cause"] = json!(a["source"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|r| format!("report:{r}")).collect::<Vec<_>>());
    out
}

/// Where an entry of the one view belongs (MCR-124, 1.3): its own track;
/// the track of its item; for the session it is about, the first track (in
/// the Supervisor's order) it leads, then one with an open item it owns, then
/// the nearest one led by a session above it. `null`: unassigned.
fn attach(n: &Value, tracks: &[Value], facts: &Facts) -> Value {
    let by = n["by"].as_str().unwrap_or("");
    let part = n["trackBy"].as_str().filter(|s| !s.is_empty()).unwrap_or(by);
    let at = |t: &Value| json!({ "by": t["by"], "track": t["id"] });
    if let Some(id) = n["track"].as_str().filter(|s| !s.is_empty()) {
        if let Some(t) = tracks.iter().find(|t| t["by"] == part && t["id"] == id) {
            return at(t);
        }
    }
    if let Some(item) = n["item"].as_str().filter(|s| !s.is_empty()) {
        if let Some(t) = tracks.iter().find(|t| t["by"] == part && t["items"].as_array().is_some_and(|all| all.iter().any(|i| i["id"] == item))) {
            return at(t);
        }
    }
    let session = [n["actor"].as_str(), n["where"]["session"].as_str()].into_iter().flatten().find(|s| !s.is_empty()).or(if by == ROOT { facts.root.as_deref() } else { Some(by).filter(|s| !s.is_empty()) });
    let Some(session) = session else { return Value::Null };
    let leads = |s: &str| tracks.iter().find(|t| t["lead"] == s);
    if let Some(t) = leads(session) {
        return at(t);
    }
    if let Some(t) = tracks.iter().find(|t| t["items"].as_array().is_some_and(|all| all.iter().any(|i| i["owner"] == session && i["state"] != "done"))) {
        return at(t);
    }
    facts.sessions.get(session).into_iter().flat_map(|f| f.above.iter()).find_map(|up| leads(up)).map_or(Value::Null, at)
}

/// How soon an entry of the one view needs the operator: a prompt now,
/// whatever its publisher said; then the urgency given; then today.
fn urgency_rank(n: &Value) -> u8 {
    if n["ask"] == "prompt" || n["live"]["prompt"].is_u64() {
        return 0;
    }
    match n["urgency"].as_str() {
        Some("now") => 0,
        Some("whenever") => 2,
        _ => 1,
    }
}

/// A registered wait's kind (`wait_register`) in the words of `waitsOn`.
fn wait_kind(kind: &str) -> &'static str {
    match kind {
        "pipeline" => "ci",
        "human" => "human",
        "peer" => "session",
        "timer" => "timer",
        _ => "external",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 10_000_000;

    /// `sup` supervises `ex` (an agent) and `sh` (a shell); `peer` is apart;
    /// `gone` has ended; `root` is the Supervisor session.
    fn facts() -> Facts {
        let agent = |name: &str, above: &[&str]| Fact { name: name.into(), state: "working".into(), agent: true, above: above.iter().map(|s| s.to_string()).collect(), ..Fact::default() };
        let mut facts = Facts::default();
        facts.sessions.insert("sup".into(), agent("Lead", &[]));
        facts.sessions.insert("ex".into(), agent("Worker", &["sup"]));
        facts.sessions.insert("sh".into(), Fact { agent: false, ..agent("Shell", &["sup"]) });
        facts.sessions.insert("peer".into(), agent("Peer", &[]));
        facts.sessions.insert("gone".into(), Fact { ended: true, state: "exited".into(), ..agent("Gone", &["sup"]) });
        facts.sessions.insert("root".into(), agent("Supervisor", &[]));
        facts
    }

    const SUP: Who = Who { id: "sup", root: false };
    const ROOT_WHO: Who = Who { id: "root", root: true };

    fn track() -> Value {
        json!({ "id": "t1", "title": "Cockpit", "lead": "ex", "refs": ["MCR-94"], "state": "moving", "line": "schema first", "items": [
            { "id": "i1", "title": "Store", "ref": "MCR-95", "owner": "ex", "state": "doing", "next": "tests" },
            { "id": "i2", "title": "Restart", "owner": "human", "state": "waiting", "waitsOn": { "kind": "human", "what": "service restart" } },
        ] })
    }

    fn action(kind: &str, more: Value) -> Value {
        let mut a = json!({ "id": "a1", "track": "t1", "title": "Do it", "kind": kind, "risk": "reversible" });
        for (k, v) in more.as_object().unwrap() {
            a[k.as_str()] = v.clone();
        }
        a
    }

    fn published() -> Cockpit {
        let mut c = Cockpit::default();
        c.publish(&SUP, &facts(), &json!({ "tracks": [track()], "actions": [action("typed_word", json!({ "where": { "session": "ex" }, "say": "merge MCR-95", "item": "i1", "blocks": ["i2"] }))] }), NOW).unwrap();
        c
    }

    /// One action on the standard track, published by `sup`.
    fn with_action(a: Value) -> Result<Value, String> {
        Cockpit::default().publish(&SUP, &facts(), &json!({ "tracks": [track()], "actions": [a] }), NOW)
    }

    #[test]
    fn a_supervising_session_publishes_its_part_and_reads_it_back() {
        let c = published();
        assert_eq!((c.schema, c.version, c.updated), (SCHEMA, 1, NOW));
        let read = c.read(&facts(), None);
        assert_eq!(read["tracks"][0]["by"], "sup");
        assert_eq!(read["tracks"][0]["items"][1]["waitsOn"]["since"], NOW);
        assert_eq!(read["actions"][0]["say"], "merge MCR-95");
        assert_eq!(read["actions"][0]["since"], NOW);
        assert_eq!(read["sessions"]["ex"]["name"], "Worker");
        // A read document can be published back: the service's fields are dropped, not refused
        let mut again = c.clone();
        again.publish(&SUP, &facts(), &json!({ "tracks": read["tracks"], "actions": read["actions"] }), NOW + 5).unwrap();
        assert_eq!(again.parts["sup"].tracks, c.parts["sup"].tracks);
        // Nothing changed, so every entry keeps its times
        assert_eq!(again.parts["sup"].actions[0].updated, NOW);
    }

    #[test]
    fn a_session_publishes_its_own_part_and_nothing_else() {
        let mut c = Cockpit::default();
        let f = facts();
        // A session without executors publishes too: its own track, with itself as lead
        let ex = Who { id: "ex", root: false };
        let own = json!({ "id": "mine", "title": "My task", "state": "moving", "items": [{ "id": "i", "title": "Code", "owner": "ex", "state": "doing" }] });
        c.publish(&ex, &f, &json!({ "tracks": [own.clone()], "actions": [{ "id": "a", "track": "mine", "title": "Say go", "kind": "typed_word", "where": { "session": "ex" }, "say": "go", "risk": "reversible" }] }), NOW).unwrap();
        assert_eq!(c.parts["ex"].tracks[0].lead, "ex");
        // Not a track led by its supervisor, and no action that points at it
        let mut above = own.clone();
        above["lead"] = json!("sup");
        assert!(c.publish(&ex, &f, &json!({ "tracks": [above] }), NOW).unwrap_err().contains("tracks[0].lead"));
        assert!(c.publish(&ex, &f, &json!({ "tracks": [own], "actions": [{ "id": "a", "track": "mine", "title": "Say go", "kind": "typed_word", "where": { "session": "sup" }, "say": "go", "risk": "reversible" }] }), NOW).unwrap_err().contains("not you or one of your executors"));
        c.publish(&ex, &f, &json!({}), NOW).unwrap();
        // A session the harness does not know, or one that has ended, publishes nothing
        for id in ["nobody", "gone"] {
            assert!(c.publish(&Who { id, root: false }, &f, &json!({ "tracks": [] }), NOW).unwrap_err().contains("does not track"));
        }
        // A lead that is neither the caller nor below it
        let mut t = track();
        t["lead"] = json!("peer");
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [t] }), NOW).unwrap_err().contains("tracks[0].lead"));
        // Without a lead the caller leads
        let mut t = track();
        t.as_object_mut().unwrap().remove("lead");
        c.publish(&SUP, &f, &json!({ "tracks": [t] }), NOW).unwrap();
        assert_eq!(c.parts["sup"].tracks[0].lead, "sup");
        // A peer may own an item: that gives it nothing
        let mut t = track();
        t["items"][0]["owner"] = json!("peer");
        c.publish(&SUP, &f, &json!({ "tracks": [t] }), NOW).unwrap();
        // The order and other parts are the Supervisor's
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [track()], "order": [{ "by": "sup", "id": "t1" }] }), NOW).unwrap_err().contains("order"));
        assert!(with_action(action("live_check", json!({ "detail": "look", "trackBy": "peer" }))).unwrap_err().contains("trackBy"));
        assert!(with_action(action("live_check", json!({ "detail": "look", "track": null }))).unwrap_err().contains("actions[0].track "));
        assert!(with_action(action("typed_word", json!({ "where": { "session": "peer" }, "say": "go" }))).unwrap_err().contains("not you or one of your executors"));
        // A new publish replaces the part whole; an empty one takes it away
        c.publish(&SUP, &f, &json!({}), NOW).unwrap();
        assert!(c.parts.is_empty());
    }

    #[test]
    fn what_does_not_fit_the_schema_is_refused_with_its_place() {
        let f = facts();
        let refused = |change: fn(&mut Value), place: &str| {
            let mut t = track();
            change(&mut t);
            let mut c = Cockpit::default();
            let err = c.publish(&SUP, &f, &json!({ "tracks": [t] }), NOW).unwrap_err();
            assert!(err.starts_with("Refused: ") && err.contains(place), "{place}: {err}");
            assert!(c.parts.is_empty() && c.version == 0, "nothing is stored from a refused call");
        };
        refused(|t| t["state"] = json!("stuck"), "tracks[0].state");
        refused(|t| t["items"][0]["state"] = json!("started"), "tracks[0].items[0].state");
        refused(|t| t["items"][1]["waitsOn"]["kind"] = json!("weather"), "tracks[0].items[1].waitsOn.kind");
        refused(|t| t["colour"] = json!("red"), "tracks");
        refused(|t| t["id"] = json!("T 1"), "tracks[0].id");
        refused(|t| t["items"][1]["id"] = json!("i1"), "tracks[0].items[1].id");
        refused(|t| t["title"] = json!(""), "tracks[0].title");
        refused(|t| t["title"] = json!("x".repeat(MAX_TITLE + 1)), "tracks[0].title");
        refused(|t| t["line"] = json!("one\ntwo"), "tracks[0].line");
        refused(|t| t["line"] = json!("a\u{1b}[31mred"), "tracks[0].line");
        refused(|t| t["line"] = json!("a\u{202e}b"), "tracks[0].line");
        refused(|t| t["lead"] = json!("nobody"), "tracks[0].lead");
        refused(|t| t["lead"] = json!("gone"), "has ended");
        refused(|t| t["items"][0]["owner"] = json!("nobody"), "tracks[0].items[0].owner");
        refused(|t| t["items"][0]["owner"] = json!(""), "tracks[0].items[0].owner");
        refused(|t| t["items"][1]["waitsOn"] = json!({ "kind": "session", "who": "nobody" }), "waitsOn.who");
        refused(|t| t["refs"] = json!(vec!["a"; MAX_LIST + 1]), "tracks[0].refs");
        refused(|t| t["items"] = json!((0..=MAX_ITEMS).map(|i| json!({ "id": format!("i{i}"), "title": "x", "owner": "human", "state": "done" })).collect::<Vec<_>>()), "tracks[0].items");
        let mut c = Cockpit::default();
        let many: Vec<Value> = (0..=MAX_TRACKS).map(|i| json!({ "id": format!("t{i}"), "title": "x", "state": "done" })).collect();
        assert!(c.publish(&SUP, &f, &json!({ "tracks": many }), NOW).unwrap_err().contains("tracks has more"));
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [track(), track()] }), NOW).unwrap_err().contains("used twice"));
        assert!(c.publish(&SUP, &f, &json!({ "trakcs": [] }), NOW).unwrap_err().contains("trakcs"));
        assert!(c.publish(&SUP, &f, &json!({ "tracks": "all of them" }), NOW).unwrap_err().contains("does not fit the schema"));
        // A part has a size, whatever its entries are
        let fat: Vec<Value> = (0..MAX_ACTIONS).map(|i| action("live_check", json!({ "id": format!("a{i}"), "detail": "x".repeat(MAX_DETAIL) }))).collect();
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [track()], "actions": fat }), NOW).unwrap_err().contains("bytes"));
    }

    #[test]
    fn an_action_carries_only_what_a_click_on_its_kind_may_use() {
        let refused = |a: Value, place: &str| {
            let err = with_action(a).unwrap_err();
            assert!(err.starts_with("Refused: ") && err.contains(place), "{place}: {err}");
        };
        // Built by the harness from its own facts, never from an agent's text
        refused(action("answer_prompt", json!({ "where": { "session": "ex" } })), "cannot be published");
        refused(action("report", json!({})), "cannot be published");
        refused(action("run_it", json!({})), "actions[0].kind");
        // typed_word: a live agent session and one plain line
        with_action(action("typed_word", json!({ "where": { "session": "ex" }, "say": "merge MCR-95" }))).unwrap();
        refused(action("typed_word", json!({ "say": "go" })), "where.session");
        refused(action("typed_word", json!({ "where": { "session": "ex" } })), "actions[0].say");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "/clear" })), "runs a command");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "!rm -rf ~" })), "runs a command");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "  !rm -rf ~" })), "spaces at its ends");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "go\nand more" })), "U+000A");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "x".repeat(MAX_PLACED + 1) })), "longer than");
        with_action(action("typed_word", json!({ "where": { "session": "ex" }, "say": "x".repeat(MAX_PLACED) }))).unwrap();
        refused(action("typed_word", json!({ "where": { "session": "ex", "command": "make" }, "say": "go" })), "where.command");
        refused(action("typed_word", json!({ "where": { "session": "ex", "url": "https://example.com" }, "say": "go" })), "where.url");
        refused(action("typed_word", json!({ "where": { "session": "sh" }, "say": "go" })), "not an agent");
        refused(action("typed_word", json!({ "where": { "session": "gone" }, "say": "go" })), "has ended");
        refused(action("typed_word", json!({ "where": { "session": "nobody" }, "say": "go" })), "not a session the harness tracks");
        // decision: choices, each a plain line
        with_action(action("decision", json!({ "options": ["Keep", "Drop"], "recommended": "Keep" }))).unwrap();
        // An option is as long as the line a click builds from it lets it be: "Decision a1: " is 13 characters
        with_action(action("decision", json!({ "options": ["Keep", "x".repeat(MAX_PLACED - 13)] }))).unwrap();
        refused(action("decision", json!({ "options": ["Keep", "x".repeat(MAX_PLACED - 12)] })), "options[1] is too long");
        refused(action("decision", json!({ "options": ["Keep"] })), "2 to 6");
        refused(action("decision", json!({ "options": ["Keep", "Drop"], "recommended": "Wait" })), "recommended");
        refused(action("decision", json!({ "options": ["Keep", "#drop"] })), "options[1]");
        refused(action("decision", json!({ "options": ["Keep", "Drop"], "say": "Keep" })), "actions[0].say");
        refused(action("live_check", json!({ "detail": "look", "options": ["a", "b"] })), "options");
        // secret_step, live_check: a checklist, and a command that is shown
        with_action(action("live_check", json!({ "detail": "1. restart\n2. look", "where": { "command": "launchctl list" } }))).unwrap();
        refused(action("secret_step", json!({})), "actions[0].detail");
        refused(action("secret_step", json!({ "detail": "x", "say": "go" })), "actions[0].say");
        refused(action("live_check", json!({ "detail": "x", "where": { "command": "a\nb" } })), "where.command");
        // external: a web link and nothing else
        with_action(action("external", json!({ "where": { "url": "https://example.com/pr/1?x=1" } }))).unwrap();
        refused(action("external", json!({})), "where.url");
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/", "https://", "https://exa mple.com", "ftp://example.com"] {
            refused(action("external", json!({ "where": { "url": bad } })), "where.url");
        }
        refused(action("external", json!({ "where": { "url": "https://example.com", "command": "open it" } })), "where.command");
        // Every action says what it risks
        refused(action("decision", json!({ "options": ["a", "b"], "risk": null })), "actions[0].risk");
        refused(action("decision", json!({ "options": ["a", "b"], "risk": "spend" })), "amount");
        refused(action("decision", json!({ "options": ["a", "b"], "amount": "5 EUR" })), "amount");
        with_action(action("decision", json!({ "options": ["a", "b"], "risk": "spend", "amount": "5 EUR", "urgency": "now" }))).unwrap();
        refused(action("decision", json!({ "options": ["a", "b"], "urgency": "soon" })), "urgency");
        // It points into its own track
        refused(action("decision", json!({ "options": ["a", "b"], "track": "t9" })), "actions[0].track");
        refused(action("decision", json!({ "options": ["a", "b"], "item": "i9" })), "actions[0].item");
        refused(action("decision", json!({ "options": ["a", "b"], "blocks": ["i1", "i9"] })), "blocks[1]");
        refused(action("decision", json!({ "options": ["a", "b"], "detail": "a\u{7}b" })), "actions[0].detail");
    }

    #[test]
    fn the_supervisor_orders_tracks_and_adds_actions_across_them() {
        let mut c = published();
        let f = facts();
        let mine = json!({ "id": "all", "title": "Everything", "state": "moving" });
        let cross = json!({ "id": "x1", "title": "Restart the service", "kind": "live_check", "detail": "kickstart", "risk": "reversible", "track": "t1", "trackBy": "sup", "blocks": ["i2"], "where": { "session": "peer" } });
        let free = json!({ "id": "x2", "title": "Choose", "kind": "decision", "options": ["a", "b"], "risk": "irreversible" });
        c.publish(&ROOT_WHO, &f, &json!({ "tracks": [mine], "actions": [cross, free], "order": [{ "by": ROOT, "id": "all" }, { "by": "sup", "id": "t1" }] }), NOW).unwrap();
        assert_eq!(c.parts[ROOT].tracks[0].lead, "root");
        let read = c.read(&f, None);
        assert_eq!(read["tracks"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect::<Vec<_>>(), ["all", "t1"]);
        assert_eq!(read["actions"].as_array().unwrap().iter().filter(|a| a["by"] == ROOT).count(), 2);
        // An order names published tracks, once each
        let order = |order: Value| c.clone().publish(&ROOT_WHO, &f, &json!({ "tracks": [{ "id": "all", "title": "x", "state": "done" }], "order": order }), NOW).unwrap_err();
        assert!(order(json!([{ "by": "sup", "id": "t9" }])).contains("order[0]"));
        assert!(order(json!([{ "by": "sup", "id": "t1" }, { "by": "sup", "id": "t1" }])).contains("twice"));
        // It removes what another session left, and edits nothing there
        assert!(c.patch(&ROOT_WHO, &f, &json!({ "by": "sup", "track": { "id": "t1", "title": "Mine now" } }), NOW).unwrap_err().contains("only to remove"));
        assert!(c.patch(&SUP, &f, &json!({ "by": "root", "remove": "action", "id": "x2" }), NOW).unwrap_err().contains("only the Supervisor"));
        c.patch(&ROOT_WHO, &f, &json!({ "by": "sup", "remove": "track", "id": "t1" }), NOW).unwrap();
        assert!(!c.parts.contains_key("sup"), "the track's own actions went with it");
        assert_eq!(c.order, [TrackRef { by: ROOT.into(), id: "all".into() }]);
        // The cross-track action stays and says that its track is gone
        let read = c.read(&f, None);
        assert_eq!(read["actions"][0]["trackMissing"], true);
        assert!(read["actions"][1].get("trackMissing").is_none());
    }

    #[test]
    fn a_patch_changes_one_entry_and_the_part_must_still_stand() {
        let mut c = published();
        let f = facts();
        // The fields given replace, the others stay
        c.patch(&SUP, &f, &json!({ "track": { "id": "t1", "state": "waiting_human", "line": "waits for the restart" } }), NOW + 10).unwrap();
        let t = &c.parts["sup"].tracks[0];
        assert_eq!((t.state.as_str(), t.items.len(), t.updated), ("waiting_human", 2, NOW + 10));
        c.patch(&SUP, &f, &json!({ "item": { "id": "i1", "state": "review" }, "of": "t1" }), NOW + 20).unwrap();
        assert_eq!(c.parts["sup"].tracks[0].items[0].state, "review");
        assert_eq!(c.parts["sup"].tracks[0].items[0].title, "Store");
        c.patch(&SUP, &f, &json!({ "item": { "id": "i3", "title": "New", "owner": "human", "state": "ready" }, "of": "t1" }), NOW + 20).unwrap();
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "urgency": "now" } }), NOW + 30).unwrap();
        let a = &c.parts["sup"].actions[0];
        assert_eq!((a.urgency.as_str(), a.say.as_str(), a.since, a.updated), ("now", "merge MCR-95", NOW, NOW + 30));
        // A wait keeps its time while it stays the same wait
        assert_eq!(c.parts["sup"].tracks[0].items[1].waits_on.as_ref().unwrap().since, NOW);
        c.patch(&SUP, &f, &json!({ "item": { "id": "i2", "waitsOn": { "kind": "ci", "what": "run 7" } }, "of": "t1" }), NOW + 40).unwrap();
        assert_eq!(c.parts["sup"].tracks[0].items[1].waits_on.as_ref().unwrap().since, NOW + 40);
        let version = c.version;
        // Refused changes leave everything as it was
        for (args, place) in [
            (json!({ "track": { "id": "t1", "state": "stuck" } }), "tracks[0].state"),
            (json!({ "item": { "id": "i1", "state": "done" } }), "of is required"),
            (json!({ "item": { "id": "i1", "state": "done" }, "of": "t9" }), "not one of your tracks"),
            (json!({ "remove": "item", "id": "i2", "of": "t1" }), "blocks[0]"),
            (json!({ "remove": "track", "id": "t1" }), "actions[0].track"),
            (json!({ "remove": "action", "id": "a9" }), "not there"),
            (json!({ "remove": "everything", "id": "t1" }), "remove"),
            (json!({ "track": { "id": "t2", "title": "x", "state": "done" }, "action": { "id": "a2" } }), "exactly one"),
            (json!({ "action": { "title": "no id" } }), "action.id"),
            (json!({ "action": { "id": "a1", "kind": "answer_prompt" } }), "cannot be published"),
            (json!({}), "exactly one"),
        ] {
            let err = c.patch(&SUP, &f, &args, NOW + 50).unwrap_err();
            assert!(err.starts_with("Refused: ") && err.contains(place), "{args}: {err}");
        }
        assert_eq!(c.version, version);
        c.patch(&SUP, &f, &json!({ "remove": "action", "id": "a1" }), NOW + 60).unwrap();
        c.patch(&SUP, &f, &json!({ "remove": "track", "id": "t1" }), NOW + 60).unwrap();
        assert!(c.parts.is_empty());
        // Another session has no way to that part: its own is all it reaches
        assert!(c.patch(&Who { id: "ex", root: false }, &f, &json!({ "remove": "track", "id": "t1" }), NOW).unwrap_err().contains("not there"));
    }

    #[test]
    fn writes_are_counted_per_session() {
        let mut c = Cockpit::default();
        let f = facts();
        for i in 0..MAX_WRITES as u64 {
            c.publish(&SUP, &f, &json!({ "tracks": [track()] }), NOW + i).unwrap();
        }
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [track()] }), NOW + 100).unwrap_err().contains("ten minutes"));
        // Refused calls do not count, and the window moves on
        assert!(c.publish(&SUP, &f, &json!({ "tracks": [track()] }), NOW + WRITE_WINDOW_MS + 100).is_ok());
    }

    #[test]
    fn what_the_owner_did_in_a_session_is_marked_on_the_entries_that_await_them_there() {
        let mut c = Cockpit::default();
        let mut f = facts();
        c.publish(&SUP, &f, &json!({
            "tracks": [{ "id": "t1", "title": "Waits", "lead": "ex", "state": "waiting_human" }, { "id": "t2", "title": "Moves", "lead": "ex", "state": "moving" }],
            "actions": [
                action("typed_word", json!({ "where": { "session": "ex" }, "say": "merge" })),
                action("decision", json!({ "id": "a2", "options": ["a", "b"] })),
            ],
        }), NOW).unwrap();
        // Nothing typed, or typed before the publish: the text stands
        assert!(c.outdated(&f).is_empty());
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW);
        assert!(c.outdated(&f).is_empty());
        let plain = c.read(&f, None);
        assert!(plain["tracks"][0].get("ownerTyped").is_none() && plain["actions"][0].get("ownerTyped").is_none());
        // Typed after it: the waiting track and the action that points there, not the moving track or the action without a session
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW + 5);
        let marks = c.outdated(&f);
        assert_eq!(marks.iter().map(|o| (o.track, o.id.as_str(), o.session.as_str(), o.typed)).collect::<Vec<_>>(), [(true, "t1", "ex", Some(NOW + 5)), (false, "a1", "ex", Some(NOW + 5))]);
        assert!(c.points_at("ex") && !c.points_at("sup") && !c.points_at("peer"));
        let read = c.read(&f, None);
        assert_eq!((&read["tracks"][0]["ownerTyped"], &read["actions"][0]["ownerTyped"]), (&json!(NOW + 5), &json!(NOW + 5)));
        assert!(read["tracks"][1].get("ownerTyped").is_none() && read["actions"][1].get("ownerTyped").is_none());
        // The published text is not rewritten, and the mark does not come back in through a publish
        assert_eq!(read["tracks"][0]["state"], "waiting_human");
        let mut back = json!({ "tracks": read["tracks"], "actions": read["actions"] });
        back["tracks"][0]["line"] = json!("still waits");
        c.publish(&SUP, &f, &back, NOW + 10).unwrap();
        assert!(!serde_json::to_string(&c).unwrap().contains("ownerTyped"));
        // The publisher changed the track: its mark is gone. The action it did not change keeps its own
        let read = c.read(&f, None);
        assert!(read["tracks"][0].get("ownerTyped").is_none());
        assert_eq!(read["actions"][0]["ownerTyped"], json!(NOW + 5));
        // A publisher cannot set the mark itself
        assert!(c.patch(&SUP, &f, &json!({ "action": { "id": "a2", "ownerTyped": 1, "sessionEnded": true } }), NOW + 11).is_ok());
        assert!(!serde_json::to_string(&c).unwrap().contains("sessionEnded"));
    }

    #[test]
    fn an_action_whose_session_ended_or_is_gone_says_so() {
        let mut c = Cockpit::default();
        let mut f = facts();
        c.publish(&SUP, &f, &json!({ "tracks": [track()], "actions": [action("typed_word", json!({ "where": { "session": "ex" }, "say": "merge" }))] }), NOW).unwrap();
        assert!(c.read(&f, None)["actions"][0].get("sessionEnded").is_none());
        f.sessions.get_mut("ex").unwrap().ended = true;
        // Also when the owner had typed there before it ended: ended is what counts
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW + 5);
        assert_eq!(c.outdated(&f), [Outdated { by: "sup".into(), track: false, need: false, id: "a1".into(), updated: NOW, session: "ex".into(), typed: None }]);
        let read = c.read(&f, None);
        assert_eq!(read["actions"][0]["sessionEnded"], true);
        assert!(read["actions"][0].get("ownerTyped").is_none());
        f.sessions.remove("ex");
        assert_eq!(c.read(&f, None)["actions"][0]["sessionEnded"], true);
        // Also in the publisher's own read, which knows nothing else of a session the harness forgot
        assert_eq!(c.read(&f, Some("sup"))["actions"][0]["sessionEnded"], true);
    }

    #[test]
    fn what_the_owner_types_to_the_supervisor_marks_none_of_its_own_entries_that_point_at_itself() {
        let mut c = Cockpit::default();
        let mut f = facts();
        f.root = Some("root".into());
        c.publish(&ROOT_WHO, &f, &json!({
            "tracks": [{ "id": "mine", "title": "Mine", "lead": "root", "state": "waiting_human" }, { "id": "theirs", "title": "Theirs", "lead": "ex", "state": "waiting_human" }],
            "actions": [
                { "id": "here", "title": "Tell me", "kind": "typed_word", "where": { "session": "root" }, "say": "go", "risk": "reversible" },
                { "id": "there", "title": "Tell it", "kind": "typed_word", "where": { "session": "ex" }, "say": "go", "risk": "reversible" },
            ],
        }), NOW).unwrap();
        f.sessions.get_mut("root").unwrap().typed = Some(NOW + 5);
        assert!(c.outdated(&f).is_empty(), "a line typed to the Supervisor is about anything");
        // Its entries that point at another session are marked as any other
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW + 6);
        assert_eq!(c.outdated(&f).iter().map(|o| (o.by.as_str(), o.id.as_str())).collect::<Vec<_>>(), [(ROOT, "theirs"), (ROOT, "there")]);
        // And the Supervisor's session ending is still said of an action that points at it
        f.sessions.get_mut("root").unwrap().ended = true;
        assert!(c.outdated(&f).iter().any(|o| o.id == "here" && o.typed.is_none()));
    }

    #[test]
    fn a_line_a_click_may_place_is_one_line_of_characters_that_are_all_seen() {
        for good in ["merge MCR-95", "übernimm main, s'il te plaît", "選択する", "yes (the 2nd one) – “quoted” … £5", "a".repeat(MAX_PLACED).as_str()] {
            assert_eq!(placeable(good), Ok(()), "{good}");
        }
        // The ranges the deny-list missed, letters that draw nothing, and what is not assigned
        for bad in ['\u{1bca0}', '\u{1bca3}', '\u{13430}', '\u{1343f}', '\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}', '\u{e01ef}', '\u{378}', '\u{10ffff}', '\u{200b}', '\u{202e}', '\u{2066}', '\u{301}', '\u{a0}', '\u{3000}', '\t', '\n', '\r', '\u{1b}', '\u{7f}', '\u{0}'] {
            let why = placeable(&format!("go{bad}on")).unwrap_err();
            assert!(why.contains(&format!("U+{:04X}", bad as u32)), "{:x}: {why}", bad as u32);
        }
        assert!(placeable("go  on").unwrap_err().contains("two spaces"));
        assert!(placeable("go on\\").unwrap_err().contains("backslash"));
        assert!(placeable(" go").is_err() && placeable("go ").is_err() && placeable("").is_err());
        assert!(placeable(&"a".repeat(MAX_PLACED + 1)).unwrap_err().contains("longer"));
        for lead in ["!ls", "#note", "/clear"] {
            assert!(placeable(lead).unwrap_err().contains("runs a command"), "{lead}");
        }
        // A command to copy may start with a path, and is a little longer; otherwise the same rule
        assert_eq!(copyable("/usr/bin/true --flag=1 | cat"), Ok(()));
        assert!(copyable("ls\u{200b}").is_err() && copyable("a  b").is_err() && copyable(&"a".repeat(MAX_COPIED + 1)).is_err());
    }

    #[test]
    fn a_link_a_click_may_open_is_https_to_a_named_public_host() {
        let link = web_link("https://GitHub.com/lambda-house/agent-mcr/pull/1?diff=split").unwrap();
        assert_eq!((link.href.as_str(), link.host.as_str(), link.path.as_str(), link.query.as_str(), link.known), ("https://github.com/lambda-house/agent-mcr/pull/1?diff=split", "github.com", "/lambda-house/agent-mcr/pull/1", "diff=split", true));
        // What is opened is what is shown: host, path and query make up the whole address
        assert_eq!(link.href, format!("https://{}{}?{}", link.host, link.path, link.query));
        assert!(web_link("https://github.com/x/y#files").unwrap_err().contains("fragment"));
        assert!(web_link("https://github.com/x/y#").is_err());
        // Where one signs in, grants access or changes an account, also a known host gets the stronger warning
        for guarded in ["https://github.com/login/oauth/authorize?client_id=x", "https://github.com/settings/tokens", "https://github.com/apps/some-app/installations/new", "https://github.com/LOGIN", "https://teob.atlassian.net/login?dest=x", "https://github.com/oauth"] {
            assert!(!web_link(guarded).unwrap().known, "{guarded}");
        }
        assert!(web_link("https://github.com/lambda-house/settings-tool").unwrap().known);
        assert!(web_link("https://teob.atlassian.net/browse/MCR-97").unwrap().known);
        // Any other host is not known, also one that only looks like a known one
        for other in ["https://example.com/", "https://github.com.evil.example/", "https://gíthub.com/"] {
            let link = web_link(other).unwrap();
            assert!(!link.known && link.host.is_ascii(), "{other}: {link:?}");
        }
        // A look-alike name shows as what it is
        assert!(web_link("https://gíthub.com/").unwrap().host.starts_with("xn--"));
        // The explicit default port is the default port
        assert_eq!(web_link("https://example.com:443/x").unwrap().href, "https://example.com/x");
        for bad in [
            "http://example.com/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "https://", "example.com",
            "https://user@example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "https://example.com:80/",
            "https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://[::1]/", "https://192.168.1.10/admin", "https://10.0.0.1/",
            "https://localhost/", "https://LOCALHOST./", "https://router/", "https://printer.local/", "https://nas.lan/", "https://dev.internal/", "https://a.localhost/",
            "https://exa mple.com/", "https://example.com/a\nb",
        ] {
            assert!(web_link(bad).is_err(), "{bad} was accepted: {:?}", web_link(bad));
        }
        assert!(web_link(&format!("https://example.com/{}", "a".repeat(MAX_LINK))).is_err());
    }

    #[test]
    fn a_click_is_resolved_from_the_stored_action_and_checked_again() {
        let mut c = Cockpit::default();
        let mut f = facts();
        f.root = Some("root".into());
        c.publish(&SUP, &f, &json!({ "tracks": [track()], "actions": [
            action("typed_word", json!({ "where": { "session": "ex" }, "say": "merge MCR-95" })),
            action("decision", json!({ "id": "pick", "options": ["Keep it", "Drop it"], "recommended": "Keep it" })),
            action("decision", json!({ "id": "there", "options": ["Yes", "No"], "where": { "session": "ex" } })),
            action("external", json!({ "id": "pr", "where": { "url": "https://github.com/x/y/pull/1" } })),
            action("live_check", json!({ "id": "look", "detail": "steps", "where": { "command": "cargo test" } })),
        ] }), NOW).unwrap();
        c.publish(&ROOT_WHO, &f, &json!({ "actions": [{ "id": "next", "title": "Which next", "kind": "decision", "options": ["A", "B"], "risk": "reversible" }] }), NOW).unwrap();
        let act = |c: &Cockpit, f: &Facts, by: &str, id: &str, act: Act| c.act(by, id, NOW, act, f);
        // The stored line into the stored session
        assert_eq!(act(&c, &f, "sup", "a1", Act::Place), Ok(Deed::Type { session: "ex".into(), text: "merge MCR-95".into() }));
        // A choice: the service's frame with the action's id, into the publisher's own box, or the session it names
        assert_eq!(act(&c, &f, "sup", "pick", Act::Choose(1)), Ok(Deed::Type { session: "sup".into(), text: "Decision pick: Drop it".into() }));
        assert_eq!(act(&c, &f, "sup", "there", Act::Choose(0)), Ok(Deed::Type { session: "ex".into(), text: "Decision there: Yes".into() }));
        assert_eq!(act(&c, &f, ROOT, "next", Act::Choose(0)), Ok(Deed::Type { session: "root".into(), text: "Decision next: A".into() }));
        // Whatever passed the publish is placed: the longest id with the longest option that goes with it
        let long_id = "d".repeat(40);
        let long_option = "x".repeat(MAX_PLACED - 51);
        c.patch(&SUP, &f, &json!({ "action": { "id": long_id, "track": "t1", "title": "Long", "kind": "decision", "options": ["a", long_option], "risk": "reversible" } }), NOW).unwrap();
        assert!(matches!(act(&c, &f, "sup", &long_id, Act::Choose(1)), Ok(Deed::Type { text, .. }) if text.chars().count() == MAX_PLACED));
        assert!(matches!(act(&c, &f, "sup", &long_id, Act::Ask), Ok(Deed::Type { .. })));
        // "Ask more": a fixed sentence with the id, to the publisher
        assert_eq!(act(&c, &f, "sup", "a1", Act::Ask), Ok(Deed::Type { session: "sup".into(), text: "Explain cockpit action a1: what happens if I do it, and what if I do not?".into() }));
        assert!(matches!(act(&c, &f, "sup", "pr", Act::Link), Ok(Deed::Link(l)) if l.host == "github.com" && l.known));
        assert_eq!(act(&c, &f, "sup", "look", Act::Copy), Ok(Deed::Copy("cargo test".into())));
        let refused = |r: Result<Deed, String>, why: &str| {
            let err = r.unwrap_err();
            assert!(err.starts_with("Refused: ") && err.contains(why), "{why}: {err}");
        };
        // Not the action the panel showed
        refused(c.act("sup", "a1", NOW - 1, Act::Place, &f), "published again");
        refused(act(&c, &f, "sup", "nothing", Act::Place), "no longer published");
        refused(act(&c, &f, "peer", "a1", Act::Place), "no longer published");
        // Not what its kind has
        refused(act(&c, &f, "sup", "a1", Act::Choose(0)), "nothing of this kind");
        refused(act(&c, &f, "sup", "pick", Act::Place), "nothing of this kind");
        refused(act(&c, &f, "sup", "pick", Act::Choose(2)), "no such option");
        refused(act(&c, &f, "sup", "a1", Act::Link), "nothing of this kind");
        refused(act(&c, &f, "sup", "a1", Act::Copy), "nothing of this kind");
        // The target was bound to another supervisor since the publish
        let mut moved = f.clone();
        moved.sessions.get_mut("ex").unwrap().above = vec!["peer".into()];
        refused(act(&c, &moved, "sup", "a1", Act::Place), "no longer works for");
        refused(act(&c, &moved, "sup", "there", Act::Choose(0)), "no longer works for");
        // The Supervisor may point anywhere, as it may publish there
        c.patch(&ROOT_WHO, &f, &json!({ "action": { "id": "far", "title": "Say it", "kind": "typed_word", "where": { "session": "peer" }, "say": "go", "risk": "reversible" } }), NOW).unwrap();
        assert_eq!(act(&c, &f, ROOT, "far", Act::Place), Ok(Deed::Type { session: "peer".into(), text: "go".into() }));
        // Ended, gone, or no agent
        let mut ended = f.clone();
        ended.sessions.get_mut("ex").unwrap().ended = true;
        refused(act(&c, &ended, "sup", "a1", Act::Place), "has ended");
        let mut shell = f.clone();
        shell.sessions.get_mut("ex").unwrap().agent = false;
        refused(act(&c, &shell, "sup", "a1", Act::Place), "not an agent");
        // The owner typed there since: the action is behind, its publisher updates it first
        let mut typed = f.clone();
        typed.sessions.get_mut("ex").unwrap().typed = Some(NOW + 1);
        refused(act(&c, &typed, "sup", "a1", Act::Place), "after this was published");
        // No Supervisor runs: its own box is nowhere
        let mut alone = f.clone();
        alone.root = None;
        refused(act(&c, &alone, ROOT, "next", Act::Choose(0)), "does not run");
        // A stored text from before the allow-list is not placed, opened or copied
        let part = c.parts.get_mut("sup").unwrap();
        part.actions[0].say = "merge\u{200b} MCR-95".into();
        part.actions[1].options[0] = "Keep\u{3164}it".into();
        part.actions[3].place.url = "http://github.com/x".into();
        part.actions[4].place.command = "cargo  test".into();
        refused(act(&c, &f, "sup", "a1", Act::Place), "U+200B");
        refused(act(&c, &f, "sup", "pick", Act::Choose(0)), "U+3164");
        assert!(act(&c, &f, "sup", "pick", Act::Choose(1)).is_ok());
        refused(act(&c, &f, "sup", "pr", Act::Link), "https");
        refused(act(&c, &f, "sup", "look", Act::Copy), "two spaces");
        // The read says which of them have no button, so the panel offers none
        let read = c.read(&f, None);
        let unclickable = |id: &str| read["actions"].as_array().unwrap().iter().find(|a| a["id"] == id).unwrap()["unclickable"].clone();
        assert_eq!((unclickable("a1"), unclickable("pick"), unclickable("pr"), unclickable("look"), unclickable("there")), (json!(["say"]), json!(["options"]), json!(["url"]), json!(["command"]), Value::Null));
    }

    #[test]
    fn an_unchanged_target_is_checked_again_at_a_publish_while_it_runs() {
        let mut c = published();
        let mut f = facts();
        // Bound to another supervisor since: a publish that keeps the target is refused now
        f.sessions.get_mut("ex").unwrap().above = vec!["peer".into()];
        let again = json!({ "tracks": [{ "id": "t1", "title": "Cockpit", "lead": "sup", "state": "moving" }], "actions": [action("typed_word", json!({ "where": { "session": "ex" }, "say": "something else" }))] });
        assert!(c.publish(&SUP, &f, &again, NOW + 1).unwrap_err().contains("not you or one of your executors"));
        // Ended: the entry may stay as it is, so that the rest of the part can change
        f.sessions.get_mut("ex").unwrap().ended = true;
        c.publish(&SUP, &f, &again, NOW + 2).unwrap();
    }

    #[test]
    fn a_registered_wait_is_not_shown_on_an_item_that_is_done() {
        let mut c = Cockpit::default();
        let mut f = facts();
        c.publish(&SUP, &f, &json!({ "tracks": [{ "id": "t9", "title": "T", "lead": "ex", "state": "moving", "items": [
            { "id": "a", "title": "A", "owner": "ex", "state": "done" },
            { "id": "b", "title": "B", "owner": "ex", "state": "doing" },
        ] }] }), NOW).unwrap();
        f.sessions.get_mut("ex").unwrap().waits = vec![FactWait { id: "w1".into(), kind: "pipeline".into(), on: "CI run".into(), reference: String::new(), since: NOW, overdue: false }];
        let read = c.read(&f, None);
        let items = &read["tracks"][0]["items"];
        assert!(items[0].get("waitsOn").is_none(), "{}", items[0]);
        assert_eq!(items[1]["waitsOn"]["derived"], "wait");
    }

    #[test]
    fn harness_facts_are_joined_at_read_and_never_stored() {
        let c = published();
        let mut f = facts();
        f.reports.insert("r1".into(), "peer".into());
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW + 1);
        f.sessions.get_mut("ex").unwrap().waits = vec![FactWait { id: "w1".into(), kind: "pipeline".into(), on: "CI run".into(), reference: "run 7".into(), since: NOW + 2, overdue: true }];
        f.sessions.get_mut("ex").unwrap().done = Some(("r0".into(), "Shipped".into(), 1));
        f.sessions.get_mut("peer").unwrap().needs_human = Some(("r1".into(), "Which key?".into(), NOW + 3));
        f.sessions.get_mut("sh").unwrap().prompt = Some(NOW + 4);
        let read = c.read(&f, None);
        let actions = read["actions"].as_array().unwrap();
        // A prompt is an action in the harness's own words: the prompt's text is not copied
        let prompt = actions.iter().find(|a| a["kind"] == "answer_prompt").unwrap();
        assert_eq!((&prompt["where"]["session"], &prompt["derived"], &prompt["since"]), (&json!("sh"), &json!("prompt"), &json!(NOW + 4)));
        assert_eq!(prompt["title"], "Shell asks for your answer in its terminal");
        // The worker's prompt went into the action that points the operator at it: one row, not two (MCR-118)
        assert_eq!(actions.iter().filter(|a| a["where"]["session"] == "ex").count(), 1);
        assert_eq!(actions[0]["live"]["prompt"], NOW + 1);
        // An open needs_human report is an action, also of a session on no track
        let report = actions.iter().find(|a| a["kind"] == "report").unwrap();
        assert_eq!((&report["where"]["session"], &report["detail"], &report["source"][0]), (&json!("peer"), &json!("Which key?"), &json!("r1")));
        // An item without a published wait shows what its owner registered; a published one stays
        let items = &read["tracks"][0]["items"];
        assert_eq!((&items[0]["waitsOn"]["kind"], &items[0]["waitsOn"]["derived"], &items[0]["waitsOn"]["overdue"]), (&json!("ci"), &json!("wait"), &json!(true)));
        assert_eq!(items[1]["waitsOn"]["what"], "service restart");
        assert!(items[1]["waitsOn"].get("derived").is_none());
        // The published state is not rewritten; the facts stand beside it
        assert_eq!(items[0]["state"], "doing");
        assert_eq!(read["sessions"]["ex"]["needsOperator"], true);
        assert_eq!(read["sessions"]["ex"]["doneReport"], "r0");
        assert_eq!(read["sessions"]["ex"]["waits"][0]["id"], "w1");
        // None of it is in the stored document
        let stored = serde_json::to_string(&c).unwrap();
        assert!(!stored.contains("derived") && !stored.contains("Which key?") && !stored.contains("CI run"));
        // A published action that names the report stands for it, and says whether it is still open
        let mut c = c;
        f.sessions.get_mut("sup").unwrap().needs_human = Some(("r2".into(), "Merge?".into(), NOW));
        f.reports.insert("r2".into(), "sup".into());
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "source": ["r2", "MCR-95"] } }), NOW).unwrap();
        let read = c.read(&f, None);
        assert_eq!(read["actions"].as_array().unwrap().iter().filter(|a| a["kind"] == "report").count(), 1, "only the peer's");
        assert_eq!(read["actions"][0]["live"]["reportOpen"], true);
        f.sessions.get_mut("sup").unwrap().needs_human = None;
        assert_eq!(c.read(&f, None)["actions"][0]["live"]["reportOpen"], false);
        // A derived entry, and what was merged into a published one, that come back in a publish are dropped, not stored as the agent's
        let read = c.read(&f, None);
        assert!(read["actions"][0]["live"]["prompt"].is_u64());
        c.publish(&SUP, &f, &json!({ "tracks": read["tracks"], "actions": read["actions"] }), NOW).unwrap();
        assert_eq!(c.parts["sup"].actions.len(), 1);
        assert!(!serde_json::to_string(&c).unwrap().contains("\"live\""));
        assert!(c.parts["sup"].tracks[0].items[0].waits_on.is_none());
    }

    #[test]
    fn a_session_reads_its_own_part_and_those_below_it() {
        let mut c = published();
        let mut f = facts();
        c.publish(&ROOT_WHO, &f, &json!({ "tracks": [{ "id": "all", "title": "Everything", "state": "moving" }] }), NOW).unwrap();
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW);
        f.sessions.get_mut("peer").unwrap().prompt = Some(NOW);
        f.sessions.get_mut("peer").unwrap().waits = vec![FactWait { id: "w9".into(), ..FactWait::default() }];
        let mut t = track();
        t["items"][0]["owner"] = json!("peer");
        c.patch(&SUP, &f, &json!({ "track": t }), NOW).unwrap();
        let mine = c.read(&f, Some("sup"));
        assert_eq!(mine["tracks"].as_array().unwrap().len(), 1);
        // Its executor's prompt, merged into its own action for that executor; the peer's is not its to see
        assert!(mine["actions"].as_array().unwrap().iter().all(|a| a["derived"] != "prompt"));
        assert_eq!(mine["actions"][0]["live"]["prompt"], NOW);
        assert!(!mine.to_string().contains("\"peer\",\"since\""));
        // A peer it names: its name and state, not what it waits for
        assert_eq!(mine["sessions"]["peer"]["state"], "working");
        assert!(mine["sessions"]["peer"].get("waits").is_none() && mine["sessions"]["peer"].get("needsOperator").is_none());
        assert!(mine["tracks"][0]["items"][0].get("waitsOn").is_none());
        // An executor sees nothing of its supervisor's part; another session nothing of either
        assert!(c.read(&f, Some("ex"))["tracks"].as_array().unwrap().is_empty());
        assert!(c.read(&f, Some("peer"))["tracks"].as_array().unwrap().is_empty());
        assert_eq!(c.read(&f, None)["tracks"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_part_follows_a_restart_and_goes_with_a_forgotten_session() {
        let mut c = published();
        let mut f = facts();
        c.publish(&ROOT_WHO, &f, &json!({ "tracks": [{ "id": "all", "title": "Everything", "state": "moving", "items": [{ "id": "i", "title": "x", "owner": "ex", "state": "waiting", "waitsOn": { "kind": "session", "who": "ex" } }] }], "order": [{ "by": "sup", "id": "t1" }] }), NOW).unwrap();
        c.moved("ex", "ex2");
        c.moved("sup", "sup2");
        assert!(c.parts.contains_key("sup2") && !c.parts.contains_key("sup"));
        assert_eq!(c.order[0].by, "sup2");
        let t = &c.parts["sup2"].tracks[0];
        assert_eq!((t.lead.as_str(), t.items[0].owner.as_str(), c.parts["sup2"].actions[0].place.session.as_str()), ("ex2", "ex2", "ex2"));
        assert_eq!(c.parts[ROOT].tracks[0].items[0].waits_on.as_ref().unwrap().who, "ex2");
        // An ended session that is still listed keeps its part, and the read says so
        let ended = f.sessions.remove("sup").map(|s| Fact { ended: true, ..s }).unwrap();
        f.sessions.insert("sup2".into(), ended);
        assert_eq!(c.read(&f, None)["sessions"]["sup2"]["ended"], true);
        assert_eq!(c.read(&f, None)["sessions"]["ex2"]["gone"], true);
        let version = c.version;
        assert!(!c.keep(|id| id == "sup2"));
        assert!(c.keep(|_| false));
        assert!(c.parts.contains_key(ROOT) && c.parts.len() == 1, "the Supervisor's part belongs to the role");
        assert!(c.order.is_empty() && c.version == version + 1);
    }

    #[test]
    fn a_stored_document_this_build_cannot_read_costs_the_cockpit_alone() {
        // A field a later build added: read, and the rest of the entry stays
        let mut stored = serde_json::to_value(published()).unwrap();
        stored["parts"]["sup"]["tracks"][0]["colour"] = json!("red");
        stored["parts"]["sup"]["tracks"][0]["items"][0]["weight"] = json!(3);
        stored["parts"]["sup"]["actions"][0]["where"]["pane"] = json!("left");
        stored["later"] = json!(true);
        let c = load(stored.clone());
        assert_eq!((c.version, c.parts["sup"].tracks[0].items.len(), c.parts["sup"].actions[0].say.as_str()), (1, 2, "merge MCR-95"));
        // What a session sends is still held to the schema
        let mut c = c;
        assert!(c.patch(&SUP, &facts(), &json!({ "track": { "id": "t1", "colour": "red" } }), NOW).unwrap_err().contains("colour"));
        assert!(c.patch(&SUP, &facts(), &json!({ "item": { "id": "i1", "weight": 3 }, "of": "t1" }), NOW).unwrap_err().contains("weight"));
        assert!(c.patch(&SUP, &facts(), &json!({ "action": { "id": "a1", "where": { "session": "ex", "pane": "left" } } }), NOW).unwrap_err().contains("pane"));
        // A document of a later schema, or a damaged one: an empty cockpit, and no error
        stored["schema"] = json!(SCHEMA + 1);
        assert!(load(stored.clone()).parts.is_empty());
        stored["schema"] = json!(SCHEMA);
        stored["parts"]["sup"]["tracks"] = json!("all of them");
        assert!(load(stored).parts.is_empty());
        assert!(load(json!([1, 2])).parts.is_empty());
    }

    #[test]
    fn a_session_that_ended_stays_named_where_it_gives_no_rights() {
        let mut c = published();
        let mut f = facts();
        // `ex` did its item and was ended; then it is forgotten
        f.sessions.get_mut("ex").unwrap().ended = true;
        c.patch(&SUP, &f, &json!({ "item": { "id": "i1", "state": "done" }, "of": "t1" }), NOW + 1).unwrap();
        c.patch(&SUP, &f, &json!({ "item": { "id": "i2", "waitsOn": { "kind": "session", "who": "ex" } }, "of": "t1" }), NOW + 2).unwrap();
        f.sessions.remove("ex");
        c.patch(&SUP, &f, &json!({ "track": { "id": "t1", "state": "done" } }), NOW + 3).unwrap();
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "urgency": "now" } }), NOW + 4).unwrap();
        let read = c.read(&f, None);
        c.publish(&SUP, &f, &json!({ "tracks": read["tracks"], "actions": read["actions"] }), NOW + 5).unwrap();
        assert_eq!((c.parts["sup"].tracks[0].lead.as_str(), c.parts["sup"].tracks[0].items[0].owner.as_str()), ("ex", "ex"));
        // An ended session may be named as an owner anew; an unknown one, or a new lead or target, may not
        f.sessions.insert("gone2".into(), Fact { ended: true, ..Fact::default() });
        c.patch(&SUP, &f, &json!({ "item": { "id": "i3", "title": "Old", "owner": "gone2", "state": "done" }, "of": "t1" }), NOW + 6).unwrap();
        assert!(c.patch(&SUP, &f, &json!({ "item": { "id": "i4", "title": "x", "owner": "nobody", "state": "done" }, "of": "t1" }), NOW).unwrap_err().contains("owner"));
        assert!(c.patch(&SUP, &f, &json!({ "track": { "id": "t2", "title": "x", "state": "done", "lead": "ex" } }), NOW).unwrap_err().contains("tracks[1].lead"));
        assert!(c.patch(&SUP, &f, &json!({ "track": { "id": "t1", "lead": "gone" } }), NOW).unwrap_err().contains("tracks[0].lead"));
        assert!(c.patch(&SUP, &f, &json!({ "action": { "id": "a2", "track": "t1", "title": "x", "kind": "typed_word", "where": { "session": "ex" }, "say": "go", "risk": "reversible" } }), NOW).unwrap_err().contains("where.session"));
        assert!(c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "where": { "session": "gone" } } }), NOW).unwrap_err().contains("where.session"));
    }

    #[test]
    fn a_line_for_an_input_box_holds_nothing_the_operator_cannot_see() {
        for hidden in ['\u{200b}', '\u{200d}', '\u{200e}', '\u{2060}', '\u{feff}', '\u{ad}', '\u{2028}', '\u{2029}', '\u{e0041}', '\u{e000}', '\u{61c}', '\u{fff9}', '\u{f0000}'] {
            let line = format!("ok merge{hidden}and push");
            for (a, place) in [
                (action("typed_word", json!({ "where": { "session": "ex" }, "say": line })), "actions[0].say"),
                (action("decision", json!({ "options": ["Keep", line] })), "actions[0].options[1]"),
                (action("live_check", json!({ "detail": "x", "where": { "command": line } })), "where.command"),
            ] {
                let err = with_action(a).unwrap_err();
                assert!(err.contains(place) && err.contains(&format!("U+{:04X}", hidden as u32)), "{:x} {place}: {err}", hidden as u32);
            }
            // In a link such a character is refused, or it is in the address only as its visible %-code
            match web_link(&format!("https://example.com/a{hidden}b")) {
                Ok(link) => assert!(!link.href.contains(hidden) && link.href.is_ascii(), "{}", link.href),
                Err(why) => assert!(!why.is_empty()),
            }
        }
        // Text that is only shown: no separators that break a line unseen and no tag characters
        for hidden in ['\u{2028}', '\u{2029}', '\u{e0041}', '\u{2066}'] {
            assert!(with_action(action("decision", json!({ "options": ["a", "b"], "title": format!("Choose{hidden}now") }))).is_err(), "{:x}", hidden as u32);
            assert!(with_action(action("decision", json!({ "options": ["a", "b"], "detail": format!("Choose{hidden}now") }))).is_err(), "{:x}", hidden as u32);
        }
        // Other scripts and joined emoji stay possible there
        with_action(action("decision", json!({ "options": ["a", "b"], "title": "Wähle: 選択 👨\u{200d}👩\u{200d}👧" }))).unwrap();
        with_action(action("typed_word", json!({ "where": { "session": "ex" }, "say": "übernimm main, s'il te plaît" }))).unwrap();
    }

    #[test]
    fn only_the_reporter_or_a_session_above_it_stands_for_its_report() {
        let mut c = published();
        let mut f = facts();
        // The supervisor's action points the operator at itself, not at the reporter
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "where": { "session": "sup" } } }), NOW).unwrap();
        f.reports.insert("r1".into(), "ex".into());
        f.sessions.get_mut("ex").unwrap().needs_human = Some(("r1".into(), "Which key?".into(), NOW));
        let derived = |c: &Cockpit, f: &Facts| c.read(f, None)["actions"].as_array().unwrap().iter().filter(|a| a["kind"] == "report").count();
        let a1 = |c: &Cockpit, f: &Facts| c.read(f, None)["actions"].as_array().unwrap().iter().find(|a| a["id"] == "a1").unwrap().clone();
        // A session of another tree names the report: the service's own entry stays
        c.publish(&Who { id: "peer", root: false }, &f, &json!({ "tracks": [{ "id": "p", "title": "Mine", "state": "moving" }], "actions": [{ "id": "quiet", "track": "p", "title": "Nothing to see", "kind": "decision", "options": ["a", "b"], "risk": "reversible", "source": ["r1"] }] }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 1);
        let read = c.read(&f, None);
        assert!(read["actions"].as_array().unwrap().iter().find(|a| a["id"] == "quiet").unwrap().get("live").is_none());
        // Its supervisor does stand for it; so does the reporter itself, and the Supervisor
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "source": ["r1"] } }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 0);
        assert_eq!(a1(&c, &f)["live"]["reportOpen"], true);
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "source": [] } }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 1);
        // Without naming it, an action that points the operator at the reporter takes the report in (MCR-118)
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "where": { "session": "ex" } } }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 0);
        assert_eq!((&a1(&c, &f)["live"]["report"]["id"], &a1(&c, &f)["live"]["report"]["text"]), (&json!("r1"), &json!("Which key?")));
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "where": { "session": "sup" } } }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 1);
        c.publish(&ROOT_WHO, &f, &json!({ "actions": [{ "id": "x", "title": "Answer", "kind": "decision", "options": ["a", "b"], "risk": "reversible", "source": ["r1"] }] }), NOW).unwrap();
        assert_eq!(derived(&c, &f), 0);
    }

    #[test]
    fn needs_you_holds_what_the_harness_knows_without_anyone_publishing() {
        // Nothing published at all (MCR-118)
        let c = Cockpit::default();
        let mut f = facts();
        f.root = Some("root".into());
        let rows = |c: &Cockpit, f: &Facts| c.read(f, None)["actions"].as_array().unwrap().iter().map(|a| (a["kind"].as_str().unwrap().to_string(), a["where"]["session"].as_str().unwrap().to_string())).collect::<Vec<_>>();
        assert!(rows(&c, &f).is_empty());
        // A prompt: a row at the next read
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW);
        assert_eq!(rows(&c, &f), [("answer_prompt".to_string(), "ex".to_string())]);
        // The operator's unsent line, with since when; the line's text is never known here
        f.sessions.get_mut("peer").unwrap().held = Some(NOW - 90_000);
        let read = c.read(&f, None);
        let held = read["actions"].as_array().unwrap().iter().find(|a| a["kind"] == "held_line").unwrap();
        assert_eq!((&held["derived"], &held["since"], &held["where"]["session"]), (&json!("held"), &json!(NOW - 90_000), &json!("peer")));
        assert!(held["title"].as_str().unwrap().contains("wait for a line you have not sent there"));
        // Never Ctrl+C: in a working agent it stops the turn (MCR-122)
        assert!(held["detail"].as_str().unwrap().contains("If its input box is empty, press Enter there") && !held.to_string().contains("Ctrl+C"));
        // Not the Supervisor's own line: its box is under the panel
        f.sessions.get_mut("root").unwrap().held = Some(NOW - 90_000);
        assert!(!rows(&c, &f).iter().any(|(_, s)| s == "root"));
        // A human wait past its time; not one in time, and not a wait on CI
        f.sessions.get_mut("sh").unwrap().waits = vec![
            FactWait { id: "w1".into(), kind: "human".into(), on: "a go for the fault run".into(), reference: String::new(), since: NOW - 5, overdue: true },
            FactWait { id: "w2".into(), kind: "human".into(), on: "later".into(), reference: String::new(), since: NOW, overdue: false },
            FactWait { id: "w3".into(), kind: "pipeline".into(), on: "CI".into(), reference: String::new(), since: NOW, overdue: true },
        ];
        let read = c.read(&f, None);
        let waits: Vec<&Value> = read["actions"].as_array().unwrap().iter().filter(|a| a["kind"] == "human_wait").collect();
        assert_eq!(waits.len(), 1);
        assert_eq!((&waits[0]["id"], &waits[0]["detail"], &waits[0]["derived"]), (&json!("wait:w1"), &json!("a go for the fault run"), &json!("wait")));
        // Each state that clears takes its row with it
        f.sessions.get_mut("ex").unwrap().prompt = None;
        f.sessions.get_mut("peer").unwrap().held = None;
        f.sessions.get_mut("sh").unwrap().waits.clear();
        assert!(rows(&c, &f).is_empty());
        // An ended session asks nothing any more
        f.sessions.get_mut("gone").unwrap().prompt = Some(NOW);
        assert!(rows(&c, &f).is_empty());
    }

    #[test]
    fn a_fact_goes_into_a_published_action_for_its_session_only_when_that_one_stands_for_it() {
        let mut c = published();
        let mut f = facts();
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW + 1);
        f.sessions.get_mut("ex").unwrap().held = Some(NOW + 2);
        f.sessions.get_mut("ex").unwrap().waits = vec![FactWait { id: "w1".into(), kind: "human".into(), on: "a go".into(), reference: String::new(), since: NOW, overdue: true }];
        // The supervisor's action points the operator at its executor: one row with the facts on it
        let read = c.read(&f, None);
        let actions = read["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!((&actions[0]["id"], &actions[0]["live"]["prompt"], &actions[0]["live"]["held"], &actions[0]["live"]["waits"][0]["on"]), (&json!("a1"), &json!(NOW + 1), &json!(NOW + 2), &json!("a go")));
        // An action the owner already typed for is behind: the facts are rows of their own again
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW + 5);
        let read = c.read(&f, None);
        assert!(read["actions"].as_array().unwrap().iter().find(|a| a["id"] == "a1").unwrap().get("live").is_none());
        assert_eq!(read["actions"].as_array().unwrap().iter().filter(|a| a.get("derived").is_some()).count(), 3);
        f.sessions.get_mut("ex").unwrap().typed = None;
        // A session of another tree points at the executor: its action takes nothing in
        c = Cockpit::default();
        let mut peer_facts = f.clone();
        // (bound to `peer` when it published, since then to `sup`)
        peer_facts.sessions.get_mut("ex").unwrap().above = vec!["peer".into()];
        c.publish(&Who { id: "peer", root: false }, &peer_facts, &json!({ "tracks": [{ "id": "p", "title": "Mine", "state": "moving" }], "actions": [{ "id": "p1", "track": "p", "title": "Say go", "kind": "typed_word", "where": { "session": "ex" }, "say": "go", "risk": "reversible" }] }), NOW).unwrap();
        let read = c.read(&f, None);
        let actions = read["actions"].as_array().unwrap();
        assert!(actions[0].get("live").is_none());
        assert_eq!(actions.iter().filter(|a| a.get("derived").is_some()).count(), 3);
        // Not into an action that may be out of date, nor one whose publisher ended: today's
        // prompt would read under an old title (review of MCR-118)
        let c = published();
        let mut f = facts();
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW + STALE_AFTER_MS + 2);
        f.now = NOW + STALE_AFTER_MS;
        assert_eq!(c.read(&f, None)["actions"][0]["live"]["prompt"], NOW + STALE_AFTER_MS + 2, "still fresh");
        f.now = NOW + STALE_AFTER_MS + 1;
        let read = c.read(&f, None);
        assert!(read["actions"][0].get("live").is_none());
        assert!(read["actions"].as_array().unwrap().iter().any(|a| a["derived"] == "prompt" && a["where"]["session"] == "ex"));
        f.now = NOW;
        f.sessions.get_mut("sup").unwrap().ended = true;
        let read = c.read(&f, None);
        assert!(read["actions"][0].get("live").is_none());
        assert!(read["actions"].as_array().unwrap().iter().any(|a| a["derived"] == "prompt" && a["where"]["session"] == "ex"));
        // None of the new kinds can be published
        for kind in ["held_line", "human_wait"] {
            assert!(with_action(action(kind, json!({ "where": { "session": "ex" } }))).unwrap_err().contains("cannot be published"), "{kind}");
        }
    }

    #[test]
    fn the_document_survives_the_store_and_an_older_store_has_none() {
        let c = published();
        let back: Cockpit = serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!((back.schema, back.version, &back.parts, &back.order), (c.schema, c.version, &c.parts, &c.order));
        let old: Cockpit = serde_json::from_str("{}").unwrap();
        assert!(old.parts.is_empty() && old.version == 0);
        assert_eq!(old.read(&facts(), None)["tracks"], json!([]));
    }

    // ---- Needs (MCR-124, S1) ----

    /// A decision `sup` asks, with what is given in `more` laid over it.
    fn need(more: Value) -> Value {
        let mut n = json!({ "id": "n1", "ask": "decision", "options": [
            { "id": "a", "label": "Use main", "risk": "reversible" },
            { "id": "b", "label": "Use a branch", "risk": "reversible", "recommended": true },
        ] });
        for (k, v) in more.as_object().unwrap() {
            n[k.as_str()] = v.clone();
        }
        n
    }

    #[test]
    fn a_need_is_declared_checked_and_replaced_by_its_id() {
        let mut c = published();
        c.declare(&SUP, &facts(), &need(json!({ "item": "i1", "actor": "ex", "urgency": "today", "checkBy": 120 })), "Which branch?", NOW).unwrap();
        let n = &c.parts["sup"].needs[0];
        assert_eq!((n.text.as_str(), n.since, n.updated, n.actor.as_str(), n.check_by), ("Which branch?", NOW, NOW, "ex", 120));
        // The same id again replaces it, as a new declaration: a click names the newer stamp
        c.declare(&SUP, &facts(), &need(json!({})), "Which branch now?", NOW + 5).unwrap();
        let n = &c.parts["sup"].needs[0];
        assert_eq!((c.parts["sup"].needs.len(), n.text.as_str(), n.since, n.updated), (1, "Which branch now?", NOW, NOW + 5));
        assert!(n.actor.is_empty(), "replaced, not merged");
        // Publishing tracks and actions leaves the needs as they are
        c.publish(&SUP, &facts(), &json!({ "tracks": [track()] }), NOW + 6).unwrap();
        assert_eq!(c.parts["sup"].needs.len(), 1);
        assert!(c.publish(&SUP, &facts(), &json!({ "tracks": [track()], "actions": [action("typed_word", json!({ "id": "n1", "where": { "session": "ex" }, "say": "go" }))] }), NOW + 7).unwrap_err().contains("need you asked"));
        assert!(published().declare(&SUP, &facts(), &need(json!({ "id": "a1" })), "Q?", NOW).unwrap_err().contains("need.id"));
        // Each refusal names the place of the first fault, and stores nothing
        let refused = |n: Value| {
            let mut c = Cockpit::default();
            let e = c.declare(&SUP, &facts(), &n, "Which one?", NOW).unwrap_err();
            assert!(c.parts.is_empty() && c.version == 0, "{e}");
            e
        };
        // What the harness builds from its own facts is never declared (L3)
        for kind in ["prompt", "held_line", "report", "done", "human_wait", "answer_prompt"] {
            assert!(refused(need(json!({ "ask": kind }))).contains("built by the harness"), "{kind}");
        }
        assert!(refused(need(json!({ "id": "prompt:ex" }))).contains("need.id"));
        assert!(refused(need(json!({ "ask": "go" }))).contains("exactly one"));
        assert!(refused(need(json!({ "ask": "question" }))).contains("no choices"));
        assert!(refused(need(json!({ "ask": "secret_step", "options": [], "detail": "1. open it", "word": "paid" }))).contains("need.word"));
        assert!(refused(need(json!({ "options": [{ "id": "a", "label": "Pay", "risk": "spend" }, { "id": "b", "label": "Wait", "risk": "reversible" }] }))).contains("need.options[0].amount"));
        assert!(refused(need(json!({ "options": [{ "id": "a", "label": "Pay", "risk": "reversible", "recommended": true }, { "id": "b", "label": "Wait", "risk": "reversible", "recommended": true }] }))).contains("at most one"));
        assert!(refused(need(json!({ "actor": "peer" }))).contains("need.actor"));
        assert!(refused(need(json!({ "actor": "sh" }))).contains("not an agent"));
        assert!(refused(need(json!({ "where": { "session": "ex" } }))).contains("goes to actor"));
        assert!(refused(need(json!({ "ask": "go", "exact": true, "word": "push", "options": [{ "id": "go", "label": "push it", "risk": "reversible" }] }))).contains("need.exact"));
        assert!(refused(need(json!({ "colour": "red" }))).contains("colour"));
        assert!(refused(need(json!({ "cause": ["report:nope"] }))).contains("need.cause[0]"));
        assert!(refused(need(json!({ "blocks": ["item:t1/i1"] }))).contains("need.blocks[0]"), "no such track in an empty part");
        assert!(refused(need(json!({ "track": "t9" }))).contains("need.track"));
        assert!(refused(need(json!({ "ask": "external", "options": [] }))).contains("need.where.url"));
        // The framed line must fit (M4): a label that passes alone may not with "Decision sup/n1: " before it
        let long = "x".repeat(110);
        assert!(refused(need(json!({ "options": [{ "id": "a", "label": long, "risk": "reversible" }, { "id": "b", "label": "no", "risk": "reversible" }] }))).contains("need.options[0].label"));
        assert!(refused(need(json!({ "options": [{ "id": "a", "label": "/compact", "risk": "reversible" }, { "id": "b", "label": "no", "risk": "reversible" }] }))).contains("need.options[0].label"));
        // The question is one line; the rest goes in detail
        assert!(Cockpit::default().declare(&SUP, &facts(), &need(json!({})), "line one\nline two", NOW).unwrap_err().contains("need.detail"));
        assert!(Cockpit::default().declare(&SUP, &facts(), &need(json!({})), "", NOW).unwrap_err().contains("text"));
        // Causes and blocks the harness has: a prompt, a session's wait, another need
        let mut f = facts();
        f.sessions.get_mut("ex").unwrap().waits.push(FactWait { id: "w1".into(), kind: "human".into(), ..FactWait::default() });
        let mut c = published();
        c.declare(&SUP, &f, &need(json!({ "id": "n2", "cause": ["prompt:ex", "wait:w1"], "blocks": ["item:t1/i2"] })), "Second?", NOW).unwrap();
        c.declare(&ROOT_WHO, &f, &need(json!({ "id": "n3", "cause": ["need:sup/n2"], "blocks": ["need:sup/n2"] })), "Third?", NOW).unwrap();
        assert!(c.declare(&ROOT_WHO, &f, &need(json!({ "id": "n4", "cause": ["need:root/n3"] })), "Fourth?", NOW).unwrap_err().contains("cause[0]"), "the root part is called supervisor");
        assert!(c.declare(&ROOT_WHO, &f, &need(json!({ "id": "n3", "cause": ["need:supervisor/n3"] })), "Itself?", NOW).unwrap_err().contains("cause[0]"));
    }

    /// Fake credentials, put together at run time so that no scanner takes this file for a leak.
    fn fakes() -> Vec<String> {
        let body = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        vec![
            ["xo", "xb-", "1234-", body].concat(),
            ["xa", "pp-", body].concat(),
            ["gh", "p_", body].concat(),
            ["git", "hub_pat_", body].concat(),
            ["sk", "-ant-", body].concat(),
            ["sk", "-", body].concat(),
            ["AK", "IA", "ABCDEFGHIJ234567"].concat(),
            ["Bear", "er ", body, ".", body].concat(),
            ["-----BEGIN RSA ", "PRIVATE KEY-----"].concat(),
        ]
    }

    #[test]
    fn text_that_looks_like_a_credential_is_refused_without_repeating_it() {
        for secret in fakes() {
            assert!(looks_secret(&format!("use {secret} now")), "{secret}");
            for (field, value) in [("why", json!(format!("use {secret}"))), ("detail", json!(format!("steps:\n{secret}")))] {
                let mut more = json!({});
                more[field] = value;
                let e = Cockpit::default().declare(&SUP, &facts(), &need(more), "Which one?", NOW).unwrap_err();
                assert!(e.contains(&format!("need.{field}")) && e.contains("credential") && !e.contains(&secret), "{e}");
            }
            let e = Cockpit::default().declare(&SUP, &facts(), &need(json!({})), &format!("Use {secret}?"), NOW).unwrap_err();
            assert!(e.contains("credential") && !e.contains(&secret), "{e}");
            // The same for what cockpit_publish takes, and again at the click (`placeable`)
            assert!(with_action(action("live_check", json!({ "detail": format!("run with {secret}") }))).unwrap_err().contains("credential"));
            assert!(placeable(&format!("use {secret}")).unwrap_err().contains("credential"), "{secret}");
        }
        for fine in ["the ghp_ prefix of a token", "ask-anthropic", "AKIA keys rotate", "a Bearer token", "risk-free", "task-antelope-1234567890123456789"] {
            assert!(!looks_secret(fine), "{fine}");
        }
    }

    #[test]
    fn a_need_is_one_entry_of_the_one_view_and_an_action_for_an_older_panel() {
        let mut f = facts();
        let mut c = published();
        c.declare(&SUP, &f, &need(json!({ "actor": "ex", "item": "i1" })), "Which branch?", NOW).unwrap();
        // Asked with a report: it stands for that report, so the report is no row of its own
        f.reports.insert("r9".into(), "sup".into());
        f.sessions.get_mut("sup").unwrap().needs_human = Some(("r9".into(), "Which branch?".into(), NOW));
        c.cite(&SUP, "n1", "r9");
        let read = c.read(&f, None);
        let n = read["needs"].as_array().unwrap().iter().find(|n| n["id"] == "n1").unwrap();
        assert_eq!((&n["attach"], &n["guarded"], &n["risk"], &n["cause"][0]), (&json!({ "by": "sup", "track": "t1" }), &json!(false), &json!("reversible"), &json!("report:r9")));
        let a = read["actions"].as_array().unwrap().iter().find(|a| a["id"] == "n1").unwrap();
        assert_eq!((&a["kind"], &a["where"]["session"], &a["options"], &a["recommended"], &a["live"]["reportOpen"]), (&json!("decision"), &json!("ex"), &json!(["Use main", "Use a branch"]), &json!("Use a branch"), &json!(true)));
        assert!(!read["actions"].as_array().unwrap().iter().any(|a| a["kind"] == "report"));
        assert!(!read["needs"].as_array().unwrap().iter().any(|n| n["id"] == "report:r9"));
        // The acting session's prompt joins an entry that points the operator there (here the
        // older action a1, which comes first), and puts it first
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW + 1);
        let read = c.read(&f, None);
        assert_eq!(read["needs"][0]["live"]["prompt"], json!(NOW + 1));
        assert!(!read["needs"].as_array().unwrap().iter().any(|n| n["id"] == "prompt:ex"));
        let alone = {
            let mut c = Cockpit::default();
            c.publish(&SUP, &f, &json!({ "tracks": [track()] }), NOW).unwrap();
            c.declare(&SUP, &f, &need(json!({ "actor": "ex" })), "Which branch?", NOW).unwrap();
            c.read(&f, None)
        };
        assert_eq!((&alone["needs"][0]["id"], &alone["needs"][0]["live"]["prompt"]), (&json!("n1"), &json!(NOW + 1)));
        // A done report is quiet, and only in the one view (Q6)
        f.sessions.get_mut("peer").unwrap().done = Some(("r8".into(), "Shipped".into(), NOW));
        let read = c.read(&f, None);
        let done = read["needs"].as_array().unwrap().iter().find(|n| n["id"] == "done:r8").unwrap();
        assert_eq!((&done["ask"], &done["urgency"], &done["attach"], &done["detail"]), (&json!("done"), &json!("whenever"), &Value::Null, &json!("Shipped")));
        assert!(!read["actions"].as_array().unwrap().iter().any(|a| a["id"] == "done:r8"));
        // A v1 action is in the one view too, in the newer words
        let a1 = read["needs"].as_array().unwrap().iter().find(|n| n["id"] == "a1").unwrap();
        assert_eq!((&a1["ask"], &a1["exact"], &a1["options"][0]["label"], &a1["fromAction"]), (&json!("go"), &json!(true), &json!("merge MCR-95"), &json!(true)));
        // The session that acts reads the need it answers, though not the part (M3)
        let mine = c.read(&f, Some("ex"));
        assert!(mine["needs"].as_array().unwrap().iter().any(|n| n["id"] == "n1") && mine["tracks"].as_array().unwrap().is_empty());
        assert!(!c.read(&f, Some("peer"))["needs"].as_array().unwrap().iter().any(|n| n["id"] == "n1"));
        // A guarded need: no button in either form
        c.declare(&SUP, &f, &need(json!({ "id": "n2", "options": [{ "id": "a", "label": "Run it", "risk": "spend", "amount": "40 EUR" }, { "id": "b", "label": "Wait", "risk": "reversible" }] })), "Run the paid step?", NOW).unwrap();
        let read = c.read(&f, None);
        let n2 = read["needs"].as_array().unwrap().iter().find(|n| n["id"] == "n2").unwrap();
        assert_eq!((&n2["guarded"], &n2["risk"], &n2["unclickable"]), (&json!(true), &json!("spend"), &json!(["options"])));
        let a2 = read["actions"].as_array().unwrap().iter().find(|a| a["id"] == "n2").unwrap();
        assert_eq!((&a2["unclickable"], &a2["amount"], &a2["where"]["session"]), (&json!(["options"]), &json!("40 EUR"), &json!("sup")));
        // Closed: out of both lists, readable under closed
        c.close(&SUP, &f, "n1", Closed { outcome: "answered".into(), chosen: "b".into(), note: "main it is".into(), at: NOW + 2 }).unwrap();
        let read = c.read(&Facts { now: NOW + 3, ..f.clone() }, None);
        assert!(!read["needs"].as_array().unwrap().iter().any(|n| n["id"] == "n1") && !read["actions"].as_array().unwrap().iter().any(|a| a["id"] == "n1"));
        assert_eq!((&read["closed"][0]["id"], &read["closed"][0]["closed"]["chosen"]), (&json!("n1"), &json!("b")));
        assert!(c.read(&Facts { now: NOW + 2 + CLOSED_KEPT_MS, ..f.clone() }, None)["closed"].as_array().unwrap().is_empty());
        assert!(c.close(&SUP, &f, "n1", Closed { outcome: "answered".into(), chosen: "".into(), note: "".into(), at: NOW + 4 }).unwrap_err().contains("not an open need"));
        assert!(c.close(&SUP, &f, "n2", Closed { outcome: "answered".into(), chosen: "zz".into(), note: "".into(), at: NOW + 4 }).unwrap_err().contains("chosen"));
        assert!(c.close(&SUP, &f, "n2", Closed { outcome: "maybe".into(), chosen: "".into(), note: "".into(), at: NOW + 4 }).unwrap_err().contains("outcome"));
    }

    #[test]
    fn every_entry_of_the_one_view_belongs_to_a_track_or_to_none() {
        let mut f = facts();
        let mut c = Cockpit::default();
        c.publish(&SUP, &f, &json!({ "tracks": [track()] }), NOW).unwrap();
        // The Supervisor's tracks, in its order: sup leads r1; the root leads r2, where peer owns an open item
        c.publish(&ROOT_WHO, &f, &json!({ "tracks": [
            { "id": "r1", "title": "Lead", "lead": "sup", "state": "moving" },
            { "id": "r2", "title": "Root", "lead": "root", "state": "moving", "items": [{ "id": "x", "title": "X", "owner": "peer", "state": "doing" }] },
        ], "order": [{ "by": "supervisor", "id": "r2" }, { "by": "supervisor", "id": "r1" }] }), NOW).unwrap();
        for id in ["ex", "sup", "sh", "peer", "root"] {
            f.sessions.get_mut(id).unwrap().prompt = Some(NOW);
        }
        f.root = Some("root".into());
        let read = c.read(&f, None);
        let at = |id: &str| read["needs"].as_array().unwrap().iter().find(|n| n["id"] == format!("prompt:{id}")).unwrap()["attach"].clone();
        assert_eq!(at("ex"), json!({ "by": "sup", "track": "t1" }), "the track it leads");
        assert_eq!(at("sup"), json!({ "by": "supervisor", "track": "r1" }), "the track it leads");
        assert_eq!(at("peer"), json!({ "by": "supervisor", "track": "r2" }), "the track where it owns an open item");
        assert_eq!(at("sh"), json!({ "by": "supervisor", "track": "r1" }), "the track of the session above it");
        assert_eq!(at("root"), json!({ "by": "supervisor", "track": "r2" }));
        // Without any of these: unassigned
        c.parts.remove(ROOT);
        assert_eq!(c.read(&f, None)["needs"].as_array().unwrap().iter().find(|n| n["id"] == "prompt:peer").unwrap()["attach"], Value::Null);
    }

    #[test]
    fn a_click_on_a_need_places_the_line_the_service_builds_in_the_acting_session() {
        let mut f = facts();
        let mut c = published();
        c.declare(&SUP, &f, &need(json!({ "actor": "ex" })), "Which branch?", NOW).unwrap();
        let stamp = c.parts["sup"].needs[0].updated;
        assert_eq!(c.act("sup", "n1", stamp, Act::Choose(1), &f).unwrap(), Deed::Type { session: "ex".into(), text: "Decision sup/n1: Use a branch".into() });
        assert!(c.act("sup", "n1", stamp + 1, Act::Choose(1), &f).unwrap_err().contains("asked again"));
        assert!(c.act("sup", "n1", stamp, Act::Choose(5), &f).unwrap_err().contains("no such choice"));
        assert!(c.act("sup", "n1", stamp, Act::Link, &f).unwrap_err().contains("nothing of this kind"));
        match c.act("sup", "n1", stamp, Act::Ask, &f).unwrap() {
            Deed::Type { session, text } => assert!(session == "sup" && text.contains("sup/n1")),
            other => panic!("{other:?}"),
        }
        // Without an actor the answer goes to the session that asked; the root part's to the Supervisor session
        c.declare(&SUP, &f, &need(json!({ "id": "n5" })), "Here?", NOW).unwrap();
        assert_eq!(c.act("sup", "n5", NOW, Act::Choose(0), &f).unwrap(), Deed::Type { session: "sup".into(), text: "Decision sup/n5: Use main".into() });
        c.declare(&ROOT_WHO, &f, &need(json!({ "id": "n6" })), "Root?", NOW).unwrap();
        assert!(c.act(ROOT, "n6", NOW, Act::Choose(0), &f).unwrap_err().contains("does not run"));
        f.root = Some("root".into());
        assert_eq!(c.act(ROOT, "n6", NOW, Act::Choose(0), &f).unwrap(), Deed::Type { session: "root".into(), text: "Decision supervisor/n6: Use main".into() });
        // An exact go places its label alone
        c.declare(&SUP, &f, &json!({ "id": "n4", "ask": "go", "exact": true, "actor": "ex", "options": [{ "id": "go", "label": "go on", "risk": "reversible" }] }), "Go on?", NOW).unwrap();
        assert_eq!(c.act("sup", "n4", NOW, Act::Place, &f).unwrap(), Deed::Type { session: "ex".into(), text: "go on".into() });
        assert_eq!(c.read(&f, None)["actions"].as_array().unwrap().iter().find(|a| a["id"] == "n4").unwrap()["say"], "go on");
        // Guarded needs are not placed by a click in this slice: an owner word, or a choice that cannot simply be undone
        c.declare(&SUP, &f, &json!({ "id": "n3", "ask": "go", "word": "push", "actor": "ex", "options": [{ "id": "go", "label": "push MCR-124", "risk": "reversible" }] }), "Push?", NOW).unwrap();
        assert!(c.act("sup", "n3", NOW, Act::Place, &f).unwrap_err().contains("owner word"));
        c.declare(&SUP, &f, &need(json!({ "id": "n2", "options": [{ "id": "a", "label": "Drop it", "risk": "irreversible" }, { "id": "b", "label": "Keep it", "risk": "reversible" }] })), "Drop the table?", NOW).unwrap();
        assert!(c.act("sup", "n2", NOW, Act::Choose(1), &f).unwrap_err().contains("owner word"));
        // The operator typed in the acting session since: no click until it is asked again
        f.sessions.get_mut("ex").unwrap().typed = Some(NOW + 1);
        assert!(c.act("sup", "n1", stamp, Act::Choose(1), &f).unwrap_err().contains("you typed"));
        let read = c.read(&f, None);
        assert_eq!(read["needs"].as_array().unwrap().iter().find(|n| n["id"] == "n1").unwrap()["ownerTyped"], NOW + 1);
        assert!(c.outdated(&f).iter().any(|o| o.need && o.id == "n1" && o.session == "ex"));
        // An acting session that left the publisher's tree is refused at the click
        f.sessions.get_mut("ex").unwrap().typed = None;
        f.sessions.get_mut("ex").unwrap().above.clear();
        assert!(c.act("sup", "n1", stamp, Act::Choose(1), &f).unwrap_err().contains("no longer works"));
        // Closed: nothing to click
        c.close(&SUP, &f, "n1", Closed { outcome: "obsolete".into(), chosen: "".into(), note: "".into(), at: NOW + 2 }).unwrap();
        assert!(c.act("sup", "n1", stamp, Act::Choose(1), &f).unwrap_err().contains("closed"));
    }

    #[test]
    fn needs_follow_a_restart_and_point_the_harness_at_their_sessions() {
        let mut c = Cockpit::default();
        c.declare(&SUP, &facts(), &need(json!({ "actor": "ex", "cause": ["prompt:ex"] })), "Which?", NOW).unwrap();
        c.declare(&SUP, &facts(), &need(json!({ "id": "n2" })), "Mine?", NOW).unwrap();
        assert!(c.points_at("ex") && c.points_at("sup") && !c.points_at("peer"));
        c.moved("ex", "ex2");
        c.moved("sup", "sup2");
        let n = &c.parts["sup2"].needs[0];
        assert_eq!((n.actor.as_str(), n.cause[0].as_str()), ("ex2", "prompt:ex2"));
        // A document of the first schema is read as it was, with no needs
        let v1 = json!({ "schema": 1, "version": 3, "parts": { "sup": { "tracks": [track()], "actions": [] } } });
        assert!(readable(&v1));
        assert_eq!(load(v1).parts["sup"].needs.len(), 0);
        assert!(!readable(&json!({ "schema": SCHEMA + 1 })));
    }
}
