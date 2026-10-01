//! What the runner reads back out of a goal's journal.
//!
//! Every guard is derived from the record rather than held in memory, so it
//! holds across a restart and across however many callers there are: the
//! cooldown, the no-progress count, the unanswered count, the failed-tick
//! count, the quota hold and "has this session been briefed". The journal is
//! newest first.

use super::clock;
use crate::storage::Storage;
use crate::storage::odyssey::{JournalEntry, JournalKind};

/// Written when a prompt was accepted and no model ever answered it. Not a
/// turn: not charged, and its checkpoint is not evidence of a stale turn.
pub const PROMPT_UNANSWERED: &str = "The prompt was accepted but never answered";
/// Written when a turn ended because the session's transport went away. A
/// restart, not the agent's failure.
pub const TRANSPORT_CLOSED: &str = "The session's transport closed";
/// Written when a tick threw before it could submit anything.
pub const TICK_FAILED: &str = "The tick failed";
/// Summary prefix of the row a quota-wait report holds the run with.
pub const QUOTA_WAIT_HOLD: &str = "The agent is waiting on a quota";
/// The move row's prefix; matches `Storage::MOVED_TO_SESSION`.
pub const MOVED_TO_SESSION: &str = Storage::MOVED_TO_SESSION;
/// What starting a run writes. The guard looks for these exact words.
pub const RUN_STARTED: &str = "Run started";
/// A planning turn, asked for. The settle that answers it is recognised by
/// this line.
pub const PLAN_REQUESTED: &str = "Asked the agent to read the plan document";

/// How long the runner holds after a quota-wait report naming no time.
pub const QUOTA_WAIT_HOLD_MS: i64 = 30 * 60_000;
/// The longest a note's named time may push the hold.
pub const QUOTA_WAIT_HOLD_MAX_MS: i64 = 6 * 60 * 60_000;

pub fn resumed_from(state: &str) -> String {
    format!("Resumed from {state}")
}

fn is(entry: &JournalEntry, kind: JournalKind) -> bool {
    entry.kind == kind
}

fn is_prompt(entry: &JournalEntry) -> bool {
    matches!(entry.kind, JournalKind::Continuation | JournalKind::Briefing)
}

/// Whether this entry is a move to another session.
pub fn is_move(entry: &JournalEntry) -> bool {
    is(entry, JournalKind::State) && entry.summary.starts_with(MOVED_TO_SESSION)
}

/// Whether the goal has been briefed on the session it points at now. A
/// briefing is per session: a move above the newest briefing means the
/// current session has never heard of the goal.
pub fn briefed_this_session(journal: &[JournalEntry]) -> bool {
    for entry in journal {
        if is(entry, JournalKind::Briefing) {
            return true;
        }
        if is_move(entry) {
            return false;
        }
    }
    false
}

pub fn last_move_at(journal: &[JournalEntry]) -> Option<i64> {
    journal.iter().find(|entry| is_move(entry)).map(|entry| entry.at)
}

pub fn move_count(journal: &[JournalEntry]) -> usize {
    journal.iter().filter(|entry| is_move(entry)).count()
}

/// Whether the briefing about to go out picks up work another session did:
/// a move newer than the newest briefing, with a briefing under it.
pub fn handed_over(journal: &[JournalEntry]) -> bool {
    let mut moved = false;
    for entry in journal {
        if is_move(entry) {
            moved = true;
        } else if is(entry, JournalKind::Briefing) {
            return moved;
        }
    }
    false
}

/// When this goal last had a prompt submitted.
pub fn last_prompt_at(journal: &[JournalEntry]) -> Option<i64> {
    journal.iter().find(|entry| is_prompt(entry)).map(|entry| entry.at)
}

/// Whether an entry means a human, a usage reset, a restart or a move picked
/// the run back up. Everything before one has been answered for.
pub fn is_run_restart(entry: &JournalEntry) -> bool {
    if is(entry, JournalKind::Resume) {
        return true;
    }
    if is(entry, JournalKind::Guard) && entry.summary.starts_with(TRANSPORT_CLOSED) {
        return true;
    }
    if is_move(entry) {
        return true;
    }
    is(entry, JournalKind::State) && (entry.summary == RUN_STARTED || entry.summary.starts_with("Resumed from "))
}

fn since_restart(journal: &[JournalEntry]) -> &[JournalEntry] {
    let end = journal.iter().position(is_run_restart).unwrap_or(journal.len());
    &journal[..end]
}

/// The fingerprint half of a checkpoint's detail.
pub fn checkpoint_fingerprint(detail: &str) -> &str {
    detail.split('\n').next().unwrap_or(detail)
}

/// The paths a checkpoint recorded as changed.
pub fn checkpoint_paths(detail: Option<&str>) -> Vec<String> {
    detail.map(|detail| detail.split('\n').skip(1).filter(|line| !line.is_empty()).map(str::to_string).collect()).unwrap_or_default()
}

/// A run's progress: the checkpoint's tree hash with every milestone and
/// task state. Two consecutive turns with the same one changed nothing.
pub fn progress_fingerprint(tree_hash: &str, milestone_states: &[&str], step_states: &[&str]) -> String {
    [tree_hash.to_string(), milestone_states.concat(), step_states.concat()].join("|")
}

/// A checkpoint row's detail: the fingerprint, then the paths this turn changed.
pub fn checkpoint_detail(fingerprint: &str, paths: &[String]) -> String {
    let mut lines = vec![fingerprint.to_string()];
    lines.extend(paths.iter().map(|path| path.replace('\n', " ")));
    lines.join("\n")
}

/// Checkpoints since the restart that belong to turns a model answered.
fn answered_checkpoints(journal: &[JournalEntry]) -> Vec<&str> {
    let mut fingerprints = Vec::new();
    let mut unanswered = false;
    let mut skip_next = false;
    for entry in since_restart(journal) {
        if is(entry, JournalKind::Guard) && entry.summary.starts_with(PROMPT_UNANSWERED) {
            unanswered = true;
        } else if is_prompt(entry) {
            skip_next = unanswered;
            unanswered = false;
        } else if is(entry, JournalKind::Checkpoint)
            && let Some(detail) = entry.detail.as_deref()
        {
            if skip_next {
                skip_next = false;
            } else {
                fingerprints.push(checkpoint_fingerprint(detail));
            }
        }
    }
    fingerprints
}

/// Prompts in a row, since the restart, that were accepted and never answered.
pub fn unanswered_run(journal: &[JournalEntry]) -> usize {
    let mut run = 0;
    let mut unanswered = false;
    for entry in since_restart(journal) {
        if is(entry, JournalKind::Guard) && entry.summary.starts_with(PROMPT_UNANSWERED) {
            unanswered = true;
        } else if is_prompt(entry) {
            if !unanswered {
                break;
            }
            run += 1;
            unanswered = false;
        }
    }
    run
}

/// Consecutive recent turns that changed nothing.
pub fn stale_checkpoint_run(journal: &[JournalEntry]) -> usize {
    let fingerprints = answered_checkpoints(journal);
    if fingerprints.len() < 2 {
        return 0;
    }
    let newest = fingerprints[0];
    fingerprints.iter().take_while(|fingerprint| **fingerprint == newest).count() - 1
}

/// Ticks in a row, since the last restart, that threw before submitting.
pub fn failed_tick_run(journal: &[JournalEntry]) -> usize {
    let mut run = 0;
    for entry in since_restart(journal) {
        if is_prompt(entry) {
            break;
        }
        if is(entry, JournalKind::Guard) && entry.summary.starts_with(TICK_FAILED) {
            run += 1;
        }
    }
    run
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// Errors that mean the process restarted or its channel died.
pub fn looks_like_transport_error(message: Option<&str>) -> bool {
    let Some(message) = message else { return false };
    let lower = message.to_lowercase();
    contains_any(
        &lower,
        &[
            "transport closed",
            "incoming_transport_closed",
            "unsupported operation",
            "connection reset",
            "connection closed",
            "connection refused",
            "broken pipe",
            "channel closed",
            "process exited",
            "not attached",
        ],
    )
}

/// Quota-shaped provider errors: a hint to re-sample, never a verdict.
pub fn looks_like_quota_error(message: Option<&str>) -> bool {
    let Some(message) = message else { return false };
    let lower = message.to_lowercase();
    if contains_any(&lower, &["usage limit", "rate limit", "rate_limit", "quota", "too many requests", "insufficient_quota", "limit reached"]) {
        return true;
    }
    if lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| word == "429") {
        return true;
    }
    // "hit your … limit", with at most one word in between.
    if let Some(index) = lower.find("hit your ") {
        let rest = &lower[index + "hit your ".len()..];
        let words: Vec<&str> = rest.split_whitespace().take(2).collect();
        return words.first().is_some_and(|word| word.starts_with("limit")) || (words.len() == 2 && words[1].starts_with("limit"));
    }
    false
}

/// A blocked report whose reason is a wait: a delegate out of quota, a
/// session limit, a window that resets later.
pub fn looks_like_quota_wait(note: Option<&str>) -> bool {
    let Some(note) = note else { return false };
    let lower = note.to_lowercase();
    if contains_any(&lower, &["quota", "session limit", "usage limit", "usage window", "reset at", "worker quota"]) {
        return true;
    }
    if lower.contains("ratelimit") || lower.contains("rate limit") || lower.contains("rate-limit") || lower.contains("rate_limit") {
        return true;
    }
    if contains_any(&lower, &["until reset", "until the reset", "until window", "until the window"]) {
        return true;
    }
    for subject in ["delegate ", "delegates "] {
        for verb in ["are ", "is ", "remain "] {
            for state in ["out", "exhausted", "quota"] {
                if lower.contains(&format!("{subject}{verb}{state}")) {
                    return true;
                }
            }
        }
    }
    false
}

/// When to try again after a quota-wait report: the clock time the note
/// names, today or tomorrow, else half an hour from now; bounded.
pub fn quota_wait_until(note: &str, now: i64) -> i64 {
    if let Some((hours, minutes)) = first_clock_time(note)
        && hours < 24
        && minutes < 60
    {
        let until = clock::next_local_time(now, hours, minutes);
        return until.min(now + QUOTA_WAIT_HOLD_MAX_MS);
    }
    now + QUOTA_WAIT_HOLD_MS
}

/// The first `H:MM` or `HH:MM` in a text.
fn first_clock_time(text: &str) -> Option<(u32, u32)> {
    let bytes = text.as_bytes();
    for index in 1..bytes.len() {
        if bytes[index] != b':' {
            continue;
        }
        let Some(minutes) = bytes.get(index + 1..index + 3) else { continue };
        if !minutes.iter().all(u8::is_ascii_digit) {
            continue;
        }
        let mut start = index;
        while start > 0 && index - start < 2 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == index {
            continue;
        }
        let hours: u32 = text[start..index].parse().ok()?;
        let minutes: u32 = text[index + 1..index + 3].parse().ok()?;
        return Some((hours, minutes));
    }
    None
}

/// The time the newest quota hold runs to, if one was written after the last
/// prompt and after the last restart.
pub fn held_until(journal: &[JournalEntry]) -> Option<i64> {
    for entry in journal {
        if is_prompt(entry) || is_run_restart(entry) {
            return None;
        }
        if is(entry, JournalKind::Guard) && entry.summary.starts_with(QUOTA_WAIT_HOLD) {
            let detail = entry.detail.as_deref().unwrap_or("");
            let index = detail.find("until=")?;
            let digits: String = detail[index + 6..].chars().take_while(char::is_ascii_digit).collect();
            return digits.parse().ok();
        }
    }
    None
}

/// Whether this claim was already journalled since the last prompt went out.
pub fn already_reported(journal: &[JournalEntry], milestone_id: &str, note: &str) -> bool {
    for entry in journal {
        if is_prompt(entry) {
            return false;
        }
        if is(entry, JournalKind::Report) && entry.milestone_id.as_deref() == Some(milestone_id) && entry.detail.as_deref().unwrap_or("") == note {
            return true;
        }
    }
    false
}

/// The session's token total when the goal was briefed on it.
pub fn start_tokens(journal: &[JournalEntry]) -> Option<i64> {
    let briefing = journal.iter().find(|entry| is(entry, JournalKind::Briefing) && entry.detail.is_some())?;
    let value: serde_json::Value = serde_json::from_str(briefing.detail.as_deref()?).ok()?;
    value.get("startTokens").and_then(serde_json::Value::as_i64)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn entry(kind: JournalKind, at: i64, summary: &str, detail: Option<&str>) -> JournalEntry {
        JournalEntry { id: format!("j{at}"), odyssey_id: "o1".into(), at, kind, milestone_id: None, baseline_id: None, summary: summary.into(), detail: detail.map(str::to_string), provider: None, model: None }
    }

    fn checkpoint(detail: &str, at: i64) -> JournalEntry {
        entry(JournalKind::Checkpoint, at, "checkpoint", Some(detail))
    }

    fn guard(summary: &str, at: i64) -> JournalEntry {
        entry(JournalKind::Guard, at, summary, None)
    }

    fn continuation(at: i64) -> JournalEntry {
        entry(JournalKind::Continuation, at, "Continued milestone 2 of 3", None)
    }

    #[test]
    fn identical_checkpoints_are_turns_that_changed_nothing() {
        assert_eq!(stale_checkpoint_run(&[checkpoint("a", 3), checkpoint("a", 2), checkpoint("a", 1)]), 2);
        assert_eq!(stale_checkpoint_run(&[checkpoint("b", 3), checkpoint("a", 2), checkpoint("a", 1)]), 0);
        assert_eq!(stale_checkpoint_run(&[checkpoint("a", 1)]), 0);
        assert_eq!(stale_checkpoint_run(&[]), 0);
    }

    #[test]
    fn a_restart_forgets_the_evidence_before_it() {
        let restart = entry(JournalKind::State, 4, &resumed_from("blocked"), None);
        assert_eq!(stale_checkpoint_run(&[restart.clone(), checkpoint("a", 3), checkpoint("a", 2), checkpoint("a", 1)]), 0);
        assert_eq!(stale_checkpoint_run(&[checkpoint("a", 5), restart.clone(), checkpoint("a", 3), checkpoint("a", 2)]), 0);
        assert_eq!(stale_checkpoint_run(&[checkpoint("a", 7), checkpoint("a", 6), checkpoint("a", 5), restart, checkpoint("a", 1)]), 2);
        assert!(is_run_restart(&entry(JournalKind::State, 1, RUN_STARTED, None)));
        assert!(is_run_restart(&entry(JournalKind::Resume, 1, "usage reset", None)));
        assert!(!is_run_restart(&entry(JournalKind::State, 1, "Paused by you", None)));
        assert!(!is_run_restart(&guard("3 turns in a row changed nothing", 1)));
        assert!(is_run_restart(&guard(&format!("{TRANSPORT_CLOSED}: Incoming transport closed"), 1)));
    }

    #[test]
    fn unanswered_prompts_are_not_stale_turns_and_are_counted() {
        let journal = vec![
            guard(PROMPT_UNANSWERED, 10),
            continuation(9),
            checkpoint("a", 8),
            guard(PROMPT_UNANSWERED, 7),
            continuation(6),
            checkpoint("a", 5),
            continuation(4),
            checkpoint("a", 3),
            continuation(2),
            checkpoint("b", 1),
        ];
        assert_eq!(stale_checkpoint_run(&journal), 0);
        let without: Vec<_> = journal.iter().filter(|entry| entry.kind != JournalKind::Guard).cloned().collect();
        assert_eq!(stale_checkpoint_run(&without), 2);
        assert_eq!(unanswered_run(&[guard(PROMPT_UNANSWERED, 6), continuation(5), checkpoint("a", 4), guard(PROMPT_UNANSWERED, 3), continuation(2), checkpoint("a", 1)]), 2);
        assert_eq!(unanswered_run(&[guard(PROMPT_UNANSWERED, 6), continuation(5), continuation(4), guard(PROMPT_UNANSWERED, 3), continuation(2)]), 1);
        assert_eq!(unanswered_run(&[]), 0);
    }

    #[test]
    fn fingerprints_and_checkpoint_details_round_trip() {
        assert_ne!(progress_fingerprint("3f2a", &["verified", "active"], &["done"]), progress_fingerprint("3f2b", &["verified", "active"], &["done"]));
        assert_ne!(progress_fingerprint("3f2a", &["active"], &["done"]), progress_fingerprint("3f2a", &["active"], &["in_progress"]));
        let detail = checkpoint_detail("3f2a|active|", &["Assets/a.cs".into(), "Docs/b.md".into()]);
        assert_eq!(checkpoint_fingerprint(&detail), "3f2a|active|");
        assert_eq!(checkpoint_paths(Some(&detail)), ["Assets/a.cs", "Docs/b.md"]);
        assert!(checkpoint_paths(Some("2000|671|109698|active")).is_empty());
    }

    #[test]
    fn errors_are_read_for_what_they_hint_at() {
        assert!(looks_like_transport_error(Some("Incoming transport closed: {\"reason\":\"incoming_transport_closed\"}")));
        assert!(looks_like_transport_error(Some("the agent rejected the request: Internal error: unsupported operation")));
        assert!(!looks_like_transport_error(Some("compile error in src/main.rs")));
        assert!(!looks_like_transport_error(None));
        for message in ["usage limit reached", "Rate limit exceeded", "HTTP 429", "insufficient_quota", "You've hit your limit", "You've hit your session limit"] {
            assert!(looks_like_quota_error(Some(message)), "{message}");
        }
        assert!(!looks_like_quota_error(Some("tests failed: 4290 lines")));
        assert!(!looks_like_quota_error(Some("compile error")));
    }

    #[test]
    fn a_blocked_report_about_quota_is_a_wait_until_the_time_it_names() {
        assert!(looks_like_quota_wait(Some("delegates are out of quota until the reset at 00:40")));
        assert!(looks_like_quota_wait(Some("worker quota exhausted")));
        assert!(!looks_like_quota_wait(Some("the build is broken")));
        let now = clock::now_ms();
        let until = quota_wait_until("reset at 00:40", now);
        assert!(until > now && until <= now + QUOTA_WAIT_HOLD_MAX_MS);
        assert_eq!(quota_wait_until("no time named", now), now + QUOTA_WAIT_HOLD_MS);
        let hold = guard(QUOTA_WAIT_HOLD, 5);
        let mut hold = hold;
        hold.detail = Some("until=12345\nmore".into());
        assert_eq!(held_until(&[hold.clone()]), Some(12345));
        assert_eq!(held_until(&[continuation(6), hold.clone()]), None, "a prompt after the hold ends it");
    }

    #[test]
    fn a_move_means_the_new_session_needs_a_briefing() {
        let briefing = entry(JournalKind::Briefing, 1, "briefed", None);
        let moved = entry(JournalKind::State, 2, &format!("{MOVED_TO_SESSION} s2 (codex)"), None);
        assert!(briefed_this_session(std::slice::from_ref(&briefing)));
        assert!(!briefed_this_session(&[moved.clone(), briefing.clone()]));
        assert!(handed_over(&[moved.clone(), briefing.clone()]));
        assert!(!handed_over(std::slice::from_ref(&moved)), "moved before it was ever briefed: nothing to inherit");
        assert_eq!(last_move_at(&[moved.clone(), briefing]), Some(2));
        assert_eq!(move_count(&[moved]), 1);
    }

    #[test]
    fn failed_ticks_count_until_a_prompt_goes_out() {
        let fail = |at| guard(&format!("{TICK_FAILED}: NOT_READY"), at);
        assert_eq!(failed_tick_run(&[fail(3), fail(2), fail(1)]), 3);
        assert_eq!(failed_tick_run(&[fail(3), continuation(2), fail(1)]), 1);
    }
}
