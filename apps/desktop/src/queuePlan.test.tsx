/**
 * The composer queue and the plan checklist, as the interface sees them.
 *
 * The queue itself runs in the session actor (tested against the mock agent
 * in claude_peer.rs); what matters here is that its published state reaches
 * the screen and that each control asks the actor for the right thing. The
 * plan is drawn from ACP plan updates: a checklist card per turn and a bar
 * pinned above the composer while steps remain.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, PlanContent, QueueView, SessionEvent } from "@thingmaker/contracts";

const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => ({ queue: { items: [], paused: null, sending: null } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { applyEvent, emptyProjection } from "./projection";
import { PlanBar, PlanCard, planProgress } from "./components/PlanChecklist";
import { QueueStrip } from "./components/QueueStrip";
import { useStore } from "./store";

afterEach(cleanup);

const handle = { id: "s", attachmentGeneration: "1" };
let sequence = 0;
function envelope(payload: SessionEvent): EventEnvelope {
  sequence += 1;
  return { apiVersion: 1, session: handle, sequence: String(sequence), payload };
}

const plan = (entries: [string, string][]): SessionEvent => ({
  type: "update",
  kind: "plan",
  planType: "items",
  id: "default",
  entries: entries.map(([content, status]) => ({ content, status })),
});

const settle: SessionEvent = { type: "turn", effect: "settled", kind: "foreground", phase: "succeeded", stopReason: "end_turn" } as SessionEvent;

describe("plans in the projection", () => {
  it("revises a plan in place within a turn and starts a new card in the next", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope(plan([["read", "in_progress"], ["write", "pending"]])));
    applyEvent(projection, envelope(plan([["read", "completed"], ["write", "in_progress"]])));
    expect(projection.cards.filter((card) => card.kind === "plan")).toHaveLength(1);

    applyEvent(projection, envelope(settle));
    applyEvent(projection, envelope(plan([["test", "pending"]])));
    const cards = projection.cards.filter((card) => card.kind === "plan");
    expect(cards).toHaveLength(2);
    // The first turn's card keeps that turn's last state: it is the record.
    const first = cards[0];
    expect(first?.kind === "plan" && first.plan.planType === "items" && first.plan.entries.map((e) => e.status)).toEqual(["completed", "in_progress"]);
    // The pinned plan is the latest one.
    expect(projection.plan?.content.planType === "items" && projection.plan.content.entries[0]?.content).toBe("test");
  });

  it("drops a removed plan from the transcript and the bar", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope(plan([["read", "pending"]])));
    applyEvent(projection, envelope({ type: "update", kind: "plan_removed", id: "default" }));
    expect(projection.cards.some((card) => card.kind === "plan")).toBe(false);
    expect(projection.plan).toBeNull();
  });

  it("keeps the queue the actor last published", () => {
    const projection = emptyProjection();
    const queue: QueueView = { items: [{ id: "q1", text: "next", extras: 1 }], paused: "the turn failed", sending: null };
    applyEvent(projection, envelope({ type: "queue", ...queue }));
    expect(projection.queue).toEqual(queue);
  });
});

const items = (entries: [string, string][]): PlanContent => ({ planType: "items", id: "default", entries: entries.map(([content, status]) => ({ content, status })) });

describe("the plan checklist", () => {
  it("counts what is done and names the step in progress", () => {
    expect(planProgress(items([["a", "completed"], ["b", "in_progress"], ["c", "pending"]]))).toMatchObject({ done: 1, total: 3, current: { content: "b" }, next: { content: "c" } });
  });

  it("draws every step with its state in the transcript card", () => {
    render(<PlanCard plan={items([["Read the spec", "completed"], ["Write the queue", "in_progress"], ["Test it", "pending"]])} />);
    expect(screen.getByText("1 of 3 done", { exact: false })).toBeTruthy();
    const list = screen.getAllByRole("listitem");
    expect(list.map((item) => item.className)).toEqual(["plan-item plan-completed", "plan-item plan-in_progress", "plan-item plan-pending"]);
    expect(list[1]?.textContent).toContain("in progress");
  });

  it("pins the progress above the composer, folded to the current step", () => {
    render(<PlanBar active plan={items([["Read", "completed"], ["Write", "in_progress"]])} />);
    expect(screen.getByText("Plan 1/2")).toBeTruthy();
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("leaves once every step is done and the turn is over", () => {
    const done = items([["Read", "completed"]]);
    const { rerender } = render(<PlanBar active plan={done} />);
    expect(screen.getByText("All steps done")).toBeTruthy();
    rerender(<PlanBar active={false} plan={done} />);
    expect(screen.queryByText("Plan 1/1")).toBeNull();
  });

  it("stays hidden until the plan changes", () => {
    const { rerender } = render(<PlanBar active plan={items([["Read", "in_progress"]])} />);
    fireEvent.click(screen.getByRole("button", { name: /Hide the plan/ }));
    expect(screen.queryByText("Plan 0/1")).toBeNull();
    rerender(<PlanBar active plan={items([["Read", "completed"], ["Write", "pending"]])} />);
    expect(screen.getByText("Plan 1/2")).toBeTruthy();
  });
});

describe("the queue strip", () => {
  const queue: QueueView = {
    items: [
      { id: "a", text: "then run the tests", extras: 0 },
      { id: "b", text: "and update the docs", extras: 2 },
    ],
    paused: null,
    sending: null,
  };

  beforeEach(() => {
    invoke.mockClear();
    useStore.setState({
      sessions: {
        s: { handle, projection: { ...emptyProjection(), queue }, workspaceId: "w" } as never,
      },
    });
  });

  it("lists what waits, in order, with what rides along", () => {
    render(<QueueStrip active canSteer queue={queue} sessionId="s" />);
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector(".queue-text")?.textContent)).toEqual(["then run the tests", "and update the docs"]);
    expect(screen.getByText("+2")).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Move up" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks the actor to move, send and drop", async () => {
    render(<QueueStrip active canSteer queue={queue} sessionId="s" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Steer in" })[1] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from the queue" })[0] as HTMLElement);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    const ops = invoke.mock.calls.map(([command, args]) => [command, (args as { request: { op: unknown } }).request.op]);
    expect(ops).toEqual([
      ["session_queue", { op: "move", id: "a", index: 1 }],
      ["session_queue", { op: "send_now", id: "b" }],
      ["session_queue", { op: "remove", id: "a" }],
    ]);
  });

  it("says that an agent that cannot steer is interrupted", () => {
    render(<QueueStrip active canSteer={false} queue={queue} sessionId="s" />);
    expect(screen.getAllByRole("button", { name: "Interrupt and send" })).toHaveLength(2);
  });

  it("says why a paused queue stopped and offers to resume or clear", () => {
    render(<QueueStrip active={false} canSteer queue={{ ...queue, paused: "the turn was cancelled" }} sessionId="s" />);
    expect(screen.getByRole("status").textContent).toContain("the turn was cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(invoke).toHaveBeenCalledWith("session_queue", { request: { handle, op: { op: "resume" } } });
  });

  it("takes a prompt back into the composer with its chips to edit", async () => {
    const restore = { mentions: [{ relativePath: "docs/a.md", mode: { mode: "path_reference" as const } }] };
    invoke.mockResolvedValueOnce({ removed: { id: "b", text: "and update the docs", extras: 1, restore }, queue: { items: [], paused: null, sending: null } });
    useStore.setState({ drafts: { s: "" }, mentions: { s: [] } });
    render(<QueueStrip active canSteer queue={queue} sessionId="s" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1] as HTMLElement);
    await vi.waitFor(() => expect(useStore.getState().drafts.s).toBe("and update the docs"));
    expect(useStore.getState().mentions.s).toEqual(restore.mentions);
  });
});
