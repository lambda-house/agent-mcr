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
    /// Keep `secret` in place of what is there. The reason it was not kept is
    /// in fixed words, as for `get`: the store's own error is not passed on.
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable>;
    /// A secret that is not there counts as removed.
    fn delete(&self, account: &str) -> Result<(), Unavailable>;

    /// Read the secrets of `accounts`, then remove them, within `within`
    /// (about, for stores that answer at once): what each held, as `get`
    /// says it, and the first reason one could not be removed. What was not
    /// begun in time is `TOO_LATE`.
    fn take(&self, accounts: &[&str], within: std::time::Duration) -> Taken {
        take_each(self, accounts, within)
    }
}

/// `Vault::take` as a loop of `get`, then `delete`, that begins nothing
/// once its time is up
pub fn take_each(vault: &(impl Vault + ?Sized), accounts: &[&str], within: std::time::Duration) -> Taken {
    let until = std::time::Instant::now() + within;
    let late = || std::time::Instant::now() >= until;
    let values = accounts.iter().map(|account| if late() { Err(TOO_LATE) } else { vault.get(account) }).collect();
    let mut removed = Ok(());
    for account in accounts {
        if let Err(why) = if late() { Err(TOO_LATE) } else { vault.delete(account) } {
            removed = removed.and(Err(why));
        }
    }
    (values, removed)
}

/// What `take` found under each account, and whether all were removed
pub type Taken = (Vec<Result<Option<String>, Unavailable>>, Result<(), Unavailable>);

/// A secret store that did not answer within the time a call had
pub const TOO_LATE: Unavailable = Unavailable("the secret store did not answer in time");

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

    /// A Keychain whose keyring is a fake, for tests
    #[cfg(all(test, target_os = "linux"))]
    fn with_keyring(service: &'static str, what: &'static str, keyring: keyring::Keyring) -> Self {
        Self { service, what, keyring }
    }
}

/// The secret store as the person knows it, for the app's dialogs. The page
/// has the same words (`secretStoreName` in `utils/harness.ts`).
pub const STORE_NAME: &str = if cfg!(target_os = "macos") {
    "the macOS Keychain"
} else if cfg!(windows) {
    "Windows Credential Manager"
} else if cfg!(target_os = "linux") {
    "your desktop keyring"
} else {
    "a secret store"
};

/// What the person should know before a secret is kept there: Credential
/// Manager and the Secret Service keep no rule per program, and a locked
/// keyring asks for its password first.
pub const STORE_NOTE: Option<&str> = if cfg!(windows) {
    Some("Other programs that run as you, agents included, can read it there while you are logged in.")
} else if cfg!(target_os = "linux") {
    Some("Other programs that run as you, agents included, can read it there while the keyring is unlocked. A locked keyring asks for its password first.")
} else {
    None
};

/// Unlock the desktop keyring because the person asked for it in the app: the
/// keyring shows its own prompt, waited for at most two minutes. Only the app
/// calls this, on the person's action, and it reads no secret; the harness
/// service never unlocks (MCR-177). Nothing to do on other systems.
pub fn unlock() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (done, finished) = std::sync::mpsc::channel();
        // A prompt nobody answers keeps this thread, not the caller
        std::thread::spawn(move || {
            let _ = done.send(keyring::unlock_default());
        });
        match finished.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(unlocked) => unlocked.map_err(|why| format!("The keyring could not be unlocked: {}", why.0)),
            Err(_) => Err("The keyring was not unlocked within two minutes".into()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[cfg(target_os = "macos")]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        match security_framework::passwords::get_generic_password(self.service, account) {
            Ok(bytes) => text_of(bytes).map(Some),
            Err(e) => from_keychain_status(e.code()),
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable> {
        security_framework::passwords::set_generic_password(self.service, account, secret.as_bytes()).map_err(|e| unwritten_keychain(e.code()))
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        match security_framework::passwords::delete_generic_password(self.service, account) {
            Ok(()) => Ok(()),
            Err(e) => from_keychain_status(e.code()).map(drop),
        }
    }
}

/// Why the Keychain did not keep a secret, in fixed words
#[cfg(any(target_os = "macos", test))]
fn unwritten_keychain(status: i32) -> Unavailable {
    match from_keychain_status(status) {
        Err(why) => why,
        Ok(_) => Unavailable("the Keychain did not keep the secret"),
    }
}

/// A secret as text. A value that is not text was not written by this
/// program: it is no missing secret, because a missing token ends a sign-in.
#[cfg_attr(not(any(target_os = "macos", windows, target_os = "linux")), allow(dead_code))]
fn text_of(bytes: Vec<u8>) -> Result<String, Unavailable> {
    String::from_utf8(bytes).map_err(|_| NOT_TEXT)
}

const NOT_TEXT: Unavailable = Unavailable("the secret store holds a value this program did not write");

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
            text_of(blob).map(Some)
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable> {
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
            return Err(Unavailable("Windows Credential Manager did not keep the secret"));
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
/// `account` attributes. A locked collection is never unlocked here, and no
/// confirmation the keyring asks for is ever shown, because both ask the person
/// (MCR-177): the service reads, writes and removes only while the collection
/// is open, and is `Unavailable` otherwise. Unlike the macOS Keychain, the
/// Secret Service keeps no rule per program: any program of the person can
/// read these items while the collection is open.
#[cfg(target_os = "linux")]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        let (service, account) = (self.service, account.to_string());
        let found = self.keyring.run(move |collection| {
            let Some(item) = collection.search(&keyring::attributes(service, &account))?.into_iter().next() else { return Ok(None) };
            collection.secret(&item).map(Some)
        })?;
        found.map(text_of).transpose()
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable> {
        let (service, label, account, secret) = (self.service, format!("Agent MCR: {} ({account})", self.what), account.to_string(), secret.to_string());
        self.keyring.run(move |collection| collection.create(&label, &keyring::attributes(service, &account), secret.as_bytes()))
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        let (service, account) = (self.service, account.to_string());
        self.keyring.run(move |collection| {
            for item in collection.search(&keyring::attributes(service, &account))? {
                collection.delete(&item)?;
            }
            Ok(())
        })
    }
    /// One job with one deadline, not one per account: a disconnect waits for
    /// the keyring at most `within`
    fn take(&self, accounts: &[&str], within: std::time::Duration) -> Taken {
        let (service, names) = (self.service, accounts.iter().map(|a| a.to_string()).collect::<Vec<_>>());
        let taken = self.keyring.run_within(within, move |collection| {
            let (mut values, mut items) = (Vec::new(), Vec::new());
            for account in &names {
                let found = collection.search(&keyring::attributes(service, account))?;
                values.push(match found.first() {
                    None => Ok(None),
                    Some(item) => collection.secret(item).map(Some),
                });
                items.extend(found);
            }
            let mut removed = Ok(());
            for item in &items {
                if let Err(fault) = collection.delete(item) {
                    removed = removed.and(Err(fault));
                }
            }
            Ok((values, removed))
        });
        match taken {
            Ok((values, removed)) => (values.into_iter().map(|value| value.map_err(|fault| keyring::words(&fault)).and_then(|found| found.map(text_of).transpose())).collect(), removed.map_err(|fault| keyring::words(&fault))),
            Err(why) => (vec![Err(why); accounts.len()], Err(why)),
        }
    }
}

/// The one thread per vault that talks to the Secret Service, through a small
/// client of our own: the `secret-service` crate shows the keyring's prompt
/// whenever a reply asks for one (`CreateItem`, `Item.Delete`) and then waits
/// for it without a limit, and its calls cannot be told not to. Here a reply
/// that asks for a prompt is dismissed and the call is `Unavailable`;
/// `Prompt.Prompt` is never called. A vault call is answered by `DEADLINE`, and
/// the job behind it starts no D-Bus call once that time is up or the caller
/// has given up, because the keyring can hold an answer back (a confirmation it
/// waits for, a daemon that is still starting), and a vault call must hold up
/// neither a sign-in's lock nor the app's ten seconds.
#[cfg(target_os = "linux")]
mod keyring {
    use super::Unavailable;
    use num_bigint::BigUint;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex, PoisonError};
    use std::time::{Duration, Instant};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    /// The most a vault call waits for the keyring
    pub const DEADLINE: Duration = Duration::from_secs(5);
    /// The most one D-Bus call may take
    const CALL: Duration = Duration::from_secs(3);
    pub const LOCKED: Unavailable = Unavailable("the keyring is locked");
    pub const NO_SERVICE: Unavailable = Unavailable("no Secret Service is running (gnome-keyring, KWallet or KeePassXC)");
    pub const UNREAD: Unavailable = Unavailable("the keyring could not be read");
    pub const LATE: Unavailable = Unavailable("the keyring did not answer in time");
    pub const PROMPTED: Unavailable = Unavailable("the keyring asked for a confirmation that was not given");
    const NO_DEFAULT: Unavailable = Unavailable("there is no default keyring");
    const NO_BUS: Unavailable = Unavailable("the D-Bus session bus could not be reached");

    const SECRETS: &str = "org.freedesktop.secrets";
    const SERVICE: &str = "/org/freedesktop/secrets";
    const ALGORITHM_DH: &str = "dh-ietf1024-sha256-aes128-cbc-pkcs7";
    const ALGORITHM_PLAIN: &str = "plain";
    const NOT_SUPPORTED: &str = "org.freedesktop.DBus.Error.NotSupported";
    /// The most of a D-Bus error name that goes to the log
    const MAX_NAME: usize = 128;

    pub type Path = OwnedObjectPath;
    /// A secret as the Secret Service sends it: the session, the parameters
    /// (the IV of an encrypted session), the value and its content type
    pub type Secret = (Path, Vec<u8>, Vec<u8>, String);

    /// What went wrong, in this program's words only: of the keyring's own
    /// answer at most the D-Bus error name is kept, never its message, which
    /// the keyring writes and which may hold what it was given (`CreateItem`
    /// carries the credential).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Fault {
        Locked,
        NoDefault,
        NoService,
        NoBus,
        /// The reply asked for a prompt, which was dismissed
        Prompted,
        /// A D-Bus call ran out of its own time
        TimedOut,
        /// No time was left to begin a call, or the caller had given up
        Late,
        Crypto(&'static str),
        /// An error reply, by its name (`MAX_NAME`, `[A-Za-z0-9._]` only)
        Refused(String),
        /// An error of the connection or the message, by its kind
        Broken(&'static str),
    }

    /// The calls one vault call may make: to the Secret Service, or a fake.
    /// There is no way to show a prompt here: a prompt can only be dismissed.
    pub trait Provider: Send {
        /// `Service.OpenSession`: with the public key for an encrypted session
        /// (the server's key comes back), with none for a plain one
        fn open_session(&self, public: Option<Vec<u8>>) -> Result<(Option<Vec<u8>>, Path), Fault>;
        /// `Service.ReadAlias("default")`
        fn default_collection(&self) -> Result<Path, Fault>;
        /// The collection's `Locked` property
        fn locked(&self, collection: &Path) -> Result<bool, Fault>;
        /// `Collection.SearchItems`
        fn search(&self, collection: &Path, attributes: &HashMap<&str, &str>) -> Result<Vec<Path>, Fault>;
        /// `Item.GetSecret`
        fn secret(&self, item: &Path, session: &Path) -> Result<Secret, Fault>;
        /// `Collection.CreateItem`: the item and the prompt
        fn create(&self, collection: &Path, label: &str, attributes: &HashMap<&str, &str>, secret: Secret, replace: bool) -> Result<(Path, Path), Fault>;
        /// `Item.Delete`: the prompt
        fn delete(&self, item: &Path) -> Result<Path, Fault>;
        /// `Prompt.Dismiss`
        fn dismiss(&self, prompt: &Path) -> Result<(), Fault>;
    }

    pub type Connect = Arc<dyn Fn() -> Result<Box<dyn Provider>, Fault> + Send + Sync>;

    /// The connection and session the thread keeps from one call to the next
    struct Link {
        provider: Box<dyn Provider>,
        session: Session,
    }
    type Job = Box<dyn FnOnce(&mut Option<Link>) + Send>;

    /// Started at the first call, and again when it is gone.
    pub struct Keyring {
        jobs: Mutex<Option<mpsc::Sender<Job>>>,
        deadline: Duration,
        connect: Connect,
    }

    impl Default for Keyring {
        fn default() -> Self {
            Self::with(DEADLINE, Arc::new(|| Bus::connect().map(|bus| Box::new(bus) as Box<dyn Provider>)))
        }
    }

    pub fn attributes<'s>(service: &'s str, account: &'s str) -> HashMap<&'s str, &'s str> {
        HashMap::from([("service", service), ("account", account)])
    }

    /// The time one vault call has, and whether its caller still waits
    struct Calls {
        until: Instant,
        gave_up: Arc<AtomicBool>,
    }

    impl Calls {
        fn over(&self) -> bool {
            self.gave_up.load(Ordering::SeqCst) || Instant::now() >= self.until
        }

        /// One D-Bus call, begun only while there is time left for it
        fn ask<T>(&self, call: impl FnOnce() -> Result<T, Fault>) -> Result<T, Fault> {
            if self.over() {
                return Err(Fault::Late);
            }
            call()
        }
    }

    /// The default collection while it is unlocked, for one vault call
    pub struct Collection<'a> {
        provider: &'a dyn Provider,
        session: &'a Session,
        path: Path,
        calls: &'a Calls,
    }

    impl Collection<'_> {
        pub fn search(&self, attributes: &HashMap<&str, &str>) -> Result<Vec<Path>, Fault> {
            self.calls.ask(|| self.provider.search(&self.path, attributes))
        }

        pub fn secret(&self, item: &Path) -> Result<Vec<u8>, Fault> {
            let (_, parameters, value, _) = self.calls.ask(|| self.provider.secret(item, &self.session.path))?;
            self.session.unseal(&parameters, &value)
        }

        /// Keep `secret` under `attributes`, in place of what is there. A
        /// `CreateItem` that was sent before the caller gave up can still land
        /// after it was told that the keyring did not answer: the keyring then
        /// keeps what was asked, and the next `set` replaces it.
        pub fn create(&self, label: &str, attributes: &HashMap<&str, &str>, secret: &[u8]) -> Result<(), Fault> {
            let sealed = self.session.seal(secret)?;
            let (_, prompt) = self.calls.ask(|| self.provider.create(&self.path, label, attributes, sealed, true))?;
            self.no_prompt(&prompt)
        }

        pub fn delete(&self, item: &Path) -> Result<(), Fault> {
            let prompt = self.calls.ask(|| self.provider.delete(item))?;
            self.no_prompt(&prompt)
        }

        /// A reply that asks for a prompt did nothing yet: the prompt is
        /// dismissed, never shown
        fn no_prompt(&self, prompt: &Path) -> Result<(), Fault> {
            if prompt.as_str() == "/" {
                return Ok(());
            }
            if let Err(fault) = self.calls.ask(|| self.provider.dismiss(prompt)) {
                note(&fault);
            }
            Err(Fault::Prompted)
        }
    }

    impl Keyring {
        pub fn with(deadline: Duration, connect: Connect) -> Self {
            Self { jobs: Mutex::new(None), deadline, connect }
        }

        /// `act` on the default collection while it is unlocked, answered by
        /// the deadline. A job whose caller gave up begins no call any more.
        pub fn run<T: Send + 'static>(&self, act: impl FnOnce(&Collection) -> Result<T, Fault> + Send + 'static) -> Result<T, Unavailable> {
            self.run_within(self.deadline, act)
        }

        /// `run`, answered by `within` when that is sooner than the deadline
        pub fn run_within<T: Send + 'static>(&self, within: Duration, act: impl FnOnce(&Collection) -> Result<T, Fault> + Send + 'static) -> Result<T, Unavailable> {
            let deadline = within.min(self.deadline);
            let (answer, answered) = mpsc::channel();
            let gave_up = Arc::new(AtomicBool::new(false));
            let calls = Calls { until: Instant::now() + deadline, gave_up: gave_up.clone() };
            let connect = self.connect.clone();
            self.send(Box::new(move |link| {
                if !calls.over() {
                    let _ = answer.send(on_default(link, &connect, &calls, act));
                }
            }))?;
            answered.recv_timeout(deadline).unwrap_or_else(|e| {
                gave_up.store(true, Ordering::SeqCst);
                Err(match e {
                    mpsc::RecvTimeoutError::Timeout => LATE,
                    mpsc::RecvTimeoutError::Disconnected => UNREAD,
                })
            })
        }

        fn send(&self, job: Job) -> Result<(), Unavailable> {
            let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
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
    fn on_default<T>(link: &mut Option<Link>, connect: &Connect, calls: &Calls, act: impl FnOnce(&Collection) -> Result<T, Fault>) -> Result<T, Unavailable> {
        attempt(link, connect, calls, act).map_err(|fault| {
            // A locked keyring, a dismissed prompt or a call never begun is no broken connection
            if !matches!(fault, Fault::Locked | Fault::NoDefault | Fault::Prompted | Fault::Late) {
                *link = None;
            }
            note(&fault);
            why(&fault)
        })
    }

    fn attempt<T>(link: &mut Option<Link>, connect: &Connect, calls: &Calls, act: impl FnOnce(&Collection) -> Result<T, Fault>) -> Result<T, Fault> {
        if link.is_none() {
            let provider = calls.ask(|| connect())?;
            let session = Session::open(calls, &*provider)?;
            *link = Some(Link { provider, session });
        }
        let Some(Link { provider, session }) = link.as_ref() else { return Err(Fault::Broken("connection")) };
        let path = calls.ask(|| provider.default_collection())?;
        if calls.ask(|| provider.locked(&path))? {
            return Err(Fault::Locked);
        }
        act(&Collection { provider: &**provider, session, path, calls })
    }

    /// The session's key exchange and cipher: dh-ietf1024-sha256-aes128-cbc-pkcs7
    /// as the Secret Service specifies it, after the `secret-service` crate's
    /// `session.rs` (MIT or Apache-2.0), or plain when the keyring refuses that.
    pub struct Session {
        path: Path,
        key: Option<[u8; 16]>,
    }

    /// The 1024-bit MODP group of RFC 2409 (the Second Oakley Group), generator 2
    const DH_PRIME: [u8; 128] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xC9, 0x0F, 0xDA, 0xA2, 0x21, 0x68, 0xC2, 0x34, 0xC4, 0xC6, 0x62, 0x8B, 0x80, 0xDC, 0x1C, 0xD1, 0x29, 0x02, 0x4E, 0x08, 0x8A, 0x67, 0xCC, 0x74, 0x02, 0x0B, 0xBE, 0xA6, 0x3B, 0x13, 0x9B, 0x22, 0x51, 0x4A, 0x08, 0x79, 0x8E, 0x34, 0x04, 0xDD, 0xEF, 0x95, 0x19, 0xB3, 0xCD, 0x3A, 0x43, 0x1B, 0x30, 0x2B, 0x0A, 0x6D, 0xF2, 0x5F, 0x14, 0x37, 0x4F, 0xE1, 0x35, 0x6D, 0x6D, 0x51, 0xC2, 0x45, 0xE4, 0x85, 0xB5, 0x76, 0x62, 0x5E, 0x7E, 0xC6, 0xF4, 0x4C, 0x42, 0xE9, 0xA6, 0x37, 0xED, 0x6B, 0x0B, 0xFF, 0x5C, 0xB6, 0xF4, 0x06, 0xB7, 0xED, 0xEE, 0x38, 0x6B, 0xFB, 0x5A, 0x89, 0x9F, 0xA5, 0xAE, 0x9F, 0x24, 0x11, 0x7C, 0x4B, 0x1F, 0xE6, 0x49, 0x28, 0x66, 0x51, 0xEC, 0xE6, 0x53, 0x81, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    ];

    /// A private key and its public half
    pub fn keypair() -> Result<(BigUint, BigUint), Fault> {
        let mut private = [0u8; 128];
        getrandom_secret::fill(&mut private).map_err(|_| Fault::Crypto("no random numbers"))?;
        let private = BigUint::from_bytes_be(&private);
        let public = BigUint::from(2u32).modpow(&private, &BigUint::from_bytes_be(&DH_PRIME));
        Ok((private, public))
    }

    /// The AES key both sides derive from the exchange
    pub fn shared_key(private: &BigUint, theirs: &[u8]) -> Result<[u8; 16], Fault> {
        let common = BigUint::from_bytes_be(theirs).modpow(private, &BigUint::from_bytes_be(&DH_PRIME)).to_bytes_be();
        let mut padded = vec![0u8; 128usize.saturating_sub(common.len())];
        padded.extend_from_slice(&common);
        let mut key = [0u8; 16];
        hkdf::Hkdf::<sha2_secret::Sha256>::new(None, &padded).expand(&[], &mut key).map_err(|_| Fault::Crypto("the session key could not be derived"))?;
        Ok(key)
    }

    pub fn encrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Result<Vec<u8>, Fault> {
        use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
        let cipher = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| Fault::Crypto("bad session key"))?;
        Ok(cipher.encrypt_padded_vec::<Pkcs7>(data))
    }

    pub fn decrypt(data: &[u8], key: &[u8; 16], iv: &[u8]) -> Result<Vec<u8>, Fault> {
        use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
        let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| Fault::Crypto("the secret has an invalid initialization vector"))?;
        cipher.decrypt_padded_vec::<Pkcs7>(data).map_err(|_| Fault::Crypto("the secret could not be decrypted"))
    }

    impl Session {
        fn open(calls: &Calls, provider: &dyn Provider) -> Result<Self, Fault> {
            let (private, public) = keypair()?;
            match calls.ask(|| provider.open_session(Some(public.to_bytes_be()))) {
                Ok((Some(theirs), path)) => Ok(Self { path, key: Some(shared_key(&private, &theirs)?) }),
                Ok((None, _)) => Err(Fault::Crypto("the keyring sent no session key")),
                Err(Fault::Refused(name)) if name == NOT_SUPPORTED => {
                    let (_, path) = calls.ask(|| provider.open_session(None))?;
                    Ok(Self { path, key: None })
                }
                Err(fault) => Err(fault),
            }
        }

        fn seal(&self, secret: &[u8]) -> Result<Secret, Fault> {
            let Some(key) = &self.key else { return Ok((self.path.clone(), Vec::new(), secret.to_vec(), "text/plain".into())) };
            let mut iv = [0u8; 16];
            getrandom_secret::fill(&mut iv).map_err(|_| Fault::Crypto("no random numbers"))?;
            Ok((self.path.clone(), iv.to_vec(), encrypt(secret, key, &iv)?, "text/plain".into()))
        }

        fn unseal(&self, parameters: &[u8], value: &[u8]) -> Result<Vec<u8>, Fault> {
            match &self.key {
                Some(key) => decrypt(value, key, parameters),
                None => Ok(value.to_vec()),
            }
        }
    }

    /// The Secret Service on the session bus, every call with a time limit
    struct Bus(zbus::blocking::Connection);

    impl Bus {
        fn connect() -> Result<Self, Fault> {
            zbus::blocking::connection::Builder::session().and_then(|bus| bus.method_timeout(CALL).build()).map(Self).map_err(|e| match fault_of(&e) {
                Fault::NoService => Fault::NoBus,
                fault => fault,
            })
        }

        fn call<B, R>(&self, path: &str, interface: &str, method: &str, body: &B) -> Result<R, Fault>
        where
            B: serde::Serialize + zbus::zvariant::DynamicType,
            R: serde::de::DeserializeOwned + zbus::zvariant::Type,
        {
            let reply = self.0.call_method(Some(SECRETS), path, Some(interface), method, body).map_err(|e| fault_of(&e))?;
            reply.body().deserialize::<R>().map_err(|e| fault_of(&e))
        }
    }

    impl Provider for Bus {
        fn open_session(&self, public: Option<Vec<u8>>) -> Result<(Option<Vec<u8>>, Path), Fault> {
            let (output, path): (OwnedValue, Path) = match public {
                Some(public) => self.call(SERVICE, "org.freedesktop.Secret.Service", "OpenSession", &(ALGORITHM_DH, Value::from(public)))?,
                None => self.call(SERVICE, "org.freedesktop.Secret.Service", "OpenSession", &(ALGORITHM_PLAIN, Value::from("")))?,
            };
            let theirs = match Vec::<u8>::try_from(output) {
                Ok(key) if !key.is_empty() => Some(key),
                _ => None,
            };
            Ok((theirs, path))
        }
        fn default_collection(&self) -> Result<Path, Fault> {
            let path: Path = self.call(SERVICE, "org.freedesktop.Secret.Service", "ReadAlias", &"default")?;
            if path.as_str() == "/" {
                return Err(Fault::NoDefault);
            }
            Ok(path)
        }
        fn locked(&self, collection: &Path) -> Result<bool, Fault> {
            let locked: OwnedValue = self.call(collection.as_str(), "org.freedesktop.DBus.Properties", "Get", &("org.freedesktop.Secret.Collection", "Locked"))?;
            bool::try_from(locked).map_err(|_| Fault::Broken("reply"))
        }
        fn search(&self, collection: &Path, attributes: &HashMap<&str, &str>) -> Result<Vec<Path>, Fault> {
            self.call(collection.as_str(), "org.freedesktop.Secret.Collection", "SearchItems", attributes)
        }
        fn secret(&self, item: &Path, session: &Path) -> Result<Secret, Fault> {
            let (secret,): (Secret,) = self.call(item.as_str(), "org.freedesktop.Secret.Item", "GetSecret", session)?;
            Ok(secret)
        }
        fn create(&self, collection: &Path, label: &str, attributes: &HashMap<&str, &str>, secret: Secret, replace: bool) -> Result<(Path, Path), Fault> {
            let properties = HashMap::from([("org.freedesktop.Secret.Item.Label", Value::from(label)), ("org.freedesktop.Secret.Item.Attributes", Value::from(attributes.clone()))]);
            self.call(collection.as_str(), "org.freedesktop.Secret.Collection", "CreateItem", &(properties, secret, replace))
        }
        fn delete(&self, item: &Path) -> Result<Path, Fault> {
            self.call(item.as_str(), "org.freedesktop.Secret.Item", "Delete", &())
        }
        fn dismiss(&self, prompt: &Path) -> Result<(), Fault> {
            self.0.call_method(Some(SECRETS), prompt.as_str(), Some("org.freedesktop.Secret.Prompt"), "Dismiss", &()).map(drop).map_err(|e| fault_of(&e))
        }
    }

    /// Unlock the default collection through the keyring's own prompt, on a
    /// connection of its own: the vault's thread never waits for a prompt. The
    /// one place that may show one, and only the app calls it.
    pub(super) fn unlock_default() -> Result<(), Unavailable> {
        use secret_service::blocking::SecretService;
        use secret_service::{EncryptionType, Error};
        let words = |e: Error| match e {
            Error::Locked => LOCKED,
            Error::NoResult => NO_DEFAULT,
            Error::Unavailable => NO_SERVICE,
            Error::Prompt | Error::PromptDisconnected => Unavailable("the unlock was cancelled"),
            Error::Zbus(e) => {
                let fault = fault_of(&e);
                note(&fault);
                why(&fault)
            }
            _ => UNREAD,
        };
        let bus = || zbus::blocking::connection::Builder::session().and_then(|bus| bus.method_timeout(CALL).build()).map_err(|_| NO_BUS);
        let service = match SecretService::connect_with_existing(EncryptionType::Dh, bus()?) {
            Err(Error::Zbus(e)) if fault_of(&e) == Fault::Refused(NOT_SUPPORTED.into()) => SecretService::connect_with_existing(EncryptionType::Plain, bus()?),
            connected => connected,
        }
        .map_err(words)?;
        let collection = service.get_default_collection().map_err(words)?;
        if collection.is_locked().map_err(words)? {
            collection.unlock().map_err(words)?;
        }
        Ok(())
    }

    /// A zbus error in this program's words: the name of an error reply, never
    /// its message
    pub fn fault_of(e: &zbus::Error) -> Fault {
        use std::io::ErrorKind;
        use zbus::DBusError;
        let name = match e {
            zbus::Error::MethodError(name, _, _) => name.as_str().to_string(),
            zbus::Error::FDO(fdo) => fdo.name().as_str().to_string(),
            zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) if io.kind() == ErrorKind::TimedOut => return Fault::TimedOut,
            zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) if io.kind() == ErrorKind::NotFound => return Fault::NoService,
            zbus::Error::InterfaceNotFound | zbus::Error::Address(_) => return Fault::NoService,
            zbus::Error::InputOutput(_) | zbus::Error::Connection(..) => return Fault::Broken("input or output"),
            zbus::Error::Handshake(_) => return Fault::Broken("handshake"),
            zbus::Error::Variant(_) | zbus::Error::InvalidReply | zbus::Error::MissingField | zbus::Error::InvalidField | zbus::Error::ExcessData => return Fault::Broken("reply"),
            _ => return Fault::Broken("other"),
        };
        match name.as_str() {
            "org.freedesktop.Secret.Error.IsLocked" => Fault::Locked,
            "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" => Fault::NoService,
            "org.freedesktop.DBus.Error.NoReply" | "org.freedesktop.DBus.Error.Timeout" | "org.freedesktop.DBus.Error.TimedOut" => Fault::TimedOut,
            _ => Fault::Refused(name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_')).take(MAX_NAME).collect()),
        }
    }

    /// The fixed words for what the keyring answered in place of a secret
    pub fn why(fault: &Fault) -> Unavailable {
        match fault {
            Fault::Locked => LOCKED,
            Fault::NoDefault => NO_DEFAULT,
            Fault::NoService => NO_SERVICE,
            Fault::NoBus => NO_BUS,
            Fault::Prompted => PROMPTED,
            Fault::TimedOut | Fault::Late => LATE,
            Fault::Crypto(_) | Fault::Refused(_) | Fault::Broken(_) => UNREAD,
        }
    }

    /// The service's log line for an unexpected answer: what kind of error and
    /// the D-Bus error name, in this program's words; nothing else of it
    pub fn log_line(fault: &Fault) -> Option<String> {
        match fault {
            Fault::Refused(name) => Some(format!("vault: the keyring refused the call: {name}")),
            Fault::Broken(kind) => Some(format!("vault: the keyring connection failed: {kind}")),
            Fault::Crypto(what) => Some(format!("vault: {what}")),
            _ => None,
        }
    }

    /// `why`, with the log line for an unexpected answer
    pub fn words(fault: &Fault) -> Unavailable {
        note(fault);
        why(fault)
    }

    fn note(fault: &Fault) {
        if let Some(line) = log_line(fault) {
            eprintln!("{line}");
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
    fn set(&self, _: &str, _: &str) -> Result<(), Unavailable> {
        Err(Unavailable("secrets are kept in the macOS Keychain, Windows Credential Manager or a Linux desktop's Secret Service, and this system has none of them"))
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
pub struct Held(
    pub std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    std::sync::Mutex<Option<Unavailable>>,
    std::sync::Mutex<std::collections::BTreeMap<String, Unavailable>>,
    std::sync::Mutex<Option<std::time::Duration>>,
    /// The time each `take` was given, in order
    pub std::sync::Mutex<Vec<std::time::Duration>>,
    /// How long the next call alone takes
    std::sync::Mutex<Option<std::time::Duration>>,
);

#[cfg(test)]
impl Held {
    /// Answer as a store that cannot be read (`Some`), or normally again (`None`).
    pub fn refuse(&self, why: Option<Unavailable>) {
        *self.1.lock().unwrap() = why;
    }

    /// Refuse to keep a secret under `account` only (`Some`), or keep it again
    /// (`None`); everything else is answered normally.
    pub fn refuse_set(&self, account: &str, why: Option<Unavailable>) {
        let mut refused = self.2.lock().unwrap();
        match why {
            Some(why) => refused.insert(account.into(), why),
            None => refused.remove(account),
        };
    }

    /// Take this long over every call (`Some`), or answer at once (`None`)
    pub fn slow(&self, each: Option<std::time::Duration>) {
        *self.3.lock().unwrap() = each;
    }

    /// Take this long over the next call only
    pub fn slow_next(&self, by: std::time::Duration) {
        *self.5.lock().unwrap() = Some(by);
    }

    fn refused(&self) -> Result<(), Unavailable> {
        let next = self.5.lock().unwrap().take();
        let slow = next.or(*self.3.lock().unwrap());
        if let Some(slow) = slow {
            std::thread::sleep(slow);
        }
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
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable> {
        self.refused()?;
        if let Some(why) = self.2.lock().unwrap().get(account) {
            return Err(*why);
        }
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        self.refused()?;
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
    fn take(&self, accounts: &[&str], within: std::time::Duration) -> Taken {
        self.4.lock().unwrap().push(within);
        take_each(self, accounts, within)
    }
}

/// A test keeps the vault it hands over, to look into it and to make it refuse.
#[cfg(test)]
impl Vault for std::sync::Arc<Held> {
    fn get(&self, account: &str) -> Result<Option<String>, Unavailable> {
        (**self).get(account)
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), Unavailable> {
        (**self).set(account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), Unavailable> {
        (**self).delete(account)
    }
    fn take(&self, accounts: &[&str], within: std::time::Duration) -> Taken {
        (**self).take(accounts, within)
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
        // A secret that was not kept says why in the same words, and never that it is missing
        assert_eq!(unwritten_keychain(-25308), Unavailable("the Keychain is locked"));
        assert_eq!(unwritten_keychain(-25300), Unavailable("the Keychain did not keep the secret"));
        assert_eq!(from_credential_error(Some(1168)), Ok(None));
        // ERROR_NO_SUCH_LOGON_SESSION, ERROR_ACCESS_DENIED, and no error code at all
        for code in [Some(1312), Some(5), None] {
            assert_eq!(from_credential_error(code), Err(CREDENTIALS_UNREAD), "{code:?}");
        }
    }

    #[test]
    fn take_stops_at_its_time_and_says_so() {
        use std::time::Duration;
        let held = Held::default();
        held.set("a", "synthetic-a").unwrap();
        held.set("b", "synthetic-b").unwrap();
        assert_eq!(held.take(&["a", "b"], Duration::from_secs(1)), (vec![Ok(Some("synthetic-a".into())), Ok(Some("synthetic-b".into()))], Ok(())));
        assert!(held.0.lock().unwrap().is_empty());
        held.set("a", "synthetic-a").unwrap();
        held.slow(Some(Duration::from_millis(150)));
        let (values, removed) = held.take(&["a", "b"], Duration::from_millis(100));
        assert_eq!(values, [Ok(Some("synthetic-a".into())), Err(TOO_LATE)]);
        assert_eq!(removed, Err(TOO_LATE));
        assert!(!held.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_value_that_is_not_text_is_no_missing_secret() {
        assert_eq!(text_of(b"synthetic-not-a-token".to_vec()), Ok("synthetic-not-a-token".into()));
        assert_eq!(text_of(vec![0xff, 0xfe, 0x00]), Err(Unavailable("the secret store holds a value this program did not write")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn what_the_keyring_answers_is_said_in_fixed_words() {
        use keyring::{fault_of, why, Fault};
        assert_eq!(why(&Fault::Locked), Unavailable("the keyring is locked"));
        assert_eq!(why(&Fault::NoDefault), Unavailable("there is no default keyring"));
        assert_eq!(why(&Fault::NoService), Unavailable("no Secret Service is running (gnome-keyring, KWallet or KeePassXC)"));
        assert_eq!(why(&Fault::Prompted), Unavailable("the keyring asked for a confirmation that was not given"));
        assert_eq!(why(&Fault::Late), Unavailable("the keyring did not answer in time"));
        assert_eq!(why(&Fault::Crypto("bad padding")), Unavailable("the keyring could not be read"));
        let timed_out = zbus::Error::InputOutput(std::sync::Arc::new(std::io::ErrorKind::TimedOut.into()));
        assert_eq!(fault_of(&timed_out), Fault::TimedOut);
        assert_eq!(fault_of(&zbus::Error::FDO(Box::new(zbus::fdo::Error::ServiceUnknown("synthetic".into())))), Fault::NoService);
    }

    /// The keyring writes an error's message itself, and `CreateItem` hands it
    /// the credential: no part of a message reaches the log line
    #[cfg(target_os = "linux")]
    #[test]
    fn the_log_line_holds_the_error_name_and_never_its_message() {
        use keyring::{fault_of, log_line, Fault};
        let token = "xoxb-synthetic-0000-not-a-token";
        let reply = zbus::Message::method_call("/", "CreateItem").unwrap().build(&()).unwrap();
        let name = zbus::names::OwnedErrorName::try_from("org.example.Keyring.Error.Rejected").unwrap();
        let refused = fault_of(&zbus::Error::MethodError(name, Some(format!("could not store {token}")), reply));
        assert_eq!(refused, Fault::Refused("org.example.Keyring.Error.Rejected".into()));
        let line = log_line(&refused).unwrap();
        assert!(line.contains("org.example.Keyring.Error.Rejected") && !line.contains(token), "{line}");
        let failed = fault_of(&zbus::Error::FDO(Box::new(zbus::fdo::Error::Failed(token.into()))));
        let line = log_line(&failed).unwrap();
        assert!(line.contains("org.freedesktop.DBus.Error.Failed") && !line.contains(token), "{line}");
        let broken = fault_of(&zbus::Error::Failure(token.into()));
        assert!(!log_line(&broken).unwrap().contains(token));
        // A name is cut to its first 128 characters
        let long = format!("org.example.{}", "a".repeat(200));
        let reply = zbus::Message::method_call("/", "Get").unwrap().build(&()).unwrap();
        let Fault::Refused(kept) = fault_of(&zbus::Error::MethodError(zbus::names::OwnedErrorName::try_from(long.as_str()).unwrap(), None, reply)) else { panic!() };
        assert_eq!(kept.len(), 128);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_session_key_is_the_same_on_both_sides_and_seals_a_secret() {
        use keyring::{decrypt, encrypt, keypair, shared_key};
        let (ours, our_public) = keypair().unwrap();
        let (theirs, their_public) = keypair().unwrap();
        let key = shared_key(&ours, &their_public.to_bytes_be()).unwrap();
        assert_eq!(key, shared_key(&theirs, &our_public.to_bytes_be()).unwrap());
        let iv = [7u8; 16];
        let sealed = encrypt(b"synthetic-secret", &key, &iv).unwrap();
        assert_ne!(sealed, b"synthetic-secret");
        assert_eq!(decrypt(&sealed, &key, &iv).unwrap(), b"synthetic-secret");
        assert!(decrypt(&sealed, &key, &[0u8; 3]).is_err());
    }

    /// A Secret Service in memory that keeps a log of every call made to it.
    /// It refuses an encrypted session, so the client falls back to plain.
    #[cfg(target_os = "linux")]
    mod fake {
        use super::super::keyring::{Fault, Path, Provider, Secret};
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        #[derive(Default)]
        pub struct State {
            pub calls: Vec<&'static str>,
            /// item path → (service, account, value)
            pub items: HashMap<String, (String, String, Vec<u8>)>,
            pub locked: bool,
            /// Answer `CreateItem` and `Item.Delete` with a prompt
            pub prompt: bool,
            /// How long each of the next searches takes
            pub slow: Vec<Duration>,
            pub made: usize,
        }

        #[derive(Clone, Default)]
        pub struct Fake(pub Arc<Mutex<State>>);

        fn path(p: &str) -> Path {
            Path::try_from(p).unwrap()
        }

        impl Fake {
            pub fn calls(&self) -> Vec<&'static str> {
                self.0.lock().unwrap().calls.clone()
            }
            fn log(&self, call: &'static str) -> std::sync::MutexGuard<'_, State> {
                let mut state = self.0.lock().unwrap();
                state.calls.push(call);
                state
            }
        }

        impl Provider for Fake {
            fn open_session(&self, public: Option<Vec<u8>>) -> Result<(Option<Vec<u8>>, Path), Fault> {
                drop(self.log("OpenSession"));
                match public {
                    Some(_) => Err(Fault::Refused("org.freedesktop.DBus.Error.NotSupported".into())),
                    None => Ok((None, path("/org/freedesktop/secrets/session/s1"))),
                }
            }
            fn default_collection(&self) -> Result<Path, Fault> {
                drop(self.log("ReadAlias"));
                Ok(path("/org/freedesktop/secrets/collection/login"))
            }
            fn locked(&self, _: &Path) -> Result<bool, Fault> {
                Ok(self.log("Locked").locked)
            }
            fn search(&self, _: &Path, attributes: &HashMap<&str, &str>) -> Result<Vec<Path>, Fault> {
                let slow = {
                    let mut state = self.log("SearchItems");
                    if state.slow.is_empty() { None } else { Some(state.slow.remove(0)) }
                };
                if let Some(slow) = slow {
                    std::thread::sleep(slow);
                }
                let state = self.0.lock().unwrap();
                Ok(state.items.iter().filter(|(_, (service, account, _))| Some(&service.as_str()) == attributes.get("service") && Some(&account.as_str()) == attributes.get("account")).map(|(p, _)| path(p)).collect())
            }
            fn secret(&self, item: &Path, session: &Path) -> Result<Secret, Fault> {
                let state = self.log("GetSecret");
                let (_, _, value) = state.items.get(item.as_str()).ok_or(Fault::Refused("org.freedesktop.Secret.Error.NoSuchObject".into()))?;
                Ok((session.clone(), Vec::new(), value.clone(), "text/plain".into()))
            }
            fn create(&self, _: &Path, _: &str, attributes: &HashMap<&str, &str>, secret: Secret, replace: bool) -> Result<(Path, Path), Fault> {
                let mut state = self.log("CreateItem");
                if state.prompt {
                    return Ok((path("/"), path("/org/freedesktop/secrets/prompt/p1")));
                }
                assert!(replace);
                let (service, account) = (attributes["service"].to_string(), attributes["account"].to_string());
                state.items.retain(|_, (s, a, _)| *s != service || *a != account);
                state.made += 1;
                let item = format!("/org/freedesktop/secrets/collection/login/{}", state.made);
                state.items.insert(item.clone(), (service, account, secret.2));
                Ok((path(&item), path("/")))
            }
            fn delete(&self, item: &Path) -> Result<Path, Fault> {
                let mut state = self.log("Delete");
                if state.prompt {
                    return Ok(path("/org/freedesktop/secrets/prompt/p2"));
                }
                state.items.remove(item.as_str());
                Ok(path("/"))
            }
            fn dismiss(&self, _: &Path) -> Result<(), Fault> {
                drop(self.log("Dismiss"));
                Ok(())
            }
        }

        pub fn keychain(fake: &Fake, deadline: Duration) -> super::Keychain {
            let fake = fake.clone();
            let keyring = super::super::keyring::Keyring::with(deadline, Arc::new(move || Ok(Box::new(fake.clone()) as Box<dyn Provider>)));
            super::Keychain::with_keyring("cc.lambdahouse.agent-mcr.test", "Test secrets", keyring)
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_client_keeps_reads_replaces_and_removes_a_secret() {
        let fake = fake::Fake::default();
        let keychain = fake::keychain(&fake, std::time::Duration::from_secs(5));
        assert_eq!(keychain.get("a"), Ok(None));
        keychain.set("a", "synthetic-one").unwrap();
        keychain.set("a", "synthetic-two").unwrap();
        assert_eq!(keychain.get("a"), Ok(Some("synthetic-two".into())));
        keychain.delete("a").unwrap();
        assert_eq!(keychain.get("a"), Ok(None));
        // An encrypted session is asked for first, then a plain one, once
        assert_eq!(fake.calls().iter().filter(|c| **c == "OpenSession").count(), 2);
        // A value that is not text is no missing secret
        fake.0.lock().unwrap().items.insert("/org/freedesktop/secrets/collection/login/x".into(), ("cc.lambdahouse.agent-mcr.test".into(), "b".into(), vec![0xff, 0xfe]));
        assert_eq!(keychain.get("b"), Err(Unavailable("the secret store holds a value this program did not write")));
        // A locked collection is said so, and nothing in it is searched
        fake.0.lock().unwrap().locked = true;
        let before = fake.calls().len();
        assert_eq!(keychain.get("a"), Err(Unavailable("the keyring is locked")));
        assert!(!fake.calls()[before..].contains(&"SearchItems"));
    }

    /// A reply that asks for a prompt is dismissed, never shown: the provider
    /// has no call that could show one, and the vault call is unavailable
    #[cfg(target_os = "linux")]
    #[test]
    fn a_reply_that_asks_for_a_prompt_is_dismissed_and_unavailable() {
        let fake = fake::Fake::default();
        let keychain = fake::keychain(&fake, std::time::Duration::from_secs(5));
        keychain.set("a", "synthetic-one").unwrap();
        fake.0.lock().unwrap().prompt = true;
        assert_eq!(keychain.set("a", "synthetic-two"), Err(Unavailable("the keyring asked for a confirmation that was not given")));
        assert_eq!(keychain.delete("a"), Err(Unavailable("the keyring asked for a confirmation that was not given")));
        let calls = fake.calls();
        assert_eq!(calls.iter().filter(|c| **c == "Dismiss").count(), 2, "{calls:?}");
        assert!(!calls.contains(&"Prompt"));
        // What was there stays, and the connection is kept
        fake.0.lock().unwrap().prompt = false;
        assert_eq!(keychain.get("a"), Ok(Some("synthetic-one".into())));
        assert_eq!(fake.calls().iter().filter(|c| **c == "OpenSession").count(), 2);
    }

    /// A disconnect reads and removes every account in one job, with one deadline
    #[cfg(target_os = "linux")]
    #[test]
    fn take_reads_and_removes_every_account_in_one_job() {
        use std::time::{Duration, Instant};
        let fake = fake::Fake::default();
        let keychain = fake::keychain(&fake, Duration::from_secs(5));
        keychain.set("a", "synthetic-a").unwrap();
        keychain.set("c", "synthetic-c").unwrap();
        let (values, removed) = keychain.take(&["a", "b", "c"], Duration::from_secs(3));
        assert_eq!(values, [Ok(Some("synthetic-a".into())), Ok(None), Ok(Some("synthetic-c".into()))]);
        assert_eq!(removed, Ok(()));
        assert!(fake.0.lock().unwrap().items.is_empty());
        // The whole job answers within the time it is given, not a deadline per account
        keychain.set("a", "synthetic-a").unwrap();
        fake.0.lock().unwrap().slow = vec![Duration::from_millis(400); 3];
        let asked = Instant::now();
        let (values, removed) = keychain.take(&["a", "b", "c"], Duration::from_millis(200));
        assert!(asked.elapsed() < Duration::from_millis(300), "{:?}", asked.elapsed());
        assert_eq!(values, vec![Err(Unavailable("the keyring did not answer in time")); 3]);
        assert_eq!(removed, Err(Unavailable("the keyring did not answer in time")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_late_reply_is_answered_by_the_deadline_and_the_worker_serves_the_next_job() {
        use std::time::{Duration, Instant};
        let deadline = Duration::from_millis(150);
        let fake = fake::Fake::default();
        let keychain = fake::keychain(&fake, deadline);
        fake.0.lock().unwrap().slow = vec![Duration::from_millis(500)];
        let asked = Instant::now();
        assert_eq!(keychain.get("a"), Err(Unavailable("the keyring did not answer in time")));
        assert!(asked.elapsed() < deadline + Duration::from_millis(100), "{:?}", asked.elapsed());
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(keychain.get("a"), Ok(None));
    }

    /// Inside one job: once the time is up, the next D-Bus call of the job is
    /// not begun (`Calls::ask`), though the job itself had started in time
    #[cfg(target_os = "linux")]
    #[test]
    fn no_call_of_a_job_begins_after_its_time_is_up() {
        use std::time::Duration;
        let fake = fake::Fake::default();
        let keychain = fake::keychain(&fake, Duration::from_millis(150));
        keychain.set("a", "synthetic-a").unwrap();
        // The search finds the item, but only after the time is up
        fake.0.lock().unwrap().slow = vec![Duration::from_millis(400)];
        assert_eq!(keychain.get("a"), Err(Unavailable("the keyring did not answer in time")));
        std::thread::sleep(Duration::from_millis(400));
        let calls = fake.calls();
        assert_eq!(calls.last(), Some(&"SearchItems"), "{calls:?}");
        assert!(!calls.contains(&"GetSecret"), "{calls:?}");
        // The next job reads it
        assert_eq!(keychain.get("a"), Ok(Some("synthetic-a".into())));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_call_the_caller_gave_up_on_is_never_started() {
        use std::time::Duration;
        let deadline = Duration::from_millis(150);
        let fake = fake::Fake::default();
        let keychain = std::sync::Arc::new(fake::keychain(&fake, deadline));
        fake.0.lock().unwrap().slow = vec![Duration::from_millis(500)];
        let first = {
            let keychain = keychain.clone();
            std::thread::spawn(move || keychain.get("a"))
        };
        std::thread::sleep(Duration::from_millis(30));
        // Queued behind the slow search, and given up on before the worker is free
        assert_eq!(keychain.set("a", "synthetic-late"), Err(Unavailable("the keyring did not answer in time")));
        assert_eq!(first.join().unwrap(), Err(Unavailable("the keyring did not answer in time")));
        std::thread::sleep(Duration::from_millis(600));
        // The first job made its calls up to the slow search and stopped there; the second made none
        assert_eq!(fake.calls(), ["OpenSession", "OpenSession", "ReadAlias", "Locked", "SearchItems"]);
        assert!(fake.0.lock().unwrap().items.is_empty());
        assert_eq!(keychain.get("a"), Ok(None));
    }

    /// Run by hand on a Linux desktop: `cargo test live_unlock -- --ignored`.
    /// A locked keyring shows its own prompt and waits for the person; an
    /// unlocked one is left as it is. `live_keyring` can run after it.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn live_unlock_shows_the_keyrings_own_prompt() {
        unlock().unwrap();
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
