//! Token usage read from Claude Code's transcript
//! (docs/plans/odyssey-second-orchestrator.md §2.6).
//!
//! Deliberately the provider-neutral output type (`agents::usage`), because the callers — the budget the goal is charged against,
//! the answered-turn check, the spend samples — are agent-agnostic and should
//! stay that way. Only the file and its shape differ.
//!
//! **Where it is.** `~/.claude/projects/<slug>/<session>.jsonl`, where the
//! slug is the absolute project root with every character that is not a letter,
//! a digit or a dash replaced by a dash. `/Users/p/KitWorkbench` becomes
//! `-Users-p-KitWorkbench`. The session is the adapter's own id, the UUID
//! `session/new` returned.
//!
//! **What it says.** One JSON object per line. An `assistant` line carries
//! `message.usage`, which is the Anthropic API's own accounting and counts
//! differently from the desktop's convention:
//!
//! - `input_tokens` is the input that was *neither* read from nor written to
//!   the prompt cache — the desktop's `input_tokens` includes its cached part;
//! - `cache_read_input_tokens` is the part served from cache;
//! - `cache_creation_input_tokens` is the part written into it, which is paid
//!   for (at a premium), so it is paid input here, not a free extra;
//! - `output_tokens_details.thinking_tokens` is the reasoning.
//!
//! The totals are reported in the desktop's convention — `input_tokens` is everything
//! that went in, with the cached part named separately as a subset — so a
//! reader prices every provider's session the same way.
//!
//! **Duplicates.** The same response is written several times (once per
//! streaming block), so a naive sum over-reports: 168 `assistant` lines for
//! 118 responses on a real session, 1.42x. There is a precise key
//! for it — `message.id` — so the fold is exact rather than a fingerprint
//! match, and folded lines are counted in `folded_items`.
//!
//! **Subagents.** A `Task` subagent's turns are written into the *same* file
//! with `isSidechain: true`. They are charged to the same account, so they
//! are counted; leaving them out would make a delegating turn look free.

use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::{
    DesktopError,
    agents::usage::{MAX_TRANSCRIPT_BYTES, TranscriptUsage, UsageCall, UsageTotals},
};

/// Claude Code's own directory for a project's transcripts.
///
/// The slug rule is Claude Code's, not ours, and is reproduced from a
/// directory it wrote rather than guessed: *each* character outside
/// `[A-Za-z0-9-]` becomes one dash, so a leading `/` is why every slug starts
/// with one and `/a/-b` becomes `-a--b` rather than `-a-b`.
pub fn project_dir(home: &Path, root: &Path) -> PathBuf {
    home.join(".claude/projects").join(slug_for(root))
}

/// The directory name Claude Code gives a project root.
pub fn slug_for(root: &Path) -> String {
    root.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

/// The transcript file for one session under a project root.
pub fn transcript_path(home: &Path, root: &Path, session_id: &str) -> PathBuf {
    project_dir(home, root).join(format!("{session_id}.jsonl"))
}

fn u64_at(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

/// Aggregates one Claude Code transcript into the same totals every
/// transcript produces.
pub fn read_transcript_usage(path: &Path) -> Result<TranscriptUsage, DesktopError> {
    let metadata = std::fs::metadata(path).map_err(|e| DesktopError::io(format!("transcript unavailable: {e}")))?;
    if metadata.len() > MAX_TRANSCRIPT_BYTES {
        return Err(DesktopError::limit_exceeded("transcript exceeds 256 MiB"));
    }
    let file = std::fs::File::open(path).map_err(|e| DesktopError::io(e.to_string()))?;
    let reader = BufReader::new(file);
    let mut out = TranscriptUsage {
        path: path.to_path_buf(),
        bytes: metadata.len(),
        lines: 0,
        parse_errors: 0,
        schema_versions: Vec::new(),
        calls: Vec::new(),
        totals: UsageTotals::default(),
    };
    // Responses already counted. A message id repeats across streaming blocks
    // and, on a resumed session, across the replayed prefix as well, so the
    // set is the whole file rather than the previous line.
    let mut seen: HashSet<String> = HashSet::new();

    for line in reader.lines() {
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
        if record.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = record.get("message") else { continue };
        let Some(usage) = message.get("usage").filter(|value| value.is_object()) else { continue };

        // `message.id` names the response; `requestId` is the fallback for a
        // line that has no message id, and the line number for neither.
        let key = message
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| record.get("requestId").and_then(Value::as_str))
            .map(str::to_string);
        if let Some(key) = &key
            && !seen.insert(key.clone())
        {
            if let Some(call) = out.calls.iter_mut().find(|call| &call.item_id == key) {
                call.folded_item_ids.push(key.clone());
            }
            out.totals.folded_items += 1;
            continue;
        }

        let uncached = u64_at(usage, "input_tokens").unwrap_or(0);
        let cached = u64_at(usage, "cache_read_input_tokens").unwrap_or(0);
        let written = u64_at(usage, "cache_creation_input_tokens").unwrap_or(0);
        let output = u64_at(usage, "output_tokens").unwrap_or(0);
        let reasoning = usage
            .get("output_tokens_details")
            .and_then(|details| details.get("thinking_tokens"))
            .and_then(Value::as_u64);
        // The desktop's convention: everything that went in, with the cached part a
        // named subset of it rather than a separate addend.
        let input = uncached + cached + written;

        out.totals.calls += 1;
        out.totals.input_tokens += input;
        out.totals.output_tokens += output;
        out.totals.cached_input_tokens += cached;
        out.totals.cache_write_input_tokens += written;
        match reasoning {
            Some(value) => out.totals.reasoning_tokens += value,
            None => out.totals.partial = true,
        }
        // Everything the cache did not serve is paid for, and a cache write
        // is paid for twice over — it is charged now and read back later.
        out.totals.paid_input_tokens += uncached + written;
        // What caching could have saved against what it did, on the same
        // definition the other readers use so the two numbers are comparable.
        if let Some(previous) = out.calls.last() {
            let cacheable = previous.input_tokens.min(input);
            out.totals.cacheable_prefix_tokens += cacheable;
            out.totals.missed_prefix_tokens += cacheable.saturating_sub(cached);
        }

        out.calls.push(UsageCall {
            generation: 0,
            item_id: key.unwrap_or_else(|| format!("line-{}", out.lines)),
            kind: "assistant".into(),
            folded_item_ids: Vec::new(),
            created_at: record.get("timestamp").and_then(Value::as_str).map(str::to_string),
            input_tokens: input,
            output_tokens: output,
            reasoning_tokens: reasoning,
            cached_input_tokens: Some(cached),
            cache_write_input_tokens: Some(written),
            context_window: None,
            cost: None,
            missed_prefix_tokens: None,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(id: &str, uncached: u64, cached: u64, written: u64, output: u64, thinking: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "requestId": format!("req_{id}"),
            "timestamp": "2026-09-17T18:19:23.060Z",
            "message": {
                "id": id,
                "role": "assistant",
                "usage": {
                    "input_tokens": uncached,
                    "cache_creation_input_tokens": written,
                    "cache_read_input_tokens": cached,
                    "output_tokens": output,
                    "output_tokens_details": { "thinking_tokens": thinking },
                },
            },
        })
        .to_string()
    }

    #[test]
    fn a_projects_transcripts_live_under_a_dashed_slug_of_its_root() {
        // Shaped like directories the adapter actually wrote, and the second
        // is why the rule is per character rather than per run: the `/`
        // before `-Users` produced a second dash.
        assert_eq!(slug_for(Path::new("/Users/me/ThingMaker")), "-Users-me-ThingMaker");
        assert_eq!(
            slug_for(Path::new("/private/tmp/claude-501/-Users-me-ThingMaker/scratchpad/probe")),
            "-private-tmp-claude-501--Users-me-ThingMaker-scratchpad-probe"
        );
        assert_eq!(slug_for(Path::new("/Users/p/my_app.v2")), "-Users-p-my-app-v2");
        assert_eq!(
            transcript_path(Path::new("/home/u"), Path::new("/w/p"), "d847b2a3-c7b5-4459-8b0f-02fdd03031a4"),
            PathBuf::from("/home/u/.claude/projects/-w-p/d847b2a3-c7b5-4459-8b0f-02fdd03031a4.jsonl")
        );
    }

    #[test]
    fn totals_follow_the_desktop_convention_so_every_provider_is_priced_the_same_way() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("s.jsonl");
        std::fs::write(
            &path,
            [
                r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
                &assistant("msg_1", 2, 35_570, 39_291, 150, 0),
                "not json",
                &assistant("msg_2", 3, 74_861, 520, 651, 519),
            ]
            .join("\n"),
        )
        .unwrap();
        let usage = read_transcript_usage(&path).unwrap();
        assert_eq!(usage.parse_errors, 1);
        assert_eq!(usage.totals.calls, 2);
        // Input is everything that went in, cached included.
        assert_eq!(usage.totals.input_tokens, (2 + 35_570 + 39_291) + (3 + 74_861 + 520));
        assert_eq!(usage.totals.cached_input_tokens, 35_570 + 74_861);
        assert_eq!(usage.totals.cache_write_input_tokens, 39_291 + 520);
        // A cache write is paid for; a cache read is what caching saved.
        assert_eq!(usage.totals.paid_input_tokens, (2 + 39_291) + (3 + 520));
        assert_eq!(usage.totals.output_tokens, 150 + 651);
        assert_eq!(usage.totals.reasoning_tokens, 519);
        assert!(!usage.totals.partial);
    }

    #[test]
    fn a_response_written_several_times_is_counted_once() {
        // Measured on a real session: 168 assistant lines, 118 responses.
        // Summing the lines over-reports the budget by 1.42x.
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("s.jsonl");
        std::fs::write(
            &path,
            [
                assistant("msg_1", 10, 0, 0, 5, 0),
                assistant("msg_1", 10, 0, 0, 5, 0),
                assistant("msg_1", 10, 0, 0, 5, 0),
                assistant("msg_2", 20, 0, 0, 7, 0),
            ]
            .join("\n"),
        )
        .unwrap();
        let usage = read_transcript_usage(&path).unwrap();
        assert_eq!(usage.totals.calls, 2);
        assert_eq!(usage.totals.folded_items, 2);
        assert_eq!(usage.totals.input_tokens, 30);
        assert_eq!(usage.totals.output_tokens, 12);
        assert_eq!(usage.calls[0].folded_item_ids.len(), 2);
    }

    #[test]
    fn a_subagents_turns_are_in_the_same_file_and_are_charged_to_the_same_account() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("s.jsonl");
        let mut sidechain: Value = serde_json::from_str(&assistant("msg_sub", 40, 0, 0, 9, 0)).unwrap();
        sidechain["isSidechain"] = Value::Bool(true);
        std::fs::write(&path, [assistant("msg_1", 10, 0, 0, 5, 0), sidechain.to_string()].join("\n")).unwrap();
        let usage = read_transcript_usage(&path).unwrap();
        assert_eq!(usage.totals.calls, 2, "a delegating turn is not free");
        assert_eq!(usage.totals.paid_input_tokens, 50);
    }

    #[test]
    fn a_transcript_that_is_not_there_is_an_error_not_a_zero() {
        // A zero would read as "this turn cost nothing", which the budget and
        // the answered-turn check would both believe.
        let temp = tempfile::tempdir().unwrap();
        assert!(read_transcript_usage(&temp.path().join("missing.jsonl")).is_err());
    }
}
