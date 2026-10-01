//! What a Codex account says about its quota.
//!
//! Codex reports its windows as percentages — a five-hour `primary` and a
//! weekly `secondary` — with reset times, on demand (`account/rateLimits/read`)
//! and whenever they change (`account/rateLimits/updated`). Both carry the
//! same `RateLimitSnapshot`, which is reduced here to the provider-neutral
//! [`QuotaSnapshot`].

use serde_json::Value;

use crate::agents::{
    Provider,
    events::{QuotaSnapshot, QuotaStatus, QuotaWindow},
};

/// Percentage at or above which a window is reported as a warning.
const WARNING_PERCENT: f64 = 90.0;

/// Reads a `RateLimitSnapshot` (the `rateLimits` of either message).
pub fn quota_from_rate_limits(snapshot: &Value, observed_at_unix_ms: u64) -> Option<QuotaSnapshot> {
    let window = |name: &str| -> Option<QuotaWindow> {
        let value = snapshot.get(name).filter(|value| !value.is_null())?;
        Some(QuotaWindow {
            kind: name.to_string(),
            used_percent: value.get("usedPercent").and_then(Value::as_f64),
            window_minutes: value.get("windowDurationMins").and_then(Value::as_u64),
            resets_at: value.get("resetsAt").and_then(Value::as_u64),
        })
    };
    let windows: Vec<QuotaWindow> = ["primary", "secondary"].iter().filter_map(|name| window(name)).collect();
    if windows.is_empty() {
        return None;
    }
    let reached = snapshot.get("rateLimitReachedType").is_some_and(|value| !value.is_null())
        || windows.iter().any(|window| window.used_percent.is_some_and(|used| used >= 100.0));
    let warning = windows.iter().any(|window| window.used_percent.is_some_and(|used| used >= WARNING_PERCENT));
    Some(QuotaSnapshot {
        provider: Provider::Codex,
        status: if reached {
            QuotaStatus::Rejected
        } else if warning {
            QuotaStatus::Warning
        } else {
            QuotaStatus::Allowed
        },
        windows,
        plan: snapshot.get("planType").and_then(Value::as_str).map(str::to_string),
        observed_at_unix_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_windows_the_account_reports_become_a_quota_snapshot() {
        // As `account/rateLimits/read` answered on a Plus account, 30 September 2026.
        let snapshot = json!({
            "limitId": "codex", "primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1790782188u64},
            "secondary": {"usedPercent": 70, "windowDurationMins": 10080, "resetsAt": 1791062537u64},
            "planType": "plus", "rateLimitReachedType": null
        });
        let quota = quota_from_rate_limits(&snapshot, 1).unwrap();
        assert_eq!(quota.status, QuotaStatus::Allowed);
        assert_eq!(quota.plan.as_deref(), Some("plus"));
        assert_eq!(quota.windows.len(), 2);
        assert_eq!(quota.windows[0].window_minutes, Some(300));
        assert_eq!(quota.windows[1].used_percent, Some(70.0));

        let spent = json!({"primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": 50}, "rateLimitReachedType": "primary"});
        let spent = quota_from_rate_limits(&spent, 1).unwrap();
        assert_eq!(spent.status, QuotaStatus::Rejected);
        assert_eq!(spent.available_again_at(), Some(50));

        let close = json!({"primary": {"usedPercent": 93, "windowDurationMins": 300}});
        assert_eq!(quota_from_rate_limits(&close, 1).unwrap().status, QuotaStatus::Warning);
        assert_eq!(quota_from_rate_limits(&json!({}), 1), None);
    }
}
