//! What the runner knows about each account's usage windows, and the rules
//! it reads them by.
//!
//! The rule all of this keeps: a reading is evidence, never a decision on its
//! own. An unsampled account has room (absence of data is not exhaustion), a
//! reading that cannot be taken leaves the last one in place, and a parked
//! goal resumes on a fresh sample that shows room, not on a clock.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::clock;
use crate::agents::{
    Provider,
    events::{QuotaSnapshot, QuotaStatus},
};
use crate::storage::odyssey::{OdysseyRecord, OdysseyState, OnUsageReset};

/// Percent of a usage window at which a run parks rather than risk a turn.
pub const USAGE_FLOOR_PERCENT: f64 = 98.0;
/// The closest together two usage samples may ever be.
pub const USAGE_RESAMPLE_MS: i64 = 60_000;
/// How often a parked goal re-checks while its named reset is still ahead.
/// These windows roll, so capacity comes back before the named reset.
pub const PARKED_RESAMPLE_MS: i64 = 5 * 60_000;
/// Spread simultaneous resumes so several goals do not fire at once.
pub const RESUME_JITTER_MS: i64 = 30_000;
/// How long a recorded Claude refusal stands before the run tries again. A
/// refused prompt costs nothing, so the cheap thing is to keep asking.
pub const CLAUDE_RETRY_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at_unix: Option<u64>,
}

/// One account's windows as last read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub fetched_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub allowed: bool,
    pub limit_reached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<UsageWindow>,
}

/// A provider's quota report as a usage snapshot: measured windows shortest
/// first. A report with no percentage at all (Claude says only "allowed"
/// until it is spent) is no snapshot, except a refusal, whose reset is then
/// the whole reading.
pub fn usage_from_quota(quota: &QuotaSnapshot) -> Option<UsageSnapshot> {
    let mut measured: Vec<_> = quota.windows.iter().filter(|window| window.used_percent.is_some()).collect();
    measured.sort_by_key(|window| window.window_minutes.unwrap_or(u64::MAX));
    let rejected = quota.status == QuotaStatus::Rejected;
    if measured.is_empty() && !rejected {
        return None;
    }
    let windows: Vec<_> = if measured.is_empty() { quota.windows.iter().collect() } else { measured.clone() };
    let to_window = |window: &crate::agents::events::QuotaWindow| UsageWindow {
        used_percent: window.used_percent.unwrap_or(100.0),
        window_seconds: window.window_minutes.unwrap_or(0) * 60,
        reset_at_unix: window.resets_at,
    };
    Some(UsageSnapshot {
        fetched_at_unix_ms: quota.observed_at_unix_ms as i64,
        plan_type: quota.plan.clone(),
        allowed: !rejected,
        limit_reached: rejected,
        primary: windows.first().map(|window| {
            let mut out = to_window(window);
            if rejected && measured.is_empty() {
                out.used_percent = 100.0;
            }
            out
        }),
        secondary: windows.get(1).map(|window| to_window(window)),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub enum UsageVerdict {
    Ok,
    Exhausted { resume_at: Option<i64>, reason: String },
}

impl UsageVerdict {
    pub fn is_exhausted(&self) -> bool {
        matches!(self, Self::Exhausted { .. })
    }
}

fn percent(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

/// Whether the account has room for another turn. When both windows are
/// spent the resume time is the later of the two.
pub fn usage_verdict(usage: Option<&UsageSnapshot>) -> UsageVerdict {
    usage_verdict_at(usage, USAGE_FLOOR_PERCENT)
}

pub fn usage_verdict_at(usage: Option<&UsageSnapshot>, floor: f64) -> UsageVerdict {
    let Some(usage) = usage else { return UsageVerdict::Ok };
    let windows: Vec<(&str, &UsageWindow)> = [("5-hour", usage.primary.as_ref()), ("weekly", usage.secondary.as_ref())]
        .into_iter()
        .filter_map(|(name, window)| window.map(|window| (name, window)))
        .collect();
    let spent: Vec<_> = windows.iter().filter(|(_, window)| window.used_percent >= floor).cloned().collect();
    if spent.is_empty() && !usage.limit_reached {
        return UsageVerdict::Ok;
    }
    let relevant = if spent.is_empty() { &windows } else { &spent };
    let resume_at = relevant.iter().filter_map(|(_, window)| window.reset_at_unix).max().map(|seconds| seconds as i64 * 1000);
    let reason = if spent.is_empty() {
        "the provider reported the usage limit was reached".to_string()
    } else {
        let names: Vec<&str> = spent.iter().map(|(name, _)| *name).collect();
        let values: Vec<String> = spent.iter().map(|(_, window)| format!("{}%", percent(window.used_percent))).collect();
        format!("the {} window{} at {}", names.join(" and "), if spent.len() > 1 { "s are" } else { " is" }, values.join(" and "))
    };
    UsageVerdict::Exhausted { resume_at, reason }
}

/// When a parked goal is waiting until, from whichever source knows it.
/// Nothing, once there is room.
pub fn waiting_until(usage: Option<&UsageSnapshot>, resume_at: Option<i64>) -> Option<i64> {
    match usage_verdict(usage) {
        UsageVerdict::Ok => None,
        UsageVerdict::Exhausted { resume_at: named, .. } => named.or(resume_at),
    }
}

/// Whether a parked goal should fetch a fresh sample: never faster than once a
/// minute, periodically before the named reset, and every minute after it.
pub fn should_resample(usage: Option<&UsageSnapshot>, resume_at: Option<i64>, now: i64) -> bool {
    let Some(snapshot) = usage else { return true };
    let age = now - snapshot.fetched_at_unix_ms;
    if age < USAGE_RESAMPLE_MS {
        return false;
    }
    match waiting_until(usage, resume_at) {
        None => true,
        Some(until) => now >= until || age >= PARKED_RESAMPLE_MS,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAction {
    Hold,
    Resume,
    Notify,
    StayPaused,
}

/// What to do for a goal parked on usage. `unsampled_means_room` is true for
/// an account whose only reading is a refusal (Claude without its usage
/// data), where absence is the healthy state.
pub fn resume_decision(goal: &OdysseyRecord, usage: Option<&UsageSnapshot>, resume_at: Option<i64>, now: i64, unsampled_means_room: bool) -> (ResumeAction, String) {
    if goal.state != OdysseyState::WaitingUsage {
        return (ResumeAction::Hold, format!("the goal is {}", goal.state.as_str()));
    }
    if usage.is_none() && !unsampled_means_room {
        return (ResumeAction::Hold, "usage has not been sampled yet".into());
    }
    if let UsageVerdict::Exhausted { resume_at: named, .. } = usage_verdict(usage) {
        let Some(until) = named.or(resume_at) else {
            return (ResumeAction::Hold, "usage reports no room and the provider gave no reset time, so there is nothing to wait for".into());
        };
        if now < until + RESUME_JITTER_MS {
            return (ResumeAction::Hold, "the reset time has not passed".into());
        }
        return (ResumeAction::Hold, "the reset time passed but usage still reports no room".into());
    }
    match goal.on_usage_reset {
        OnUsageReset::ContinueAutomatically => (ResumeAction::Resume, "usage reset and this goal continues automatically".into()),
        OnUsageReset::NotifyOnly => (ResumeAction::Notify, "usage reset; waiting for you to resume".into()),
        OnUsageReset::Stop => (ResumeAction::StayPaused, "usage reset; this goal is set to stop".into()),
    }
}

/// Whether a line is the Claude account saying it is spent. Narrower than
/// "looks like a quota error": this parks a run, so a model that merely
/// mentions rate limits must not match.
pub fn looks_like_claude_limit(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("hit your limit")
        || lower.contains("hit your session limit")
        || lower.contains("usage limit reached")
        || ["rate limit", "rate_limit", "rate-limit", "ratelimit"].iter().any(|needle| lower.contains(needle))
}

/// The reset time a Claude limit message names ("resets 12:20am"), as epoch
/// ms on the local clock. The zone in the message is read but not applied.
pub fn claude_reset_at(message: &str, now: i64) -> Option<i64> {
    let lower = message.to_lowercase();
    let index = lower.find("reset")?;
    let after = &lower[index..];
    let after = after.strip_prefix("resets").or_else(|| after.strip_prefix("reset"))?;
    let bytes = after.as_bytes();
    let start = bytes.iter().position(u8::is_ascii_digit)?;
    let rest = &after[start..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 2 {
        return None;
    }
    let mut hour: u32 = digits.parse().ok()?;
    let mut tail = &rest[digits.len()..];
    let mut minute = 0;
    if let Some(stripped) = tail.strip_prefix(':') {
        let mins: String = stripped.chars().take_while(char::is_ascii_digit).collect();
        if mins.len() != 2 {
            return None;
        }
        minute = mins.parse().ok()?;
        tail = &stripped[2..];
    }
    let suffix = tail.trim_start();
    let suffix = if suffix.starts_with("am") {
        Some("am")
    } else if suffix.starts_with("pm") {
        Some("pm")
    } else {
        None
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    if suffix == Some("pm") && hour < 12 {
        hour += 12;
    }
    if suffix == Some("am") && hour == 12 {
        hour = 0;
    }
    Some(clock::next_local_time(now, hour, minute))
}

/// A snapshot for the Claude account from a refusal, or `None` when the
/// message is not a limit at all. 100% used: the only thing a refusal says is
/// that there is no room.
pub fn claude_usage_from(message: &str, now: i64) -> Option<UsageSnapshot> {
    if !looks_like_claude_limit(message) {
        return None;
    }
    let reset = claude_reset_at(message, now);
    Some(UsageSnapshot {
        fetched_at_unix_ms: now,
        plan_type: None,
        allowed: false,
        limit_reached: true,
        primary: Some(UsageWindow { used_percent: 100.0, window_seconds: 5 * 3600, reset_at_unix: reset.map(|at| (at / 1000) as u64) }),
        secondary: None,
    })
}

/// Every account's latest reading, kept the way the runner reads them.
#[derive(Debug, Default, Clone)]
pub struct UsageBook {
    readings: HashMap<Provider, UsageSnapshot>,
}

impl UsageBook {
    pub fn get(&self, provider: Provider) -> Option<&UsageSnapshot> {
        self.readings.get(&provider)
    }

    pub fn all(&self) -> HashMap<Provider, UsageSnapshot> {
        self.readings.clone()
    }

    /// A quota report. One that names no percentages and is not a refusal is
    /// "allowed", which clears a refusal recorded earlier: a turn that got an
    /// answer is the evidence the refusal was waiting for.
    pub fn note_quota(&mut self, quota: &QuotaSnapshot) -> Option<UsageSnapshot> {
        match usage_from_quota(quota) {
            Some(snapshot) => {
                self.readings.insert(quota.provider, snapshot.clone());
                Some(snapshot)
            }
            None => {
                if quota.status != QuotaStatus::Rejected {
                    self.readings.remove(&quota.provider);
                }
                None
            }
        }
    }

    /// A failure message read as the Claude account being spent. Returns
    /// whether it was one.
    pub fn note_claude_limit(&mut self, message: &str, now: i64) -> bool {
        match claude_usage_from(message, now) {
            Some(snapshot) => {
                self.readings.insert(Provider::Claude, snapshot);
                true
            }
            None => false,
        }
    }

    /// The Claude refusal is dropped once its window has passed or it is old
    /// enough to be worth trying again; until then it stands.
    pub fn refresh_claude_refusal(&mut self, now: i64) {
        let Some(held) = self.readings.get(&Provider::Claude) else { return };
        if !held.limit_reached {
            return;
        }
        let window_over = held.primary.as_ref().and_then(|window| window.reset_at_unix).is_some_and(|reset| now >= reset as i64 * 1000);
        let worth_retrying = now - held.fetched_at_unix_ms >= CLAUDE_RETRY_MS;
        if window_over || worth_retrying {
            self.readings.remove(&Provider::Claude);
        }
    }

    pub fn clear(&mut self, provider: Provider) {
        self.readings.remove(&provider);
    }

    pub fn set(&mut self, provider: Provider, snapshot: Option<UsageSnapshot>) {
        match snapshot {
            Some(snapshot) => {
                self.readings.insert(provider, snapshot);
            }
            None => {
                self.readings.remove(&provider);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::agents::events::QuotaWindow;
    use crate::superthing::tests::goal;

    pub fn window(used: f64, reset: Option<u64>) -> UsageWindow {
        UsageWindow { used_percent: used, window_seconds: 18_000, reset_at_unix: reset }
    }

    pub fn usage(primary: Option<UsageWindow>, secondary: Option<UsageWindow>) -> UsageSnapshot {
        UsageSnapshot { fetched_at_unix_ms: 0, plan_type: None, allowed: true, limit_reached: false, primary, secondary }
    }

    #[test]
    fn an_unsampled_account_has_room() {
        assert_eq!(usage_verdict(None), UsageVerdict::Ok);
        assert_eq!(usage_verdict(Some(&usage(Some(window(71.0, None)), Some(window(30.0, None))))), UsageVerdict::Ok);
    }

    #[test]
    fn a_window_at_the_floor_parks_and_is_named() {
        let UsageVerdict::Exhausted { resume_at, reason } = usage_verdict(Some(&usage(Some(window(99.0, Some(1_700_000_000))), Some(window(40.0, None))))) else { panic!() };
        assert!(reason.contains("5-hour window is at 99%"), "{reason}");
        assert_eq!(resume_at, Some(1_700_000_000_000));
        let UsageVerdict::Exhausted { resume_at, .. } = usage_verdict(Some(&usage(Some(window(100.0, Some(1_000))), Some(window(100.0, Some(9_000)))))) else { panic!() };
        assert_eq!(resume_at, Some(9_000_000), "the later window");
        let mut limited = usage(Some(window(12.0, None)), Some(window(3.0, None)));
        limited.limit_reached = true;
        let UsageVerdict::Exhausted { resume_at, reason } = usage_verdict(Some(&limited)) else { panic!() };
        assert_eq!(resume_at, None);
        assert!(reason.contains("the provider reported"));
    }

    #[test]
    fn a_parked_goal_resumes_on_a_sample_that_shows_room_not_on_the_clock() {
        let mut waiting = goal();
        waiting.state = OdysseyState::WaitingUsage;
        waiting.on_usage_reset = OnUsageReset::ContinueAutomatically;
        let roomy = usage(Some(window(10.0, None)), None);
        assert_eq!(resume_decision(&waiting, Some(&roomy), Some(9_999_999), 1, false).0, ResumeAction::Resume);
        let spent = usage(Some(window(100.0, Some(1_000))), None);
        assert_eq!(resume_decision(&waiting, Some(&spent), None, 0, false).0, ResumeAction::Hold);
        assert_eq!(resume_decision(&waiting, Some(&spent), None, 2_000_000, false).1, "the reset time passed but usage still reports no room");
        assert_eq!(resume_decision(&waiting, None, None, 0, false).1, "usage has not been sampled yet");
        assert_eq!(resume_decision(&waiting, None, None, 0, true).0, ResumeAction::Resume, "Claude: no reading is room");
        waiting.on_usage_reset = OnUsageReset::NotifyOnly;
        assert_eq!(resume_decision(&waiting, Some(&roomy), None, 0, false).0, ResumeAction::Notify);
        waiting.on_usage_reset = OnUsageReset::Stop;
        assert_eq!(resume_decision(&waiting, Some(&roomy), None, 0, false).0, ResumeAction::StayPaused);
        let mut running = goal();
        running.state = OdysseyState::Running;
        assert_eq!(resume_decision(&running, Some(&roomy), None, 0, false).0, ResumeAction::Hold);
    }

    #[test]
    fn a_parked_goal_samples_at_a_bounded_rate() {
        let mut spent = usage(Some(window(100.0, Some(10_000))), None);
        spent.fetched_at_unix_ms = 0;
        assert!(!should_resample(Some(&spent), None, 30_000), "never inside a minute");
        assert!(should_resample(Some(&spent), None, PARKED_RESAMPLE_MS), "periodically before the reset");
        assert!(!should_resample(Some(&spent), None, PARKED_RESAMPLE_MS - 1));
        assert!(should_resample(Some(&spent), None, 10_000_001), "every minute after it");
        assert!(should_resample(None, None, 0), "no snapshot at all");
        let no_reset = usage(Some(window(100.0, None)), None);
        assert!(should_resample(Some(&no_reset), None, USAGE_RESAMPLE_MS));
    }

    #[test]
    fn a_claude_refusal_is_a_reading_with_its_reset_time() {
        let now = clock::now_ms();
        let snapshot = claude_usage_from("Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)", now).unwrap();
        let reset = snapshot.primary.as_ref().unwrap().reset_at_unix.unwrap() as i64 * 1000;
        assert_eq!(clock::local_hhmm(reset), "00:20");
        assert!(claude_usage_from("the model talked about rate design", now).is_none());
        assert!(claude_usage_from("I fixed the code", now).is_none());
        assert_eq!(claude_reset_at("resets 12pm", now).map(clock::local_hhmm), Some("12:00".to_string()));
        assert_eq!(claude_reset_at("resets 3:05pm", now).map(clock::local_hhmm), Some("15:05".to_string()));
        assert_eq!(claude_reset_at("no time here", now), None);
    }

    #[test]
    fn the_book_keeps_a_refusal_until_it_is_worth_asking_again() {
        let mut book = UsageBook::default();
        assert!(book.note_claude_limit("You've hit your limit · resets 5am", 1_000));
        book.refresh_claude_refusal(1_000 + CLAUDE_RETRY_MS - 1);
        assert!(book.get(Provider::Claude).is_some());
        book.refresh_claude_refusal(1_000 + CLAUDE_RETRY_MS);
        assert!(book.get(Provider::Claude).is_none());
        let allowed = QuotaSnapshot { provider: Provider::Claude, status: QuotaStatus::Allowed, windows: vec![], plan: None, observed_at_unix_ms: 5 };
        book.note_claude_limit("hit your limit", 1);
        book.note_quota(&allowed);
        assert!(book.get(Provider::Claude).is_none(), "an allowed report clears a refusal");
        let codex = QuotaSnapshot {
            provider: Provider::Codex,
            status: QuotaStatus::Allowed,
            windows: vec![
                QuotaWindow { kind: "secondary".into(), used_percent: Some(30.0), window_minutes: Some(10_080), resets_at: Some(9) },
                QuotaWindow { kind: "primary".into(), used_percent: Some(70.0), window_minutes: Some(300), resets_at: Some(3) },
            ],
            plan: Some("plus".into()),
            observed_at_unix_ms: 7,
        };
        let snapshot = book.note_quota(&codex).unwrap();
        assert_eq!(snapshot.primary.unwrap().used_percent, 70.0, "shortest window first");
        assert_eq!(snapshot.secondary.unwrap().used_percent, 30.0);
    }
}
