//! Cross-platform Unix-domain socket aliases and private-file helpers.

use std::path::Path;

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
#[cfg(windows)]
pub use uds_windows::{UnixListener as Listener, UnixStream as Stream};

/// Create `path` if needed and restrict it to the current user.
#[cfg(unix)]
pub fn private_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

/// Create `path` if needed and restrict it to the current user (W3 implements DACLs).
#[cfg(not(unix))]
pub fn private_dir(path: &Path) -> Result<(), String> {
    let _ = path;
    Err("Private directory ACLs are not yet implemented on this platform".into())
}

/// Restrict an existing file or socket to the current user.
#[cfg(unix)]
pub fn private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

/// Restrict an existing file or socket to the current user (W3 implements DACLs).
#[cfg(not(unix))]
pub fn private_file(path: &Path) -> Result<(), String> {
    let _ = path;
    Err("Private file ACLs are not yet implemented on this platform".into())
}

/// Whether `meta` describes a socket file.
#[cfg(unix)]
pub fn is_socket(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;
    meta.file_type().is_socket()
}

/// Whether `meta` describes a socket file (fails closed until Windows check is added).
#[cfg(not(unix))]
pub fn is_socket(meta: &std::fs::Metadata) -> bool {
    let _ = meta;
    false
}
