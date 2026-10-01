//! The Claude account's plan usage, asked of Claude Code itself.
//!
//! Claude Code answers the data behind its own `/usage` command through the
//! Agent SDK's control protocol (`get_usage`): the five-hour and seven-day
//! windows with their utilisation and reset times. It reads them with its own
//! sign-in; the desktop sees only the answer, never a credential. No model is
//! called, so asking costs nothing.
//!
//! The program asked is the Claude Code binary the adapter ships with — the
//! same one every session runs — started on stdio in stream-json mode, asked
//! once, and stopped. The SDK marks the request experimental, so anything it
//! cannot read is an error the caller treats as "no reading", not a guess.

use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::{
    agents::{
        Provider,
        events::{QuotaSnapshot, QuotaStatus, QuotaWindow},
    },
    security::EnvironmentProfile,
};

/// The Claude Code binary beside the adapter: `@anthropic-ai/claude-agent-sdk-<platform>/claude`
/// in the adapter's own `node_modules`, else `claude` on PATH or in the
/// usual install places.
pub fn locate_claude_binary(adapter_script: &Path, home: &Path) -> Option<PathBuf> {
    let package = adapter_script.parent()?.parent()?;
    let scoped = package.join("node_modules/@anthropic-ai");
    let mut bundled: Vec<PathBuf> = std::fs::read_dir(&scoped)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("claude-agent-sdk-"))
        .map(|entry| entry.path().join("claude"))
        .filter(|path| path.is_file())
        .collect();
    bundled.sort();
    if let Some(found) = bundled.into_iter().next() {
        return Some(found);
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path_var)
        .map(|dir| dir.join("claude"))
        .chain([home.join(".local/bin/claude"), home.join(".claude/local/claude"), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")])
        .find(|path| path.is_file())
}

/// Asks Claude Code for the account's plan usage.
pub fn read_quota(claude: &Path, timeout: Duration) -> Result<QuotaSnapshot, String> {
    let env = EnvironmentProfile::trusted_local().resolve(std::env::vars());
    let mut child = Command::new(claude)
        .args(["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"])
        .current_dir(std::env::temp_dir())
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start Claude Code: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Claude Code took no input")?;
    let stdout = child.stdout.take().ok_or("Claude Code produced no output")?;
    let (tx, rx) = std::sync::mpsc::channel::<(String, Value)>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if value.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let response = value.get("response").cloned().unwrap_or(Value::Null);
            let id = response.get("request_id").and_then(Value::as_str).unwrap_or_default().to_string();
            if tx.send((id, response)).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + timeout;
    let finish = |mut child: std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
    let mut ask = |id: &str, request: Value| -> Result<Value, String> {
        writeln!(stdin, "{}", json!({ "type": "control_request", "request_id": id, "request": request }))
            .and_then(|()| stdin.flush())
            .map_err(|error| format!("Claude Code closed its input: {error}"))?;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok((answered, response)) if answered == id => {
                    return match response.get("subtype").and_then(Value::as_str) {
                        Some("success") => Ok(response.get("response").cloned().unwrap_or(Value::Null)),
                        _ => Err(response.get("error").and_then(Value::as_str).unwrap_or("Claude Code refused the request").to_string()),
                    };
                }
                Ok(_) => {}
                Err(_) => return Err(format!("Claude Code did not answer within {}s", timeout.as_secs())),
            }
        }
    };
    let result = ask("init", json!({ "subtype": "initialize" })).and_then(|_| ask("usage", json!({ "subtype": "get_usage", "skip_behaviors": true })));
    finish(child);
    let usage = result?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    quota_from_usage(&usage, now)
}

/// The `get_usage` answer as a quota snapshot.
pub fn quota_from_usage(usage: &Value, now_unix_ms: u64) -> Result<QuotaSnapshot, String> {
    if usage.get("rate_limits_available").and_then(Value::as_bool) != Some(true) {
        return Err("Claude Code reports no plan limits for this sign-in (an API key, or a provider without them)".into());
    }
    let limits = usage.get("rate_limits").filter(|value| value.is_object()).ok_or("Claude Code sent no rate limits")?;
    let mut windows = Vec::new();
    let mut locked = false;
    // The two windows every plan has, then any per-model week it reports.
    for (key, minutes) in [("five_hour", 300u64), ("seven_day", 10_080), ("seven_day_opus", 10_080), ("seven_day_sonnet", 10_080)] {
        let Some(window) = limits.get(key).filter(|value| value.is_object()) else { continue };
        let used = window.get("utilization").and_then(Value::as_f64);
        if used.is_none() && key != "five_hour" && key != "seven_day" {
            continue;
        }
        locked |= window.get("locked_reason").is_some_and(|reason| !reason.is_null());
        windows.push(QuotaWindow {
            kind: key.to_string(),
            used_percent: used,
            window_minutes: Some(minutes),
            resets_at: window.get("resets_at").and_then(Value::as_str).and_then(parse_iso8601),
        });
    }
    if windows.is_empty() {
        return Err("Claude Code reported no usage windows".into());
    }
    let severities: Vec<&str> = limits
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|limit| limit.get("severity").and_then(Value::as_str))
        .collect();
    let full = windows.iter().any(|window| window.used_percent.is_some_and(|used| used >= 100.0));
    let status = if full || locked {
        QuotaStatus::Rejected
    } else if severities.iter().any(|severity| *severity != "normal") {
        QuotaStatus::Warning
    } else {
        QuotaStatus::Allowed
    };
    Ok(QuotaSnapshot {
        provider: Provider::Claude,
        status,
        windows,
        plan: usage.get("subscription_type").and_then(Value::as_str).map(str::to_string),
        observed_at_unix_ms: now_unix_ms,
    })
}

/// `2026-10-01T12:39:59.688293+00:00` (or `…Z`) as Unix seconds.
pub fn parse_iso8601(text: &str) -> Option<u64> {
    let (date, rest) = text.split_once('T')?;
    let mut parts = date.split('-');
    let (year, month, day): (i64, u32, u32) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    let time_end = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(time_end);
    let mut clock = time.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: f64 = clock.next().unwrap_or("0").parse().ok()?;
    let offset_seconds: i64 = match zone.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            let hours: i64 = digits.get(0..2)?.parse().ok()?;
            let minutes: i64 = digits.get(2..4).unwrap_or("0").parse().ok()?;
            let total = hours * 3600 + minutes * 60;
            if sign == '+' { total } else { -total }
        }
        _ => 0,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second as i64 - offset_seconds;
    u64::try_from(seconds).ok()
}

/// Howard Hinnant's civil-to-days.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_times_read_as_claude_code_writes_them() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2026-10-01T12:39:59.688293+00:00"), Some(1_790_858_399));
        assert_eq!(parse_iso8601("2026-10-01T14:39:59+02:00"), Some(1_790_858_399));
        assert_eq!(parse_iso8601("not a date"), None);
    }

    #[test]
    fn the_usage_answer_becomes_the_accounts_windows() {
        // Shape captured from Claude Code (agent SDK 0.3.284) on a Team plan.
        let usage = json!({
            "subscription_type": "team",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 31, "resets_at": "2026-10-01T12:39:59.688293+00:00", "locked_reason": null },
                "seven_day": { "utilization": 31, "resets_at": "2026-10-04T03:59:59.688324+00:00", "locked_reason": null },
                "seven_day_opus": null,
                "limits": [{ "kind": "session", "percent": 31, "severity": "normal" }]
            }
        });
        let quota = quota_from_usage(&usage, 7).unwrap();
        assert_eq!(quota.provider, Provider::Claude);
        assert_eq!(quota.status, QuotaStatus::Allowed);
        assert_eq!(quota.plan.as_deref(), Some("team"));
        assert_eq!(quota.windows.len(), 2);
        assert_eq!(quota.windows[0].used_percent, Some(31.0));
        assert_eq!(quota.windows[0].window_minutes, Some(300));
        assert_eq!(quota.windows[1].resets_at, Some(1_791_086_399));

        let mut spent = usage.clone();
        spent["rate_limits"]["five_hour"]["utilization"] = json!(100);
        assert_eq!(quota_from_usage(&spent, 7).unwrap().status, QuotaStatus::Rejected);
        let mut warned = usage.clone();
        warned["rate_limits"]["limits"][0]["severity"] = json!("warning");
        assert_eq!(quota_from_usage(&warned, 7).unwrap().status, QuotaStatus::Warning);
        assert!(quota_from_usage(&json!({ "rate_limits_available": false, "rate_limits": null }), 7).is_err());
    }
}
