//! Where the service keeps credentials: the macOS Keychain, one service name
//! per connector. A secret read from here never goes into a state file, a
//! status, a tool result or a log line.

/// A store of secrets, by account name.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str);
}

/// The macOS Keychain under one service name; `what` names the secrets in
/// messages to the person ("Slack tokens").
pub struct Keychain {
    pub service: &'static str,
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

#[cfg(not(target_os = "macos"))]
impl Vault for Keychain {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err(format!("{} are kept in the macOS Keychain ({}); this system has none", self.what, self.service))
    }
    fn delete(&self, _: &str) {}
}
