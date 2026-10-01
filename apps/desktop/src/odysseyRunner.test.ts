import { describe, expect, it } from "vitest";
import type { MilestoneRecord, OdysseyJournalEntry, OdysseyRecord, UsageSnapshot } from "@thingmaker/contracts";
import {
  PROMPT_UNANSWERED,
  RUN_STARTED,
  TICK_FAILED,
  TRANSPORT_CLOSED,
  checkpointDetail,
  checkpointFingerprint,
  checkpointPaths,
  briefedThisSession,
  failedTickRun,
  handedOver,
  heldUntil,
  isRunRestart,
  looksLikeQuotaWait,
  QUOTA_WAIT_HOLD,
  QUOTA_WAIT_HOLD_MS,
  quotaWaitUntil,
  looksLikeQuotaError,
  looksLikeTransportError,
  parseReport,
  progressFingerprint,
  resumedFrom,
  staleCheckpointRun,
  unansweredRun,
} from "./odysseyReport";
import { FAILOVER_COOLDOWN_MS, failoverDecision, RESUME_JITTER_MS, PARKED_RESAMPLE_MS, PROMPT_COOLDOWN_MS, STALE_ACTIVITY_MS, STALE_TURN_LIMIT, staleActivity, STALL_WARNING_MS, USAGE_RESAMPLE_MS, deadTurn, exhaustedCeiling, hasRunnableCheck, shouldResample, waitingUntil, activeMilestone, continuationsLeft, countdown, decide, resumeDecision, lastPromptAt, stallDuration, stallNotice, stopsAfterMilestone, usageVerdict, UNANSWERED_LIMIT } from "./odysseyRunner";

const goal: OdysseyRecord = {
  id: "o1",
  workspaceId: "w1",
  sessionId: "kw-1",
  title: "Ship onboarding v2",
  brief: "",
  state: "running",
  stopCondition: "goal_complete",
  onUsageReset: "notify_only",
  onReport: "continue",
  onPlanChange: "review",
  orchestrator: "codex",
  deadTurnMinutes: 30,
  maxContinuations: 50,
  continuationsUsed: 3,
  tokensUsed: 1_000,
  createdAt: 0,
  updatedAt: 0,
};

function milestone(overrides: Partial<MilestoneRecord> & { id: string }): MilestoneRecord {
  return { odysseyId: "o1", position: 0, title: overrides.id, detail: "", state: "planned", checkKind: "manual", steps: [], ...overrides };
}

const briefed: OdysseyJournalEntry[] = [{ id: "j0", odysseyId: "o1", at: 1, kind: "briefing", summary: "briefed" }];
const ready = { attached: true, idle: true };
const window = (usedPercent: number, resetAtUnix?: number) => ({ usedPercent, windowSeconds: 18_000, ...(resetAtUnix ? { resetAtUnix } : {}) });
const usage = (overrides: Partial<UsageSnapshot>): UsageSnapshot => ({ fetchedAtUnixMs: 0, allowed: true, limitReached: false, ...overrides });

describe("the report line", () => {
  it("reads a well-formed report", () => {
    expect(parseReport("Done.\nODYSSEY-REPORT: milestone=3 status=complete note=screens built")).toEqual({
      milestone: 3,
      status: "complete",
      note: "screens built",
    });
  });

  it("takes the last report when a reply restates it", () => {
    const text = "SUPERTHING-REPORT: milestone=1 status=blocked note=first\ntext\nODYSSEY-REPORT: milestone=2 status=complete note=second";
    expect(parseReport(text)).toMatchObject({ milestone: 2, status: "complete", note: "second" });
  });

  it("tolerates spacing, case and a missing note", () => {
    expect(parseReport("odyssey-report:  milestone = 2   status = BLOCKED")).toEqual({ milestone: 2, status: "blocked", note: "" });
  });

  it("returns null for anything it cannot read, rather than guessing", () => {
    expect(parseReport("I finished the milestone!")).toBeNull();
    expect(parseReport("SUPERTHING-REPORT: status=complete")).toBeNull();
    expect(parseReport("SUPERTHING-REPORT: milestone=0 status=complete")).toBeNull();
    expect(parseReport("SUPERTHING-REPORT: milestone=2 status=nearly")).toBeNull();
    expect(parseReport("")).toBeNull();
  });
});

describe("the no-progress guard", () => {
  const checkpoint = (detail: string, at: number): OdysseyJournalEntry => ({ id: `j${at}`, odysseyId: "o1", at, kind: "checkpoint", summary: "checkpoint", detail });

  it("counts consecutive identical checkpoints as turns that changed nothing", () => {
    // Newest first, as the journal is stored.
    expect(staleCheckpointRun([checkpoint("a", 3), checkpoint("a", 2), checkpoint("a", 1)])).toBe(2);
    expect(staleCheckpointRun([checkpoint("b", 3), checkpoint("a", 2), checkpoint("a", 1)])).toBe(0);
    expect(staleCheckpointRun([checkpoint("a", 1)])).toBe(0);
    expect(staleCheckpointRun([])).toBe(0);
  });

  it("forgets everything before the run was restarted, so Resume actually resumes", () => {
    // The journal is append-only. Without this the guard re-trips on the same
    // evidence the instant the run restarts, and Resume is a button that does
    // nothing: the turn that would write a different checkpoint never runs.
    const restart: OdysseyJournalEntry = { id: "r", odysseyId: "o1", at: 4, kind: "state", summary: resumedFrom("blocked") };
    expect(staleCheckpointRun([restart, checkpoint("a", 3), checkpoint("a", 2), checkpoint("a", 1)])).toBe(0);
    // One new stale checkpoint after the restart is still only one turn.
    expect(staleCheckpointRun([checkpoint("a", 5), restart, checkpoint("a", 3), checkpoint("a", 2)])).toBe(0);
    // And it trips again on its own evidence.
    expect(staleCheckpointRun([checkpoint("a", 7), checkpoint("a", 6), checkpoint("a", 5), restart, checkpoint("a", 1)])).toBe(2);
  });

  it("recognises every way a run gets picked back up", () => {
    expect(isRunRestart({ kind: "state", summary: RUN_STARTED })).toBe(true);
    expect(isRunRestart({ kind: "state", summary: resumedFrom("paused") })).toBe(true);
    expect(isRunRestart({ kind: "resume", summary: "usage reset and this goal continues automatically" })).toBe(true);
    // Not a restart: an ordinary state row, or the guard's own row.
    expect(isRunRestart({ kind: "state", summary: "Paused by you" })).toBe(false);
    expect(isRunRestart({ kind: "guard", summary: "3 turns in a row changed nothing" })).toBe(false);
  });

  it("fingerprints disk and plan state together", () => {
    const base = { treeHash: "3f2a", milestoneStates: ["verified", "active"], stepStates: ["done"] };
    expect(progressFingerprint(base)).toBe(progressFingerprint({ ...base }));
    // The tree hash covers every path and content hash, so any edit anywhere
    // in the tree changes it — there is no count to saturate.
    expect(progressFingerprint(base)).not.toBe(progressFingerprint({ ...base, treeHash: "3f2b" }));
    // A turn that wrote nothing but moved a step still counts as progress.
    expect(progressFingerprint(base)).not.toBe(progressFingerprint({ ...base, stepStates: ["in_progress"] }));
  });

  it("keeps the changed paths behind the fingerprint, and reads either half back", () => {
    const detail = checkpointDetail("3f2a|active|", ["Assets/a.cs", "Docs/b.md"]);
    expect(checkpointFingerprint(detail)).toBe("3f2a|active|");
    expect(checkpointPaths(detail)).toEqual(["Assets/a.cs", "Docs/b.md"]);
    // Rows written before paths were kept are a fingerprint and nothing else.
    expect(checkpointFingerprint("2000|671|109698|active")).toBe("2000|671|109698|active");
    expect(checkpointPaths("2000|671|109698|active")).toEqual([]);
    expect(checkpointPaths(undefined)).toEqual([]);
  });

  const guardRow = (summary: string, at: number): OdysseyJournalEntry => ({ id: `g${at}`, odysseyId: "o1", at, kind: "guard", summary });
  const continuation = (at: number): OdysseyJournalEntry => ({ id: `k${at}`, odysseyId: "o1", at, kind: "continuation", summary: "Continued milestone 2 of 3" });

  it("does not count the checkpoint of a prompt no model answered as a stale turn", () => {
    // Newest first: two unanswered prompts, then an answered one that changed
    // nothing, then one that did. Only the answered turns are evidence.
    const journal = [
      guardRow(PROMPT_UNANSWERED, 10),
      continuation(9),
      checkpoint("a", 8),
      guardRow(PROMPT_UNANSWERED, 7),
      continuation(6),
      checkpoint("a", 5),
      continuation(4),
      checkpoint("a", 3),
      continuation(2),
      checkpoint("b", 1),
    ];
    expect(staleCheckpointRun(journal)).toBe(0);
    // The same rows without the unanswered guards read as three stale turns.
    expect(staleCheckpointRun(journal.filter((entry) => entry.kind !== "guard"))).toBe(2);
  });

  it("counts prompts in a row that were accepted and never answered", () => {
    expect(unansweredRun([guardRow(PROMPT_UNANSWERED, 6), continuation(5), checkpoint("a", 4), guardRow(PROMPT_UNANSWERED, 3), continuation(2), checkpoint("a", 1)])).toBe(2);
    // An answered continuation ends the run, whatever came before it.
    expect(unansweredRun([guardRow(PROMPT_UNANSWERED, 6), continuation(5), continuation(4), guardRow(PROMPT_UNANSWERED, 3), continuation(2)])).toBe(1);
    // A restart clears it, like every other guard.
    const restart: OdysseyJournalEntry = { id: "r", odysseyId: "o1", at: 4, kind: "state", summary: resumedFrom("blocked") };
    expect(unansweredRun([guardRow(PROMPT_UNANSWERED, 6), continuation(5), restart, guardRow(PROMPT_UNANSWERED, 3), continuation(2)])).toBe(1);
    expect(unansweredRun([])).toBe(0);
  });

  it("treats a transport that closed under the run as a restart", () => {
    expect(isRunRestart(guardRow(`${TRANSPORT_CLOSED}: Incoming transport closed`, 1))).toBe(true);
    expect(isRunRestart(guardRow(PROMPT_UNANSWERED, 1))).toBe(false);
    expect(looksLikeTransportError('Incoming transport closed: {"reason":"incoming_transport_closed"}')).toBe(true);
    expect(looksLikeTransportError("Kit rejected the request: Internal error: unsupported operation")).toBe(true);
    expect(looksLikeTransportError("compile error in src/main.rs")).toBe(false);
    expect(looksLikeTransportError(undefined)).toBe(false);
  });
});

describe("the usage verdict", () => {
  it("treats an unsampled account as fine rather than as exhausted", () => {
    expect(usageVerdict(null)).toEqual({ kind: "ok" });
    expect(usageVerdict(undefined)).toEqual({ kind: "ok" });
  });

  it("is fine while both windows have room", () => {
    expect(usageVerdict(usage({ primary: window(71), secondary: window(30) }))).toEqual({ kind: "ok" });
  });

  it("parks when a window reaches the floor, and names it", () => {
    const verdict = usageVerdict(usage({ primary: window(99, 1_700_000_000), secondary: window(40) }));
    expect(verdict.kind).toBe("exhausted");
    if (verdict.kind !== "exhausted") return;
    expect(verdict.reason).toContain("5-hour window is at 99%");
    expect(verdict.resumeAt).toBe(1_700_000_000_000);
  });

  it("waits for the later window when both are spent", () => {
    const verdict = usageVerdict(usage({ primary: window(100, 1_000), secondary: window(100, 9_000) }));
    if (verdict.kind !== "exhausted") throw new Error("expected exhausted");
    expect(verdict.resumeAt).toBe(9_000_000);
  });

  it("stops on a reported limit even with no window over the floor, and admits it has no reset time", () => {
    const verdict = usageVerdict(usage({ limitReached: true, primary: window(12), secondary: window(3) }));
    if (verdict.kind !== "exhausted") throw new Error("expected exhausted");
    expect(verdict.resumeAt).toBeNull();
    expect(verdict.reason).toContain("the provider reported");
  });
});

describe("what the runner decides", () => {
  const plan = [milestone({ id: "m1", state: "verified", position: 0 }), milestone({ id: "m2", state: "active", position: 1 })];

  it("does nothing unless the goal is running", () => {
    for (const state of ["draft", "paused", "blocked", "complete", "abandoned"] as const) {
      expect(decide({ goal: { ...goal, state }, milestones: plan, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "idle" });
    }
  });

  it("waits for the session rather than queueing prompts", () => {
    expect(decide({ goal, milestones: plan, journal: briefed, session: { attached: false, idle: true }, usage: null })).toMatchObject({ action: "idle", reason: "the session is not attached" });
    expect(decide({ goal, milestones: plan, journal: briefed, session: { attached: true, idle: false }, usage: null })).toMatchObject({ action: "idle", reason: "a turn is already running" });
  });

  it("parks on a spent quota even while a turn is still running", () => {
    // The bug this guards: the session checks came first, so a spent window
    // hid behind "a turn is already running" for as long as that turn took —
    // and a turn with no quota behind it runs a very long time. The goal never
    // reached waiting_usage, so it never learned a reset time and could never
    // come back on its own.
    const spent = usage({ primary: window(100, 1_700_000_000), secondary: window(40) });
    expect(decide({ goal, milestones: plan, journal: briefed, session: { attached: true, idle: false }, usage: spent })).toMatchObject({
      action: "wait_usage",
      resumeAt: 1_700_000_000_000,
    });
    // Detached is the same: a known recovery time beats "not right now".
    expect(decide({ goal, milestones: plan, journal: briefed, session: { attached: false, idle: true }, usage: spent })).toMatchObject({ action: "wait_usage" });
  });

  it("still reports the session plainly when there is quota to spend", () => {
    const fine = usage({ primary: window(12), secondary: window(40) });
    expect(decide({ goal, milestones: plan, journal: briefed, session: { attached: true, idle: false }, usage: fine })).toMatchObject({
      action: "idle",
      reason: "a turn is already running",
    });
  });

  it("briefs before it continues, and only once", () => {
    expect(decide({ goal, milestones: plan, journal: [], session: ready, usage: null })).toEqual({ action: "brief" });
    expect(decide({ goal, milestones: plan, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "continue", index: 1 });
  });

  it("blocks a goal with no milestones instead of prompting into the void", () => {
    expect(decide({ goal, milestones: [], journal: briefed, session: ready, usage: null })).toMatchObject({ action: "block", reason: "the goal has no milestones" });
  });

  it("stops at the continuation ceiling and at the token budget", () => {
    expect(decide({ goal: { ...goal, continuationsUsed: 50 }, milestones: plan, journal: briefed, session: ready, usage: null })).toMatchObject({
      action: "block",
      reason: "the continuation limit of 50 is used up",
    });
    expect(decide({ goal: { ...goal, tokenBudget: 1_000, tokensUsed: 1_000 }, milestones: plan, journal: briefed, session: ready, usage: null })).toMatchObject({
      action: "block",
      reason: "the token budget of 1,000 is used up",
    });
  });

  it("reports the budget before the usage window, so the reason is the real one", () => {
    const spent = usage({ primary: window(100, 1_000) });
    expect(decide({ goal: { ...goal, continuationsUsed: 50 }, milestones: plan, journal: briefed, session: ready, usage: spent })).toMatchObject({ action: "block" });
  });

  it("parks on usage with the provider's reset time", () => {
    const decision = decide({ goal, milestones: plan, journal: briefed, session: ready, usage: usage({ primary: window(100, 1_700_000_000) }) });
    expect(decision).toMatchObject({ action: "wait_usage", resumeAt: 1_700_000_000_000 });
  });

  it("blocks a run that keeps changing nothing", () => {
    const stale: OdysseyJournalEntry[] = [
      ...Array.from({ length: STALE_TURN_LIMIT + 1 }, (_, index) => ({ id: `c${index}`, odysseyId: "o1", at: 100 - index, kind: "checkpoint" as const, summary: "checkpoint", detail: "same" })),
      ...briefed,
    ];
    expect(decide({ goal, milestones: plan, journal: stale, session: ready, usage: null })).toMatchObject({ action: "block", reason: expect.stringContaining("changed nothing") });
  });

  it("blocks a run whose prompts are accepted and never answered", () => {
    const rows: OdysseyJournalEntry[] = [];
    for (let index = 0; index < UNANSWERED_LIMIT; index += 1) {
      rows.push({ id: `g${index}`, odysseyId: "o1", at: 100 - index * 2, kind: "guard", summary: PROMPT_UNANSWERED });
      rows.push({ id: `k${index}`, odysseyId: "o1", at: 99 - index * 2, kind: "continuation", summary: "Continued milestone 2 of 2" });
    }
    const decision = decide({ goal, milestones: plan, journal: [...rows, ...briefed], session: ready, usage: null });
    expect(decision).toMatchObject({ action: "block", reason: expect.stringContaining("never answered") });
  });

  it("completes when every milestone is verified or skipped", () => {
    const done = [milestone({ id: "m1", state: "verified" }), milestone({ id: "m2", state: "skipped", position: 1 })];
    expect(decide({ goal, milestones: done, journal: briefed, session: ready, usage: null })).toEqual({ action: "complete" });
  });

  it("stops at a claimed milestone instead of re-prompting it for ever, when told to wait", () => {
    const claimed = [milestone({ id: "m1", state: "verified" }), milestone({ id: "m2", state: "reported", position: 1 })];
    expect(decide({ goal: { ...goal, onReport: "wait" }, milestones: claimed, journal: briefed, session: ready, usage: null })).toMatchObject({
      action: "await_verification",
      index: 1,
    });
  });

  it("carries on past a claim nobody but a human could check, by default", () => {
    // A plan whose checks are all `manual` would otherwise stop twelve times.
    // Carrying on never means verified: the milestone stays `reported`.
    const claimed = [
      milestone({ id: "m1", state: "verified" }),
      milestone({ id: "m2", state: "reported", position: 1 }),
      milestone({ id: "m3", state: "planned", position: 2 }),
    ];
    expect(decide({ goal, milestones: claimed, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "continue", index: 2 });
  });

  it("still stops for a claim it can check itself, whatever the setting", () => {
    // Running the check is cheap and decisive, so it is never skipped.
    const checkable = [milestone({ id: "m1", state: "reported", checkKind: "tests_pass", checkSpec: "pnpm test" }), milestone({ id: "m2", state: "planned", position: 1 })];
    expect(decide({ goal, milestones: checkable, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "await_verification", index: 0 });
  });

  it("is complete when the only thing left is an unverified claim it cannot check", () => {
    const claimed = [milestone({ id: "m1", state: "verified" }), milestone({ id: "m2", state: "reported", position: 1 })];
    expect(decide({ goal, milestones: claimed, journal: briefed, session: ready, usage: null })).toEqual({ action: "complete" });
    // Under `wait` the same plan is not finished: it is waiting for a tick.
    expect(decide({ goal: { ...goal, onReport: "wait" }, milestones: claimed, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "await_verification" });
  });

  it("knows which milestones it could settle without asking", () => {
    expect(hasRunnableCheck({ checkKind: "tests_pass", checkSpec: "pnpm test" })).toBe(true);
    expect(hasRunnableCheck({ checkKind: "manual", checkSpec: "pnpm test" })).toBe(false);
    expect(hasRunnableCheck({ checkKind: "command" })).toBe(false);
    expect(hasRunnableCheck({ checkKind: "command", checkSpec: "  " })).toBe(false);
  });

  it("re-prompts a milestone whose check failed, because that is work to redo", () => {
    const withFailure = [milestone({ id: "m1", state: "verified" }), milestone({ id: "m2", state: "failed", position: 1 }), milestone({ id: "m3", state: "planned", position: 2 })];
    expect(activeMilestone(withFailure)?.index).toBe(1);
    expect(decide({ goal, milestones: withFailure, journal: briefed, session: ready, usage: null })).toMatchObject({ action: "continue", index: 1 });
  });
});

describe("resuming from a usage wait", () => {
  const waiting: OdysseyRecord = { ...goal, state: "waiting_usage", onUsageReset: "continue_automatically" };
  const roomy = usage({ primary: window(10) });

  it("resumes as soon as the sample shows room, whatever the recorded clock says", () => {
    // These windows roll: capacity comes back as old usage ages out, well
    // before the `reset_at` the provider names. Gating the resume on that
    // clock left a goal parked in front of a full window for hours, and each
    // re-sample pushed the clock further out.
    expect(resumeDecision({ goal: waiting, usage: roomy, resumeAt: 9_999_999, now: 1 })).toMatchObject({ action: "resume" });
    expect(resumeDecision({ goal: waiting, usage: roomy, resumeAt: null, now: 1 })).toMatchObject({ action: "resume" });
  });

  it("does not resume on the clock alone when usage still says no", () => {
    const still = usage({ primary: window(100, 1) });
    expect(resumeDecision({ goal: waiting, usage: still, resumeAt: 1_000_000, now: 2_000_000 })).toMatchObject({
      action: "hold",
      reason: "the reset time passed but usage still reports no room",
    });
  });

  it("holds when usage says there is no room and no reset time to wait for", () => {
    const blind = usage({ limitReached: true });
    expect(resumeDecision({ goal: waiting, usage: blind, resumeAt: null, now: 9_999_999 })).toMatchObject({ action: "hold", reason: expect.stringContaining("no reset time") });
  });

  it("comes back from a reload, where the recorded reset time is gone", () => {
    // `resumeAt` lives in memory only. A parked goal used to be stranded for
    // ever after a reload because the runner had nothing left to wait for; the
    // sample is enough on its own.
    expect(resumeDecision({ goal: waiting, usage: roomy, resumeAt: null, now: 9_999_999 })).toMatchObject({ action: "resume" });
    // And a still-spent window after a reload waits for the time the sample
    // itself names, not the one the runner forgot.
    const still = usage({ primary: window(100, 2_000) });
    expect(resumeDecision({ goal: waiting, usage: still, resumeAt: null, now: 1_000_000 })).toMatchObject({ action: "hold", reason: "the reset time has not passed" });
    expect(resumeDecision({ goal: waiting, usage: still, resumeAt: null, now: 3_000_000 })).toMatchObject({
      action: "hold",
      reason: "the reset time passed but usage still reports no room",
    });
  });

  it("waits rather than guessing when usage has never been sampled", () => {
    expect(resumeDecision({ goal: waiting, usage: null, resumeAt: null, now: 9_999_999 })).toMatchObject({ action: "hold", reason: "usage has not been sampled yet" });
  });

  it("honours the mode: notify, stay paused, or continue", () => {
    const at = { resumeAt: 1_000_000, now: 2_000_000, usage: roomy };
    expect(resumeDecision({ goal: { ...waiting, onUsageReset: "notify_only" }, ...at })).toMatchObject({ action: "notify" });
    expect(resumeDecision({ goal: { ...waiting, onUsageReset: "stop" }, ...at })).toMatchObject({ action: "stay_paused" });
    expect(resumeDecision({ goal: waiting, ...at })).toMatchObject({ action: "resume" });
  });

  it("ignores a goal that is not waiting", () => {
    expect(resumeDecision({ goal, usage: roomy, resumeAt: 1, now: 2 })).toMatchObject({ action: "hold", reason: "the goal is running" });
  });
});

describe("small helpers", () => {
  it("knows which stop conditions pause after a milestone", () => {
    expect(stopsAfterMilestone(goal)).toBe(false);
    expect(stopsAfterMilestone({ ...goal, stopCondition: "milestone_complete" })).toBe(true);
    expect(stopsAfterMilestone({ ...goal, stopCondition: "manual" })).toBe(true);
  });

  it("counts continuations left without going negative", () => {
    expect(continuationsLeft(goal)).toBe(47);
    expect(continuationsLeft({ ...goal, continuationsUsed: 99 })).toBe(0);
  });

  it("drops seconds from a long countdown and keeps them from a short one", () => {
    expect(countdown(2 * 3_600_000 + 13 * 60_000 + 8_000)).toBe("2:13:08");
    expect(countdown(75_000)).toBe("1:15");
    expect(countdown(9_000)).toBe("0:09");
    expect(countdown(-5)).toBe("0:00");
  });

  it("recognises quota-shaped errors as a hint, not a verdict", () => {
    expect(looksLikeQuotaError("429 Too Many Requests")).toBe(true);
    expect(looksLikeQuotaError("You have reached your usage limit")).toBe(true);
    expect(looksLikeQuotaError("insufficient_quota")).toBe(true);
    expect(looksLikeQuotaError("compile error in src/main.rs")).toBe(false);
    expect(looksLikeQuotaError(null)).toBe(false);
  });
});

/**
 * A run that cannot act says so (docs/plans/odyssey-observability.md §4).
 * Silence is the failure mode this guards: the runner sat on "a turn is
 * already running" for an hour and nothing on screen said a word.
 */
describe("reporting a stalled run", () => {
  const now = 1_700_000_000_000;

  it("says nothing while the wait is still ordinary", () => {
    expect(stallNotice({ reason: "a turn is already running", since: now - 60_000, now })).toBeNull();
    expect(stallNotice({ reason: "a turn is already running", since: now - (STALL_WARNING_MS - 1), now })).toBeNull();
  });

  it("names the reason and how long it has held once the wait is not ordinary", () => {
    const notice = stallNotice({ reason: "a turn is already running", since: now - STALL_WARNING_MS, now });
    expect(notice).toBe("Super Thing has not been able to act for 5m: a turn is already running");
  });

  it("never trips on a run whose reason keeps changing, because that run is moving", () => {
    // `since` is reset by the caller whenever the reason changes, so a moving
    // run always looks recent.
    expect(stallNotice({ reason: "the session is not attached", since: now, now })).toBeNull();
  });

  it("says nothing when there is no reason, or nothing has been waiting", () => {
    expect(stallNotice({ reason: "", since: now - 10 * STALL_WARNING_MS, now })).toBeNull();
    expect(stallNotice({ reason: "a turn is already running", since: null, now })).toBeNull();
  });

  it("reads a long wait the way a person would say it", () => {
    expect(stallDuration(5 * 60_000)).toBe("5m");
    expect(stallDuration(59 * 60_000)).toBe("59m");
    expect(stallDuration(60 * 60_000)).toBe("1h");
    expect(stallDuration(83 * 60_000)).toBe("1h 23m");
    expect(stallDuration(-1)).toBe("0m");
  });
});

/**
 * Re-sampling while parked. The trap: the decision to resume was made from the
 * snapshot the goal was parked with, which says "no room" for ever — so it
 * held, so it never refreshed, so it never learned the window was back. A goal
 * parked at 16:07 was still parked at 18:58, an hour past its own reset.
 */
describe("when a parked goal checks the account again", () => {
  const now = 1_700_000_000_000;
  const parked = (usedPercent: number, resetAtUnix: number, fetchedAtUnixMs: number) =>
    usage({ fetchedAtUnixMs, primary: window(usedPercent, resetAtUnix), secondary: window(20) });

  it("checks periodically even before the named reset, because the window may free up early", () => {
    const reset = Math.floor((now + 2 * 3_600_000) / 1000);
    // Just sampled: leave it alone.
    expect(shouldResample({ usage: parked(100, reset, now - 90_000), resumeAt: null, now })).toBe(false);
    // Ten minutes later, look again — the window rolls, the clock does not.
    expect(shouldResample({ usage: parked(100, reset, now - 10 * 60_000), resumeAt: null, now })).toBe(true);
  });

  it("samples once the reset time has passed, however stale the snapshot says no", () => {
    const reset = Math.floor((now - 60_000) / 1000);
    expect(shouldResample({ usage: parked(100, reset, now - 3 * 3_600_000), resumeAt: null, now })).toBe(true);
  });

  it("never samples faster than once a minute, parked or not", () => {
    const reset = Math.floor((now + 2 * 3_600_000) / 1000);
    expect(shouldResample({ usage: parked(100, reset, now - 30_000), resumeAt: null, now })).toBe(false);
    expect(PARKED_RESAMPLE_MS).toBeGreaterThan(USAGE_RESAMPLE_MS);
  });

  it("does not sample more than once a minute", () => {
    const reset = Math.floor((now - 60_000) / 1000);
    expect(shouldResample({ usage: parked(100, reset, now - 10_000), resumeAt: null, now })).toBe(false);
    expect(shouldResample({ usage: parked(100, reset, now - USAGE_RESAMPLE_MS - 1), resumeAt: null, now })).toBe(true);
  });

  it("samples when nothing knows a reset time, rather than waiting for ever", () => {
    expect(shouldResample({ usage: usage({ limitReached: true, fetchedAtUnixMs: now - 5 * 60_000 }), resumeAt: null, now })).toBe(true);
  });

  it("samples when there is no snapshot at all", () => {
    expect(shouldResample({ usage: null, resumeAt: null, now })).toBe(true);
  });

  it("prefers the time the sample names over the one the runner remembered", () => {
    const reset = Math.floor((now + 3_600_000) / 1000);
    expect(waitingUntil(parked(100, reset, now), 1)).toBe(reset * 1000);
    // With room in the window there is nothing to wait for at all. Reporting
    // the stale recorded time here is what put a live countdown on a goal the
    // runner had already stopped waiting on.
    expect(waitingUntil(usage({ primary: window(10) }), 5_000)).toBeNull();
    expect(waitingUntil(null, null)).toBeNull();
  });
});

/**
 * Telling a dead turn from a slow one. Six subagents once sat on open sockets
 * for eighty minutes after a quota wall; the parent turn could not settle, so
 * the runner refused to act the whole time and nothing would ever have freed
 * it. But a silent tool call is a legitimate thing, so the test is "no events
 * at all", generously timed.
 */
describe("deciding a turn has died", () => {
  const now = 1_700_000_000_000;

  it("says nothing while events are still arriving", () => {
    expect(deadTurn({ running: true, lastEventAt: now - 60_000, now, minutes: 30 })).toBeNull();
    expect(deadTurn({ running: true, lastEventAt: now - 29 * 60_000, now, minutes: 30 })).toBeNull();
  });

  it("reports the silence once it is past the limit", () => {
    expect(deadTurn({ running: true, lastEventAt: now - 80 * 60_000, now, minutes: 30 })).toEqual({ silentMs: 80 * 60_000, workingAgents: 0 });
  });

  it("names how many subagents the cancel takes with it", () => {
    // Subagent events move `lastEventAt` too, so a working subagent that is
    // still talking keeps the turn alive; one that has gone silent dies with
    // it, and the record says so.
    expect(deadTurn({ running: true, lastEventAt: now - 80 * 60_000, now, minutes: 30, workingAgents: 4 })).toEqual({ silentMs: 80 * 60_000, workingAgents: 4 });
    expect(deadTurn({ running: true, lastEventAt: now - 60_000, now, minutes: 30, workingAgents: 4 })).toBeNull();
  });

  it("never fires when no turn is running", () => {
    expect(deadTurn({ running: false, lastEventAt: now - 10 * 3_600_000, now, minutes: 30 })).toBeNull();
  });

  it("is switched off by a limit of zero, or a negative one", () => {
    expect(deadTurn({ running: true, lastEventAt: now - 10 * 3_600_000, now, minutes: 0 })).toBeNull();
    expect(deadTurn({ running: true, lastEventAt: now - 10 * 3_600_000, now, minutes: -1 })).toBeNull();
  });

  it("waits for a first event rather than cancelling a turn it has not seen", () => {
    expect(deadTurn({ running: true, lastEventAt: null, now, minutes: 30 })).toBeNull();
  });
});

/**
 * Naming the ceiling a blocked goal ran into. Resume writes "running" and the
 * guard writes "blocked" again on the same tick, so a button offering to
 * resume a goal out of budget is offering nothing — four presses, eight
 * journal rows, no progress.
 */
describe("a goal blocked on a budget", () => {
  it("names the continuation ceiling and what raising it would cost", () => {
    expect(exhaustedCeiling({ ...goal, continuationsUsed: 10, maxContinuations: 10 })).toEqual({ kind: "continuations", used: 10, limit: 10, step: 10 });
  });

  it("names the token ceiling", () => {
    expect(exhaustedCeiling({ ...goal, tokenBudget: 200_000, tokensUsed: 240_000 })).toEqual({ kind: "tokens", used: 240_000, limit: 200_000, step: 200_000 });
  });

  it("says nothing when there is budget left", () => {
    expect(exhaustedCeiling({ ...goal, continuationsUsed: 9, maxContinuations: 10 })).toBeNull();
    expect(exhaustedCeiling({ ...goal, tokenBudget: 200_000, tokensUsed: 1 })).toBeNull();
    // No budget set is not an exhausted budget.
    expect(exhaustedCeiling({ ...goal, tokensUsed: 10_000_000 })).toBeNull();
  });

  it("reports the continuation ceiling first when both are spent", () => {
    expect(exhaustedCeiling({ ...goal, continuationsUsed: 10, maxContinuations: 10, tokenBudget: 1, tokensUsed: 2 })?.kind).toBe("continuations");
  });

  it("never proposes a step of zero, however the ceiling was set", () => {
    expect(exhaustedCeiling({ ...goal, continuationsUsed: 0, maxContinuations: 0 })?.step).toBe(1);
  });
});

/**
 * The cooldown between prompts (docs/plans/odyssey.md §4.1 step 5). Specified
 * from the start and never built: eight continuations went out in eighteen
 * seconds because nothing rate-limited the runner, and the record never
 * advanced because none of those turns settled.
 */
describe("the prompt cooldown", () => {
  const at = 1_700_000_000_000;
  const plan = [milestone({ id: "m1", state: "active" })];
  const prompted = (when: number): OdysseyJournalEntry[] => [
    { id: "c", odysseyId: "o1", at: when, kind: "continuation", summary: "Continued milestone 1 of 1" },
    ...briefed,
  ];

  it("refuses a second prompt inside the cooldown", () => {
    const decision = decide({ goal, milestones: plan, journal: prompted(at - 1_000), session: ready, usage: null, now: at });
    expect(decision).toMatchObject({ action: "idle", reason: "waiting out the cooldown after the last prompt" });
  });

  it("lets the next one through once it has passed", () => {
    expect(decide({ goal, milestones: plan, journal: prompted(at - PROMPT_COOLDOWN_MS), session: ready, usage: null, now: at })).toMatchObject({ action: "continue" });
  });

  it("reads the last prompt from the record, so it holds across a reload and across callers", () => {
    expect(lastPromptAt(prompted(at))).toBe(at);
    // The briefing counts too: the turn after it is still a prompt.
    expect(lastPromptAt(briefed)).toBe(briefed[0]?.at);
    expect(lastPromptAt([])).toBeNull();
  });

  it("does not hold up anything but a prompt", () => {
    // A goal out of budget still reports that, rather than the cooldown.
    expect(decide({ goal: { ...goal, continuationsUsed: 50 }, milestones: plan, journal: prompted(at), session: ready, usage: null, now: at })).toMatchObject({
      action: "block",
    });
  });
});

/**
 * Believing what a session says is running. A subagent whose process is killed
 * or dies with its provider never reports that it stopped, so the node sits at
 * "working" — "Working in the background · 196m · 1 child process" for
 * something that exited three hours earlier.
 */
describe("activity a session has stopped talking about", () => {
  const now = 1_700_000_000_000;

  it("believes a session that is still saying things", () => {
    expect(staleActivity({ lastEventAt: now - 60_000, now })).toBeNull();
    expect(staleActivity({ lastEventAt: now - (STALE_ACTIVITY_MS - 1), now })).toBeNull();
  });

  it("reports how long the silence has run once it is long enough to matter", () => {
    expect(staleActivity({ lastEventAt: now - 196 * 60_000, now })).toEqual({ silentMs: 196 * 60_000 });
  });

  it("says nothing about a session that has never reported anything", () => {
    // No events yet is not the same as gone quiet.
    expect(staleActivity({ lastEventAt: null, now })).toBeNull();
  });

  it("is more impatient than the dead-turn cancel, because it only changes wording", () => {
    expect(STALE_ACTIVITY_MS).toBeLessThan(30 * 60_000);
  });
});

describe("a blocked report that is really a wait", () => {
  const now = new Date(2026, 8, 14, 21, 30).getTime();
  const plan = [milestone({ id: "m1", state: "verified", position: 0 }), milestone({ id: "m2", state: "active", position: 1 })];

  it("recognises quota and reset language, and nothing else", () => {
    expect(looksLikeQuotaWait("Awaiting the user-selected delegate quota reset at 00:40 Europe/Madrid")).toBe(true);
    expect(looksLikeQuotaWait("Both configured delegates hit the external session limit")).toBe(true);
    expect(looksLikeQuotaWait("configured worker quota is exhausted")).toBe(true);
    expect(looksLikeQuotaWait("the staging credentials are missing")).toBe(false);
    expect(looksLikeQuotaWait("the check cannot pass as written: two requirements contradict")).toBe(false);
    expect(looksLikeQuotaWait(undefined)).toBe(false);
  });

  it("holds until the time the note names, tomorrow if it has passed, else half an hour", () => {
    expect(quotaWaitUntil("delegate quota reset at 00:40 Europe/Madrid", now)).toBe(new Date(2026, 8, 15, 0, 40).getTime());
    expect(quotaWaitUntil("window resets at 22:15", now)).toBe(new Date(2026, 8, 14, 22, 15).getTime());
    expect(quotaWaitUntil("worker quota exhausted", now)).toBe(now + QUOTA_WAIT_HOLD_MS);
    // A time far off is bounded: a run does not sleep a day on a note.
    expect(quotaWaitUntil("reset at 21:29", now)).toBeLessThanOrEqual(now + 6 * 60 * 60_000);
  });

  it("idles until the hold passes, then continues, and forgets a hold once a prompt went out after it", () => {
    const until = now + 60 * 60_000;
    const hold: OdysseyJournalEntry = { id: "h", odysseyId: "o1", at: now, kind: "guard", summary: `${QUOTA_WAIT_HOLD}: delegates out`, detail: `until=${until}` };
    const continuation: OdysseyJournalEntry = { id: "k", odysseyId: "o1", at: now - 10 * 60_000, kind: "continuation", summary: "Continued milestone 2 of 2" };
    expect(heldUntil([hold, continuation, ...briefed])).toBe(until);
    expect(heldUntil([{ ...continuation, at: now + 1 }, hold, ...briefed])).toBeNull();
    const holding = decide({ goal, milestones: plan, journal: [hold, continuation, ...briefed], session: ready, usage: null, now: now + 5 * 60_000 });
    expect(holding).toMatchObject({ action: "idle", reason: expect.stringContaining("waiting for its delegates' quota") });
    expect(decide({ goal, milestones: plan, journal: [hold, continuation, ...briefed], session: ready, usage: null, now: until + 1 })).toMatchObject({ action: "continue" });
  });
});

describe("a goal that moves between sessions (docs/plans/odyssey-second-orchestrator.md)", () => {
  const moved = (at: number): OdysseyJournalEntry => ({ id: `m${at}`, odysseyId: "o1", at, kind: "state", summary: "Moved to session s-2 (claude)" });
  const briefing = (at: number): OdysseyJournalEntry => ({ id: `b${at}`, odysseyId: "o1", at, kind: "briefing", summary: "Briefed the session on the goal" });
  const milestones = [milestone({ id: "m1", state: "planned" })];

  it("briefs the session it is pointed at now, not once per goal", () => {
    // The journal is newest first. A briefing above the newest move is this
    // session's; a move above the newest briefing means the session in front
    // of the run has never heard of the goal, and "Continue. Milestone 7/9"
    // would mean nothing to it.
    expect(briefedThisSession([briefing(2), moved(1)])).toBe(true);
    expect(briefedThisSession([moved(3), briefing(2)])).toBe(false);
    expect(briefedThisSession([])).toBe(false);

    const afterMove = decide({ goal, milestones, journal: [moved(3), briefing(2)], session: ready, usage: null, now: 100_000 });
    expect(afterMove).toEqual({ action: "brief" });
    const afterBriefing = decide({ goal, milestones, journal: [briefing(4), moved(3), briefing(2)], session: ready, usage: null, now: 100_000 });
    expect(afterBriefing.action).toBe("continue");
  });

  it("tells the new session it inherited a run, and only when it did", () => {
    // A goal moved before it was ever briefed — the user restarting a session
    // before pressing Start — has nothing to inherit, and pointing that model
    // at notes that do not exist teaches it the prompt is unreliable.
    expect(handedOver([moved(3), briefing(2)])).toBe(true);
    expect(handedOver([moved(1)])).toBe(false);
    expect(handedOver([briefing(2), moved(1)])).toBe(false);
  });

  it("starts the no-progress and unanswered guards again after a move", () => {
    // Whatever those guards had counted was about a session that is gone; a
    // fresh orchestrator must not inherit a block it had no part in.
    expect(isRunRestart(moved(1))).toBe(true);
    const journal: OdysseyJournalEntry[] = [
      { id: "c2", odysseyId: "o1", at: 5, kind: "checkpoint", summary: "nothing changed", detail: checkpointDetail("same", []) },
      moved(4),
      { id: "c1", odysseyId: "o1", at: 3, kind: "checkpoint", summary: "nothing changed", detail: checkpointDetail("same", []) },
      { id: "c0", odysseyId: "o1", at: 2, kind: "checkpoint", summary: "nothing changed", detail: checkpointDetail("same", []) },
    ];
    expect(staleCheckpointRun(journal)).toBe(0);
  });
});

describe("failover between the two accounts (docs/plans/odyssey-second-orchestrator.md §2.5)", () => {
  const either: OdysseyRecord = { ...goal, orchestrator: "either" };
  const spent = usage({ primary: window(100, 2_000), allowed: false, limitReached: true });
  const free = usage({ primary: window(12) });
  const parked = { parked: true, idle: true, now: 10_000_000 };

  it("moves to the other account only when this one is spent and the other is not", () => {
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: spent, claude: free }, ...parked })).toEqual({
      to: "claude",
      reason: expect.stringContaining("Codex's account is spent"),
    });
    // And symmetrically back, which is how a run returns to Codex.
    expect(failoverDecision({ goal: either, journal: [], current: "claude", usage: { codex: free, claude: spent }, ...parked })?.to).toBe("codex");

    // Both spent: there is nowhere better to be, so it waits where it is
    // rather than paying for a briefing to wait somewhere else.
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: spent, claude: spent }, ...parked })).toBeNull();
    // Nothing wrong with this account: moving would trade two subscriptions
    // for one for no reason at all.
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: free, claude: free }, ...parked })).toBeNull();
    // An account nobody has sampled is not an exhausted account.
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: null, claude: free }, ...parked })).toBeNull();
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: spent, claude: null }, ...parked })?.to).toBe("claude");
  });

  it("never moves mid-turn, and never from a run that is not parked", () => {
    // A turn owns the working tree until it settles. Two orchestrators
    // editing it at once is the one risk this feature carries.
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: spent, claude: free }, parked: true, idle: false, now: 10_000_000 })).toBeNull();
    expect(failoverDecision({ goal: either, journal: [], current: "codex", usage: { codex: spent, claude: free }, parked: false, idle: true, now: 10_000_000 })).toBeNull();
  });

  it("moves at most once an hour, because a move costs a fresh briefing", () => {
    const recent: OdysseyJournalEntry[] = [{ id: "m1", odysseyId: "o1", at: 10_000_000 - 10 * 60_000, kind: "state", summary: "Moved to session s-2 (claude)" }];
    expect(failoverDecision({ goal: either, journal: recent, current: "codex", usage: { codex: spent, claude: free }, ...parked })).toBeNull();
    const old: OdysseyJournalEntry[] = [{ id: "m1", odysseyId: "o1", at: 10_000_000 - FAILOVER_COOLDOWN_MS - 1, kind: "state", summary: "Moved to session s-2 (claude)" }];
    expect(failoverDecision({ goal: either, journal: old, current: "codex", usage: { codex: spent, claude: free }, ...parked })?.to).toBe("claude");
  });

  it("a pinned goal moves onto its account and never off it for quota", () => {
    // The user said which account this run spends. A spent window is not a
    // reason to overrule that; it is a reason to wait.
    const pinned: OdysseyRecord = { ...goal, orchestrator: "claude" };
    expect(failoverDecision({ goal: pinned, journal: [], current: "codex", usage: {}, parked: false, idle: true, now: 10_000_000 })).toEqual({
      to: "claude",
      reason: expect.stringContaining("set to run on Claude"),
    });
    expect(failoverDecision({ goal: pinned, journal: [], current: "claude", usage: { claude: spent, codex: free }, ...parked })).toBeNull();
  });

  it("does not drag a run back onto its pin the instant it was moved off it", () => {
    // What this is for, observed on the live goal: migration 16 wrote `kit`
    // onto every goal that already existed, so every one of them is pinned.
    // A manual move to Claude was undone one second later by this rule — the
    // runner overruling a human who had just said what they wanted. The store
    // now updates the pin on a manual move, and this is the second belt: one
    // move an hour whatever the reason, so the two can never take turns.
    const justMoved: OdysseyJournalEntry[] = [{ id: "m1", odysseyId: "o1", at: 10_000_000 - 1_000, kind: "state", summary: "Moved to session s-2 (claude)" }];
    const pinned: OdysseyRecord = { ...goal, orchestrator: "codex" };
    expect(failoverDecision({ goal: pinned, journal: justMoved, current: "claude", usage: {}, parked: false, idle: true, now: 10_000_000 })).toBeNull();

    // An hour later it does correct itself, because the pin is still what the
    // record says this goal runs on.
    const older: OdysseyJournalEntry[] = [{ id: "m1", odysseyId: "o1", at: 10_000_000 - FAILOVER_COOLDOWN_MS - 1, kind: "state", summary: "Moved to session s-2 (claude)" }];
    expect(failoverDecision({ goal: pinned, journal: older, current: "claude", usage: {}, parked: false, idle: true, now: 10_000_000 })?.to).toBe("codex");
  });

  it("leaves a goal that is not running alone", () => {
    for (const state of ["paused", "blocked", "complete", "draft"] as const) {
      expect(failoverDecision({ goal: { ...either, state }, journal: [], current: "codex", usage: { codex: spent, claude: free }, ...parked })).toBeNull();
    }
  });
});

describe("a tick that cannot even send a prompt", () => {
  const milestones = [milestone({ id: "m1", state: "active" })];
  const failed = (at: number, id: string): OdysseyJournalEntry => ({ id, odysseyId: "o1", at, kind: "guard", summary: `${TICK_FAILED}: NOT_READY session record missing` });

  it("stops the run instead of retrying a fault that does not clear", () => {
    // Observed live: a Claude session's row was stored under the adapter's
    // own id and a command looked it up by the attachment handle, so every
    // submit threw. The run stayed `running` and retried for ever — a
    // checkpoint every eleven seconds and no turn between them.
    const journal = [failed(5, "g3"), failed(4, "g2"), failed(3, "g1"), ...briefed];
    expect(failedTickRun(journal)).toBe(3);
    expect(decide({ goal, milestones, journal, session: ready, usage: null, now: 100_000 })).toEqual({
      action: "block",
      reason: expect.stringContaining("3 ticks in a row failed"),
    });
  });

  it("carries on while the failures are occasional", () => {
    // One bad tick is a blip. The guard is for a fault that repeats.
    const journal = [failed(5, "g2"), failed(4, "g1"), ...briefed];
    expect(failedTickRun(journal)).toBe(2);
    expect(decide({ goal, milestones, journal, session: ready, usage: null, now: 100_000 }).action).toBe("continue");
  });

  it("forgets them once a prompt actually goes out", () => {
    const journal: OdysseyJournalEntry[] = [
      failed(9, "g4"),
      { id: "c1", odysseyId: "o1", at: 8, kind: "continuation", summary: "Continued milestone 1 of 1" },
      failed(7, "g3"),
      failed(6, "g2"),
      failed(5, "g1"),
      ...briefed,
    ];
    expect(failedTickRun(journal)).toBe(1);
  });
});

describe("counting down a Claude window (docs/plans/odyssey-second-orchestrator.md §2.4)", () => {
  const at3pm = Math.floor(new Date("2026-09-18T15:40:00").getTime() / 1000);
  const spent = usage({ fetchedAtUnixMs: 0, allowed: false, limitReached: true, primary: { usedPercent: 100, windowSeconds: 5 * 3600, resetAtUnix: at3pm } });
  const auto: OdysseyRecord = { ...goal, state: "waiting_usage", onUsageReset: "continue_automatically" };

  it("gives the run a reset time to count down to, from the refusal alone", () => {
    // Nothing on this side reports a percentage; the refusal's own "resets
    // 3:40pm" is the whole signal, and the strip's countdown reads it.
    const verdict = usageVerdict(spent);
    expect(verdict.kind).toBe("exhausted");
    expect(waitingUntil(spent, null)).toBe(at3pm * 1000);
  });

  it("holds until the window comes back, then continues by itself", () => {
    const before = at3pm * 1000 - 60_000;
    expect(resumeDecision({ goal: auto, usage: spent, resumeAt: null, now: before, unsampledMeansRoom: true }).action).toBe("hold");

    // Past the reset the snapshot is dropped, and for this account that is
    // the signal — there is no endpoint to confirm it against.
    const after = at3pm * 1000 + RESUME_JITTER_MS + 1;
    expect(resumeDecision({ goal: auto, usage: null, resumeAt: null, now: after, unsampledMeansRoom: true }).action).toBe("resume");
  });

  it("still refuses to resume the OpenAI account on an absent sample", () => {
    // There the fetch failing is what absence means, and resuming on nothing
    // is how a goal used to burn a window it did not have.
    expect(resumeDecision({ goal: auto, usage: null, resumeAt: null, now: Date.now() }).action).toBe("hold");
  });

  it("honours the goal's own setting, the same as the other account", () => {
    const after = at3pm * 1000 + RESUME_JITTER_MS + 1;
    const notify: OdysseyRecord = { ...auto, onUsageReset: "notify_only" };
    expect(resumeDecision({ goal: notify, usage: null, resumeAt: null, now: after, unsampledMeansRoom: true }).action).toBe("notify");
    const stop: OdysseyRecord = { ...auto, onUsageReset: "stop" };
    expect(resumeDecision({ goal: stop, usage: null, resumeAt: null, now: after, unsampledMeansRoom: true }).action).toBe("stay_paused");
  });
});

describe("reports written before the rename", () => {
  it("are read under either name, so a goal already running keeps working", () => {
    expect(parseReport("Done.\nODYSSEY-REPORT: milestone=2 status=complete note=old")?.milestone).toBe(2);
    expect(parseReport("Done.\nSUPERTHING-REPORT: milestone=3 status=complete note=new")?.milestone).toBe(3);
  });
});
