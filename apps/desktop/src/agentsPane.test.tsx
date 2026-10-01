/**
 * The subagent list, once subagents run somewhere else.
 *
 * Two things this has to get right: which model is running each one — no
 * longer implied by the session's own picker, since subagents are delegated
 * to another harness on another account — and not burying a running agent
 * inside a collapsed group of finished ones.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection, type AgentNode } from "./projection";
import { AgentsPane } from "./components/AgentsPane";
import { describeModel } from "./components/OdysseyActivity";

function agent(overrides: Partial<AgentNode> & { id: string; name: string }): AgentNode {
  return {
    status: "working",
    outcome: null,
    generation: 1,
    task: "",
    parentId: null,
    parentName: null,
    harness: "acp.claude",
    model: "sonnet",
    createdAtUnixMs: 1,
    generationStartedAtUnixMs: Date.now() - 60_000,
    generationFinishedAtUnixMs: null,
    updatedSequence: "1",
    ...overrides,
  };
}

function seed(nodes: AgentNode[]) {
  const handle = { id: "sess-1", attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  for (const node of nodes) projection.inspector.agents.set(node.id, node);
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: "kw-1" } as unknown as Snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: Date.now(),
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { "sess-1": session } });
}

beforeEach(() => useStore.setState({ sessions: {} }));
afterEach(cleanup);

describe("which model is running an agent", () => {
  it("names the harness and the model together", () => {
    expect(describeModel({ harness: "acp.claude", model: "opus" })).toBe("acp.claude · opus");
  });

  it("says the harness chose, rather than showing nothing", () => {
    // Null means the runtime reported no selection — an answer, not a gap.
    expect(describeModel({ harness: "acp.claude", model: null })).toBe("acp.claude · default");
  });

  it("shows it on every agent in the pane", () => {
    seed([agent({ id: "a1", name: "verifier", model: "opus" }), agent({ id: "a2", name: "worker", model: null })]);
    render(<AgentsPane sessionId="sess-1" />);
    expect(screen.getByText(/acp\.claude · opus/)).toBeTruthy();
    expect(screen.getByText(/acp\.claude · default/)).toBeTruthy();
  });
});

describe("keeping finished agents out of the way", () => {
  it("collapses them behind a count, and leaves the running ones out", () => {
    seed([
      agent({ id: "a1", name: "running-one" }),
      agent({ id: "a2", name: "done-one", status: "idle", outcome: "success" }),
      agent({ id: "a3", name: "done-two", status: "removed", outcome: "success" }),
    ]);
    render(<AgentsPane sessionId="sess-1" />);

    const group = screen.getByText("2 finished subagents").closest("details") as HTMLElement;
    expect(within(group).getByText("done-one")).toBeTruthy();
    expect(within(group).getByText("done-two")).toBeTruthy();
    // The running one is not inside the collapsed group.
    expect(within(group).queryByText("running-one")).toBeNull();
    expect(screen.getByText("running-one")).toBeTruthy();
  });

  it("never collapses a finished parent that still has a working child", () => {
    // Hiding it would bury the one thing worth looking at.
    seed([
      agent({ id: "p", name: "finished-parent", status: "idle", outcome: "success" }),
      agent({ id: "c", name: "busy-child", parentId: "p" }),
    ]);
    render(<AgentsPane sessionId="sess-1" />);

    expect(screen.queryByText(/finished subagent/)).toBeNull();
    expect(screen.getByText("finished-parent")).toBeTruthy();
    expect(screen.getByText("busy-child")).toBeTruthy();
  });

  it("says so plainly when everything has finished", () => {
    seed([agent({ id: "a1", name: "done", status: "idle", outcome: "success" })]);
    render(<AgentsPane sessionId="sess-1" />);
    expect(screen.getByText("Nothing is running right now.")).toBeTruthy();
    expect(screen.getByText("1 finished subagent")).toBeTruthy();
  });
});
