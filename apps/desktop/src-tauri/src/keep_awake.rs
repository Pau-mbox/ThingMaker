//! Keeps macOS and Windows from idle sleep while agents work.
//!
//! Big Thing promises to keep working while you sleep, and a team job that
//! waits for a limit to reset expects the Mac to be awake when it does. The
//! host holds a macOS power assertion (`PreventUserIdleSystemSleep`, the one
//! `caffeinate -i` takes), or a Windows PowerRequestSystemRequired request,
//! whenever something is working, and releases it the
//! moment nothing is. The display may still sleep, and closing the lid still
//! sleeps the Mac: only *idle* sleep is held off.
//!
//! "Working" is any session with a turn running or background work in
//! flight, any Big Thing goal running or parked until an account's limit
//! resets, and any team job not finished. On battery the assertion is held
//! only when Settings allows it, because an overnight run on battery is a
//! flat battery in the morning.
//!
//! The decision is polled every few seconds rather than driven by events:
//! idle sleep is minutes away, so a short delay costs nothing, and polling
//! cannot miss an edge. The assertion belongs to this process, so macOS
//! drops it by itself if ThingMaker exits or crashes.

use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use thingmaker_supervisor::supervisor::DetachedCallState;

use crate::{commands::CommandResult, state::AppState};

const POLL: Duration = Duration::from_secs(15);
const ASSERTION_NAME: &str = "ThingMaker: agents are working";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub sessions: usize,
    pub goals: usize,
    pub jobs: usize,
}

impl Work {
    pub fn any(&self) -> bool {
        self.sessions + self.goals + self.jobs > 0
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    /// The assertion is held now.
    pub holding: bool,
    pub work: Work,
    /// `None` where the power source cannot be read (a desktop Mac reads AC).
    pub on_battery: Option<bool>,
    /// Why it is or is not held, in words for Settings.
    pub reason: String,
}

static STATUS: Mutex<Option<KeepAwakeStatus>> = Mutex::new(None);

/// What the poller last decided, for Settings.
#[tauri::command]
pub fn keep_awake_status() -> CommandResult<KeepAwakeStatus> {
    Ok(STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone().unwrap_or_default())
}

/// Whether to hold the assertion, and why: pure, so it is tested without a Mac.
pub fn decide(enabled: bool, allow_on_battery: bool, work: &Work, on_battery: Option<bool>) -> (bool, String) {
    if !enabled {
        return (false, "Off in Settings.".into());
    }
    if !work.any() {
        return (false, "Nothing is working.".into());
    }
    if on_battery == Some(true) && !allow_on_battery {
        return (false, "On battery, so the computer may sleep as usual.".into());
    }
    let mut parts = Vec::new();
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    if work.sessions > 0 {
        parts.push(plural(work.sessions, "session working", "sessions working"));
    }
    if work.goals > 0 {
        parts.push(plural(work.goals, "Big Thing running", "Big Things running"));
    }
    if work.jobs > 0 {
        parts.push(plural(work.jobs, "team job open", "team jobs open"));
    }
    (true, format!("Keeping the computer awake: {}.", parts.join(", ")))
}

async fn work_now(state: &AppState) -> Work {
    let mut work = Work::default();
    for id in state.actor_ids() {
        if let Some(actor) = state.actor(&id)
            && let Ok(snapshot) = actor.snapshot().await
        {
            let detached = snapshot.detached_calls.values().any(|call| matches!(call, DetachedCallState::Active | DetachedCallState::CancellationRequested));
            if snapshot.foreground.is_active() || !snapshot.autonomous_turns.is_empty() || detached || snapshot.queue.holds_next_turn() {
                work.sessions += 1;
            }
        }
    }
    work.goals = state.engine.get().map(|engine| engine.live_goal_count()).unwrap_or(0);
    work.jobs = state.delegation.get().map(|delegation| delegation.open_job_count()).unwrap_or(0);
    work
}

/// Runs for the life of the app.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut held: Option<power::Assertion> = None;
        loop {
            let status = {
                let state = app.state::<AppState>();
                let settings = crate::commands::app::load_settings(&state);
                let work = work_now(&state).await;
                let on_battery = power::on_battery();
                let (want, reason) = decide(settings.keep_awake, settings.keep_awake_on_battery, &work, on_battery);
                if want && held.is_none() {
                    held = power::Assertion::hold(ASSERTION_NAME);
                    if held.is_some() {
                        tracing::info!(target: "keep_awake", %reason, "holding off idle sleep");
                    } else {
                        tracing::warn!(target: "keep_awake", "The operating system refused the power assertion");
                    }
                } else if !want && held.take().is_some() {
                    tracing::info!(target: "keep_awake", %reason, "idle sleep allowed again");
                }
                let reason = if want && held.is_none() { "The operating system could not prevent idle sleep; see the log.".into() } else { reason };
                KeepAwakeStatus { holding: held.is_some(), work, on_battery, reason }
            };
            *STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(status);
            tokio::time::sleep(POLL).await;
        }
    });
}

/// Lets Settings show the new answer without waiting for the next poll.
#[tauri::command]
pub async fn keep_awake_refresh(state: State<'_, AppState>) -> CommandResult<KeepAwakeStatus> {
    let settings = crate::commands::app::load_settings(&state);
    let work = work_now(&state).await;
    let on_battery = power::on_battery();
    let (_, reason) = decide(settings.keep_awake, settings.keep_awake_on_battery, &work, on_battery);
    let holding = STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().is_some_and(|status| status.holding);
    Ok(KeepAwakeStatus { holding, work, on_battery, reason })
}

#[cfg(target_os = "macos")]
mod power {
    use core_foundation::{
        base::{CFRelease, CFTypeRef, TCFType},
        string::{CFString, CFStringRef},
    };

    type AssertionId = u32;
    /// `kIOPMAssertionLevelOn`.
    const LEVEL_ON: u32 = 255;
    /// `kIOReturnSuccess`.
    const SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut AssertionId) -> i32;
        fn IOPMAssertionRelease(id: AssertionId) -> i32;
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
    }

    /// A held power assertion; dropping it lets the Mac idle-sleep again.
    pub struct Assertion(AssertionId);

    impl Assertion {
        pub fn hold(name: &str) -> Option<Self> {
            let kind = CFString::from_static_string("PreventUserIdleSystemSleep");
            let name = CFString::new(name);
            let mut id: AssertionId = 0;
            // SAFETY: both strings outlive the call, and `id` is a valid out
            // pointer; IOKit copies what it keeps.
            let result = unsafe { IOPMAssertionCreateWithName(kind.as_concrete_TypeRef(), LEVEL_ON, name.as_concrete_TypeRef(), &mut id) };
            (result == SUCCESS).then_some(Self(id))
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: the id came from a successful create and is released once.
            unsafe {
                IOPMAssertionRelease(self.0);
            }
        }
    }

    /// Whether the Mac runs on its battery now; `None` when it cannot say.
    pub fn on_battery() -> Option<bool> {
        // SAFETY: the snapshot is owned (Copy rule) and released here; the
        // type string is borrowed from it (Get rule) and read before that.
        unsafe {
            let info = IOPSCopyPowerSourcesInfo();
            if info.is_null() {
                return None;
            }
            let kind = IOPSGetProvidingPowerSourceType(info);
            let answer = (!kind.is_null()).then(|| CFString::wrap_under_get_rule(kind) == "Battery Power");
            CFRelease(info);
            answer
        }
    }
}

#[cfg(windows)]
mod power {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Power::{GetSystemPowerStatus, PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest, SYSTEM_POWER_STATUS},
            SystemServices::POWER_REQUEST_CONTEXT_VERSION,
            Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
        },
    };

    // Power request handles are process-wide, so the async poller can release
    // one from a different worker thread. The owned handle is closed once.
    pub struct Assertion(usize);

    impl Assertion {
        pub fn hold(name: &str) -> Option<Self> {
            let mut reason: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 { SimpleReasonString: reason.as_mut_ptr() },
            };
            // SAFETY: context and its terminated UTF-16 string outlive the call;
            // the returned handle is checked and owned exclusively by this value.
            unsafe {
                let handle = PowerCreateRequest(&context);
                if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                    return None;
                }
                if PowerSetRequest(handle, PowerRequestSystemRequired) == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self(handle as usize))
            }
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: the owned handle came from PowerCreateRequest and is
            // released exactly once, balancing the successful PowerSetRequest.
            unsafe {
                let handle = self.0 as HANDLE;
                PowerClearRequest(handle, PowerRequestSystemRequired);
                CloseHandle(handle);
            }
        }
    }

    pub fn on_battery() -> Option<bool> {
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: status points to a writable structure for the duration of the call.
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return None;
        }
        match status.ACLineStatus {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod power {
    pub struct Assertion;

    impl Assertion {
        pub fn hold(_name: &str) -> Option<Self> {
            None
        }
    }

    pub fn on_battery() -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_only_while_something_works_and_the_power_source_allows() {
        let busy = Work { sessions: 1, goals: 1, jobs: 2 };
        let (hold, reason) = decide(true, false, &busy, Some(false));
        assert!(hold);
        assert_eq!(reason, "Keeping the computer awake: 1 session working, 1 Big Thing running, 2 team jobs open.");
        assert!(!decide(true, false, &Work::default(), Some(false)).0, "nothing working");
        assert!(!decide(false, true, &busy, Some(false)).0, "off in Settings");
        assert!(!decide(true, false, &busy, Some(true)).0, "on battery, not allowed");
        assert!(decide(true, true, &busy, Some(true)).0, "on battery, allowed");
        assert!(decide(true, false, &busy, None).0, "a Mac with no battery reading is plugged in");
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn an_assertion_is_taken_and_released() {
        let held = power::Assertion::hold("ThingMaker test assertion").expect("the OS grants an idle-sleep assertion");
        drop(held);
        // Reading the power source never fails on a Mac that has IOKit.
        let _ = power::on_battery();
    }
}
