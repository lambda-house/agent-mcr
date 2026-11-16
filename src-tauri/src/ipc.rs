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

/// Create `path` with a protected user-only DACL if missing, or verify it without repairing.
#[cfg(windows)]
pub fn private_dir(path: &Path) -> Result<(), String> {
    win::private_dir(path)
}

/// Restrict an existing file or socket to the current user.
#[cfg(unix)]
pub fn private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

/// Verify an existing file or socket has a protected user-only DACL, without repairing.
#[cfg(windows)]
pub fn private_file(path: &Path) -> Result<(), String> {
    win::private_file(path)
}

/// Whether `meta` (or `path` on Windows) describes a socket file.
#[cfg(unix)]
pub fn is_socket(_path: &Path, meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;
    meta.file_type().is_socket()
}

/// Whether `path` describes an AF_UNIX socket reparse point.
#[cfg(windows)]
pub fn is_socket(path: &Path, _meta: &std::fs::Metadata) -> bool {
    win::is_af_unix_socket(path)
}

#[cfg(windows)]
mod win {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE,
        HLOCAL, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS,
        NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, InitializeSecurityDescriptor,
        IsValidSid, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
        SetSecurityDescriptorOwner, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
        OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, FindClose, FindFirstFileW, FILE_ALL_ACCESS,
        FILE_ATTRIBUTE_REPARSE_POINT, WIN32_FIND_DATAW,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const IO_REPARSE_TAG_AF_UNIX: u32 = 0x8000_0023;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    struct Handle(HANDLE);
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

    struct LocalMem(HLOCAL);
    impl Drop for LocalMem {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: allocated by LocalAlloc / Win32 security APIs.
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    fn to_wide(path: &Path) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn current_user_sid() -> Result<Vec<u8>, String> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: pseudo-handle for current process; `token` is valid for writes.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0
            || token.is_null()
        {
            return Err("Cannot open current process token".into());
        }
        let _token = Handle(token);
        let mut needed: u32 = 0;
        // SAFETY: probing buffer size.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err("Cannot query current user SID size".into());
        }
        let mut buf = vec![0u8; needed as usize];
        // SAFETY: `buf` has `needed` bytes.
        if unsafe {
            GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err("Cannot query current user SID".into());
        }
        if (needed as usize) < std::mem::size_of::<TOKEN_USER>() {
            return Err("Invalid token user buffer".into());
        }
        // SAFETY: `buf` holds a `TOKEN_USER` (read_unaligned avoids Vec<u8> alignment assumption).
        let sid = unsafe { std::ptr::read_unaligned(buf.as_ptr().cast::<TOKEN_USER>()) }.User.Sid;
        // SAFETY: checking SID validity and length.
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err("Invalid current user SID".into());
        }
        // SAFETY: `sid` is valid.
        let len = unsafe { GetLengthSid(sid) } as usize;
        // SAFETY: `sid` points to `len` readable bytes.
        Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), len) }.to_vec())
    }

    pub fn is_af_unix_socket(path: &Path) -> bool {
        let wide = to_wide(path);
        // SAFETY: zeroed WIN32_FIND_DATAW is valid.
        let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
        // SAFETY: `wide` is null-terminated; `data` is valid for writes.
        let h = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
        if h == INVALID_HANDLE_VALUE {
            return false;
        }
        // SAFETY: valid find handle.
        unsafe { FindClose(h) };
        (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            && data.dwReserved0 == IO_REPARSE_TAG_AF_UNIX
    }

    fn create_private_dir(path: &Path, user_sid: &mut [u8]) -> Result<(), String> {
        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: user_sid.as_mut_ptr().cast(),
            },
        };
        let mut acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: `ea` is valid; `acl` receives a LocalAlloc pointer.
        let rc = unsafe { SetEntriesInAclW(1, &ea, std::ptr::null(), &mut acl) };
        if rc != ERROR_SUCCESS || acl.is_null() {
            return Err(format!("{}: cannot build DACL (error {rc})", path.display()));
        }
        let _acl = LocalMem(acl.cast());

        // SAFETY: zeroed SECURITY_DESCRIPTOR buffer initialized via InitializeSecurityDescriptor.
        let mut sd: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
        let sd_ptr: PSECURITY_DESCRIPTOR = (&mut sd as *mut SECURITY_DESCRIPTOR).cast();
        // SAFETY: `sd_ptr` points to a SECURITY_DESCRIPTOR buffer.
        if unsafe { InitializeSecurityDescriptor(sd_ptr, SECURITY_DESCRIPTOR_REVISION) } == 0 {
            return Err(format!("{}: cannot initialize security descriptor", path.display()));
        }
        // SAFETY: `sd_ptr` and `user_sid` are valid.
        if unsafe { SetSecurityDescriptorOwner(sd_ptr, user_sid.as_mut_ptr().cast(), 0) } == 0 {
            return Err(format!("{}: cannot set security descriptor owner", path.display()));
        }
        // SAFETY: `sd_ptr` and `acl` are valid.
        if unsafe { SetSecurityDescriptorDacl(sd_ptr, 1, acl, 0) } == 0 {
            return Err(format!("{}: cannot set security descriptor DACL", path.display()));
        }
        // SAFETY: `sd_ptr` is valid; mark DACL protected so nothing inherits from parent.
        if unsafe {
            SetSecurityDescriptorControl(sd_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
        } == 0
        {
            return Err(format!("{}: cannot protect security descriptor DACL", path.display()));
        }

        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: 0,
        };
        let wide = to_wide(path);
        // SAFETY: `wide` is null-terminated and `sa` is valid.
        if unsafe { CreateDirectoryW(wide.as_ptr(), &sa) } == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_ALREADY_EXISTS {
                return verify_private(path, true, user_sid);
            }
            return Err(format!("{}: cannot create directory (error {err})", path.display()));
        }
        Ok(())
    }

    fn verify_private(path: &Path, is_dir: bool, user_sid: &mut [u8]) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(path)
            .map_err(|e| format!("{}: cannot inspect metadata: {e}", path.display()))?;
        let attrs = meta.file_attributes();
        if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (is_dir || !is_af_unix_socket(path)) {
            return Err(format!("{}: refusing reparse point / symlink", path.display()));
        }
        if is_dir && !meta.is_dir() {
            return Err(format!("{}: expected a directory", path.display()));
        }
        if !is_dir && meta.is_dir() {
            return Err(format!("{}: expected a file or socket, found directory", path.display()));
        }

        let wide = to_wide(path);
        let mut owner: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is null-terminated; output pointers are valid for writes.
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != ERROR_SUCCESS || sd.is_null() {
            return Err(format!("{}: cannot read security descriptor (error {rc})", path.display()));
        }
        let _sd = LocalMem(sd);

        // SAFETY: checking owner SID validity and equality with current user.
        let owner_ok = !owner.is_null()
            && unsafe { IsValidSid(owner) } != 0
            && unsafe { EqualSid(owner, user_sid.as_mut_ptr().cast()) } != 0;
        if !owner_ok {
            return Err(format!("{}: owner is not the current user", path.display()));
        }

        let mut control: u16 = 0;
        let mut revision: u32 = 0;
        // SAFETY: `sd` is valid from GetNamedSecurityInfoW.
        if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0
            || (control & SE_DACL_PROTECTED) == 0
        {
            return Err(format!("{}: DACL is not protected", path.display()));
        }

        if dacl.is_null() {
            return Err(format!("{}: missing DACL (unrestricted)", path.display()));
        }
        let mut info = ACL_SIZE_INFORMATION {
            AceCount: 0,
            AclBytesInUse: 0,
            AclBytesFree: 0,
        };
        // SAFETY: `dacl` is valid; `info` matches AclSizeInformation.
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(format!("{}: cannot inspect DACL", path.display()));
        }
        for i in 0..info.AceCount {
            let mut ace_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            // SAFETY: `i < info.AceCount`.
            if unsafe { GetAce(dacl, i, &mut ace_ptr) } == 0 || ace_ptr.is_null() {
                return Err(format!("{}: cannot read DACL ACE", path.display()));
            }
            // SAFETY: `ace_ptr` starts with `ACE_HEADER`.
            let header = unsafe { &*(ace_ptr.cast::<ACE_HEADER>()) };
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return Err(format!("{}: unexpected ACE type {}", path.display(), header.AceType));
            }
            // SAFETY: `AceType == ACCESS_ALLOWED_ACE_TYPE`.
            let ace = unsafe { &*(ace_ptr.cast::<ACCESS_ALLOWED_ACE>()) };
            let sid = (&ace.SidStart as *const u32).cast_mut().cast();
            // SAFETY: `sid` is inside the ACE.
            if unsafe { IsValidSid(sid) } == 0
                || unsafe { EqualSid(sid, user_sid.as_mut_ptr().cast()) } == 0
            {
                return Err(format!("{}: DACL grants access to another principal", path.display()));
            }
        }
        Ok(())
    }

    pub fn private_dir(path: &Path) -> Result<(), String> {
        let mut user_sid = current_user_sid()?;
        if std::fs::symlink_metadata(path).is_ok() {
            return verify_private(path, true, &mut user_sid);
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && std::fs::symlink_metadata(parent).is_err() {
                private_dir(parent)?;
            }
        }
        create_private_dir(path, &mut user_sid)
    }

    pub fn private_file(path: &Path) -> Result<(), String> {
        let mut user_sid = current_user_sid()?;
        verify_private(path, false, &mut user_sid)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
        use windows_sys::Win32::Security::{
            CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE, WELL_KNOWN_SID_TYPE,
        };
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinWorldSid};

        fn temp_root(name: &str) -> std::path::PathBuf {
            let p = std::env::temp_dir().join(format!("mcr-w3-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            p
        }

        #[test]
        fn new_private_dir_has_protected_user_only_dacl_and_file_inherits() {
            let dir = temp_root("ok");
            private_dir(&dir).unwrap();

            let mut user_sid = current_user_sid().unwrap();
            let wide = to_wide(&dir);
            let mut owner: *mut std::ffi::c_void = std::ptr::null_mut();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = unsafe {
                GetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    std::ptr::null_mut(),
                    &mut dacl,
                    std::ptr::null_mut(),
                    &mut sd,
                )
            };
            assert_eq!(rc, ERROR_SUCCESS);
            let _sd = LocalMem(sd);
            assert_ne!(unsafe { EqualSid(owner, user_sid.as_mut_ptr().cast()) }, 0);
            let mut control: u16 = 0;
            let mut rev: u32 = 0;
            assert_ne!(unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut rev) }, 0);
            assert_ne!(control & SE_DACL_PROTECTED, 0);

            let mut info = ACL_SIZE_INFORMATION { AceCount: 0, AclBytesInUse: 0, AclBytesFree: 0 };
            assert_ne!(
                unsafe {
                    GetAclInformation(
                        dacl,
                        (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                        AclSizeInformation,
                    )
                },
                0
            );
            assert_eq!(info.AceCount, 1);
            let mut ace_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            assert_ne!(unsafe { GetAce(dacl, 0, &mut ace_ptr) }, 0);
            let header = unsafe { &*(ace_ptr.cast::<ACE_HEADER>()) };
            assert_eq!(header.AceType, ACCESS_ALLOWED_ACE_TYPE);
            assert_ne!(header.AceFlags & OBJECT_INHERIT_ACE as u8, 0);
            assert_ne!(header.AceFlags & CONTAINER_INHERIT_ACE as u8, 0);

            let child = dir.join("secret.txt");
            std::fs::write(&child, b"ok").unwrap();
            private_file(&child).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn existing_dir_with_extra_ace_or_junction_is_refused_not_repaired() {
            let dir = temp_root("extra-ace");
            private_dir(&dir).unwrap();

            // Add Everyone (World) read ACE and verify private_dir refuses it without repairing.
            let mut world_sid = vec![0u8; 68];
            let mut len = world_sid.len() as u32;
            let world_type: WELL_KNOWN_SID_TYPE = WinWorldSid;
            assert_ne!(
                unsafe { CreateWellKnownSid(world_type, std::ptr::null_mut(), world_sid.as_mut_ptr().cast(), &mut len) },
                0
            );
            let mut user_sid = current_user_sid().unwrap();
            let eas = [
                EXPLICIT_ACCESS_W {
                    grfAccessPermissions: FILE_ALL_ACCESS,
                    grfAccessMode: GRANT_ACCESS,
                    grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    Trustee: TRUSTEE_W {
                        pMultipleTrustee: std::ptr::null_mut(),
                        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                        TrusteeForm: TRUSTEE_IS_SID,
                        TrusteeType: TRUSTEE_IS_USER,
                        ptstrName: user_sid.as_mut_ptr().cast(),
                    },
                },
                EXPLICIT_ACCESS_W {
                    grfAccessPermissions: windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ,
                    grfAccessMode: GRANT_ACCESS,
                    grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    Trustee: TRUSTEE_W {
                        pMultipleTrustee: std::ptr::null_mut(),
                        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                        TrusteeForm: TRUSTEE_IS_SID,
                        TrusteeType: windows_sys::Win32::Security::Authorization::TRUSTEE_IS_WELL_KNOWN_GROUP,
                        ptstrName: world_sid.as_mut_ptr().cast(),
                    },
                },
            ];
            let mut new_acl: *mut ACL = std::ptr::null_mut();
            assert_eq!(unsafe { SetEntriesInAclW(2, eas.as_ptr(), std::ptr::null(), &mut new_acl) }, ERROR_SUCCESS);
            let _acl = LocalMem(new_acl.cast());
            let mut wide = to_wide(&dir);
            assert_eq!(
                unsafe {
                    SetNamedSecurityInfoW(
                        wide.as_mut_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        new_acl,
                        std::ptr::null_mut(),
                    )
                },
                ERROR_SUCCESS
            );
            assert!(private_dir(&dir).is_err());
            // Must not repair: a second call still refuses.
            assert!(private_dir(&dir).is_err());
            let _ = std::fs::remove_dir_all(&dir);

            // Junction / symlink check
            let target = temp_root("junc-target");
            let link = temp_root("junc-link");
            private_dir(&target).unwrap();
            if std::os::windows::fs::symlink_dir(&target, &link).is_ok() {
                assert!(private_dir(&link).is_err());
                let _ = std::fs::remove_dir(&link);
            }
            let _ = std::fs::remove_dir_all(&target);
        }
    }
}
