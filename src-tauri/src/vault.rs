//! Where the service keeps credentials: the macOS Keychain, Windows
//! Credential Manager or, on Linux, the desktop's Secret Service; one service
//! name per connector. A secret read from here never goes into a state file, a
//! status, a tool result or a log line.

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

/// The system's secret store under one service name: the macOS Keychain, on
/// Windows a generic credential `<service>/<account>`, on Linux an item of the
/// Secret Service's default collection. `what` names the secrets in messages
/// to the person ("Slack tokens").
pub struct Keychain {
    service: &'static str,
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    what: &'static str,
    #[cfg(target_os = "linux")]
    keyring: keyring::Keyring,
}

impl Keychain {
    pub fn new(service: &'static str, what: &'static str) -> Self {
        Self {
            service,
            what,
            #[cfg(target_os = "linux")]
            keyring: keyring::Keyring::default(),
        }
    }
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

/// The desktop's Secret Service over D-Bus (gnome-keyring, KWallet, KeePassXC):
/// one item per account in the default collection, found by its `service` and
/// `account` attributes. A locked collection is never unlocked here, because
/// that asks the person (MCR-177): the service reads, writes and removes only
/// while it is open, and is `Unavailable` otherwise. Unlike the macOS Keychain,
/// the Secret Service keeps no rule per program: any program of the person
/// can read these items while the collection is open.
#[cfg(target_os = "linux")]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        let (service, account) = (self.service, account.to_string());
        self.keyring.run(move |collection| {
            let Some(item) = collection.search_items(keyring::attributes(service, &account))?.into_iter().next() else { return Ok(None) };
            // A value that is not text was not written by this program
            Ok(String::from_utf8(item.get_secret()?).ok())
        })
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let (service, label, account, secret) = (self.service, format!("Agent MCR: {} ({account})", self.what), account.to_string(), secret.to_string());
        self.keyring
            .run(move |collection| collection.create_item(&label, keyring::attributes(service, &account), secret.as_bytes(), true, "text/plain").map(drop))
            .map_err(|why| format!("{} could not be kept in the keyring: {}", self.what, why.0))
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        let (service, account) = (self.service, account.to_string());
        self.keyring.run(move |collection| {
            for item in collection.search_items(keyring::attributes(service, &account))? {
                item.delete()?;
            }
            Ok(())
        })
    }
}

/// The one thread per vault that talks to the Secret Service. A call waits for
/// it at most `DEADLINE`, because the keyring can hold an answer back (a
/// confirmation it asks for, a daemon that is still starting), and a vault call
/// must hold up neither a sign-in's lock nor the app's ten seconds.
#[cfg(target_os = "linux")]
mod keyring {
    use super::Unavailable;
    use secret_service::blocking::{Collection, SecretService};
    use secret_service::{EncryptionType, Error};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex, PoisonError};
    use std::time::Duration;

    /// The most a vault call waits for the keyring
    const DEADLINE: Duration = Duration::from_secs(5);
    /// The most one D-Bus call may take
    const CALL: Duration = Duration::from_secs(3);
    const LOCKED: Unavailable = Unavailable("the keyring is locked");
    const NO_SERVICE: Unavailable = Unavailable("no Secret Service is running (gnome-keyring, KWallet or KeePassXC)");
    const UNREAD: Unavailable = Unavailable("the keyring could not be read");

    /// The connection and session the thread keeps from one call to the next
    type Link = Option<SecretService<'static>>;
    type Job = Box<dyn FnOnce(&mut Link) + Send>;

    /// Started at the first call, and again when it is gone.
    #[derive(Default)]
    pub struct Keyring(Mutex<Option<mpsc::Sender<Job>>>);

    pub fn attributes<'s>(service: &'s str, account: &'s str) -> HashMap<&'s str, &'s str> {
        HashMap::from([("service", service), ("account", account)])
    }

    impl Keyring {
        /// `act` on the default collection while it is unlocked, answered by
        /// `DEADLINE`. A call that was given up on is not begun any more.
        pub fn run<T: Send + 'static>(&self, act: impl for<'c> FnOnce(&'c Collection<'c>) -> Result<T, Error> + Send + 'static) -> Result<T, Unavailable> {
            let (answer, answered) = mpsc::channel();
            let gave_up = Arc::new(AtomicBool::new(false));
            let late = gave_up.clone();
            self.send(Box::new(move |link| {
                if !late.load(Ordering::SeqCst) {
                    let _ = answer.send(on_default(link, act));
                }
            }))?;
            answered.recv_timeout(DEADLINE).unwrap_or_else(|e| {
                gave_up.store(true, Ordering::SeqCst);
                Err(match e {
                    mpsc::RecvTimeoutError::Timeout => Unavailable("the keyring did not answer in time"),
                    mpsc::RecvTimeoutError::Disconnected => UNREAD,
                })
            })
        }

        fn send(&self, job: Job) -> Result<(), Unavailable> {
            let mut jobs = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            let job = match jobs.as_ref() {
                Some(sender) => match sender.send(job) {
                    Ok(()) => return Ok(()),
                    // The thread is gone (a call panicked): another one takes over
                    Err(mpsc::SendError(job)) => job,
                },
                None => job,
            };
            let (sender, received) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("keyring".into())
                .spawn(move || {
                    let mut link = None;
                    for job in received {
                        job(&mut link);
                    }
                })
                .map_err(|_| UNREAD)?;
            let sent = sender.send(job).map_err(|_| UNREAD);
            *jobs = Some(sender);
            sent
        }
    }

    /// `act` on the default collection, connecting first when there is no
    /// connection. A connection that failed is dropped and made again next time.
    fn on_default<T>(link: &mut Link, act: impl for<'c> FnOnce(&'c Collection<'c>) -> Result<T, Error>) -> Result<T, Unavailable> {
        if link.is_none() {
            *link = Some(connect()?);
        }
        let Some(service) = link.as_ref() else { return Err(UNREAD) };
        let done = service.get_default_collection().and_then(|collection| {
            if collection.is_locked()? {
                return Err(Error::Locked);
            }
            act(&collection)
        });
        done.map_err(|e| {
            // A locked keyring, or one without a default collection, is no broken connection
            if !matches!(e, Error::Locked | Error::NoResult) {
                *link = None;
            }
            why(&e)
        })
    }

    /// A session bus connection with a time limit on every call, and a session
    /// with the Secret Service: encrypted, or plain when the service refuses that.
    fn connect() -> Result<SecretService<'static>, Unavailable> {
        let bus = || zbus::blocking::connection::Builder::session().and_then(|bus| bus.method_timeout(CALL).build()).map_err(|_| Unavailable("the D-Bus session bus could not be reached"));
        match SecretService::connect_with_existing(EncryptionType::Dh, bus()?) {
            Err(e) if error_name(&e).as_deref() == Some("org.freedesktop.DBus.Error.NotSupported") => SecretService::connect_with_existing(EncryptionType::Plain, bus()?).map_err(|e| why(&e)),
            connected => connected.map_err(|e| why(&e)),
        }
    }

    /// The D-Bus error name of a refusal, when the keyring answered with one.
    fn error_name(e: &Error) -> Option<String> {
        use zbus::DBusError;
        match e {
            Error::Zbus(zbus::Error::MethodError(name, _, _)) => Some(name.to_string()),
            Error::Zbus(zbus::Error::FDO(fdo)) => Some(fdo.name().to_string()),
            Error::ZbusFdo(fdo) => Some(fdo.name().to_string()),
            _ => None,
        }
    }

    /// The fixed words for what the keyring answered in place of a secret. What
    /// it said itself goes to the service's log, and only when it is unexpected.
    pub(super) fn why(e: &Error) -> Unavailable {
        match e {
            Error::Locked => LOCKED,
            Error::NoResult => Unavailable("there is no default keyring"),
            Error::Unavailable => NO_SERVICE,
            Error::Prompt | Error::PromptDisconnected => Unavailable("the keyring asked for a confirmation that was not given"),
            Error::Zbus(zbus::Error::InputOutput(io)) if io.kind() == std::io::ErrorKind::TimedOut => Unavailable("the keyring did not answer in time"),
            _ => match error_name(e).as_deref() {
                Some("org.freedesktop.Secret.Error.IsLocked") => LOCKED,
                Some("org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner") => NO_SERVICE,
                _ => {
                    eprintln!("vault: the keyring answered: {e}");
                    UNREAD
                }
            },
        }
    }
}

/// No secret store on other systems: connecting fails instead of keeping a
/// token in a file. Since nothing can be kept, nothing is there.
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl Vault for Keychain {
    fn get(&self, _: &str) -> Result<Option<String>, Unavailable> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err(format!("{} are kept in the macOS Keychain, Windows Credential Manager or a Linux desktop's Secret Service ({}); this system has none of them", self.what, self.service))
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

    #[cfg(target_os = "linux")]
    #[test]
    fn what_the_keyring_answers_is_said_in_fixed_words() {
        use secret_service::Error;
        assert_eq!(keyring::why(&Error::Locked), Unavailable("the keyring is locked"));
        assert_eq!(keyring::why(&Error::NoResult), Unavailable("there is no default keyring"));
        assert_eq!(keyring::why(&Error::Unavailable), Unavailable("no Secret Service is running (gnome-keyring, KWallet or KeePassXC)"));
        assert_eq!(keyring::why(&Error::Prompt), Unavailable("the keyring asked for a confirmation that was not given"));
        let timed_out = Error::Zbus(zbus::Error::InputOutput(std::sync::Arc::new(std::io::ErrorKind::TimedOut.into())));
        assert_eq!(keyring::why(&timed_out), Unavailable("the keyring did not answer in time"));
        assert_eq!(keyring::why(&Error::Crypto("bad padding")), Unavailable("the keyring could not be read"));
    }

    /// Run by hand on a Linux desktop whose keyring is unlocked:
    /// `cargo test live_keyring -- --ignored`. It keeps, reads, replaces and
    /// removes one item under a service name of its own, and leaves nothing
    /// behind. With the keyring locked it fails at the first read, saying so.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn live_keyring_keeps_replaces_and_removes_a_secret() {
        let service: &'static str = Box::leak(format!("cc.lambdahouse.agent-mcr.test-{}", std::process::id()).into_boxed_str());
        let keychain = Keychain::new(service, "Test secrets");
        assert_eq!(keychain.get("a"), Ok(None));
        keychain.set("a", "one").unwrap();
        assert_eq!(keychain.get("a"), Ok(Some("one".into())));
        keychain.set("a", "two").unwrap();
        assert_eq!(keychain.get("a"), Ok(Some("two".into())));
        keychain.delete("a").unwrap();
        assert_eq!(keychain.get("a"), Ok(None));
        // A secret that is not there is removed already
        keychain.delete("a").unwrap();
    }
}
