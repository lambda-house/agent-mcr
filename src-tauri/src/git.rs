//! Run local Git operations with a deadline and a cap on each output stream.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Callers supply a fixed Git operation and put any user data in operands.
/// Check the exit status before using the output. An incomplete stream is an error.
pub fn run(
    cwd: &Path,
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    max_output: usize,
) -> Result<Output, String> {
    if !cwd.is_absolute() {
        return Err("Git requires an absolute working directory".into());
    }
    let executable = if cfg!(unix) && Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git"
    } else {
        "git"
    };
    let no_hooks = if cfg!(windows) { "core.hooksPath=NUL" } else { "core.hooksPath=/dev/null" };
    let mut command = Command::new(executable);
    // Inherited Git variables can redirect an operation away from its working directory,
    // add configuration, or send traces to a file.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .args(["--no-pager", "-c", no_hooks, "-c", "core.fsmonitor=false", "-c", "credential.helper="])
        .args(args)
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
    capture(command, timeout, max_output).map_err(|error| format!("Git: {error}"))
}

fn capture(mut command: Command, timeout: Duration, max_output: usize) -> io::Result<Output> {
    let start = Instant::now();
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    // Drain both pipes concurrently. Each reader keeps at most max_output + 1 bytes.
    let stdout = read_pipe(child.stdout.take().unwrap(), max_output);
    let stderr = read_pipe(child.stderr.take().unwrap(), max_output);
    let result = (|| {
        while !stdout.is_finished() || !stderr.is_finished() {
            pause(start, timeout)?;
        }
        let stdout = stdout.join().map_err(|_| io::Error::other("stdout reader failed"))??;
        let stderr = stderr.join().map_err(|_| io::Error::other("stderr reader failed"))??;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(Output { status, stdout, stderr });
            }
            pause(start, timeout)?;
        }
    })();
    if result.is_err() {
        stop(&mut child);
    }
    result
}

fn read_pipe(pipe: impl Read + Send + 'static, limit: usize) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        pipe.take((limit as u64).saturating_add(1)).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(io::Error::other(format!("output exceeds {limit} bytes")));
        }
        Ok(bytes)
    })
}

fn pause(start: Instant, timeout: Duration) -> io::Result<()> {
    let remaining = timeout.saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "command timed out"));
    }
    thread::sleep(remaining.min(Duration::from_millis(5)));
    Ok(())
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
        assert!(run(Path::new("."), &["--version"], TIMEOUT, 4096).unwrap_err().contains("absolute"));
    }

    #[test]
    fn rejects_oversized_output() {
        let cwd = std::env::current_dir().unwrap();
        assert!(run(&cwd, &["--version"], TIMEOUT, 1).unwrap_err().contains("output exceeds 1 bytes"));
        assert!(run(&cwd, &["--mcr-unknown-option"], TIMEOUT, 1).unwrap_err().contains("output exceeds 1 bytes"));
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_command_on_timeout() {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("/bin/sleep");
        command.arg("10").process_group(0);
        let start = Instant::now();
        let error = capture(command, Duration::from_millis(30), 4096).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
