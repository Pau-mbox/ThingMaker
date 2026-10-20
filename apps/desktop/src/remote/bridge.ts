/**
 * The phone build's line to the computer: one WebSocket to the phone bridge,
 * speaking the renderer's own protocol. `call` is a command and its result;
 * a `Channel` argument becomes `channel` frames; the host's events arrive as
 * `event` frames.
 *
 * In the Android app the screens are bundled and the app opens the socket
 * itself — through the relay or the user's tunnel, with the Access headers —
 * and sends the hello with this phone's token, so the page never holds a
 * secret. In a desktop browser, for testing, the socket is the page's own, on
 * the origin that served it, with the token from `#token=` in the address.
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
type ChannelSink = { onmessage?: ((message: unknown) => void) | null };

declare global {
  interface Window {
    ThingMakerNative?: {
      notify?(title: string, body: string): void;
      connectionChanged?(state: string): void;
      unpair?(): void;
      /**
       * A WebSocket the app opens itself, with the Cloudflare Access headers
       * a page's own socket cannot carry. Its events come back through
       * `window.__thingmakerSocket`.
       */
      socketOpen?(path: string): string;
      socketSend?(id: string, data: string): void;
      socketClose?(id: string): void;
      /** Android's file picker; answered through `__thingmakerAnswer` with `[{name, dataBase64}]`. */
      pickFiles?(id: string): void;
      /** Android's "save as"; answered with the saved address, or null. */
      saveText?(id: string, name: string, content: string): void;
      macName?(): string;
      connectionMode?(): string;
      address?(): string;
      lockEnabled?(): boolean;
      setLockEnabled?(enabled: boolean): void;
      language?(): string;
      setLanguage?(language: string): void;
    };
    __thingmakerSocket?: (id: string, kind: "open" | "message" | "close", data: string) => void;
    __thingmakerAnswer?: (id: string, value: unknown) => void;
  }
}

const answers = new Map<string, (value: unknown) => void>();

/** Asks the Android app for something it answers later (a picker, a save). */
export function askNative<T>(ask: (id: string) => void): Promise<T> {
  window.__thingmakerAnswer ??= (id, value) => {
    answers.get(id)?.(value);
    answers.delete(id);
  };
  const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<T>((resolve) => {
    answers.set(id, resolve as (value: unknown) => void);
    ask(id);
  });
}

/** Why the app's socket would not open, as the connection banner says it. */
const CLOSE_REASON: Record<string, string> = {
  "relay-without-computer": "The relay is up, but ThingMaker on the computer is not connected to it.",
  "access-refused": "Cloudflare Access turned this phone away. Pair again to pick up the current token.",
  unreachable: "Can't reach the computer's address. Is this phone online?",
};

/** What the bridge needs of a socket: the browser's, or the app's. */
type Socket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: ((reason?: string) => void) | null;
  /** The app's socket: it sends the hello itself. */
  native: boolean;
};

const nativeSockets = new Map<string, Socket>();

/** The app's socket, when there is an app; the page's own otherwise. */
function openSocket(path: string): Socket {
  const native = window.ThingMakerNative;
  if (!native?.socketOpen || !native.socketSend || !native.socketClose) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const browser = new WebSocket(`${scheme}://${window.location.host}${path}`);
    const socket: Socket = { send: (data) => browser.send(data), close: () => browser.close(), onopen: null, onmessage: null, onclose: null, native: false };
    browser.onopen = () => socket.onopen?.();
    browser.onmessage = (message) => socket.onmessage?.(message);
    browser.onclose = () => socket.onclose?.();
    return socket;
  }
  window.__thingmakerSocket ??= (id, kind, data) => {
    const socket = nativeSockets.get(id);
    if (!socket) return;
    if (kind === "open") socket.onopen?.();
    else if (kind === "message") socket.onmessage?.({ data });
    else {
      nativeSockets.delete(id);
      socket.onclose?.(data || undefined);
    }
  };
  const id = native.socketOpen(path);
  const socket: Socket = {
    send: (data) => native.socketSend?.(id, data),
    close: () => native.socketClose?.(id),
    onopen: null,
    onmessage: null,
    onclose: null,
    native: true,
  };
  nativeSockets.set(id, socket);
  return socket;
}

const TOKEN_KEY = "thingmaker.remote.token";

function token(): string {
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

/** Calls running at once; the computer refuses more than 16 from one phone. */
const MAX_IN_FLIGHT = 8;

export class Bridge {
  private socket: Socket | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private channels = new Map<number, ChannelSink>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** Frames written while the socket was not open yet, with their call's id. */
  private queue: { text: string; id?: number }[] = [];
  /** Calls whose frame went out: their outcome is unknown if the line drops. */
  private sent = new Set<number>();
  /** Calls waiting for room under {@link MAX_IN_FLIGHT}. */
  private waiting: { start: () => void; reject: (error: unknown) => void }[] = [];
  private state: ConnectionState = "connecting";
  private watchers = new Set<(state: ConnectionState, message?: string) => void>();
  private everOpen = false;
  /** Why the line last failed to open, kept while it retries. */
  private lastReason: string | undefined;
  private retry = 1000;

  constructor() {
    this.open();
  }

  private open() {
    const socket = openSocket("/v1/ws");
    this.socket = socket;
    this.setState("connecting", this.lastReason);
    // The app's socket has said hello already, with the token it keeps.
    socket.onopen = () => {
      if (!socket.native) socket.send(JSON.stringify({ t: "hello", token: token(), client: "thingmaker-browser" }));
    };
    socket.onmessage = (message) => this.receive(String(message.data));
    socket.onclose = (reason) => {
      this.socket = null;
      // A call that went out may or may not have run: it is never sent
      // again by itself. One that never left can be tried again.
      for (const [id, pending] of this.pending) {
        if (this.sent.has(id)) pending.reject({ code: "IO", message: "The connection dropped while this was on its way; check before trying again.", retry: "user_action" });
        else pending.reject({ code: "IO", message: "Not sent: the connection to the computer dropped.", retry: "safe" });
      }
      for (const waiting of this.waiting.splice(0)) waiting.reject({ code: "IO", message: "Not sent: the connection to the computer dropped.", retry: "safe" });
      this.pending.clear();
      this.sent.clear();
      this.queue.length = 0;
      if (this.state === "denied") return;
      this.lastReason = reason ? CLOSE_REASON[reason] : undefined;
      this.setState("closed", this.lastReason);
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
        this.lastReason = undefined;
        this.retry = 1000;
        this.setState("open");
        for (const queued of this.queue.splice(0)) {
          this.socket?.send(queued.text);
          if (queued.id !== undefined) this.sent.add(queued.id);
        }
        return;
      case "denied":
        this.setState("denied", String(frame.message ?? "This phone is not paired."));
        this.socket?.close();
        return;
      case "result": {
        const pending = this.pending.get(Number(frame.id));
        if (!pending) return;
        this.pending.delete(Number(frame.id));
        this.sent.delete(Number(frame.id));
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(frame.error);
        this.startWaiting();
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

  private send(frame: { id?: number }) {
    const text = JSON.stringify(frame);
    if (this.socket && this.state === "open") {
      this.socket.send(text);
      if (frame.id !== undefined) this.sent.add(frame.id);
    } else this.queue.push({ text, ...(frame.id !== undefined ? { id: frame.id } : {}) });
  }

  /** Starts calls that waited for room, oldest first. */
  private startWaiting() {
    while (this.pending.size < MAX_IN_FLIGHT && this.waiting.length > 0) this.waiting.shift()?.start();
  }

  /**
   * Calls the computer. At most {@link MAX_IN_FLIGHT} run at once (the
   * screens load many panels together); the rest wait their turn.
   */
  call(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const start = () => {
        const id = this.next++;
        this.pending.set(id, { resolve, reject });
        this.send({ t: "call", id, cmd: command, args: this.wire(args) } as { id: number });
      };
      if (this.pending.size < MAX_IN_FLIGHT) start();
      else this.waiting.push({ start, reject });
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
