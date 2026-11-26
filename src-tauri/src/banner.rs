//! macOS banners under the app's own name, and what a click on one opens
//! (MCR-180). The harness service posts them; the session a banner is about
//! rides in its request identifier, so a click can show that session
//! instead of only bringing Agent MCR forward.
//!
//! macOS hands the click to a process of the bundle: the app or the service
//! that posted it. Both listen. The app opens the session at once; the
//! service keeps it for the app to take (`take_clicked`), which the app asks
//! for when its window comes forward.

/// Request identifiers of banners about a session: `session/<id>/<random>`.
const SESSION_PREFIX: &str = "session/";
/// A click the service kept is stale after this long: the app missed it
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLICK_KEEP_MS: u64 = 60_000;

/// The request identifier of a banner, naming its session if it has one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn identifier(session: Option<&str>, random: &str) -> String {
    match session.filter(|s| !s.is_empty() && !s.contains('/')) {
        Some(s) => format!("{SESSION_PREFIX}{s}/{random}"),
        None => random.to_string(),
    }
}

/// The session a banner's request identifier names.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn session_of(identifier: &str) -> Option<&str> {
    let rest = identifier.strip_prefix(SESSION_PREFIX)?;
    let (session, _) = rest.split_once('/')?;
    (!session.is_empty()).then_some(session)
}

/// The click the service kept for the app, with when it came.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static CLICKED: std::sync::Mutex<Option<(String, u64)>> = std::sync::Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Keep a click for the app (in the service).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keep_clicked(session: String) {
    *CLICKED.lock().unwrap_or_else(|e| e.into_inner()) = Some((session, now_ms()));
}

/// The session of the last banner clicked in this process, once, if it is recent.
pub fn take_clicked() -> Option<String> {
    let taken = CLICKED.lock().unwrap_or_else(|e| e.into_inner()).take();
    taken.filter(|(_, at)| now_ms().saturating_sub(*at) <= CLICK_KEEP_MS).map(|(s, _)| s)
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationDefaultActionIdentifier, UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    /// The notification centre raises an exception in a process outside an app bundle
    fn bundled() -> bool {
        std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
    }

    pub struct Ivars {
        opened: Box<dyn Fn(String) + Send + Sync>,
    }

    define_class!(
        // The centre calls it on a queue of its own, not on the main thread
        #[unsafe(super(NSObject))]
        #[name = "AgentMcrBannerDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                // A click on the banner itself; a dismissal or another action opens nothing
                let default = unsafe { UNNotificationDefaultActionIdentifier };
                if response.actionIdentifier().isEqualToString(default) {
                    let id = response.notification().request().identifier().to_string();
                    if let Some(session) = super::session_of(&id) {
                        (self.ivars().opened)(session.to_string());
                    }
                }
                done.call(());
            }
        }
    );

    /// Hear clicks on this bundle's banners that macOS hands to this process.
    /// Call it early: a click that launches the app is handed over at launch.
    pub fn listen(opened: Box<dyn Fn(String) + Send + Sync>) {
        if !bundled() { return; }
        let this = Delegate::alloc().set_ivars(Ivars { opened });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(this), init] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The centre holds its delegate weakly: this one lives as long as the process
        std::mem::forget(delegate);
    }

    #[allow(unused_unsafe)]
    pub fn post(title: &str, text: &str, session: Option<&str>) {
        if !bundled() { return; }
        unsafe {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(text));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            // One session's banners stay together in Notification Centre
            if let Some(session) = session {
                content.setThreadIdentifier(&NSString::from_str(session));
            }
            let id = super::identifier(session, &crate::runner::random_id());
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
            let adder = center.clone();
            // macOS asks the person once; later calls return the stored answer
            let decided = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
                if granted.as_bool() { adder.addNotificationRequest_withCompletionHandler(&request, None); }
                else { eprintln!("harness: notifications are not allowed for Agent MCR"); }
            });
            center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &decided);
        }
    }
}

/// Post a banner; `session` is the one a click on it opens.
pub fn post(title: &str, text: &str, session: Option<&str>) {
    #[cfg(target_os = "macos")]
    mac::post(title, &text.chars().take(200).collect::<String>(), session);
    #[cfg(not(target_os = "macos"))]
    let _ = (title, text, session);
}

/// In the app: open the clicked banner's session with `opened`.
pub fn listen_in_app(opened: impl Fn(String) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(opened));
    #[cfg(not(target_os = "macos"))]
    let _ = opened;
}

/// In the service: keep the clicked banner's session for the app.
pub fn listen_in_service() {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(keep_clicked));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_banner_about_a_session_names_it_in_its_identifier() {
        let id = identifier(Some("29cc09974512"), "r1");
        assert_eq!(id, "session/29cc09974512/r1");
        assert_eq!(session_of(&id), Some("29cc09974512"));
        // One about no session, or about a name that would not parse back, opens nothing
        assert_eq!(identifier(None, "r2"), "r2");
        assert_eq!(identifier(Some(""), "r3"), "r3");
        assert_eq!(identifier(Some("a/b"), "r4"), "r4");
        assert_eq!(session_of("r2"), None);
        assert_eq!(session_of("session//r5"), None);
        assert_eq!(session_of("session/x"), None);
    }

    #[test]
    fn a_kept_click_is_taken_once_and_only_while_recent() {
        keep_clicked("s1".into());
        assert_eq!(take_clicked().as_deref(), Some("s1"));
        assert_eq!(take_clicked(), None);
        *CLICKED.lock().unwrap() = Some(("s2".into(), now_ms() - CLICK_KEEP_MS - 1));
        assert_eq!(take_clicked(), None);
    }
}
