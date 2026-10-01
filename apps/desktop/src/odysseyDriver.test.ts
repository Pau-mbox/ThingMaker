/**
 * The runner's wiring (docs/plans/odyssey.md §4, §6): does the store actually
 * do what `decide` and `resumeDecision` say, and — the part that matters most —
 * does it stay off the provider when it should?
 *
 * Every command is mocked, so these tests assert calls rather than effects:
 * what got submitted, what state was written, and above all what was *not*
 * submitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AmendmentRecord, OdysseyView, QuotaSnapshot, Snapshot, UsageSnapshot } from "@thingmaker/contracts";

// `vi.mock` is hoisted above the file's own statements, so the mock is built
// inside the factory and read back through the mocked module afterwards.
vi.mock("./ipc", () => ({
  api: {
    odysseyForSession: vi.fn(),
    odysseyView: vi.fn(),
    odysseySetState: vi.fn(async () => undefined),
    odysseyJournalAppend: vi.fn(async () => ({})),
    odysseyRecordContinuation: vi.fn(async () => undefined),
    odysseySetMilestoneState: vi.fn(async () => undefined),
    odysseyRecordReport: vi.fn(async () => undefined),
    odysseyRecordCheck: vi.fn(async () => ({})),
    odysseyAmendAdd: vi.fn(async () => ({})),
    odysseyAmendList: vi.fn(async () => []),
    odysseyAmendDocument: vi.fn(async () => null),
    odysseyAmendSetState: vi.fn(async () => undefined),
    odysseyAmendMarkTold: vi.fn(async () => undefined),
    odysseyEditMilestone: vi.fn(async () => ({})),
    odysseyDeleteMilestone: vi.fn(async () => undefined),
    odysseyReorderMilestones: vi.fn(async () => undefined),
    odysseyPlanDocument: vi.fn(async () => "# Roadmap\n\n## Phase one\nDo the thing.\n"),
    odysseyAddMilestone: vi.fn(async () => ({ id: "new1" })),
    odysseyAddStep: vi.fn(async (_milestoneId: string, title: string) => ({ id: `step-${title}`, title })),
    odysseyEditStep: vi.fn(async () => ({})),
    odysseyAssignStep: vi.fn(async () => undefined),
    odysseySetStepState: vi.fn(async () => undefined),
    odysseyReorderSteps: vi.fn(async () => undefined),
    odysseyDeleteStep: vi.fn(async () => undefined),
    odysseyPlanChangeAdd: vi.fn(async (request: { ops: string; summary: string; state: string }) => ({ id: "pc1", odysseyId: "o1", at: 1, ...request })),
    odysseyPlanChangeList: vi.fn(async () => []),
    odysseyPlanChangeDecide: vi.fn(async () => undefined),
    odysseyQuestionAdd: vi.fn(async (request: { question: string }) => ({ id: "q1", odysseyId: "o1", at: 1, state: "open", options: [], ...request })),
    odysseyQuestionList: vi.fn(async () => []),
    odysseyQuestionSettle: vi.fn(async () => undefined),
    odysseySetPlan: vi.fn(async () => undefined),
    odysseyRepoint: vi.fn(),
    odysseyEditGoal: vi.fn(async () => ({})),
    odysseyClaudePreflight: vi.fn(async () => ({ available: true })),
    sessionCancel: vi.fn(async () => undefined),
    odysseyInstallSkill: vi.fn(async () => ({ path: "/home/.agents/skills/super-thing/SKILL.md", changed: false })),
    odysseyRunCheck: vi.fn(async () => ({ outcome: { passed: true, exitCode: 0, summary: "`pnpm test` exited 0", output: "Tests 12 passed (12)", durationMs: 900, timedOut: false }, milestone: {} })),
    sessionSubmit: vi.fn(async () => ({ outcome: { outcome: "accepted" } })),
    sessionTokenUsage: vi.fn(async () => ({ totals: TOTALS(5_000, 500) })),
    odysseyCheckpoint: vi.fn(async () => ({ treeHash: "t1", fileCount: 3, first: false, changed: 1, additions: 10, deletions: 1, truncated: false, files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 1 }] })),
    odysseyUsageSampleAdd: vi.fn(async () => null),
    odysseySpendModel: vi.fn(async () => ({ samples: 0, pairs: 0, hypotheses: [], verdict: "insufficient", note: "" })),
    odysseyWorkspaceNotes: vi.fn(async () => ({ agentNotes: [] })),
    odysseyList: vi.fn(async () => []),
    confirmDialog: vi.fn(async () => false),
    sessionStop: vi.fn(async () => undefined),
    providerQuota: vi.fn(),
  },
}));
/** Transcript totals of the shape the command returns; paid input and output are what the budget counts. */
const TOTALS = (paidInputTokens: number, outputTokens: number) => ({
  calls: 3,
  inputTokens: paidInputTokens + 40_000,
  outputTokens,
  reasoningTokens: 100,
  cachedInputTokens: 40_000,
  cacheWriteInputTokens: 0,
  foldedItems: 0,
  paidInputTokens,
  cacheablePrefixTokens: 0,
  missedPrefixTokens: 0,
  cachePartial: false,
  partial: false,
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, PLAN_REQUESTED, useStore, type LiveSession } from "./store";
import { emptyProjection, type AgentNode } from "./projection";
import { PROMPT_UNANSWERED, QUOTA_WAIT_HOLD, TRANSPORT_CLOSED } from "./odysseyReport";
import { CLAUDE_RETRY_MS } from "./odysseyClaudeQuota";
import { api as mockedApi } from "./ipc";

// The mocked module's functions, typed as mocks so calls can be asserted.
type Mocks = { [K in keyof typeof mockedApi]: ReturnType<typeof vi.fn> };
const api = mockedApi as unknown as Mocks;

const SESSION = "sess-1";
const window = (usedPercent: number, resetAtUnix?: number) => ({ usedPercent, windowSeconds: 18_000, ...(resetAtUnix ? { resetAtUnix } : {}) });
const usage = (overrides: Partial<UsageSnapshot>): UsageSnapshot => ({ fetchedAtUnixMs: 0, allowed: true, limitReached: false, ...overrides });
/** The same reading as Codex's app-server reports it, which is what `providerQuota` answers. */
const quota = (snapshot: UsageSnapshot): QuotaSnapshot => ({
  provider: "codex",
  status: snapshot.limitReached ? "rejected" : "allowed",
  windows: [snapshot.primary, snapshot.secondary]
    .filter((w): w is NonNullable<typeof w> => !!w)
    .map((w, index) => ({ kind: index === 0 ? "primary" : "secondary", usedPercent: w.usedPercent, windowMinutes: index === 0 ? 300 : 10_080, ...(w.resetAtUnix ? { resetsAt: w.resetAtUnix } : {}) })),
  ...(snapshot.planType ? { plan: snapshot.planType } : {}),
  observedAtUnixMs: snapshot.fetchedAtUnixMs,
});

function view(overrides: { state?: OdysseyView["goal"]["state"]; onUsageReset?: OdysseyView["goal"]["onUsageReset"]; briefed?: boolean; milestoneState?: OdysseyView["milestones"][number]["state"] } = {}): OdysseyView {
  return {
    goal: {
      id: "o1",
      workspaceId: "w1",
      sessionId: "kw-1",
      title: "Ship onboarding v2",
      brief: "",
      state: overrides.state ?? "running",
      stopCondition: "goal_complete",
      onUsageReset: overrides.onUsageReset ?? "notify_only",
      onReport: "continue",
      onPlanChange: "auto",
      orchestrator: "codex",
      deadTurnMinutes: 30,
      maxContinuations: 50,
      continuationsUsed: 2,
      tokensUsed: 100,
      createdAt: 0,
      updatedAt: 0,
    },
    milestones: [
      { id: "m1", odysseyId: "o1", position: 0, title: "Audit flow", detail: "", state: "verified", checkKind: "manual", steps: [] },
      { id: "m2", odysseyId: "o1", position: 1, title: "Build screens", detail: "", state: overrides.milestoneState ?? "active", checkKind: "manual", steps: [] },
    ],
    journal: overrides.briefed === false ? [] : [{ id: "j1", odysseyId: "o1", at: 1, kind: "briefing", summary: "briefed", detail: JSON.stringify({ startTokens: 1_000 }) }],
  };
}

function seed(odyssey: OdysseyView, extra: { idle?: boolean; usageSnapshot?: UsageSnapshot | null; resumeAt?: number | null } = {}) {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  projection.foreground = extra.idle === false ? "running" : "idle";
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: "kw-1", provider: "codex" } as unknown as Snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
  api.odysseyView.mockResolvedValue(odyssey);
  useStore.setState({
    sessions: { [SESSION]: session },
    odyssey: { [SESSION]: odyssey },
    odysseyRuntime: { [SESSION]: { resumeAt: extra.resumeAt ?? null, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false } },
    odysseyPendingDeltas: {},
    odysseyToolBaseline: {},
    odysseyAmendments: {},
    odysseyPendingTurn: {},
    odysseyNotes: {},
    usage: { codex: extra.usageSnapshot === undefined ? usage({ primary: window(20), secondary: window(10) }) : extra.usageSnapshot },
    repoInfo: { w1: null },
    error: null,
  });
}

describe("the runner's wiring", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("submits the briefing first, and records the starting token total", async () => {
    seed(view({ briefed: false }));
    await useStore.getState().odysseyTick(SESSION);

    // The briefing offers the skill, so the skill is installed first.
    expect(api.odysseyInstallSkill).toHaveBeenCalled();
    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(api.sessionSubmit.mock.calls[0]?.[3] ?? api.sessionSubmit.mock.calls[0]?.[2]).toContain("You are working under Super Thing");
    const briefing = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "briefing");
    expect(JSON.parse(briefing?.detail ?? "{}")).toEqual({ startTokens: 5_500 });
  });

  it("releases the session after a submit, so the next turn is not blocked for ever", async () => {
    // The marker means "a submit is awaiting its accept", not "a turn is
    // running". Leaving it set made the runner report "a turn is already
    // running" from then on and the goal sat at Running doing nothing.
    seed(view({ briefed: false }));
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sessions[SESSION]?.inFlightRequestId).toBeNull();
  });

  it("releases the session when the submit is refused, or throws", async () => {
    api.sessionSubmit.mockResolvedValueOnce({ outcome: { outcome: "rejected", error: { code: "IO", message: "no" } } } as never);
    seed(view({ briefed: false }));
    await useStore.getState().odysseyTick(SESSION);
    expect(useStore.getState().sessions[SESSION]?.inFlightRequestId).toBeNull();

    api.sessionSubmit.mockRejectedValueOnce(new Error("transport died"));
    seed(view({ briefed: false }));
    await useStore.getState().odysseyTick(SESSION);
    expect(useStore.getState().sessions[SESSION]?.inFlightRequestId).toBeNull();
  });

  it("continues the active milestone with a short prompt once briefed", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("Continue. Milestone 2/2: Build screens.");
    expect(text).not.toContain("You are working under Super Thing");
    expect(api.odysseySetMilestoneState).toHaveBeenCalledWith("m2", "active");
    // The checkpoint is written before the prompt goes out.
    expect(api.odysseyJournalAppend.mock.calls.map(([r]) => r.kind)).toContain("checkpoint");
  });

  it("parks on a spent usage window instead of submitting", async () => {
    seed(view(), { usageSnapshot: usage({ primary: window(100, 1_700_000_000), secondary: window(50) }) });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "waiting_usage");
    expect(useStore.getState().odysseyRuntime[SESSION]?.resumeAt).toBe(1_700_000_000_000);
  });

  it("does not submit while a turn is already running", async () => {
    seed(view(), { idle: false });
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });

  it("blocks at the continuation ceiling without submitting", async () => {
    const atCeiling = view();
    atCeiling.goal.continuationsUsed = 50;
    seed(atCeiling);
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
  });

  it("moves on from an unverified claim by default, without calling it verified", async () => {
    const claimed = view({ milestoneState: "reported" });
    claimed.milestones.push({ id: "m3", odysseyId: "o1", position: 2, title: "Ship it", detail: "", state: "planned", checkKind: "manual", steps: [] });
    seed(claimed);

    await useStore.getState().odysseyTick(SESSION);

    // The next milestone is worked, and nothing claimed the skipped one is done.
    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).toContain("Milestone 3/3");
    expect(api.odysseyRecordCheck).not.toHaveBeenCalled();
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "paused");
  });

  it("stops at a claimed milestone and asks for verification, when told to wait", async () => {
    const waiting = view({ milestoneState: "reported" });
    seed({ ...waiting, goal: { ...waiting.goal, onReport: "wait" } });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "paused");
    const journal = api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary);
    expect(journal.some((summary) => summary.includes("verify it to continue"))).toBe(true);
  });

  it("records a report as a claim, never as a verification", async () => {
    const current = view();
    seed(current);
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text: "done\nODYSSEY-REPORT: milestone=2 status=complete note=screens built" }], contentUnknown: false },
    } as never);

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordReport).toHaveBeenCalledWith("m2", "screens built");
    expect(api.odysseyRecordCheck).not.toHaveBeenCalled();
  });

  it("charges the turn to the goal's budget from the transcript's own numbers", async () => {
    seed(view());
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    // 5,500 spent now, 1,000 when the goal started, 100 already charged.
    expect(api.odysseyRecordContinuation).toHaveBeenCalledWith("o1", 4_400);
  });

  it("blocks on a turn that failed for a reason that is not the quota", async () => {
    seed(view());
    await useStore.getState().odysseyOnSettle(SESSION, "failed", "compile error in src/main.rs");

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
    expect(api.providerQuota).not.toHaveBeenCalled();
  });

  it("re-samples usage before treating a failure as a limit", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ limitReached: true, primary: window(100, 1_700_000_000) })));
    seed(view());
    await useStore.getState().odysseyOnSettle(SESSION, "failed", "429 Too Many Requests");

    expect(api.providerQuota).toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "waiting_usage");
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
  });
});

describe("waking from a usage wait", () => {
  const flush = async () => {
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("re-checks the account once the window should be back, however old the snapshot is", async () => {
    // The bug: the goal was parked with a snapshot saying 100%, the decision
    // was made from that snapshot, it held, so nothing ever refreshed it. A
    // goal parked at 16:07 was still parked at 18:58.
    const reset = Math.floor((Date.now() - 60_000) / 1000);
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(4), secondary: window(20) })));
    seed(view({ state: "waiting_usage", onUsageReset: "continue_automatically" }), {
      resumeAt: null,
      usageSnapshot: usage({ fetchedAtUnixMs: Date.now() - 3 * 3_600_000, primary: window(100, reset), secondary: window(20) }),
    });

    // Once it starts, the record says running; the mock has to agree or the
    // tick that follows reads a goal that is still parked.
    api.odysseyView.mockResolvedValue(view({ state: "running" }) as never);

    await useStore.getState().odysseyPoll();

    expect(api.providerQuota).toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
    expect(api.sessionSubmit).toHaveBeenCalled();
  });

  it("stays parked when the fresh sample still says there is no room", async () => {
    const reset = Math.floor((Date.now() - 60_000) / 1000);
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(100, Math.floor(Date.now() / 1000) + 3_600) })));
    seed(view({ state: "waiting_usage" }), {
      resumeAt: null,
      usageSnapshot: usage({ fetchedAtUnixMs: Date.now() - 3 * 3_600_000, primary: window(100, reset) }),
    });

    await useStore.getState().odysseyPoll();

    expect(api.providerQuota).toHaveBeenCalled();
    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "running");
  });

  it("resumes a goal parked in front of a window that freed up early", async () => {
    // The rolling window gives capacity back before the reset it named, so a
    // goal parked at 99% can have a full window in front of it long before the
    // clock runs out. The sample decides; the clock does not get a vote.
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(0), secondary: window(80) })));
    seed(view({ state: "waiting_usage", onUsageReset: "continue_automatically" }), {
      resumeAt: Date.now() + 2 * 3_600_000,
      usageSnapshot: usage({ fetchedAtUnixMs: Date.now() - 6 * 60_000, primary: window(99, Math.floor(Date.now() / 1000) + 7_200), secondary: window(80) }),
    });
    api.odysseyView.mockResolvedValue(view({ state: "running" }) as never);

    await useStore.getState().odysseyPoll();
    await flush();

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
    expect(api.sessionSubmit).toHaveBeenCalled();
  });

  it("holds while the window is still genuinely spent", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(100, Math.floor(Date.now() / 1000) + 3_600) })));
    seed(view({ state: "waiting_usage" }), {
      resumeAt: Date.now() + 3_600_000,
      usageSnapshot: usage({ fetchedAtUnixMs: Date.now() - 10 * 60_000, primary: window(100, Math.floor(Date.now() / 1000) + 3_600) }),
    });
    await useStore.getState().odysseyPoll();
    await flush();
    // It looks — the window could have freed up early — and then holds.
    expect(api.providerQuota).toHaveBeenCalled();
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });

  it("does not hammer the usage endpoint while it waits", async () => {
    seed(view({ state: "waiting_usage" }), {
      resumeAt: Date.now() + 3_600_000,
      usageSnapshot: usage({ fetchedAtUnixMs: Date.now() - 20_000, primary: window(100, Math.floor(Date.now() / 1000) + 3_600) }),
    });
    await useStore.getState().odysseyPoll();
    await flush();
    expect(api.providerQuota, "a sample 20s old is fresh enough").not.toHaveBeenCalled();
  });

  it("notifies and stays paused when the mode is notify_only", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(5) })));
    seed(view({ state: "waiting_usage", onUsageReset: "notify_only" }), { resumeAt: Date.now() - 60_000 });
    await useStore.getState().odysseyPoll();

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "paused");
    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().announcement).toContain("ready to resume");
  });

  it("resumes and continues when the mode is continue_automatically", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(5) })));
    const resumed = view({ state: "waiting_usage", onUsageReset: "continue_automatically" });
    seed(resumed, { resumeAt: Date.now() - 60_000 });
    // The refresh after `odysseySetState` reports the goal as running again.
    api.odysseyView.mockResolvedValue({ ...resumed, goal: { ...resumed.goal, state: "running" } });

    await useStore.getState().odysseyPoll();

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(api.sessionSubmit.mock.calls[0]?.[2]).toContain("Resumed after waiting");
  });

  it("does not resume on the clock alone when usage still reports no room", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ limitReached: true, primary: window(100, 1) })));
    seed(view({ state: "waiting_usage", onUsageReset: "continue_automatically" }), { resumeAt: Date.now() - 60_000 });
    await useStore.getState().odysseyPoll();

    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "running");
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });
});

/**
 * O5: the two verification lanes (docs/plans/odyssey.md §5.1). The rule these
 * tests exist to protect is the same in both: nothing becomes "verified"
 * without an exit code, and an unreadable turn claims nothing at all.
 */
describe("verifying a milestone", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  /** A goal whose second milestone claims completion and names a check. */
  function claimed(): OdysseyView {
    const current = view({ milestoneState: "reported" });
    const milestone = current.milestones[1]!;
    current.milestones[1] = { ...milestone, checkKind: "tests_pass", checkSpec: "pnpm test", reportedNote: "screens built" };
    return current;
  }

  /** Puts a settled shell result in the projection, as Kit's tool record. */
  function toolResult(id: string, output: unknown) {
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.toolCalls.set(id, { rawOutput: output } as never);
  }

  function reported(text = "SUPERTHING-REPORT: milestone=2 status=complete note=screens built") {
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text }], contentUnknown: false },
    } as never);
  }

  it("verifies from the agent's own tool result when the exit code is there", async () => {
    seed(claimed());
    useStore.setState({ odysseyToolBaseline: { [SESSION]: [] } });
    toolResult("t1", { command: "pnpm test", exit_code: 0, stdout: "Tests 12 passed (12)", stderr: "" });
    reported();

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordReport).toHaveBeenCalledWith("m2", "screens built");
    const [id, passed, evidence, source] = api.odysseyRecordCheck.mock.calls[0] ?? [];
    expect([id, passed, source]).toEqual(["m2", true, "agent_tool_result"]);
    expect(evidence).toContain("exit code read from its tool result");
  });

  it("fails the milestone on a non-zero exit, and tells the model why", async () => {
    seed(claimed());
    useStore.setState({ odysseyToolBaseline: { [SESSION]: [] } });
    toolResult("t1", { command: "pnpm test", exit_code: 1, stdout: "", stderr: "AssertionError: expected 2\n  at onboarding.test.ts:14" });
    reported();

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordCheck.mock.calls[0]?.slice(0, 2)).toEqual(["m2", false]);
    const delta = useStore.getState().odysseyDeltas(SESSION).find((entry) => entry.kind === "check_failed");
    expect(delta).toMatchObject({ kind: "check_failed", command: "pnpm test", exitCode: 1 });
    expect(delta && "tail" in delta && delta.tail).toContain("AssertionError");
  });

  it("claims nothing from a turn whose commands cannot be told apart", async () => {
    seed(claimed());
    useStore.setState({ odysseyToolBaseline: { [SESSION]: [] } });
    toolResult("t1", { exit_code: 0, stdout: "ok" });
    toolResult("t2", { exit_code: 0, stdout: "ok" });
    reported();

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordCheck).not.toHaveBeenCalled();
    const summaries = api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary);
    expect(summaries.some((summary: string) => summary.includes("Nothing in the turn's tool results verified"))).toBe(true);
  });

  it("ignores a matching result from a turn the runner did not start", async () => {
    seed(claimed());
    // No baseline: the tool results cannot be attributed to this claim.
    toolResult("t1", { command: "pnpm test", exit_code: 0, stdout: "" });
    reported();

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyRecordCheck).not.toHaveBeenCalled();
  });

  it("ignores a check that ran before the runner submitted this turn", async () => {
    seed(claimed());
    toolResult("stale", { command: "pnpm test", exit_code: 0, stdout: "" });
    useStore.setState({ odysseyToolBaseline: { [SESSION]: ["stale"] } });
    reported();

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyRecordCheck).not.toHaveBeenCalled();
  });

  it("runs the check here when a claim arrives with no usable evidence", async () => {
    const current = claimed();
    seed(current);
    // The check records a verdict, so the refreshed record moves off the claim.
    const verified = { ...current, milestones: [current.milestones[0]!, { ...current.milestones[1]!, state: "verified" as const, checkSource: "desktop" as const }] };
    api.odysseyView.mockResolvedValue(verified as never);
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseyRunCheck).toHaveBeenCalledWith("w1", "m2");
    // The desktop lane decides without another turn, so the goal is not paused
    // and the run continues.
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "paused");
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
  });

  it("tells the model what a desktop-run check found", async () => {
    api.odysseyRunCheck.mockResolvedValueOnce({
      outcome: { passed: false, exitCode: 2, summary: "`pnpm test` exited 2", output: "1 failed\nsee onboarding.test.ts", durationMs: 10, timedOut: false },
      milestone: {},
    } as never);
    const current = claimed();
    seed(current);
    api.odysseyView.mockResolvedValue({ ...current, milestones: [current.milestones[0]!, { ...current.milestones[1]!, state: "failed" as const }] } as never);
    await useStore.getState().odysseyRunCheck(SESSION, "m2");

    // The failure reaches the model in the very next continuation, with the
    // command, the code and the tail — not just "the check failed".
    const text = api.sessionSubmit.mock.calls.at(-1)?.[2] as string;
    expect(text).toContain("pnpm test");
    expect(text).toContain("2");
    expect(text).toContain("onboarding.test.ts");
    // Told once: the delta is cleared when the prompt carrying it goes out.
    expect(useStore.getState().odysseyDeltas(SESSION).some((entry) => entry.kind === "check_failed")).toBe(false);
  });

  it("stops rather than looping when a check leaves the milestone unmoved", async () => {
    // The record still says "reported" after the check: running it again
    // would be an infinite loop, so the run pauses and says what happened.
    seed(claimed());
    await useStore.getState().odysseyRunCheck(SESSION, "m2");

    expect(api.odysseyRunCheck).toHaveBeenCalledTimes(1);
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "paused");
    const summaries = api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary);
    expect(summaries.some((summary: string) => summary.includes("still only reported"))).toBe(true);
  });

  it("waits for the user on a claim it cannot check itself, when told to wait", async () => {
    const current = view({ milestoneState: "reported" });
    seed({ ...current, goal: { ...current.goal, onReport: "wait" } });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseyRunCheck).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "paused");
  });

  it("refuses to run a manual milestone's check", async () => {
    const current = view({ milestoneState: "reported" });
    seed(current);
    await useStore.getState().odysseyRunCheck(SESSION, "m2");

    expect(api.odysseyRunCheck).not.toHaveBeenCalled();
    expect(useStore.getState().error?.message).toContain("verified by you");
  });
});

describe("the skill the briefing points at", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("drops the offer rather than pointing at a skill it could not install", async () => {
    api.odysseyInstallSkill.mockRejectedValueOnce(new Error("HOME is not set"));
    seed(view({ briefed: false }));
    await useStore.getState().odysseyTick(SESSION);

    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("You are working under Super Thing");
    expect(text).not.toContain("odyssey` skill");
  });

  it("does not reinstall it on an ordinary continuation", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    expect(api.odysseyInstallSkill).not.toHaveBeenCalled();
  });
});

/**
 * Planning a goal from a document (docs/plans/odyssey.md §3.1). The rule these
 * tests protect: Super Thing never reads the document for milestones, and the plan
 * the model proposes lands as a draft nobody has started.
 */
describe("planning a goal from a document", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  /** A draft goal created from a document, with no milestones yet. */
  function draft(overrides: { journal?: OdysseyView["journal"]; milestones?: OdysseyView["milestones"] } = {}): OdysseyView {
    const base = view({ state: "draft", briefed: false });
    return {
      goal: { ...base.goal, state: "draft", planSource: "roadmap.md", planDocumentBytes: 400 },
      milestones: overrides.milestones ?? [],
      journal: overrides.journal ?? [],
    };
  }

  function replied(text: string) {
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text }], contentUnknown: false },
    } as never);
  }

  const PLAN_REPLY = `Read it.

SUPERTHING-PLAN
milestone: Phase one
detail: Do the thing.
check: tests_pass cargo test
step: first
step: second
milestone: Phase two
END-SUPERTHING-PLAN`;

  it("submits the document to the model rather than parsing it", async () => {
    seed(draft());
    await useStore.getState().odysseyRequestPlan(SESSION);

    // Released once the submit is accepted, or the run that follows would see
    // a busy session and never brief it.
    expect(useStore.getState().sessions[SESSION]?.inFlightRequestId).toBeNull();

    expect(api.odysseyPlanDocument).toHaveBeenCalledWith("o1");
    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("## Phase one");
    expect(text).toContain("SUPERTHING-PLAN");
    expect(text).toContain("roadmap.md");
    // Planning only: no milestone is written by asking.
    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
    // And the request is journalled, so a reload knows a reply is expected.
    expect(api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary)).toContain(PLAN_REQUESTED);
  });

  it("writes the milestones the model proposed, with their steps and checks", async () => {
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    replied(PLAN_REPLY);
    // The second read returns the milestones the writes created, so the steps
    // pass has ids to attach to.
    api.odysseyView.mockResolvedValue({
      ...draft(),
      milestones: [
        { id: "n1", odysseyId: "o1", position: 0, title: "Phase one", detail: "Do the thing.", state: "planned", checkKind: "tests_pass", checkSpec: "cargo test", steps: [] },
        { id: "n2", odysseyId: "o1", position: 1, title: "Phase two", detail: "", state: "planned", checkKind: "manual", steps: [] },
      ],
    } as never);

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddMilestone.mock.calls.map(([request]) => request.title)).toEqual(["Phase one", "Phase two"]);
    expect(api.odysseyAddMilestone.mock.calls[0]?.[0]).toMatchObject({ checkKind: "tests_pass", checkSpec: "cargo test" });
    expect(api.odysseyAddStep.mock.calls).toEqual([
      ["n1", "first"],
      ["n1", "second"],
    ]);
  });

  it("leaves the goal a draft, so a plan from a document is always seen first", async () => {
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    replied(PLAN_REPLY);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseySetState).not.toHaveBeenCalled();
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });

  it("records that no plan was proposed rather than inventing one", async () => {
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    replied("This document is a design note. I did not find milestones in it.");
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
    expect(api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary)).toContain("The agent proposed no plan");
  });

  it("does not read a reply as a plan when no plan was asked for", async () => {
    seed(draft());
    replied(PLAN_REPLY);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
  });

  it("does not overwrite milestones that already exist", async () => {
    const existing = view().milestones;
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }], milestones: existing }));
    replied(PLAN_REPLY);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
  });

  it("wires a proposed plan's task dependencies by id after the tasks exist", async () => {
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    api.odysseyAddMilestone.mockResolvedValue({ id: "new1" } as never);
    api.odysseyView.mockResolvedValue({
      ...draft(),
      milestones: [{ id: "new1", odysseyId: "o1", position: 0, title: "Phase one", detail: "", state: "planned", checkKind: "manual", steps: [] }],
    } as never);
    replied("SUPERTHING-PLAN\nmilestone: Phase one\nstep: Model\nstep: Pricing\ndepends: 1\nEND-SUPERTHING-PLAN");
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddStep.mock.calls.map(([, title]) => title)).toEqual(["Model", "Pricing"]);
    expect(api.odysseyEditStep).toHaveBeenCalledWith("step-Pricing", { dependsOn: ["step-Model"] });
  });

  it("charges nothing to a draft's budget: there is no run to account for", async () => {
    seed(draft({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    replied(PLAN_REPLY);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyRecordContinuation).not.toHaveBeenCalled();
  });

  it("refuses to ask while the session is mid-turn", async () => {
    seed(draft(), { idle: false });
    await useStore.getState().odysseyRequestPlan(SESSION);

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().error?.message).toContain("session is busy");
  });

  it("says so when the goal has no document to read", async () => {
    api.odysseyPlanDocument.mockResolvedValueOnce(null as never);
    seed(draft());
    await useStore.getState().odysseyRequestPlan(SESSION);

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().error?.message).toContain("no plan document");
  });
});

/**
 * A wedged run reports itself (docs/plans/odyssey-observability.md §4). The
 * bug that prompted this sat on one idle reason for an hour in total silence.
 */
describe("a run that cannot act", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    vi.useRealTimers();
  });

  /** A running goal whose session is mid-turn, so every tick idles. */
  function busy() {
    seed(view(), { idle: false });
  }

  it("starts the stall clock on the first tick it cannot act", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);

    const runtime = useStore.getState().odysseyRuntime[SESSION]!;
    expect(runtime.lastReason).toBe("a turn is already running");
    expect(runtime.stalledSince).toBeGreaterThan(0);
    expect(runtime.stallNotified).toBe(false);
    // Nothing is journalled yet: an idle tick is not news.
    expect(api.odysseyJournalAppend).not.toHaveBeenCalled();
  });

  it("keeps one clock across repeated ticks with the same reason", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);
    const first = useStore.getState().odysseyRuntime[SESSION]!.stalledSince;
    await useStore.getState().odysseyTick(SESSION);
    await useStore.getState().odysseyTick(SESSION);

    expect(useStore.getState().odysseyRuntime[SESSION]!.stalledSince).toBe(first);
    expect(api.odysseyJournalAppend).not.toHaveBeenCalled();
  });

  it("restarts the clock when the reason changes, because that run is moving", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);
    const first = useStore.getState().odysseyRuntime[SESSION]!.stalledSince!;

    // Same goal, different obstacle.
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.attachment = "detached";
    await useStore.getState().odysseyTick(SESSION);

    const runtime = useStore.getState().odysseyRuntime[SESSION]!;
    expect(runtime.lastReason).toBe("the session is not attached");
    expect(runtime.stalledSince).toBeGreaterThanOrEqual(first);
  });

  it("journals and announces once the wait stops being ordinary", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);
    // Backdate the clock rather than waiting five minutes.
    useStore.setState({ odysseyRuntime: { [SESSION]: { ...useStore.getState().odysseyRuntime[SESSION]!, stalledSince: Date.now() - 6 * 60_000 } } });
    await useStore.getState().odysseyTick(SESSION);

    const guard = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "guard");
    expect(guard?.summary).toMatch(/^Super Thing has not been able to act for 6m: a turn is already running$/);
    expect(useStore.getState().odysseyRuntime[SESSION]!.stallNotified).toBe(true);
  });

  it("reports a stall once per episode, not once per tick", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);
    useStore.setState({ odysseyRuntime: { [SESSION]: { ...useStore.getState().odysseyRuntime[SESSION]!, stalledSince: Date.now() - 6 * 60_000 } } });
    await useStore.getState().odysseyTick(SESSION);
    await useStore.getState().odysseyTick(SESSION);
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseyJournalAppend.mock.calls.filter(([request]) => request.kind === "guard")).toHaveLength(1);
  });

  it("clears the clock as soon as the runner acts again", async () => {
    busy();
    await useStore.getState().odysseyTick(SESSION);
    expect(useStore.getState().odysseyRuntime[SESSION]!.stalledSince).not.toBeNull();

    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).toHaveBeenCalled();
    expect(useStore.getState().odysseyRuntime[SESSION]!.stalledSince).toBeNull();
    expect(useStore.getState().odysseyRuntime[SESSION]!.stallNotified).toBe(false);
  });
});

/**
 * Resuming after a reload. Renderer changes drop every bit of in-memory
 * bookkeeping, so a run has to come back from the record alone — otherwise
 * shipping an improvement to Super Thing would silently stop the goal it was
 * meant to help.
 */
/**
 * Only one tick at a time. Three callers can reach the runner at once; when
 * they did, Kit refused four submits with "session is already running a
 * prompt", the goal blocked, and the continuations were spent for nothing.
 */
describe("ticks that arrive together", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("submits once when the heartbeat, a settle and Start all fire together", async () => {
    seed(view());
    const store = useStore.getState();
    await Promise.all([store.odysseyTick(SESSION), store.odysseyTick(SESSION), store.odysseyTick(SESSION), store.odysseyTick(SESSION), store.odysseyTick(SESSION)]);
    // The four that were turned away return at once; the first is still going.
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(api.odysseyJournalAppend.mock.calls.filter(([request]) => request.kind === "checkpoint")).toHaveLength(1);
  });

  it("lets the next tick run once the first one is done", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit).toHaveBeenCalledTimes(2);
  });

  it("treats a busy session as busy, not as a reason to block the goal", async () => {
    api.sessionSubmit.mockResolvedValueOnce({
      outcome: { outcome: "rejected", error: { code: "IO", message: "Kit rejected the request: Internal error: unsupported operation: session is already running a prompt" } },
    } as never);
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toContain("busy");
  });

  it("still blocks on a refusal that is a real refusal", async () => {
    api.sessionSubmit.mockResolvedValueOnce({ outcome: { outcome: "rejected", error: { code: "IO", message: "the model is not available" } } } as never);
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
  });
});

/**
 * Resume has to actually resume. The journal is append-only, so a guard that
 * reads the whole of it re-trips the instant the run restarts — the button
 * looked broken because it was.
 */
describe("resuming a blocked run", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  /** A goal blocked by the no-progress guard, its stale checkpoints intact. */
  function stalled(): OdysseyView {
    const base = view({ state: "blocked" });
    const stale = (at: number): OdysseyView["journal"][number] => ({ id: `c${at}`, odysseyId: "o1", at, kind: "checkpoint", summary: "2000 files", detail: "2000|671|109698|active" });
    return { ...base, journal: [stale(5), stale(4), stale(3), stale(2), ...base.journal] };
  }

  it("continues instead of blocking again on the same evidence", async () => {
    const blocked = stalled();
    seed(blocked);
    // The record after Start: running, with the restart row the guard reads.
    api.odysseyView.mockResolvedValue({
      ...blocked,
      goal: { ...blocked.goal, state: "running" },
      journal: [{ id: "r", odysseyId: "o1", at: 6, kind: "state", summary: "Resumed from blocked" }, ...blocked.journal],
    } as never);

    await useStore.getState().odysseyStart(SESSION);

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
  });

  it("still blocks when the run goes stale again after the restart", async () => {
    const blocked = stalled();
    seed(blocked);
    const restart = { id: "r", odysseyId: "o1", at: 6, kind: "state" as const, summary: "Resumed from blocked" };
    const fresh = (at: number) => ({ id: `n${at}`, odysseyId: "o1", at, kind: "checkpoint" as const, summary: "no change", detail: "same" });
    api.odysseyView.mockResolvedValue({
      ...blocked,
      goal: { ...blocked.goal, state: "running" },
      journal: [fresh(10), fresh(9), fresh(8), fresh(7), restart, ...blocked.journal],
    } as never);

    await useStore.getState().odysseyStart(SESSION);

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
  });
});

describe("picking a run back up after a reload", () => {
  // The heartbeat starts a tick without awaiting it, so one slow session
  // cannot hold up the others; the test has to let those settle.
  const flush = async () => {
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("continues a running goal on the heartbeat with no runtime state at all", async () => {
    seed(view());
    // Everything the runner kept in memory is gone: the reason, the stall
    // clock, the tool baseline, the resume time.
    useStore.setState({ odysseyRuntime: {}, odysseyToolBaseline: {}, odysseyPendingDeltas: {} });

    await useStore.getState().odysseyPoll();
    await flush();

    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(api.sessionSubmit.mock.calls[0]?.[2]).toContain("Continue. Milestone 2/2");
  });

  it("re-briefs nothing: the briefing is remembered by the journal, not by memory", async () => {
    seed(view());
    useStore.setState({ odysseyRuntime: {} });
    await useStore.getState().odysseyPoll();
    await flush();

    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).not.toContain("You are working under Super Thing");
  });

  it("leaves a paused or blocked goal alone, because resuming is the user's call", async () => {
    for (const state of ["paused", "blocked", "complete"] as const) {
      for (const fn of Object.values(api)) fn.mockClear();
      seed(view({ state }));
      useStore.setState({ odysseyRuntime: {} });
      await useStore.getState().odysseyPoll();
      await flush();
      expect(api.sessionSubmit, `a ${state} goal must not submit`).not.toHaveBeenCalled();
    }
  });

  it("waits for the turn in flight rather than double-submitting into it", async () => {
    seed(view(), { idle: false });
    useStore.setState({ odysseyRuntime: {} });
    await useStore.getState().odysseyPoll();
    await flush();

    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toBe("a turn is already running");
  });
});

/**
 * Changing a goal while it runs (docs/plans/odyssey.md §3.2). The rules these
 * protect: the runner is never interrupted, the model decides where the change
 * belongs, and verified work is never rewritten.
 */
describe("amending a running goal", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.odysseyAddMilestone.mockResolvedValue({ id: "new1" } as never);
  });

  const queued = (overrides: Partial<AmendmentRecord> = {}): AmendmentRecord => ({
    id: "a1",
    odysseyId: "o1",
    at: 1,
    note: "Generate the ships and embed them",
    refs: [{ path: "Assets/Art/Ships", kind: "directory", detail: "48 files" }],
    state: "pending",
    tellCount: 0,
    ...overrides,
  });

  it("never submits on its own while a turn is running", async () => {
    seed(view(), { idle: false });
    await useStore.getState().odysseyAddAmendment(SESSION, { odysseyId: "o1", note: "add the ships", refs: [] });
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.odysseyAmendAdd).toHaveBeenCalled();
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });

  it("carries a queued change on the next prompt, as a reference the agent opens itself", async () => {
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued()] } });
    await useStore.getState().odysseyTick(SESSION);

    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("Continue. Milestone 2/2");
    expect(text).toContain("Generate the ships and embed them");
    expect(text).toContain("`Assets/Art/Ships` (directory, 48 files)");
    expect(text).toContain("you decide where and when");
    // Counted as carried, at the point in the run where it happened.
    expect(api.odysseyAmendMarkTold).toHaveBeenCalledWith("a1", 2);
  });

  it("does not repeat a change in the very next prompt", async () => {
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ state: "told", tellCount: 1, toldAtContinuation: 2 })] } });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).not.toContain("Generate the ships");
  });

  it("asks again once the agent has had a few turns and done nothing", async () => {
    // The bug: told once, then never again, while forty-six continuations went
    // by and the prompt that carried it compacted out of context.
    const current = view();
    current.goal.continuationsUsed = 12;
    seed(current);
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ state: "told", tellCount: 1, toldAtContinuation: 2 })] } });
    await useStore.getState().odysseyTick(SESSION);

    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("Generate the ships and embed them");
    expect(text).toContain("asked this once already");
    expect(api.odysseyAmendMarkTold).toHaveBeenCalledWith("a1", 12);
  });

  it("stops asking after enough refusals rather than repeating for ever", async () => {
    const current = view();
    // Well past the re-tell interval, but still inside the continuation ceiling
    // so the goal actually submits.
    current.goal.continuationsUsed = 30;
    seed(current);
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ state: "told", tellCount: 3, toldAtContinuation: 4 })] } });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).not.toContain("Generate the ships");
    expect(api.odysseyAmendMarkTold).not.toHaveBeenCalled();
  });

  it("quotes a document only when the agent cannot open it itself", async () => {
    api.odysseyAmendDocument.mockResolvedValue("# Ships\nOne per class." as never);
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ documentSource: "ships.md", refs: [] })] } });
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).toContain("One per class.");
  });

  it("applies the plan changes the model replied with, in the order it meant", async () => {
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ state: "told" })] } });
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: {
        key: "m",
        role: "agent",
        messageId: "1",
        blocks: [
          {
            type: "text",
            text: "SUPERTHING-AMEND\nadd: Ship art pipeline\nafter: 1\nstep: Import the sprites\nrevise: 2\ntitle: Build screens with ships\nEND-SUPERTHING-AMEND",
          },
        ],
        contentUnknown: false,
      },
    } as never);

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddMilestone.mock.calls[0]?.[0]).toMatchObject({ title: "Ship art pipeline" });
    expect(api.odysseyAddStep).toHaveBeenCalledWith("new1", "Import the sprites");
    expect(api.odysseyEditMilestone).toHaveBeenCalledWith("m2", expect.objectContaining({ title: "Build screens with ships" }));
    // The round trip is closed: the queued change is marked applied.
    expect(api.odysseyAmendSetState).toHaveBeenCalledWith("a1", "applied");
  });

  it("refuses to rewrite a verified milestone, and says so in the record", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text: "SUPERTHING-AMEND\ndrop: 1\nreason: no longer needed\nEND-SUPERTHING-AMEND" }], contentUnknown: false },
    } as never);

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyDeleteMilestone).not.toHaveBeenCalled();
    const entry = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.summary?.includes("The plan changed"));
    expect(entry?.detail).toContain("already verified");
  });

  it("changes nothing when the reply has no amendment block", async () => {
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [queued({ state: "told" })] } });
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text: "Noted; the plan already covers it." }], contentUnknown: false },
    } as never);

    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
    expect(api.odysseyEditMilestone).not.toHaveBeenCalled();
    // Still waiting on the model, so it is not marked applied.
    expect(api.odysseyAmendSetState).not.toHaveBeenCalledWith("a1", "applied");
  });

  it("tells the model what changed in the next continuation", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push({
      kind: "message",
      key: "m",
      message: { key: "m", role: "agent", messageId: "1", blocks: [{ type: "text", text: "SUPERTHING-AMEND\nadd: Ship art pipeline\nEND-SUPERTHING-AMEND" }], contentUnknown: false },
    } as never);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    // It reaches the model in the very next prompt, which the settle sends.
    const text = api.sessionSubmit.mock.calls.at(-1)?.[2] as string;
    expect(text).toContain("Plan edited:");
    expect(text).toContain("Ship art pipeline");
  });
});

/**
 * Cancelling a turn that stopped being one. The runner does this itself
 * because nothing else can: the turn cannot settle, so the session never goes
 * idle, so the run waits for a human who may be asleep.
 */
describe("a turn that went silent", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  /** A running goal whose session claims a turn but has gone quiet. */
  function silent(minutesQuiet: number) {
    seed(view(), { idle: false });
    const session = useStore.getState().sessions[SESSION]!;
    useStore.setState({ sessions: { [SESSION]: { ...session, lastEventAt: Date.now() - minutesQuiet * 60_000 } } });
  }

  it("cancels it, says how long it was silent, and does not submit into it", async () => {
    silent(80);
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionCancel).toHaveBeenCalledTimes(1);
    expect(api.sessionSubmit).not.toHaveBeenCalled();
    const guard = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "guard");
    expect(guard?.summary).toBe("Cancelled a turn that had produced nothing for 1h 20m");
  });

  it("leaves a turn alone while it is still producing events", async () => {
    silent(3);
    await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionCancel).not.toHaveBeenCalled();
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toBe("a turn is already running");
  });

  it("respects a goal that has switched the cancel off", async () => {
    const off = view();
    off.goal.deadTurnMinutes = 0;
    seed(off, { idle: false });
    const session = useStore.getState().sessions[SESSION]!;
    useStore.setState({ sessions: { [SESSION]: { ...session, lastEventAt: Date.now() - 5 * 3_600_000 } } });

    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionCancel).not.toHaveBeenCalled();
  });

  it("does not cancel for any other reason the runner cannot act", async () => {
    // Detached, not mid-turn: cancelling would be the wrong answer.
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.attachment = "detached";
    session.projection.foreground = "running";
    useStore.setState({ sessions: { [SESSION]: { ...session, lastEventAt: Date.now() - 80 * 60_000 } } });

    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionCancel).not.toHaveBeenCalled();
  });
});

/**
 * The spin this prevents: eight continuations in eighteen seconds, none of
 * which settled, until the no-progress guard stopped it. Every one was a
 * prompt the account paid for.
 */
describe("prompting no faster than the cooldown", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
  });

  it("submits once and then holds, however many times it is ticked", async () => {
    const current = view();
    seed(current);
    // The record after the first submit, as the next tick would read it.
    api.odysseyView.mockResolvedValue({
      ...current,
      journal: [{ id: "c1", odysseyId: "o1", at: Date.now(), kind: "continuation", summary: "Continued milestone 2 of 2" }, ...current.journal],
    } as never);

    await useStore.getState().odysseyTick(SESSION);
    for (let round = 0; round < 5; round += 1) await useStore.getState().odysseyTick(SESSION);

    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toContain("cooldown");
  });

  it("holds on a record whose last prompt never settled", async () => {
    // The case from the spin: the counter never advanced because nothing
    // settled, so only the journal's timestamp could stop it.
    const current = view();
    seed({ ...current, journal: [{ id: "c1", odysseyId: "o1", at: Date.now() - 1_000, kind: "continuation", summary: "Continued milestone 2 of 2" }, ...current.journal] });

    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });
});

/** An agent message card, as the projection would hold it. */
function agentCard(key: string, text: string) {
  return { kind: "message", key, message: { key, role: "agent", messageId: key, blocks: [{ type: "text", text }], contentUnknown: false } } as never;
}

describe("turns the model never saw", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("remembers what it read at submit, so the settle can tell an answered turn from a dead one", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    expect(useStore.getState().odysseyPendingTurn[SESSION]).toMatchObject({ kind: "continue", tokensAtSubmit: 5_500, agentMessagesAtSubmit: 0 });
  });

  it("does not charge a prompt that no model answered, and says why in the record", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    // Nothing moved in the transcript between submit and settle.
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordContinuation).not.toHaveBeenCalled();
    const guard = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "guard");
    expect(guard?.summary).toBe(PROMPT_UNANSWERED);
    // An unanswered prompt is not a stop: the run went round again.
    expect(api.sessionSubmit).toHaveBeenCalledTimes(2);
  });

  it("charges a turn the model answered, once", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(6_000, 800) } as never);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordContinuation).toHaveBeenCalledTimes(1);
    // 6,800 now, 1,000 at the start, 100 already charged.
    expect(api.odysseyRecordContinuation).toHaveBeenCalledWith("o1", 5_700);
    expect(api.odysseyJournalAppend.mock.calls.map(([request]) => request.summary)).not.toContain(PROMPT_UNANSWERED);
  });

  it("keeps running when the transport closed under the turn", async () => {
    seed(view());
    await useStore.getState().odysseyOnSettle(SESSION, "failed", 'Incoming transport closed: {"reason":"incoming_transport_closed"}');

    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    const guard = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "guard");
    expect(guard?.summary.startsWith(TRANSPORT_CLOSED)).toBe(true);
  });

  it("does not block when a restarting session refuses the prompt", async () => {
    api.sessionSubmit.mockResolvedValueOnce({ outcome: { outcome: "rejected", error: { code: "IO", message: "Kit rejected the request: Internal error: unsupported operation" } } } as never);
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    const guard = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "guard");
    expect(guard?.summary.startsWith(TRANSPORT_CLOSED)).toBe(true);
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toContain("restarting");
  });
});

describe("reading the report from the turn that produced it", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("ignores a report line written before this turn", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("old", "SUPERTHING-REPORT: milestone=2 status=complete note=screens built"));
    await useStore.getState().odysseyTick(SESSION);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(6_000, 800) } as never);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordReport).not.toHaveBeenCalled();
  });

  it("reads a report written during this turn", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("old", "SUPERTHING-REPORT: milestone=1 status=complete note=earlier"));
    await useStore.getState().odysseyTick(SESSION);
    session.projection.cards.push(agentCard("new", "done\nODYSSEY-REPORT: milestone=2 status=complete note=screens built"));
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(6_000, 800) } as never);
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordReport).toHaveBeenCalledWith("m2", "screens built");
  });

  it("does not journal the same claim twice since the last prompt", async () => {
    const current = view();
    current.journal = [
      { id: "r1", odysseyId: "o1", at: 3, kind: "report", milestoneId: "m2", summary: "Reported milestone 2 complete", detail: "screens built" },
      { id: "c1", odysseyId: "o1", at: 2, kind: "continuation", milestoneId: "m2", summary: "Continued milestone 2 of 2" },
      ...current.journal,
    ];
    seed(current);
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "SUPERTHING-REPORT: milestone=2 status=complete note=screens built"));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyRecordReport).not.toHaveBeenCalled();
    expect(api.odysseyJournalAppend.mock.calls.map(([request]) => request.kind)).not.toContain("report");
  });
});

describe("what a turn is told and what it leaves behind", () => {
  const flush = async () => {
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
    api.odysseyWorkspaceNotes.mockResolvedValue({ agentNotes: [] } as never);
  });

  it("writes a per-turn checkpoint: what changed, behind a fingerprint of the tree", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseyCheckpoint).toHaveBeenCalledWith("w1", "o1");
    const row = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.kind === "checkpoint");
    expect(row?.summary).toBe("1 file changed · +10 −1");
    expect(row?.detail?.split("\n")).toEqual(["t1|verifiedactive|", "a.ts"]);
  });

  it("tells the model where its handoff note is, and which subagent notes are new", async () => {
    const now = Date.now();
    api.odysseyWorkspaceNotes.mockResolvedValue({
      state: { path: "docs/super-thing/STATE.md", bytes: 10, modifiedAtUnixMs: now - 2 * 60_000 },
      agentNotes: [{ path: "docs/super-thing/agents/economy.md", bytes: 5, modifiedAtUnixMs: now }],
    } as never);
    seed(view());
    await useStore.getState().odysseyTick(SESSION);

    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("Handoff note: `docs/super-thing/STATE.md` (updated 2m ago)");
    expect(text).toContain("Subagent notes written since your last turn: `docs/super-thing/agents/economy.md`");
    expect(useStore.getState().odysseyNotes[SESSION]?.state?.path).toBe("docs/super-thing/STATE.md");
  });

  it("asks for the handoff note to be created when there is none", async () => {
    seed(view());
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).toContain("does not exist yet — create it this turn");
  });

  it("keeps a usage reading, with the transcript's counters, for each running goal", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(20, 1_700_000_000), secondary: window(10) })));
    seed(view());
    await useStore.getState().refreshUsage("codex");
    await flush();

    expect(api.odysseyUsageSampleAdd).toHaveBeenCalledWith(
      expect.objectContaining({ odysseyId: "o1", primaryUsedPercent: 20, primaryResetAt: 1_700_000_000, secondaryUsedPercent: 10, calls: 3, paidInputTokens: 5_000, cachedInputTokens: 40_000, outputTokens: 500, reasoningTokens: 100 }),
    );
  });

  it("takes no reading for a goal that is not running or parked", async () => {
    api.providerQuota.mockResolvedValue(quota(usage({ primary: window(20) })));
    seed(view({ state: "paused" }));
    await useStore.getState().refreshUsage("codex");
    await flush();
    expect(api.odysseyUsageSampleAdd).not.toHaveBeenCalled();
  });

  it("warns that stopping the session kills the subagents still working", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    const agent: AgentNode = {
      id: "a1",
      name: "economy",
      status: "working",
      outcome: null,
      generation: 1,
      task: "Implement the market",
      parentId: null,
      parentName: null,
      harness: "acp.claude",
      model: "sonnet",
      createdAtUnixMs: 0,
      generationStartedAtUnixMs: 0,
      generationFinishedAtUnixMs: null,
      updatedSequence: "1",
    };
    session.projection.inspector.agents.set(agent.id, agent);
    api.confirmDialog.mockResolvedValue(false as never);

    await useStore.getState().stop(SESSION);

    expect(api.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("1 subagent is still working and will be killed with it") }));
    expect(api.sessionStop).not.toHaveBeenCalled();
  });
});

describe("tasks inside milestones", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
    api.odysseyAddStep.mockImplementation(async (_milestoneId: string, title: string) => ({ id: `step-${title}`, title }));
  });

  const withTasks = () => {
    const current = view();
    current.milestones[1]!.steps = [
      { id: "t1", milestoneId: "m2", position: 0, title: "Model", state: "done", note: "", detail: "", dependsOn: [] },
      { id: "t2", milestoneId: "m2", position: 1, title: "Pricing", state: "pending", note: "", detail: "", dependsOn: ["t1"] },
    ];
    return current;
  };

  it("records the agent's task moves from its lines, and who it named", async () => {
    seed(withTasks());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "Working.\nODYSSEY-TASK: milestone=2 task=2 status=in_progress agent=2.2-pricing\nODYSSEY-TASK: milestone=2 task=9 status=done"));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseySetStepState).toHaveBeenCalledWith("t2", "in_progress", undefined);
    expect(api.odysseyAssignStep).toHaveBeenCalledWith("t2", "2.2-pricing", null, null);
    // A number the record does not have is ignored.
    expect(api.odysseySetStepState).toHaveBeenCalledTimes(1);
  });

  it("ties a working subagent named after a task to that task, with the model it saw", async () => {
    seed(withTasks());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.inspector.agents.set("a1", {
      id: "a1",
      name: "2.2-pricing",
      status: "working",
      outcome: null,
      generation: 1,
      task: "Implement pricing",
      parentId: null,
      parentName: null,
      harness: "acp.claude",
      model: "sonnet",
      createdAtUnixMs: 0,
      generationStartedAtUnixMs: 0,
      generationFinishedAtUnixMs: null,
      updatedSequence: "1",
    });
    await useStore.getState().odysseyObserveAgents(SESSION);

    expect(api.odysseyAssignStep).toHaveBeenCalledWith("t2", "2.2-pricing", "acp.claude", "sonnet");
    expect(api.odysseySetStepState).toHaveBeenCalledWith("t2", "in_progress");
    // The same observation twice writes nothing new.
    api.odysseyAssignStep.mockClear();
    await useStore.getState().odysseyObserveAgents(SESSION);
    expect(api.odysseyAssignStep).not.toHaveBeenCalled();
  });

  it("does not finish a task because its subagent finished: done is the agent's report", async () => {
    seed(withTasks());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.inspector.agents.set("a1", {
      id: "a1",
      name: "2.2-pricing",
      status: "idle",
      outcome: "success",
      generation: 1,
      task: "",
      parentId: null,
      parentName: null,
      harness: "acp.claude",
      model: "sonnet",
      createdAtUnixMs: 0,
      generationStartedAtUnixMs: 0,
      generationFinishedAtUnixMs: 1,
      updatedSequence: "2",
    });
    await useStore.getState().odysseyObserveAgents(SESSION);
    expect(api.odysseySetStepState).not.toHaveBeenCalled();
    expect(api.odysseyAssignStep).toHaveBeenCalledWith("t2", "2.2-pricing", "acp.claude", "sonnet");
  });

  it("appends tasks named in a revise after the milestone's own, numbering those first", async () => {
    seed(withTasks());
    await useStore.getState().odysseyApplyAmendment(SESSION, "SUPERTHING-AMEND\nrevise: 2\nstep: Validation\ndepends: 1, 2\nEND-SUPERTHING-AMEND");

    expect(api.odysseyAddStep).toHaveBeenCalledWith("m2", "Validation");
    expect(api.odysseyEditStep).toHaveBeenCalledWith("step-Validation", { dependsOn: ["t1", "t2"] });
  });

  it("asks the agent for tasks through the amendment lane", async () => {
    seed(view());
    await useStore.getState().odysseyRequestTasks(SESSION, 1);
    expect(api.odysseyAmendAdd).toHaveBeenCalledWith(expect.objectContaining({ odysseyId: "o1", note: expect.stringContaining('Break milestone 2 ("Build screens") into three to eight tasks') }));
  });
});

describe("replanning as a diff the user decides on", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
    api.odysseyAddStep.mockImplementation(async (_milestoneId: string, title: string) => ({ id: `step-${title}`, title }));
  });

  const reviewed = () => {
    const current = view();
    current.goal.onPlanChange = "review";
    current.milestones[1]!.steps = [
      { id: "t1", milestoneId: "m2", position: 0, title: "Model", state: "done", note: "", detail: "", dependsOn: [] },
      { id: "t2", milestoneId: "m2", position: 1, title: "Pricing", state: "pending", note: "", detail: "", dependsOn: ["t1"] },
      { id: "t3", milestoneId: "m2", position: 2, title: "Validation", state: "pending", note: "", detail: "", dependsOn: ["t2"] },
    ];
    return current;
  };

  it("holds the agent's block as a proposal, shows the diff, and tells the agent to work to the current plan", async () => {
    seed(reviewed());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "SUPERTHING-AMEND\nsplit_task: 2.2\nstep: Price model\nstep: Slippage\nreason: two owners\nEND-SUPERTHING-AMEND"));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseyAddStep).not.toHaveBeenCalled();
    expect(api.odysseyPlanChangeAdd).toHaveBeenCalledWith(expect.objectContaining({ state: "proposed", reason: "two owners", summary: expect.stringContaining('⇄ Split task 2.2 "Pricing" into 2: Price model, Slippage') }));
    const text = api.sessionSubmit.mock.calls.at(-1)?.[2] as string;
    expect(text).toContain("Your plan change is waiting for the user's decision");
  });

  it("applies a held change from the inbox, resolving it against the plan as it is now", async () => {
    const current = reviewed();
    seed(current);
    useStore.setState({
      odysseyPlanChanges: {
        [SESSION]: [
          {
            id: "pc1",
            odysseyId: "o1",
            at: 5,
            ops: JSON.stringify([{ op: "split_task", ref: { milestone: 2, task: 2 }, steps: [{ title: "Price model", depends: [] }, { title: "Slippage", depends: [] }], reason: "two owners" }]),
            summary: "⇄ Split task 2.2",
            state: "proposed",
          },
        ],
      },
    });
    await useStore.getState().odysseyDecidePlanChange(SESSION, "pc1", "apply");

    expect(api.odysseyPlanChangeDecide).toHaveBeenCalledWith("pc1", "applied", null);
    expect(api.odysseyAddStep.mock.calls.map(([, title]) => title)).toEqual(["Price model", "Slippage"]);
    // The pieces inherit what the whole waited on; what waited on the whole now waits on the last piece.
    expect(api.odysseyEditStep).toHaveBeenCalledWith("step-Price model", { dependsOn: ["t1"] });
    expect(api.odysseyEditStep).toHaveBeenCalledWith("t3", { dependsOn: ["step-Slippage"] });
    expect(api.odysseyReorderSteps).toHaveBeenCalledWith("m2", ["t1", "step-Price model", "step-Slippage", "t3"]);
    expect(api.odysseyDeleteStep).toHaveBeenCalledWith("t2");
  });

  it("carries a rejection and its note back to the agent", async () => {
    seed(reviewed());
    useStore.setState({ odysseyPlanChanges: { [SESSION]: [{ id: "pc1", odysseyId: "o1", at: 5, ops: "[]", summary: "− Drop task 2.3", state: "proposed" }] } });
    await useStore.getState().odysseyDecidePlanChange(SESSION, "pc1", "reject", "validation stays");
    expect(api.odysseyPlanChangeDecide).toHaveBeenCalledWith("pc1", "rejected", "validation stays");
    expect(api.odysseyDeleteStep).not.toHaveBeenCalled();
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit.mock.calls.at(-1)?.[2] as string).toContain("The user rejected your plan change (− Drop task 2.3): validation stays");
  });

  it("drops a task and re-points what waited on it, and moves a task", async () => {
    const current = reviewed();
    current.goal.onPlanChange = "auto";
    seed(current);
    await useStore.getState().odysseyApplyAmendment(SESSION, "SUPERTHING-AMEND\ndrop_task: 2.2\nreason: folded into 2.1\nmove_task: 2.3\nafter: start\nEND-SUPERTHING-AMEND");
    expect(api.odysseyEditStep).toHaveBeenCalledWith("t3", { dependsOn: ["t1"] });
    expect(api.odysseyDeleteStep).toHaveBeenCalledWith("t2");
    expect(api.odysseyReorderSteps).toHaveBeenCalledWith("m2", ["t3", "t1", "t2"]);
  });

  it("records a question the agent hands over and tells it the answer later", async () => {
    seed(reviewed());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "Working.\nODYSSEY-ASK: kind=architecture default=continuing with plain classes options=ECS | classes question=Move the economy to ECS before milestone 3?"));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseyQuestionAdd).toHaveBeenCalledWith({ odysseyId: "o1", kind: "architecture", question: "Move the economy to ECS before milestone 3?", options: ["ECS", "classes"], fallback: "continuing with plain classes" });
    // The run did not stop for it.
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");

    useStore.setState({ odysseyQuestions: { [SESSION]: [{ id: "q1", odysseyId: "o1", at: 1, kind: "architecture", question: "Move the economy to ECS before milestone 3?", options: ["ECS", "classes"], state: "open" }] } });
    api.sessionSubmit.mockClear();
    await useStore.getState().odysseyAnswerQuestion(SESSION, "q1", "classes");
    expect(api.odysseyQuestionSettle).toHaveBeenCalledWith("q1", "answered", "classes");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = api.sessionSubmit.mock.calls.at(-1)?.[2] as string;
    expect(text).toContain('You asked "Move the economy to ECS before milestone 3?". The user answered: classes');
  });
});

describe("the default: tasks are the agent's, milestones are the user's", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
    api.odysseyAddStep.mockImplementation(async (_milestoneId: string, title: string) => ({ id: `step-${title}`, title }));
  });

  it("lands task changes at once and holds only the milestone-level part of the same block", async () => {
    const current = view();
    current.goal.onPlanChange = "tasks_auto";
    seed(current);
    await useStore.getState().odysseyApplyAmendment(SESSION, "SUPERTHING-AMEND\nrevise: 2\nstep: Pricing\nstep: Validation\ndepends: 1\nadd: Risk layer\nafter: 2\nEND-SUPERTHING-AMEND");

    // The tasks exist now; the new milestone waits in the inbox.
    expect(api.odysseyAddStep.mock.calls.map(([, title]) => title)).toEqual(["Pricing", "Validation"]);
    expect(api.odysseyAddMilestone).not.toHaveBeenCalled();
    const states = api.odysseyPlanChangeAdd.mock.calls.map(([request]) => request.state);
    expect(states).toEqual(["applied", "proposed"]);
    expect(api.odysseyPlanChangeAdd.mock.calls[1]?.[0].summary).toContain('+ Add milestone "Risk layer" after milestone 2');
  });

  it("treats retitling a milestone or changing its check as the user's decision", async () => {
    const current = view();
    current.goal.onPlanChange = "tasks_auto";
    seed(current);
    await useStore.getState().odysseyApplyAmendment(SESSION, "SUPERTHING-AMEND\nrevise: 2\ntitle: Screens and flows\nEND-SUPERTHING-AMEND");
    expect(api.odysseyEditMilestone).not.toHaveBeenCalled();
    expect(api.odysseyPlanChangeAdd).toHaveBeenCalledWith(expect.objectContaining({ state: "proposed" }));
  });
});

describe("a blocked report about a quota is a wait, not a block", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("keeps the goal running, leaves the milestone alone, and holds the next prompt", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "SUPERTHING-REPORT: milestone=2 status=blocked note=Awaiting the delegate quota reset at 00:40; nothing changed."));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");

    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    expect(api.odysseySetMilestoneState).not.toHaveBeenCalledWith("m2", "failed");
    const hold = api.odysseyJournalAppend.mock.calls.map(([request]) => request).find((request) => request.summary?.startsWith(QUOTA_WAIT_HOLD));
    expect(hold?.detail).toMatch(/^until=\d+/);
    // The settle's own tick did not prompt again: the hold is in the record it reads.
    api.odysseyView.mockResolvedValue({ ...view(), journal: [{ id: "h", odysseyId: "o1", at: Date.now(), kind: "guard", summary: hold!.summary, detail: hold!.detail }, ...view().journal] } as never);
    api.sessionSubmit.mockClear();
    await useStore.getState().refreshOdyssey(SESSION, "o1");
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit).not.toHaveBeenCalled();
    expect(useStore.getState().odysseyRuntime[SESSION]?.lastReason).toContain("waiting for its delegates' quota");
  });

  it("still blocks on a reason that is not a wait", async () => {
    seed(view());
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.cards.push(agentCard("m", "SUPERTHING-REPORT: milestone=2 status=blocked note=the staging credentials are missing"));
    await useStore.getState().odysseyOnSettle(SESSION, "succeeded");
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
  });
});

describe("a note rides the prompt without asking for a plan change", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("carries the note as a note and leaves out the fold-it-in instruction", async () => {
    seed(view());
    useStore.setState({ odysseyAmendments: { [SESSION]: [{ id: "n1", odysseyId: "o1", at: 1, note: "Prefer acp.kit today.", refs: [], state: "pending", tellCount: 0, kind: "note" }] } });
    await useStore.getState().odysseyTick(SESSION);
    const text = api.sessionSubmit.mock.calls[0]?.[2] as string;
    expect(text).toContain("- A note from the user: Prefer acp.kit today.");
    expect(text).not.toContain("Fold the above into the plan");
    expect(api.odysseyAmendMarkTold).toHaveBeenCalledWith("n1", 2);
  });

  it("keeps the instruction when a change rides alongside a note", async () => {
    seed(view());
    useStore.setState({
      odysseyAmendments: {
        [SESSION]: [
          { id: "n1", odysseyId: "o1", at: 1, note: "Prefer acp.kit today.", refs: [], state: "pending", tellCount: 0, kind: "note" },
          { id: "c1", odysseyId: "o1", at: 2, note: "Add a ships milestone.", refs: [], state: "pending", tellCount: 0 },
        ],
      },
    });
    await useStore.getState().odysseyTick(SESSION);
    expect(api.sessionSubmit.mock.calls[0]?.[2] as string).toContain("Fold the above into the plan");
  });
});

/**
 * Moving a run between sessions (docs/plans/odyssey-second-orchestrator.md
 * §2.3, §2.5). The record moves and the conversation does not, so what these
 * assert is that the new session is told the goal from scratch and the old one
 * is never prompted again.
 */
describe("re-pointing a goal at another session", () => {
  const OTHER = "sess-2";

  function seedPair(current: OdysseyView, agent: "codex" | "claude" = "codex") {
    seed(current);
    const handle = { id: OTHER, attachmentGeneration: "1" };
    const projection = emptyProjection();
    projection.attachment = "attached";
    projection.process = "ready";
    projection.foreground = "idle";
    const second: LiveSession = {
      handle,
      workspaceId: "w1",
      snapshot: { handle, agentSessionId: "kw-2", provider: agent } as unknown as Snapshot,
      projection,
      inFlightRequestId: null,
      steerInFlight: false,
      attention: "none",
      openedAt: 0,
      turnStartedAt: null,
      lastEventAt: null,
      usage: EMPTY_SESSION_USAGE,
    };
    useStore.setState({ sessions: { ...useStore.getState().sessions, [OTHER]: second } });
  }

  /** The view the record returns after a move: same goal, new session, with the move on top. */
  function movedView(from: OdysseyView, agent: "codex" | "claude" = "codex"): OdysseyView {
    return {
      ...from,
      goal: { ...from.goal, sessionId: "kw-2" },
      // Written now, as the storage writes it: the failover cooldown is read
      // off this row, so a move stamped at the epoch would let the next tick
      // move again immediately.
      journal: [{ id: "mv", odysseyId: "o1", at: Date.now(), kind: "state", summary: `Moved to session s-2 (${agent})` }, ...from.journal],
    };
  }

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
    api.confirmDialog.mockResolvedValue(true as never);
  });

  it("briefs the session it moved to, once, and never prompts the old one again", async () => {
    const before = view();
    seedPair(before);
    const after = movedView(before);
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);

    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });

    expect(api.odysseyRepoint).toHaveBeenCalledWith("o1", "w1", "kw-2", "codex");
    // Exactly one prompt, to the new session, and it is a briefing rather
    // than a continuation: that model has never heard of this goal.
    expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
    const [handle, , text] = api.sessionSubmit.mock.calls[0] as [{ id: string }, string, string];
    expect(handle.id).toBe(OTHER);
    expect(text).toContain("You are working under Super Thing");
    expect(text).toContain("picked up a run another session started");
    // The old session no longer holds the goal, so nothing can tick it.
    expect(useStore.getState().odyssey[SESSION]).toBeNull();
  });

  it("carries the deltas across and drops the turn it cancelled", async () => {
    const before = view();
    seedPair(before);
    const after = movedView(before);
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);
    useStore.setState({
      // Something the next continuation still has to say — it belongs to the
      // goal, not to whichever session was holding it.
      odysseyPendingDeltas: { [SESSION]: [{ kind: "verified", milestone: 1, title: "Audit flow", evidence: "`pnpm test` exited 0" }] },
      // This belongs to the turn that is about to be cancelled, and does not.
      odysseyPendingTurn: { [SESSION]: { kind: "continue", submittedAt: 1, tokensAtSubmit: 1, agentMessagesAtSubmit: 0 } },
    });

    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });

    expect(useStore.getState().odysseyPendingDeltas[SESSION]).toBeUndefined();
    expect(useStore.getState().odysseyPendingDeltas[OTHER]).toHaveLength(1);
    expect(useStore.getState().odysseyPendingTurn[SESSION]).toBeUndefined();
  });

  it("cancels the running turn first, so two orchestrators never hold the tree", async () => {
    const before = view();
    seedPair(before);
    const running = useStore.getState().sessions[SESSION]!;
    running.projection.foreground = "running";
    useStore.setState({ sessions: { ...useStore.getState().sessions, [SESSION]: running } });
    const after = movedView(before);
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);

    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });
    expect(api.sessionCancel).toHaveBeenCalled();
  });

  it("a move you make by hand says which account the run spends from now on", async () => {
    // Observed on the live goal: every pre-migration goal is pinned to `kit`
    // by the column's default, so a manual move to Claude was dragged back a
    // second later. Moving it by hand is the user saying where it belongs.
    const before = view();
    seedPair(before, "claude");
    const after = movedView(before, "claude");
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);

    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });

    expect(api.odysseyEditGoal).toHaveBeenCalledWith("o1", { orchestrator: "claude" });
  });

  it("leaves an `either` goal's setting alone, because that already says 'you decide'", async () => {
    const before: OdysseyView = { ...view(), goal: { ...view().goal, orchestrator: "either" } };
    seedPair(before, "claude");
    const after = { ...movedView(before, "claude"), goal: { ...before.goal, sessionId: "kw-2" } };
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);

    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });

    expect(api.odysseyEditGoal).not.toHaveBeenCalled();
  });

  it("does not re-pin on an automatic failover, which is not the user speaking", async () => {
    const parked: OdysseyView = { ...view(), goal: { ...view().goal, orchestrator: "either" } };
    seedPair(parked, "claude");
    const after = movedView(parked, "claude");
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);
    useStore.setState({ usage: { codex: usage({ primary: window(99, 2_000), limitReached: true, allowed: false }), claude: null } });
    useStore.setState({ openSessionFor: vi.fn(async () => ({ key: OTHER, agentSessionId: "kw-2" })) as never });

    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseyEditGoal).not.toHaveBeenCalled();
  });

  it("does nothing at all when the user says no", async () => {
    seedPair(view());
    api.confirmDialog.mockResolvedValue(false as never);
    await useStore.getState().odysseyMoveTo(SESSION, { kind: "session", sessionId: OTHER });
    expect(api.odysseyRepoint).not.toHaveBeenCalled();
    expect(api.sessionSubmit).not.toHaveBeenCalled();
  });

  it("moves a parked `either` goal to the account that has room, without asking", async () => {
    // The lever: 62% of the first real run's wall clock was spent parked on
    // one account with a second subscription sitting idle.
    const parked: OdysseyView = { ...view(), goal: { ...view().goal, orchestrator: "either" } };
    seedPair(parked, "claude");
    const after = movedView(parked, "claude");
    api.odysseyRepoint.mockResolvedValue(after as never);
    api.odysseyForSession.mockResolvedValue(after as never);
    api.odysseyView.mockResolvedValue(after as never);
    // Codex is spent; nothing says the Claude account is.
    useStore.setState({ usage: { codex: usage({ primary: window(99, 2_000), limitReached: true, allowed: false }), claude: null } });
    const opened = vi.fn(async () => ({ key: OTHER, agentSessionId: "kw-2" }));
    useStore.setState({ openSessionFor: opened as never });

    await useStore.getState().odysseyTick(SESSION);

    expect(opened).toHaveBeenCalledWith("w1", "claude");
    expect(api.odysseyRepoint).toHaveBeenCalledWith("o1", "w1", "kw-2", "claude");
    // Automatic: nobody is at the keyboard at 3am, and the move is journalled
    // instead so the history says why the account changed.
    expect(api.confirmDialog).not.toHaveBeenCalled();
    const moves = api.odysseyJournalAppend.mock.calls.map(([request]) => request as { summary: string }).filter((request) => request.summary.startsWith("Moving to Claude"));
    expect(moves).toHaveLength(1);
  });

  it("parks rather than moving when both accounts are spent", async () => {
    const parked: OdysseyView = { ...view(), goal: { ...view().goal, orchestrator: "either" } };
    seedPair(parked);
    useStore.setState({
      usage: {
        codex: usage({ primary: window(99, 2_000), limitReached: true, allowed: false }),
        claude: usage({ primary: window(100, 3_000), limitReached: true, allowed: false }),
      },
    });
    const opened = vi.fn();
    useStore.setState({ openSessionFor: opened as never });

    await useStore.getState().odysseyTick(SESSION);

    expect(opened).not.toHaveBeenCalled();
    expect(api.odysseyRepoint).not.toHaveBeenCalled();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "waiting_usage");
  });
});

describe("what a refused prompt means", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("parks on a quota refusal rather than blocking the run", async () => {
    // Kit accepts the prompt and the turn fails afterwards, so the quota path
    // was only ever wired into the settle. The Claude adapter refuses the
    // submit outright, which blocked a goal that had merely run out of window
    // and left it needing a human for a condition with a reset time on it.
    // Pinned to Claude and running on Claude, so nothing tries to move it
    // and the submit is what the tick actually does.
    seed({ ...view(), goal: { ...view().goal, orchestrator: "claude" } });
    useStore.setState({ sessions: { ...useStore.getState().sessions, [SESSION]: { ...useStore.getState().sessions[SESSION]!, snapshot: { handle: { id: SESSION, attachmentGeneration: "1" }, agentSessionId: "cc-1", provider: "claude" } as unknown as Snapshot } } });
    api.sessionSubmit.mockResolvedValue({
      outcome: { outcome: "rejected", error: { code: "PROTOCOL", message: "The agent rejected the request: Internal error: You've hit your session limit · resets 3:40pm (Europe/Madrid)" } },
    } as never);

    await useStore.getState().odysseyTick(SESSION);

    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "waiting_usage");
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "blocked");
    const wait = api.odysseyJournalAppend.mock.calls.map(([r]) => r as { kind: string; detail?: string }).find((r) => r.kind === "wait");
    expect(wait?.detail).toContain("resume at");
    // And the account is remembered, so the poll knows what it is waiting on.
    expect(useStore.getState().usage.claude?.limitReached).toBe(true);
  });

  it("still blocks a refusal that is not about quota", async () => {
    seed(view());
    api.sessionSubmit.mockResolvedValue({ outcome: { outcome: "rejected", error: { code: "IO", message: "the model does not exist" } } } as never);
    await useStore.getState().odysseyTick(SESSION);
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "blocked");
  });
});

describe("a Claude run parked on its window", () => {
  const at = Math.floor((Date.now() + 40 * 60_000) / 1000);
  const spentClaude = usage({ allowed: false, limitReached: true, primary: { usedPercent: 100, windowSeconds: 5 * 3600, resetAtUnix: at } });

  function claudeSession() {
    useStore.setState({
      sessions: {
        ...useStore.getState().sessions,
        [SESSION]: { ...useStore.getState().sessions[SESSION]!, snapshot: { handle: { id: SESSION, attachmentGeneration: "1" }, agentSessionId: "cc-1", provider: "claude" } as unknown as Snapshot },
      },
    });
  }

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    api.sessionTokenUsage.mockResolvedValue({ totals: TOTALS(5_000, 500) } as never);
  });

  it("holds a fresh refusal, so the countdown does not flicker", async () => {
    // The catalog probe cannot see a spent account — session/new succeeds and
    // the models come back while every prompt is refused. Asking it here
    // cleared the limit a second after it was recorded and wiped the
    // countdown off the screen.
    const fresh = { ...spentClaude, fetchedAtUnixMs: Date.now() };
    seed({ ...view({ state: "waiting_usage" }), goal: { ...view().goal, state: "waiting_usage", orchestrator: "claude", onUsageReset: "continue_automatically" } });
    claudeSession();
    useStore.setState({ usage: { ...useStore.getState().usage, claude: fresh } });

    await useStore.getState().odysseyPoll();

    expect(api.odysseyClaudePreflight).not.toHaveBeenCalled();
    expect(useStore.getState().usage.claude).toBe(fresh);
    expect(api.odysseySetState).not.toHaveBeenCalledWith("o1", "running");
  });

  it("tries again after a few minutes rather than trusting the reset it was given", async () => {
    // The reset time is a claim. One was recorded here against the wrong
    // account entirely and would have parked a working run for three hours,
    // so a refusal buys minutes, not the window it names. A refused prompt
    // costs nothing, which is what makes retrying the cheap option.
    const stale = { ...spentClaude, fetchedAtUnixMs: Date.now() - CLAUDE_RETRY_MS - 1 };
    seed({ ...view({ state: "waiting_usage" }), goal: { ...view().goal, state: "waiting_usage", orchestrator: "claude", onUsageReset: "continue_automatically" } });
    claudeSession();
    useStore.setState({ usage: { ...useStore.getState().usage, claude: stale } });

    await useStore.getState().odysseyPoll();

    // Still well before the reset it named, and it goes anyway.
    expect(stale.primary!.resetAtUnix! * 1000).toBeGreaterThan(Date.now());
    expect(useStore.getState().usage.claude).toBeNull();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
  });

  it("lets Resume override a recorded refusal at once", async () => {
    // Pressing Resume is the user saying "try it now", and on this account
    // that is the only way to find out — nothing there reports headroom.
    seed({ ...view(), goal: { ...view().goal, state: "blocked", orchestrator: "claude" } });
    claudeSession();
    useStore.setState({ usage: { ...useStore.getState().usage, claude: { ...spentClaude, fetchedAtUnixMs: Date.now() } } });

    await useStore.getState().odysseyStart(SESSION);

    expect(useStore.getState().usage.claude).toBeNull();
  });

  it("continues by itself once the window has passed", async () => {
    const past = Math.floor((Date.now() - 60 * 60_000) / 1000);
    seed({ ...view({ state: "waiting_usage" }), goal: { ...view().goal, state: "waiting_usage", orchestrator: "claude", onUsageReset: "continue_automatically" } });
    claudeSession();
    useStore.setState({ usage: { ...useStore.getState().usage, claude: usage({ allowed: false, limitReached: true, primary: { usedPercent: 100, windowSeconds: 5 * 3600, resetAtUnix: past } }) } });

    await useStore.getState().odysseyPoll();

    // The limit is dropped once its own reset has passed, and for this
    // account that is the only signal there will ever be.
    expect(useStore.getState().usage.claude).toBeNull();
    expect(api.odysseySetState).toHaveBeenCalledWith("o1", "running");
  });
});
