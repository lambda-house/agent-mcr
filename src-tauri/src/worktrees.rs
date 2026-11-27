//! The harness creates linked worktrees and only removes ones it can identify as its own.

use crate::git;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};

const OWNER_FILE: &str = "agent-mcr-owner";
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Request {
    Branch(Branch),
    Scratch(Scratch),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Branch {
    repo: PathBuf,
    branch: String,
    base: String,
    #[serde(default)]
    disposable: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scratch {
    repo: PathBuf,
    commit: String,
    #[serde(default)]
    disposable: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Managed {
    pub path: PathBuf,
    repo: PathBuf,
    admin: PathBuf,
    owner: String,
    checkout: Checkout,
    /// Relative paths below the worktree whose ignored files may go with it,
    /// besides any `target`, `node_modules` or `dist` folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    disposable: Vec<String>,
}

const MAX_DISPOSABLE: usize = 32;

/// Exact relative paths under the worktree root, written with `/`: no
/// absolute path, drive, backslash, empty, `.` or `..` part, and no `.git`.
fn disposable_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > MAX_DISPOSABLE {
        return Err(format!("worktree.disposable takes at most {MAX_DISPOSABLE} paths"));
    }
    paths
        .iter()
        .map(|path| {
            let fine = !path.is_empty()
                && path.len() <= 256
                && !path.chars().any(|c| c.is_control() || c == '\\' || c == ':')
                && path
                    .split('/')
                    .all(|part| !matches!(part, "" | "." | ".." | ".git"));
            if fine {
                Ok(path.clone())
            } else {
                Err(format!("worktree.disposable: {path:?} must be a relative path below the worktree, with / between names and no empty, ., .. or .git part"))
            }
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum Checkout {
    Branch { branch: String, base: String },
    Scratch { commit: String },
}

pub fn lenient<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Managed>, D::Error> {
    Ok(serde_json::Value::deserialize(d)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok()))
}

/// After launch fails before spawning, try to undo the checkout, provided it
/// still contains exactly the starting commit and has no changes.
pub struct Pending {
    managed: Option<Managed>,
    head: String,
}

impl Pending {
    pub fn worktree(&self) -> &Managed {
        self.managed.as_ref().expect("pending worktree")
    }

    pub fn keep(mut self) -> Managed {
        self.managed.take().expect("pending worktree")
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(tree) = self.managed.take() {
            let deadline = Instant::now() + Duration::from_secs(3);
            if let Err(reason) = tree.remove(deadline, Some(&self.head)) {
                eprintln!(
                    "Could not roll back worktree {}: {reason}",
                    tree.path.display()
                );
            }
        }
    }
}

pub fn create(
    request: Request,
    track: Option<&Path>,
    within: Option<&Path>,
    home: &Path,
    owner: &str,
) -> Result<Pending, String> {
    let (repo, disposable) = match &request {
        Request::Branch(branch) => (&branch.repo, &branch.disposable),
        Request::Scratch(scratch) => (&scratch.repo, &scratch.disposable),
    };
    let disposable = disposable_paths(disposable)?;
    if !repo.is_absolute() {
        return Err("worktree.repo must be an absolute path".into());
    }
    let repo = canonical(repo)?;
    let allowed = |path: &Path| {
        if let Some(within) = within {
            if !path.starts_with(within)
                || (path != within && crate::agent::guarded(path, Some(home)))
            {
                return Err(format!(
                    "Refused: Git worktrees must stay in your folder ({}) or below it",
                    within.display()
                ));
            }
        }
        Ok(())
    };
    allowed(&repo)?;
    let deadline = Instant::now() + Duration::from_secs(8);
    if git_path(&repo, "--show-toplevel", deadline)? != repo {
        return Err("worktree.repo must be the root of a Git checkout".into());
    }
    let common = git_path(&repo, "--git-common-dir", deadline)?;
    allowed(&common)?;
    let track = match track {
        Some(track) => canonical(track)?,
        None => common
            .parent()
            .filter(|_| common.file_name() == Some(OsStr::new(".git")))
            .unwrap_or(&repo)
            .parent()
            .ok_or("The repository has no parent folder for worktrees")?
            .to_path_buf(),
    };
    allowed(&track)?;
    let root = track.join("wt");
    allowed(&root)?;
    if root.starts_with(&common) {
        return Err("The worktree folder must be outside Git metadata".into());
    }
    let (checkout, name, add, start) = match request {
        Request::Branch(Branch { branch, base, .. }) => {
            let name = branch_folder(&repo, &branch, deadline)?;
            let full = format!("refs/heads/{branch}");
            let base_head = commit(&repo, &base, deadline)?;
            let base_ref = checked(
                &repo,
                &[
                    "rev-parse",
                    "--symbolic-full-name",
                    "--verify",
                    "--end-of-options",
                    &base,
                ],
                deadline,
            )?;
            let base = match line(&base_ref.stdout)? {
                r if r == full => return Err("The worktree branch cannot also be its base".into()),
                r if r.starts_with("refs/heads/") || r.starts_with("refs/remotes/") => r.to_owned(),
                _ => base_head.clone(),
            };
            let exists = run(&repo, &["show-ref", "--verify", "--quiet", &full], deadline)?;
            let (add, start) = match exists.status.code() {
                Some(0) => (
                    Add::Existing(branch.clone()),
                    commit(&repo, &full, deadline)?,
                ),
                Some(1) => (Add::Branch(branch.clone()), base_head),
                _ => return Err(failure(&exists)),
            };
            (Checkout::Branch { branch, base }, name, add, start)
        }
        Request::Scratch(Scratch {
            commit: revision, ..
        }) => {
            let head = commit(&repo, &revision, deadline)?;
            (
                Checkout::Scratch {
                    commit: head.clone(),
                },
                format!("scratch-{owner}"),
                Add::Scratch,
                head,
            )
        }
    };
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("Cannot create {}: {e}", root.display())),
    }
    if !fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) || canonical(&root)? != root {
        return Err(format!(
            "Worktree directory {} must be a real directory",
            root.display()
        ));
    }

    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        _ => {
            return Err(format!(
                "Worktree path already exists or cannot be checked: {}",
                path.display()
            ))
        }
    }
    let operand = path.as_os_str();
    let add_args: Vec<&OsStr> = match &add {
        Add::Existing(branch) | Add::Branch(branch) => vec![
            "worktree".as_ref(),
            "add".as_ref(),
            "--no-checkout".as_ref(),
            "--no-guess-remote".as_ref(),
            "--".as_ref(),
            operand,
            branch.as_ref(),
        ],
        Add::Scratch => vec![
            "worktree".as_ref(),
            "add".as_ref(),
            "--no-checkout".as_ref(),
            "--detach".as_ref(),
            "--".as_ref(),
            operand,
            start.as_ref(),
        ],
    };
    let result = (|| -> Result<Pending, String> {
        if let Add::Branch(branch) = &add {
            // `worktree add -b` would run `git branch` as a child, which the
            // runner's Git may not start. As with -b, the branch stays when
            // the worktree cannot be added.
            checked(
                &repo,
                &["branch", "--no-track", "--", branch.as_str(), start.as_str()],
                deadline,
            )?;
        }
        checked(&repo, &add_args, deadline)?;
        let admin = git_path(&path, "--absolute-git-dir", deadline)?;
        if git_path(&path, "--git-common-dir", deadline)? != common
            || admin.parent() != Some(common.join("worktrees").as_path())
        {
            return Err("Git did not create a linked worktree for this repository".into());
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(admin.join(OWNER_FILE))
            .and_then(|mut f| f.write_all(owner.as_bytes()))
            .map_err(|e| format!("Cannot record worktree ownership: {e}"))?;
        let pending = Pending {
            managed: Some(Managed {
                path: path.clone(),
                repo,
                admin,
                owner: owner.to_owned(),
                checkout,
                disposable,
            }),
            head: start.clone(),
        };
        pending.worktree().check_checkout(deadline)?;
        // Read filter settings from the new checkout, where onbranch and gitdir
        // includes can differ from the source. Checkout-index never overwrites
        // files that have appeared since the worktree was reserved.
        checked(&path, &["read-tree", "HEAD"], deadline)?;
        checked(&path, &["checkout-index", "--all", "--index"], deadline)?;
        Ok(pending)
    })();
    result.map_err(|reason| format!("Cannot prepare worktree {}: {reason}", path.display()))
}

enum Add {
    Existing(String),
    Branch(String),
    Scratch,
}

fn branch_folder(repo: &Path, branch: &str, deadline: Instant) -> Result<String, String> {
    if branch.is_empty() || branch.starts_with('-') || branch == "HEAD" || branch.len() > 200 {
        return Err("Invalid worktree branch name".into());
    }
    let full = format!("refs/heads/{branch}");
    if !run(repo, &["check-ref-format", &full], deadline)?
        .status
        .success()
    {
        return Err("Invalid worktree branch name".into());
    }
    let mut folder = String::new();
    for byte in branch.bytes() {
        if byte.is_ascii_alphanumeric() || b".-_".contains(&byte) {
            folder.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(folder, "%{byte:02X}").unwrap();
        }
    }
    if folder.len() > 200 {
        return Err("Worktree branch name is too long for a folder".into());
    }
    Ok(folder)
}

impl Managed {
    pub fn cleanup(&self, deadline: Instant) -> Result<u64, String> {
        self.remove(deadline, None)
    }

    fn remove(&self, deadline: Instant, rollback_head: Option<&str>) -> Result<u64, String> {
        self.verify_owner(deadline)?;
        let head = self.check_checkout(deadline)?;
        if let Some(original) = rollback_head {
            if original != head {
                return Err("the checkout moved after creation".into());
            }
        } else if let Checkout::Branch { branch, base } = &self.checkout {
            let remote = format!("refs/remotes/origin/{branch}");
            if !contains(&self.path, &remote, &head, deadline)?
                && !contains(&self.path, base, &head, deadline)?
            {
                return Err(format!("branch {branch} has an unpushed or unmerged HEAD (checked local {remote} and base {base})"));
            }
        }
        self.check_clean(deadline)?;
        // Ignore rules often cover local configuration as well as build output.
        // Only the generated directories named here, and the paths the request
        // named as disposable, may go away with the checkout.
        let ignored = checked(
            &self.path,
            &[
                "ls-files",
                "-o",
                "-i",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
            deadline,
        )?;
        let outside = |path: &[u8]| {
            let directory = path
                .iter()
                .rposition(|b| *b == b'/')
                .map_or(&b""[..], |last| &path[..last]);
            let entry = path.strip_suffix(b"/").unwrap_or(path);
            let disposable = self.disposable.iter().any(|d| {
                entry.strip_prefix(d.as_bytes()).is_some_and(|rest| rest.is_empty() || rest.starts_with(b"/"))
            });
            !disposable
                && !directory
                    .split(|b| *b == b'/')
                    .any(|part| matches!(part, b"target" | b"node_modules" | b"dist"))
        };
        let mut stray = false;
        let mut parents = Vec::new();
        for path in ignored.stdout.split(|b| *b == 0).filter(|path| !path.is_empty()) {
            if !outside(path) {
                continue;
            }
            // Git names a directory alone when everything in it is ignored, also
            // when only a deeper path in it is disposable: look inside such a one.
            let entry = path.strip_suffix(b"/").unwrap_or(path);
            let parent = path.ends_with(b"/").then(|| {
                self.disposable.iter().find(|d| {
                    d.as_bytes()
                        .strip_prefix(entry)
                        .is_some_and(|rest| rest.starts_with(b"/"))
                })
            });
            match parent.flatten() {
                Some(d) => parents.push(d[..entry.len()].to_string()),
                None => {
                    stray = true;
                    break;
                }
            }
        }
        for parent in &parents {
            if stray {
                break;
            }
            let mut args = vec![
                "ls-files".to_string(),
                "-o".into(),
                "-i".into(),
                "--exclude-standard".into(),
                "-z".into(),
                "--".into(),
                format!(":(literal){parent}/"),
            ];
            // Excluding the disposable paths only keeps the listing short: every
            // file listed still goes through `outside`.
            args.extend(
                self.disposable
                    .iter()
                    .filter(|d| d.starts_with(&format!("{parent}/")))
                    .map(|d| format!(":(exclude,literal){d}")),
            );
            let inside = checked(&self.path, &args, deadline)?;
            stray = inside
                .stdout
                .split(|b| *b == 0)
                .filter(|path| !path.is_empty())
                .any(outside);
        }
        if stray {
            return Err(if self.disposable.is_empty() {
                "the worktree has ignored files outside target, node_modules, or dist (name generated paths in worktree.disposable)".into()
            } else {
                "the worktree has ignored files outside target, node_modules, dist and its disposable paths".into()
            });
        }
        let index = checked(&self.path, &["ls-files", "-v", "-z"], deadline)?;
        if index
            .stdout
            .split(|b| *b == 0)
            .filter_map(|entry| entry.first())
            .any(|tag| tag.is_ascii_lowercase() || *tag == b'S')
        {
            return Err("the worktree index hides tracked files from the status check".into());
        }
        let bytes = disk_bytes(&self.path, deadline)?;
        self.verify_owner(deadline)?;
        // Without --force, `worktree remove` checks the contents with `git
        // status` as a child, which the runner's Git may not start. So the same
        // check runs here, last before the removal, under the runner's guards.
        // One --force still refuses a locked worktree; never pass it twice.
        self.check_clean(deadline)?;
        // Run it from the main checkout: Windows does not delete a process's
        // current directory. The worktree's own scoped filter settings are disabled too.
        let removed = git::run_from(
            &self.repo,
            &[&self.path, &self.repo],
            &[
                "worktree".as_ref(),
                "remove".as_ref(),
                "--force".as_ref(),
                "--".as_ref(),
                self.path.as_os_str(),
            ],
            deadline.saturating_duration_since(Instant::now()),
            OUTPUT_LIMIT,
        )
        .map_err(|e| e.to_string())?;
        if !removed.status.success() {
            return Err(failure(&removed));
        }
        Ok(bytes)
    }

    fn check_clean(&self, deadline: Instant) -> Result<(), String> {
        let status = checked(
            &self.path,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            deadline,
        )?;
        if !status.stdout.is_empty() {
            return Err("the worktree has uncommitted or untracked changes".into());
        }
        Ok(())
    }

    fn check_checkout(&self, deadline: Instant) -> Result<String, String> {
        let head = commit(&self.path, "HEAD", deadline)?;
        let symbolic = run(&self.path, &["symbolic-ref", "-q", "HEAD"], deadline)?;
        match &self.checkout {
            Checkout::Branch { branch, .. }
                if symbolic.status.success()
                    && line(&symbolic.stdout)? == format!("refs/heads/{branch}") =>
            {
                Ok(head)
            }
            Checkout::Scratch { commit }
                if symbolic.status.code() == Some(1) && *commit == head =>
            {
                Ok(head)
            }
            _ => Err("the worktree branch or detached commit changed".into()),
        }
    }

    fn verify_owner(&self, deadline: Instant) -> Result<(), String> {
        let missing = || "the path is no longer the harness-owned worktree".to_string();
        if canonical(&self.path)? != self.path
            || !fs::symlink_metadata(self.path.join(".git")).is_ok_and(|m| m.is_file())
            || git_path(&self.path, "--absolute-git-dir", deadline)? != self.admin
            || git_path(&self.path, "--show-toplevel", deadline)? != self.path
            || git_path(&self.path, "--git-common-dir", deadline)?
                != git_path(&self.repo, "--git-common-dir", deadline)?
        {
            return Err(missing());
        }
        let marker = self.admin.join(OWNER_FILE);
        if !fs::symlink_metadata(&marker)
            .is_ok_and(|m| m.is_file() && m.len() == self.owner.len() as u64)
            || fs::read(&marker).ok().as_deref() != Some(self.owner.as_bytes())
        {
            return Err(missing());
        }
        Ok(())
    }
}

fn contains(repo: &Path, reference: &str, head: &str, deadline: Instant) -> Result<bool, String> {
    let out = run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
        deadline,
    )?;
    if out.status.code() == Some(1) {
        return Ok(false);
    }
    if !out.status.success() {
        return Err(failure(&out));
    }
    let tip = object_id(&out.stdout)?;
    let relation = run(repo, &["merge-base", "--is-ancestor", head, &tip], deadline)?;
    match relation.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(failure(&relation)),
    }
}

fn commit(repo: &Path, revision: &str, deadline: Instant) -> Result<String, String> {
    if revision.is_empty()
        || revision.starts_with('-')
        || revision.len() > 1024
        || revision.chars().any(char::is_control)
    {
        return Err("Invalid worktree revision".into());
    }
    let out = checked(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
        deadline,
    )?;
    object_id(&out.stdout)
}

fn object_id(bytes: &[u8]) -> Result<String, String> {
    let id = line(bytes)?;
    if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Git did not return a commit id".into());
    }
    Ok(id.to_owned())
}

fn line(bytes: &[u8]) -> Result<&str, String> {
    let value = std::str::from_utf8(bytes).map_err(|_| "Git returned non-UTF-8 text")?;
    Ok(value.trim_end_matches(['\r', '\n']))
}

fn git_path(cwd: &Path, flag: &str, deadline: Instant) -> Result<PathBuf, String> {
    let out = checked(
        cwd,
        &["rev-parse", "--path-format=absolute", flag],
        deadline,
    )?;
    let path = Path::new(line(&out.stdout)?);
    if !path.is_absolute() {
        return Err("Git did not return an absolute path".into());
    }
    canonical(path)
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn run(repo: &Path, args: &[impl AsRef<OsStr>], deadline: Instant) -> Result<Output, String> {
    git::run(
        repo,
        args,
        deadline.saturating_duration_since(Instant::now()),
        OUTPUT_LIMIT,
    )
    .map_err(|e| e.to_string())
}

fn checked(repo: &Path, args: &[impl AsRef<OsStr>], deadline: Instant) -> Result<Output, String> {
    let out = run(repo, args, deadline)?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(failure(&out))
    }
}

fn failure(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let why = stderr
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect::<String>();
    if why.is_empty() {
        format!("Git failed ({})", out.status)
    } else {
        format!("Git: {why}")
    }
}

fn disk_bytes(path: &Path, deadline: Instant) -> Result<u64, String> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(unix)]
    let device = fs::symlink_metadata(path).map_err(|e| e.to_string())?.dev();
    let mut dirs = vec![fs::read_dir(path).map_err(|e| e.to_string())?];
    let mut total = 0u64;
    while let Some(dir) = dirs.last_mut() {
        let Some(entry) = dir.next() else {
            dirs.pop();
            continue;
        };
        if Instant::now() >= deadline {
            return Err("timed out measuring worktree size".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" && entry.path().parent() != Some(path) {
            return Err("the worktree contains a nested Git checkout".into());
        }
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        // Git lists no named pipe, socket or device, so neither its status nor
        // its list of ignored files can vouch for one: keep the checkout.
        let kind = meta.file_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            #[cfg(unix)]
            let what = {
                use std::os::unix::fs::FileTypeExt;
                if kind.is_fifo() {
                    "a named pipe"
                } else if kind.is_socket() {
                    "a socket"
                } else if kind.is_block_device() {
                    "a block device"
                } else if kind.is_char_device() {
                    "a character device"
                } else {
                    "a special file"
                }
            };
            #[cfg(not(unix))]
            let what = "a special file";
            return Err(format!("the worktree contains {what}"));
        }
        #[cfg(unix)]
        if meta.dev() != device {
            return Err("the worktree contains a mounted filesystem".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if meta.is_dir() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err("the worktree contains a directory reparse point".into());
            }
        }
        #[cfg(unix)]
        let size = if meta.is_dir() || meta.nlink() == 1 {
            meta.blocks().saturating_mul(512)
        } else {
            0
        };
        #[cfg(not(unix))]
        let size = meta.len();
        total = total.saturating_add(size);
        if meta.is_dir() {
            dirs.push(fs::read_dir(entry.path()).map_err(|e| e.to_string())?);
        }
    }
    Ok(total)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::{json, Value};

    pub fn git(cwd: &Path, args: &[&str]) -> String {
        let out = checked(cwd, args, deadline()).unwrap();
        line(&out.stdout).unwrap().to_owned()
    }

    pub fn init(repo: &Path) -> String {
        fs::create_dir_all(repo).unwrap();
        git(repo, &["init", "--initial-branch=main", "-q"]);
        git(repo, &["config", "--local", "user.name", "Agent MCR Test"]);
        git(
            repo,
            &["config", "--local", "user.email", "test@example.invalid"],
        );
        git(repo, &["config", "--local", "commit.gpgSign", "false"]);
        fs::write(
            repo.join(".gitignore"),
            "target/\nnode_modules/\ndist/\n.env\nsrc-tauri/gen/schemas/\n",
        )
        .unwrap();
        fs::write(repo.join("tracked"), "original").unwrap();
        git(repo, &["add", "--", ".gitignore", "tracked"]);
        git(repo, &["commit", "-qm", "initial"]);
        git(repo, &["rev-parse", "HEAD"])
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    /// The folders `worktree remove` ran in on this thread so far. Windows
    /// cannot delete a process's current directory, so it must not run inside
    /// the worktree it removes.
    fn removed_from() -> Vec<PathBuf> {
        git::tests::RAN.with(|ran| {
            ran.borrow()
                .iter()
                .filter(|(_, args)| args.len() > 1 && args[0] == "worktree" && args[1] == "remove")
                .map(|(cwd, _)| cwd.clone())
                .collect()
        })
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = canonical(root.path()).unwrap().join("repo space");
        init(&repo);
        (root, repo)
    }

    fn make(repo: &Path, request: Value) -> Pending {
        let track = repo.parent().unwrap();
        create(
            serde_json::from_value(request).unwrap(),
            None,
            Some(track),
            track,
            "test",
        )
        .unwrap()
    }

    #[test]
    fn creates_branch_at_base_and_removes_build_output_after_base_merges() {
        let (_root, repo) = fixture();
        let managed = make(
            &repo,
            json!({"repo": repo, "branch": "feature/one", "base": "main"}),
        )
        .keep();
        assert_eq!(
            managed.path,
            repo.parent().unwrap().join("wt/feature%2Fone")
        );
        assert_eq!(
            git(&managed.path, &["symbolic-ref", "HEAD"]),
            "refs/heads/feature/one"
        );
        assert_eq!(
            git(&managed.path, &["rev-parse", "HEAD"]),
            git(&repo, &["rev-parse", "main"])
        );
        fs::write(managed.path.join("tracked"), "next change").unwrap();
        git(&managed.path, &["commit", "-qam", "work"]);
        git(&repo, &["merge", "--ff-only", "feature/one"]);
        fs::create_dir(managed.path.join("target")).unwrap();
        fs::write(managed.path.join("target/object"), vec![1; 32 * 1024]).unwrap();
        let bytes = managed.cleanup(deadline()).unwrap();
        assert!(bytes >= 32 * 1024);
        assert!(!managed.path.exists());
        assert_eq!(removed_from(), std::slice::from_ref(&repo));
        assert!(repo.join("tracked").exists());
        assert!(!git(&repo, &["rev-parse", "--verify", "refs/heads/feature/one"]).is_empty());
    }

    #[test]
    fn ignored_files_under_a_disposable_path_go_with_the_checkout() {
        let (_root, repo) = fixture();
        // As in agent-mcr: src-tauri is tracked, its gen/schemas ignored
        fs::create_dir(repo.join("src-tauri")).unwrap();
        fs::write(repo.join("src-tauri/build.rs"), "fn main() {}").unwrap();
        git(&repo, &["add", "--", "src-tauri/build.rs"]);
        git(&repo, &["commit", "-qm", "src-tauri"]);
        let generated = |path: &Path| {
            fs::create_dir_all(path.join("src-tauri/gen/schemas")).unwrap();
            fs::write(path.join("src-tauri/gen/schemas/acl.json"), "{}").unwrap();
        };
        let kept = make(&repo, json!({"repo": repo, "branch": "kept", "base": "main"})).keep();
        generated(&kept.path);
        assert!(kept.cleanup(deadline()).unwrap_err().contains("worktree.disposable"));
        assert!(kept.path.join("src-tauri/gen/schemas/acl.json").is_file());
        let listed = make(
            &repo,
            json!({"repo": repo, "branch": "listed", "base": "main", "disposable": ["src-tauri/gen"]}),
        )
        .keep();
        generated(&listed.path);
        // A name that only starts like a disposable path is not below it
        fs::create_dir_all(listed.path.join("src-tauri/generated")).unwrap();
        fs::write(listed.path.join("src-tauri/generated/.env"), "secret").unwrap();
        assert!(listed.cleanup(deadline()).unwrap_err().contains("disposable paths"));
        fs::remove_dir_all(listed.path.join("src-tauri/generated")).unwrap();
        listed.cleanup(deadline()).unwrap();
        assert!(!listed.path.exists());
        // The record keeps the list across a store round trip
        let stored: Managed = serde_json::from_value(serde_json::to_value(&kept).unwrap()).unwrap();
        assert!(stored.disposable.is_empty());
    }

    #[test]
    fn a_parent_git_names_for_a_deeper_disposable_path_is_looked_into() {
        let (_root, repo) = fixture();
        // Only src-tauri/gen/schemas is disposable, but Git names src-tauri/gen/
        // when everything in it is ignored
        fs::create_dir(repo.join("src-tauri")).unwrap();
        fs::write(repo.join("src-tauri/build.rs"), "fn main() {}").unwrap();
        let mut ignore = fs::read_to_string(repo.join(".gitignore")).unwrap();
        ignore.push_str("src-tauri/gen/other.json\n");
        fs::write(repo.join(".gitignore"), ignore).unwrap();
        git(&repo, &["add", "--", ".gitignore", "src-tauri/build.rs"]);
        git(&repo, &["commit", "-qm", "src-tauri"]);
        let request = |branch: &str| {
            json!({"repo": repo, "branch": branch, "base": "main", "disposable": ["src-tauri/gen/schemas"]})
        };
        let generated = |path: &Path| {
            fs::create_dir_all(path.join("src-tauri/gen/schemas")).unwrap();
            fs::write(path.join("src-tauri/gen/schemas/acl.json"), "{}").unwrap();
        };
        let removed = make(&repo, request("removed")).keep();
        generated(&removed.path);
        removed.cleanup(deadline()).unwrap();
        assert!(!removed.path.exists());
        // An ignored sibling of the disposable path keeps the checkout
        let kept = make(&repo, request("kept")).keep();
        generated(&kept.path);
        fs::write(kept.path.join("src-tauri/gen/other.json"), "{}").unwrap();
        assert!(kept.cleanup(deadline()).unwrap_err().contains("disposable paths"));
        assert!(kept.path.join("src-tauri/gen/other.json").is_file());
        assert!(kept.path.join("src-tauri/gen/schemas/acl.json").is_file());
    }

    #[cfg(unix)]
    fn fifo(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
    }

    #[cfg(unix)]
    #[test]
    fn an_ignored_named_pipe_beside_a_disposable_path_keeps_the_checkout() {
        let (_root, repo) = fixture();
        // Review 17412: Git lists no named pipe, so the walk must refuse it
        fs::create_dir(repo.join("src-tauri")).unwrap();
        fs::write(repo.join("src-tauri/build.rs"), "fn main() {}").unwrap();
        let mut ignore = fs::read_to_string(repo.join(".gitignore")).unwrap();
        ignore.push_str("*.log\n");
        fs::write(repo.join(".gitignore"), ignore).unwrap();
        git(&repo, &["add", "--", ".gitignore", "src-tauri/build.rs"]);
        git(&repo, &["commit", "-qm", "src-tauri"]);
        let kept = make(
            &repo,
            json!({"repo": repo, "branch": "kept", "base": "main", "disposable": ["src-tauri/gen/schemas"]}),
        )
        .keep();
        fs::create_dir_all(kept.path.join("src-tauri/gen/schemas")).unwrap();
        fs::write(kept.path.join("src-tauri/gen/schemas/acl.json"), "{}").unwrap();
        let pipe = kept.path.join("src-tauri/gen/ipc.log");
        fifo(&pipe);
        let error = kept.cleanup(deadline()).unwrap_err();
        assert!(error.contains("named pipe"), "{error}");
        assert!(fs::symlink_metadata(&pipe).is_ok());
        assert!(kept.path.join("src-tauri/gen/schemas/acl.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_named_pipe_in_build_output_keeps_the_checkout() {
        let (_root, repo) = fixture();
        let kept = make(&repo, json!({"repo": repo, "branch": "kept", "base": "main"})).keep();
        fs::create_dir(kept.path.join("target")).unwrap();
        fs::write(kept.path.join("target/object"), "built").unwrap();
        let pipe = kept.path.join("target/server.pipe");
        fifo(&pipe);
        let error = kept.cleanup(deadline()).unwrap_err();
        assert!(error.contains("named pipe"), "{error}");
        assert!(fs::symlink_metadata(&pipe).is_ok());
        assert!(kept.path.join("target/object").is_file());
    }

    #[test]
    fn refuses_disposable_paths_that_leave_the_worktree() {
        let (_root, repo) = fixture();
        for bad in ["", "/abs", "../up", "a/../b", "a//b", "./a", "a/", "a\\b", "C:/x", ".git", "a/.git/hooks"] {
            let request = serde_json::from_value(
                json!({"repo": repo, "branch": "feature", "base": "main", "disposable": [bad]}),
            )
            .unwrap();
            let track = repo.parent().unwrap();
            let error = create(request, None, Some(track), track, "test").err().unwrap();
            assert!(error.contains("worktree.disposable"), "{bad:?}: {error}");
        }
        assert!(serde_json::from_value::<Request>(
            json!({"repo": repo, "commit": "HEAD", "disposable": "src-tauri/gen"})
        )
        .is_err());
        assert!(!repo.parent().unwrap().join("wt").exists());
    }

    #[test]
    fn keeps_an_unpushed_head_until_local_origin_contains_it() {
        let (_root, repo) = fixture();
        let managed = make(
            &repo,
            json!({"repo": repo, "branch": "feature", "base": "main"}),
        )
        .keep();
        let previous = git(&managed.path, &["rev-parse", "HEAD"]);
        fs::write(managed.path.join("tracked"), "next change").unwrap();
        git(&managed.path, &["commit", "-qam", "work"]);
        let head = git(&managed.path, &["rev-parse", "HEAD"]);
        git(
            &repo,
            &["update-ref", "refs/remotes/origin/feature", &previous],
        );
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("unpushed"));
        assert!(managed.path.is_dir());
        git(&repo, &["update-ref", "refs/remotes/origin/feature", &head]);
        assert!(managed.cleanup(deadline()).is_ok());
        assert!(!managed.path.exists());
    }

    #[test]
    fn checks_out_existing_branch_and_keeps_local_changes_and_ignored_config() {
        let (_root, repo) = fixture();
        git(&repo, &["branch", "existing"]);
        let managed = make(
            &repo,
            json!({"repo": repo, "branch": "existing", "base": "main"}),
        )
        .keep();
        assert_eq!(
            git(&managed.path, &["symbolic-ref", "HEAD"]),
            "refs/heads/existing"
        );
        fs::write(managed.path.join("tracked"), "modified").unwrap();
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("uncommitted"));
        git(&managed.path, &["restore", "--", "tracked"]);
        fs::write(managed.path.join("untracked"), "new").unwrap();
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("untracked"));
        fs::remove_file(managed.path.join("untracked")).unwrap();
        fs::write(managed.path.join(".env"), "fixture").unwrap();
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("ignored files"));
        assert_eq!(fs::read(managed.path.join(".env")).unwrap(), b"fixture");
    }

    #[test]
    fn a_scratch_worktree_is_detached_at_the_requested_commit() {
        let (_root, repo) = fixture();
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let request = json!({"repo": repo, "commit": head});
        let pending = make(&repo, request.clone());
        let path = pending.worktree().path.clone();
        assert_eq!(git(&path, &["rev-parse", "HEAD"]), head);
        assert!(git(&path, &["branch", "--show-current"]).is_empty());
        drop(pending);
        assert!(
            !path.exists(),
            "a launch that never spawned rolls back its scratch checkout"
        );
        assert_eq!(removed_from(), std::slice::from_ref(&repo), "the rollback runs from the main checkout");
        let managed = make(&repo, request).keep();
        fs::write(managed.path.join("tracked"), "change").unwrap();
        git(&managed.path, &["commit", "-qam", "detached work"]);
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("commit changed"));
        assert!(managed.path.is_dir());
    }

    #[test]
    fn a_worktree_replaced_at_the_same_path_is_kept() {
        let (_root, repo) = fixture();
        let managed = make(
            &repo,
            json!({"repo": repo, "branch": "feature", "base": "main"}),
        )
        .keep();
        let path = managed.path.to_str().unwrap();
        // The runner's Git starts no child: no `git status` inside a plain
        // remove, no `git reset` inside a checkout.
        git(&repo, &["worktree", "remove", "--force", "--", path]);
        git(&repo, &["worktree", "add", "--no-checkout", "--", path, "feature"]);
        assert!(managed
            .cleanup(deadline())
            .unwrap_err()
            .contains("no longer the harness-owned worktree"));
        assert!(managed.path.exists());
    }

    #[test]
    fn refuses_ambiguous_requests_paths_outside_scope_and_option_operands() {
        let (_root, repo) = fixture();
        assert!(serde_json::from_value::<Request>(
            json!({"repo": repo, "branch": "feature", "base": "main", "commit": "HEAD"})
        )
        .is_err());
        let request =
            serde_json::from_value(json!({"repo": repo, "branch": "feature", "base": "main"}))
                .unwrap();
        let scope = repo.join("unrelated");
        assert!(create(request, None, Some(&scope), &scope, "test")
            .err()
            .unwrap()
            .contains("stay in your folder"));
        let request =
            serde_json::from_value(json!({"repo": repo, "branch": "--force", "base": "main"}))
                .unwrap();
        assert!(create(request, None, None, &scope, "test")
            .err()
            .unwrap()
            .contains("Invalid worktree branch"));
        assert!(!repo.parent().unwrap().join("wt").exists());
    }
}
