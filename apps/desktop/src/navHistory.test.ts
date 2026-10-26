/**
 * Back and forward. The store records every move after the fact, so these
 * drive it the way the UI does — setView, selectSession, setSessionTab — and
 * check that each place is one entry, that going back and forward lands on
 * the panel that was showing, and that a closed session is stepped over.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { NAV_LIMIT, recordVisit } from "./navHistory";
import { useStore, type LiveSession } from "./store";

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const fakeSession = (id: string) => ({ handle: { id }, workspaceId: "w", attention: "none" }) as unknown as LiveSession;

function withSessions(...ids: string[]) {
  useStore.setState({ sessions: Object.fromEntries(ids.map((id) => [id, fakeSession(id)])) });
}

const where = () => {
  const { view, sessionTab } = useStore.getState();
  return view.kind === "session" ? `${view.sessionId}/${sessionTab}` : view.kind;
};

describe("navigation history", () => {
  it("records a session switch as one visit, on the transcript", async () => {
    withSessions("a", "b");
    const state = useStore.getState();
    state.selectSession("a");
    await tick();
    state.setSessionTab("odyssey");
    await tick();
    state.selectSession("b");
    await tick();
    const { navHistory } = useStore.getState();
    expect(navHistory.map((e) => (e.view.kind === "session" ? `${e.view.sessionId}/${e.tab}` : e.view.kind))).toEqual([
      "welcome",
      "a/transcript",
      "a/odyssey",
      "b/transcript",
    ]);
  });

  it("goes back to the panel that was showing, and forward again", async () => {
    withSessions("a", "b");
    const state = useStore.getState();
    state.selectSession("a");
    await tick();
    state.setSessionTab("odyssey");
    await tick();
    state.setView({ kind: "settings" });
    await tick();

    state.navigate(-1);
    await tick();
    expect(where()).toBe("a/odyssey");
    state.navigate(-1);
    await tick();
    expect(where()).toBe("a/transcript");
    state.navigate(1);
    await tick();
    expect(where()).toBe("a/odyssey");
    // Going back does not grow the history.
    expect(useStore.getState().navHistory).toHaveLength(4);
  });

  it("drops the forward places when you go somewhere new", async () => {
    withSessions("a", "b");
    const state = useStore.getState();
    state.selectSession("a");
    await tick();
    state.selectSession("b");
    await tick();
    state.navigate(-1);
    await tick();
    state.setView({ kind: "teams" });
    await tick();
    state.navigate(1);
    await tick();
    expect(where()).toBe("teams");
  });

  it("steps over a session that has since closed", async () => {
    withSessions("a", "b");
    const state = useStore.getState();
    state.selectSession("a");
    await tick();
    state.selectSession("b");
    await tick();
    state.setView({ kind: "teams" });
    await tick();
    withSessions("a");
    state.navigate(-1);
    await tick();
    expect(where()).toBe("a/transcript");
  });

  it("keeps a bounded history", () => {
    let history = [{ view: { kind: "welcome" } as const, tab: null }] as Parameters<typeof recordVisit>[0];
    let index = 0;
    for (let i = 0; i < NAV_LIMIT + 10; i += 1) {
      const next = recordVisit(history, index, { view: { kind: "session", sessionId: `s${i}` }, tab: "transcript" })!;
      history = next.history;
      index = next.index;
    }
    expect(history).toHaveLength(NAV_LIMIT);
    expect(index).toBe(NAV_LIMIT - 1);
  });
});
