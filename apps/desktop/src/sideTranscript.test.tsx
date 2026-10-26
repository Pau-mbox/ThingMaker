/**
 * The Side Transcript: a copy of a session, with its whole conversation as
 * context, shown inside it. These check that it is opened as a copy (and as
 * a summary where the provider cannot copy), that it is kept per session and
 * stays out of the session list, and that what it passes to the main session
 * reads as its own and not as the user's.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord, WorkspaceRecord } from "@thingmaker/contracts";

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

import { splitSideNotes } from "./bigThingTurns";
import { api } from "./ipc";
import { emptyProjection } from "./projection";
import { latestSide, useStore, type LiveSession } from "./store";
import { Sidebar } from "./components/Sidebar";
import { SideNotesCard } from "./components/BigThingLinks";

const initial = useStore.getState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.setState(initial, true);
});

const workspace: WorkspaceRecord = { id: "w1", environmentId: "e1", canonicalRoot: "/r", displayPath: "/r", workspaceHash: "h", trustState: "trusted_local", createdAt: 0 };

function record(overrides: Partial<SessionRecord> & { agentSessionId: string }): SessionRecord {
  return { id: `row-${overrides.agentSessionId}`, workspaceId: "w1", origin: "desktop", archiveState: "active", pinned: false, provider: "claude", createdAt: 0, ...overrides };
}

function mainSession(provider: "claude" | "gemini" = "claude"): LiveSession {
  const projection = emptyProjection();
  projection.cards.push({ kind: "message", key: "user|m1", message: { key: "user|m1", role: "user", messageId: "m1", blocks: [{ type: "text", text: "Build the login screen" }], contentUnknown: false } });
  return {
    handle: { id: "main", attachmentGeneration: "1" },
    workspaceId: "w1",
    snapshot: { agentSessionId: "agent-main", provider, configOptions: [{ configId: "model", currentValue: "opus" }] },
    projection,
    attention: "none",
  } as unknown as LiveSession;
}

/** Stops `openSide` right after the open request, so only it is examined. */
const STOP = new Error("stop after the open request");

describe("opening a side transcript", () => {
  it("copies the main session, on its provider and model, linked to it", async () => {
    useStore.setState({ workspaces: [workspace], sessions: { main: mainSession() }, records: { w1: [] } });
    const open = vi.spyOn(api, "sessionOpen").mockRejectedValue(STOP);
    await useStore.getState().openSide("main");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ workspaceId: "w1", provider: "claude", model: "opus", sideOf: "main", mode: { mode: "fork", session_id: "agent-main" } });
    expect(useStore.getState().sideOpening.main).toBe(false);
  });

  it("starts a new session from a summary where the provider cannot copy one", async () => {
    useStore.setState({ workspaces: [workspace], sessions: { main: mainSession() }, records: { w1: [] } });
    const open = vi.spyOn(api, "sessionOpen").mockRejectedValueOnce({ code: "UNSUPPORTED", message: "no fork" }).mockRejectedValue(STOP);
    await useStore.getState().openSide("main");
    expect(open.mock.calls.map((call) => call[0].mode.mode)).toEqual(["fork", "new"]);
    expect(open.mock.calls[1]![0].sideOf).toBe("main");
  });

  it("never asks Antigravity for a copy", async () => {
    useStore.setState({ workspaces: [workspace], sessions: { main: mainSession("gemini") }, records: { w1: [] } });
    const open = vi.spyOn(api, "sessionOpen").mockRejectedValue(STOP);
    await useStore.getState().openSide("main");
    expect(open.mock.calls.map((call) => call[0].mode.mode)).toEqual(["new"]);
  });

  it("resumes the side transcript the session already has", async () => {
    const records = [
      record({ agentSessionId: "agent-main" }),
      record({ agentSessionId: "side-old", origin: "side", parentSessionId: "row-agent-main", createdAt: 1 }),
      record({ agentSessionId: "side-new", origin: "side", parentSessionId: "row-agent-main", createdAt: 2 }),
    ];
    useStore.setState({ workspaces: [workspace], sessions: { main: mainSession() }, records: { w1: records } });
    vi.spyOn(api, "sessionListOpen").mockResolvedValue([]);
    const open = vi.spyOn(api, "sessionOpen").mockRejectedValue(STOP);
    await useStore.getState().openSide("main");
    expect(open.mock.calls[0]![0]).toMatchObject({ mode: { mode: "resume", session_id: "side-new" }, sideOf: "main" });
    // Asked for a fresh one, it copies again instead.
    await useStore.getState().openSide("main", true);
    expect(open.mock.calls[1]![0].mode).toEqual({ mode: "fork", session_id: "agent-main" });
  });

  it("finds a session's newest side transcript, and only its own", () => {
    const records = [
      record({ agentSessionId: "a", origin: "side", parentSessionId: "row-x", createdAt: 5 }),
      record({ agentSessionId: "b", origin: "side", parentSessionId: "row-main", createdAt: 1 }),
      record({ agentSessionId: "c", origin: "side", parentSessionId: "row-main", createdAt: 3 }),
      record({ agentSessionId: "d", origin: "desktop", parentSessionId: "row-main", createdAt: 9 }),
    ];
    expect(latestSide(records, "row-main")?.agentSessionId).toBe("c");
    expect(latestSide(records, "row-none")).toBeUndefined();
  });
});

describe("the side transcript in the rest of the app", () => {
  it("is not listed as a session of its own", () => {
    useStore.setState({
      workspaces: [workspace],
      inspections: { w1: { record: workspace, trustStale: false } as never },
      sessions: {},
      sessionOrder: [],
      records: { w1: [record({ agentSessionId: "9e08bad3-0015-4de2-9591-53bf1e167ef4" }), record({ agentSessionId: "51de0000-0015-4de2-9591-53bf1e167ef4", origin: "side", parentSessionId: "row-9e08bad3-0015-4de2-9591-53bf1e167ef4" })] },
    });
    render(<Sidebar />);
    expect(screen.getByText(/Session 9e08bad3/i)).toBeTruthy();
    expect(screen.queryByText(/51de0000/)).toBeNull();
  });

  it("reads what it passed to the main session as its own, apart from the user's words", () => {
    const text = "[From the side transcript] The Big Thing plan was changed from the side transcript: + Add milestone 3\n[From the side transcript] Task 2.1 \"Wire the API\" was marked done.\nNow carry on with the tests";
    expect(splitSideNotes(text)).toEqual({
      notes: ["The Big Thing plan was changed from the side transcript: + Add milestone 3", 'Task 2.1 "Wire the API" was marked done.'],
      rest: "Now carry on with the tests",
    });
    expect(splitSideNotes("A message that merely mentions [From the side transcript]")).toEqual({ notes: [], rest: "A message that merely mentions [From the side transcript]" });
    const { notes, rest } = splitSideNotes(text);
    render(<SideNotesCard notes={notes} own={rest} />);
    expect(screen.getByText("Side Transcript → this session: 2 notes")).toBeTruthy();
    expect(screen.getByText("Now carry on with the tests")).toBeTruthy();
  });
});
