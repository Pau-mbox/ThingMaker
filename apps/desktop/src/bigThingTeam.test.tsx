/**
 * The team views of a run (ADR-010): who did each milestone, read from the
 * record; the project memory, written through the host; and the run options,
 * which edit the goal.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OdysseyView } from "@thingmaker/contracts";

const calls: { command: string; args: Record<string, unknown> }[] = [];
const memory: Record<string, unknown>[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "memory_list") return memory;
    if (command === "memory_write") {
      const entry = { id: `m${memory.length}`, workspaceId: "w1", author: "user", createdAt: 1, updatedAt: 1, ...((args.request as { entry: object }).entry) };
      memory.unshift(entry);
      return entry;
    }
    if (command === "bigthing_commits") return [];
    return null;
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { MemoryPanel, RunOptions, Timeline } from "./components/BigThingTeam";

const view: OdysseyView = {
  goal: {
    id: "o1",
    workspaceId: "w1",
    title: "Ship it",
    brief: "",
    state: "draft",
    stopCondition: "goal_complete",
    onUsageReset: "notify_only",
    onReport: "continue",
    onPlanChange: "tasks_auto",
    orchestrator: "either",
    deadTurnMinutes: 30,
    maxContinuations: 10,
    continuationsUsed: 2,
    tokensUsed: 0,
    createdAt: 1,
    updatedAt: 2,
  },
  milestones: [
    {
      id: "m1",
      odysseyId: "o1",
      position: 0,
      title: "Economy",
      detail: "",
      state: "verified",
      checkKind: "manual",
      steps: [{ id: "s1", milestoneId: "m1", position: 0, title: "Prices", state: "done", note: "", detail: "", dependsOn: [], agentName: "1.1-prices", harness: "team · Codex", model: "gpt-6-luna", review: "approved by sonnet (Claude Code)" }],
    },
  ],
  journal: [{ id: "j1", odysseyId: "o1", at: 10, kind: "continuation", milestoneId: "m1", summary: "Continued milestone 1 of 1", provider: "claude", model: "opus" }],
};

afterEach(() => {
  cleanup();
  calls.length = 0;
  memory.length = 0;
});

describe("the team views of a run", () => {
  it("says who led each milestone and which worker did each task", () => {
    render(<Timeline view={view} />);
    expect(screen.getByText(/Led by Claude Code · opus — 1 continuation/)).toBeTruthy();
    expect(screen.getByText(/1.1-prices: team · Codex · gpt-6-luna · review: approved by sonnet/)).toBeTruthy();
  });

  it("adds to the project memory through the host and lists what is there", async () => {
    render(<MemoryPanel goalUpdatedAt={1} workspaceId="w1" />);
    fireEvent.change(screen.getByLabelText("Memory title"), { target: { value: "Prices are cents" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to memory" }));
    });
    const written = calls.find((entry) => entry.command === "memory_write");
    expect(written?.args.request).toEqual({ workspaceId: "w1", entry: { kind: "decision", title: "Prices are cents", body: "" } });
    expect(await screen.findByText("Prices are cents")).toBeTruthy();
  });

  it("edits the goal's dispatch, review and worktree options", () => {
    const edits: object[] = [];
    const { rerender } = render(<RunOptions onEdit={(edit) => edits.push(edit)} view={view} />);
    fireEvent.change(screen.getByLabelText("Who hands out the tasks"), { target: { value: "runner" } });
    expect(edits).toContainEqual({ dispatch: "runner" });
    rerender(<RunOptions onEdit={(edit) => edits.push(edit)} view={{ ...view, goal: { ...view.goal, dispatch: "runner" } }} />);
    fireEvent.click(screen.getByLabelText(/Review every finished task/));
    expect(edits).toContainEqual({ reviewTasks: true });
    fireEvent.click(screen.getByLabelText(/own branch and worktree/));
    expect(edits).toContainEqual({ isolate: true });
  });
});
