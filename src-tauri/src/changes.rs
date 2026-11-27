//! The Changes pane of a hosted session (MCR-176): its branch and head, the
//! commits ahead of and behind the base, what is not committed, and a diff
//! per file. Read only: nothing here stages, commits, discards or fetches.
//!
//! The page names a session, never a path: `harness_changes` takes the
//! folder from the runner's record of that session, and every git call runs
//! in the top of the work tree `git rev-parse --show-toplevel` finds there
//! (a Codex session may sit in a subfolder).
//!
//! Git runs as the operator and outside any agent's sandbox, in a
//! repository an agent can write to. A repository's own config can make a
//! read-only command run a program: `core.fsmonitor` at every status, a
//! filter driver's `clean` or `process` for every file whose stat changed,
//! `diff.<driver>.textconv`, `diff.external`, `status.submoduleSummary`.
//! The shared runner (`git::run`, MCR-174) switches those off for every
//! call, and clears inherited `GIT_*` variables, hooks, optional locks (the
//! index is never written), lazy fetches and prompts, with a deadline and a
//! cap on each output stream, filter drivers whose names hold `=` included,
//! and with `log.showSignature=false`, so a signed commit runs no gpg (the
//! pane's formats use no `%G` placeholder either). The pane calls only the
//! subcommands the runner guards (`rev-parse`, `symbolic-ref`,
//! `merge-base`, `log`, `status`, `diff`); the tests below check the runner
//! against each program a repository's config could run.
//!
//! Lines of a diff that have the shape of a credential (`secret_shape`, the
//! detector of the cockpit and of Copy as task) are not sent to the page:
//! the line keeps its `+`/`-` mark, says it was hidden, and the file and
//! the whole read count them. Private key blocks are judged per hunk, since
//! a hunk can hold any part of one (`hide`). Branch, base and upstream
//! names, commit subjects and authors and file names of that shape are
//! hidden too. Screenshots of Live travel; the operator still learns that a
//! token is about to be committed, which is what they need to act on, and
//! can read it in a terminal of their own.
//!
//! One read describes one head: HEAD, the base and the upstream are
//! resolved to shas once, and every later call names those shas, so an
//! agent that commits during the read cannot mix two heads in one answer.
//! The uncommitted files are the net diff from that head plus what `git
//! status` reports beside it (a change staged and then undone in the work
//! tree, which a commit would still take). Logs are read with
//! `--encoding=UTF-8`, and a count git refuses is an error, never "even".

use serde::Serialize;
use std::path::Path;

/// Bytes of one diff call (all files of one side); the rest is not loaded
pub const PATCH_LIMIT: usize = 2 * 1024 * 1024;
/// Bytes of one file's diff sent to the page; a larger one is not shown
pub const FILE_DIFF: usize = 256 * 1024;
/// Bytes of a file or status list
const LIST_LIMIT: usize = 1024 * 1024;
/// Bytes of a one-line answer (a sha, a ref name, counts)
const LINE_LIMIT: usize = 64 * 1024;
/// Bytes of the ahead/behind marks: two per commit
const COUNT_LIMIT: usize = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 500;
pub const MAX_COMMITS: usize = 100;

/// What a diff line says instead of a credential
pub const HIDDEN: &str = "··· hidden: this line has the shape of a credential";
/// What a hunk header says after its ranges instead of such a line
const HIDDEN_CONTEXT: &str = "··· hidden";

/// One git call: `git <args>` in `dir`. The runner owns the timeout and the
/// bound on what is read (`limit` bytes of standard output).
pub trait Git {
    /// `Ok(Some(_))` when git exited with 0; `Ok(None)` when it exited
    /// otherwise (no such ref, not a work tree); `Err` when it could not run
    /// or ran out of time.
    fn run(&self, dir: &Path, args: &[String], limit: usize) -> Result<Option<Out>, String>;
}

/// Git through the shared runner (MCR-174), with one deadline for the
/// whole read: each call gets the time that is left.
pub struct SharedGit {
    pub until: std::time::Instant,
}

/// The time one read of the pane may take, all its git calls together
pub const DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);

impl SharedGit {
    pub fn started() -> Self {
        SharedGit { until: std::time::Instant::now() + DEADLINE }
    }
}

impl Git for SharedGit {
    fn run(&self, dir: &Path, args: &[String], limit: usize) -> Result<Option<Out>, String> {
        let left = self.until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err("Reading the work tree took too long.".into());
        }
        match crate::git::run(dir, args, left, limit) {
            Ok(out) if out.status.success() => Ok(Some(Out { stdout: out.stdout, truncated: false })),
            Ok(_) => Ok(None),
            // The runner keeps nothing of an output past its cap
            Err(crate::git::Error::OutputLimit { .. }) => Ok(Some(Out { stdout: vec![], truncated: true })),
            Err(crate::git::Error::Other(e)) if e.kind() == std::io::ErrorKind::TimedOut => Err("Reading the work tree took too long.".into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub struct Out {
    pub stdout: Vec<u8>,
    /// Standard output went past the limit and was cut there
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// None: the folder is not in a git work tree
    pub repo: Option<Repo>,
    pub note: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub root: String,
    /// None: a detached head
    pub branch: Option<String>,
    /// None: no commit yet
    pub head: Option<String>,
    pub base: Option<Track>,
    pub base_note: Option<String>,
    /// The branch's upstream, when it has one
    pub upstream: Option<Track>,
    /// Ahead of the base, newest first
    pub commits: Vec<Commit>,
    pub commits_more: bool,
    /// From the merge base with the base to the head
    pub committed: Side,
    /// From the head to the work tree, staged or not
    pub uncommitted: Side,
    pub untracked: Vec<String>,
    pub untracked_more: bool,
    /// Lines, subjects and names hidden as credential shapes
    pub hidden: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub name: String,
    pub ahead: u64,
    pub behind: u64,
    pub merge_base: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Seconds since 1970
    pub time: u64,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub files: Vec<File>,
    /// More files than `MAX_FILES`, or a list cut at its limit
    pub more: bool,
    pub note: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub path: String,
    /// Git's letter: M, A, D, T (type), U (unmerged)
    pub status: String,
    /// Uncommitted only: in the index / in the work tree
    pub staged: bool,
    pub unstaged: bool,
    /// None for a binary file
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
    pub diff: Option<String>,
    /// Why there is no diff: binary, too large, not loaded
    pub diff_note: Option<String>,
    pub hidden: usize,
    /// Uncommitted only: staged, then put back in the work tree, so the
    /// head and the work tree agree while a commit would still take the
    /// staged change. Its diff is the staged one, then the work tree's.
    pub undone: bool,
}

const TOO_LARGE: &str = "too large to show here: run git diff in a terminal";
const NOT_LOADED: &str = "not loaded: the diff of all files passed the limit";
const UNMATCHED: &str = "not shown: its part of the diff could not be told apart";

/// Everything the pane shows for the folder `cwd`.
pub fn read(git: &dyn Git, cwd: &Path) -> Result<Changes, String> {
    let plain = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    let Some(top) = git.run(cwd, &plain(&["rev-parse", "--show-toplevel"]), LINE_LIMIT)? else {
        return Ok(Changes { repo: None, note: Some("This folder is not in a git work tree.".into()) });
    };
    let root = line(&top.stdout);
    if root.is_empty() {
        return Ok(Changes { repo: None, note: Some("This folder is not in a git work tree.".into()) });
    }
    let dir = Path::new(&root);
    let r = Reader { git, dir };
    let mut repo = Repo { root: root.clone(), ..Repo::default() };
    repo.branch = r.line(&["symbolic-ref", "--quiet", "--short", "HEAD"])?.filter(|b| !b.is_empty());
    // The head and every ref compared with it are resolved once, and only
    // those shas are used after: an agent that commits while the pane reads
    // cannot make one answer describe two heads.
    repo.head = r.line(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.filter(|h| !h.is_empty());

    if let Some(head) = repo.head.clone() {
        match r.base()? {
            Some((name, base)) => {
                let merge_base = r.line(&["merge-base", &base, &head])?.filter(|m| !m.is_empty());
                let (behind, ahead) = r.counts("the base", &base, &head)?;
                repo.base = Some(Track { name: name.clone(), ahead, behind, merge_base: merge_base.clone() });
                let (commits, more) = r.commits(&base, &head)?;
                repo.commits = commits;
                repo.commits_more = more;
                match merge_base {
                    Some(mb) => repo.committed = r.side(&[&mb, &head], false)?,
                    None => repo.committed.note = Some("The head has no commit in common with the base.".into()),
                }
            }
            None => repo.base_note = Some("No base: the repository has neither origin/HEAD nor origin/main.".into()),
        }
        // `@{upstream}` follows the branch's setting, which can change during
        // the read: it is asked once, and the ref it named then is resolved
        if let Some(full) = r.line(&["rev-parse", "--symbolic-full-name", "@{upstream}"])?.filter(|u| u.starts_with("refs/")) {
            if let Some(sha) = r.line(&["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")])?.filter(|u| !u.is_empty()) {
                let (behind, ahead) = r.counts("the upstream", &sha, &head)?;
                let name = full.strip_prefix("refs/remotes/").or_else(|| full.strip_prefix("refs/heads/")).unwrap_or(&full).to_string();
                repo.upstream = Some(Track { name, ahead, behind, merge_base: None });
            }
        }
    } else {
        repo.base_note = Some("No commit yet.".into());
    }

    let (status, status_more) = r.tracked()?;
    let (untracked, more) = r.untracked()?;
    repo.untracked = untracked;
    repo.untracked_more = more;
    if let Some(head) = repo.head.clone() {
        repo.uncommitted = r.side(&[&head], true)?;
        for file in &mut repo.uncommitted.files {
            if let Some(xy) = status.iter().find(|(path, _)| *path == file.path).map(|(_, xy)| xy) {
                let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
                file.staged = x != b' ';
                file.unstaged = y != b' ';
                file.status = (if x == b' ' { y } else { x } as char).to_string();
            }
        }
        // A change git status sees that the net diff from the head does not:
        // staged, then undone in the work tree. A plain commit takes it.
        let missing: Vec<&(String, String)> = status.iter().filter(|(path, _)| !repo.uncommitted.files.iter().any(|f| f.path == *path)).collect();
        for (n, (path, xy)) in missing.into_iter().enumerate() {
            if n >= ONE_BY_ONE || repo.uncommitted.files.len() >= MAX_FILES {
                repo.uncommitted.more = true;
                break;
            }
            if let Some(file) = r.undone(&head, path, xy)? {
                repo.uncommitted.files.push(file);
            }
        }
    } else {
        repo.uncommitted.files = status.into_iter().map(|(path, xy)| File { status: xy.trim().chars().next().unwrap_or('A').to_string(), staged: xy.as_bytes()[0] != b' ', unstaged: xy.as_bytes()[1] != b' ', path, diff_note: Some("no commit to compare with yet".into()), ..File::default() }).collect();
    }
    if status_more {
        repo.uncommitted.more = true;
    }

    // Names, subjects and authors are shown too: hide those with the shape as well
    let mut hidden = 0;
    let mut name = |s: &mut String| {
        if crate::secret_shape::looks_secret(s) {
            *s = "(hidden: has the shape of a credential)".into();
            hidden += 1;
        }
    };
    for c in &mut repo.commits {
        name(&mut c.subject);
        name(&mut c.author);
    }
    for f in repo.committed.files.iter_mut().chain(repo.uncommitted.files.iter_mut()) {
        name(&mut f.path);
    }
    repo.untracked.iter_mut().for_each(&mut name);
    if let Some(b) = repo.branch.as_mut() {
        name(b);
    }
    for t in repo.base.iter_mut().chain(repo.upstream.iter_mut()) {
        name(&mut t.name);
    }
    repo.hidden = hidden + repo.committed.files.iter().chain(&repo.uncommitted.files).map(|f| f.hidden).sum::<usize>();
    Ok(Changes { repo: Some(repo), note: None })
}

struct Reader<'a> {
    git: &'a dyn Git,
    dir: &'a Path,
}

/// Diff options that keep config out of what is parsed (`git::run` adds
/// `--no-ext-diff` and `--no-textconv` to every diff)
const DIFF: [&str; 7] = ["--no-color", "--no-renames", "--no-relative", "--submodule=short", "--ignore-submodules=dirty", "--src-prefix=a/", "--dst-prefix=b/"];

impl Reader<'_> {
    fn run(&self, args: &[&str], limit: usize) -> Result<Option<Out>, String> {
        let all: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        self.git.run(self.dir, &all, limit)
    }

    fn line(&self, args: &[&str]) -> Result<Option<String>, String> {
        Ok(self.run(args, LINE_LIMIT)?.map(|o| line(&o.stdout)))
    }

    /// origin/HEAD, else origin/main: its name and the commit it names now
    fn base(&self) -> Result<Option<(String, String)>, String> {
        let sha = |r: &str| -> Result<Option<String>, String> { Ok(self.line(&["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")])?.filter(|s| !s.is_empty())) };
        if let Some(r) = self.line(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])? {
            if let Some(name) = r.strip_prefix("refs/remotes/") {
                if let Some(at) = sha(&format!("refs/remotes/{name}"))? {
                    return Ok(Some((name.to_string(), at)));
                }
            }
        }
        Ok(sha("refs/remotes/origin/main")?.map(|at| ("origin/main".into(), at)))
    }

    /// (behind, ahead) of HEAD against `other`. `log` marks each commit of
    /// the symmetric range `<` (only in `other`) or `>` (only in HEAD):
    /// `rev-list --count` is not among the runner's guarded subcommands.
    /// The marks are read as UTF-8 whatever `i18n.logOutputEncoding` says,
    /// and a count git refused is an error, never "even". `what` says which
    /// ref in fixed words: a ref's own name may have a credential's shape,
    /// and an error reaches the page unredacted.
    fn counts(&self, what: &str, other: &str, head: &str) -> Result<(u64, u64), String> {
        let range = format!("{other}...{head}");
        let Some(out) = self.run(&["log", "--no-color", "--no-show-signature", "--encoding=UTF-8", "--left-right", "--format=%m", &range, "--"], COUNT_LIMIT)? else {
            return Err(format!("Git could not count the commits between {what} and the head."));
        };
        if out.truncated {
            return Err(format!("The head and {what} are too far apart to count here."));
        }
        let marks = String::from_utf8_lossy(&out.stdout);
        let count = |m: &str| marks.lines().filter(|l| *l == m).count() as u64;
        Ok((count("<"), count(">")))
    }

    fn commits(&self, base: &str, head: &str) -> Result<(Vec<Commit>, bool), String> {
        let n = format!("-n{}", MAX_COMMITS + 1);
        let range = format!("{base}..{head}");
        let Some(out) = self.run(&["log", "--no-color", "--no-show-signature", "--encoding=UTF-8", "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1e", &n, &range, "--"], LIST_LIMIT)? else { return Ok((vec![], false)) };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut commits: Vec<Commit> = text
            .split('\x1e')
            .filter_map(|rec| {
                let mut f = rec.trim_start_matches('\n').split('\x1f');
                let (sha, short, author, time, subject) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
                (!sha.is_empty()).then(|| Commit { sha: sha.into(), short: short.into(), author: author.into(), time: time.parse().unwrap_or(0), subject: subject.into() })
            })
            .collect();
        let more = commits.len() > MAX_COMMITS || out.truncated;
        commits.truncate(MAX_COMMITS);
        Ok((commits, more))
    }

    /// `git status -z` entries, without the one an output cut at its limit
    /// left half written; and whether it was cut
    fn status(&self, untracked: &str) -> Result<(Vec<(String, String)>, bool), String> {
        let Some(out) = self.run(&["status", "--porcelain=v1", "-z", "--no-renames", untracked, "--ignore-submodules=dirty"], LIST_LIMIT)? else {
            return Ok((vec![], false));
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut entries: Vec<&str> = text.split('\0').filter(|e| e.len() > 3).collect();
        if out.truncated {
            entries.pop();
        }
        Ok((entries.into_iter().map(|e| (e[3..].to_string(), e[..2].to_string())).collect(), out.truncated))
    }

    /// XY letters per tracked path. Read apart from the untracked names, so
    /// that a flood of those cannot push the tracked ones out of the list.
    fn tracked(&self) -> Result<(Vec<(String, String)>, bool), String> {
        let (all, cut) = self.status("--untracked-files=no")?;
        Ok((all.into_iter().filter(|(_, xy)| xy != "??" && xy != "!!").collect(), cut))
    }

    fn untracked(&self) -> Result<(Vec<String>, bool), String> {
        let (all, cut) = self.status("--untracked-files=normal")?;
        let mut names: Vec<String> = all.into_iter().filter(|(_, xy)| xy == "??").map(|(path, _)| path).collect();
        let more = names.len() > MAX_FILES || cut;
        names.truncate(MAX_FILES);
        Ok((names, more))
    }

    /// A tracked file the net diff from `head` leaves out: its staged diff,
    /// then its work tree's, each read alone. What it says comes from those
    /// two diffs, not from the status read before them: a file an editor
    /// put back in the meantime has neither and is no row (None), and only
    /// a staged diff that the work tree takes back is `undone`.
    fn undone(&self, head: &str, path: &str, xy: &str) -> Result<Option<File>, String> {
        let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
        let mut file = File { path: path.to_string(), status: (if x == b' ' { y } else { x } as char).to_string(), ..File::default() };
        let spec = format!(":(literal){path}");
        let mut parts = [String::new(), String::new()];
        let mut cut = [false, false];
        for (i, from) in [&["--cached", head][..], &[][..]].into_iter().enumerate() {
            let args: Vec<String> = ["diff", "--patch"].iter().chain(DIFF.iter()).chain(from.iter()).map(|a| a.to_string()).chain(["--".to_string(), spec.clone()]).collect();
            if let Some(out) = self.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), FILE_DIFF)? {
                cut[i] = out.truncated;
                parts[i] = String::from_utf8_lossy(&out.stdout).into_owned();
            }
        }
        file.staged = cut[0] || !parts[0].is_empty();
        file.unstaged = cut[1] || !parts[1].is_empty();
        if !file.staged && !file.unstaged {
            return Ok(None);
        }
        file.undone = file.staged && file.unstaged;
        let text = parts.concat();
        if cut[0] || cut[1] || text.len() > FILE_DIFF {
            file.diff_note = Some(TOO_LARGE.into());
        } else if text.lines().any(|l| l.starts_with("Binary files ")) {
            file.binary = true;
            file.diff_note = Some("binary".into());
        } else {
            let (added, removed) = line_counts(&text);
            (file.added, file.removed) = (Some(added), Some(removed));
            let (shown, hidden) = hide(&text);
            file.diff = Some(shown);
            file.hidden = hidden;
        }
        Ok(Some(file))
    }

    /// The files between `range` (one commit: to the work tree) with counts and diffs
    fn side(&self, range: &[&str], worktree: bool) -> Result<Side, String> {
        let mut side = Side::default();
        let with = |head: &[&str]| -> Vec<String> { head.iter().chain(DIFF.iter()).chain(range.iter()).map(|a| a.to_string()).chain(std::iter::once("--".to_string())).collect() };
        let names = with(&["diff", "--name-status", "-z"]);
        let Some(status) = self.run(&names.iter().map(String::as_str).collect::<Vec<_>>(), LIST_LIMIT)? else {
            side.note = Some("Git could not compare these.".into());
            return Ok(side);
        };
        let counts = with(&["diff", "--numstat", "-z"]);
        let numstat = self.run(&counts.iter().map(String::as_str).collect::<Vec<_>>(), LIST_LIMIT)?;
        // --name-status -z: letter, then the path
        let text = String::from_utf8_lossy(&status.stdout);
        let mut parts = text.split('\0');
        while let (Some(letter), Some(path)) = (parts.next(), parts.next()) {
            if letter.is_empty() {
                break;
            }
            side.files.push(File { path: path.to_string(), status: letter.chars().next().unwrap_or('M').to_string(), unstaged: worktree, ..File::default() });
        }
        side.more = status.truncated;
        if side.files.len() > MAX_FILES {
            side.files.truncate(MAX_FILES);
            side.more = true;
        }
        // --numstat -z: added TAB removed TAB path, "-" for a binary file
        if let Some(numstat) = numstat {
            for rec in String::from_utf8_lossy(&numstat.stdout).split('\0') {
                let mut f = rec.splitn(3, '\t');
                let (Some(a), Some(r), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
                if let Some(file) = side.files.iter_mut().find(|file| file.path == path) {
                    file.binary = a == "-";
                    file.added = a.parse().ok();
                    file.removed = r.parse().ok();
                }
            }
        }
        let patch_args = with(&["diff", "--patch"]);
        let patch = self.run(&patch_args.iter().map(String::as_str).collect::<Vec<_>>(), PATCH_LIMIT)?;
        match patch {
            Some(patch) => attach(&mut side.files, &String::from_utf8_lossy(&patch.stdout), patch.truncated),
            None => side.files.iter_mut().for_each(|f| f.diff_note = Some(NOT_LOADED.into())),
        }
        // All files together passed the limit: each file that was left out
        // on its own, up to `ONE_BY_ONE` of them, so one large file does not
        // hide the small ones beside it. The path is git's own, taken literally.
        let left: Vec<usize> = side.files.iter().enumerate().filter(|(_, f)| f.diff_note.as_deref() == Some(NOT_LOADED)).map(|(i, _)| i).take(ONE_BY_ONE).collect();
        for i in left {
            let spec = format!(":(literal){}", side.files[i].path);
            let args: Vec<String> = ["diff", "--patch"].iter().chain(DIFF.iter()).chain(range.iter()).map(|a| a.to_string()).chain(["--".to_string(), spec]).collect();
            let one = self.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), FILE_DIFF)?;
            let file = &mut side.files[i];
            match one {
                Some(out) if out.truncated => file.diff_note = Some(TOO_LARGE.into()),
                Some(out) => {
                    file.diff_note = None;
                    attach(std::slice::from_mut(file), &String::from_utf8_lossy(&out.stdout), false);
                }
                None => {}
            }
        }
        Ok(side)
    }
}

/// Files whose diffs are read one by one after the diff of all passed its limit
const ONE_BY_ONE: usize = 100;

fn line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end_matches(['\n', '\r']).to_string()
}

/// Added and removed lines of a patch, counted in its hunks only
fn line_counts(patch: &str) -> (u64, u64) {
    let (mut added, mut removed, mut in_hunk) = (0, 0, false);
    for l in patch.lines() {
        if l.starts_with("diff --git ") {
            in_hunk = false;
        } else if l.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && l.starts_with('+') {
            added += 1;
        } else if in_hunk && l.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// Splits a patch at its file headers and gives each file its part, in the
/// order git lists them; a header that names another path ends the pairing.
fn attach(files: &mut [File], patch: &str, truncated: bool) {
    let mut chunks: Vec<&str> = Vec::new();
    let mut start = None;
    let mut at = 0;
    for l in patch.split_inclusive('\n') {
        if l.starts_with("diff --git ") {
            if let Some(s) = start {
                chunks.push(&patch[s..at]);
            }
            start = Some(at);
        }
        at += l.len();
    }
    // The last part is whole only when nothing was cut
    let last = start.map(|s| &patch[s..]);
    let mut paired = true;
    for (i, file) in files.iter_mut().enumerate() {
        let chunk = chunks.get(i).copied().or(if i == chunks.len() && !truncated { last } else { None });
        if file.binary {
            file.diff_note = Some("binary".into());
            continue;
        }
        let Some(chunk) = chunk.filter(|_| paired) else {
            file.diff_note = Some(if paired { NOT_LOADED } else { UNMATCHED }.into());
            continue;
        };
        let header = chunk.lines().next().unwrap_or("");
        if header != format!("diff --git a/{0} b/{0}", file.path) && !header.starts_with("diff --git \"") {
            paired = false;
            file.diff_note = Some(UNMATCHED.into());
            continue;
        }
        if chunk.len() > FILE_DIFF {
            file.diff_note = Some(TOO_LARGE.into());
            continue;
        }
        let (text, hidden) = hide(chunk);
        file.diff = Some(text);
        file.hidden = hidden;
    }
}

/// One file's diff with every line of a credential's shape replaced, and
/// what may be a private key hidden. A hunk can hold any part of a key
/// block, so each hunk is judged alone: from a BEGIN line to its END line,
/// to the hunk's end when the END is outside it, from the hunk's start when
/// the BEGIN is; and, for the middle of a block where neither delimiter is
/// in the hunk, every line with the shape of a key's body (at least 40
/// characters of the base64 alphabet that are not all hex digits) with the
/// base64 lines next to it. This hides a long run of such text that is no
/// key as well; it is counted like any hidden line.
pub fn hide(chunk: &str) -> (String, usize) {
    let lines: Vec<&str> = chunk.split_inclusive('\n').collect();
    let body = |l: &str| l.trim_end_matches(['\n', '\r']).to_string();
    let mut hide = vec![false; lines.len()];
    let mut from = 0;
    for (i, l) in lines.iter().enumerate() {
        if l.starts_with("@@") || l.starts_with("diff --git ") {
            mark_keys(&lines, from..i, &mut hide);
            from = i + 1;
        }
    }
    mark_keys(&lines, from..lines.len(), &mut hide);
    let mut out = String::with_capacity(chunk.len());
    let mut hidden = 0;
    for (i, l) in lines.iter().enumerate() {
        let b = body(l);
        // A hunk header keeps its ranges; git puts the nearest line that
        // starts with a letter after them, which can be a key's line
        if let Some(ranges) = b.strip_prefix("@@").and_then(|r| r.find("@@").map(|k| &b[..k + 4])) {
            let context = b[ranges.len()..].trim();
            if !context.is_empty() && (key_body(context) || context.contains("PRIVATE KEY") || crate::secret_shape::looks_secret(context)) {
                out.push_str(ranges);
                out.push(' ');
                out.push_str(HIDDEN_CONTEXT);
                out.push('\n');
                hidden += 1;
            } else {
                out.push_str(l);
            }
            continue;
        }
        if hide[i] || crate::secret_shape::looks_secret(&b) {
            let mark = b.chars().next().filter(|c| matches!(c, '+' | '-' | ' ')).unwrap_or(' ');
            out.push(mark);
            out.push_str(HIDDEN);
            out.push('\n');
            hidden += 1;
        } else {
            out.push_str(l);
        }
    }
    (out, hidden)
}

/// The text of a hunk's line without its `+`, `-` or ` ` mark, and
/// without the file's own indentation (a key in a YAML block scalar)
fn content(l: &str) -> &str {
    let b = l.trim_end_matches(['\n', '\r']);
    let b = match b.as_bytes().first() {
        Some(b'+' | b'-' | b' ') => &b[1..],
        _ => b,
    };
    b.trim_matches([' ', '\t'])
}

fn base64ish(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
}

/// A line that may be part of a key's body
fn key_body(s: &str) -> bool {
    s.len() >= 40 && base64ish(s) && !s.bytes().all(|c| c.is_ascii_hexdigit())
}

fn mark_keys(lines: &[&str], hunk: std::ops::Range<usize>, hide: &mut [bool]) {
    let begins = |i: usize| content(lines[i]).contains("-----BEGIN") && content(lines[i]).contains("PRIVATE KEY");
    let ends = |i: usize| content(lines[i]).contains("-----END") && content(lines[i]).contains("PRIVATE KEY");
    let mut open = None;
    for i in hunk.clone() {
        if begins(i) {
            open = Some(i);
        }
        if ends(i) {
            let start = open.take().unwrap_or(hunk.start);
            hide[start..=i].iter_mut().for_each(|h| *h = true);
        }
    }
    if let Some(start) = open {
        hide[start..hunk.end].iter_mut().for_each(|h| *h = true);
    }
    // Each run of base64 lines is looked at once: hidden whole when any
    // line of it has a key body's shape
    let mut i = hunk.start;
    while i < hunk.end {
        let start = i;
        let mut keyish = false;
        while i < hunk.end && base64ish(content(lines[i])) {
            keyish |= key_body(content(lines[i]));
            i += 1;
        }
        if keyish {
            hide[start..i].iter_mut().for_each(|h| *h = true);
        }
        i = i.max(start + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The repository's own settings for the tests. `core.autocrlf=false`
    /// keeps the bytes a test writes the bytes git stores and checks out:
    /// Git for Windows sets `autocrlf=true` in its system config, which the
    /// test's own git calls read and the runner (`GIT_CONFIG_NOSYSTEM`) does
    /// not, so a checkout with CRLF would look changed to the pane.
    const SETTINGS: [(&str, &str); 4] = [("user.email", "t@example.invalid"), ("user.name", "T"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")];

    fn init(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        for (k, v) in SETTINGS {
            git(dir, &["config", k, v]);
        }
    }

    /// A repository with an origin whose main has one commit, cloned.
    fn clone() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir(&origin).unwrap();
        init(&origin);
        write(&origin, "a.txt", "one\ntwo\nthree\n");
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "first"]);
        // Set before the checkout, so it writes the stored bytes
        git(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", "origin", "work"]);
        let work = tmp.path().join("work");
        for (k, v) in SETTINGS {
            git(&work, &["config", k, v]);
        }
        (tmp, work)
    }

    fn repo(dir: &Path) -> Repo {
        read(&SharedGit::started(), dir).unwrap().repo.expect("a work tree")
    }

    #[test]
    fn a_folder_outside_git_is_said_so() {
        let tmp = tempfile::tempdir().unwrap();
        let c = read(&SharedGit::started(), tmp.path()).unwrap();
        assert!(c.repo.is_none());
        assert!(c.note.unwrap().contains("not in a git work tree"));
    }

    #[test]
    fn a_clean_tree_has_its_branch_head_and_base_and_nothing_else() {
        let (_tmp, work) = clone();
        let r = repo(&work);
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.head.as_ref().map(String::len), Some(40));
        let base = r.base.unwrap();
        assert_eq!((base.name.as_str(), base.ahead, base.behind), ("origin/main", 0, 0));
        assert!(r.commits.is_empty() && r.committed.files.is_empty() && r.uncommitted.files.is_empty() && r.untracked.is_empty());
        let up = r.upstream.unwrap();
        assert_eq!((up.name.as_str(), up.ahead, up.behind), ("origin/main", 0, 0));
    }

    #[test]
    fn a_dirty_tree_shows_staged_unstaged_and_untracked_with_counts_and_diffs() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "one\nTWO\nthree\nfour\n");
        write(&work, "b.txt", "new\n");
        git(&work, &["add", "b.txt"]);
        write(&work, "c/untracked.txt", "x\n");
        let r = repo(&work);
        let files: Vec<_> = r.uncommitted.files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.staged, f.unstaged, f.added, f.removed)).collect();
        assert_eq!(files, vec![("a.txt", "M", false, true, Some(2), Some(1)), ("b.txt", "A", true, false, Some(1), Some(0))]);
        let diff = r.uncommitted.files[0].diff.as_deref().unwrap();
        assert!(diff.starts_with("diff --git a/a.txt b/a.txt") && diff.contains("-two\n+TWO\n") && diff.contains("+four\n"), "{diff}");
        assert!(r.uncommitted.files[1].diff.as_deref().unwrap().contains("+new"));
        assert_eq!(r.untracked, vec!["c/"]);
        assert!(r.committed.files.is_empty());
    }

    #[test]
    fn a_codex_session_in_a_subfolder_reads_the_whole_work_tree() {
        let (_tmp, work) = clone();
        write(&work, "deep/er/x.txt", "x\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "deep"]);
        write(&work, "a.txt", "changed\n");
        let r = repo(&work.join("deep/er"));
        assert_eq!(dunce::canonicalize(&r.root).unwrap(), dunce::canonicalize(&work).unwrap());
        assert_eq!(r.uncommitted.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a.txt"]);
        assert_eq!(r.committed.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["deep/er/x.txt"]);
    }

    #[test]
    fn ahead_and_behind_count_against_origin_head_and_list_the_commits_ahead() {
        let (tmp, work) = clone();
        let origin = tmp.path().join("origin");
        write(&origin, "o.txt", "upstream\n");
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "on main"]);
        git(&work, &["fetch", "-q"]);
        git(&work, &["checkout", "-qb", "feature"]);
        for (i, name) in ["f1.txt", "f2.txt"].iter().enumerate() {
            write(&work, name, &format!("{i}\n"));
            git(&work, &["add", "."]);
            git(&work, &["commit", "-qm", &format!("feature {i}")]);
        }
        let r = repo(&work);
        assert_eq!(r.branch.as_deref(), Some("feature"));
        let base = r.base.unwrap();
        assert_eq!((base.name.as_str(), base.ahead, base.behind), ("origin/main", 2, 1));
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["feature 1", "feature 0"]);
        assert!(!r.commits_more);
        // From the merge base: o.txt came in on main and is not this branch's change
        assert_eq!(r.committed.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("f1.txt", "A"), ("f2.txt", "A")]);
        assert!(r.upstream.is_none());
    }

    #[test]
    fn the_base_is_origin_head_where_it_names_another_branch() {
        let (tmp, work) = clone();
        let origin = tmp.path().join("origin");
        git(&origin, &["branch", "trunk"]);
        git(&work, &["fetch", "-q"]);
        git(&work, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        assert_eq!(repo(&work).base.unwrap().name, "origin/trunk");
        // Without origin/HEAD, origin/main
        git(&work, &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
        assert_eq!(repo(&work).base.unwrap().name, "origin/main");
    }

    #[test]
    fn a_repository_without_origin_has_no_base_and_still_shows_uncommitted_work() {
        let tmp = tempfile::tempdir().unwrap();
        init(tmp.path());
        let r = repo(tmp.path());
        assert!(r.head.is_none() && r.base.is_none());
        write(tmp.path(), "n.txt", "n\n");
        git(tmp.path(), &["add", "."]);
        let r = repo(tmp.path());
        assert_eq!(r.uncommitted.files.iter().map(|f| (f.path.as_str(), f.staged)).collect::<Vec<_>>(), vec![("n.txt", true)]);
        git(tmp.path(), &["commit", "-qm", "n"]);
        let r = repo(tmp.path());
        assert!(r.head.is_some() && r.base.is_none() && r.base_note.unwrap().contains("origin/main"));
    }

    #[test]
    fn a_large_diff_is_not_shown_and_the_files_beside_it_are() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "small change\n");
        let big: String = (0..80_000).map(|i| format!("line {i} of a long generated file\n")).collect();
        // Larger than the diff of all files may be: the others are read one by one
        assert!(big.len() > PATCH_LIMIT);
        write(&work, "big.txt", &big);
        write(&work, "z.txt", "after\n");
        git(&work, &["add", "big.txt", "z.txt"]);
        let r = repo(&work);
        let by = |p: &str| r.uncommitted.files.iter().find(|f| f.path == p).unwrap();
        assert!(by("a.txt").diff.is_some());
        assert_eq!((by("big.txt").diff.as_deref(), by("big.txt").diff_note.as_deref(), by("big.txt").added), (None, Some(TOO_LARGE), Some(80_000)));
        assert!(by("z.txt").diff.as_deref().unwrap().contains("+after"));
    }

    #[test]
    fn a_patch_cut_at_its_limit_loads_the_files_before_the_cut_only() {
        let mut files: Vec<File> = ["a", "b", "c"].iter().map(|p| File { path: p.to_string(), ..File::default() }).collect();
        let patch = "diff --git a/a b/a\n+1\ndiff --git a/b b/b\n+2\ndiff --git a/c b/c\n+3 cut he";
        attach(&mut files, patch, true);
        assert_eq!(files.iter().map(|f| (f.diff.is_some(), f.diff_note.as_deref())).collect::<Vec<_>>(), vec![(true, None), (true, None), (false, Some(NOT_LOADED))]);
        // A header that names another path ends the pairing rather than showing a file the wrong diff
        let mut files: Vec<File> = ["a", "b"].iter().map(|p| File { path: p.to_string(), ..File::default() }).collect();
        attach(&mut files, "diff --git a/x b/x\n+1\ndiff --git a/b b/b\n+2\n", false);
        assert_eq!(files.iter().map(|f| f.diff_note.as_deref()).collect::<Vec<_>>(), vec![Some(UNMATCHED), Some(UNMATCHED)]);
    }

    #[test]
    fn a_path_git_quotes_in_its_diff_header_still_gets_its_diff() {
        let (_tmp, work) = clone();
        write(&work, "naïve note.txt", "one\n");
        write(&work, "plain.txt", "two\n");
        git(&work, &["add", "."]);
        let r = repo(&work);
        let by = |p: &str| r.uncommitted.files.iter().find(|f| f.path == p).unwrap();
        assert!(by("naïve note.txt").diff.as_deref().unwrap().contains("+one"));
        assert!(by("plain.txt").diff.as_deref().unwrap().contains("+two"));
    }

    #[test]
    fn a_binary_file_has_no_diff_and_no_counts() {
        let (_tmp, work) = clone();
        std::fs::write(work.join("bin.dat"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        git(&work, &["add", "."]);
        let r = repo(&work);
        let f = &r.uncommitted.files[0];
        assert_eq!((f.binary, f.added, f.diff.as_deref(), f.diff_note.as_deref()), (true, None, None, Some("binary")));
    }

    /// Fake credentials, put together at run time so that no scanner takes this file for a leak.
    fn token() -> String {
        ["gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].concat()
    }

    #[test]
    fn credential_lines_are_hidden_and_counted_and_the_rest_is_shown() {
        let (_tmp, work) = clone();
        let key = ["-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQUJDREVGR0hJSktMTU5PUFFS\n-----END OPENSSH ", "PRIVATE KEY-----\n"].concat();
        write(&work, ".env", &format!("NAME=demo\nTOKEN={}\n", token()));
        write(&work, "id_test", &key);
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", &format!("add {}", token())]);
        let r = repo(&work);
        let env = r.committed.files.iter().find(|f| f.path == ".env").unwrap();
        let diff = env.diff.as_deref().unwrap();
        assert!(diff.contains("+NAME=demo") && diff.contains(&format!("+{HIDDEN}")) && !diff.contains(&token()), "{diff}");
        assert_eq!(env.hidden, 1);
        let id = r.committed.files.iter().find(|f| f.path == "id_test").unwrap();
        assert_eq!(id.hidden, 4);
        assert!(!id.diff.as_deref().unwrap().contains("b3BlbnNz"));
        assert!(!r.commits[0].subject.contains(&token()));
        assert_eq!(r.hidden, 1 + 4 + 1);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains(&token()) && !json.contains("QUJDREVG"));
    }

    /// The hooks are shell commands: Unix only
    #[cfg(unix)]
    #[test]
    fn a_repositorys_config_runs_no_program_while_it_is_read() {
        let (tmp, work) = clone();
        let mark = |what: &str| tmp.path().join(format!("ran-{what}"));
        let touch = |what: &str| format!("touch '{}'; cat", mark(what).display());
        let quit = |what: &str| format!("touch '{}'; false", mark(what).display());
        write(&work, ".gitattributes", "*.txt filter=evil diff=evil\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "attributes"]);
        git(&work, &["config", "filter.evil.clean", &touch("clean")]);
        git(&work, &["config", "filter.evil.process", &quit("process")]);
        git(&work, &["config", "filter.evil.required", "true"]);
        git(&work, &["config", "filter.other.name.clean", &touch("dotted")]);
        git(&work, &["config", "diff.evil.textconv", &touch("textconv")]);
        git(&work, &["config", "diff.external", &touch("external")]);
        git(&work, &["config", "core.fsmonitor", &quit("fsmonitor")]);
        git(&work, &["config", "core.pager", &touch("pager")]);
        write(&work, "a.txt", "one\nchanged\n");
        let r = repo(&work);
        assert_eq!(r.uncommitted.files[0].path, "a.txt");
        assert!(r.uncommitted.files[0].diff.as_deref().unwrap().contains("+changed"));
        assert!(r.committed.files.iter().any(|f| f.path == ".gitattributes"));
        for what in ["clean", "process", "dotted", "textconv", "external", "fsmonitor", "pager"] {
            assert!(!mark(what).exists(), "{what} ran");
        }
        // The same tree without the guards runs them: the test sees what it says it prevents
        let _ = Command::new("git").args(["status", "--porcelain"]).current_dir(&work).output().unwrap();
        assert!(mark("fsmonitor").exists() || mark("process").exists(), "the unguarded status ran nothing: the test proves nothing");
    }

    /// A filter driver named `a=b`, which `.gitattributes` can select, is
    /// switched off by the runner alone (it passes the override through
    /// `GIT_CONFIG_KEY_n`, which `-c` could not: git splits a `-c` at its
    /// first `=`). The pane reads the tree and the filter never runs.
    #[cfg(unix)]
    #[test]
    fn a_filter_named_with_an_equals_sign_does_not_run_while_the_pane_reads() {
        let (tmp, work) = clone();
        let mark = tmp.path().join("ran-a=b");
        write(&work, ".gitattributes", "*.txt filter=a=b\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "attributes"]);
        git(&work, &["config", "filter.a=b.clean", &format!("touch '{}'; cat", mark.display())]);
        git(&work, &["config", "filter.a=b.required", "true"]);
        write(&work, "a.txt", "one\nchanged\n");
        let r = repo(&work);
        assert_eq!(r.uncommitted.files[0].path, "a.txt");
        assert!(r.uncommitted.files[0].diff.as_deref().unwrap().contains("+changed"));
        assert!(!mark.exists(), "the a=b filter ran");
        // The case is real: plain git runs it
        let _ = Command::new("git").args(["diff", "--numstat", "HEAD"]).current_dir(&work).output().unwrap();
        assert!(mark.exists(), "plain git ran no a=b filter: the test proves nothing");
    }

    /// A signed commit ahead of the base, with `log.showSignature` on and a
    /// `gpg.program` in the repository's config: the pane lists the commit
    /// and runs no gpg (the runner sets `log.showSignature=false`, the
    /// pane's formats have no `%G`).
    #[cfg(unix)]
    #[test]
    fn a_signed_commit_runs_no_gpg_program_while_the_pane_reads() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let (tmp, work) = clone();
        let mark = tmp.path().join("ran-gpg");
        let probe = tmp.path().join("gpg-probe");
        std::fs::write(&probe, format!("#!/bin/sh\ntouch '{}'; exit 1\n", mark.display())).unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
        write(&work, "s.txt", "signed\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "signed work"]);
        // A signature header needs no key for log to hand it to gpg
        let head = Command::new("git").args(["cat-file", "commit", "HEAD"]).current_dir(&work).output().unwrap();
        let head = String::from_utf8(head.stdout).unwrap();
        let (headers, message) = head.split_once("\n\n").unwrap();
        let signed = format!("{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\n{message}");
        let mut hash = Command::new("git")
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .current_dir(&work)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        hash.stdin.take().unwrap().write_all(signed.as_bytes()).unwrap();
        let hash = hash.wait_with_output().unwrap();
        assert!(hash.status.success());
        let sha = String::from_utf8(hash.stdout).unwrap().trim().to_string();
        git(&work, &["update-ref", "HEAD", &sha]);
        git(&work, &["config", "gpg.program", probe.to_str().unwrap()]);
        git(&work, &["config", "log.showSignature", "true"]);
        let r = repo(&work);
        assert_eq!(r.head.as_deref(), Some(sha.as_str()));
        assert_eq!(r.base.as_ref().map(|b| (b.ahead, b.behind)), Some((1, 0)));
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["signed work"]);
        assert!(r.committed.files.iter().any(|f| f.path == "s.txt"));
        assert!(!mark.exists(), "gpg ran");
        // The case is real: plain git log runs it
        let _ = Command::new("git").args(["log", "-1"]).current_dir(&work).output().unwrap();
        assert!(mark.exists(), "plain git log ran no gpg: the test proves nothing");
    }

    /// Every call the pane makes uses a subcommand the runner guards
    #[test]
    fn the_pane_calls_only_subcommands_the_runner_guards() {
        struct Seen(std::cell::RefCell<Vec<String>>);
        impl Git for Seen {
            fn run(&self, dir: &Path, args: &[String], limit: usize) -> Result<Option<Out>, String> {
                self.0.borrow_mut().push(args[0].clone());
                SharedGit::started().run(dir, args, limit)
            }
        }
        let (_tmp, work) = clone();
        write(&work, "a.txt", "dirty\n");
        write(&work, "new.txt", "new\n");
        git(&work, &["checkout", "-qb", "feature"]);
        git(&work, &["add", "new.txt"]);
        git(&work, &["commit", "-qm", "feature"]);
        git(&work, &["branch", "--set-upstream-to=origin/main"]);
        let seen = Seen(Default::default());
        read(&seen, &work).unwrap().repo.expect("a work tree");
        let used: std::collections::BTreeSet<String> = seen.0.into_inner().into_iter().collect();
        let guarded = ["rev-parse", "symbolic-ref", "merge-base", "log", "status", "diff"];
        assert!(used.iter().all(|u| guarded.contains(&u.as_str())), "{used:?}");
        assert!(used.contains("log") && used.contains("diff") && used.contains("status"), "{used:?}");
    }

    #[test]
    fn reading_changes_nothing_in_the_repository() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "dirty\n");
        let index = work.join(".git/index");
        let before = std::fs::read(&index).unwrap();
        let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = repo(&work);
        assert_eq!(std::fs::read(&index).unwrap(), before);
        assert_eq!(std::fs::metadata(&index).unwrap().modified().unwrap(), modified);
        assert!(!work.join(".git/index.lock").exists());
    }

    /// A Git that hands each call to the shared runner, and lets a test act
    /// after a call (an agent that commits while the pane reads) or answer
    /// in its place.
    struct Hooked<F: Fn(&[String]) -> Option<Result<Option<Out>, String>>, G: Fn(&[String])> {
        instead: F,
        after: G,
    }
    impl<F: Fn(&[String]) -> Option<Result<Option<Out>, String>>, G: Fn(&[String])> Git for Hooked<F, G> {
        fn run(&self, dir: &Path, args: &[String], limit: usize) -> Result<Option<Out>, String> {
            if let Some(answer) = (self.instead)(args) {
                return answer;
            }
            let out = SharedGit::started().run(dir, args, limit);
            (self.after)(args);
            out
        }
    }

    fn sha(dir: &Path, rev: &str) -> String {
        let out = Command::new("git").args(["rev-parse", rev]).current_dir(dir).output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn a_staged_change_undone_in_the_work_tree_is_still_listed() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "one\ntwo\nthree\nstaged\n");
        git(&work, &["add", "a.txt"]);
        // The work tree is the head's bytes again: the net diff is empty
        write(&work, "a.txt", "one\ntwo\nthree\n");
        let r = repo(&work);
        let files: Vec<_> = r.uncommitted.files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.staged, f.unstaged, f.undone)).collect();
        assert_eq!(files, vec![("a.txt", "M", true, true, true)]);
        let f = &r.uncommitted.files[0];
        let diff = f.diff.as_deref().unwrap();
        // The staged diff first, then the work tree's that takes it back
        let (staged, back) = (diff.find("+staged").unwrap(), diff.rfind("-staged").unwrap());
        assert!(staged < back, "{diff}");
        assert_eq!((f.added, f.removed), (Some(1), Some(1)));
        // A file the net diff lists is not listed twice
        write(&work, "a.txt", "one\nTWO\nthree\n");
        assert_eq!(repo(&work).uncommitted.files.iter().filter(|f| f.path == "a.txt").count(), 1);
    }

    #[test]
    fn a_flood_of_untracked_names_does_not_push_tracked_changes_out() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "one\ntwo\nthree\nstaged\n");
        git(&work, &["add", "a.txt"]);
        write(&work, "a.txt", "one\ntwo\nthree\n");
        write(&work, "u.txt", "u\n");
        // The untracked list passed its limit: the runner keeps none of it
        let flood = Hooked { instead: |args: &[String]| args.iter().any(|a| a == "--untracked-files=normal").then(|| Ok(Some(Out { stdout: vec![], truncated: true }))), after: |_: &[String]| {} };
        let r = read(&flood, &work).unwrap().repo.unwrap();
        assert!(r.untracked.is_empty() && r.untracked_more);
        assert_eq!(r.uncommitted.files.iter().map(|f| (f.path.as_str(), f.undone)).collect::<Vec<_>>(), vec![("a.txt", true)]);
    }

    #[test]
    fn one_read_describes_the_head_it_resolved_first() {
        let (_tmp, work) = clone();
        git(&work, &["checkout", "-qb", "feature"]);
        write(&work, "f.txt", "f\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "first feature"]);
        let first = sha(&work, "HEAD");
        let committed = std::cell::Cell::new(false);
        // An agent commits right after the pane resolved the head
        let racing = Hooked {
            instead: |_: &[String]| None,
            after: |args: &[String]| {
                if !committed.get() && args.iter().any(|a| a == "HEAD^{commit}") {
                    committed.set(true);
                    write(&work, "late.txt", "late\n");
                    git(&work, &["add", "."]);
                    git(&work, &["commit", "-qm", "late feature"]);
                }
            },
        };
        let r = read(&racing, &work).unwrap().repo.unwrap();
        assert!(committed.get());
        assert_ne!(sha(&work, "HEAD"), first);
        assert_eq!(r.head.as_deref(), Some(first.as_str()));
        let base = r.base.unwrap();
        assert_eq!((base.ahead, base.behind), (1, 0));
        assert_eq!(r.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["first feature"]);
        assert_eq!(r.committed.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["f.txt"]);
        // Against that head, the later commit's file is work not committed
        assert_eq!(r.uncommitted.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("late.txt", "A")]);
    }

    #[test]
    fn counts_and_commits_are_read_as_utf8_whatever_the_log_encoding() {
        let (_tmp, work) = clone();
        git(&work, &["checkout", "-qb", "feature"]);
        for i in 0..4 {
            write(&work, &format!("f{i}.txt"), "x\n");
            git(&work, &["add", "."]);
            git(&work, &["commit", "-qm", &format!("feature {i} é")]);
        }
        git(&work, &["config", "i18n.logOutputEncoding", "UTF-16"]);
        let r = repo(&work);
        let base = r.base.unwrap();
        assert_eq!((base.ahead, base.behind), (4, 0));
        assert_eq!(r.commits.iter().map(|c| (c.subject.as_str(), c.author.as_str())).collect::<Vec<_>>(), (0..4).rev().map(|i| (format!("feature {i} é"), "T".to_string())).collect::<Vec<_>>().iter().map(|(s, a)| (s.as_str(), a.as_str())).collect::<Vec<_>>());
    }

    #[test]
    fn a_count_git_refuses_is_an_error_and_never_even() {
        let (_tmp, work) = clone();
        let refusing = Hooked { instead: |args: &[String]| args.iter().any(|a| a == "--left-right").then_some(Ok(None)), after: |_: &[String]| {} };
        let e = read(&refusing, &work).unwrap_err();
        assert!(e.contains("could not count"), "{e}");
    }

    #[test]
    fn names_of_the_base_upstream_and_authors_are_hidden_when_they_look_like_credentials() {
        let (tmp, work) = clone();
        let origin = tmp.path().join("origin");
        let t = token();
        // A branch of that name on origin, its upstream, and a commit by an author of that name
        git(&origin, &["branch", &t]);
        git(&work, &["fetch", "-q"]);
        git(&work, &["checkout", "-qb", &t, "--track", &format!("origin/{t}")]);
        git(&work, &["symbolic-ref", "refs/remotes/origin/HEAD", &format!("refs/remotes/origin/{t}")]);
        write(&work, "f.txt", "f\n");
        git(&work, &["add", "."]);
        git(&work, &["-c", &format!("user.name={t}"), "commit", "-qm", "work"]);
        let r = repo(&work);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains(&t), "{json}");
        assert_eq!(r.base.as_ref().map(|b| (b.ahead, b.behind)), Some((1, 0)));
        assert!(r.upstream.as_ref().unwrap().name.starts_with("(hidden"));
        assert!(r.commits[0].author.starts_with("(hidden"));
        // branch, base, upstream, author
        assert_eq!(r.hidden, 4);
    }

    /// Test-only key material: base64 lines of a key's length, made at run time
    fn key_lines(n: usize) -> Vec<String> {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        (0..n).map(|i| (0..64).map(|j| alphabet[(i * 7 + j * 13) % 64] as char).collect()).collect()
    }

    #[test]
    fn a_hunk_in_the_middle_of_a_key_block_shows_none_of_it() {
        let (_tmp, work) = clone();
        let mut lines = vec![["-----BEGIN RSA ", "PRIVATE KEY-----"].concat()];
        lines.extend(key_lines(30));
        lines.push("AAAB3==".into());
        lines.push(["-----END RSA ", "PRIVATE KEY-----"].concat());
        let text = |l: &[String]| l.iter().map(|l| format!("{l}\n")).collect::<String>();
        write(&work, "id_rsa", &text(&lines));
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "key"]);
        // One line in the middle changes: the hunk has neither delimiter
        let old = lines[15].clone();
        lines[15] = key_lines(31)[30].clone();
        write(&work, "id_rsa", &text(&lines));
        let r = repo(&work);
        let f = &r.uncommitted.files[0];
        let diff = f.diff.as_deref().unwrap();
        assert!(!diff.contains("BEGIN") && !diff.contains("END"), "the fixture's hunk holds a delimiter: {diff}");
        for l in &lines[1..31] {
            assert!(!diff.contains(&l[..20]), "a key line is shown: {diff}");
        }
        assert!(!diff.contains(&old[..20]));
        // The hunk's eight lines and the key line git names in its header
        assert_eq!(f.hidden, 9, "{diff}");
        assert!(diff.contains(&format!("@@ {HIDDEN_CONTEXT}\n")), "{diff}");
        // A hunk near the end: from its start to the END line, the short last line included
        lines[29] = key_lines(32)[31].clone();
        lines[15] = old;
        write(&work, "id_rsa", &text(&lines));
        let diff = repo(&work).uncommitted.files[0].diff.clone().unwrap();
        assert!(!diff.contains("AAAB3==") && !diff.contains(&lines[29][..20]), "{diff}");
    }

    #[test]
    fn hex_digests_and_ordinary_lines_beside_them_stay_shown() {
        let chunk = "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n name\n-0123456789abcdef0123456789abcdef01234567\n+89abcdef0123456789abcdef0123456789abcdef\n";
        let (out, hidden) = hide(chunk);
        assert_eq!((out.as_str(), hidden), (chunk, 0));
        // An END line with its BEGIN before the hunk hides the hunk up to it, and nothing after
        let chunk = "diff --git a/k b/k\n@@ -3,3 +3,3 @@\n-abc\n+abd\n -----END EC PRIVATE KEY-----\n+after\n";
        let (out, hidden) = hide(chunk);
        assert_eq!(hidden, 3);
        assert!(out.ends_with("+after\n") && !out.contains("abd"), "{out}");
    }

    #[test]
    fn a_count_error_names_no_ref() {
        let (tmp, work) = clone();
        let origin = tmp.path().join("origin");
        let t = token();
        git(&origin, &["branch", &t]);
        git(&work, &["fetch", "-q"]);
        git(&work, &["checkout", "-qb", &t, "--track", &format!("origin/{t}")]);
        git(&work, &["symbolic-ref", "refs/remotes/origin/HEAD", &format!("refs/remotes/origin/{t}")]);
        // The base's count, then the upstream's, refused and then cut at its limit
        for (nth, answer) in [(0, None), (1, None), (0, Some(true)), (1, Some(true))] {
            let calls = std::cell::Cell::new(0);
            let failing = Hooked {
                instead: |args: &[String]| {
                    if !args.iter().any(|a| a == "--left-right") {
                        return None;
                    }
                    calls.set(calls.get() + 1);
                    (calls.get() - 1 == nth).then(|| Ok(answer.map(|truncated| Out { stdout: vec![], truncated })))
                },
                after: |_: &[String]| {},
            };
            let e = read(&failing, &work).unwrap_err();
            assert!(!e.contains(&t), "{e}");
            assert!(e.contains(if nth == 0 { "the base" } else { "the upstream" }), "{e}");
        }
    }

    #[test]
    fn an_indented_key_body_is_hidden_too() {
        let (_tmp, work) = clone();
        let mut lines = vec!["service:".to_string(), "  key: |".to_string()];
        lines.extend(key_lines(30).into_iter().map(|l| format!("    {l}")));
        lines.push("  name: demo".into());
        let text = |l: &[String]| l.iter().map(|l| format!("{l}\n")).collect::<String>();
        write(&work, "config.yaml", &text(&lines));
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "config"]);
        lines[16] = format!("\t{}", key_lines(31)[30]);
        write(&work, "config.yaml", &text(&lines));
        let r = repo(&work);
        let diff = r.uncommitted.files[0].diff.as_deref().unwrap();
        assert!(!diff.contains("PRIVATE KEY"), "the fixture's hunk holds a delimiter: {diff}");
        for l in &lines[2..32] {
            assert!(!diff.contains(&l.trim()[..20]), "a key line is shown: {diff}");
        }
        // The mark of each hidden line stays
        assert!(diff.contains(&format!("-{HIDDEN}")) && diff.contains(&format!("+{HIDDEN}")), "{diff}");
    }

    #[test]
    fn an_edit_put_back_while_the_pane_reads_is_no_staged_change() {
        let (_tmp, work) = clone();
        write(&work, "a.txt", "one\ntwo\nthree\nedited\n");
        // Status sees the edit; then the editor puts the file back, nothing staged at any time
        let reverting = Hooked {
            instead: |_: &[String]| None,
            after: |args: &[String]| {
                if args.iter().any(|a| a == "--untracked-files=no") {
                    write(&work, "a.txt", "one\ntwo\nthree\n");
                }
            },
        };
        let r = read(&reverting, &work).unwrap().repo.unwrap();
        assert!(r.uncommitted.files.is_empty(), "{:?}", r.uncommitted.files.iter().map(|f| (&f.path, f.staged, f.undone)).collect::<Vec<_>>());
    }

    #[test]
    fn the_upstream_count_is_of_the_ref_it_names() {
        let (_tmp, work) = clone();
        git(&work, &["checkout", "-qb", "feature"]);
        write(&work, "f.txt", "f\n");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "feature"]);
        // origin/captured is the head itself; origin/main is one behind it
        git(&work, &["update-ref", "refs/remotes/origin/captured", "HEAD"]);
        git(&work, &["branch", "--set-upstream-to=origin/captured"]);
        let switched = std::cell::Cell::new(false);
        // The tracking setting changes right after the upstream was asked
        let racing = Hooked {
            instead: |_: &[String]| None,
            after: |args: &[String]| {
                if !switched.get() && args.iter().any(|a| a == "@{upstream}") {
                    switched.set(true);
                    git(&work, &["branch", "--set-upstream-to=origin/main"]);
                }
            },
        };
        let r = read(&racing, &work).unwrap().repo.unwrap();
        assert!(switched.get());
        let up = r.upstream.unwrap();
        assert_eq!((up.name.as_str(), up.ahead, up.behind), ("origin/captured", 0, 0));
    }
}
