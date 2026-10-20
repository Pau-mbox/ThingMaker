import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "@thingmaker/contracts";

vi.mock("./ipc", () => ({ api: { sessionListOpen: vi.fn() } }));
import { api } from "./ipc";
import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { AttentionBanner } from "./components/Attention";

function live(id: string, generation = "1"): LiveSession {
  const handle = { id, attachmentGeneration: generation };
  return {
    handle, workspaceId: "w1", snapshot: { handle, agentSessionId: id } as Snapshot,
    projection: emptyProjection(), inFlightRequestId: null, steerInFlight: false,
    attention: "failed", openedAt: 0, turnStartedAt: null, lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useStore.setState({ sessions: {}, sessionOrder: [], records: {}, jobs: {}, view: { kind: "welcome" } });
});
afterEach(cleanup);

it("removes a session closed on another client and its stale failure banner", async () => {
  const session = live("closed");
  useStore.setState({ sessions: { closed: session }, sessionOrder: ["closed"], view: { kind: "session", sessionId: "closed" } });
  const records = useStore.getState().records;
  render(<AttentionBanner />);
  expect(screen.getByText(/1 session needs attention/)).toBeTruthy();
  vi.mocked(api.sessionListOpen).mockResolvedValue([]);
  await act(() => useStore.getState().rehydrate());
  expect(useStore.getState().sessions).toEqual({});
  expect(useStore.getState().sessionOrder).toEqual([]);
  expect(useStore.getState().view).toEqual({ kind: "workspace", workspaceId: "w1" });
  expect(useStore.getState().records).toBe(records);
  expect(screen.queryByText(/1 session needs attention/)).toBeNull();
});

it("keeps sessions opened or replaced while the host list is in flight", async () => {
  useStore.setState({ sessions: { same: live("same") }, sessionOrder: ["same"] });
  let resolve!: (value: Awaited<ReturnType<typeof api.sessionListOpen>>) => void;
  vi.mocked(api.sessionListOpen).mockReturnValue(new Promise((done) => { resolve = done; }));
  const refresh = useStore.getState().rehydrate();
  const replacement = live("same", "2");
  const added = live("new");
  useStore.setState({ sessions: { same: replacement, new: added }, sessionOrder: ["same", "new"] });
  resolve([]);
  await refresh;
  expect(useStore.getState().sessions).toEqual({ same: replacement, new: added });
  expect(useStore.getState().sessionOrder).toEqual(["same", "new"]);
});

it("keeps the current view and attachments if the host cannot be reached", async () => {
  const session = live("retained");
  useStore.setState({ sessions: { retained: session }, sessionOrder: ["retained"], view: { kind: "session", sessionId: "retained" } });
  vi.mocked(api.sessionListOpen).mockRejectedValue(new Error("offline"));
  await useStore.getState().rehydrate();
  expect(useStore.getState().sessions.retained).toBe(session);
  expect(useStore.getState().view).toEqual({ kind: "session", sessionId: "retained" });
});
