/**
 * Reads the model's report line out of a settled turn (docs/plans/odyssey.md
 * §4.3).
 *
 * The line is a convention, not a protocol: a missing or malformed one means
 * "work continued, nothing claimed", and the runner iterates. Nothing here can
 * mark a milestone done — a parsed `status=complete` is a *claim*, which the
 * caller records as `reported`.
 */

export type Report = {
  /** 1-based, as the model was asked to write it. */
  milestone: number;
  status: "complete" | "blocked";
  note: string;
};

const LINE = /^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-REPORT:\s*(.+)$/im;

/**
 * Parses the last report line in a message. Later lines win, so a model that
 * restates its report at the end of a long reply is read as it intended.
 */
export function parseReport(text: string): Report | null {
  if (!text) return null;
  // Scan from the end: `String.matchAll` keeps order, so the last match is the
  // model's final word on the turn.
  const matches = [...text.matchAll(/^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-REPORT:\s*(.+)$/gim)];
  const body = matches.at(-1)?.[1] ?? text.match(LINE)?.[1];
  if (!body) return null;

  const milestone = /(?:^|\s)milestone\s*=\s*(\d+)/i.exec(body);
  const status = /(?:^|\s)status\s*=\s*(complete|blocked)/i.exec(body);
  if (!milestone || !status) return null;

  const index = Number.parseInt(milestone[1] ?? "", 10);
  if (!Number.isFinite(index) || index < 1) return null;

  // The note runs to the end of the line, so it may contain anything but a
  // newline. An absent note is not a failure to parse.
  const note = /(?:^|\s)note\s*=\s*(.*)$/i.exec(body)?.[1]?.trim() ?? "";
  return { milestone: index, status: status[1]?.toLowerCase() as Report["status"], note };
}

/**
 * A run's progress fingerprint, used by the no-progress guard (§4.4). Two
 * consecutive turns with the same fingerprint changed nothing on disk and
 * nothing in the plan.
 *
 * The disk half is the checkpoint's tree hash — every path with its content
 * hash — not a count of changed files. The count used to come from a diff
 * against a baseline taken when the session opened; it saturated at the
 * review cap on the third turn of the first real run and read "2000 files"
 * for the next sixty-three, so it could neither see a change nor miss one.
 */
export function progressFingerprint(input: { treeHash: string; milestoneStates: string[]; stepStates: string[] }): string {
  return [input.treeHash, input.milestoneStates.join(""), input.stepStates.join("")].join("|");
}

/**
 * The `detail` of a checkpoint row: the fingerprint on the first line, then
 * the paths this turn changed, one per line. The guard reads the first line;
 * a reader of the history sees the rest.
 */
export function checkpointDetail(fingerprint: string, paths: string[]): string {
  return [fingerprint, ...paths.map((path) => path.replace(/\n/g, " "))].join("\n");
}

/** The fingerprint half of a checkpoint's detail (the whole thing for rows written before paths were kept). */
export function checkpointFingerprint(detail: string): string {
  return detail.split("\n")[0] ?? detail;
}

/** The paths a checkpoint recorded as changed, if that checkpoint kept them. */
export function checkpointPaths(detail: string | undefined): string[] {
  if (!detail) return [];
  return detail.split("\n").slice(1).filter(Boolean);
}

/**
 * The guard row written when Kit accepted a prompt and no model ever answered
 * it — the process had no quota behind it or was mid-restart. Twenty-five of
 * fifty-four continuations on the first real run were this. They are not
 * turns: they are not charged to the budget and their checkpoints are not
 * evidence that a turn changed nothing.
 */
export const PROMPT_UNANSWERED = "The prompt was accepted but never answered";

/**
 * The guard row written when a turn ended because the session's transport
 * went away underneath it. That is a restart, not the agent's failure, so
 * the run stays `running` and the guard's history starts again after it.
 */
export const TRANSPORT_CLOSED = "The session's transport closed";

/** Errors that mean the process restarted or its channel died, not that the model failed. */
export function looksLikeTransportError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /transport closed|incoming_transport_closed|unsupported operation|connection (?:reset|closed|refused)|broken pipe|channel closed|process exited|not attached/i.test(message);
}

/**
 * The summary prefix of the row `odyssey_repoint` writes when a goal is
 * pointed at a different session (docs/plans/odyssey-second-orchestrator.md
 * §2.3). It has to match `Storage::MOVED_TO_SESSION` exactly: the runner reads
 * it to decide that the session in front of it has never been told the goal.
 */
export const MOVED_TO_SESSION = "Moved to session";

/** Whether this entry is a move to another session. */
export function isMove(entry: { kind: string; summary: string }): boolean {
  return entry.kind === "state" && entry.summary.startsWith(MOVED_TO_SESSION);
}

/**
 * Whether the goal has been briefed on the session it is pointed at *now*.
 *
 * A briefing is per session, not per goal. The transcript does not move with
 * the run, so a session that was never briefed knows nothing: no goal, no
 * milestones, no protocol, no handoff note. Continuing into it would submit
 * "Continue. Milestone 7/9" to a model that has never heard of milestone 7.
 *
 * The journal is newest-first, so the first of the two markers found wins: a
 * briefing above the newest move is this session's, a move above the newest
 * briefing means the current session is waiting for one.
 */
export function briefedThisSession(journal: { kind: string; summary: string }[]): boolean {
  for (const entry of journal) {
    if (entry.kind === "briefing") return true;
    if (isMove(entry)) return false;
  }
  return false;
}

/** When this goal last moved, from the record, or `null` if it never has. */
export function lastMoveAt(journal: { kind: string; summary: string; at: number }[]): number | null {
  return journal.find(isMove)?.at ?? null;
}

/** How many sessions this goal has run on, for the record and the strip. */
export function moveCount(journal: { kind: string; summary: string }[]): number {
  return journal.filter(isMove).length;
}

/**
 * Whether the briefing this session is about to get is picking up work another
 * session already did.
 *
 * Not the same as "the goal has moved": a goal moved before it was ever
 * briefed — the user restarting a session before pressing Start — has nothing
 * to inherit, and telling that model to read notes that do not exist teaches
 * it the prompt is unreliable. So: a move newer than the newest briefing, with
 * a briefing somewhere under it.
 */
export function handedOver(journal: { kind: string; summary: string }[]): boolean {
  let moved = false;
  for (const entry of journal) {
    if (isMove(entry)) moved = true;
    else if (entry.kind === "briefing") return moved;
  }
  return false;
}

/** What `odysseyStart` writes when a run is started or picked back up. */
export const RUN_STARTED = "Run started";
export const resumedFrom = (state: string) => `Resumed from ${state}`;

/**
 * Whether a journal entry means "a human (or a usage reset) restarted this
 * run". Everything before one is history the guard has already been answered
 * for.
 */
export function isRunRestart(entry: { kind: string; summary: string }): boolean {
  if (entry.kind === "resume") return true;
  // A transport that closed under the turn means the process came back new;
  // whatever the guard had counted before it was about a process that is gone.
  if (entry.kind === "guard" && entry.summary.startsWith(TRANSPORT_CLOSED)) return true;
  // A move is the strongest restart there is: a different session, possibly a
  // different program on a different account. Checkpoints and unanswered
  // prompts from before it were about something that is no longer running.
  if (isMove(entry)) return true;
  return entry.kind === "state" && (entry.summary === RUN_STARTED || entry.summary.startsWith("Resumed from "));
}

type JournalLike = { kind: string; summary: string; detail?: string | undefined };

/** The journal since the newest restart, newest first. */
function sinceRestart(journal: JournalLike[]): JournalLike[] {
  const restart = journal.findIndex(isRunRestart);
  return journal.slice(0, restart < 0 ? journal.length : restart);
}

/**
 * Checkpoints since the restart that belong to turns a model actually took,
 * newest first. A checkpoint is written just before its continuation; when
 * that continuation was never answered, the checkpoint measured nothing and
 * is left out.
 */
function answeredCheckpoints(journal: JournalLike[]): string[] {
  const fingerprints: string[] = [];
  let unanswered = false;
  let skipNext = false;
  for (const entry of sinceRestart(journal)) {
    if (entry.kind === "guard" && entry.summary.startsWith(PROMPT_UNANSWERED)) unanswered = true;
    else if (entry.kind === "continuation" || entry.kind === "briefing") {
      skipNext = unanswered;
      unanswered = false;
    } else if (entry.kind === "checkpoint" && entry.detail) {
      if (skipNext) skipNext = false;
      else fingerprints.push(checkpointFingerprint(entry.detail));
    }
  }
  return fingerprints;
}

/**
 * How many prompts in a row, since the restart, Kit accepted and no model
 * answered. Stops at the first continuation that was answered.
 */
export function unansweredRun(journal: JournalLike[]): number {
  let run = 0;
  let unanswered = false;
  for (const entry of sinceRestart(journal)) {
    if (entry.kind === "guard" && entry.summary.startsWith(PROMPT_UNANSWERED)) unanswered = true;
    else if (entry.kind === "continuation" || entry.kind === "briefing") {
      if (!unanswered) break;
      run += 1;
      unanswered = false;
    }
  }
  return run;
}

/**
 * How many consecutive recent checkpoints show the same fingerprint. The
 * journal is the source, so this survives a reload: the guard cannot be reset
 * by restarting the app.
 *
 * It *is* reset by the user pressing Resume. Pressing it means "I have looked
 * at this, carry on", and the journal is append-only, so without this the
 * guard re-trips on the same evidence the instant the run restarts and Resume
 * does nothing at all — the run can never produce the new checkpoint that
 * would clear it, because the guard stops the turn that would write one.
 */
export function staleCheckpointRun(journal: JournalLike[]): number {
  const fingerprints = answeredCheckpoints(journal);
  if (fingerprints.length < 2) return 0;
  const newest = fingerprints[0] as string;
  let run = 0;
  for (const fingerprint of fingerprints) {
    if (fingerprint !== newest) break;
    run += 1;
  }
  // Two identical checkpoints mean one turn changed nothing.
  return run - 1;
}

/**
 * The guard row written when a tick threw rather than returning an outcome —
 * the command itself failed, not the model.
 *
 * Observed live: a Claude session's row is stored under the adapter's own id,
 * a command looked it up by the attachment handle, and every submit failed
 * with `NOT_READY session record missing`. The thrown error was caught, the
 * run stayed `running`, and the runner retried for ever — a checkpoint every
 * eleven seconds and no turn in between. A fault that does not clear by
 * itself needs a human, and it has to stop to get one.
 */
export const TICK_FAILED = "The tick failed";

/**
 * How many ticks in a row, since the last restart, threw before submitting
 * anything. Stops at the first continuation that actually went out.
 */
export function failedTickRun(journal: JournalLike[]): number {
  let run = 0;
  for (const entry of sinceRestart(journal)) {
    if (entry.kind === "continuation" || entry.kind === "briefing") break;
    if (entry.kind === "guard" && entry.summary.startsWith(TICK_FAILED)) run += 1;
  }
  return run;
}

/** Quota-shaped provider errors. A hint to re-sample usage, never a verdict. */
export function looksLikeQuotaError(message: string | null | undefined): boolean {
  if (!message) return false;
  // "hit your … limit" is Claude Code's own wording for a spent window; the
  // adapter's machine-readable `errorKind: rate_limit` is not always carried
  // into the text a caller sees.
  return /usage limit|rate limit|rate_limit|quota|too many requests|\b429\b|insufficient_quota|limit reached|hit your (?:\w+ )?limit/i.test(message);
}

/**
 * A `blocked` report whose reason is a wait, not a block: a delegate out of
 * quota, a session limit, a window that resets later. The first real run
 * produced five of these in an evening, each one stopping the goal until a
 * human pressed Resume, for a condition that would have cleared by itself.
 */
export function looksLikeQuotaWait(note: string | null | undefined): boolean {
  if (!note) return false;
  return /quota|session limit|usage (?:limit|window)|rate.?limit|reset at|until (?:the )?(?:reset|window)|delegates? (?:are|is|remain) (?:out|exhausted|quota)|worker quota/i.test(note);
}

/** Summary prefix of the guard row written for such a report. */
export const QUOTA_WAIT_HOLD = "The agent is waiting on a quota";

/** How long the runner holds off after a quota-wait report when the note names no time. */
export const QUOTA_WAIT_HOLD_MS = 30 * 60_000;

/** The longest a note's named time may push the hold. */
export const QUOTA_WAIT_HOLD_MAX_MS = 6 * 60 * 60_000;

/**
 * When to try again after a quota-wait report: the clock time the note names
 * ("reset at 00:40"), today or tomorrow, else half an hour from now. Bounded,
 * because a note can name any time and a run should not sleep a day on it.
 */
export function quotaWaitUntil(note: string, now: number): number {
  const match = /(\d{1,2}):(\d{2})/.exec(note);
  if (match) {
    const hours = Number.parseInt(match[1] ?? "", 10);
    const minutes = Number.parseInt(match[2] ?? "", 10);
    if (hours < 24 && minutes < 60) {
      const at = new Date(now);
      at.setHours(hours, minutes, 0, 0);
      let until = at.getTime();
      if (until <= now) until += 24 * 60 * 60_000;
      return Math.min(until, now + QUOTA_WAIT_HOLD_MAX_MS);
    }
  }
  return now + QUOTA_WAIT_HOLD_MS;
}

/**
 * The time the newest quota hold runs to, if one was written after the last
 * prompt. Journal-derived like the cooldown, so it survives a reload; a hold
 * older than the newest continuation has done its job.
 */
export function heldUntil(journal: { kind: string; summary: string; detail?: string | undefined }[]): number | null {
  for (const entry of journal) {
    if (entry.kind === "continuation" || entry.kind === "briefing" || isRunRestart(entry)) return null;
    if (entry.kind === "guard" && entry.summary.startsWith(QUOTA_WAIT_HOLD)) {
      const match = /until=(\d+)/.exec(entry.detail ?? "");
      return match ? Number.parseInt(match[1] ?? "", 10) : null;
    }
  }
  return null;
}
