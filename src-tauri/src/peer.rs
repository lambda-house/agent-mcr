//! Who is on the other end of a local socket, as the kernel reports it.
//!
//! Every process here runs as the same user, so these checks are not a wall
//! between that user's programs: a program that sets out to pass them can (it
//! can hand a connection to a process that does pass). They keep a hosted
//! agent from reaching the sockets with one plain command, and they are the
//! only source of a caller's identity: nothing a caller says about itself is
//! believed.

use crate::ipc::Stream;
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

/// The user and process that opened the connection.
#[cfg(target_os = "macos")]
fn credentials(stream: &Stream) -> Option<(u32, i32)> {
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

#[cfg(all(unix, not(target_os = "macos")))]
fn credentials(stream: &Stream) -> Option<(u32, i32)> {
    // SAFETY: zeroed is a valid ucred, and `len` is its size.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let ok = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) } == 0;
    (ok && cred.pid > 0).then_some((cred.uid, cred.pid))
}

/// The connection comes from a process of the user this process runs as.
#[cfg(unix)]
pub fn same_user(stream: &Stream) -> bool {
    // SAFETY: plain syscall.
    credentials(stream).is_some_and(|(uid, _)| uid == unsafe { libc::getuid() })
}

#[cfg(unix)]
pub fn pid(stream: &Stream) -> Option<i32> {
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

#[cfg(all(unix, not(target_os = "macos")))]
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

#[cfg(all(unix, not(target_os = "macos")))]
pub fn program(pid: i32) -> Option<PathBuf> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    // A program replaced on disk while it runs
    let text = path.to_string_lossy();
    Some(PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(&text)))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, FILETIME, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Networking::WinSock::{WSAIoctl, SOCKET};
    use windows_sys::Win32::Security::{
        EqualSid, GetLengthSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const SIO_AF_UNIX_GETPEERPID: u32 = 0x5800_0100;

    struct Handle(HANDLE);

    impl Handle {
        fn open_process(pid: u32) -> Option<Self> {
            // SAFETY: OpenProcess returns null on failure.
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(Self(handle))
            }
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: owned handle.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    pub fn pid(stream: &Stream) -> Option<i32> {
        let mut peer_pid: u32 = 0;
        let mut bytes_returned: u32 = 0;
        // SAFETY: output buffer and length match u32; socket is a live AF_UNIX stream.
        let rc = unsafe {
            WSAIoctl(
                stream.as_raw_socket() as SOCKET,
                SIO_AF_UNIX_GETPEERPID,
                std::ptr::null(),
                0,
                (&mut peer_pid as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
                None,
            )
        };
        if rc != 0 || bytes_returned != std::mem::size_of::<u32>() as u32 {
            return None;
        }
        i32::try_from(peer_pid).ok().filter(|&p| p > 0)
    }

    fn process_user_sid(process: HANDLE) -> Option<Vec<u8>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: `token` is valid for writes; `process` is a live handle.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 || token.is_null() {
            return None;
        }
        let _token = Handle(token);
        let mut needed: u32 = 0;
        // SAFETY: probing required buffer size.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        // SAFETY: `buf` has `needed` bytes.
        if unsafe {
            GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return None;
        }
        if (needed as usize) < std::mem::size_of::<TOKEN_USER>() {
            return None;
        }
        // SAFETY: `buf` holds a valid `TOKEN_USER` structure.
        let user = unsafe { &*(buf.as_ptr().cast::<TOKEN_USER>()) };
        let sid = user.User.Sid;
        // SAFETY: checking SID validity and length before copying its bytes.
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return None;
        }
        // SAFETY: `sid` was validated by `IsValidSid`.
        let len = unsafe { GetLengthSid(sid) } as usize;
        if len == 0 {
            return None;
        }
        // SAFETY: `sid` points to `len` readable bytes.
        Some(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), len) }.to_vec())
    }

    pub fn same_user(stream: &Stream) -> bool {
        let Some(peer_pid) = pid(stream).and_then(|p| u32::try_from(p).ok()) else {
            return false;
        };
        let Some(peer_proc) = Handle::open_process(peer_pid) else {
            return false;
        };
        let Some(mut theirs) = process_user_sid(peer_proc.0) else {
            return false;
        };
        // SAFETY: pseudo-handle for current process; does not need closing.
        let Some(mut mine) = process_user_sid(unsafe { GetCurrentProcess() }) else {
            return false;
        };
        // SAFETY: both buffers are valid SIDs copied from GetTokenInformation.
        unsafe {
            IsValidSid(mine.as_mut_ptr().cast()) != 0
                && IsValidSid(theirs.as_mut_ptr().cast()) != 0
                && EqualSid(mine.as_mut_ptr().cast(), theirs.as_mut_ptr().cast()) != 0
        }
    }

    fn creation_time(process: HANDLE) -> Option<u64> {
        // SAFETY: zeroed FILETIME is valid.
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        // SAFETY: all four pointers are valid for writes.
        if unsafe { GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return None;
        }
        Some(((created.dwHighDateTime as u64) << 32) | (created.dwLowDateTime as u64))
    }

    pub fn parent(pid: i32) -> Option<i32> {
        let child_pid = u32::try_from(pid).ok().filter(|&p| p > 0)?;
        let child_proc = Handle::open_process(child_pid)?;
        let child_created = creation_time(child_proc.0)?;

        // SAFETY: plain snapshot syscall.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let _snap = Handle(snap);

        // SAFETY: zeroed PROCESSENTRY32W with dwSize set is required by Process32FirstW.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: `snap` is a valid process snapshot and `entry.dwSize` is set.
        if unsafe { Process32FirstW(snap, &mut entry) } == 0 {
            return None;
        }
        let mut ppid = None;
        loop {
            if entry.th32ProcessID == child_pid {
                ppid = Some(entry.th32ParentProcessID);
                break;
            }
            // SAFETY: `snap` and `entry` are valid from the previous call.
            if unsafe { Process32NextW(snap, &mut entry) } == 0 {
                break;
            }
        }
        let ppid = ppid.filter(|&p| p != 0 && p != child_pid)?;
        // Windows reuses PIDs and does not re-parent orphans: verify the candidate parent started no later than the child.
        let parent_proc = Handle::open_process(ppid)?;
        let parent_created = creation_time(parent_proc.0)?;
        if parent_created > child_created {
            return None;
        }
        i32::try_from(ppid).ok().filter(|&p| p > 0)
    }

    pub fn program(pid: i32) -> Option<PathBuf> {
        let pid = u32::try_from(pid).ok().filter(|&p| p > 0)?;
        let handle = Handle::open_process(pid)?;
        let mut cap = 512usize;
        loop {
            let mut buf = vec![0u16; cap];
            let mut len = buf.len() as u32;
            // SAFETY: `buf` has `len` u16 elements writable.
            if unsafe { QueryFullProcessImageNameW(handle.0, 0, buf.as_mut_ptr(), &mut len) } != 0
            {
                return Some(PathBuf::from(OsString::from_wide(&buf[..len as usize])));
            }
            // SAFETY: plain GetLastError call.
            if unsafe { GetLastError() } == ERROR_INSUFFICIENT_BUFFER && cap < 32_768 {
                cap *= 2;
                continue;
            }
            return None;
        }
    }
}

#[cfg(windows)]
pub fn same_user(stream: &Stream) -> bool {
    win::same_user(stream)
}

#[cfg(windows)]
pub fn pid(stream: &Stream) -> Option<i32> {
    win::pid(stream)
}

#[cfg(windows)]
pub fn parent(pid: i32) -> Option<i32> {
    win::parent(pid)
}

#[cfg(windows)]
pub fn program(pid: i32) -> Option<PathBuf> {
    win::program(pid)
}

fn real(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The connection comes from this very program (the app, the harness service
/// or one of its bridges), run by the same user.
pub fn is_this_program(stream: &Stream) -> bool {
    let Some(pid) = pid(stream) else { return false };
    if !same_user(stream) {
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

    #[cfg(unix)]
    fn stream_pair() -> (Stream, Stream) {
        Stream::pair().unwrap()
    }

    #[cfg(windows)]
    fn stream_pair() -> (Stream, Stream) {
        let path = std::env::temp_dir().join(format!("mcr-peer-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = crate::ipc::Listener::bind(&path).unwrap();
        let client = Stream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        let _ = std::fs::remove_file(&path);
        (client, server)
    }

    #[test]
    fn a_connection_from_this_process_is_recognised() {
        let (a, _b) = stream_pair();
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
