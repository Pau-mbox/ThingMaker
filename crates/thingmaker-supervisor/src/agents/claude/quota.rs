//! What a Claude account says about its quota, and when a spent one comes
//! back (docs/plans/odyssey-second-orchestrator.md §2.4).
//!
//! Two signals, both from the adapter itself; nothing here reads a token or
//! calls an Anthropic endpoint.
//!
//! **Before it is spent.** The Agent SDK emits a `rate_limit_event` when the
//! account's rate-limit state *changes* (verified on a live turn, 30 September
//! 2026: an ordinary turn on a fresh window emits none), and the adapter
//! forwards it as `_claude/rateLimit` on a `usage_update` once the turn has
//! reported its first usage: `{status: allowed | allowed_warning | rejected, resetsAt,
//! rateLimitType: five_hour | seven_day | seven_day_opus | …, utilization}`.
//! [`quota_from_usage_meta`] turns that into the provider-neutral
//! [`QuotaSnapshot`], which is what lets the router move work off Claude
//! *before* a run hits the wall.
//!
//! **Once it is spent.** Prompting a spent account returns, verbatim from
//! adapter 0.76.0 on a Pro subscription:
//!
//! ```json
//! { "code": -32603,
//!   "message": "Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)",
//!   "data": { "errorKind": "rate_limit" } }
//! ```
//!
//! `data.errorKind` is the machine-readable part and is what decides; the
//! reset time has to be read out of English, so it is best-effort and a
//! failure to parse it means "we know it is spent, we do not know until when",
//! which the runner already handles (it parks on an unknown reset and
//! re-samples).

use serde_json::Value;

use crate::{
    agents::{
        Provider,
        events::{QuotaSnapshot, QuotaStatus, QuotaWindow},
    },
    transport::jsonrpc::RpcError,
};

/// The key `claude-agent-acp` puts the SDK's `rate_limit_info` under.
pub const RATE_LIMIT_META_KEY: &str = "_claude/rateLimit";

/// Reads `_claude/rateLimit` out of a `usage_update`'s `_meta`.
///
/// `utilization` is a fraction (0–1) in the SDK's type and is reported as a
/// percentage; a value above 1 is taken to be a percentage already, because
/// reading 0.7% for 70% would hide a nearly spent account.
pub fn quota_from_usage_meta(meta: &Value, observed_at_unix_ms: u64) -> Option<QuotaSnapshot> {
    let info = meta.get(RATE_LIMIT_META_KEY)?;
    let status = match info.get("status").and_then(Value::as_str)? {
        "allowed" => QuotaStatus::Allowed,
        "allowed_warning" => QuotaStatus::Warning,
        "rejected" => QuotaStatus::Rejected,
        _ => return None,
    };
    let used_percent = info.get("utilization").and_then(Value::as_f64).map(|u| if u <= 1.0 { u * 100.0 } else { u });
    let window_minutes = match info.get("rateLimitType").and_then(Value::as_str) {
        Some("five_hour") => Some(300),
        Some(kind) if kind.starts_with("seven_day") => Some(10_080),
        _ => None,
    };
    let window = QuotaWindow {
        kind: info.get("rateLimitType").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        used_percent,
        window_minutes,
        resets_at: info.get("resetsAt").and_then(Value::as_u64),
    };
    Some(QuotaSnapshot {
        provider: Provider::Claude,
        status,
        windows: vec![window],
        plan: None,
        observed_at_unix_ms,
    })
}

/// A rate limit the account reported, with the reset time when it named one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimit {
    /// The message as the adapter wrote it, for the record and the screen.
    pub message: String,
    /// Unix seconds, when the message named a time we could place on a clock.
    pub reset_at_unix: Option<u64>,
    /// The IANA zone the message named, when it named one.
    pub zone: Option<String>,
}

/// Whether an error the adapter returned is the account being spent.
///
/// `data.errorKind` is checked first because it is the adapter's own word.
/// The text is a fallback for older builds and for the same condition
/// arriving as a message chunk rather than an error.
pub fn rate_limit_from_error(error: &RpcError) -> Option<RateLimit> {
    let kind = error
        .data
        .as_ref()
        .and_then(|data| data.get("errorKind"))
        .and_then(Value::as_str);
    if kind != Some("rate_limit") && !looks_like_rate_limit(&error.message) {
        return None;
    }
    Some(rate_limit_from_text(&error.message, now_unix()))
}

/// Whether a line of prose is the account saying it is spent. Deliberately
/// narrow: a model *discussing* rate limits must not park the run.
pub fn looks_like_rate_limit(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["hit your session limit", "usage limit reached", "rate limit", "rate_limit", "hit your limit"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Reads a rate-limit message into a limit and, when it can, a reset time.
pub fn rate_limit_from_text(message: &str, now_unix_seconds: u64) -> RateLimit {
    let zone = message
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(zone, _)| zone.trim().to_string())
        .filter(|zone| zone.contains('/'));
    RateLimit {
        message: message.trim().to_string(),
        reset_at_unix: parse_reset_clock(message, now_unix_seconds),
        zone,
    }
}

/// `resets 12:20am`, `resets at 3pm`, `resets 14:05` → the next time that
/// clock reading comes round.
///
/// The named zone is *not* applied: reading it would need a tz database, and
/// the machine the desktop runs on is overwhelmingly the machine the account
/// is used from, so local time is the better of two guesses. It is only ever
/// used to decide when to try again, and trying again early costs one refused
/// prompt.
fn parse_reset_clock(message: &str, now_unix_seconds: u64) -> Option<u64> {
    let lower = message.to_lowercase();
    let after = lower.split("reset").nth(1)?;
    let bytes = after.as_bytes();
    let start = bytes.iter().position(u8::is_ascii_digit)?;
    let rest = &after[start..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == ':').collect();
    let mut parts = digits.split(':');
    let mut hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = match parts.next() {
        Some(text) => text.parse().ok()?,
        None => 0,
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    let suffix = rest[digits.len()..].trim_start();
    if suffix.starts_with("pm") && hour < 12 {
        hour += 12;
    } else if suffix.starts_with("am") && hour == 12 {
        hour = 0;
    }
    Some(next_local_clock(now_unix_seconds, hour, minute))
}

/// The next time the local clock reads `hour:minute`, as unix seconds.
///
/// Local, and deliberately arithmetic rather than calendrical: a reset is
/// hours away, and the only thing that depends on this is when to re-sample.
fn next_local_clock(now_unix_seconds: u64, hour: u32, minute: u32) -> u64 {
    let offset = local_offset_seconds(now_unix_seconds);
    let local = now_unix_seconds as i64 + offset;
    let midnight = local - local.rem_euclid(86_400);
    let target = midnight + i64::from(hour) * 3600 + i64::from(minute) * 60;
    let target = if target <= local { target + 86_400 } else { target };
    (target - offset).max(0) as u64
}

/// This machine's UTC offset in seconds, from the C library rather than a
/// crate: the desktop has no tz dependency and this is the one place that
/// needs one.
fn local_offset_seconds(now_unix_seconds: u64) -> i64 {
    // `localtime_r` fills a `tm` whose `tm_gmtoff` is exactly this.
    #[cfg(unix)]
    {
        unsafe {
            let time = now_unix_seconds as libc::time_t;
            let mut out: libc::tm = std::mem::zeroed();
            if libc::localtime_r(&time, &mut out).is_null() {
                return 0;
            }
            out.tm_gmtoff as i64
        }
    }
    #[cfg(not(unix))]
    {
        let _ = now_unix_seconds;
        0
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_per_turn_rate_limit_event_becomes_a_quota_snapshot() {
        let meta = serde_json::json!({ "_claude/rateLimit": {
            "status": "allowed_warning", "resetsAt": 1790800000u64, "rateLimitType": "five_hour", "utilization": 0.82
        }});
        let snapshot = quota_from_usage_meta(&meta, 5).unwrap();
        assert_eq!(snapshot.status, QuotaStatus::Warning);
        assert_eq!(snapshot.windows[0].kind, "five_hour");
        assert_eq!(snapshot.windows[0].window_minutes, Some(300));
        assert!((snapshot.windows[0].used_percent.unwrap() - 82.0).abs() < 1e-9);
        assert_eq!(snapshot.windows[0].resets_at, Some(1790800000));
        let spent = serde_json::json!({ "_claude/rateLimit": { "status": "rejected", "resetsAt": 9, "rateLimitType": "seven_day_opus" }});
        let spent = quota_from_usage_meta(&spent, 0).unwrap();
        assert_eq!(spent.available_again_at(), Some(9));
        assert_eq!(quota_from_usage_meta(&serde_json::json!({}), 0), None);
    }

    fn error(message: &str, kind: Option<&str>) -> RpcError {
        RpcError {
            code: -32603,
            message: message.to_string(),
            data: kind.map(|kind| serde_json::json!({ "errorKind": kind })),
        }
    }

    #[test]
    fn the_adapters_own_error_kind_decides_and_the_text_is_the_fallback() {
        // Captured verbatim from adapter 0.76.0 on a spent Pro subscription.
        let limit = rate_limit_from_error(&error(
            "Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)",
            Some("rate_limit"),
        ))
        .expect("a rate limit");
        assert_eq!(limit.zone.as_deref(), Some("Europe/Madrid"));
        assert!(limit.reset_at_unix.is_some(), "the message names a clock time");

        // An ordinary internal error is not a quota wall and must not park a run.
        assert_eq!(rate_limit_from_error(&error("Internal error: ENOENT", None)), None);
        // An older build with no `data` still says it in the message.
        assert!(rate_limit_from_error(&error("usage limit reached", None)).is_some());
    }

    #[test]
    fn a_clock_reading_resolves_to_the_next_time_it_comes_round() {
        // 1758067200 is 2025-09-17T00:00:00Z. Whatever the machine's zone,
        // the answer is in the future and within a day.
        let now = 1_758_067_200;
        for message in ["resets 12:20am (Europe/Madrid)", "resets at 3pm", "resets 14:05", "Resets 9:30 AM"] {
            let at = rate_limit_from_text(message, now).reset_at_unix.unwrap_or_else(|| panic!("{message}"));
            assert!(at > now, "{message} resolved to the past");
            assert!(at <= now + 86_400, "{message} resolved more than a day out");
        }
        // Nothing to read is not a failure: the runner parks on an unknown
        // reset and re-samples rather than guessing a time.
        assert_eq!(rate_limit_from_text("You've hit your limit", now).reset_at_unix, None);
        assert_eq!(rate_limit_from_text("resets 99:99", now).reset_at_unix, None);
    }

    #[test]
    fn midnight_and_noon_are_the_two_the_twelve_hour_clock_gets_wrong() {
        // 12am is 00:00 and 12pm is 12:00; naive +12 turns both into 24:00.
        let now = 1_758_067_200;
        let midnight = parse_reset_clock("resets 12:00am", now).unwrap();
        let noon = parse_reset_clock("resets 12:00pm", now).unwrap();
        assert_ne!(midnight, noon);
        assert!((midnight as i64 - noon as i64).abs() % 86_400 == 43_200);
    }
}
