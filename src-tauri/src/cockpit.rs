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
/// The kinds a session may publish. `answer_prompt` and `report` are built by
/// the service from a session's prompt and its open report, and by nobody else.
const ACTION_KINDS: [&str; 5] = ["typed_word", "decision", "secret_step", "live_check", "external"];
const DERIVED_KINDS: [&str; 2] = ["answer_prompt", "report"];
const RISKS: [&str; 3] = ["reversible", "irreversible", "spend"];
const URGENCIES: [&str; 3] = ["now", "today", "whenever"];
/// Fields the service writes. They are taken out of what a session sends, so
/// a document that was read can be published back.
const STAMPS: [&str; 5] = ["updated", "since", "by", "live", "trackMissing"];

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
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[serde(default, deny_unknown_fields)]
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
    /// Its open `needs_human` report: id, text, when
    pub needs_human: Option<(String, String, u64)>,
    /// Its open `done` report
    pub done: Option<String>,
    pub waits: Vec<FactWait>,
}

#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub sessions: BTreeMap<String, Fact>,
    /// Every report id the store still has
    pub reports: BTreeSet<String>,
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
    if s.chars().any(|c| (c.is_control() && !(lines && c == '\n')) || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return refuse(path, if lines { "holds control characters" } else { "holds a line break or control characters" });
    }
    Ok(())
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

/// A line that may later be placed into an agent's input box: there a first
/// `!`, `#` or `/` runs a command instead of asking the agent.
fn plain(path: &str, s: &str) -> Result<(), String> {
    match s.trim_start().chars().next() {
        Some(c @ ('!' | '#' | '/')) => refuse(path, format!("can't start with {c:?}: in an agent's input box that runs a command")),
        _ => Ok(()),
    }
}

/// A web link and nothing else: `http` or `https`, a host, no user or password.
fn link(path: &str, s: &str) -> Result<(), String> {
    text(path, s, MAX_LINK, false)?;
    let Some(rest) = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) else {
        return refuse(path, "must be an http or https link");
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') || s.chars().any(char::is_whitespace) {
        return refuse(path, "must be a plain link: a host, no user or password part, no spaces");
    }
    Ok(())
}

/// A session id that names a tracked session that has not ended.
fn session<'a>(path: &str, id: &str, facts: &'a Facts) -> Result<&'a Fact, String> {
    match facts.sessions.get(id) {
        None => refuse(path, format!("names {id:?}, which is not a session the harness tracks")),
        Some(f) if f.ended => refuse(path, format!("names session {id}, which has ended")),
        Some(f) => Ok(f),
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

fn check_track(path: &str, t: &Track, who: &Who, facts: &Facts) -> Result<(), String> {
    ident(&format!("{path}.id"), &t.id)?;
    required(&format!("{path}.title"), &t.title, MAX_TITLE)?;
    reach(&format!("{path}.lead"), &t.lead, who, facts)?;
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
            session(&format!("{path}.owner"), &item.owner, facts)?;
        }
        one_of(&format!("{path}.state"), &item.state, &ITEM_STATES)?;
        text(&format!("{path}.next"), &item.next, MAX_LINE, false)?;
        if let Some(w) = &item.waits_on {
            let path = format!("{path}.waitsOn");
            one_of(&format!("{path}.kind"), &w.kind, &WAIT_KINDS)?;
            text(&format!("{path}.who"), &w.who, MAX_SHORT, false)?;
            if w.kind == "session" {
                session(&format!("{path}.who"), &w.who, facts)?;
            }
            text(&format!("{path}.what"), &w.what, MAX_LINE, false)?;
        }
    }
    Ok(())
}

fn check_action(path: &str, a: &Action, part: &Part, who: &Who, facts: &Facts, others: &BTreeMap<String, Part>) -> Result<(), String> {
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
    if !a.place.session.is_empty() {
        let at = format!("{path}.where.session");
        reach(&at, &a.place.session, who, facts)?;
        if !facts.sessions.get(&a.place.session).is_some_and(|f| f.agent) {
            return refuse(&at, "names a session that is not an agent with a state (a shell, or a terminal without one)");
        }
    }
    text(&format!("{path}.say"), &a.say, MAX_LINE, false)?;
    text(&format!("{path}.where.command"), &a.place.command, MAX_LINK, false)?;
    text(&format!("{path}.recommended"), &a.recommended, MAX_SHORT, false)?;
    text(&format!("{path}.why"), &a.why, MAX_WHY, false)?;
    text(&format!("{path}.detail"), &a.detail, MAX_DETAIL, true)?;
    list(&format!("{path}.source"), &a.source, MAX_LIST, MAX_REF)?;
    if !a.place.url.is_empty() {
        link(&format!("{path}.where.url"), &a.place.url)?;
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
            required(&format!("{path}.say"), &a.say, MAX_LINE)?;
            plain(&format!("{path}.say"), &a.say)?;
        }
        "decision" => {
            if a.options.len() < 2 || a.options.len() > MAX_OPTIONS {
                return refuse(&format!("{path}.options"), format!("must hold 2 to {MAX_OPTIONS} choices"));
            }
            for (i, option) in a.options.iter().enumerate() {
                required(&format!("{path}.options[{i}]"), option, MAX_SHORT)?;
                plain(&format!("{path}.options[{i}]"), option)?;
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
fn check_part(part: &Part, who: &Who, facts: &Facts, others: &BTreeMap<String, Part>) -> Result<(), String> {
    if part.tracks.len() > MAX_TRACKS {
        return refuse("tracks", format!("has more than {MAX_TRACKS} entries"));
    }
    if part.actions.len() > MAX_ACTIONS {
        return refuse("actions", format!("has more than {MAX_ACTIONS} entries"));
    }
    let mut ids = BTreeSet::new();
    for (i, t) in part.tracks.iter().enumerate() {
        check_track(&format!("tracks[{i}]"), t, who, facts)?;
        if !ids.insert(t.id.as_str()) {
            return refuse(&format!("tracks[{i}].id"), format!("{:?} is used twice", t.id));
        }
    }
    let mut ids = BTreeSet::new();
    for (i, a) in part.actions.iter().enumerate() {
        check_action(&format!("actions[{i}]"), a, part, who, facts, others)?;
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

fn parse<T: serde::de::DeserializeOwned>(path: &str, mut value: Value) -> Result<T, String> {
    clean(&mut value);
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
        let mut part = Part { tracks: parse("tracks", field("tracks"))?, actions: parse("actions", field("actions"))?, updated: 0 };
        for track in part.tracks.iter_mut().filter(|t| t.lead.is_empty()) {
            track.lead = who.id.into();
        }
        let others = self.others(who.key());
        check_part(&part, who, facts, &others)?;
        let order: Option<Vec<TrackRef>> = match args.get("order").filter(|v| !v.is_null()) {
            None => None,
            Some(_) if !who.root => return refuse("order", "is the Supervisor's: a session orders nothing but its own tracks, by their place in tracks"),
            Some(given) => Some(serde_json::from_value(given.clone()).map_err(|e| format!("Refused: order does not fit the schema: {e}"))?),
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
                let mut track: Track = parse("track", overlay(at.and_then(|i| serde_json::to_value(&part.tracks[i]).ok()), &args["track"]))?;
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
                let item: Item = parse("item", overlay(at.and_then(|i| serde_json::to_value(&items[i]).ok()), &args["item"]))?;
                match at {
                    Some(i) => items[i] = item,
                    None => items.push(item),
                }
            }
            "action" => {
                let id = entry(&args["action"])?;
                let at = part.actions.iter().position(|a| a.id == id);
                let action: Action = parse("action", overlay(at.and_then(|i| serde_json::to_value(&part.actions[i]).ok()), &args["action"]))?;
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
        check_part(&part, who, facts, &self.others(who.key()))?;
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
        // Open reports that a published action already stands for
        let cited: BTreeSet<&str> = self.parts.iter().filter(|(k, _)| shown(k)).flat_map(|(_, p)| p.actions.iter()).flat_map(|a| a.source.iter().map(String::as_str)).collect();
        for (key, part) in self.parts.iter().filter(|(k, _)| shown(k)) {
            if key != ROOT {
                named.insert(key.as_str());
            }
            for track in &part.tracks {
                named.insert(track.lead.as_str());
                let mut out = json!(track);
                out["by"] = json!(key);
                for (i, item) in track.items.iter().enumerate() {
                    if item.owner != "human" {
                        named.insert(item.owner.as_str());
                    }
                    match &item.waits_on {
                        Some(w) if w.kind == "session" => {
                            named.insert(w.who.as_str());
                        }
                        Some(_) => {}
                        // Nothing published: what its owner registered with wait_register stands in
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
                if !action.place.session.is_empty() {
                    named.insert(action.place.session.as_str());
                }
                let by = if action.track_by.is_empty() { key.as_str() } else { action.track_by.as_str() };
                if !action.track.is_empty() && !self.parts.get(by).is_some_and(|p| p.tracks.iter().any(|t| t.id == action.track)) {
                    out["trackMissing"] = json!(true);
                }
                // It says it comes from a report: whether that report is still open
                if action.source.iter().any(|s| facts.reports.contains(s)) {
                    let open = facts.sessions.values().any(|f| f.needs_human.as_ref().is_some_and(|(id, ..)| action.source.contains(id)));
                    out["live"] = json!({ "reportOpen": open });
                }
                actions.push(out);
            }
        }
        // What needs the operator by the harness's own knowledge, whoever published what
        for (id, fact) in facts.sessions.iter().filter(|(id, f)| !f.ended && below(id)) {
            if let Some(since) = fact.prompt {
                named.insert(id.as_str());
                actions.push(json!({
                    "id": format!("prompt:{id}"), "kind": "answer_prompt", "derived": "prompt", "where": { "session": id }, "since": since,
                    "title": format!("{} asks for your answer in its terminal", if fact.name.is_empty() { "A session" } else { &fact.name }),
                }));
            }
            if let Some((report, said, since)) = fact.needs_human.as_ref().filter(|(report, ..)| !cited.contains(report.as_str())) {
                named.insert(id.as_str());
                actions.push(json!({
                    "id": format!("report:{report}"), "kind": "report", "derived": "report", "where": { "session": id }, "since": since, "source": [report],
                    "title": format!("{} needs you", if fact.name.is_empty() { "A session" } else { &fact.name }), "detail": said,
                }));
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
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "  !rm -rf ~" })), "runs a command");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "go\nand more" })), "line break");
        refused(action("typed_word", json!({ "where": { "session": "ex" }, "say": "x".repeat(MAX_LINE + 1) })), "longer than");
        refused(action("typed_word", json!({ "where": { "session": "ex", "command": "make" }, "say": "go" })), "where.command");
        refused(action("typed_word", json!({ "where": { "session": "ex", "url": "https://example.com" }, "say": "go" })), "where.url");
        refused(action("typed_word", json!({ "where": { "session": "sh" }, "say": "go" })), "not an agent");
        refused(action("typed_word", json!({ "where": { "session": "gone" }, "say": "go" })), "has ended");
        refused(action("typed_word", json!({ "where": { "session": "nobody" }, "say": "go" })), "not a session the harness tracks");
        // decision: choices, each a plain line
        with_action(action("decision", json!({ "options": ["Keep", "Drop"], "recommended": "Keep" }))).unwrap();
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
    fn harness_facts_are_joined_at_read_and_never_stored() {
        let c = published();
        let mut f = facts();
        f.reports.insert("r1".into());
        f.sessions.get_mut("ex").unwrap().prompt = Some(NOW + 1);
        f.sessions.get_mut("ex").unwrap().waits = vec![FactWait { id: "w1".into(), kind: "pipeline".into(), on: "CI run".into(), reference: "run 7".into(), since: NOW + 2, overdue: true }];
        f.sessions.get_mut("ex").unwrap().done = Some("r0".into());
        f.sessions.get_mut("peer").unwrap().needs_human = Some(("r1".into(), "Which key?".into(), NOW + 3));
        let read = c.read(&f, None);
        let actions = read["actions"].as_array().unwrap();
        // A prompt is an action in the harness's own words: the prompt's text is not copied
        let prompt = actions.iter().find(|a| a["kind"] == "answer_prompt").unwrap();
        assert_eq!((&prompt["where"]["session"], &prompt["derived"], &prompt["since"]), (&json!("ex"), &json!("prompt"), &json!(NOW + 1)));
        assert_eq!(prompt["title"], "Worker asks for your answer in its terminal");
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
        f.reports.insert("r2".into());
        c.patch(&SUP, &f, &json!({ "action": { "id": "a1", "source": ["r2", "MCR-95"] } }), NOW).unwrap();
        let read = c.read(&f, None);
        assert_eq!(read["actions"].as_array().unwrap().iter().filter(|a| a["kind"] == "report").count(), 1, "only the peer's");
        assert_eq!(read["actions"][0]["live"]["reportOpen"], true);
        f.sessions.get_mut("sup").unwrap().needs_human = None;
        assert_eq!(c.read(&f, None)["actions"][0]["live"]["reportOpen"], false);
        // A derived entry that comes back in a publish is dropped, not stored as the agent's
        let read = c.read(&f, None);
        c.publish(&SUP, &f, &json!({ "tracks": read["tracks"], "actions": read["actions"] }), NOW).unwrap();
        assert_eq!(c.parts["sup"].actions.len(), 1);
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
        assert_eq!(mine["actions"].as_array().unwrap().iter().filter(|a| a["derived"] == "prompt").map(|a| a["where"]["session"].as_str().unwrap()).collect::<Vec<_>>(), ["ex"]);
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
    fn the_document_survives_the_store_and_an_older_store_has_none() {
        let c = published();
        let back: Cockpit = serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!((back.schema, back.version, &back.parts, &back.order), (c.schema, c.version, &c.parts, &c.order));
        let old: Cockpit = serde_json::from_str("{}").unwrap();
        assert!(old.parts.is_empty() && old.version == 0);
        assert_eq!(old.read(&facts(), None)["tracks"], json!([]));
    }
}
