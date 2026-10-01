/**
 * O2's gate: the Super Thing screen renders a seeded goal, and the states the plan
 * says must look different actually do.
 *
 * The screen is a view of the record, so this test seeds the store the way the
 * command would and asserts what a reader would see — in particular that a
 * milestone the model merely claimed is labelled as a claim.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneRecord, OdysseyView, Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { EMPTY_SESSION_USAGE, PLAN_REQUESTED, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { OdysseyPane } from "./components/OdysseyPane";

const SESSION = "sess-1";

function milestone(overrides: Partial<MilestoneRecord> & { id: string; title: string; position: number }): MilestoneRecord {
  return { odysseyId: "o1", detail: "", state: "planned", checkKind: "manual", steps: [], ...overrides };
}

const view: OdysseyView = {
  goal: {
    id: "o1",
    workspaceId: "w1",
    sessionId: "kw-1",
    title: "Ship onboarding v2",
    brief: "Design and implement a new user onboarding experience.",
    state: "running",
    stopCondition: "goal_complete",
    onUsageReset: "continue_automatically",
    onReport: "continue",
    onPlanChange: "review",
    orchestrator: "codex",
    deadTurnMinutes: 30,
    maxContinuations: 50,
    continuationsUsed: 12,
    tokenBudget: 200_000,
    tokensUsed: 84_200,
    createdAt: 1,
    updatedAt: 2,
  },
  milestones: [
    milestone({ id: "m1", title: "Audit existing flow", position: 0, state: "verified", checkSource: "user", checkOutput: "ticked by you" }),
    milestone({
      id: "m2",
      title: "Define acceptance tests",
      position: 1,
      state: "verified",
      checkKind: "tests_pass",
      checkSpec: "pnpm test",
      checkSource: "desktop",
      checkOutput: "Tests 63 passed (63)",
    }),
    milestone({
      id: "m3",
      title: "Build onboarding screens",
      position: 2,
      state: "active",
      checkKind: "tests_pass",
      checkSpec: "pnpm test",
      steps: [
        { id: "s1", milestoneId: "m3", position: 0, title: "Set up components", state: "done", note: "", detail: "", dependsOn: [] },
        { id: "s2", milestoneId: "m3", position: 1, title: "Implement screens", state: "in_progress", note: "paused for usage", detail: "", dependsOn: [] },
      ],
    }),
    milestone({ id: "m4", title: "Verify accessibility", position: 3, state: "reported", checkKind: "command", checkSpec: "pnpm run a11y", reportedNote: "audited every screen" }),
    milestone({ id: "m5", title: "Review and handoff", position: 4 }),
  ],
  journal: [{ id: "j1", odysseyId: "o1", at: 1_700_000_000_000, kind: "wait", summary: "Checkpoint saved before usage reset" }],
};

function seed(odyssey: OdysseyView | null | undefined, options: { agent?: "codex" | "claude" } = {}) {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const snapshot = { handle, agentSessionId: "kw-1", provider: options.agent ?? "codex", process: "ready", attachment: "attached", foreground: "idle" } as unknown as Snapshot;
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot,
    projection: emptyProjection(),
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { [SESSION]: session }, odyssey: odyssey === undefined ? {} : { [SESSION]: odyssey } });
}

/** The rail became tabs: what used to be always on screen is one click away. */
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const openDetails = () => fireEvent.click(screen.getByRole("button", { name: "details" }));

describe("the Super Thing screen", () => {
  beforeEach(() => {
    useStore.setState({ sessions: {}, odyssey: {}, odysseyQuestions: {}, odysseyPlanChanges: {}, odysseyAmendments: {}, odysseyNotes: {}, error: null });
  });

  // This project does not enable testing-library's global auto-cleanup.
  afterEach(cleanup);

  it("asks for a goal when the session has none", () => {
    seed(null);
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText("Set a goal for this session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create goal" })).toBeTruthy();
  });

  it("renders a seeded goal with its milestones and steps", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByRole("heading", { name: "Ship onboarding v2" })).toBeTruthy();
    for (const title of ["Audit existing flow", "Define acceptance tests", "Build onboarding screens", "Verify accessibility", "Review and handoff"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    // The footer carries the latest journal line; the History tab repeats it.
    expect(screen.getAllByText("Checkpoint saved before usage reset", { exact: false })).toHaveLength(1);
    openTab("History");
    expect(screen.getAllByText("Checkpoint saved before usage reset", { exact: false })).toHaveLength(2);
  });

  it("counts only checked milestones as verified", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    // Two verified, and the reported one is not counted despite the claim.
    expect(screen.getByText("2 of 5 milestones verified")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Verified/ })).toHaveLength(2);
  });

  it("labels a model claim as a claim", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    const claim = screen.getByText("reported · unverified");
    expect(claim).toBeTruthy();
    expect(claim.getAttribute("title")).toContain("Nothing has checked it");
  });

  it("shows the budget as used-of-ceiling rather than a bare number", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText("12 of 50")).toBeTruthy();
    expect(screen.getByText("84,200 of 200,000")).toBeTruthy();
  });

  it("says where the record lives, and that a check decides verification", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText("Saved in this app's database, not in your project.")).toBeTruthy();
    openTab("History");
    expect(screen.getByText(/not when the agent said so/)).toBeTruthy();
  });

  it("shows the countdown and the auto-resume rule while parked on usage", () => {
    // The countdown comes from the sample, which is what the runner waits on.
    const resetAtUnix = Math.floor((Date.now() + 2 * 3_600_000 + 13 * 60_000) / 1000);
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: null, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false } },
      usage: { codex: { fetchedAtUnixMs: Date.now(), allowed: true, limitReached: true, primary: { usedPercent: 100, windowSeconds: 18_000, resetAtUnix } } },
    });
    seed({ ...view, goal: { ...view.goal, state: "waiting_usage", onUsageReset: "continue_automatically" } });
    render(<OdysseyPane sessionId={SESSION} />);

    // Whose window, now that there are two accounts that can be spent.
    expect(screen.getByText("Waiting for ChatGPT's usage window")).toBeTruthy();
    expect(screen.getByText(/remaining/)).toBeTruthy();
    expect(screen.getByText(/Auto-resume is on/)).toBeTruthy();
    // A ticking clock in a live region is unusable with a screen reader.
    expect(screen.getByText(/^2:1[23]:/).closest("[aria-hidden]")).toBeTruthy();
  });

  it("stops counting down once the window has room again", () => {
    // The bug: parked at 99% with a reset two hours out, the window rolled and
    // freed capacity early, but the card kept counting to the old reset — and
    // every re-sample pushed it further away.
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: Date.now() + 2 * 3_600_000, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false } },
      usage: {
        codex: {
          fetchedAtUnixMs: Date.now(),
          allowed: true,
          limitReached: false,
          primary: { usedPercent: 0, windowSeconds: 18_000, resetAtUnix: Math.floor(Date.now() / 1000) + 18_000 },
        },
      },
    });
    seed({ ...view, goal: { ...view.goal, state: "waiting_usage" } });
    render(<OdysseyPane sessionId={SESSION} />);

    expect(screen.queryByText(/remaining/)).toBeNull();
    expect(screen.getByText("Usage is back; the run picks up on the next check.")).toBeTruthy();
  });

  it("admits it cannot resume on a clock when nothing knows a reset time", () => {
    // Spent, but the provider named no reset: there is genuinely nothing to
    // count down to, which is different from having room.
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: null, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false } },
      usage: { codex: { fetchedAtUnixMs: Date.now(), allowed: true, limitReached: true } },
    });
    seed({ ...view, goal: { ...view.goal, state: "waiting_usage" } });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText(/no reset time/)).toBeTruthy();
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it("counts down to the time the usage sample names when the runner has forgotten it", () => {
    // After a reload the in-memory resume time is gone. Reading only that made
    // the card announce "no reset time" directly above a usage readout that
    // showed one.
    const resetAtUnix = Math.floor((Date.now() + 2 * 3_600_000 + 13 * 60_000) / 1000);
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: null, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false } },
      usage: { codex: { fetchedAtUnixMs: Date.now(), allowed: true, limitReached: true, primary: { usedPercent: 100, windowSeconds: 18_000, resetAtUnix } } },
    });
    seed({ ...view, goal: { ...view.goal, state: "waiting_usage" } });
    render(<OdysseyPane sessionId={SESSION} />);

    expect(screen.queryByText(/no reset time/)).toBeNull();
    expect(screen.getByText(/remaining/)).toBeTruthy();
    expect(screen.getByText(/^2:1[23]:/)).toBeTruthy();
  });

  it("offers Start on a draft and Pause on a run", () => {
    seed({ ...view, goal: { ...view.goal, state: "draft" } });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    cleanup();

    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("shows what blocked a run, from the journal", () => {
    seed({
      ...view,
      goal: { ...view.goal, state: "blocked" },
      journal: [{ id: "g1", odysseyId: "o1", at: 1, kind: "guard", summary: "3 turns in a row changed nothing on disk and nothing in the plan" }],
    });
    render(<OdysseyPane sessionId={SESSION} />);
    // The state strip says it, and the footer repeats it as the latest entry.
    expect(within(screen.getByRole("status")).getByText(/3 turns in a row changed nothing/)).toBeTruthy();
    expect(screen.getAllByText(/3 turns in a row changed nothing/)).toHaveLength(2);
    // The History tab adds its row.
    openTab("History");
    expect(screen.getAllByText(/3 turns in a row changed nothing/)).toHaveLength(3);
  });

  it("offers to run a claimed milestone's check, and to accept it without one", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    // m4 claims completion and names a command, so both lanes are on offer
    // and the weaker one says what it is.
    // The active milestone names a command too, so both offer to run it.
    expect(screen.getAllByRole("button", { name: "Run check" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Accept anyway" })).toBeTruthy();
    expect(screen.getByText(/Model's note: audited every screen/)).toBeTruthy();
  });

  it("offers only a tick for a milestone whose check is the user", () => {
    seed({ ...view, milestones: [milestone({ id: "m1", title: "Read it over", position: 0, state: "reported", checkKind: "manual", reportedNote: "done" })] });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run check" })).toBeNull();
  });

  it("names the lane that produced a verification, and shows what it printed", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    const badges = screen.getAllByRole("button", { name: /Verified/ });
    // m2 was checked by Super Thing; opening it shows the lane and the output.
    fireEvent.click(badges[1] as HTMLElement);
    expect(screen.getByText("check run by Super Thing", { exact: false })).toBeTruthy();
    expect(screen.getByText(/Tests 63 passed/)).toBeTruthy();
  });

  it("opens a failed check's output rather than hiding it in a tooltip", () => {
    seed({
      ...view,
      milestones: [
        milestone({ id: "m1", title: "Build it", position: 0, state: "failed", checkKind: "tests_pass", checkSpec: "pnpm test", checkSource: "desktop", checkOutput: "`pnpm test` exited 1\n\n2 failed" }),
      ],
    });
    render(<OdysseyPane sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: /Check failed/ }));
    expect(screen.getByText(/2 failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run check" })).toBeTruthy();
  });

  it("shows the runner's reason in any state, with how old it is", () => {
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: null, lastReason: "a turn is already running", lastReasonAt: Date.now() - 4 * 60_000, ticking: false, stalledSince: null, stallNotified: false } },
    });
    seed({ ...view, goal: { ...view.goal, state: "paused" } });
    render(<OdysseyPane sessionId={SESSION} />);

    const card = within(screen.getByRole("status"));
    expect(card.getByText(/a turn is already running/)).toBeTruthy();
    // The age is the point: without it an hour-old reason reads as current.
    expect(card.getByText(/4m ago/)).toBeTruthy();
  });

  it("warns when the runner has been unable to act for too long", () => {
    useStore.setState({
      odysseyRuntime: {
        [SESSION]: { resumeAt: null, lastReason: "a turn is already running", lastReasonAt: Date.now(), ticking: false, stalledSince: Date.now() - 12 * 60_000, stallNotified: true },
      },
    });
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);

    expect(within(screen.getByRole("status")).getByText("Super Thing has not been able to act for 12m: a turn is already running")).toBeTruthy();
  });

  it("does not warn while the wait is still ordinary", () => {
    useStore.setState({
      odysseyRuntime: { [SESSION]: { resumeAt: null, lastReason: "a turn is already running", lastReasonAt: Date.now(), ticking: false, stalledSince: Date.now() - 30_000, stallNotified: false } },
    });
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);

    expect(screen.queryByText(/has not been able to act/)).toBeNull();
    expect(within(screen.getByRole("status")).getByText(/a turn is already running/)).toBeTruthy();
  });

  it("offers the choice between carrying on and waiting at every claim", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    openTab("Settings");
    const picker = screen.getByLabelText("When the agent says a milestone is done") as HTMLSelectElement;
    expect(picker.value).toBe("continue");
    expect(screen.getByText(/stays reported · unverified and the run keeps going/)).toBeTruthy();
  });

  it("says plainly when a finished goal rests on the agent's word", () => {
    seed({
      ...view,
      goal: { ...view.goal, state: "complete" },
      milestones: [milestone({ id: "m1", title: "Done properly", position: 0, state: "verified" }), milestone({ id: "m2", title: "Claimed", position: 1, state: "reported" })],
    });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(within(screen.getByRole("status")).getByText(/1 milestone is the agent.s word alone/)).toBeTruthy();
  });

  it("says what it will do about a silent turn, and when", () => {
    useStore.setState({
      odysseyRuntime: {
        [SESSION]: { resumeAt: null, lastReason: "a turn is already running", lastReasonAt: Date.now(), ticking: false, stalledSince: Date.now() - 12 * 60_000, stallNotified: true },
      },
    });
    seed(view);
    const session = useStore.getState().sessions[SESSION]!;
    session.projection.foreground = "running";
    useStore.setState({ sessions: { [SESSION]: { ...session, lastEventAt: Date.now() - 12 * 60_000 } } });
    render(<OdysseyPane sessionId={SESSION} />);

    const card = within(screen.getByRole("status"));
    expect(card.getByText(/no events for 12m/)).toBeTruthy();
    expect(card.getByText(/cancels the turn at 30 minutes/)).toBeTruthy();
  });

  it("offers the silent-turn limit as a setting", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    openTab("Settings");
    expect((screen.getByLabelText("Cancel a silent turn after") as HTMLInputElement).value).toBe("30");
    expect(screen.getByText(/0 never cancels/)).toBeTruthy();
  });

  it("refuses to offer a Resume that cannot work, and offers the remedy instead", () => {
    seed({
      ...view,
      goal: { ...view.goal, state: "blocked", continuationsUsed: 10, maxContinuations: 10 },
      journal: [{ id: "g1", odysseyId: "o1", at: 1, kind: "guard", summary: "the continuation limit of 10 is used up" }],
    });
    render(<OdysseyPane sessionId={SESSION} />);

    const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(resume.getAttribute("title")).toContain("cannot clear a budget");
    expect(screen.getByText(/10 of 10 continuations are spent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow 10 more and resume" })).toBeTruthy();
  });

  it("still offers Resume for a goal blocked on something a restart can clear", () => {
    seed({
      ...view,
      goal: { ...view.goal, state: "blocked" },
      journal: [{ id: "g1", odysseyId: "o1", at: 1, kind: "guard", summary: "3 turns in a row changed nothing" }],
    });
    render(<OdysseyPane sessionId={SESSION} />);
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/cannot clear this/)).toBeNull();
  });

  it("offers the project's test command as a setting, showing the one the goal has", () => {
    seed({ ...view, goal: { ...view.goal, defaultCheck: "python3 Tools/check.py" } });
    render(<OdysseyPane sessionId={SESSION} />);
    openTab("Settings");
    const field = screen.getByLabelText("Test command") as HTMLInputElement;
    expect(field.value).toBe("python3 Tools/check.py");
    expect(screen.getByText(/The planner is told to make it each milestone/)).toBeTruthy();
  });

  it("shows where a milestone's specification lives", () => {
    seed({ ...view, milestones: [milestone({ id: "m1", title: "Economy", position: 0, section: "## 4. Economy (lines 210–305)" })] });
    render(<OdysseyPane sessionId={SESSION} />);
    // A planned milestone is a single row until it is opened.
    expect(screen.queryByText("## 4. Economy (lines 210–305)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    expect(screen.getByText("## 4. Economy (lines 210–305)")).toBeTruthy();
    expect(screen.getByText(/^spec:/)).toBeTruthy();
  });

  it("says whether the run is keeping its handoff note", () => {
    seed(view);
    useStore.setState({ odysseyNotes: { [SESSION]: { agentNotes: [] } } });
    render(<OdysseyPane sessionId={SESSION} />);
    openDetails();
    expect(screen.getByText(/No handoff note yet/)).toBeTruthy();
    cleanup();

    seed(view);
    useStore.setState({
      odysseyNotes: {
        [SESSION]: {
          state: { path: "docs/super-thing/STATE.md", bytes: 900, modifiedAtUnixMs: Date.now() - 5 * 60_000 },
          agentNotes: [{ path: "docs/super-thing/agents/a.md", bytes: 1, modifiedAtUnixMs: Date.now() }],
        },
      },
    });
    render(<OdysseyPane sessionId={SESSION} />);
    openDetails();
    expect(screen.getByText(/Handoff note/)).toBeTruthy();
    expect(screen.getByText(/1 subagent note/)).toBeTruthy();
  });

  it("puts the run's numbers in the strip and the rest behind tabs", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    const strip = within(screen.getByRole("status"));
    // Tasks: one done of two on the active milestone.
    expect(strip.getByText("1 of 2")).toBeTruthy();
    expect(strip.getByText("12 of 50")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Roadmap", "Inbox", "Documents", "History", "Changes", "Settings"]);
    expect(screen.queryByLabelText("Test command")).toBeNull();
    openTab("Changes");
    expect(screen.getByText(/Nothing queued/)).toBeTruthy();
  });

  it("lists a milestone's tasks as a table with number, owner, state and dependencies", () => {
    const tasked: OdysseyView = {
      ...view,
      milestones: [
        milestone({
          id: "m6",
          title: "Economy",
          position: 0,
          state: "active",
          steps: [
            { id: "t1", milestoneId: "m6", position: 0, title: "Model", state: "done", note: "", detail: "Cities and goods", dependsOn: [], agentName: "1.1-model", harness: "acp.claude", model: "sonnet", updatedAt: Date.now() - 120_000 },
            { id: "t2", milestoneId: "m6", position: 1, title: "Pricing", state: "pending", note: "", detail: "", dependsOn: ["t1"] },
            { id: "t3", milestoneId: "m6", position: 2, title: "Validation", state: "pending", note: "", detail: "", dependsOn: ["t2"] },
          ],
        }),
      ],
    };
    seed(tasked);
    render(<OdysseyPane sessionId={SESSION} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("1.1")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("acp.claude · sonnet")).toBeTruthy();
    // The chip, not the option of the same name in the state picker.
    const chip = (row: HTMLElement) => row.querySelector(".task-status")?.textContent;
    expect(chip(rows[0] as HTMLElement)).toBe("Done");
    expect(within(rows[0] as HTMLElement).getByText("2m ago")).toBeTruthy();
    // The second is ready because its dependency is done; the third waits on 1.2.
    expect(chip(rows[1] as HTMLElement)).toBe("To do");
    expect(chip(rows[2] as HTMLElement)).toBe("Waiting");
    expect(within(rows[2] as HTMLElement).getByText("1.2")).toBeTruthy();
    // Descriptions stay folded until a task is opened.
    expect(screen.queryByText("Cities and goods")).toBeNull();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: /Model/ }));
    expect(screen.getByText("Cities and goods")).toBeTruthy();
  });

  it("offers to ask the agent for tasks when a milestone has none", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    const title = screen.getByRole("button", { name: "Review and handoff" });
    fireEvent.click(title);
    const row = within(title.closest("li") as HTMLElement);
    expect(row.getByRole("button", { name: "ask the agent to break it into tasks" })).toBeTruthy();
    expect(row.getByText("No tasks yet.")).toBeTruthy();
  });

  it("lists what needs a human in the inbox, with the controls that settle it", () => {
    seed({ ...view, goal: { ...view.goal, onReport: "wait" } });
    useStore.setState({
      odysseyQuestions: { [SESSION]: [{ id: "q1", odysseyId: "o1", at: 10, kind: "architecture", question: "ECS or classes?", options: ["ECS", "classes"], fallback: "continuing with classes", state: "open" }] },
      odysseyPlanChanges: { [SESSION]: [{ id: "pc1", odysseyId: "o1", at: 9, ops: "[]", summary: '⇄ Split task 3.2 "Implement screens" into 2: A, B (two owners)\n− Drop task 3.9 — refused: milestone 3 has no task 9', reason: "two owners", state: "proposed" }] },
    });
    render(<OdysseyPane sessionId={SESSION} />);
    // The question and the plan change; milestone 4's claim has a command
    // check, which Super Thing runs itself, so it is not the user's decision.
    expect(screen.getByRole("tab", { name: "Inbox (2)" })).toBeTruthy();
    openTab("Inbox (2)");
    expect(screen.getByText("Architectural fork")).toBeTruthy();
    expect(screen.getByText("ECS or classes?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ECS" })).toBeTruthy();
    expect(screen.getByText("Plan change proposed")).toBeTruthy();
    expect(screen.getByText(/Split task 3.2/)).toBeTruthy();
    expect(screen.getByText(/refused: milestone 3 has no task 9/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.queryByText(/waits for your tick/)).toBeNull();
  });

  it("says when nothing needs a human", () => {
    seed(view);
    render(<OdysseyPane sessionId={SESSION} />);
    openTab("Inbox");
    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
  });

  it("shows a skeleton until the record has been read", () => {
    seed(undefined);
    const { container } = render(<OdysseyPane sessionId={SESSION} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});

/**
 * A draft goal planned from a document. The plan is the agent's reading, and
 * the card has to say so — and say that Start is what authorises its checks.
 */
describe("a goal planned from a document", () => {
  const planned = (overrides: Partial<OdysseyView> = {}): OdysseyView => ({
    goal: { ...view.goal, state: "draft", planSource: "roadmap.md", planDocumentBytes: 8_192 },
    milestones: [],
    journal: [],
    ...overrides,
  });

  beforeEach(() => {
    useStore.setState({ sessions: {}, odyssey: {}, odysseyRuntime: {}, error: null });
  });
  afterEach(cleanup);

  it("says the agent is reading it once the plan has been asked for", () => {
    seed(planned({ journal: [{ id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED }] }));
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText("Planned from roadmap.md · 8 KB")).toBeTruthy();
    expect(screen.getByText(/The agent is reading the document/)).toBeTruthy();
  });

  it("cannot be started before there is anything to run", () => {
    seed(planned());
    render(<OdysseyPane sessionId={SESSION} />);
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute("title")).toContain("let the agent propose them");
  });

  it("attributes a proposed plan to the agent and warns about its checks", () => {
    seed(
      planned({
        milestones: [
          milestone({ id: "n1", title: "Phase one", position: 0, checkKind: "tests_pass", checkSpec: "cargo test" }),
          milestone({ id: "n2", title: "Phase two", position: 1 }),
        ],
        journal: [
          { id: "p2", odysseyId: "o1", at: 2, kind: "plan", summary: "The agent proposed 2 milestones from roadmap.md", detail: "1 milestone has a check Super Thing can run." },
          { id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED },
        ],
      }),
    );
    render(<OdysseyPane sessionId={SESSION} />);

    // Scoped to the card: the journal footer repeats the latest entry too.
    const card = within(screen.getByRole("region", { name: "Plan document" }));
    expect(card.getByText(/The agent proposed 2 milestones from roadmap.md/)).toBeTruthy();
    expect(card.getByText(/the agent.s reading of the document, not Super Thing.s/)).toBeTruthy();
    expect(card.getByText(/1 of them has a check Super Thing will run in this workspace/)).toBeTruthy();
    // Now it can be started, and starting is the approval.
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Starting accepts the plan as it stands/)).toBeTruthy();
  });

  it("warns when nothing in a proposed plan can be checked by a command", () => {
    seed(
      planned({
        milestones: [milestone({ id: "n1", title: "Phase one", position: 0 }), milestone({ id: "n2", title: "Phase two", position: 1 })],
        journal: [{ id: "p2", odysseyId: "o1", at: 2, kind: "plan", summary: "The agent proposed 2 milestones from roadmap.md" }],
      }),
    );
    render(<OdysseyPane sessionId={SESSION} />);
    const card = within(screen.getByRole("region", { name: "Plan document" }));
    expect(card.getByText(/Every milestone is manual: the run will stop at each claim until you tick it/)).toBeTruthy();
    expect(card.getByText(/Set a test command in Settings/)).toBeTruthy();
  });

  it("says plainly when the agent proposed nothing, and offers to ask again", () => {
    seed(
      planned({
        journal: [
          { id: "p2", odysseyId: "o1", at: 2, kind: "plan", summary: "The agent proposed no plan", detail: "Its reply contained no SUPERTHING-PLAN block." },
          { id: "p1", odysseyId: "o1", at: 1, kind: "plan", summary: PLAN_REQUESTED },
        ],
      }),
    );
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText(/reply contained no plan/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask the agent to plan it" })).toBeTruthy();
  });

  it("shows nothing about planning for a goal that was not planned from a document", () => {
    seed({ ...view, goal: { ...view.goal, state: "draft" } });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.queryByText(/Planned from/)).toBeNull();
  });
});

describe("which subscription the run is spending", () => {
  afterEach(cleanup);

  it("names the account beside the state, not among the numbers", () => {
    // The account was the last item in a dense row of stats and read as one
    // more figure, so a run that had moved accounts looked identical to one
    // that had not — and an error saying "Kit" on a Claude session made it
    // worse.
    seed(view, { agent: "claude" });
    render(<OdysseyPane sessionId={SESSION} />);
    const badge = screen.getByTitle(/spends the Claude subscription/i);
    expect(badge.textContent).toContain("Claude");
  });

  it("says whose window it is waiting on", () => {
    // "Waiting for usage reset" meant nothing once there were two accounts.
    seed({ ...view, goal: { ...view.goal, state: "waiting_usage" } }, { agent: "claude" });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText(/Waiting for Claude's usage window/i)).toBeTruthy();
  });

  it("calls a Codex run's account by its subscription, not by the agent", () => {
    // Codex is the program; ChatGPT is what it spends, and that is the thing a
    // reader is actually asking about.
    seed(view, { agent: "codex" });
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByTitle(/spends the ChatGPT subscription/i).textContent).toContain("ChatGPT");
  });
});
