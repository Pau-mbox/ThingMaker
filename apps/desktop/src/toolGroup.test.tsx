/**
 * The transcript folds a run of tool calls into one line: what the run did,
 * in plain words, with failures and edits still in view and the raw call a
 * click away. While the turn runs, the line says what is happening now.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, ToolPatch } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection, type Card } from "./projection";
import { ToolGroup } from "./components/ToolGroup";
import { groupCards } from "./components/SessionPanel";

const ROOT = "/w/app";
const tool = (id: string, fields: Partial<ToolPatch>): ToolPatch => ({ toolCallId: id, title: null, status: "completed", toolKind: "execute", content: null, rawInput: null, rawOutput: null, name: null, locations: null, meta: null, present: [], cleared: [], ...fields });
const patches = [
  tool("t1", { toolKind: "read", title: `Read ${ROOT}/Docs/GAME.md` }),
  tool("t2", { title: `cd ${ROOT}; grep -rn "tooltip" Assets`, rawInput: { command: `cd ${ROOT}; grep -rn "tooltip" Assets` } }),
  tool("t3", { title: "pnpm test", rawInput: { command: "pnpm test" }, rawOutput: { exitCode: 1, output: "1 failed" } }),
  tool("t4", { toolKind: "edit", title: `Edit ${ROOT}/Docs/GAME.md`, locations: [{ path: `${ROOT}/Docs/GAME.md` }] }),
];
const cards: Card[] = patches.map((patch) => ({ kind: "tool", key: `k-${patch.toolCallId}`, toolCallId: patch.toolCallId as string }));

function seed(running = false) {
  const handle = { id: "s1", attachmentGeneration: "1" };
  const projection = emptyProjection();
  for (const patch of patches) projection.toolCalls.set(patch.toolCallId as string, patch);
  if (running) projection.toolCalls.set("t5", tool("t5", { status: "in_progress", title: `sed -n 1,40p ${ROOT}/a.cs`, rawInput: { command: `sed -n 1,40p ${ROOT}/a.cs` } }));
  const session = { handle, workspaceId: "w1", snapshot: { handle, provider: "codex" } as unknown as Snapshot, projection, inFlightRequestId: null, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: Date.now(), usage: EMPTY_SESSION_USAGE } as unknown as LiveSession;
  useStore.setState({ sessions: { s1: session }, workspaces: [{ id: "w1", canonicalRoot: ROOT, displayPath: ROOT } as never] });
}

const renderGroup = (live = false, extra: Card[] = []) =>
  render(<ToolGroup cards={[...cards, ...extra]} live={live} renderCard={(card) => <span key={card.key}>{card.key}</span>} renderDetail={(patch) => <pre>{JSON.stringify(patch.rawInput)}</pre>} sessionId="s1" />);

beforeEach(() => seed());
afterEach(cleanup);

describe("a folded run of tool calls", () => {
  it("is one line with what it did, and keeps failures and edits in view", () => {
    renderGroup();
    expect(screen.getByText("Worked")).toBeTruthy();
    expect(screen.getByText("· edited 1 file, read 1 file, searched 1 time, ran 1 command")).toBeTruthy();
    expect(screen.getByText("4 steps")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
    // Folded: the failure and the edit are shown, the read and the search are not.
    expect(screen.getByText("Edit Docs/GAME.md")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryByText("Read Docs/GAME.md")).toBeNull();
  });

  it("opens on every step, and a step on its raw call", () => {
    renderGroup();
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
    expect(screen.getByText("Read Docs/GAME.md")).toBeTruthy();
    expect(screen.getByText("Assets")).toBeTruthy();
    expect(screen.getByText("for “tooltip”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Read Docs\/GAME.md/ }));
    expect(screen.getByText("null")).toBeTruthy();
  });

  it("says what is happening now while the turn runs", () => {
    seed(true);
    renderGroup(true, [{ kind: "tool", key: "k-t5", toolCallId: "t5" }]);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("· reading a.cs")).toBeTruthy();
    expect(screen.getByText("5 steps")).toBeTruthy();
  });
});

describe("grouping the transcript", () => {
  it("puts the tool calls between two messages in one run, runtime lines included", () => {
    const message = (key: string, role: "user" | "agent") => ({ kind: "message", key, message: { role, messageId: key, blocks: [], contentUnknown: false } }) as unknown as Card;
    const groups = groupCards([
      message("m1", "user"),
      { kind: "runtime", key: "r1", text: "starting" },
      cards[0] as Card,
      { kind: "permission", key: "p1", requestId: "q", title: null, decision: "allowed" },
      cards[1] as Card,
      message("m2", "agent"),
      cards[2] as Card,
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["single", "work", "single", "work"]);
    expect(groups[1]?.kind === "work" && groups[1].cards.map((card) => card.key)).toEqual(["r1", "k-t1", "p1", "k-t2"]);
  });
});
