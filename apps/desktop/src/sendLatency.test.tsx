import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentSnapshot, Mention, Snapshot, SubmissionOutcome } from "@thingmaker/contracts";

const calls = vi.hoisted(() => ({ api: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("./ipc", () => ({ api: new Proxy(calls.api, { get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)) }) }));
import { api } from "./ipc";
import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { applyEvent, emptyProjection } from "./projection";
import { PendingPrompt } from "./components/PendingPrompt";

const initial = useStore.getState();
const handle = { id: "s", attachmentGeneration: "1" };
const attachment = { id: "a", name: "photo.png" } as AttachmentSnapshot;
const mention: Mention = { relativePath: "src/app.ts", mode: { mode: "path_reference" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const mock of Object.values(calls.api)) mock.mockReset();
  const session: LiveSession = {
    handle, workspaceId: "w", snapshot: { provider: "claude" } as Snapshot, projection: emptyProjection(),
    inFlightRequestId: null, steerInFlight: false, attention: "none", openedAt: 0,
    turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ ...initial, sessions: { s: session }, drafts: { s: "Do the work" }, attachments: { s: [attachment] }, mentions: { s: [mention] } }, true);
});
afterEach(() => { cleanup(); useStore.setState(initial, true); });

it("shows the message and clears the composer before delivery resolves, without submitting twice", async () => {
  const delivery = deferred<{ requestId: string; outcome: SubmissionOutcome }>();
  vi.mocked(api.sessionSubmit).mockReturnValue(delivery.promise);
  render(<PendingPrompt sessionId="s" />);
  let sending!: Promise<void>;
  act(() => { sending = useStore.getState().send("s"); });
  expect(screen.getByText("Do the work")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Sending…");
  expect(screen.getByText("photo.png")).toBeTruthy();
  expect(screen.getByText("@src/app.ts")).toBeTruthy();
  expect(useStore.getState().drafts.s).toBe("");
  expect(useStore.getState().attachments.s).toEqual([]);
  expect(useStore.getState().mentions.s).toEqual([]);
  act(() => useStore.getState().setDraft("s", "Next instruction"));
  await useStore.getState().send("s");
  expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
  const requestId = useStore.getState().sessions.s!.inFlightRequestId!;
  await act(async () => {
    delivery.resolve({ requestId, outcome: { outcome: "accepted" } });
    await sending;
  });
  expect(useStore.getState().drafts.s).toBe("Next instruction");
  expect(screen.getByRole("status").textContent).toBe("Sent");
  act(() => {
    const session = useStore.getState().sessions.s!;
    applyEvent(session.projection, {
      apiVersion: 1, session: handle, sequence: "1",
      payload: { type: "update", kind: "user_message", messageId: `prompt-${requestId}`, content: [{ type: "text", text: "Do the work" }], replace: true, hasContent: true },
    });
    useStore.setState({ sessions: { s: { ...session, projection: { ...session.projection } } } });
  });
  expect(screen.queryByText("Do the work")).toBeNull();
  expect(useStore.getState().sessions.s!.projection.cards).toHaveLength(1);
});

it.each(["rejected", "outcome_unknown", "transport"])("restores a %s send without losing a newer draft or attachments", async (outcome) => {
  const delivery = deferred<Awaited<ReturnType<typeof api.sessionSubmit>>>();
  vi.mocked(api.sessionSubmit).mockReturnValue(delivery.promise);
  const sending = useStore.getState().send("s");
  useStore.getState().setDraft("s", "New draft");
  const newer = { id: "b", name: "next.png" } as AttachmentSnapshot;
  useStore.setState({ attachments: { s: [newer] } });
  if (outcome === "transport") delivery.reject(new Error("offline"));
  else delivery.resolve({ requestId: "r", outcome: { outcome, error: { code: "IO", message: "delivery failed", retry: "user_action" } } } as Awaited<ReturnType<typeof api.sessionSubmit>>);
  await sending;
  expect(useStore.getState().drafts.s).toBe("Do the work\n\nNew draft");
  expect(useStore.getState().attachments.s).toEqual([attachment, newer]);
  expect(useStore.getState().mentions.s).toEqual([mention]);
  expect(useStore.getState().sessions.s!.pendingPrompt).toBeUndefined();
  expect(useStore.getState().sessions.s!.inFlightRequestId).toBeNull();
  expect(useStore.getState().error).toBeTruthy();
  expect(api.sessionSubmit).toHaveBeenCalledTimes(1);
});

it("does not duplicate a queue entry when its event arrives before the command reply", async () => {
  const delivery = deferred<Awaited<ReturnType<typeof api.sessionEnqueue>>>();
  vi.mocked(api.sessionEnqueue).mockReturnValue(delivery.promise);
  render(<PendingPrompt sessionId="s" />);
  let sending!: Promise<void>;
  act(() => { sending = useStore.getState().enqueue("s"); });
  expect(screen.getByText("Do the work")).toBeTruthy();
  const requestId = useStore.getState().sessions.s!.inFlightRequestId!;
  act(() => {
    const session = useStore.getState().sessions.s!;
    useStore.setState({ sessions: { s: { ...session, projection: { ...session.projection, queue: { items: [{ id: requestId, text: "Do the work", extras: 2 }], sending: null, paused: null } } } } });
  });
  expect(screen.queryByText("Do the work")).toBeNull();
  act(() => useStore.getState().setDraft("s", "Another message"));
  await act(async () => { delivery.resolve({} as Awaited<ReturnType<typeof api.sessionEnqueue>>); await sending; });
  expect(useStore.getState().drafts.s).toBe("Another message");
  expect(useStore.getState().sessions.s!.pendingPrompt).toBeUndefined();
  expect(api.sessionEnqueue).toHaveBeenCalledWith(handle, requestId, "Do the work", ["a"], [mention], { attachments: [attachment], mentions: [mention] });
});

it("restores an unsuccessful enqueue", async () => {
  vi.mocked(api.sessionEnqueue).mockRejectedValue(new Error("offline"));
  await useStore.getState().enqueue("s");
  expect(useStore.getState().drafts.s).toBe("Do the work");
  expect(useStore.getState().attachments.s).toEqual([attachment]);
  expect(useStore.getState().sessions.s!.pendingPrompt).toBeUndefined();
});
