//! What the harness service reads of a hosted session's transcript for its
//! context figures (MCR-149): numbers only, in memory only. It is not the
//! app's index (`sessions.rs`), whose parser and stored history it leaves
//! alone. Files are opened only as regular files, through descriptors that
//! never follow a symlink (`open_confined`), because a hosted agent can report
//! any path, a named pipe or a linked folder included.
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime};

/// Response times and deduplication keys kept per session: a response's
/// repeated rows (its content blocks, a repeated `token_count`) come within a
/// few rows of each other, so dropping old keys loses no deduplication in practice
pub const MAX_TURNS: usize = 10_000;
const MAX_KEYS: usize = 1_024;
/// The longest model name kept
const MAX_MODEL: usize = 100;
/// A record longer than this is not read
const MAX_LINE: u64 = 16 * 1024 * 1024;

/// List-price ratios of a token against an uncached input token, as the
/// token study of MCR-149 (`tok/analyze.py`) counted them: Claude cache
/// write 5 minutes, cache write 1 hour, cache read, output; Codex cached
/// input, output. Cache reads and writes are parts of the input and
/// reasoning is part of the output: neither is added again
const CLAUDE_EQ: (f64, f64, f64, f64) = (1.25, 2.0, 0.1, 5.0);
const CODEX_EQ: (f64, f64) = (0.1, 8.0);

/// A response id as it is kept for deduplication: the first 16 bytes of its
/// SHA-256, so what is kept per id is bounded whatever the transcript says
type Key = [u8; 16];

fn key_of(id: &str) -> Key {
    let digest = Sha256::digest(id.as_bytes());
    let mut key = [0; 16];
    key.copy_from_slice(&digest[..16]);
    key
}

/// An RFC3339 timestamp in milliseconds; 0 when it is missing or malformed.
fn millis(at: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(at).map(|d| d.timestamp_millis().max(0) as u64).unwrap_or(0)
}

/// What one transcript says in numbers. Nothing of its text is kept: no
/// prompt, title, ticket key, tool, skill or agent name, no folder; the one
/// string is the latest model name, cut short.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    claude: bool,
    /// The input side of the latest main-conversation response: the context as it stands
    pub now: u64,
    /// `now` is estimated from a compaction summary's length (4 characters a token)
    pub now_estimated: bool,
    pub peak: u64,
    /// The model's context window, when the agent records it (Codex)
    pub window: u64,
    pub compactions: u64,
    /// Seconds the prompt cache Claude last wrote lives (5 minutes or 1 hour); 0 when not recorded
    pub cache_ttl: u64,
    /// When the latest main-conversation response was recorded (ms), at its first row
    pub last_turn_at: u64,
    input_equivalent: f64,
    /// When each response was recorded (ms), subagents in the file included: the latest `MAX_TURNS`
    turns: VecDeque<u64>,
    pub turns_dropped: u64,
    pub model: String,
    /// Per response id, the largest usage seen: Claude writes a row per
    /// content block. An id is kept as a fixed-size hash (`key_of`), never as
    /// its text, so a long id costs no more than a short one
    keys: HashMap<Key, [u64; 5]>,
    order: VecDeque<Key>,
    /// The last Codex `last_token_usage` counted
    last_codex: (u64, u64, u64),
    /// A Claude compaction boundary came and its summary has not yet
    boundary_open: bool,
}

impl Stats {
    pub fn new(claude: bool) -> Self {
        Self { claude, ..Self::default() }
    }
    /// Input-token equivalents of all responses so far
    pub fn input_equivalent(&self) -> u64 {
        self.input_equivalent.round() as u64
    }
    #[cfg(test)]
    fn turn_count(&self) -> u64 {
        self.turns.len() as u64 + self.turns_dropped
    }
    fn turn(&mut self, at: u64) {
        if self.turns.len() == MAX_TURNS {
            self.turns.pop_front();
            self.turns_dropped += 1;
        }
        self.turns.push_back(at);
    }
    fn size(&mut self, input: u64) {
        if input > 0 {
            self.now = input;
            self.now_estimated = false;
            self.peak = self.peak.max(input);
        }
    }
    fn model(&mut self, model: &str) {
        if !model.is_empty() && model != "<synthetic>" {
            self.model = model.chars().take(MAX_MODEL).collect();
        }
    }
    /// One record of the transcript
    pub fn row(&mut self, r: &Value) {
        let at = millis(r["timestamp"].as_str().unwrap_or(""));
        let kind = r["type"].as_str().unwrap_or("");
        if self.claude {
            self.claude_row(r, kind, at);
        } else {
            self.codex_row(r, kind, at);
        }
    }
    fn claude_row(&mut self, r: &Value, kind: &str, at: u64) {
        let side = r["isSidechain"] == true;
        let m = &r["message"];
        if kind == "assistant" && m["usage"].is_object() && m["model"] != "<synthetic>" {
            self.model(m["model"].as_str().unwrap_or(""));
            let u = &m["usage"];
            let n = |v: &Value| v.as_u64().unwrap_or(0);
            let (written, hour) = (n(&u["cache_creation_input_tokens"]), n(&u["cache_creation"]["ephemeral_1h_input_tokens"]));
            let now = [n(&u["input_tokens"]), written, hour.min(written), n(&u["cache_read_input_tokens"]), n(&u["output_tokens"])];
            let key = key_of(m["id"].as_str().unwrap_or(""));
            let new = !self.keys.contains_key(&key);
            let seen = self.keys.entry(key).or_insert([0; 5]);
            let delta: Vec<u64> = now.iter().zip(seen.iter()).map(|(a, b)| a.saturating_sub(*b)).collect();
            for (s, a) in seen.iter_mut().zip(now) {
                *s = (*s).max(a);
            }
            let (w5m, w1h, read, out) = CLAUDE_EQ;
            let f = |x: u64| x as f64;
            self.input_equivalent += f(delta[0]) + w5m * f(delta[1].saturating_sub(delta[2])) + w1h * f(delta[2]) + read * f(delta[3]) + out * f(delta[4]);
            if new {
                self.order.push_back(key);
                if self.order.len() > MAX_KEYS {
                    if let Some(old) = self.order.pop_front() {
                        self.keys.remove(&old);
                    }
                }
                // One response, at its first row's time
                self.turn(at);
                if !side {
                    self.size(now[0] + now[1] + now[3]);
                    self.last_turn_at = self.last_turn_at.max(at);
                    let w5 = n(&u["cache_creation"]["ephemeral_5m_input_tokens"]);
                    if hour > 0 {
                        self.cache_ttl = 3600;
                    } else if w5 > 0 {
                        self.cache_ttl = 300;
                    }
                }
            }
        }
        // A compaction is its boundary; a summary counts only when no boundary announced it
        if kind == "system" && r["subtype"] == "compact_boundary" && !side {
            self.compactions += 1;
            self.boundary_open = true;
            self.now = r["compactMetadata"]["postTokens"].as_u64().unwrap_or(0);
            self.now_estimated = false;
        }
        if kind == "user" && r["isCompactSummary"] == true {
            if !self.boundary_open {
                self.compactions += 1;
            }
            self.boundary_open = false;
            if self.now == 0 {
                self.now = text_len(&m["content"]) as u64 / 4;
                self.now_estimated = true;
            }
        }
    }
    fn codex_row(&mut self, r: &Value, kind: &str, at: u64) {
        let p = &r["payload"];
        match (kind, p["type"].as_str().unwrap_or("")) {
            ("event_msg", "token_count") => {
                let info = &p["info"];
                if let Some(window) = info["model_context_window"].as_u64() {
                    self.window = window;
                }
                let last = &info["last_token_usage"];
                let n = |k: &str| last[k].as_u64().unwrap_or(0);
                let seen = (n("input_tokens"), n("cached_input_tokens"), n("output_tokens"));
                // Codex can repeat the last response's usage in a later `token_count`: one response
                if last.is_object() && seen != self.last_codex {
                    self.last_codex = seen;
                    let (input, cached, output) = seen;
                    let (read, out) = CODEX_EQ;
                    self.input_equivalent += input.saturating_sub(cached) as f64 + read * cached as f64 + out * output as f64;
                    self.turn(at);
                    self.size(input);
                    self.last_turn_at = self.last_turn_at.max(at);
                }
            }
            ("event_msg", "context_compacted") | ("compacted", _) => self.compactions += 1,
            ("turn_context", _) => self.model(p["model"].as_str().unwrap_or("")),
            _ => {}
        }
    }
}

/// The length of a message's text, read and not kept.
fn text_len(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len(),
        Value::Array(parts) => parts.iter().map(|p| p["text"].as_str().map_or(0, str::len)).sum(),
        _ => 0,
    }
}

/// A transcript read on from where the last read stopped.
pub struct Follow {
    /// The real location of the agent's transcript folder, and the file below it
    root: PathBuf,
    rel: PathBuf,
    offset: u64,
    /// The file it read, so that a replaced file is read again from its start
    identity: Option<(u64, u64)>,
    /// The file's modification time when the last read ended, and its
    /// anchors then (`anchors`): a file rewritten in place, on the same inode
    /// and at the same or a greater length, is read again from its start
    modified: Option<SystemTime>,
    anchors: (u64, u64),
    /// How often it started over at the beginning of a rewritten file
    restarts: u64,
    pub stats: Stats,
}

impl Follow {
    pub fn new(root: &Path, rel: &Path, claude: bool) -> Self {
        Self { root: root.to_path_buf(), rel: rel.to_path_buf(), offset: 0, identity: None, modified: None, anchors: (0, 0), restarts: 0, stats: Stats::new(claude) }
    }
    /// Whether what was read is no longer what the file holds: another file
    /// (inode), a shorter one, or one changed since the last read without
    /// growing (agents only append) or with other bytes at its anchors.
    /// Everything is looked at through the opened handle.
    fn rewritten(&self, file: &mut File, meta: &std::fs::Metadata) -> Result<bool, String> {
        if self.offset == 0 {
            return Ok(false);
        }
        if self.identity != file_identity(meta) || meta.len() < self.offset {
            return Ok(true);
        }
        if meta.modified().ok() == self.modified {
            return Ok(false);
        }
        Ok(meta.len() == self.offset || anchors(file, self.offset)? != self.anchors)
    }
    /// Reads what was appended for about `slice`; true once it has read up
    /// to the last whole record
    pub fn read(&mut self, slice: Duration) -> Result<bool, String> {
        let began = Instant::now();
        let mut file = open_confined(&self.root, &self.rel).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if self.rewritten(&mut file, &meta)? {
            let restarts = self.restarts + 1;
            *self = Self::new(&self.root, &self.rel, self.stats.claude);
            self.restarts = restarts;
        }
        self.identity = file_identity(&meta);
        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(self.offset)).map_err(|e| e.to_string())?;
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = Read::by_ref(&mut reader).take(MAX_LINE + 1).read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
            if n == 0 || line.last() != Some(&b'\n') {
                if n as u64 > MAX_LINE {
                    return Err("Transcript record exceeds 16 MiB".into());
                }
                // The end, or a record its writer has not finished
                self.mark(reader.get_mut())?;
                return Ok(true);
            }
            self.offset += n as u64;
            #[derive(Deserialize)]
            struct Kind {
                #[serde(rename = "type")]
                kind: String,
            }
            let wanted = !self.stats.claude || serde_json::from_slice::<Kind>(&line).is_ok_and(|k| matches!(k.kind.as_str(), "assistant" | "user" | "system"));
            if wanted {
                if let Ok(r) = serde_json::from_slice::<Value>(&line) {
                    self.stats.row(&r);
                }
            }
            if began.elapsed() >= slice {
                self.mark(reader.get_mut())?;
                return Ok(false);
            }
        }
    }
    /// Remembers the file as this read leaves it: its time and anchors
    fn mark(&mut self, file: &mut File) -> Result<(), String> {
        self.modified = file.metadata().map_err(|e| e.to_string())?.modified().ok();
        self.anchors = anchors(file, self.offset)?;
        Ok(())
    }
}

/// Hashes of a file's first 4 KiB and of the 256 bytes before `offset`
/// (FNV-1a), read through the handle.
fn anchors(file: &mut File, offset: u64) -> Result<(u64, u64), String> {
    fn hash(file: &mut File, start: u64, length: u64) -> Result<u64, String> {
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(length).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)))
    }
    Ok((hash(file, 0, offset.min(4096))?, hash(file, offset.saturating_sub(256), offset.min(256))?))
}

/// What the figures of one session show, as of a read to the end of its
/// transcript: copied out of `Stats` so a request never touches what the
/// worker reads into.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Figures {
    pub claude: bool,
    pub now: u64,
    pub now_estimated: bool,
    pub peak: u64,
    pub window: u64,
    pub compactions: u64,
    pub cache_ttl: u64,
    pub last_turn_at: u64,
    pub input_equivalent: u64,
    /// Response times, the latest `MAX_TURNS`
    pub turns: Vec<u64>,
    pub turns_dropped: u64,
}

impl Stats {
    pub fn figures(&self) -> Figures {
        Figures {
            claude: self.claude,
            now: self.now,
            now_estimated: self.now_estimated,
            peak: self.peak,
            window: self.window,
            compactions: self.compactions,
            cache_ttl: self.cache_ttl,
            last_turn_at: self.last_turn_at,
            input_equivalent: self.input_equivalent(),
            turns: self.turns.iter().copied().collect(),
            turns_dropped: self.turns_dropped,
        }
    }
}

/// Where a session's transcript is to be looked for: the agent's transcript
/// folder below the home folder (and how deep it nests), the conversation the
/// file must name, and the path the agent's hooks reported, if any.
#[derive(Clone, Debug, PartialEq)]
pub struct Want {
    pub home: PathBuf,
    pub folder: &'static str,
    pub depth: usize,
    pub conversation: String,
    pub reported: Option<String>,
    pub claude: bool,
}

/// What looking for a transcript found.
#[derive(Debug, PartialEq)]
pub enum Found {
    /// The real location of the agent's transcript folder, and the transcript below it
    At(PathBuf, PathBuf),
    Nothing,
    /// The walk's time ran out
    Unfinished,
}

/// The transcript of a hosted session. It must name the session's
/// conversation (its file name ends with the conversation id) and lie inside
/// the real location of its agent's transcript folder: the path its hooks
/// reported when its real folder is there, else the file found there by the
/// conversation id, in a walk that follows no symlink and stops at
/// `deadline`. `open_confined` looks again, through the descriptors.
pub fn locate(want: &Want, deadline: Instant) -> Found {
    let id = want.conversation.as_str();
    if !crate::agents::is_uuid(id) {
        return Found::Nothing;
    }
    let Some(root) = real_root(&want.home, want.folder) else { return Found::Nothing };
    let names = |p: &Path| p.extension().is_some_and(|e| e == "jsonl") && p.file_stem().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(id));
    if let Some(rel) = want.reported.as_deref().map(Path::new).filter(|p| names(p)).and_then(|p| below(&root, p)) {
        return Found::At(root, rel);
    }
    let mut files = Vec::new();
    if !jsonl_files_until(&root, want.depth, &mut files, deadline) {
        return Found::Unfinished;
    }
    files.into_iter().find(|p| names(p)).and_then(|p| Some(p.strip_prefix(&root).ok()?.to_path_buf())).map_or(Found::Nothing, |rel| Found::At(root, rel))
}

/// The `.jsonl` files under `dir`, `depth` folders deep, following no
/// symlink; false when `deadline` passed first.
pub fn jsonl_files_until(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, deadline: Instant) -> bool {
    if Instant::now() >= deadline {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return true };
    for entry in entries.flatten() {
        if Instant::now() >= deadline {
            return false;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() && depth > 0 {
            if !jsonl_files_until(&path, depth - 1, out, deadline) {
                return false;
            }
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
    true
}

/// How long the worker reads one transcript before it turns to the next
/// one that is asked for: a long transcript keeps no other one waiting.
const SLICE: Duration = Duration::from_millis(200);
/// How long the worker's walk for a transcript may take
const WALK: Duration = Duration::from_secs(5);
/// How long a transcript that was not found is not looked for again
const LOOK_AGAIN: Duration = Duration::from_secs(30);

/// What a request gets for a session.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    /// Read to its end after the request asked: the figures, or `None` when
    /// no transcript was found or it was refused
    Current(Option<Arc<Figures>>),
    /// Not read to its end within the request's budget: the figures of the
    /// last read that was, and when that ended (ms), if one ever was
    Behind(Option<(Arc<Figures>, u64)>),
}

struct Entry {
    want: Want,
    /// When a request last asked for it, and when the worker last began a
    /// look or read that settled it: it is current for a request that asked
    /// no later than that
    asked: Option<Instant>,
    settled: Option<Instant>,
    /// When the worker last turned to it: the least recently served goes first
    worked: Option<Instant>,
    /// The worker has taken it out; nothing else ever reads its files
    busy: bool,
    follow: Option<Box<Follow>>,
    looked: Option<Instant>,
    /// The last read to the end, and when it ended (ms); `None` also when the
    /// last settled look found nothing to show (no transcript, or a refused one)
    snap: Option<(Arc<Figures>, u64)>,
}

impl Entry {
    fn new(want: Want) -> Self {
        Self { want, asked: None, settled: None, worked: None, busy: false, follow: None, looked: None, snap: None }
    }
    fn current_for(&self, asked: Instant) -> bool {
        self.settled.is_some_and(|s| s >= asked)
    }
}

/// The transcripts the context figures follow (MCR-149), read by one
/// background thread and never on a request's thread: a request says what it
/// wants, waits at most its budget for the worker (on a condition variable,
/// never on a file) and takes the last figures read to the end, saying
/// whether they are current. The map's lock is never held across file I/O.
pub struct Contexts {
    map: Mutex<BTreeMap<String, Entry>>,
    /// The worker is told there is work, and requests that work was done
    wake: Condvar,
    done: Condvar,
    started: AtomicBool,
    /// Tests: the worker waits on this, before it reads the named session, until it is sent to or dropped
    #[cfg(test)]
    pub stall: Mutex<Option<(String, std::sync::mpsc::Receiver<()>)>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the worker took out to do.
struct Job {
    id: String,
    want: Want,
    follow: Option<Box<Follow>>,
    looked: Option<Instant>,
    began: Instant,
}

impl Contexts {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            map: Mutex::new(BTreeMap::new()),
            wake: Condvar::new(),
            done: Condvar::new(),
            started: AtomicBool::new(false),
            #[cfg(test)]
            stall: Mutex::new(None),
        })
    }

    /// The figures of these sessions, after at most `budget`. Sessions for
    /// which `keep` is false are no longer followed (ended or forgotten).
    pub fn ask(self: &Arc<Self>, wants: Vec<(String, Want)>, keep: impl Fn(&str) -> bool, budget: Duration) -> BTreeMap<String, Answer> {
        let asked = Instant::now();
        let deadline = asked + budget;
        let mut map = locked(&self.map);
        map.retain(|id, _| keep(id));
        let ids: Vec<String> = wants.iter().map(|(id, _)| id.clone()).collect();
        for (id, want) in wants {
            let entry = map.entry(id).or_insert_with(|| Entry::new(want.clone()));
            // Another conversation or reported path: followed afresh (a job under way for the old one is dropped when it comes back)
            if entry.want != want {
                *entry = Entry::new(want);
            }
            entry.asked = Some(asked);
        }
        if ids.is_empty() {
            return BTreeMap::new();
        }
        self.start();
        self.wake.notify_all();
        while !ids.iter().all(|id| map.get(id).is_none_or(|e| e.current_for(asked))) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            map = self.done.wait_timeout(map, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        ids.into_iter()
            .filter_map(|id| {
                let e = map.get(&id)?;
                let answer = if e.current_for(asked) {
                    Answer::Current(e.snap.as_ref().map(|(f, _)| f.clone()))
                } else {
                    Answer::Behind(e.snap.clone())
                };
                Some((id, answer))
            })
            .collect()
    }

    #[cfg(test)]
    pub fn follows(&self, id: &str) -> bool {
        locked(&self.map).contains_key(id)
    }

    fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = Arc::downgrade(self);
        if let Err(e) = std::thread::Builder::new().name("context-figures".into()).spawn(move || Self::work(me)) {
            eprintln!("harness: the context figures' worker did not start: {e}");
            self.started.store(false, Ordering::SeqCst);
        }
    }

    /// The worker: takes the asked-for session served least recently, looks
    /// for or reads its transcript for a slice, puts it back and says so. It
    /// ends once the harness that owns the map is gone.
    fn work(me: Weak<Self>) {
        loop {
            let Some(this) = me.upgrade() else { return };
            let job = {
                let mut map = locked(&this.map);
                let pick = map
                    .iter()
                    .filter(|(_, e)| !e.busy && e.asked.is_some_and(|a| !e.current_for(a)))
                    .min_by_key(|(_, e)| e.worked)
                    .map(|(id, _)| id.clone());
                match pick {
                    Some(id) => {
                        let e = map.get_mut(&id).expect("picked from the map");
                        e.busy = true;
                        Some(Job { id, want: e.want.clone(), follow: e.follow.take(), looked: e.looked, began: Instant::now() })
                    }
                    None => {
                        let _ = this.wake.wait_timeout(map, Duration::from_secs(1));
                        None
                    }
                }
            };
            if let Some(job) = job {
                this.run(job);
            }
        }
    }

    fn run(&self, job: Job) {
        let Job { id, want, mut follow, mut looked, began } = job;
        // Settled with these figures, `None` for nothing to show; unsettled while a read goes on
        let mut settled: Option<Option<Arc<Figures>>> = None;
        if follow.is_none() {
            if looked.is_some_and(|at| at.elapsed() < LOOK_AGAIN) {
                settled = Some(None);
            } else {
                looked = Some(Instant::now());
                match locate(&want, Instant::now() + WALK) {
                    Found::At(root, rel) => follow = Some(Box::new(Follow::new(&root, &rel, want.claude))),
                    Found::Nothing | Found::Unfinished => settled = Some(None),
                }
            }
        }
        if let Some(f) = follow.as_mut() {
            #[cfg(test)]
            {
                let stall = locked(&self.stall).take_if(|(at, _)| *at == id);
                if let Some((_, rx)) = stall {
                    let _ = rx.recv();
                }
            }
            match f.read(SLICE) {
                Ok(true) => settled = Some(Some(Arc::new(f.stats.figures()))),
                Ok(false) => {}
                // Gone, replaced or refused: dropped, and looked for again after a while
                Err(e) => {
                    eprintln!("harness: context of {id}: {e}");
                    follow = None;
                    looked = Some(Instant::now());
                    settled = Some(None);
                }
            }
        }
        let mut map = locked(&self.map);
        if let Some(e) = map.get_mut(&id).filter(|e| e.busy && e.want == want) {
            e.busy = false;
            e.follow = follow;
            e.looked = looked;
            e.worked = Some(Instant::now());
            if let Some(figures) = settled {
                e.settled = Some(began);
                e.snap = figures.map(|f| (f, now_ms()));
            }
        }
        drop(map);
        self.done.notify_all();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(unix)]
fn file_identity(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn file_identity(_meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// The real location of an agent's transcript folder under the home folder,
/// when no part of it below the home folder is a symlink: a folder linked
/// elsewhere is not the agent's folder for the harness.
pub fn real_root(home: &Path, folder: &str) -> Option<PathBuf> {
    let root = dunce::canonicalize(home).ok()?.join(folder);
    (dunce::canonicalize(&root).ok()? == root).then_some(root)
}

/// `path` as a path below `root`, by the real location of its folder: what
/// `open_confined` opens, or `None` when its folder is not inside the root.
pub fn below(root: &Path, path: &Path) -> Option<PathBuf> {
    if path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let folder = dunce::canonicalize(path.parent()?).ok()?;
    Some(folder.strip_prefix(root).ok()?.join(path.file_name()?))
}

/// Opens the regular file `rel` below `root` for reading, through the
/// descriptors themselves: on unix every folder from `/` down, the root
/// included, is opened with `O_DIRECTORY | O_NOFOLLOW` from the one before
/// it, and the file with `O_NOFOLLOW | O_NONBLOCK`, then checked with `fstat`
/// to be a regular file. A symlink anywhere on the way, also one swapped in
/// after the path was looked at, fails the open; a named pipe never makes it
/// wait. Elsewhere the opened handle's final path must lie inside the root.
pub fn open_confined(root: &Path, rel: &Path) -> std::io::Result<File> {
    let refused = |why: &str| std::io::Error::new(std::io::ErrorKind::PermissionDenied, why.to_string());
    if !root.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) || rel.file_name().is_none() {
        return Err(refused("Transcript is outside its agent's folder"));
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::os::unix::ffi::OsStrExt;
        let name = |s: &std::ffi::OsStr| CString::new(s.as_bytes()).map_err(|_| refused("A path with a NUL"));
        let open_at = |dir: Option<&OwnedFd>, part: &CString, flags: i32| -> std::io::Result<OwnedFd> {
            // SAFETY: plain open/openat calls; the descriptor is owned at once
            let fd = unsafe {
                match dir {
                    None => libc::open(part.as_ptr(), flags),
                    Some(dir) => libc::openat(dir.as_raw_fd(), part.as_ptr(), flags),
                }
            };
            if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
        };
        let folder = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut dir = open_at(None, &name(std::ffi::OsStr::new("/"))?, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)?;
        let leaf = rel.file_name().ok_or_else(|| refused("No file name"))?;
        let folders = root.components().chain(rel.parent().into_iter().flat_map(Path::components));
        for part in folders {
            match part {
                Component::RootDir => {}
                Component::Normal(part) => dir = open_at(Some(&dir), &name(part)?, folder)?,
                _ => return Err(refused("Transcript is outside its agent's folder")),
            }
        }
        let fd = open_at(Some(&dir), &name(leaf)?, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)?;
        let file = File::from(fd);
        if !file.metadata()?.is_file() {
            return Err(refused("Transcript is not a regular file"));
        }
        Ok(file)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
        let file = File::open(root.join(rel))?;
        if !file.metadata()?.is_file() {
            return Err(refused("Transcript is not a regular file"));
        }
        // Where the handle really is, links and junctions resolved
        let mut buf = vec![0u16; 32_768];
        // SAFETY: the handle is open for the call and the buffer is as long as said
        let len = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as _, buf.as_mut_ptr(), buf.len() as u32, FILE_NAME_NORMALIZED) } as usize;
        if len == 0 || len >= buf.len() {
            return Err(std::io::Error::last_os_error());
        }
        let real = PathBuf::from(String::from_utf16_lossy(&buf[..len]));
        let real = dunce::simplified(&real).to_path_buf();
        if !real.starts_with(root) {
            return Err(refused("Transcript is outside its agent's folder"));
        }
        Ok(file)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(refused("Not supported on this platform"))
    }
}

/// Opens a file of an agent's folder only when it is a regular file: no
/// symlink, named pipe or device, whose opening or reading could wait for good.
pub fn open_regular(path: &Path) -> Result<File, String> {
    let kind = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?.file_type();
    if !kind.is_file() {
        return Err("Not a regular file".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Not a regular file".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("mcr-stats-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("-w")).unwrap();
        (dunce::canonicalize(root).unwrap(), PathBuf::from("-w/0b8c9630-d8ae-4b6f-a765-44266a0929e0.jsonl"))
    }
    fn append(path: &Path, rows: &[Value]) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for r in rows {
            writeln!(f, "{r}").unwrap();
        }
    }
    fn read_all(f: &mut Follow) {
        assert!(f.read(Duration::from_secs(10)).unwrap());
    }
    fn reply(id: &str, at: &str, input: u64, read: u64, hour: u64, output: u64) -> Value {
        json!({"type":"assistant","timestamp":at,"message":{"id":id,"model":"claude-opus-5-5","usage":{"input_tokens":input,"cache_read_input_tokens":read,"cache_creation_input_tokens":hour,"cache_creation":{"ephemeral_1h_input_tokens":hour},"output_tokens":output}}})
    }

    /// The figures keep no text: a prompt, a ticket key, a tool name or a
    /// tool's input are read past, and the usage is still counted once per response.
    #[test]
    fn stats_keep_numbers_only_and_count_a_response_once() {
        let (root, rel) = fixture("text");
        append(&root.join(&rel), &[
            json!({"type":"user","timestamp":"2026-01-01T10:00:00Z","cwd":"/secret/place","message":{"role":"user","content":"Please fix MCR-123 today"}}),
            reply("m1", "2026-01-01T10:00:01Z", 10, 0, 1_000, 2),
            // Its second content block repeats the usage, later
            reply("m1", "2026-01-01T10:30:00Z", 10, 0, 1_000, 2),
            json!({"type":"assistant","timestamp":"2026-01-01T10:00:02Z","isSidechain":true,"message":{"id":"s1","model":"claude-haiku","usage":{"input_tokens":5,"output_tokens":1},"content":[{"type":"tool_use","name":"mcp__teob-memory__memory_search","input":{"q":"plans"}}]}}),
        ]);
        let mut f = Follow::new(&root, &rel, true);
        read_all(&mut f);
        let s = &f.stats;
        // 10 + 2×1000 + 5×2, then the subagent's 5 + 5×1
        assert_eq!((s.input_equivalent(), s.turn_count(), s.now, s.cache_ttl), (2_030, 2, 1_010, 3600));
        assert_eq!(s.last_turn_at, millis("2026-01-01T10:00:01Z"), "a repeated row moves no time");
        // The one string kept is the model name; nothing else of the record is a field
        let kept = format!("{s:?}");
        assert!(!kept.contains("MCR-123") && !kept.contains("secret") && !kept.contains("memory_search") && !kept.contains("plans"), "{kept}");
    }

    /// Codex: a repeated `token_count` is one response at its first time; a
    /// compaction boundary alone counts for Claude, and an estimated size says so.
    #[test]
    fn codex_repeats_and_claude_compactions() {
        let (root, rel) = fixture("codex");
        let count = |at: &str, last: [u64; 3]| json!({"timestamp":at,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258_400,
            "last_token_usage":{"input_tokens":last[0],"cached_input_tokens":last[1],"output_tokens":last[2]}}}});
        append(&root.join(&rel), &[count("2026-01-01T10:00:00Z", [100, 80, 10]), count("2026-01-01T10:46:00Z", [100, 80, 10]), count("2026-01-01T10:47:00Z", [200, 150, 20])]);
        let mut f = Follow::new(&root, &rel, false);
        read_all(&mut f);
        // (20 + 8 + 80) + (50 + 15 + 160)
        assert_eq!((f.stats.turn_count(), f.stats.input_equivalent(), f.stats.now, f.stats.window), (2, 333, 200, 258_400));
        assert_eq!(f.stats.last_turn_at, millis("2026-01-01T10:47:00Z"));

        let (root, rel) = fixture("compact");
        append(&root.join(&rel), &[
            reply("m1", "2026-01-01T10:00:00Z", 10, 0, 0, 1),
            json!({"type":"system","subtype":"compact_boundary","timestamp":"2026-01-01T10:01:00Z","compactMetadata":{"postTokens":4}}),
            json!({"type":"user","isCompactSummary":true,"message":{"content":"summary"}}),
            json!({"type":"system","subtype":"compact_boundary","compactMetadata":{}}),
            json!({"type":"user","isCompactSummary":true,"message":{"content":"x".repeat(400)}}),
        ]);
        let mut f = Follow::new(&root, &rel, true);
        read_all(&mut f);
        assert_eq!((f.stats.compactions, f.stats.now, f.stats.now_estimated), (2, 100, true));
    }

    /// What is kept per session is bounded, and reading on after an append,
    /// or from the start of a replaced file, counts right.
    #[test]
    fn bounded_and_read_on() {
        let (root, rel) = fixture("bounds");
        let path = root.join(&rel);
        {
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
            for n in 0..MAX_TURNS + 5 {
                let row = json!({"type":"assistant","timestamp":"2026-01-01T10:00:01Z","message":{"id":format!("m{n}"),"model":"m".repeat(500),"usage":{"input_tokens":1,"output_tokens":0}}});
                writeln!(file, "{row}\n{row}").unwrap();
            }
        }
        let mut f = Follow::new(&root, &rel, true);
        read_all(&mut f);
        assert_eq!((f.stats.turns.len(), f.stats.turns_dropped, f.stats.input_equivalent()), (MAX_TURNS, 5, (MAX_TURNS + 5) as u64));
        assert!(f.stats.keys.len() <= MAX_KEYS && f.stats.order.len() <= MAX_KEYS && f.stats.model.len() == MAX_MODEL);
        append(&path, &[reply("new", "2026-01-01T11:00:00Z", 7, 0, 0, 0)]);
        read_all(&mut f);
        assert_eq!(f.stats.turn_count(), MAX_TURNS as u64 + 6);
        std::fs::remove_file(&path).unwrap();
        append(&path, &[reply("again", "2026-01-01T12:00:00Z", 3, 0, 0, 0)]);
        read_all(&mut f);
        assert_eq!((f.stats.turn_count(), f.stats.now), (1, 3));
    }

    /// Only a regular file below the root is opened, through descriptors: a
    /// named pipe does not wait, a link is refused, and a folder swapped for a
    /// link between the look at the path and its opening fails the open.
    #[cfg(unix)]
    #[test]
    fn opens_only_through_the_root_and_never_through_a_link() {
        let (root, rel) = fixture("confined");
        let path = root.join(&rel);
        append(&path, &[reply("m1", "2026-01-01T10:00:00Z", 1, 0, 0, 0)]);
        assert!(open_confined(&root, &rel).is_ok());
        assert_eq!(below(&root, &path), Some(rel.clone()));
        assert_eq!(below(&root, &root.join("-w/../../x.jsonl")), None);
        assert!(open_confined(&root, Path::new("../x.jsonl")).is_err());

        // A folder outside, with a file of the same name
        let outside = std::env::temp_dir().join(format!("mcr-stats-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        let outside = dunce::canonicalize(outside).unwrap();
        append(&outside.join(rel.file_name().unwrap()), &[reply("x", "2026-01-01T10:00:00Z", 1, 0, 0, 0)]);
        // A link in the root to it: never opened, and `below` finds it outside
        std::os::unix::fs::symlink(&outside, root.join("-link")).unwrap();
        let linked = Path::new("-link").join(rel.file_name().unwrap());
        assert!(open_confined(&root, &linked).is_err());
        assert_eq!(below(&root, &root.join(&linked)), None);
        // The folder passes the look, then is replaced by a link before the open
        let checked = below(&root, &path).unwrap();
        std::fs::rename(root.join("-w"), root.join("-w-old")).unwrap();
        std::os::unix::fs::symlink(root.join("-link"), root.join("-w")).unwrap();
        assert!(open_confined(&root, &checked).is_err(), "a folder swapped for a link was followed");
        let mut follow = Follow::new(&root, &checked, true);
        assert!(follow.read(Duration::from_secs(5)).is_err());
        // The file itself swapped for a link to a file outside
        std::fs::remove_file(root.join("-w")).unwrap();
        std::fs::create_dir(root.join("-w")).unwrap();
        std::os::unix::fs::symlink(outside.join(rel.file_name().unwrap()), &path).unwrap();
        assert!(open_confined(&root, &checked).is_err(), "a file swapped for a link was followed");
        // The root itself replaced by a link: refused too
        assert!(open_confined(&root.join("-link"), Path::new("x.jsonl")).is_err());

        // A named pipe does not make the open wait
        let pipe = root.join("-w-old/pipe.jsonl");
        let c = std::ffi::CString::new(pipe.display().to_string()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let rel_pipe = Path::new("-w-old/pipe.jsonl");
        let (tx, rx) = std::sync::mpsc::channel();
        let r = root.clone();
        std::thread::spawn(move || {
            let _ = tx.send(open_confined(&r, rel_pipe).is_err() && open_regular(&r.join(rel_pipe)).is_err());
        });
        assert!(rx.recv_timeout(Duration::from_secs(5)).expect("the open waited on a pipe"));
    }

    fn want_in(name: &str) -> (Want, PathBuf) {
        let home = std::env::temp_dir().join(format!("mcr-stats-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let id = "0b8c9630-d8ae-4b6f-a765-44266a0929e0";
        let path = home.join(format!(".claude/projects/-w/{id}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let want = Want { home: dunce::canonicalize(&home).unwrap(), folder: ".claude/projects", depth: 1, conversation: id.into(), reported: None, claude: true };
        (want, path)
    }

    /// MCR-149 round 3: transcripts are read by the worker, never on the
    /// request's thread. A read that stalls does not hold the answer past its
    /// budget: the request gets the last figures read to the end, marked as
    /// behind, and once the read goes on the next request is current again.
    #[test]
    fn a_stalled_read_does_not_delay_the_answer() {
        let (want, path) = want_in("stall");
        append(&path, &[reply("m1", "2026-01-01T10:00:00Z", 10, 0, 0, 1)]);
        let contexts = Contexts::new();
        let ask = |budget: Duration| {
            let began = Instant::now();
            let answer = contexts.ask(vec![("ex".into(), want.clone())], |_| true, budget).remove("ex").unwrap();
            (answer, began.elapsed())
        };
        let (first, _) = ask(Duration::from_secs(10));
        let Answer::Current(Some(first)) = first else { panic!("{first:?}") };
        assert_eq!(first.turns.len(), 1);

        append(&path, &[reply("m2", "2026-01-01T10:05:00Z", 20, 0, 0, 1)]);
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *locked(&contexts.stall) = Some(("ex".into(), rx));
        let (behind, took) = ask(Duration::from_millis(300));
        assert!(took < Duration::from_millis(1_500), "the request waited {took:?} on a stalled read");
        let Answer::Behind(Some((figures, at))) = behind else { panic!("{behind:?}") };
        assert_eq!((figures.turns.len(), figures.now), (1, 10), "the last figures read to the end, not a partial read");
        assert!(at > 0);
        // A second request while the worker still waits is not held up either
        let (again, took) = ask(Duration::from_millis(100));
        assert!(matches!(again, Answer::Behind(Some(_))) && took < Duration::from_millis(1_000));

        drop(tx);
        let (current, _) = ask(Duration::from_secs(10));
        let Answer::Current(Some(figures)) = current else { panic!("{current:?}") };
        assert_eq!((figures.turns.len(), figures.now), (2, 20));
    }

    /// A first read that stalls has nothing to show yet (never partial
    /// figures); a transcript that is not there settles as nothing at once.
    #[test]
    fn a_first_read_that_stalls_shows_nothing_and_a_missing_one_is_none() {
        let (want, path) = want_in("first");
        append(&path, &[reply("m1", "2026-01-01T10:00:00Z", 10, 0, 0, 1)]);
        let contexts = Contexts::new();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *locked(&contexts.stall) = Some(("ex".into(), rx));
        let began = Instant::now();
        let answer = contexts.ask(vec![("ex".into(), want.clone())], |_| true, Duration::from_millis(200)).remove("ex");
        assert!(began.elapsed() < Duration::from_millis(1_500));
        assert_eq!(answer, Some(Answer::Behind(None)));
        drop(tx);

        let missing = Want { conversation: "1b8c9630-d8ae-4b6f-a765-44266a0929e0".into(), ..want.clone() };
        let answer = contexts.ask(vec![("gone".into(), missing)], |_| true, Duration::from_secs(10)).remove("gone");
        assert_eq!(answer, Some(Answer::Current(None)));
        // Sessions no longer kept are no longer followed
        contexts.ask(Vec::new(), |id| id == "ex", Duration::ZERO);
        assert!(contexts.follows("ex") && !contexts.follows("gone"));
    }

    /// Rewrites a file in place: same inode, same length, other bytes.
    fn rewrite_in_place(path: &Path, from: &str, to: &str) {
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(from.len(), to.len());
        let inode = std::fs::metadata(path).map(|m| file_identity(&m)).unwrap();
        // The modification time must be able to move
        std::thread::sleep(Duration::from_millis(20));
        let mut f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.write_all(text.replacen(from, to, 1).as_bytes()).unwrap();
        drop(f);
        let meta = std::fs::metadata(path).unwrap();
        assert_eq!((file_identity(&meta), meta.len()), (inode, text.len() as u64));
    }

    /// MCR-149 round 4: a transcript rewritten in place between two reads,
    /// on the same inode and at the same length, is read again from its
    /// start; an append is read on without starting over.
    #[test]
    fn a_rewrite_in_place_is_read_again_and_an_append_is_not() {
        let (root, rel) = fixture("rewrite");
        let path = root.join(&rel);
        // A record past the anchors' first 4 KiB, so only the time can tell
        let filler: Vec<Value> = (0..40).map(|n| json!({"type":"user","timestamp":"2026-01-01T09:00:00Z","message":{"content":"x".repeat(100 + n)}})).collect();
        append(&path, &filler);
        append(&path, &[reply("m1", "2026-01-01T10:00:00Z", 100, 0, 0, 1)]);
        append(&path, &[json!({"type":"user","timestamp":"2026-01-01T10:00:01Z","message":{"content":"y".repeat(400)}})]);
        let mut f = Follow::new(&root, &rel, true);
        read_all(&mut f);
        assert_eq!((f.stats.now, f.restarts), (100, 0));
        rewrite_in_place(&path, "\"input_tokens\":100", "\"input_tokens\":900");
        read_all(&mut f);
        assert_eq!((f.stats.now, f.stats.turn_count(), f.restarts), (900, 1, 1), "a same-length rewrite was not seen");
        // Rewritten where the anchor before the end lies, and appended to: read again too
        append(&path, &[reply("m2", "2026-01-01T10:01:00Z", 950, 0, 0, 1)]);
        read_all(&mut f);
        assert_eq!((f.stats.now, f.stats.turn_count(), f.restarts), (950, 2, 1), "an append is read on");
        rewrite_in_place(&path, "\"input_tokens\":950", "\"input_tokens\":970");
        append(&path, &[json!({"type":"user","timestamp":"2026-01-01T10:02:00Z","message":{"content":"z"}})]);
        read_all(&mut f);
        assert_eq!((f.stats.now, f.stats.turn_count(), f.restarts), (970, 2, 2));

        // Through the worker: a request after the rewrite is current with the new figures
        let (want, path) = want_in("rewrite");
        append(&path, &[reply("m1", "2026-01-01T10:00:00Z", 100, 0, 0, 1)]);
        let contexts = Contexts::new();
        let ask = || contexts.ask(vec![("ex".into(), want.clone())], |_| true, Duration::from_secs(10)).remove("ex").unwrap();
        assert!(matches!(ask(), Answer::Current(Some(f)) if f.now == 100));
        rewrite_in_place(&path, "\"input_tokens\":100", "\"input_tokens\":900");
        assert!(matches!(ask(), Answer::Current(Some(f)) if f.now == 900));
    }

    /// MCR-149 round 4: a response id is kept as a 16-byte hash, so a
    /// megabyte-long id costs what a short one does and still deduplicates.
    #[test]
    fn dedup_keys_are_fixed_size_hashes() {
        let mut s = Stats::new(true);
        let long = "i".repeat(1 << 20);
        let row = |id: &str, input: u64| json!({"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"id":id,"model":"m","usage":{"input_tokens":input,"output_tokens":0}}});
        s.row(&row(&long, 10));
        s.row(&row(&long, 10));
        s.row(&row(&format!("{long}x"), 5));
        assert_eq!((s.turn_count(), s.input_equivalent(), s.keys.len(), s.order.len()), (2, 15, 2, 2));
        assert!(format!("{s:?}").len() < 4096, "the id's text is kept");
        assert_eq!(std::mem::size_of::<Key>(), 16);
    }
}
