//! Where the service keeps credentials: the macOS Keychain or Windows
//! Credential Manager, one service name per connector. A secret read from
//! here never goes into a state file, a status, a tool result or a log line.

/// A store of secrets, by account name.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str);
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
    fn get(&self, account: &str) -> Option<String> {
        security_framework::passwords::get_generic_password(self.service, account).ok().and_then(|b| String::from_utf8(b).ok())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(self.service, account, secret.as_bytes()).map_err(|e| format!("The Keychain refused the token: {e}"))
    }
    fn delete(&self, account: &str) {
        let _ = security_framework::passwords::delete_generic_password(self.service, account);
    }
}

/// Windows Credential Manager, a generic credential per token, kept for this user only.
#[cfg(windows)]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Option<String> {
        use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
        let target = wide(&format!("{}/{account}", self.service));
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is NUL-terminated; on success `found` is freed with CredFree below.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) == 0 || found.is_null() {
                return None;
            }
            let blob = std::slice::from_raw_parts((*found).CredentialBlob, (*found).CredentialBlobSize as usize).to_vec();
            CredFree(found.cast());
            String::from_utf8(blob).ok()
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
    fn delete(&self, account: &str) {
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
        let target = wide(&format!("{}/{account}", self.service));
        // SAFETY: `target` is NUL-terminated.
        unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// No secret store on other systems: connecting fails instead of keeping a token in a file.
#[cfg(not(any(target_os = "macos", windows)))]
impl Vault for Keychain {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err(format!("{} are kept in the macOS Keychain or Windows Credential Manager ({}); this system has neither", self.what, self.service))
    }
    fn delete(&self, _: &str) {}
}

/// A vault for tests: nothing leaves the process.
#[cfg(test)]
#[derive(Default)]
pub struct Held(pub std::sync::Mutex<std::collections::BTreeMap<String, String>>);

#[cfg(test)]
impl Vault for Held {
    fn get(&self, account: &str) -> Option<String> {
        self.0.lock().unwrap().get(account).cloned()
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) {
        self.0.lock().unwrap().remove(account);
    }
}
