/**
 * ThingMaker's phone relay.
 *
 * The Mac keeps one WebSocket open to `/mac`; the phone talks to every other
 * path as if it were the Mac. Plain requests travel to the Mac as `req`
 * frames and come back as `res`, binary chunks and `end`; a phone's
 * WebSocket becomes a `ws_open` stream whose messages travel as `ws_msg`.
 * The relay understands nothing else: the Mac's bridge still checks every
 * phone's own token, and Cloudflare Access (configured on the Worker) keeps
 * everyone without the service token from reaching this code at all.
 *
 * One Durable Object holds the Mac's socket. The first Mac to connect
 * claims the relay with its key; only that key gets in afterwards.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
}

/** How long the Mac has to start answering a request. */
const ANSWER_MS = 30_000;
/** Largest request body the phone sends (pairing, and nothing big). */
const MAX_BODY = 1024 * 1024;
/** Headers that belong to one hop only. */
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "host"]);

type Pending = {
  resolve: (response: Response) => void;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName("mac")).fetch(request);
  },
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** A chunk from the Mac: one length byte, the stream id, then the bytes. */
function splitChunk(data: ArrayBuffer): { id: string; bytes: Uint8Array } {
  const view = new Uint8Array(data);
  const length = view[0] ?? 0;
  return { id: new TextDecoder().decode(view.subarray(1, 1 + length)), bytes: view.subarray(1 + length) };
}

export class Relay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mac") return this.acceptMac(request);
    const mac = this.mac();
    if (!mac) {
      return new Response("ThingMaker on the Mac is not connected to the relay. Open it there, with phone access on.", { status: 503 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.phoneSocket(request, url, mac);
    return this.forward(request, url, mac);
  }

  /** The Mac's current line: the newest open one, not one being replaced. */
  private mac(): WebSocket | undefined {
    return this.ctx
      .getWebSockets("mac")
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .at(-1);
  }

  private async acceptMac(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("The Mac connects with a WebSocket.", { status: 426 });
    const key = request.headers.get("x-thingmaker-mac") ?? "";
    if (key.length < 32) return new Response("Missing the Mac's key.", { status: 401 });
    const hash = await sha256(key);
    const owner = await this.ctx.storage.get<string>("macKeyHash");
    if (owner && owner !== hash) {
      return new Response("This relay belongs to another Mac. Deploy a fresh relay, or reset this one (wrangler delete, then deploy).", { status: 403 });
    }
    if (!owner) await this.ctx.storage.put("macKeyHash", hash);
    // A new connection from the Mac replaces the old one, and the phones'
    // streams went with the old one: they reconnect.
    for (const old of this.ctx.getWebSockets("mac")) old.close(4000, "replaced");
    for (const phone of this.ctx.getWebSockets("phone")) phone.close(1012, "the Mac reconnected");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["mac"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private phoneSocket(request: Request, url: URL, mac: WebSocket): Response {
    const id = crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["phone", `p:${id}`]);
    mac.send(JSON.stringify({ t: "ws_open", id, path: url.pathname + url.search, headers: headersOf(request.headers) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async forward(request: Request, url: URL, mac: WebSocket): Promise<Response> {
    const id = crypto.randomUUID();
    let body: string | null = null;
    if (request.body) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > MAX_BODY) return new Response("Request too large for the relay.", { status: 413 });
      body = base64(bytes);
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const answer = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => this.fail(id, 504, "The Mac did not answer in time."), ANSWER_MS);
      this.pending.set(id, { resolve, writer: writable.getWriter(), readable, timer, started: false });
    });
    mac.send(JSON.stringify({ t: "req", id, method: request.method, path: url.pathname + url.search, headers: headersOf(request.headers), body }));
    return answer;
  }

  private fail(id: string, status: number, message: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (!pending.started) pending.resolve(new Response(message, { status }));
    else void pending.writer.abort(message).catch(() => undefined);
  }

  private phone(id: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`p:${id}`)[0];
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(socket);
    if (!tags.includes("mac")) {
      // A phone's message, on to the Mac with the stream it belongs to.
      const id = tags.find((tag) => tag.startsWith("p:"))?.slice(2);
      const mac = this.mac();
      if (!id || !mac) return socket.close(1011, "the Mac is not connected");
      mac.send(JSON.stringify({ t: "ws_msg", id, data: typeof message === "string" ? message : new TextDecoder().decode(message) }));
      return;
    }
    if (typeof message !== "string") {
      // A body chunk: written, then acknowledged, so the Mac never runs
      // ahead of a slow phone by more than its window.
      const { id, bytes } = splitChunk(message);
      const pending = this.pending.get(id);
      if (!pending) return;
      try {
        await pending.writer.write(bytes);
        socket.send(JSON.stringify({ t: "ack", id }));
      } catch {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        socket.send(JSON.stringify({ t: "cancel", id }));
      }
      return;
    }
    let frame: { t?: string; id?: string; status?: number; headers?: Record<string, string>; data?: string; code?: number };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const id = frame.id ?? "";
    switch (frame.t) {
      case "res": {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.started = true;
        pending.resolve(new Response(pending.readable, { status: frame.status ?? 200, headers: frame.headers ?? {} }));
        return;
      }
      case "end": {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        await pending.writer.close().catch(() => undefined);
        return;
      }
      case "ws_msg":
        this.phone(id)?.send(frame.data ?? "");
        return;
      case "ws_close":
        this.phone(id)?.close(1000, "closed by the Mac");
        return;
      case "ping":
        socket.send(JSON.stringify({ t: "pong" }));
        return;
      default:
    }
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    const tags = this.ctx.getTags(socket);
    if (tags.includes("mac")) {
      // A line the Mac replaced closing late: the phones are on the new one.
      if (this.mac() && this.mac() !== socket) return;
      for (const phone of this.ctx.getWebSockets("phone")) phone.close(1012, "the Mac went away");
      for (const id of [...this.pending.keys()]) this.fail(id, 502, "The Mac went away.");
      return;
    }
    const id = tags.find((tag) => tag.startsWith("p:"))?.slice(2);
    if (id) this.mac()?.send(JSON.stringify({ t: "ws_close", id, code }));
    try {
      socket.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011);
  }
}
