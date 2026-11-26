//! Where the service keeps credentials: the macOS Keychain or Windows
//! Credential Manager, one service name per connector. A secret read from
//! here never goes into a state file, a status, a tool result or a log line.

/// The store did not say whether a secret is there: it is locked, it refused
/// this program, or it did not answer. Never taken for "not there", because a
/// missing token ends a sign-in. The words are fixed, so they may be shown to
/// the operator and in a tool result; the store's own error is not passed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unavailable(pub &'static str);

/// A store of secrets, by account name.
pub trait Vault: Send + Sync {
    /// The secret; `Ok(None)` only when the store says it has none.
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// A secret that is not there counts as removed.
    fn delete(&self, account: &str) -> Result<(), Unavailable>;
}

/// The system's secret store under one service name: the macOS Keychain, or
/// on Windows a generic credential `<service>/<account>`. `what` names the
/// secrets in messages to the person ("Slack tokens").
pub struct Keychain {
    pub service: &'static str,
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    pub what: &'static str,
}

#[cfg(target_os = "macos")]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        match security_framework::passwords::get_generic_password(self.service, account) {
            // A value that is not text was not written by this program
            Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
            Err(e) => from_keychain_status(e.code()),
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(self.service, account, secret.as_bytes()).map_err(|e| format!("The Keychain refused the token: {e}"))
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        match security_framework::passwords::delete_generic_password(self.service, account) {
            Ok(()) => Ok(()),
            Err(e) => from_keychain_status(e.code()).map(drop),
        }
    }
}

/// A Keychain status in place of a secret (`SecBase.h`): only
/// errSecItemNotFound says that there is none.
#[cfg(any(target_os = "macos", test))]
fn from_keychain_status(status: i32) -> Result<Option<String>, Unavailable> {
    match status {
        // errSecItemNotFound
        -25300 => Ok(None),
        // errSecInteractionNotAllowed: locked, and no prompt may be shown
        -25308 => Err(Unavailable("the Keychain is locked")),
        // errSecAuthFailed, errSecUserCanceled: the prompt was refused or dismissed
        -25293 | -128 => Err(Unavailable("access to the Keychain was refused")),
        _ => Err(Unavailable("the Keychain could not be read")),
    }
}

/// Windows Credential Manager, a generic credential per token, kept for this user only.
#[cfg(windows)]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
        let target = wide(&format!("{}/{account}", self.service));
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is NUL-terminated; on success `found` is freed with CredFree below.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) == 0 {
                // Asked at once, before another call can change the thread's last error
                return from_credential_error(std::io::Error::last_os_error().raw_os_error());
            }
            if found.is_null() {
                return Err(CREDENTIALS_UNREAD);
            }
            let blob = std::slice::from_raw_parts((*found).CredentialBlob, (*found).CredentialBlobSize as usize).to_vec();
            CredFree(found.cast());
            Ok(String::from_utf8(blob).ok())
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        use windows_sys::Win32::Security::Credentials::{CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
        let mut target = wide(&format!("{}/{account}", self.service));
        let mut blob = secret.as_bytes().to_vec();
        // SAFETY: zeroed CREDENTIALW is valid; the pointers outlive the call, which copies them.
        let written = unsafe {
            let mut credential: CREDENTIALW = std::mem::zeroed();
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = target.as_mut_ptr();
            credential.CredentialBlobSize = blob.len() as u32;
            credential.CredentialBlob = blob.as_mut_ptr();
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            CredWriteW(&credential, 0)
        };
        if written == 0 {
            return Err(format!("Windows Credential Manager refused the token: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
        let target = wide(&format!("{}/{account}", self.service));
        // SAFETY: `target` is NUL-terminated.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            return from_credential_error(std::io::Error::last_os_error().raw_os_error()).map(drop);
        }
        Ok(())
    }
}

#[cfg(any(windows, test))]
const CREDENTIALS_UNREAD: Unavailable = Unavailable("Windows Credential Manager could not be read");

/// The error of a Credential Manager call in place of a secret: only
/// ERROR_NOT_FOUND says that there is none.
#[cfg(any(windows, test))]
fn from_credential_error(code: Option<i32>) -> Result<Option<String>, Unavailable> {
    match code {
        // ERROR_NOT_FOUND
        Some(1168) => Ok(None),
        _ => Err(CREDENTIALS_UNREAD),
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// No secret store on other systems: connecting fails instead of keeping a
/// token in a file. Since nothing can be kept, nothing is there.
#[cfg(not(any(target_os = "macos", windows)))]
impl Vault for Keychain {
    fn get(&self, _: &str) -> Result<Option<String>, Unavailable> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err(format!("{} are kept in the macOS Keychain or Windows Credential Manager ({}); this system has neither", self.what, self.service))
    }
    fn delete(&self, _: &str) -> Result<(), Unavailable> {
        Ok(())
    }
}

/// A vault for tests: nothing leaves the process. While it is made to refuse
/// (`refuse`), it answers as a locked store would: nothing is read, written or
/// removed, and nothing is said about what it holds.
#[cfg(test)]
#[derive(Default)]
pub struct Held(pub std::sync::Mutex<std::collections::BTreeMap<String, String>>, std::sync::Mutex<Option<Unavailable>>);

#[cfg(test)]
impl Held {
    /// Answer as a store that cannot be read (`Some`), or normally again (`None`).
    pub fn refuse(&self, why: Option<Unavailable>) {
        *self.1.lock().unwrap() = why;
    }

    fn refused(&self) -> Result<(), Unavailable> {
        match *self.1.lock().unwrap() {
            Some(why) => Err(why),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
impl Vault for Held {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        self.refused()?;
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.refused().map_err(|why| why.0.to_string())?;
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        self.refused()?;
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// A test keeps the vault it hands over, to look into it and to make it refuse.
#[cfg(test)]
impl Vault for std::sync::Arc<Held> {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        (**self).get(account)
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        (**self).set(account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        (**self).delete(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_stores_own_not_found_means_that_a_secret_is_missing() {
        assert_eq!(from_keychain_status(-25300), Ok(None));
        assert_eq!(from_keychain_status(-25308), Err(Unavailable("the Keychain is locked")));
        assert_eq!(from_keychain_status(-128), Err(Unavailable("access to the Keychain was refused")));
        // errSecAuthFailed, errSecNotAvailable, errSecNoSuchKeychain, and a status of no known meaning
        for status in [-25293, -25291, -25294, -1] {
            assert!(from_keychain_status(status).is_err(), "{status}");
        }
        assert_eq!(from_credential_error(Some(1168)), Ok(None));
        // ERROR_NO_SUCH_LOGON_SESSION, ERROR_ACCESS_DENIED, and no error code at all
        for code in [Some(1312), Some(5), None] {
            assert_eq!(from_credential_error(code), Err(CREDENTIALS_UNREAD), "{code:?}");
        }
    }
}
