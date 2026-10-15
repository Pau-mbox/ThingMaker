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
  it("keeps the paired phone bridge separate from the installed Remote protocol", async () => {
    const token = vi.fn(() => "paired-phone-token");
    window.ThingMakerNative = { token };
    const bridge = await import("./bridge");
    expect(bridge.isRemote).toBe(false);
    expect(window.ThingMakerNative.onmessage).toBeUndefined();
    expect(token).not.toHaveBeenCalled();
  });

  it("detects the installed Remote bridge and forwards kept session titles", async () => {
    const { bridge, sent, receive } = await remote();
    expect(bridge.isRemote).toBe(true);
    expect(sent[0]).toEqual({ command: "hello" });
    const titles: unknown[] = [];
    await bridge.listen("thingmaker://session-title", event => titles.push(event.payload));
    receive({ event: "thingmaker://session-title", payload: { agentSessionId: "session", title: "Kept title" } });
    expect(titles).toEqual([{ agentSessionId: "session", title: "Kept title" }]);
  });

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

  it("queues a startup burst below the host limit and drains every reply", async () => {
    const { bridge, sent, receive } = await remote();
    const requests = Array.from({ length: 40 }, (_, index) => bridge.invoke("session_snapshot", { index }));
    await Promise.resolve();
    expect(sent.filter(frame => frame.id)).toHaveLength(8);
    for (let index = 0; index < requests.length; index++) {
      const frames = sent.filter(frame => frame.id);
      expect(frames.length - index).toBeLessThanOrEqual(8);
      receive({ id: frames[index]!.id, result: index });
    }
    await expect(Promise.all(requests)).resolves.toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(sent.filter(frame => frame.id)).toHaveLength(40);
  });

  it("rejects unsent queued actions on disconnect without replaying them", async () => {
    const { bridge, sent, receive } = await remote();
    const requests = Array.from({ length: 12 }, (_, index) => bridge.invoke("session_submit", { request: { requestId: String(index) } }));
    const results = Promise.allSettled(requests);
    await Promise.resolve();
    receive({ status: "offline" });
    const settled = await results;
    for (let index = 0; index < settled.length; index++) {
      expect(settled[index]).toMatchObject({ status: "rejected", reason: { code: index < 8 ? "OUTCOME_UNKNOWN" : "IO", retry: index < 8 ? "after_reconcile" : "safe" } });
    }
    receive({ ready: true, apiVersion: 2 });
    await Promise.resolve();
    expect(sent.filter(frame => frame.command === "session_submit")).toHaveLength(8);
    const fresh = bridge.invoke("workspace_list");
    await Promise.resolve();
    receive({ id: sent.at(-1)!.id, result: [] });
    await expect(fresh).resolves.toEqual([]);
  });
});
