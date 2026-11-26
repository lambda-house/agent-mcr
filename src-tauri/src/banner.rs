//! macOS banners under the app's own name, and what a click on one opens
//! (MCR-180). The harness service posts them; the session a banner is about
//! rides in its request identifier, so a click can show that session
//! instead of only bringing Agent MCR forward.
//!
//! macOS hands the click to a process of the bundle: the app or the service
//! that posted it. Both listen and stamp the click with a clock the two
//! share (`stamp`), so the latest click wins across both routes, and a click
//! on a banner about no session takes back an earlier one. The service keeps
//! its click until `CLICK_KEEP` has passed, for the app to take with the
//! control op `banner_clicked` (`take_clicked`). The app asks only when
//! there is reason to: when its main window gains the focus (macOS brings
//! the app forward at the click), a few times and then no more
//! (`FOCUS_ASKS`); once when a click reaches the app itself, to settle the
//! order with one the service may hold; and with the Live list read it
//! already makes (`sessions` with `bannerClick`). There is no poll of its
//! own. The app keeps the latest click until its page takes it
//! (`take_open`): a click that launched the app arrives before the page
//! listens, and one about no session takes back what the page took.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Request identifiers of banners about a session: `session/<id>/<random>`.
const SESSION_PREFIX: &str = "session/";
/// How long the service keeps a click for the app. macOS brings the app
/// forward at the click, so a click the app has not taken by then is not
/// taken at a later, unrelated focus
const CLICK_KEEP: Duration = Duration::from_secs(10);
/// When the app asks the service after its main window gained the focus,
/// counted from the focus: the click that brought it forward may reach the
/// service a moment after the focus. Then it stops until the next focus
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const FOCUS_ASKS: [Duration; 5] = [Duration::from_millis(0), Duration::from_millis(200), Duration::from_millis(500), Duration::from_millis(1000), Duration::from_millis(2000)];

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

/// When a click came, in nanoseconds of a monotonic clock that the app and
/// the service read alike (macOS: `CLOCK_UPTIME_RAW`, since boot), so the
/// two processes' clicks can be ordered. No wall clock: one set back would
/// misorder them.
pub fn stamp() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut t = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        if unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut t) } == 0 {
            return t.tv_sec as u64 * 1_000_000_000 + t.tv_nsec as u64;
        }
    }
    // Elsewhere no banner is posted; a process-local clock keeps the order within the process
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64 + 1
}

/// A click: its session (none for a banner about none) and its `stamp`.
#[derive(Clone, Debug, PartialEq)]
pub struct Click {
    pub session: Option<String>,
    pub at: u64,
}

/// In the service: the latest click and until when it is kept (a monotonic deadline).
static CLICKED: Mutex<Option<(Click, Instant)>> = Mutex::new(None);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keep_clicked(click: Click, now: Instant) {
    let mut slot = lock(&CLICKED);
    if slot.as_ref().is_none_or(|(kept, _)| kept.at < click.at) {
        *slot = Some((click, now + CLICK_KEEP));
    }
}

fn take_clicked_at(now: Instant) -> Option<Click> {
    lock(&CLICKED).take().filter(|(_, until)| now < *until).map(|(click, _)| click)
}

/// In the service: the latest click handed to it, once, while it is kept.
pub fn take_clicked() -> Option<Click> {
    take_clicked_at(Instant::now())
}

/// The service's answer to `banner_clicked`, and the `bannerClick` of a list read.
pub fn click_json(click: Option<Click>) -> serde_json::Value {
    match click {
        Some(c) => serde_json::json!({ "session": c.session, "at": c.at }),
        None => serde_json::json!({ "session": null }),
    }
}

/// The app's reading of that answer: a click, or none.
pub fn click_from(answer: &serde_json::Value) -> Option<Click> {
    let at = answer["at"].as_u64()?;
    Some(Click { session: answer["session"].as_str().map(str::to_owned), at })
}

/// In the app: what the page is to take, and the stamp of the latest click
/// seen by either route, kept after the page took it, so an older click that
/// comes later opens nothing.
#[derive(Default)]
struct Open {
    /// The latest click, until the page takes it: `Some(None)` takes back
    /// what the page may still be about to open
    pending: Option<Option<String>>,
    latest: u64,
}

static OPEN: Mutex<Open> = Mutex::new(Open { pending: None, latest: 0 });

/// In the app: a click from either route. Whether it is the latest, so that
/// the page is to be told: one about a session to open it, one about no
/// session to take back one the page took already and has not opened yet.
pub fn offer(click: Click) -> bool {
    let mut open = lock(&OPEN);
    if click.at <= open.latest {
        return false;
    }
    open.latest = click.at;
    open.pending = Some(click.session);
    true
}

/// In the app: whether a click waits for the page to take it. A list read
/// says so, because the page must not decide an older ask before it has it.
pub fn open_pending() -> bool {
    lock(&OPEN).pending.is_some()
}

/// In the app: the latest click for the page, once: `Some(Some(id))` opens
/// that session, `Some(None)` takes back an earlier one, `None` is nothing new.
pub fn take_open() -> Option<Option<String>> {
    lock(&OPEN).pending.take()
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
        clicked: Box<dyn Fn(super::Click) + Send + Sync>,
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
                    let at = super::stamp();
                    let id = response.notification().request().identifier().to_string();
                    (self.ivars().clicked)(super::Click { session: super::session_of(&id).map(str::to_owned), at });
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
    pub fn listen(clicked: Box<dyn Fn(super::Click) + Send + Sync>) {
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

/// In the app: hand every click on a banner to `clicked`.
pub fn listen_in_app(clicked: impl Fn(Click) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(clicked));
    #[cfg(not(target_os = "macos"))]
    let _ = clicked;
}

/// In the service: keep the clicked banner's session for the app.
pub fn listen_in_service() {
    #[cfg(target_os = "macos")]
    mac::listen(Box::new(|click| keep_clicked(click, Instant::now())));
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

    fn click(session: Option<&str>, at: u64) -> Click {
        Click { session: session.map(str::to_owned), at }
    }

    // CLICKED is one slot per process: the service's tests of it run in one test
    #[test]
    fn the_service_keeps_the_latest_click_once_and_only_until_its_deadline() {
        let t = Instant::now();
        keep_clicked(click(Some("s1"), 1), t);
        assert_eq!(take_clicked_at(t + Duration::from_secs(1)), Some(click(Some("s1"), 1)));
        assert_eq!(take_clicked_at(t + Duration::from_secs(1)), None);
        // Past its deadline: not taken at a later, unrelated focus
        keep_clicked(click(Some("s2"), 2), t);
        assert_eq!(take_clicked_at(t + CLICK_KEEP), None);
        assert_eq!(take_clicked_at(t), None, "taking it empties the slot");
        // A later click on a banner about no session (the state file's) takes back the earlier one,
        // and is handed on as such, so the app can take back its own older one too
        keep_clicked(click(Some("s3"), 3), t);
        keep_clicked(click(None, 4), t);
        assert_eq!(take_clicked_at(t), Some(click(None, 4)));
        // An older stamp does not replace a newer click
        keep_clicked(click(Some("s5"), 6), t);
        keep_clicked(click(Some("s4"), 5), t);
        assert_eq!(take_clicked_at(t).and_then(|c| c.session).as_deref(), Some("s5"));
    }

    #[test]
    fn the_answer_carries_the_click_and_its_stamp_or_nothing() {
        assert_eq!(click_from(&click_json(Some(click(Some("s1"), 7)))), Some(click(Some("s1"), 7)));
        assert_eq!(click_from(&click_json(Some(click(None, 8)))), Some(click(None, 8)));
        assert_eq!(click_from(&click_json(None)), None);
        // An older service's answer (no stamp) is no click
        assert_eq!(click_from(&serde_json::json!({ "session": "s1" })), None);
    }

    // OPEN is one slot per process too
    #[test]
    fn the_app_hands_the_page_only_the_latest_click_of_either_route_once() {
        let opens = |id: &str| Some(Some(id.to_owned()));
        // The app's own click B, then the service's older A: A opens nothing
        assert!(!open_pending());
        assert!(offer(click(Some("b"), 20)));
        assert!(!offer(click(Some("a"), 10)));
        assert!(open_pending(), "a list read says the page has a click to take");
        assert_eq!(take_open(), opens("b"));
        assert!(!open_pending());
        assert_eq!(take_open(), None);
        // Taken already: an older click that comes later still opens nothing
        assert!(!offer(click(Some("a"), 15)));
        assert_eq!(take_open(), None);
        // A later click about no session replaces one the page has not taken
        assert!(offer(click(Some("c"), 30)));
        assert!(offer(click(None, 31)));
        assert_eq!(take_open(), Some(None));
        // and reaches the page after it took one, to take that back (MCR-180 round 4)
        assert!(offer(click(Some("d"), 40)));
        assert_eq!(take_open(), opens("d"));
        assert!(offer(click(None, 41)));
        assert_eq!(take_open(), Some(None));
        // A newer click from the service after the app's own: the service's opens
        assert!(offer(click(Some("e"), 50)));
        assert!(offer(click(Some("f"), 51)));
        assert_eq!(take_open(), opens("f"));
    }

    #[test]
    fn the_stamp_moves_on() {
        let a = stamp();
        std::thread::sleep(Duration::from_millis(1));
        assert!(stamp() > a);
    }

    #[test]
    fn the_app_asks_a_few_times_after_a_focus_and_then_stops() {
        assert_eq!(FOCUS_ASKS[0], Duration::ZERO);
        assert!(FOCUS_ASKS.windows(2).all(|w| w[0] < w[1]));
        // All within the time the service keeps a click
        assert!(*FOCUS_ASKS.last().unwrap() < CLICK_KEEP);
    }
}
