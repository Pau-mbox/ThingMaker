/**
 * Loops, the user's approvals and the results tasks are given, as the Big
 * Thing screen shows them: the approval card in the inbox settles the run's
 * question, and the task table edits a task's flow.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneRecord, OdysseyStep, OdysseyView, QuestionRecord } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { useStore } from "./store";
import { InboxPanel } from "./components/OdysseyInbox";
import { TaskTable } from "./components/OdysseyTasks";
import { flowBadges, taskInputs } from "./odysseyTasks";

const SESSION = "sess-1";

function step(id: string, title: string, overrides: Partial<OdysseyStep> = {}): OdysseyStep {
  return { id, milestoneId: "m1", position: 0, title, state: "done", note: "", detail: "", dependsOn: [], ...overrides };
}

const steps = [
  step("s1", "Write the copy", { result: "Bees, but faster.", round: 2 }),
  step("s2", "Review the copy", { dependsOn: ["s1"], uses: ["s1"], loopTo: "s1", loopLimit: 3, round: 2 }),
  step("s3", "Your sign-off", { state: "in_progress", kind: "approval", dependsOn: ["s2"], detail: "Check the tone." }),
];
const milestone: MilestoneRecord = { id: "m1", odysseyId: "o1", position: 0, title: "Copy", detail: "", state: "active", checkKind: "manual", steps };
const view = {
  goal: { id: "o1", workspaceId: "w1", title: "Goal", brief: "", state: "running" },
  milestones: [milestone],
  journal: [],
} as unknown as OdysseyView;
const question: QuestionRecord = { id: "q1", odysseyId: "o1", at: Date.now(), kind: "approval", question: "Your sign-off", options: [], state: "open", stepId: "s3" };

const decide = vi.fn(async () => undefined);
const editStep = vi.fn(async () => undefined);

beforeEach(() => {
  decide.mockClear();
  editStep.mockClear();
  useStore.setState({
    sessions: {},
    odyssey: { [SESSION]: view },
    odysseyQuestions: { [SESSION]: [question] },
    odysseyPlanChanges: {},
    odysseyAmendments: {},
    odysseyDecideApproval: decide,
    odysseyEditStep: editStep,
  } as never);
});
afterEach(cleanup);

describe("a task's place in the flow", () => {
  it("reads as short badges", () => {
    expect(flowBadges(steps[1]!, [milestone], 0)).toEqual(["↺ back to 1.1 · round 2 of 3", "uses 1.1"]);
    expect(flowBadges(steps[2]!, [milestone], 0)).toEqual(["your approval"]);
    expect(flowBadges(steps[0]!, [milestone], 0)).toEqual(["round 2"]);
  });

  it("gives an approval what it waits on when it names nothing", () => {
    expect(taskInputs([milestone], steps[2]!)).toEqual([{ number: "1.2", title: "Review the copy", result: null }]);
    expect(taskInputs([milestone], steps[1]!)).toEqual([{ number: "1.1", title: "Write the copy", result: "Bees, but faster." }]);
  });
});

describe("the approval card", () => {
  it("shows what to approve and settles the question with the comments", async () => {
    render(<InboxPanel sessionId={SESSION} view={view} />);
    const card = screen.getByText("Your approval").closest("li") as HTMLElement;
    expect(within(card).getByText("Check the tone.")).toBeTruthy();
    expect(within(card).getByText(/Result of task 1.2/)).toBeTruthy();
    fireEvent.change(within(card).getByRole("textbox", { name: "Your comments" }), { target: { value: "Warmer, please" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send it back" }));
    expect(decide).toHaveBeenCalledWith(SESSION, "q1", "send_back", "Warmer, please");
    const approve = within(card).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    expect(decide).toHaveBeenLastCalledWith(SESSION, "q1", "approve", "Warmer, please");
  });

  it("offers another round when a loop used its rounds", async () => {
    useStore.setState({ odysseyQuestions: { [SESSION]: [{ ...question, kind: "loop_limit", stepId: "s2", question: "Task 1.2 still asks for changes after 3 rounds", fallback: "shorter" }] } });
    render(<InboxPanel sessionId={SESSION} view={view} />);
    expect(screen.getByText("A loop used its rounds")).toBeTruthy();
    expect(screen.getByText("shorter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Another round" }));
    expect(decide).toHaveBeenCalledWith(SESSION, "q1", "send_back", null);
    const accept = screen.getByRole("button", { name: "Accept it as it is" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(accept.disabled).toBe(false));
    fireEvent.click(accept);
    expect(decide).toHaveBeenLastCalledWith(SESSION, "q1", "approve", null);
  });
});

describe("the task table", () => {
  it("edits who does a task, what it is given and where its loop goes", () => {
    render(<TaskTable milestone={milestone} milestoneIndex={0} sessionId={SESSION} />);
    expect(screen.getByText("↺ back to 1.1 · round 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review the copy/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Who does it" }), { target: { value: "approval" } });
    expect(editStep).toHaveBeenLastCalledWith(SESSION, "s2", { kind: "approval" });
    fireEvent.click(screen.getByRole("checkbox", { name: "1.1 Write the copy" }));
    expect(editStep).toHaveBeenLastCalledWith(SESSION, "s2", { uses: [] });
    fireEvent.change(screen.getByRole("combobox", { name: "When it asks for changes, go back to" }), { target: { value: "" } });
    expect(editStep).toHaveBeenLastCalledWith(SESSION, "s2", { loopTo: "" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rounds" }), { target: { value: "5" } });
    expect(editStep).toHaveBeenLastCalledWith(SESSION, "s2", { loopLimit: 5 });
  });
});
