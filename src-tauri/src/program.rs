//! What a program says of itself in its own output (MCR-115): OSC 7501
//! program status (spec rev 0.4,
//! https://www.superlogical.com/rex/docs/build/program-status), OSC 133
//! prompt marks and OSC 9;4 progress. The runner's `Scanner` frames the
//! sequences and hands their bodies here; this module is pure.
//!
//! Everything here is untrusted: any output can print these sequences, an
//! agent that shows a file among it. A report is a hint for the operator and
//! nothing else. It never answers a prompt, never counts as the owner's word
//! and never changes a session's state, which comes from the agents' hooks.
//! It lives in the runner's memory only, never in a store, message or log.

use serde::{Deserialize, Serialize};

/// The fixed answer to a feature query. It holds nothing from any report, and
/// its body differs from the query's, so an echo of it is no new query.
pub const QUERY_REPLY: &str = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

/// The whole sequence, OSC through ST.
pub const MAX_SEQUENCE: usize = 4096;
const MAX_KEY: usize = 16;
const MAX_ID: usize = 128;
const MAX_LEVELS: usize = 8;
const MAX_SEGMENT: usize = 32;
const TITLE_ENCODED: usize = 256;
const TITLE_DECODED: usize = 192;
const MSG_ENCODED: usize = 2732;
const MSG_DECODED: usize = 2048;
/// Records per terminal; the spec asks for at least 64.
pub const MAX_RECORDS: usize = 64;

/// One record: exactly the keys of the last report with its id.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Empty for the root record
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// 0 to 100; absent means indeterminate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub app: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub msg: String,
    #[serde(default)]
    pub at: u64,
}

/// The last OSC 133 mark: A prompt starts, B input starts, C a command runs,
/// D it finished (with its exit code when the shell gave one).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub mark: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub at: u64,
}

/// The last OSC 9;4 progress (ConEmu, Windows Terminal): `normal`, `error`,
/// `indeterminate` or `paused`, with a percent where one was given.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u8>,
    pub at: u64,
}

/// What the runner keeps per session.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// Least recently updated first
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<Record>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Prompt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
}

/// An OSC body this module understands.
#[derive(Clone, Debug, PartialEq)]
pub enum Said {
    Report(Record),
    Query,
    Prompt(String, Option<i32>),
    Progress(Option<Progress>),
}

impl Program {
    pub fn is_empty(&self) -> bool {
        self.records.is_empty() && self.prompt.is_none() && self.progress.is_none()
    }

    /// Takes in what a sequence said, at `now`. A query changes nothing.
    pub fn take(&mut self, said: Said, now: u64) {
        match said {
            Said::Report(mut record) => {
                record.at = now;
                if record.state == "clear" {
                    let id = record.id;
                    if id.is_empty() {
                        self.records.clear();
                    } else {
                        let below = format!("{id}/");
                        self.records.retain(|r| r.id != id && !r.id.starts_with(&below));
                    }
                    return;
                }
                self.records.retain(|r| r.id != record.id);
                if self.records.len() >= MAX_RECORDS {
                    self.records.remove(0);
                }
                self.records.push(record);
            }
            Said::Query => {}
            Said::Prompt(mark, exit) => {
                // A new prompt ends whatever was working or blocked
                if mark == "A" {
                    self.drop_running();
                }
                self.prompt = Some(Prompt { mark, exit, at: now });
            }
            Said::Progress(progress) => self.progress = progress.map(|p| Progress { at: now, ..p }),
        }
    }

    /// The process exited: working and blocked records go, done and error stay.
    pub fn exited(&mut self) {
        self.drop_running();
        self.progress = None;
    }

    /// A full reset of the terminal (RIS) removes every record.
    pub fn reset(&mut self) {
        *self = Program::default();
    }

    fn drop_running(&mut self) {
        self.records.retain(|r| r.state != "working" && r.state != "blocked");
    }
}

/// The body of an OSC (`code;rest`) and the length of the whole sequence,
/// introducer and terminator included. `None` for what this module does not
/// read, or a report that must be ignored.
pub fn read(body: &[u8], sequence: usize) -> Option<Said> {
    let (code, rest) = match body.iter().position(|&b| b == b';') {
        Some(i) => (&body[..i], &body[i + 1..]),
        None => (body, &[][..]),
    };
    match code {
        b"7501" if sequence <= MAX_SEQUENCE => {
            if rest == b"?" {
                Some(Said::Query)
            } else {
                parse(rest).ok().map(Said::Report)
            }
        }
        b"133" => prompt(rest),
        b"9" => rest.strip_prefix(b"4;").or((rest == b"4").then_some(&b""[..])).and_then(progress),
        _ => None,
    }
}

/// Decodes a report body (what follows `7501;`). An error means the whole
/// report is ignored: nothing of it is applied.
pub fn parse(body: &[u8]) -> Result<Record, String> {
    let mut record = Record::default();
    let (mut kind, mut app, mut progress) = (None, None, None);
    for pair in body.split(|&b| b == b':') {
        let Some(eq) = pair.iter().position(|&b| b == b'=') else { continue };
        let (key, value) = (pair[..eq].trim_ascii(), pair[eq + 1..].trim_ascii());
        if key.len() > MAX_KEY {
            return Err(format!("key is {} bytes, max {MAX_KEY}", key.len()));
        }
        if key.is_empty() || !key.iter().all(u8::is_ascii_lowercase) || !value.iter().all(|&b| b.is_ascii_alphanumeric() || b"_.,+/=-".contains(&b)) {
            continue;
        }
        // Values are all ASCII here
        let text = String::from_utf8_lossy(value).into_owned();
        match key {
            b"state" => record.state = text,
            b"id" => {
                if !valid_id(&text) {
                    return Err("invalid id".into());
                }
                record.id = text;
            }
            b"kind" => kind = Some(text),
            b"progress" => progress = Some(text),
            b"app" => {
                if text.len() > MAX_SEGMENT {
                    return Err(format!("app is {} bytes, max {MAX_SEGMENT}", text.len()));
                }
                app = Some(text);
            }
            b"title" => record.title = decode_text("title", value, TITLE_ENCODED, TITLE_DECODED)?,
            b"msg" => record.msg = decode_text("msg", value, MSG_ENCODED, MSG_DECODED)?,
            // Unknown keys are how the protocol grows
            _ => {}
        }
    }
    match record.state.as_str() {
        "" => return Err("no state".into()),
        "idle" | "working" | "done" | "blocked" | "error" | "clear" => {}
        _ => return Err("unknown state".into()),
    }
    if record.state == "blocked" {
        record.kind = kind.filter(|k| matches!(k.as_str(), "permission" | "question" | "auth")).unwrap_or_default();
    }
    if record.state == "working" || record.state == "blocked" {
        record.progress = progress.and_then(|p| (p.len() <= 3).then(|| p.parse::<u8>().ok()).flatten()).filter(|p| *p <= 100);
    }
    record.app = app.filter(|a| valid_segment(a)).unwrap_or_default();
    Ok(record)
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_SEGMENT && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && id.split('/').count() <= MAX_LEVELS && id.split('/').all(valid_segment)
}

/// Standard base64 of UTF-8 text, padding optional, no control characters.
/// Direction overrides and isolates are taken out (they could make the text
/// read otherwise outside the terminal), line separators become spaces.
fn decode_text(key: &str, value: &[u8], encoded: usize, decoded: usize) -> Result<String, String> {
    if value.len() > encoded {
        return Err(format!("{key} is {} bytes encoded, max {encoded}", value.len()));
    }
    let raw = base64(value).ok_or_else(|| format!("{key} is not valid base64"))?;
    if raw.len() > decoded {
        return Err(format!("{key} is {} bytes decoded, max {decoded}", raw.len()));
    }
    let text = String::from_utf8(raw).map_err(|_| format!("{key} is not valid UTF-8"))?;
    if text.chars().any(|c| c < '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c)) {
        return Err(format!("{key} contains a control character"));
    }
    Ok(text
        .chars()
        .filter(|c| !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}' | '\u{061c}'))
        .map(|c| if matches!(c, '\u{2028}' | '\u{2029}') { ' ' } else { c })
        .collect())
}

fn base64(input: &[u8]) -> Option<Vec<u8>> {
    let body = match input.iter().position(|&b| b == b'=') {
        Some(i) => {
            let pad = &input[i..];
            // Padding only at the end, and only as much as completes the last group
            if !pad.iter().all(|&b| b == b'=') || pad.len() > 2 || !(i + pad.len()).is_multiple_of(4) {
                return None;
            }
            &input[..i]
        }
        None => input,
    };
    if body.len() % 4 == 1 {
        return None;
    }
    let value = |b: u8| match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for group in body.chunks(4) {
        let mut n = 0u32;
        for (i, &b) in group.iter().enumerate() {
            n |= u32::from(value(b)?) << (18 - 6 * i);
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..group.len() - 1]);
    }
    Some(out)
}

/// `133;A`, `133;B`, `133;C`, `133;D[;exit]`, each with optional `;key=value` parameters.
fn prompt(rest: &[u8]) -> Option<Said> {
    let mut parts = rest.split(|&b| b == b';');
    let mark = match parts.next()? {
        m @ (b"A" | b"B" | b"C" | b"D") => String::from_utf8_lossy(m).into_owned(),
        _ => return None,
    };
    let exit = if mark == "D" { parts.next().and_then(|e| std::str::from_utf8(e).ok()?.parse::<i32>().ok()) } else { None };
    Some(Said::Prompt(mark, exit))
}

/// `9;4;state;value`: 0 removes, 1 normal, 2 error, 3 indeterminate, 4 paused.
fn progress(rest: &[u8]) -> Option<Said> {
    let mut parts = rest.split(|&b| b == b';');
    let state = parts.next().filter(|s| !s.is_empty()).map_or(Some(0), |s| std::str::from_utf8(s).ok()?.parse::<u8>().ok())?;
    let value = parts.next().and_then(|v| std::str::from_utf8(v).ok()?.parse::<u8>().ok()).filter(|v| *v <= 100);
    let state = match state {
        0 => return Some(Said::Progress(None)),
        1 => "normal",
        2 => "error",
        3 => "indeterminate",
        4 => "paused",
        _ => return None,
    };
    let value = if state == "indeterminate" { None } else { value };
    Some(Said::Progress(Some(Progress { state: state.into(), value, at: 0 })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in s.as_bytes().chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
            for i in 0..=chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
            out.push_str(&"=".repeat(3 - chunk.len()));
        }
        out
    }

    fn report(body: &str) -> Result<Record, String> {
        parse(body.as_bytes())
    }

    #[test]
    fn a_report_is_read_as_the_spec_says() {
        let r = report(&format!("state=blocked:kind=permission:app=terraform:progress=40:msg={}", b64("Apply 3 to add?"))).unwrap();
        assert_eq!((r.state.as_str(), r.kind.as_str(), r.app.as_str(), r.progress, r.msg.as_str()), ("blocked", "permission", "terraform", Some(40), "Apply 3 to add?"));
        // Padding is optional, whitespace around keys and values goes, the last duplicate wins
        let title = b64("build");
        let r = report(&format!(" state = idle :title={}:state=working:progress=7", title.trim_end_matches('='))).unwrap();
        assert_eq!((r.state.as_str(), r.title.as_str(), r.progress), ("working", "build", Some(7)));
        // Kind only with blocked, progress only with working or blocked
        let r = report("state=done:kind=permission:progress=50").unwrap();
        assert_eq!((r.kind.as_str(), r.progress), ("", None));
        // Values the spec treats as absent
        let r = report("state=blocked:kind=wish:progress=101:app=a/b").unwrap();
        assert_eq!((r.kind.as_str(), r.progress, r.app.as_str()), ("", None, ""));
        assert_eq!(report("state=working:progress=-1").unwrap().progress, None);
        assert_eq!(report("state=working:progress=0050").unwrap().progress, None);
    }

    #[test]
    fn bad_keys_and_pairs_are_skipped_and_the_rest_is_read() {
        // No '=', an empty key, capitals in the key, a byte outside the value set, an unknown key
        let r = report("novalue:=x:State=error:msg=a;b:future=1:state=working:app=cargo").unwrap();
        assert_eq!((r.state.as_str(), r.app.as_str(), r.msg.as_str()), ("working", "cargo", ""));
        assert_eq!(report("app=cargo").unwrap_err(), "no state");
        assert_eq!(report("state=sleeping").unwrap_err(), "unknown state");
        // A key over the limit discards the whole report, also when another pair is good
        assert!(report("state=working:abcdefghijklmnopq=1").unwrap_err().contains("key"));
    }

    #[test]
    fn a_report_that_breaks_a_limit_is_discarded_whole() {
        assert!(report(&format!("state=working:app={}", "a".repeat(33))).is_err());
        assert!(report(&format!("state=working:id={}", "a".repeat(33))).is_err());
        assert!(report(&format!("state=working:id={}", ["a"; 9].join("/"))).is_err());
        assert!(report("state=working:id=a//b").is_err());
        assert!(report(&format!("state=working:id={}", ["abcdefghijklmnopqrstuvwxyz012345"; 4].join("/"))).is_err());
        assert!(report(&format!("state=working:title={}", b64(&"t".repeat(193)))).is_err());
        assert!(report(&format!("state=working:title={}", b64(&"t".repeat(192)))).is_ok());
        assert!(report(&format!("state=working:msg={}", b64(&"m".repeat(2049)))).is_err());
        assert!(report(&format!("state=working:msg={}", "A".repeat(2733))).is_err());
        // Bad base64, bad UTF-8, a control character, a newline: the whole report goes
        assert!(report("state=working:msg=ab.c").is_err());
        assert!(report("state=working:msg=a-b_").is_err());
        // A byte outside the value set is a malformed pair: skipped, the report stands
        assert_eq!(report("state=working:msg=@@@@").unwrap().msg, "");
        assert!(report("state=working:msg=Q").is_err());
        assert!(report("state=working:msg=QQ=A").is_err());
        assert!(report(&format!("state=working:msg={}", b64("\u{ff}").replace("w7", "/w"))).is_err());
        assert!(report(&format!("state=working:msg={}", b64("two\nlines"))).is_err());
        assert!(report(&format!("state=working:title={}", b64("tab\there"))).is_err());
        assert!(report(&format!("state=working:title={}", b64("c1\u{85}"))).is_err());
        // A bad id is not taken for the root record
        assert!(report("state=done:id=").is_err());
    }

    #[test]
    fn shown_text_cannot_turn_itself_around() {
        let r = report(&format!("state=done:msg={}", b64("ok \u{202e}txt.exe\u{2069}\u{2028}next"))).unwrap();
        assert_eq!(r.msg, "ok txt.exe next");
        // What joined emoji need stays
        assert_eq!(report(&format!("state=done:title={}", b64("👩\u{200d}💻"))).unwrap().title, "👩\u{200d}💻");
    }

    #[test]
    fn records_follow_the_spec() {
        let mut p = Program::default();
        let take = |p: &mut Program, body: &str, at| p.take(Said::Report(report(body).unwrap()), at);
        take(&mut p, "state=working:progress=10", 1);
        take(&mut p, "state=working:id=build", 2);
        take(&mut p, "state=blocked:id=build/test:kind=question", 3);
        take(&mut p, "state=done:id=other", 4);
        // A report replaces its record completely
        take(&mut p, "state=idle", 5);
        assert_eq!(p.records.iter().map(|r| (r.id.as_str(), r.state.as_str(), r.progress)).collect::<Vec<_>>(), [("build", "working", None), ("build/test", "blocked", None), ("other", "done", None), ("", "idle", None)]);
        // clear removes the record and those beneath it, not a sibling whose name only starts the same
        take(&mut p, "state=working:id=builder", 6);
        take(&mut p, "state=clear:id=build", 7);
        assert_eq!(p.records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["other", "", "builder"]);
        // A new prompt ends working and blocked; done, error and idle stay
        take(&mut p, "state=error:id=e", 8);
        p.take(Said::Prompt("A".into(), None), 9);
        assert_eq!(p.records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["other", "", "e"]);
        take(&mut p, "state=blocked:id=b", 10);
        p.exited();
        assert_eq!(p.records.len(), 3);
        take(&mut p, "state=clear", 11);
        assert!(p.records.is_empty());
        p.take(Said::Progress(Some(Progress { state: "normal".into(), value: Some(5), at: 0 })), 12);
        p.reset();
        assert!(p.is_empty());
    }

    #[test]
    fn records_are_capped_and_the_least_recently_updated_goes() {
        let mut p = Program::default();
        for i in 0..MAX_RECORDS {
            p.take(Said::Report(report(&format!("state=working:id=r{i}")).unwrap()), i as u64);
        }
        // r0 is updated again, so r1 is the oldest when one more comes
        p.take(Said::Report(report("state=done:id=r0").unwrap()), 100);
        p.take(Said::Report(report("state=done:id=new").unwrap()), 101);
        assert_eq!(p.records.len(), MAX_RECORDS);
        assert!(!p.records.iter().any(|r| r.id == "r1"));
        assert!(p.records.iter().any(|r| r.id == "r0") && p.records.iter().any(|r| r.id == "new"));
    }

    #[test]
    fn query_prompt_marks_and_progress_are_read() {
        assert_eq!(read(b"7501;?", 10), Some(Said::Query));
        // The reply, echoed back, is no query
        let reply = &QUERY_REPLY.as_bytes()[2..QUERY_REPLY.len() - 2];
        assert_eq!(read(reply, QUERY_REPLY.len()), None);
        assert_eq!(read(b"7501;state=idle", MAX_SEQUENCE + 1), None);
        assert_eq!(read(b"133;A;cl=m", 12), Some(Said::Prompt("A".into(), None)));
        assert_eq!(read(b"133;D;2", 9), Some(Said::Prompt("D".into(), Some(2))));
        assert_eq!(read(b"133;D", 7), Some(Said::Prompt("D".into(), None)));
        assert_eq!(read(b"133;Z", 7), None);
        assert_eq!(read(b"9;4;1;50", 10), Some(Said::Progress(Some(Progress { state: "normal".into(), value: Some(50), at: 0 }))));
        assert_eq!(read(b"9;4;3;50", 10), Some(Said::Progress(Some(Progress { state: "indeterminate".into(), value: None, at: 0 }))));
        assert_eq!(read(b"9;4;0;0", 9), Some(Said::Progress(None)));
        assert_eq!(read(b"9;4", 5), Some(Said::Progress(None)));
        assert_eq!(read(b"9;4;9;1", 9), None);
        // An iTerm2 notification is not progress
        assert_eq!(read(b"9;Build done", 14), None);
    }
}
