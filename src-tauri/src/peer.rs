//! Who is on the other end of a local socket, as the kernel reports it.
//!
//! Every process here runs as the same user, so these checks are not a wall
//! between that user's programs: a program that sets out to pass them can (it
//! can hand a connection to a process that does pass). They keep a hosted
//! agent from reaching the sockets with one plain command, and they are the
//! only source of a caller's identity: nothing a caller says about itself is
//! believed.

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

/// The user and process that opened the connection.
#[cfg(target_os = "macos")]
fn credentials(stream: &UnixStream) -> Option<(u32, i32)> {
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    // SAFETY: both pointers are valid for writes.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return None;
    }
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: `pid` and `len` are valid for writes of the sizes passed.
    let ok = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut len) } == 0;
    (ok && pid > 0).then_some((uid, pid))
}

#[cfg(not(target_os = "macos"))]
fn credentials(stream: &UnixStream) -> Option<(u32, i32)> {
    // SAFETY: zeroed is a valid ucred, and `len` is its size.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let ok = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) } == 0;
    (ok && cred.pid > 0).then_some((cred.uid, cred.pid))
}

/// The connection comes from a process of the user this process runs as.
pub fn same_user(stream: &UnixStream) -> bool {
    // SAFETY: plain syscall.
    credentials(stream).is_some_and(|(uid, _)| uid == unsafe { libc::getuid() })
}

pub fn pid(stream: &UnixStream) -> Option<i32> {
    credentials(stream).map(|(_, pid)| pid)
}

#[cfg(target_os = "macos")]
pub fn parent(pid: i32) -> Option<i32> {
    // SAFETY: zeroed is a valid proc_bsdinfo, and the size passed is its size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (got == size).then_some(info.pbi_ppid as i32)
}

#[cfg(not(target_os = "macos"))]
pub fn parent(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // "pid (comm) state ppid …": the command may hold spaces and brackets
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// The program a process runs.
#[cfg(target_os = "macos")]
pub fn program(pid: i32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is valid for writes of the size passed.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned()))
}

#[cfg(not(target_os = "macos"))]
pub fn program(pid: i32) -> Option<PathBuf> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    // A program replaced on disk while it runs
    let text = path.to_string_lossy();
    Some(PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(&text)))
}

fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The connection comes from this very program (the app, the harness service
/// or one of its bridges), run by the same user.
pub fn is_this_program(stream: &UnixStream) -> bool {
    let Some((uid, pid)) = credentials(stream) else { return false };
    // SAFETY: plain syscall.
    if uid != unsafe { libc::getuid() } {
        return false;
    }
    match (program(pid), std::env::current_exe()) {
        (Some(theirs), Ok(ours)) => real(&theirs) == real(&ours),
        _ => false,
    }
}

/// The first of `roots` that `pid` is, or descends from.
pub fn ancestor_among(mut pid: i32, roots: &[i32]) -> Option<i32> {
    for _ in 0..32 {
        if roots.contains(&pid) {
            return Some(pid);
        }
        match parent(pid) {
            Some(up) if up > 1 => pid = up,
            _ => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_from_this_process_is_recognised() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(same_user(&a));
        assert_eq!(pid(&a), Some(std::process::id() as i32));
        assert!(is_this_program(&a));
        let me = std::process::id() as i32;
        assert_eq!(ancestor_among(me, &[me]), Some(me));
        let up = parent(me).unwrap();
        assert_eq!(ancestor_among(me, &[up]), Some(up));
        assert_eq!(ancestor_among(me, &[]), None);
    }
}
