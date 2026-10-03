import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { delete window.ThingMakerNative; vi.resetModules(); });
async function remote() {
  vi.resetModules();
  const sent: { id?: string; command: string; args?: unknown }[] = [];
  const native = { postMessage: (message: string) => { sent.push(JSON.parse(message)); }, onmessage: (_event: MessageEvent<string>) => undefined as void };
  window.ThingMakerNative = native;
  const bridge = await import("./bridge");
  const receive = (frame: unknown) => native.onmessage!({ data: JSON.stringify(frame) } as MessageEvent<string>);
  receive({ ready: true, apiVersion: 2 });
  return { bridge, sent, receive };
}
describe("shared renderer duplex recovery", () => {
  it("receives a live actor channel independently of concurrent command replies", async () => {
    const { bridge, sent, receive } = await remote();
    const events: unknown[] = [];
    const channel = new bridge.Channel<unknown>(); channel.onmessage = event => events.push(event);
    const subscribe = bridge.invoke("session_subscribe", { handle: { id: "actor" }, onEvent: channel });
    const snapshot = bridge.invoke("session_snapshot", { handle: { id: "actor" } });
    await Promise.resolve();
    const subscribeFrame = sent.find(frame => frame.command === "session_subscribe")!;
    const snapshotFrame = sent.find(frame => frame.command === "session_snapshot")!;
    const channelId = JSON.parse(JSON.stringify(channel)).__remoteChannel;
    receive({ channel: channelId, payload: { sequence: "1", payload: { kind: "agent_message" } } });
    receive({ id: snapshotFrame.id, result: { foreground: "running" } });
    receive({ id: subscribeFrame.id, result: null });
    await expect(snapshot).resolves.toEqual({ foreground: "running" });
    await expect(subscribe).resolves.toBeNull();
    expect(events).toHaveLength(1);
  });
  it("never repeats an uncertain submission when reconnecting", async () => {
    const { bridge, sent, receive } = await remote();
    const promise = bridge.invoke("session_submit", { request: { requestId: "durable-id" } });
    const rejected = expect(promise).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", retry: "after_reconcile" });
    await Promise.resolve();
    receive({ status: "offline" });
    await rejected;
    receive({ ready: true, apiVersion: 2 });
    await Promise.resolve();
    expect(sent.filter(frame => frame.command === "session_submit")).toHaveLength(1);
  });
});
