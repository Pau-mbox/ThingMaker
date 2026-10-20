/**
 * Continuing a conversation on another provider: nothing happens until the
 * person sends, then a new session gets the brief and their message, and the
 * old one closes.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "@thingmaker/contracts";

const calls = vi.hoisted(() => ({ api: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("./ipc", () => ({
  api: new Proxy(calls.api, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)),
  }),
}));
import { api } from "./ipc";
import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { HANDOFF_SPLIT, withoutHandoff } from "./team";

const snapshot = (id: string, provider: string) =>
  ({ handle: { id, attachmentGeneration: "1" }, agentSessionId: `agent-${id}`, provider, toolCalls: {}, foreground: "idle" }) as unknown as Snapshot;

function live(id: string): LiveSession {
  const handle = { id, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.cards = [{ kind: "message", key: "u1", message: { key: "u1", role: "user", messageId: "u1", blocks: [{ type: "text", text: "Fix the login bug" }], contentUnknown: false } }];
  return {
    handle, workspaceId: "w1", snapshot: snapshot(id, "claude"), projection, inFlightRequestId: null, steerInFlight: false,
    attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE,
  };
}

const renameSession = vi.fn(async () => undefined);
const archiveSession = vi.fn(async () => undefined);

beforeEach(() => {
  for (const key of Object.keys(calls.api)) delete calls.api[key];
  renameSession.mockClear();
  archiveSession.mockClear();
  useStore.setState({
    sessions: { old: live("old") }, sessionOrder: ["old"], drafts: { old: "Now add a test" }, attachments: {}, mentions: {},
    pendingProvider: {}, continuations: {}, continuationHistory: {}, teams: {}, view: { kind: "session", sessionId: "old" },
    renameSession, archiveSession, loadOdyssey: vi.fn(async () => undefined), loadTeam: vi.fn(async () => undefined),
  } as never);
  vi.mocked(api.sessionOpen).mockResolvedValue({ handle: { id: "new", attachmentGeneration: "1" }, snapshot: snapshot("new", "codex") } as never);
  vi.mocked(api.sessionSnapshot).mockResolvedValue(snapshot("new", "codex"));
  vi.mocked(api.sessionHistory).mockResolvedValue([] as never);
  vi.mocked(api.sessionSubmit).mockResolvedValue({ outcome: { outcome: "accepted" } } as never);
});

it("forgets a provider choice that is the session's own", () => {
  useStore.getState().setPendingProvider("old", { provider: "codex" });
  expect(useStore.getState().pendingProvider.old).toEqual({ provider: "codex" });
  useStore.getState().setPendingProvider("old", { provider: "claude" });
  expect(useStore.getState().pendingProvider.old).toBeUndefined();
});

it("moves to the new provider only when the message is sent", async () => {
  useStore.getState().setPendingProvider("old", { provider: "codex", model: "gpt-6" });
  expect(api.sessionOpen).not.toHaveBeenCalled();
  await useStore.getState().send("old");

  expect(api.sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-6", mode: { mode: "new" } }));
  expect(useStore.getState().error).toBeNull();
  const prompt = vi.mocked(api.sessionSubmit).mock.calls[0]![2] as string;
  expect(prompt).toContain("Fix the login bug");
  expect(prompt.endsWith(`${HANDOFF_SPLIT}Now add a test`)).toBe(true);
  expect(withoutHandoff(prompt)).toBe("Now add a test");

  const state = useStore.getState();
  expect(state.sessions.old).toBeUndefined();
  expect(state.view).toEqual(expect.objectContaining({ kind: "session", sessionId: "new" }));
  expect(state.pendingProvider.old).toBeUndefined();
  expect(state.continuations["agent-new"]).toEqual({ fromAgentSessionId: "agent-old", fromProvider: "claude" });
  expect(state.continuationHistory.new).toHaveLength(1);
  expect(api.sessionStop).toHaveBeenCalledWith({ id: "old", attachmentGeneration: "1" });
  expect(archiveSession).toHaveBeenCalledWith("w1", "agent-old", true);
});

it("leaves everything as it was if the new session refuses the message", async () => {
  vi.mocked(api.sessionSubmit).mockResolvedValue({ outcome: { outcome: "rejected", error: { message: "no" } } } as never);
  useStore.getState().setPendingProvider("old", { provider: "codex" });
  await useStore.getState().send("old");
  const state = useStore.getState();
  expect(state.sessions.old).toBeTruthy();
  expect(state.sessions.new).toBeUndefined();
  expect(state.drafts.old).toBe("Now add a test");
  expect(state.pendingProvider.old).toEqual({ provider: "codex" });
  expect(api.sessionStop).toHaveBeenCalledWith({ id: "new", attachmentGeneration: "1" });
});

it("just starts on the chosen provider when nothing was said yet", async () => {
  const empty = live("old");
  empty.projection.cards = [];
  useStore.setState({ sessions: { old: empty } });
  useStore.getState().setPendingProvider("old", { provider: "codex", model: "gpt-6" });
  await useStore.getState().send("old");
  expect(api.sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-6" }));
  expect(vi.mocked(api.sessionSubmit).mock.calls[0]![2]).toBe("Now add a test");
  const state = useStore.getState();
  expect(state.sessions.old).toBeUndefined();
  expect(state.view).toEqual(expect.objectContaining({ kind: "session", sessionId: "new" }));
  expect(state.continuations).toEqual({});
  expect(state.continuationHistory).toEqual({});
  expect(renameSession).not.toHaveBeenCalled();
});

it("without a provider choice, sends as usual", async () => {
  await useStore.getState().send("old");
  expect(api.sessionOpen).not.toHaveBeenCalled();
});
