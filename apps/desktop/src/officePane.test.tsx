/** The office shows the lead and the team's helpers, and nothing else. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { OfficePane } from "./components/OfficePane";

function session(id: string): LiveSession {
  const handle = { id, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  return {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: `a-${id}`, provider: "claude" } as unknown as Snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: Date.now(),
    usage: EMPTY_SESSION_USAGE,
  };
}

beforeEach(() => useStore.setState({ sessions: {}, jobs: {}, teams: {} }));
afterEach(cleanup);

describe("OfficePane", () => {
  const job = (worker: string, status: JobView["status"]) => ({ id: `j-${worker}`, orchestrator: "lead", worker, provider: "codex", task: `${worker} task`, status, toolCalls: 0, attempts: 0, startedAtUnixMs: Date.now() - 1000 }) as JobView;

  it("lists the lead and the team's helpers, and not the lead's temporary subagents", () => {
    const lead = session("lead");
    lead.projection.inspector.agents.set("a1", { id: "a1", name: "atlas-haiku", status: "working", outcome: null, generation: 1, task: "x", parentId: null, parentName: null, harness: "claude-code", model: "haiku", createdAtUnixMs: 1, generationStartedAtUnixMs: 1, generationFinishedAtUnixMs: null, updatedSequence: "1" });
    useStore.setState({ sessions: { lead }, jobs: { lead: [job("Reviewer", "running")] } });
    render(<OfficePane sessionId="lead" />);
    expect(screen.getByText("Everyone in the office (2)")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(screen.queryByText("atlas-haiku")).toBeNull();
  });

  it("opens a panel to choose the wall screen and picture frame images", () => {
    useStore.setState({ sessions: { lead: session("lead") }, jobs: {} });
    render(<OfficePane sessionId="lead" />);
    expect(screen.queryByText("Wall screen")).toBeNull();
    fireEvent.click(screen.getByLabelText("Customize the office"));
    expect(screen.getByText("Wall screen")).toBeTruthy();
    expect(screen.getByText("Picture frame")).toBeTruthy();
    expect(screen.getByText("Your images stay on this device.")).toBeTruthy();
  });

  it("resizes from its left edge, by keyboard too, and keeps to its limits", () => {
    useStore.setState({ sessions: { lead: session("lead") }, jobs: {} });
    render(<OfficePane sessionId="lead" />);
    const edge = screen.getByRole("separator", { name: "Resize the office" });
    const pane = screen.getByRole("complementary", { name: "Office" });
    fireEvent.keyDown(edge, { key: "Home" });
    expect(pane.style.width).toBe("320px");
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(pane.style.width).toBe("336px");
    fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
    expect(pane.style.width).toBe("272px");
    for (let index = 0; index < 10; index += 1) fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
    expect(pane.style.width).toBe("240px");
  });
});
