//! macOS banners under the app's own name, and what a click on one opens
//! (MCR-180). The harness service posts them; the session a banner is about
//! rides in its request identifier, so a click can show that session
//! instead of only bringing Agent MCR forward.
//!
//! macOS hands the click to a process of the bundle: the app or the service
//! that posted it. Both listen, and in both the latest click wins: a click
//! on a banner about no session takes back an earlier one. The service keeps
//! it until `CLICK_KEEP` has passed, for the app to take with the control op
//! `banner_clicked` (`take_clicked`). The app keeps what it has to open until
//! its page takes it (`take_open`): a click that launched the app arrives
//! before the page listens.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Request identifiers of banners about a session: `session/<id>/<random>`.
const SESSION_PREFIX: &str = "session/";
/// How long the service keeps a click for the app. The app asks while its
/// window has the focus, and macOS brings it forward at the click, so a
/// click the app has not taken by then is not taken at a later, unrelated
/// focus
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLICK_KEEP: Duration = Duration::from_secs(10);
/// After the app's window gains the focus it asks the service this often,
/// for `FOCUS_BURST`; then every `FOCUSED_EVERY` while it keeps the focus
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FOCUS_STEP: Duration = Duration::from_millis(250);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FOCUS_BURST: Duration = Duration::from_secs(3);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FOCUSED_EVERY: Duration = Duration::from_secs(2);

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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// In the service: the latest click, its session (none for a banner about
/// none) and until when it is kept. A monotonic clock: a wall clock set back
/// would keep a stale click.
static CLICKED: Mutex<Option<(Option<String>, Instant)>> = Mutex::new(None);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keep_clicked(session: Option<String>, now: Instant) {
    *lock(&CLICKED) = Some((session, now + CLICK_KEEP));
}

fn take_clicked_at(now: Instant) -> Option<String> {
    lock(&CLICKED).take().filter(|(_, until)| now < *until).and_then(|(s, _)| s)
}

/// In the service: the session of the latest banner clicked here, once, while it is kept.
pub fn take_clicked() -> Option<String> {
    take_clicked_at(Instant::now())
}

/// In the app: what the latest click asks the page to open, until the page takes it.
static OPEN: Mutex<Option<String>> = Mutex::new(None);

/// In the app: a click to open; a click on a banner about no session takes back an earlier one.
pub fn set_open(session: Option<String>) {
    *lock(&OPEN) = session;
}

/// In the app: the session the page is to open, once.
pub fn take_open() -> Option<String> {
    lock(&OPEN).take()
}

/// When the app's window gained the focus, while it has it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static FOCUSED_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

/// In the app: the main window gained or lost the focus.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn window_focused(focused: bool) {
    *lock(&FOCUSED_SINCE) = focused.then(Instant::now);
}

/// Whether the app asks the service now: only while its window has the
/// focus, often just after it gained it (the click that brought it forward
/// may reach the service a moment later), then now and then (a click while
/// the window already had the focus brings no new focus).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ask_now(focused_since: Option<Instant>, last_asked: Option<Instant>, now: Instant) -> bool {
    let Some(since) = focused_since else { return false };
    let Some(last) = last_asked.filter(|last| *last >= since) else { return true };
    let gap = now.saturating_duration_since(last);
    if now.saturating_duration_since(since) < FOCUS_BURST { gap >= FOCUS_STEP } else { gap >= FOCUSED_EVERY }
}

/// In the app: ask the service for clicks it was handed, on its own thread
/// for as long as the app runs. `ask` is one request; it must not start the
/// service.
#[cfg(target_os = "macos")]
pub fn watch_service(ask: impl Fn() -> Option<String> + Send + 'static, opened: impl Fn(String) + Send + 'static) {
    std::thread::spawn(move || {
        let mut last: Option<Instant> = None;
        loop {
            std::thread::sleep(FOCUS_STEP / 2);
            let now = Instant::now();
            if !ask_now(*lock(&FOCUSED_SINCE), last, now) { continue; }
            last = Some(now);
            if let Some(session) = ask() {
                opened(session);
            }
        }
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    /// The notification centre raises an exception in a process outside an app bundle
    fn bundled() -> bool {
        std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
    }

    pub struct Ivars {
        clicked: Box<dyn Fn(Option<String>) + Send + Sync>,
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
                    (self.ivars().clicked)(super::session_of(&id).map(str::to_owned));
                }
                done.call(());
            }

            // A delegate without this hides a banner while the app is in front;
            // the operator is told whatever they look at
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, show: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                show.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }
        }
    );

    /// Hear clicks on this bundle's banners that macOS hands to this process.
    /// Call it early: a click that launches the app is handed over at launch.
    pub fn listen(clicked: Box<dyn Fn(Option<String>) + Send + Sync>) {
        if !bundled() { return; }
        let this = Delegate::alloc().set_ivars(Ivars { clicked });
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

/// In the app: hand every click on a banner to `clicked` (none: a banner about no session).
pub fn listen_in_app(clicked: impl Fn(Option<String>) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(clicked));
    #[cfg(not(target_os = "macos"))]
    let _ = clicked;
}

/// In the service: keep the clicked banner's session for the app.
pub fn listen_in_service() {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(|session| keep_clicked(session, Instant::now())));
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

    // CLICKED is one slot per process: the service's tests of it run in one test
    #[test]
    fn the_service_keeps_the_latest_click_once_and_only_until_its_deadline() {
        let t = Instant::now();
        keep_clicked(Some("s1".into()), t);
        assert_eq!(take_clicked_at(t + Duration::from_secs(1)).as_deref(), Some("s1"));
        assert_eq!(take_clicked_at(t + Duration::from_secs(1)), None);
        // Past its deadline: not taken at a later, unrelated focus
        keep_clicked(Some("s2".into()), t);
        assert_eq!(take_clicked_at(t + CLICK_KEEP), None);
        assert_eq!(take_clicked_at(t), None, "taking it empties the slot");
        // A later click on a banner about no session (the state file's) takes back the earlier one
        keep_clicked(Some("s3".into()), t);
        keep_clicked(None, t + Duration::from_millis(10));
        assert_eq!(take_clicked_at(t + Duration::from_millis(20)), None);
        // An earlier instant (no wall clock to set back): kept
        keep_clicked(Some("s4".into()), t + Duration::from_secs(5));
        assert_eq!(take_clicked_at(t).as_deref(), Some("s4"));
    }

    #[test]
    fn the_app_holds_a_click_until_its_page_takes_it_and_the_latest_wins() {
        set_open(Some("s1".into()));
        set_open(Some("s2".into()));
        assert_eq!(take_open().as_deref(), Some("s2"));
        assert_eq!(take_open(), None);
        set_open(Some("s3".into()));
        set_open(None);
        assert_eq!(take_open(), None);
    }

    #[test]
    fn the_app_asks_the_service_only_while_focused_often_at_first_then_now_and_then() {
        let t = Instant::now();
        let ms = Duration::from_millis;
        // Not focused: never
        assert!(!ask_now(None, None, t));
        // Focus gained: at once, then every step during the burst
        assert!(ask_now(Some(t), None, t));
        assert!(ask_now(Some(t), Some(t - ms(5)), t), "an ask from before this focus does not count");
        assert!(!ask_now(Some(t), Some(t), t + ms(100)));
        assert!(ask_now(Some(t), Some(t), t + FOCUS_STEP));
        // After the burst: every FOCUSED_EVERY, for a click while the window already had the focus
        let late = t + FOCUS_BURST + ms(1);
        assert!(!ask_now(Some(t), Some(late - ms(500)), late));
        assert!(ask_now(Some(t), Some(late - FOCUSED_EVERY), late));
    }
}
