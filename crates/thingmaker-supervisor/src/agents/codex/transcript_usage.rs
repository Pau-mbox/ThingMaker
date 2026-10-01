//! Token usage read from Codex's own transcript (its "rollout").
//!
//! **Where it is.** `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl`
//! (or under the session's `$CODEX_HOME`). The thread id is the one
//! `thread/start` answered with, which is the session's agent id here.
//!
//! **What it says.** One JSON object per line. After each model response Codex
//! writes an `event_msg` whose payload is `token_count`, carrying that
//! response's `last_token_usage` and the thread's running
//! `total_token_usage`. Codex's `input_tokens` already *includes*
//! `cached_input_tokens`, which is the desktop's convention, so nothing is
//! restated.
//!
//! **Duplicates.** A `token_count` is also written when only the rate limits
//! changed; its total is the same as the one before it, so it is folded
//! rather than counted as a call.

use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::{
    DesktopError,
    agents::usage::{MAX_TRANSCRIPT_BYTES, TranscriptUsage, UsageCall, UsageTotals},
};

/// Finds a thread's rollout file under `codex_home/sessions`, newest day
/// first. `None` when the thread has written nothing yet.
pub fn find_rollout(codex_home: &Path, thread_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread_id}.jsonl");
    let mut days: Vec<PathBuf> = Vec::new();
    let sorted = |dir: &Path| -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
        entries.sort();
        entries.reverse();
        entries
    };
    for year in sorted(&codex_home.join("sessions")) {
        for month in sorted(&year) {
            days.extend(sorted(&month));
        }
    }
    days.into_iter().find_map(|day| {
        std::fs::read_dir(day)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&suffix)))
    })
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Aggregates one Codex rollout into the same totals every transcript produces.
pub fn read_transcript_usage(path: &Path) -> Result<TranscriptUsage, DesktopError> {
    let metadata = std::fs::metadata(path).map_err(|e| DesktopError::io(format!("transcript unavailable: {e}")))?;
    if metadata.len() > MAX_TRANSCRIPT_BYTES {
        return Err(DesktopError::limit_exceeded("transcript exceeds 256 MiB"));
    }
    let file = std::fs::File::open(path).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut out = TranscriptUsage {
        path: path.to_path_buf(),
        bytes: metadata.len(),
        lines: 0,
        parse_errors: 0,
        schema_versions: Vec::new(),
        calls: Vec::new(),
        totals: UsageTotals::default(),
    };
    let mut previous_total: Option<u64> = None;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            out.parse_errors += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        out.lines += 1;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            out.parse_errors += 1;
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = record.get("payload").filter(|payload| payload.get("type").and_then(Value::as_str) == Some("token_count")) else {
            continue;
        };
        let Some(info) = payload.get("info").filter(|info| !info.is_null()) else { continue };
        let total = info.get("total_token_usage").map(|usage| u64_at(usage, "total_tokens"));
        if total.is_some() && total == previous_total {
            out.totals.folded_items += 1;
            if let Some(call) = out.calls.last_mut() {
                call.folded_item_ids.push(format!("line-{}", out.lines));
            }
            continue;
        }
        previous_total = total;
        let Some(last) = info.get("last_token_usage") else { continue };
        let input = u64_at(last, "input_tokens");
        let cached = u64_at(last, "cached_input_tokens");
        let written = u64_at(last, "cache_write_input_tokens");
        let output = u64_at(last, "output_tokens");
        let reasoning = last.get("reasoning_output_tokens").and_then(Value::as_u64);

        out.totals.calls += 1;
        out.totals.input_tokens += input;
        out.totals.output_tokens += output;
        out.totals.cached_input_tokens += cached;
        out.totals.cache_write_input_tokens += written;
        match reasoning {
            Some(value) => out.totals.reasoning_tokens += value,
            None => out.totals.partial = true,
        }
        out.totals.paid_input_tokens += input.saturating_sub(cached);
        if let Some(previous) = out.calls.last() {
            let cacheable = previous.input_tokens.min(input);
            out.totals.cacheable_prefix_tokens += cacheable;
            out.totals.missed_prefix_tokens += cacheable.saturating_sub(cached);
        }
        out.calls.push(UsageCall {
            generation: 0,
            item_id: format!("line-{}", out.lines),
            kind: "response".into(),
            created_at: record.get("timestamp").and_then(Value::as_str).map(str::to_string),
            folded_item_ids: Vec::new(),
            input_tokens: input,
            output_tokens: output,
            reasoning_tokens: reasoning,
            cached_input_tokens: Some(cached),
            cache_write_input_tokens: Some(written),
            context_window: info.get("model_context_window").and_then(Value::as_u64),
            cost: None,
            missed_prefix_tokens: None,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(total: u64, input: u64, cached: u64, output: u64) -> String {
        format!(
            r#"{{"timestamp":"t","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":{total}}},"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":{output},"reasoning_output_tokens":7,"total_tokens":{}}},"model_context_window":258400}}}}}}"#,
            input + output
        )
    }

    #[test]
    fn each_response_is_one_call_and_a_rate_limit_only_update_is_folded() {
        let temp = tempfile::tempdir().unwrap();
        let day = temp.path().join("sessions/2026/09/30");
        std::fs::create_dir_all(&day).unwrap();
        let path = day.join("rollout-2026-09-30T13-16-32-01a0f207-cb1b-7862-836a-1971b2777166.jsonl");
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"01a0f207"}}"#.to_string(),
            count(30_609, 30_338, 21_632, 271),
            count(30_609, 30_338, 21_632, 271),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}"#.to_string(),
            count(62_000, 31_000, 30_208, 400),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(find_rollout(temp.path(), "01a0f207-cb1b-7862-836a-1971b2777166"), Some(path.clone()));
        assert_eq!(find_rollout(temp.path(), "nope"), None);

        let usage = read_transcript_usage(&path).unwrap();
        assert_eq!(usage.totals.calls, 2);
        assert_eq!(usage.totals.folded_items, 1);
        assert_eq!(usage.totals.input_tokens, 61_338, "input already includes the cached part");
        assert_eq!(usage.totals.cached_input_tokens, 51_840);
        assert_eq!(usage.totals.paid_input_tokens, 61_338 - 51_840);
        assert_eq!(usage.totals.output_tokens, 671);
        assert_eq!(usage.calls[1].context_window, Some(258_400));
    }
}
