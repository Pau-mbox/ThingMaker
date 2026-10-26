/**
 * The phone's line to the computer: a few calls at a time, and never a
 * request sent again on its own after the line drops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "./remote/bridge";

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: { t: string; id?: number; cmd?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.onclose?.();
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  localStorage.setItem("thingmaker.remote.token", "t".repeat(32));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connected(): { bridge: Bridge; socket: FakeSocket } {
  const bridge = new Bridge();
  const socket = FakeSocket.last!;
  socket.onopen?.();
  socket.receive({ t: "welcome" });
  return { bridge, socket };
}

const calls = (socket: FakeSocket) => socket.sent.filter((frame) => frame.t === "call");

describe("the phone's bridge", () => {
  it("runs at most eight calls at once and starts the rest as answers come", () => {
    const { bridge, socket } = connected();
    for (let i = 0; i < 12; i++) void bridge.call("session_snapshot").catch(() => undefined);
    expect(calls(socket)).toHaveLength(8);
    socket.receive({ t: "result", id: calls(socket)[0]!.id, ok: true, value: null });
    expect(calls(socket)).toHaveLength(9);
  });

  it("marks a call that went out as uncertain when the line drops, and one that never left as safe", async () => {
    const { bridge, socket } = connected();
    const outcomes: unknown[] = [];
    for (let i = 0; i < 9; i++) void bridge.call("session_submit").catch((error) => outcomes.push(error));
    socket.close();
    await Promise.resolve();
    const retries = outcomes.map((error) => (error as { retry: string }).retry);
    expect(retries.filter((retry) => retry === "user_action")).toHaveLength(8);
    expect(retries.filter((retry) => retry === "after_reconcile")).toHaveLength(1);
  });

  it("never sends a request again after its promise failed", async () => {
    const bridge = new Bridge();
    const first = FakeSocket.last!;
    first.onopen?.();
    // Still waiting for the welcome: the call is queued, not sent.
    const failed = bridge.call("session_submit").catch((error) => error);
    first.close();
    expect(((await failed) as { retry: string }).retry).toBe("after_reconcile");
    vi.advanceTimersByTime(20_000);
    const second = FakeSocket.last!;
    expect(second).not.toBe(first);
    second.onopen?.();
    second.receive({ t: "welcome" });
    expect(calls(second)).toHaveLength(0);
  });

  it("tries again when the computer never welcomes the line", () => {
    const bridge = new Bridge();
    const first = FakeSocket.last!;
    first.onopen?.();
    const states: string[] = [];
    bridge.watch((state) => states.push(state));
    vi.advanceTimersByTime(20_000);
    expect(states).toContain("closed");
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.last).not.toBe(first);
  });

  it("pings a quiet line and gives up on one that stays silent", () => {
    const { bridge, socket } = connected();
    const states: string[] = [];
    bridge.watch((state) => states.push(state));
    vi.advanceTimersByTime(25_000);
    expect(socket.sent.some((frame) => frame.t === "ping")).toBe(true);
    socket.receive({ t: "pong" });
    vi.advanceTimersByTime(45_000);
    expect(states).not.toContain("closed");
    vi.advanceTimersByTime(10_000);
    expect(states).toContain("closed");
  });
});
