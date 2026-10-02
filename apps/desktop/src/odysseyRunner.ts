/**
 * What the screen says about a running goal (docs/plans/odyssey.md §4, §6).
 *
 * The runner's decisions — when to brief, continue, park, resume or fail over
 * — are made by the Rust engine. What is left here is pure and read-only: how
 * the account's usage reads, how long a run or a session has been quiet, and
 * the countdown and ceilings the strip shows.
 */
import type { MilestoneRecord, OdysseyRecord, UsageSnapshot } from "@thingmaker/contracts";

/** Percent of a usage window at which Big Thing parks rather than risk a turn. */
export const USAGE_FLOOR_PERCENT = 98;

/**
 * How long the runner may be unable to act before that is reported as a stall.
 *
 * A run is mostly waiting, so a few idle ticks mean nothing. Minutes of the
 * same "I cannot act" reason mean something is wrong — a detached session, an
 * exited process, a claim waiting on a tick, or a bug in the runner itself —
 * and the difference between noticing that in a minute and in an hour is
 * whether anything says so.
 */
export const STALL_WARNING_MS = 5 * 60_000;

/**
 * How long a session may be completely silent before what it reports as
 * running stops being believable.
 *
 * A subagent or child call only leaves the inspector when the runtime says it
 * finished. A process that is killed, crashes, or dies with its provider never
 * sends that, so the node sits at `working` for ever — "Working in the
 * background · 196m · 1 child process" for something that exited three hours
 * ago. The session's own silence is the evidence: if *nothing at all* has
 * arrived, nothing in it is running.
 *
 * This only changes what is displayed. It cancels nothing and decides nothing.
 */
export const STALE_ACTIVITY_MS = 10 * 60_000;

/** How long a session has been silent, once that is long enough to matter. */
export function staleActivity(input: { lastEventAt: number | null; now: number; limit?: number }): { silentMs: number } | null {
  const { lastEventAt, now, limit = STALE_ACTIVITY_MS } = input;
  if (lastEventAt === null) return null;
  const silentMs = now - lastEventAt;
  return silentMs >= limit ? { silentMs } : null;
}

/**
 * When a parked goal is when the reset time it was parked with has passed,
 * from whichever source knows it.
 *
 * The sample's own time wins: the one the runner recorded lives in memory and
 * does not survive a reload.
 */
export function waitingUntil(usage: UsageSnapshot | null | undefined, resumeAt: number | null): number | null {
  const verdict = usageVerdict(usage);
  // Nothing to wait for once there is room: showing a countdown to a reset
  // time the runner is no longer waiting on is how a stuck goal looked busy.
  if (verdict.kind !== "exhausted") return null;
  return verdict.resumeAt ?? resumeAt;
}

/** Plain-English duration for a stall, rounded the way a reader would say it. */
export function stallDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/**
 * The warning for a run that has been unable to act, or `null` while it is
 * still within the grace period. `since` is when this reason first appeared,
 * so a reason that keeps changing never trips it — that is a run doing things,
 * not a run stuck.
 */
export function stallNotice(input: { reason: string; since: number | null; now: number; limit?: number }): string | null {
  const { reason, since, now, limit = STALL_WARNING_MS } = input;
  if (since === null || !reason) return null;
  const waited = now - since;
  if (waited < limit) return null;
  return `Big Thing has not been able to act for ${stallDuration(waited)}: ${reason}`;
}

export type UsageVerdict = { kind: "ok" } | { kind: "exhausted"; resumeAt: number | null; reason: string };

/**
 * Whether the account has room for another turn.
 *
 * An unsampled account is treated as fine: absence of data is not evidence of
 * exhaustion, and blocking on it would strand every goal on a machine that has
 * never fetched usage. When both windows are spent the resume time is the
 * *later* of the two — recovering the 5-hour window does not help if the
 * weekly one is gone.
 */
export function usageVerdict(usage: UsageSnapshot | null | undefined, floor = USAGE_FLOOR_PERCENT): UsageVerdict {
  if (!usage) return { kind: "ok" };
  const windows = [
    { name: "5-hour", window: usage.primary },
    { name: "weekly", window: usage.secondary },
  ].filter((entry): entry is { name: string; window: NonNullable<UsageSnapshot["primary"]> } => !!entry.window);

  const spent = windows.filter((entry) => entry.window.usedPercent >= floor);
  if (spent.length === 0 && !usage.limitReached) return { kind: "ok" };

  // `limitReached` with no window over the floor still means stop; the reset
  // time is then whatever the windows report, and may be nothing.
  const relevant = spent.length > 0 ? spent : windows;
  const resets = relevant.map((entry) => entry.window.resetAtUnix).filter((value): value is number => typeof value === "number");
  const reason =
    spent.length > 0
      ? `the ${spent.map((entry) => entry.name).join(" and ")} window${spent.length > 1 ? "s are" : " is"} at ${spent.map((entry) => `${entry.window.usedPercent}%`).join(" and ")}`
      : "the provider reported the usage limit was reached";
  return { kind: "exhausted", resumeAt: resets.length > 0 ? Math.max(...resets) * 1000 : null, reason };
}

/** Whether Big Thing can settle this milestone itself, without asking anyone. */
export function hasRunnableCheck(milestone: Pick<MilestoneRecord, "checkKind" | "checkSpec">): boolean {
  return milestone.checkKind !== "manual" && !!milestone.checkSpec?.trim();
}

/**
 * The ceiling a blocked goal has run into, if that is why it is blocked.
 *
 * Resume cannot clear a budget — the counters are real and the guard is right
 * — so a goal in this state will re-block on the instant, and the button that
 * offers to resume it is offering something that cannot work. The caller uses
 * this to name the actual remedy instead.
 */
export function exhaustedCeiling(goal: OdysseyRecord): { kind: "continuations" | "tokens"; used: number; limit: number; step: number } | null {
  if (goal.continuationsUsed >= goal.maxContinuations) {
    return { kind: "continuations", used: goal.continuationsUsed, limit: goal.maxContinuations, step: Math.max(1, goal.maxContinuations) };
  }
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { kind: "tokens", used: goal.tokensUsed, limit: goal.tokenBudget, step: Math.max(1, goal.tokenBudget) };
  }
  return null;
}

/** Human phrasing for the countdown, dropping seconds past an hour (§8.4). */
export function countdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `0:${String(seconds).padStart(2, "0")}`;
}
