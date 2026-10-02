/**
 * The Big Thing tab's "Working now" lanes: one per worker holding a job or a
 * subagent working, beside the orchestrator's own turn, each named by the
 * plan's task number when it is one of the plan's tasks.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { WorkLanes, lanesFor } from "./components/WorkLanes";

const step = (id: string, title: string, extra: Partial<OdysseyStep> = {}) => ({ id, title, state: "in_progress", ...extra }) as unknown as OdysseyStep;
const milestones = [
  { id: "m1", title: "Foundation", state: "verified", steps: [step("s1", "Schema")] },
  { id: "m2", title: "Screens", state: "active", steps: [step("s2", "Layout", { jobId: "j1" }), step("s3", "Copy", { agentName: "copy-writer" })] },
] as unknown as MilestoneRecord[];
const job = (id: string, status: JobView["status"], extra: Partial<JobView> = {}): JobView => ({ id, orchestrator: "o", worker: "cx", provider: "codex", task: "Do the thing\nmore", status, toolCalls: 3, attempts: 0, startedAtUnixMs: 1, ...extra });

afterEach(cleanup);

describe("parallel-work lanes", () => {
  it("lays out the orchestrator, each open job and each working subagent, by task number", () => {
    const lanes = lanesFor({
      orchestrator: { provider: "claude", model: "opus", running: true, startedAt: 1, toolCalls: 1, milestone: "Milestone 2: Screens" },
      jobs: [job("j1", "running"), job("j2", "waiting", { waitingReason: "image limit", worker: "gm" }), job("j3", "succeeded")],
      agents: [
        { id: "a1", name: "copy-writer", harness: "claude-code", model: null, status: "working", task: "Write the copy", generationStartedAtUnixMs: 1 },
        { id: "a2", name: "old", harness: "claude-code", model: null, status: "idle", task: "", generationStartedAtUnixMs: 1 },
      ],
      milestones,
    });
    expect(lanes.map((lane) => lane.who)).toEqual(["Orchestrator", "cx", "gm", "copy-writer"]);
    expect(lanes[1]).toMatchObject({ number: "2.1", task: "Layout", provider: "codex", state: "working" });
    expect(lanes[2]).toMatchObject({ number: null, task: "Do the thing", state: "waiting", note: "image limit" });
    expect(lanes[3]).toMatchObject({ number: "2.2", task: "Copy", provider: "claude" });
  });

  it("has no lanes when nothing is running", () => {
    const lanes = lanesFor({ orchestrator: { provider: "claude", model: null, running: false, startedAt: null, toolCalls: 0, milestone: null }, jobs: [job("j3", "succeeded")], agents: [], milestones });
    expect(lanes).toEqual([]);
  });

  it("shows a lane per open job in the tab, numbered from the plan", () => {
    const handle = { id: "o", attachmentGeneration: "1" };
    const projection = emptyProjection();
    projection.attachment = "attached";
    projection.foreground = "idle";
    const session = { handle, workspaceId: "w1", snapshot: { handle, provider: "claude" }, projection, inFlightRequestId: null, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: Date.now(), usage: EMPTY_SESSION_USAGE } as unknown as LiveSession;
    useStore.setState({ sessions: { o: session }, jobs: { o: [job("j1", "running", { workerSession: "w-handle" })] }, odyssey: { o: { goal: {}, milestones, journal: [] } as never } });
    render(<WorkLanes sessionId="o" />);
    expect(screen.getByText("Working now")).toBeTruthy();
    expect(screen.getByText("2.1")).toBeTruthy();
    expect(screen.getByText("Layout")).toBeTruthy();
    expect(screen.getByText("1 in parallel")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
