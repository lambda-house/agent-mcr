//! Run local Git operations with a deadline and a cap on each output stream.
//!
//! Most operations here only read: plumbing, `status`, `diff`, `log`. Their
//! Git may start no program at all (`Limit::Alone`): no filter driver,
//! textconv, external diff, gpg, fsmonitor, hook, alias or Git subcommand,
//! whatever the configuration says when Git reads it. So a driver written into
//! a shared `.git/config` or `info/attributes` after the guards below looked at
//! the configuration cannot run there (MCR-194).
//!
//! `worktree` and `checkout-index` (`UNCONFINED`) need Git's own children and
//! parallel-checkout workers, and run as on main: the `-c` and `GIT_CONFIG_*`
//! guards disable the filter drivers the configuration names when the guard
//! reads it. A driver configured between that read and Git's own can still run
//! for those operations, which the harness runs only at a session's start and
//! end (tracked on MCR-191).
//!
//! The system configuration is read as Git reads it (MCR-194: Git for Windows
//! keeps `core.autocrlf=true` there). Whoever can write it can replace Git
//! itself; the name scan sees it too, and the read-only operations start no
//! program it names.
//!
//! Known limit, failing closed: on Linux, with `core.ignorecase=true` and
//! 4,000 index entries or more, Git builds its name hash with worker threads,
//! which the process limit refuses, and a confined `status` fails (the
//! worktree is kept, the pane shows an error). Tracked on MCR-191.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum Error {
    OutputLimit { limit: usize },
    Other(io::Error),
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Other(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutputLimit { limit } => write!(f, "Git output exceeds {limit} bytes"),
            Self::Other(error) => write!(f, "Git: {error}"),
        }
    }
}

impl std::error::Error for Error {}

/// Operations that start Git's own children (`worktree add` runs `git branch`
/// and `update-ref`, `worktree remove` runs `git status`) or checkout workers.
/// They run without the process limit, with the name-scan guard only.
const UNCONFINED: [&str; 2] = ["worktree", "checkout-index"];

/// Linux counts threads against the process limit, and Git treats a failed
/// worker thread as fatal: preloading starts threads from 1,000 index
/// entries, index reading by the core count.
const ONE_THREAD: [&str; 4] = ["-c", "core.preloadIndex=false", "-c", "index.threads=1"];

/// Callers supply a fixed Git subcommand followed by its arguments. Place user
/// data in operands. Check the exit status before using the output.
///
/// The guards cover the subcommands used so far: plumbing (`rev-parse`,
/// `ls-files`, `show-ref`, `merge-base`, `config`, `read-tree`,
/// `checkout-index`, `symbolic-ref`, `check-ref-format`), `worktree`,
/// `status`, and `diff`, `show` and `log`, which also get `--no-ext-diff` and
/// `--no-textconv`. Formats must not use the `%G` signature placeholders, which
/// run the configured gpg program. `blame`, `grep --textconv` and
/// `cat-file --textconv` are not guarded: they would try to run a configured
/// textconv program. Add a guard here before calling them.
///
/// Every operation but `UNCONFINED` may start no child process: one that
/// needs a program, or a Git subcommand, fails.
pub fn run(
    cwd: &Path,
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    max_output: usize,
) -> Result<Output, Error> {
    run_from(cwd, &[cwd], args, timeout, max_output)
}

/// As `run`, with the filters configured in each folder of `config_from`
/// disabled. For an operation that reaches into another checkout from `cwd`,
/// such as `worktree remove`, which Windows cannot run from inside the folder
/// it deletes.
pub fn run_from(
    cwd: &Path,
    config_from: &[&Path],
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    max_output: usize,
) -> Result<Output, Error> {
    #[cfg(test)]
    tests::RAN.with(|ran| {
        ran.borrow_mut().push((
            cwd.to_path_buf(),
            args.iter().map(|a| a.as_ref().to_os_string()).collect(),
        ))
    });
    if !cwd.is_absolute() || config_from.iter().any(|dir| !dir.is_absolute()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "requires an absolute working directory",
        )
        .into());
    }
    let limit = match args.first() {
        Some(operation)
            if UNCONFINED
                .iter()
                .any(|name| operation.as_ref() == OsStr::new(name)) =>
        {
            Limit::None
        }
        _ => Limit::Alone,
    };
    // Even the guard's own config reads run alone.
    may_run_alone()?;
    let start = Instant::now();
    let left = || timeout.saturating_sub(start.elapsed());
    let mut command = local_command(cwd, left())?;
    if let Some((operation, operands)) = args.split_first() {
        // Worktree checkout and even status/diff can invoke configured filters.
        // Inspect only their names, and disable them before running the operation.
        let mut filters = BTreeSet::new();
        for dir in config_from {
            let mut config = local_command(dir, left())?;
            config.args([
                "config",
                "--name-only",
                "--null",
                "--get-regexp",
                "^filter\\.",
            ]);
            let found = capture(config, Limit::Alone, left(), 64 * 1024)?;
            match found.status.code() {
                Some(0) => {
                    let names = String::from_utf8(found.stdout).map_err(io::Error::other)?;
                    filters.extend(
                        names.split_terminator('\0').filter_map(|key| {
                            key.rsplit_once('.').map(|(name, _)| name.to_owned())
                        }),
                    );
                }
                Some(1) if found.stderr.is_empty() => {}
                _ => return Err(io::Error::other("cannot inspect Git filter configuration").into()),
            }
        }
        if !filters.is_empty() {
            // Keep keys and values separate. Git's -c syntax splits on
            // the first '=' even when it belongs to a filter driver name.
            let mut index = 0;
            for filter in filters {
                for (setting, value) in [
                    ("clean", ""),
                    ("smudge", ""),
                    ("process", ""),
                    ("required", "false"),
                ] {
                    command.env(
                        format!("GIT_CONFIG_KEY_{index}"),
                        format!("{filter}.{setting}"),
                    );
                    command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
                    index += 1;
                }
            }
            command.env("GIT_CONFIG_COUNT", index.to_string());
        }
        if limit == Limit::Alone {
            command.args(ONE_THREAD);
        }
        command.arg(operation);
        let operation = operation.as_ref();
        let shows_diff = ["diff", "show", "log"]
            .iter()
            .any(|name| operation == OsStr::new(name));
        if shows_diff {
            command.args(["--no-ext-diff", "--no-textconv"]);
        }
        if shows_diff || operation == OsStr::new("status") {
            // Gitlinks still show a commit difference. Their worktree contents
            // would require a separate config inspection in each submodule.
            command.arg("--ignore-submodules=dirty");
        }
        command.args(operands);
    }
    let remaining = left();
    if remaining.is_zero() {
        return Err(timed_out().into());
    }
    #[cfg(test)]
    if let Some(mut hook) = tests::BEFORE_RUN.with(|hook| hook.borrow_mut().take()) {
        hook()
    }
    capture(command, limit, remaining, max_output)
}

/// Refuses credentials the process limit may not bind. Linux exempts a real
/// user id 0 and the capabilities `CAP_SYS_ADMIN` and `CAP_SYS_RESOURCE`, and
/// capabilities belong to the thread: this reads the spawning thread's own
/// status and refuses any real, effective or saved user id 0 and any
/// permitted, effective or ambient capability. On Linux the child also gets
/// `no_new_privs`, so a file capability or set-user-id bit adds none.
#[cfg(unix)]
fn may_run_alone() -> io::Result<()> {
    let refuse = |what: &str| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refuses to run with {what}, where it cannot stop Git from starting programs"),
        ))
    };
    // SAFETY: getuid and geteuid have no preconditions.
    if unsafe { libc::getuid() == 0 || libc::geteuid() == 0 } {
        return refuse("user id 0");
    }
    #[cfg(target_os = "linux")]
    {
        // Run on the thread that spawns Git.
        let status = std::fs::read_to_string("/proc/thread-self/status")?;
        if privileged(&status) != Some(false) {
            return refuse("user id 0 or a Linux capability");
        }
    }
    Ok(())
}

#[cfg(windows)]
fn may_run_alone() -> io::Result<()> {
    Ok(())
}

/// Whether a Linux `/proc/.../status` shows a real, effective or saved user
/// id 0, or any permitted, effective or ambient capability. None when the
/// text does not say.
#[cfg(any(target_os = "linux", test))]
fn privileged(status: &str) -> Option<bool> {
    let field = |name: &str| status.lines().find_map(|line| line.strip_prefix(name));
    let ids = field("Uid:")?
        .split_whitespace()
        .take(3)
        .map(|id| id.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    if ids.len() != 3 {
        return None;
    }
    let mut capabilities = 0;
    for name in ["CapPrm:", "CapEff:", "CapAmb:"] {
        capabilities |= u64::from_str_radix(field(name)?.trim(), 16).ok()?;
    }
    Some(ids.contains(&0) || capabilities != 0)
}

fn local_command(cwd: &Path, timeout: Duration) -> io::Result<Command> {
    let no_hooks = if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    };
    let mut command = Command::new(executable(timeout)?);
    // Inherited Git variables can redirect an operation away from its working directory,
    // add configuration, or send traces to a file.
    strip_git_env(&mut command);
    #[cfg(test)]
    tests::CONFIG_FILES.with(|files| {
        for (name, path) in files.borrow().iter() {
            command.env(name, path);
        }
    });
    command
        .args([
            "--no-pager",
            "-c",
            no_hooks,
            "-c",
            "core.fsmonitor=false",
            "-c",
            "credential.helper=",
            "-c",
            "diff.external=",
            "-c",
            "status.submoduleSummary=false",
            "-c",
            "submodule.recurse=false",
            // A signed commit in log or show would run the configured gpg program.
            "-c",
            "log.showSignature=false",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .current_dir(cwd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

fn strip_git_env(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
}

#[cfg(unix)]
fn executable(_timeout: Duration) -> io::Result<PathBuf> {
    Ok(if Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git"
    } else {
        "git"
    }
    .into())
}

/// The Git program itself. `git.exe` on PATH is usually Git for Windows'
/// launcher (`cmd\git.exe`, `bin\git.exe`), which starts the real Git as a
/// child and so cannot run alone. A launcher found here anyway fails to start
/// Git: the operation fails, nothing runs.
#[cfg(windows)]
fn executable(timeout: Duration) -> io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::sync::Mutex;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    static FOUND: Mutex<Option<PathBuf>> = Mutex::new(None);
    if let Some(found) = FOUND.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok(found);
    }
    let mut ask = Command::new("git.exe");
    strip_git_env(&mut ask);
    ask.arg("--exec-path")
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW);
    let out = capture(ask, Limit::None, timeout, 4096)
        .map_err(|e| io::Error::other(format!("cannot find Git: {e}")))?;
    let exec = String::from_utf8(out.stdout).map_err(io::Error::other)?;
    let exec = PathBuf::from(exec.trim());
    if !out.status.success() || !exec.is_absolute() {
        return Err(io::Error::other("cannot find the Git program"));
    }
    // <prefix>\mingw64\libexec\git-core -> <prefix>\mingw64\bin\git.exe
    let found = exec
        .parent()
        .and_then(Path::parent)
        .map(|prefix| prefix.join("bin").join("git.exe"))
        .into_iter()
        .chain([exec.join("git.exe")])
        .find(|path| path.is_file())
        .ok_or_else(|| io::Error::other("cannot find the Git program"))?;
    *FOUND.lock().unwrap_or_else(|e| e.into_inner()) = Some(found.clone());
    Ok(found)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Limit {
    /// The process may start no other process.
    Alone,
    None,
}

#[cfg(unix)]
type Confinement = ();

#[cfg(unix)]
fn spawn(command: &mut Command, limit: Limit) -> io::Result<(Child, Confinement)> {
    if limit == Limit::Alone {
        use std::os::unix::process::CommandExt;
        // SAFETY: prctl and setrlimit are async-signal-safe and touch only
        // this child. With no process allowed for the user, every fork,
        // posix_spawn and (on Linux) thread of the child fails, also after it
        // has run Git. Exempt credentials are refused in `may_run_alone`.
        unsafe {
            command.pre_exec(|| {
                // No file capability or set-user-id bit takes effect at exec.
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                let none = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::setrlimit(libc::RLIMIT_NPROC, &none) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    Ok((command.spawn()?, ()))
}

#[cfg(windows)]
type Confinement = Option<Job>;

/// Starts the child suspended, puts it in a job that holds one process, then
/// lets it run: it cannot start another process at any time.
#[cfg(windows)]
fn spawn(command: &mut Command, limit: Limit) -> io::Result<(Child, Confinement)> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
    if limit == Limit::None {
        return Ok((command.spawn()?, None));
    }
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    match Job::confine(&child) {
        Ok(job) => Ok((child, Some(job))),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

#[cfg(windows)]
struct Handle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: an owned, open handle.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct Job(#[allow(dead_code)] Handle);

#[cfg(windows)]
impl Job {
    fn confine(child: &Child) -> io::Result<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: an anonymous job with default security.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Handle(job);
        // SAFETY: a plain C struct, valid when zeroed.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        // SAFETY: the pointer and size describe `limits`.
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are open; the child is suspended.
        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as _) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume(child.id())?;
        Ok(Job(job))
    }
}

#[cfg(windows)]
fn resume(pid: u32) -> io::Result<()> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: a snapshot of all threads, closed by `Handle`.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = Handle(snapshot);
    // SAFETY: a plain C struct, valid when zeroed; dwSize is set below.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    // SAFETY: `entry` is a THREADENTRY32 with its size set.
    let mut more = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: opens a thread of our own suspended child.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = Handle(thread);
            // SAFETY: an open thread handle with THREAD_SUSPEND_RESUME.
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        // SAFETY: as above.
        more = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(io::Error::other("cannot start the confined Git"));
    }
    Ok(())
}

fn capture(
    mut command: Command,
    limit: Limit,
    timeout: Duration,
    max_output: usize,
) -> Result<Output, Error> {
    let start = Instant::now();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Held until the child is reaped: on Windows, closing the job kills it.
    let (mut child, _confinement) = spawn(&mut command, limit)?;
    // Drain both pipes concurrently. Each reader keeps at most max_output + 1 bytes.
    let stdout = read_pipe(child.stdout.take().unwrap(), max_output);
    let stderr = read_pipe(child.stderr.take().unwrap(), max_output);
    let result = (|| {
        let (mut stdout, mut stderr) = (Some(stdout), Some(stderr));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        while stdout.is_some() || stderr.is_some() {
            if stdout.as_ref().is_some_and(thread::JoinHandle::is_finished) {
                out = stdout
                    .take()
                    .unwrap()
                    .join()
                    .map_err(|_| io::Error::other("stdout reader failed"))??;
            }
            if stderr.as_ref().is_some_and(thread::JoinHandle::is_finished) {
                err = stderr
                    .take()
                    .unwrap()
                    .join()
                    .map_err(|_| io::Error::other("stderr reader failed"))??;
            }
            if stdout.is_some() || stderr.is_some() {
                pause(start, timeout)?;
            }
        }
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(Output {
                    status,
                    stdout: out,
                    stderr: err,
                });
            }
            pause(start, timeout)?;
        }
    })();
    if result.is_err() {
        stop(&mut child);
    }
    result
}

fn read_pipe(
    pipe: impl Read + Send + 'static,
    limit: usize,
) -> thread::JoinHandle<Result<Vec<u8>, Error>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        pipe.take((limit as u64).saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(Error::OutputLimit { limit });
        }
        Ok(bytes)
    })
}

fn pause(start: Instant, timeout: Duration) -> io::Result<()> {
    let remaining = timeout.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return Err(timed_out());
    }
    thread::sleep(remaining.min(Duration::from_millis(5)));
    Ok(())
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "command timed out")
}

fn stop(child: &mut Child) {
    #[cfg(unix)]
    // Git can run child processes that inherit the output pipes.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
pub mod tests {
    use super::*;

    thread_local! {
        /// The folder and arguments of each run on this thread.
        pub static RAN: std::cell::RefCell<Vec<(std::path::PathBuf, Vec<std::ffi::OsString>)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    thread_local! {
        /// Runs once, after the guards read the configuration and before Git
        /// runs the operation.
        pub static BEFORE_RUN: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
        /// `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_GLOBAL` for the runner's Git
        /// on this thread, so a test does not read the person's own files.
        pub static CONFIG_FILES: std::cell::RefCell<Vec<(&'static str, std::path::PathBuf)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    const TIMEOUT: Duration = Duration::from_secs(5);

    /// Git as a person would run it, outside the runner, without the
    /// person's own global or system configuration.
    fn raw(cwd: &Path, args: &[&str]) -> Output {
        let mut command = Command::new("git");
        strip_git_env(&mut command);
        command
            .current_dir(cwd)
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .output()
            .unwrap()
    }

    fn ok(output: Output) -> String {
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    fn committed(repo: &Path, files: &[(&str, &str)]) {
        ok(run(repo, &["init", "-q"], TIMEOUT, 4096).unwrap());
        for (name, text) in files {
            std::fs::write(repo.join(name), text).unwrap();
            ok(run(repo, &["add", "--", name], TIMEOUT, 4096).unwrap());
        }
        ok(raw(
            repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "fixture",
            ],
        ));
    }

    /// Git as a person would run it with `system` as the system configuration.
    fn raw_system(cwd: &Path, system: &Path, args: &[&str]) -> Output {
        let mut command = Command::new("git");
        strip_git_env(&mut command);
        command
            .current_dir(cwd)
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_SYSTEM", system)
            .args(args)
            .output()
            .unwrap()
    }

    /// The runner's Git on this thread reads `system` as its system
    /// configuration and an empty global one.
    fn config_files(system: &Path, global: &Path) {
        CONFIG_FILES.with(|files| {
            *files.borrow_mut() = vec![
                ("GIT_CONFIG_SYSTEM", system.to_path_buf()),
                ("GIT_CONFIG_GLOBAL", global.to_path_buf()),
            ]
        })
    }

    /// A filter program that records its own start with shell builtins only,
    /// so no second program stands between its start and the record. Git
    /// runs it by this relative path from the top of the checkout. Returns
    /// the record's path.
    fn probe(repo: &Path) -> std::path::PathBuf {
        std::fs::write(
            repo.join(".git/probe"),
            "#!/bin/sh\necho entered >> .git/probe-ran\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                repo.join(".git/probe"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        repo.join(".git/probe-ran")
    }

    /// MCR-194: Git for Windows keeps `core.autocrlf=true` in its system
    /// configuration, which the runner used to switch off, so a clean CRLF
    /// checkout read as modified.
    #[test]
    fn a_crlf_checkout_reads_clean_under_a_system_autocrlf() {
        let fixture = tempfile::tempdir().unwrap();
        let dir = fixture.path();
        let system = dir.join("system.gitconfig");
        std::fs::write(&system, "[core]\n\tautocrlf = true\n").unwrap();
        let empty = dir.join("empty.gitconfig");
        std::fs::write(&empty, "").unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir(&repo).unwrap();
        config_files(&system, &empty);
        committed(&repo, &[("a.txt", "one\ntwo\n")]);
        // What a checkout under core.autocrlf=true writes.
        std::fs::write(repo.join("a.txt"), "one\r\ntwo\r\n").unwrap();
        let git = |args: &[&str]| run(&repo, args, TIMEOUT, 4096).unwrap();
        // Read-tree drops the index's file sizes, so Git compares contents.
        let status = || {
            ok(git(&["read-tree", "HEAD"]));
            ok(git(&["status", "--porcelain"]))
        };
        assert_eq!(status(), "");
        assert_eq!(ok(git(&["diff", "--numstat", "HEAD"])), "");
        // A later scope decides, as for Git itself.
        ok(git(&["config", "--local", "core.autocrlf", "false"]));
        assert_eq!(status(), " M a.txt\n");
        ok(git(&["config", "--local", "--unset", "core.autocrlf"]));
        assert_eq!(status(), "");
        // Without the system setting the clean checkout reads as modified.
        config_files(&empty, &empty);
        assert_eq!(status(), " M a.txt\n");
        CONFIG_FILES.with(|files| files.borrow_mut().clear());
    }

    /// The system configuration is read in full, so a filter it names must not
    /// run through the runner: neither one present when the guard looks nor
    /// one written there afterwards. Plain Git runs it.
    #[test]
    fn a_filter_named_only_in_the_system_file_does_not_run() {
        let fixture = tempfile::tempdir().unwrap();
        let dir = fixture.path();
        let system = dir.join("system.gitconfig");
        let empty = dir.join("empty.gitconfig");
        std::fs::write(&empty, "").unwrap();
        std::fs::write(&system, "").unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir(&repo).unwrap();
        config_files(&empty, &empty);
        committed(
            &repo,
            &[
                (".gitattributes", "file filter=sys\n"),
                ("file", "original\n"),
            ],
        );
        let marker = probe(&repo);
        let driver = "[filter \"sys\"]\n\tclean = .git/probe\n";
        config_files(&system, &empty);
        for late in [false, true] {
            std::fs::write(&system, if late { "" } else { driver }).unwrap();
            ok(run(&repo, &["read-tree", "HEAD"], TIMEOUT, 4096).unwrap());
            std::fs::write(repo.join("file"), "changed\n").unwrap();
            if late {
                let system = system.clone();
                BEFORE_RUN.with(|slot| {
                    *slot.borrow_mut() =
                        Some(Box::new(move || std::fs::write(&system, driver).unwrap()))
                });
            }
            let output = run(&repo, &["status", "--porcelain"], TIMEOUT, 4096).unwrap();
            assert!(BEFORE_RUN.with(|slot| slot.borrow().is_none()));
            assert!(
                !marker.exists(),
                "late {late}: the system filter ran: {output:?}"
            );
            assert_eq!(ok(output), " M file\n", "late {late}");
            // Plain Git with the same system file runs it.
            ok(raw(&repo, &["read-tree", "HEAD"]));
            std::fs::write(repo.join("file"), "changed\n").unwrap();
            let _ = raw_system(&repo, &system, &["status", "--porcelain"]);
            assert!(
                marker.exists(),
                "late {late}: plain Git should run the filter"
            );
            std::fs::remove_file(&marker).unwrap();
        }
        CONFIG_FILES.with(|files| files.borrow_mut().clear());
    }

    /// The runner's Git starts no program, whatever the configuration says:
    /// here a shell alias. The same alias runs under a plain Git. `worktree`
    /// still runs Git's own children.
    #[test]
    fn the_runners_git_starts_no_program_except_for_worktrees() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        committed(&repo, &[("a.txt", "one\n")]);
        let ran = |repo: &Path| raw(repo, &["config", "--get", "mcr.ran"]).status.success();
        ok(raw(
            &repo,
            &[
                "config",
                "--local",
                "alias.probe",
                "!git config --local mcr.ran yes",
            ],
        ));
        ok(raw(&repo, &["probe"]));
        assert!(ran(&repo), "the alias should run under a plain Git");
        ok(raw(&repo, &["config", "--local", "--unset", "mcr.ran"]));
        let output = run(&repo, &["probe"], TIMEOUT, 4096).unwrap();
        assert!(!output.status.success(), "{output:?}");
        assert!(!ran(&repo), "the alias ran under the runner");
        // `worktree add -b` runs `git branch`, `worktree remove` runs `git status`.
        let tree = fixture.path().join("tree");
        let tree = tree.to_str().unwrap();
        ok(run(
            &repo,
            &["worktree", "add", "-b", "side", "--", tree],
            TIMEOUT,
            4096,
        )
        .unwrap());
        ok(run(&repo, &["worktree", "remove", "--", tree], TIMEOUT, 4096).unwrap());
    }

    /// MCR-194 P1: on the operations that run alone, a driver configured after
    /// the guard read the configuration, and one named by an attribute the
    /// guard never saw, does not run. The probe records its own start with
    /// shell builtins only, so no second program stands between its start and
    /// the record.
    #[test]
    fn a_filter_driver_written_after_the_guard_looked_does_not_run() {
        let fixture = tempfile::tempdir().unwrap();
        let cwd = &fixture.path().join("repo");
        std::fs::create_dir(cwd).unwrap();
        committed(
            cwd,
            &[
                (".gitattributes", "file filter=late\n"),
                ("file", "original\n"),
            ],
        );
        let marker = probe(cwd);
        type Late = (
            &'static [&'static str],
            &'static [(&'static str, &'static str)],
            bool,
        );
        // Operation, settings written late, whether `info/attributes` names
        // the driver, and what the operation itself must answer.
        let cases: [(Late, Option<&str>); 4] = [
            (
                (
                    &["status", "--porcelain"],
                    &[("filter.late.clean", ".git/probe")],
                    false,
                ),
                Some(" M file\n"),
            ),
            (
                (
                    &["diff", "--numstat", "HEAD"],
                    &[
                        ("filter.late.clean", ".git/probe"),
                        ("filter.late.required", "true"),
                    ],
                    false,
                ),
                // A required filter that cannot start fails the operation.
                None,
            ),
            (
                (
                    &["status", "--porcelain"],
                    &[("filter.later.process", ".git/probe")],
                    true,
                ),
                Some(" M file\n"),
            ),
            (
                (
                    &["diff", "--numstat", "HEAD"],
                    &[("filter.later.clean", ".git/probe")],
                    true,
                ),
                Some("1\t1\tfile\n"),
            ),
        ];
        for ((args, settings, attributes), expected) in cases {
            // Read-tree drops the index's file sizes, so Git reads the file.
            ok(run(cwd, &["read-tree", "HEAD"], TIMEOUT, 4096).unwrap());
            std::fs::write(cwd.join("file"), "changed\n").unwrap();
            let late = cwd.clone();
            BEFORE_RUN.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    for (key, value) in settings {
                        ok(raw(&late, &["config", "--local", key, value]));
                    }
                    if attributes {
                        std::fs::write(late.join(".git/info/attributes"), "* filter=later\n")
                            .unwrap();
                    }
                }))
            });
            let output = run(cwd, args, TIMEOUT, 64 * 1024).unwrap();
            assert!(
                BEFORE_RUN.with(|slot| slot.borrow().is_none()),
                "the hook did not run"
            );
            assert!(
                !marker.exists(),
                "{args:?} started the late driver: {output:?}"
            );
            match expected {
                Some(stdout) => {
                    assert!(output.status.success(), "{args:?}: {output:?}");
                    assert_eq!(String::from_utf8_lossy(&output.stdout), stdout, "{args:?}");
                }
                None => {
                    assert!(!output.status.success(), "{args:?}: {output:?}");
                    assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
                }
            }
            // The same configuration starts the driver under a plain Git.
            ok(raw(cwd, &["read-tree", "HEAD"]));
            std::fs::write(cwd.join("file"), "changed\n").unwrap();
            let _ = raw(cwd, args);
            assert!(
                marker.exists(),
                "{args:?} should start the driver without the runner"
            );
            std::fs::remove_file(&marker).unwrap();
            for section in ["filter.late", "filter.later"] {
                let _ = raw(cwd, &["config", "--local", "--remove-section", section]);
            }
            let _ = std::fs::remove_file(cwd.join(".git/info/attributes"));
        }
    }

    /// Linux counts threads against the process limit. Git preloads the index
    /// with threads from 1,000 entries; the runner keeps it to one thread.
    #[test]
    fn a_repository_with_many_index_entries_reads_clean_alone() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path();
        ok(run(repo, &["init", "-q"], TIMEOUT, 4096).unwrap());
        // A system core.autocrlf=true (Git for Windows) would warn once per
        // file while staging, past the output cap.
        ok(run(
            repo,
            &["config", "--local", "core.autocrlf", "false"],
            TIMEOUT,
            4096,
        )
        .unwrap());
        for dir in 0..30 {
            let dir = repo.join(format!("d{dir:02}"));
            std::fs::create_dir(&dir).unwrap();
            for file in 0..50 {
                std::fs::write(dir.join(format!("f{file:02}")), format!("{file}\n")).unwrap();
            }
        }
        ok(run(repo, &["add", "--", "."], TIMEOUT, 4096).unwrap());
        ok(raw(
            repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "many",
            ],
        ));
        let git = |args: &[&str]| run(repo, args, TIMEOUT, 1 << 20).unwrap();
        assert_eq!(
            ok(git(&["ls-files", "-z"])).split_terminator('\0').count(),
            1500
        );
        ok(git(&["config", "--local", "core.preloadIndex", "true"]));
        ok(git(&["config", "--local", "index.threads", "true"]));
        assert_eq!(
            ok(git(&["config", "--get", "core.preloadIndex"])),
            "false\n"
        );
        assert_eq!(ok(git(&["config", "--get", "index.threads"])), "1\n");
        // Read-tree drops the file sizes: every entry is looked at again.
        ok(git(&["read-tree", "HEAD"]));
        assert_eq!(ok(git(&["status", "--porcelain"])), "");
        assert_eq!(ok(git(&["diff", "--numstat", "HEAD"])), "");
    }

    #[test]
    fn privileged_linux_credentials_are_found() {
        let status = |uid: &str, prm: &str, eff: &str, amb: &str| {
            format!(
                "Name:\tx\nUid:\t{uid}\nGid:\t1000\t1000\t1000\t1000\n\
                 CapInh:\t0000000000000000\nCapPrm:\t{prm}\nCapEff:\t{eff}\n\
                 CapBnd:\t000001ffffffffff\nCapAmb:\t{amb}\n"
            )
        };
        let user = "1000\t1000\t1000\t1000";
        let none = "0000000000000000";
        assert_eq!(privileged(&status(user, none, none, none)), Some(false));
        // A user id 0 in the real, effective or saved place.
        for uid in [
            "0\t1000\t1000\t1000",
            "1000\t0\t1000\t1000",
            "1000\t1000\t0\t1000",
        ] {
            assert_eq!(
                privileged(&status(uid, none, none, none)),
                Some(true),
                "{uid}"
            );
        }
        // Any capability, also one that is only permitted, and not only the
        // two the limit exempts: CAP_NET_BIND_SERVICE (10).
        let one = "0000000000000400";
        assert_eq!(privileged(&status(user, one, none, none)), Some(true));
        assert_eq!(privileged(&status(user, none, one, none)), Some(true));
        assert_eq!(privileged(&status(user, none, none, one)), Some(true));
        assert_eq!(
            privileged(&status(user, "000001ffffffffff", none, none)),
            Some(true)
        );
        // Text that does not say refuses.
        assert_eq!(privileged(&status("1000\t1000", none, none, none)), None);
        assert_eq!(privileged(&status(user, "zz", none, none)), None);
        assert_eq!(
            privileged("Name:\tx\nUid:\t1000\t1000\t1000\t1000\nCapPrm:\t0\nCapEff:\t0\n"),
            None
        );
    }

    #[test]
    fn runs_git_in_the_given_folder_with_literal_operands() {
        let repo = tempfile::tempdir().unwrap();
        let output = run(repo.path(), &["init", "-q"], TIMEOUT, 4096).unwrap();
        assert!(output.status.success(), "{output:?}");
        let nested = repo.path().join("a folder & more");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("a file & more"), b"data").unwrap();
        let output = run(&nested, &["add", "--", "a file & more"], TIMEOUT, 4096).unwrap();
        assert!(output.status.success(), "{output:?}");
        let output = run(&nested, &["ls-files", "-z"], TIMEOUT, 4096).unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"a file & more\0");
        let output = run(&nested, &["rev-parse", "--verify", "HEAD"], TIMEOUT, 4096).unwrap();
        assert!(!output.status.success());
        assert!(!output.stderr.is_empty());
    }

    #[test]
    fn refuses_relative_folders() {
        assert!(run(Path::new("."), &["--version"], TIMEOUT, 4096)
            .unwrap_err()
            .to_string()
            .contains("absolute"));
    }

    #[test]
    fn rejects_oversized_output() {
        let cwd = std::env::current_dir().unwrap();
        assert!(matches!(
            run(&cwd, &["--version"], TIMEOUT, 1),
            Err(Error::OutputLimit { limit: 1 })
        ));
        assert!(matches!(
            run(&cwd, &["--mcr-unknown-option"], TIMEOUT, 1),
            Err(Error::OutputLimit { limit: 1 })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn repository_programs_are_disabled() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let repo = tempfile::tempdir().unwrap();
        let cwd = repo.path();
        let raw = |args: &[&str]| {
            Command::new("git")
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args(args)
                .output()
                .unwrap()
        };
        let setup = |args: &[&str]| {
            let output = raw(args);
            assert!(output.status.success(), "{output:?}");
        };
        setup(&["init", "-q"]);
        fs::write(cwd.join(".gitattributes"), "file filter=a=b diff=probe\n").unwrap();
        fs::write(cwd.join("file"), "original\n").unwrap();
        setup(&["add", "--", ".gitattributes", "file"]);
        setup(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-qm",
            "fixture",
        ]);
        fs::write(cwd.join("file"), "changed content\n").unwrap();

        let marker = cwd.join(".git/probe-ran");
        let probe = cwd.join(".git/probe");
        fs::write(
            &probe,
            format!("#!/bin/sh\ntouch '{}'; exit 1\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&probe, fs::Permissions::from_mode(0o700)).unwrap();
        let probe_cmd = probe.to_str().unwrap();
        let hooks = cwd.join(".git/test-hooks");
        fs::create_dir(&hooks).unwrap();
        fs::copy(&probe, hooks.join("post-checkout")).unwrap();
        // A commit with a signature header (no key needed) makes log run gpg.
        let head = raw(&["cat-file", "commit", "HEAD"]).stdout;
        let head = String::from_utf8(head).unwrap();
        let (headers, message) = head.split_once("\n\n").unwrap();
        let signed = format!("{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\n{message}");
        let mut hash = Command::new("git")
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut hash.stdin.take().unwrap(), signed.as_bytes()).unwrap();
        let hash = hash.wait_with_output().unwrap();
        assert!(hash.status.success(), "{hash:?}");
        setup(&[
            "update-ref",
            "HEAD",
            String::from_utf8(hash.stdout).unwrap().trim(),
        ]);

        for (key, value, args) in [
            (
                "filter.a=b.clean",
                probe_cmd,
                &["diff", "--numstat", "HEAD", "--", "file"][..],
            ),
            (
                "filter.a=b.process",
                probe_cmd,
                &["diff", "--numstat", "HEAD", "--", "file"][..],
            ),
            (
                "diff.probe.textconv",
                probe_cmd,
                &["diff", "HEAD", "--", "file"][..],
            ),
            (
                "diff.external",
                probe_cmd,
                &["diff", "HEAD", "--", "file"][..],
            ),
            ("core.fsmonitor", probe_cmd, &["status", "--porcelain"][..]),
            (
                "core.hooksPath",
                ".git/test-hooks",
                &["checkout", "--", "file"][..],
            ),
            (
                "filter.a=b.smudge",
                probe_cmd,
                &["checkout-index", "--all", "--index"][..],
            ),
            ("gpg.program", probe_cmd, &["log", "-1"][..]),
            ("gpg.program", probe_cmd, &["show", "-s", "HEAD"][..]),
        ] {
            setup(&["config", "--local", key, value]);
            if key == "gpg.program" {
                setup(&["config", "--local", "log.showSignature", "true"]);
            }
            if key.starts_with("filter.") && !key.ends_with(".smudge") {
                setup(&["config", "--local", "filter.a=b.required", "true"]);
            }
            if key.ends_with(".smudge") {
                fs::remove_file(cwd.join("file")).unwrap();
            }
            let baseline = raw(args);
            assert!(
                marker.is_file(),
                "{key} should run without guards: {baseline:?}"
            );
            fs::remove_file(&marker).unwrap();
            if key.ends_with(".smudge") {
                fs::remove_file(cwd.join("file")).unwrap();
            } else {
                fs::write(cwd.join("file"), "changed content\n").unwrap();
            }
            let output = run(cwd, args, TIMEOUT, 4096).unwrap();
            assert!(output.status.success(), "{key}: {output:?}");
            assert!(!marker.exists(), "{key} ran");
            setup(&["config", "--local", "--unset", key]);
            if key == "gpg.program" {
                setup(&["config", "--local", "--unset", "log.showSignature"]);
            }
            if key.starts_with("filter.") && !key.ends_with(".smudge") {
                setup(&["config", "--local", "--unset", "filter.a=b.required"]);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn status_does_not_run_submodule_summary() {
        use std::fs;

        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("repo");
        let module = repo.join("module");
        fs::create_dir_all(&module).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let output = run(cwd, args, TIMEOUT, 4096).unwrap();
            assert!(output.status.success(), "{output:?}");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        for cwd in [&repo, &module] {
            git(cwd, &["init", "-q"]);
            git(cwd, &["config", "--local", "user.name", "Test"]);
            git(
                cwd,
                &["config", "--local", "user.email", "test@example.invalid"],
            );
            git(cwd, &["config", "--local", "commit.gpgSign", "false"]);
        }
        git(&module, &["commit", "--allow-empty", "-qm", "first"]);
        let commit = git(&module, &["rev-parse", "HEAD"]);
        fs::write(
            repo.join(".gitmodules"),
            "[submodule \"module\"]\n  path = module\n  url = ./module\n",
        )
        .unwrap();
        git(&repo, &["add", "--", ".gitmodules"]);
        git(
            &repo,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{commit},module"),
            ],
        );
        git(&repo, &["commit", "-qm", "add gitlink"]);
        git(
            &module,
            &["commit", "--allow-empty", "-qm", "module changed"],
        );
        git(
            &repo,
            &["config", "--local", "status.submoduleSummary", "true"],
        );
        let raw = Command::new("git")
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["status", "--ignore-submodules=dirty"])
            .output()
            .unwrap();
        assert!(raw.status.success());
        assert!(String::from_utf8_lossy(&raw.stdout).contains("* module "));
        let safe = run(&repo, &["status"], TIMEOUT, 4096).unwrap();
        assert!(safe.status.success());
        let status = String::from_utf8_lossy(&safe.stdout);
        assert!(status.contains("module"));
        assert!(!status.contains("* module "));
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_command_on_timeout() {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("/bin/sleep");
        command.arg("10").process_group(0);
        let start = Instant::now();
        let error = capture(command, Limit::None, Duration::from_millis(30), 4096).unwrap_err();
        assert!(matches!(error, Error::Other(error) if error.kind() == io::ErrorKind::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
