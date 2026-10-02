import { describe, expect, it } from "vitest";
import type { OdysseyRecord, UsageSnapshot } from "@thingmaker/contracts";
import { checkpointPaths } from "./odysseyReport";
import { STALE_ACTIVITY_MS, staleActivity, STALL_WARNING_MS, exhaustedCeiling, hasRunnableCheck, waitingUntil, countdown, stallDuration, stallNotice, usageVerdict } from "./odysseyRunner";

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

const window = (usedPercent: number, resetAtUnix?: number) => ({ usedPercent, windowSeconds: 18_000, ...(resetAtUnix ? { resetAtUnix } : {}) });
const usage = (overrides: Partial<UsageSnapshot>): UsageSnapshot => ({ fetchedAtUnixMs: 0, allowed: true, limitReached: false, ...overrides });

describe("the paths a checkpoint kept", () => {
  it("reads the changed paths behind the fingerprint", () => {
    expect(checkpointPaths("3f2a|active|\nAssets/a.cs\nDocs/b.md")).toEqual(["Assets/a.cs", "Docs/b.md"]);
    // Rows written before paths were kept are a fingerprint and nothing else.
    expect(checkpointPaths("2000|671|109698|active")).toEqual([]);
    expect(checkpointPaths(undefined)).toEqual([]);
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

describe("what the runner can settle by itself", () => {
  it("knows which milestones it could settle without asking", () => {
    expect(hasRunnableCheck({ checkKind: "tests_pass", checkSpec: "pnpm test" })).toBe(true);
    expect(hasRunnableCheck({ checkKind: "manual", checkSpec: "pnpm test" })).toBe(false);
    expect(hasRunnableCheck({ checkKind: "command" })).toBe(false);
    expect(hasRunnableCheck({ checkKind: "command", checkSpec: "  " })).toBe(false);
  });
});

describe("the countdown", () => {
  it("drops seconds from a long countdown and keeps them from a short one", () => {
    expect(countdown(2 * 3_600_000 + 13 * 60_000 + 8_000)).toBe("2:13:08");
    expect(countdown(75_000)).toBe("1:15");
    expect(countdown(9_000)).toBe("0:09");
    expect(countdown(-5)).toBe("0:00");
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
    expect(notice).toBe("Big Thing has not been able to act for 5m: a turn is already running");
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

describe("how long a parked goal waits", () => {
  const now = 1_700_000_000_000;
  const parked = (usedPercent: number, resetAtUnix: number, fetchedAtUnixMs: number) =>
    usage({ fetchedAtUnixMs, primary: window(usedPercent, resetAtUnix), secondary: window(20) });

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

describe("counting down a Claude window (docs/plans/odyssey-second-orchestrator.md §2.4)", () => {
  const at3pm = Math.floor(new Date("2026-09-18T15:40:00").getTime() / 1000);
  const spent = usage({ fetchedAtUnixMs: 0, allowed: false, limitReached: true, primary: { usedPercent: 100, windowSeconds: 5 * 3600, resetAtUnix: at3pm } });

  it("gives the run a reset time to count down to, from the refusal alone", () => {
    // Nothing on this side reports a percentage; the refusal's own "resets
    // 3:40pm" is the whole signal, and the strip's countdown reads it.
    const verdict = usageVerdict(spent);
    expect(verdict.kind).toBe("exhausted");
    expect(waitingUntil(spent, null)).toBe(at3pm * 1000);
  });
});
