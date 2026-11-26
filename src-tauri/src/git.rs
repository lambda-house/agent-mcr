//! Run local Git operations with a deadline and a cap on each output stream.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fmt;
use std::io::{self, Read};
use std::path::Path;
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

/// Callers supply a fixed Git subcommand followed by its arguments. Place user
/// data in operands. Check the exit status before using the output.
pub fn run(
    cwd: &Path,
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    max_output: usize,
) -> Result<Output, Error> {
    if !cwd.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "requires an absolute working directory",
        )
        .into());
    }
    let start = Instant::now();
    let mut command = local_command(cwd);
    if let Some((operation, operands)) = args.split_first() {
        // Worktree checkout and even status/diff can invoke configured filters.
        // Inspect only their names, and disable them before running the operation.
        let mut config = local_command(cwd);
        config.args([
            "config",
            "--name-only",
            "--null",
            "--get-regexp",
            "^filter\\.",
        ]);
        let found = capture(config, timeout, 64 * 1024)?;
        match found.status.code() {
            Some(0) => {
                let names = std::str::from_utf8(&found.stdout).map_err(io::Error::other)?;
                let filters: BTreeSet<_> = names
                    .split_terminator('\0')
                    .filter_map(|key| key.rsplit_once('.').map(|(name, _)| name))
                    .collect();
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
            Some(1) if found.stderr.is_empty() => {}
            _ => return Err(io::Error::other("cannot inspect Git filter configuration").into()),
        }
        command.arg(operation);
        if ["diff", "show", "log"]
            .iter()
            .any(|name| operation.as_ref() == OsStr::new(name))
        {
            command.args(["--no-ext-diff", "--no-textconv"]);
        }
        command.args(operands);
    }
    let remaining = timeout.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return Err(timed_out().into());
    }
    capture(command, remaining, max_output)
}

fn local_command(cwd: &Path) -> Command {
    let executable = if cfg!(unix) && Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git"
    } else if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    };
    let no_hooks = if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    };
    let mut command = Command::new(executable);
    // Inherited Git variables can redirect an operation away from its working directory,
    // add configuration, or send traces to a file.
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
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
        ])
        .env("GIT_CONFIG_NOSYSTEM", "1")
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
    command
}

fn capture(mut command: Command, timeout: Duration, max_output: usize) -> Result<Output, Error> {
    let start = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
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
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

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
                &["checkout", "--", "file"][..],
            ),
        ] {
            setup(&["config", "--local", key, value]);
            if key.starts_with("filter.") {
                setup(&["config", "--local", "filter.a=b.required", "true"]);
            }
            let baseline = raw(args);
            assert!(
                marker.is_file(),
                "{key} should run without guards: {baseline:?}"
            );
            fs::remove_file(&marker).unwrap();
            fs::write(cwd.join("file"), "changed content\n").unwrap();
            let output = run(cwd, args, TIMEOUT, 4096).unwrap();
            assert!(output.status.success(), "{key}: {output:?}");
            assert!(!marker.exists(), "{key} ran");
            setup(&["config", "--local", "--unset", key]);
            if key.starts_with("filter.") {
                setup(&["config", "--local", "--unset", "filter.a=b.required"]);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_command_on_timeout() {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("/bin/sleep");
        command.arg("10").process_group(0);
        let start = Instant::now();
        let error = capture(command, Duration::from_millis(30), 4096).unwrap_err();
        assert!(matches!(error, Error::Other(error) if error.kind() == io::ErrorKind::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
