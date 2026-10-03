/**
 * The phone build's line to the Mac: one WebSocket to the bridge that served
 * this page, speaking the renderer's own protocol. `call` is a command and
 * its result; a `Channel` argument becomes `channel` frames; the host's
 * events arrive as `event` frames.
 *
 * The page comes from the Mac, so the socket is on the same origin. The
 * phone's token comes from the Android app (`window.ThingMakerNative`), or,
 * in a desktop browser for testing, from `#token=` in the address, kept in
 * local storage.
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
type ChannelSink = { onmessage?: ((message: unknown) => void) | null };

declare global {
  interface Window {
    ThingMakerNative?: {
      token(): string;
      notify?(title: string, body: string): void;
      connectionChanged?(state: string): void;
    };
  }
}

const TOKEN_KEY = "thingmaker.remote.token";

function token(): string {
  const native = window.ThingMakerNative?.token();
  if (native) return native;
  const fromHash = /token=([A-Za-z0-9_-]{20,})/.exec(window.location.hash)?.[1];
  if (fromHash) {
    try {
      localStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      // A private window: the token lives only in the address.
    }
    history.replaceState(null, "", window.location.pathname);
    return fromHash;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export type ConnectionState = "connecting" | "open" | "denied" | "closed";

class Bridge {
  private socket: WebSocket | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private channels = new Map<number, ChannelSink>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private queue: string[] = [];
  private state: ConnectionState = "connecting";
  private watchers = new Set<(state: ConnectionState, message?: string) => void>();
  private everOpen = false;
  private retry = 1000;

  constructor() {
    this.open();
  }

  private open() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/v1/ws`);
    this.socket = socket;
    this.setState("connecting");
    socket.onopen = () => socket.send(JSON.stringify({ t: "hello", token: token(), client: "thingmaker-phone" }));
    socket.onmessage = (message) => this.receive(String(message.data));
    socket.onclose = () => {
      this.socket = null;
      for (const [, pending] of this.pending) pending.reject({ code: "IO", message: "The connection to the Mac dropped.", retry: "safe" });
      this.pending.clear();
      if (this.state === "denied") return;
      this.setState("closed");
      // A reconnect starts the screens over: streams missed while away are
      // read again from the Mac rather than patched together here.
      setTimeout(() => (this.everOpen ? window.location.reload() : this.open()), this.retry);
      this.retry = Math.min(this.retry * 2, 15_000);
    };
  }

  private setState(state: ConnectionState, message?: string) {
    this.state = state;
    window.ThingMakerNative?.connectionChanged?.(state);
    for (const watcher of this.watchers) watcher(state, message);
  }

  watch(watcher: (state: ConnectionState, message?: string) => void): () => void {
    this.watchers.add(watcher);
    watcher(this.state);
    return () => this.watchers.delete(watcher);
  }

  private receive(text: string) {
    let frame: { t?: string; [key: string]: unknown };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.t) {
      case "welcome":
        this.everOpen = true;
        this.retry = 1000;
        this.setState("open");
        for (const queued of this.queue.splice(0)) this.socket?.send(queued);
        return;
      case "denied":
        this.setState("denied", String(frame.message ?? "This phone is not paired."));
        this.socket?.close();
        return;
      case "result": {
        const pending = this.pending.get(Number(frame.id));
        if (!pending) return;
        this.pending.delete(Number(frame.id));
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(frame.error);
        return;
      }
      case "channel":
        this.channels.get(Number(frame.cid))?.onmessage?.(frame.data);
        return;
      case "event":
        for (const listener of this.listeners.get(String(frame.name)) ?? []) listener(frame.payload);
        return;
      default:
    }
  }

  private send(frame: object) {
    const text = JSON.stringify(frame);
    if (this.socket && this.state === "open") this.socket.send(text);
    else this.queue.push(text);
  }

  call(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: "call", id, cmd: command, args: this.wire(args) });
    });
  }

  /** Channels in the arguments become ids the Mac streams to. */
  private wire(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value && typeof value === "object" && "__remoteChannel" in value) {
        const id = (value as { __remoteChannel: number }).__remoteChannel;
        this.channels.set(id, value as ChannelSink);
        out[key] = { __channel: id };
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  channelId(): number {
    return this.next++;
  }

  listen(name: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return () => set.delete(listener);
  }
}

let instance: Bridge | null = null;

export function bridge(): Bridge {
  instance ??= new Bridge();
  return instance;
}
