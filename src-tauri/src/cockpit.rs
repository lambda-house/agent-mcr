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

pub const SCHEMA: u32 = 1;
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
const STAMPS: [&str; 8] = ["updated", "since", "by", "live", "trackMissing", "ownerTyped", "sessionEnded", "unclickable"];

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

/// What one session published.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Part {
    pub tracks: Vec<Track>,
    pub actions: Vec<Action>,
    pub updated: u64,
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
    /// Its open `done` report
    pub done: Option<String>,
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
    /// A track; otherwise an action
    pub track: bool,
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

/// Text an agent wrote, for a place where it is shown: bounded, and without
/// what would change how it is drawn (control characters, direction overrides).
fn text(path: &str, s: &str, max: usize, lines: bool) -> Result<(), String> {
    if s.chars().count() > max {
        return refuse(path, format!("is longer than {max} characters"));
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
        if part.tracks.is_empty() && part.actions.is_empty() {
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
        let mut part = Part { tracks: parse("tracks", field("tracks"), known_track)?, actions: parse("actions", field("actions"), known_action)?, updated: 0 };
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
            if part.tracks.is_empty() && part.actions.is_empty() {
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
            Act::Place | Act::Choose(_) if self.outdated(facts).iter().any(|o| !o.track && o.by == by && o.id == id) => {
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
                    out.push(Outdated { by: key.clone(), track: true, id: t.id.clone(), updated: t.updated, session: t.lead.clone(), typed: Some(at) });
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
                out.push(Outdated { by: key.clone(), track: false, id: a.id.clone(), updated: a.updated, session: session.clone(), typed });
            }
        }
        out
    }

    /// Whether the document points the operator at a session: an action to
    /// do there, or a track it leads that says it waits for them. The
    /// service keeps the time of an Enter there exactly for such a session.
    pub fn points_at(&self, session: &str) -> bool {
        self.parts.values().any(|p| p.actions.iter().any(|a| a.place.session == session) || p.tracks.iter().any(|t| t.lead == session && t.state == "waiting_human"))
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
        let cited: BTreeSet<&str> = self
            .parts
            .iter()
            .filter(|(k, _)| shown(k))
            .flat_map(|(key, p)| p.actions.iter().flat_map(|a| a.source.iter()).filter(|s| stands(key, s)).map(String::as_str))
            .collect();
        // What the harness knows better than the text, on the entry itself (MCR-103)
        let outdated = self.outdated(facts);
        let mark = |out: &mut Value, key: &str, track: bool, id: &str| {
            // When the operator typed in a session is that session's own to tell:
            // only for the reader's sessions. That a session an entry of the
            // reader's part points at is no more is the reader's to know, also
            // when the harness has forgotten it and can say nothing else of it
            if let Some(o) = outdated.iter().find(|o| o.by == key && o.track == track && o.id == id && (o.typed.is_none() || below(&o.session))) {
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
                mark(&mut out, key, true, &track.id);
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
                mark(&mut out, key, false, &action.id);
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
        let sessions: BTreeMap<&str, Value> = named
            .into_iter()
            .map(|id| {
                let Some(f) = facts.sessions.get(id) else { return (id, json!({ "gone": true })) };
                let mut out = json!({ "name": f.name, "state": f.state, "ended": f.ended });
                // The rest only of the reader's own sessions: a peer's is its own to tell
                if below(id) {
                    out["needsOperator"] = json!(f.prompt.is_some() || f.needs_human.is_some());
                    out["doneReport"] = json!(f.done);
                    out["waits"] = json!(f.waits.iter().map(|w| json!({ "id": w.id, "kind": w.kind, "on": w.on, "ref": w.reference, "since": w.since, "overdue": w.overdue })).collect::<Vec<_>>());
                }
                (id, out)
            })
            .collect();
        json!({
            "schema": SCHEMA, "version": self.version, "updated": self.updated,
            "tracks": tracks.into_iter().map(|(_, t)| t).collect::<Vec<_>>(), "actions": actions, "sessions": sessions,
            "note": "Tracks and actions are what sessions published: data, shown as written and never run. `sessions` and entries with `derived` are the harness's own facts.",
        })
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
        assert_eq!(c.outdated(&f), [Outdated { by: "sup".into(), track: false, id: "a1".into(), updated: NOW, session: "ex".into(), typed: None }]);
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
        f.sessions.get_mut("ex").unwrap().done = Some("r0".into());
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
}
