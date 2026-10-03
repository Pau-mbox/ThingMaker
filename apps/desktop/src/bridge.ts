/** Same typed UI commands; Android owns TLS and the API key. */
import { Channel as TauriChannel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, emit as tauriEmit, type Event, type EventCallback } from "@tauri-apps/api/event";
import { getCurrentWebview as tauriWebview } from "@tauri-apps/api/webview";

declare global { interface Window { ThingMakerNative?: { postMessage(message: string): void; onmessage?: (event: MessageEvent<string>) => void }; } }
export const isRemote = typeof window !== "undefined" && !!window.ThingMakerNative;
let connected = false;
let everConnected = false;
let sequence = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Map<string, Set<EventCallback<unknown>>>();
const channels = new Map<string, RemoteChannel<unknown>>();
const subscriptions = new Map<string, { command: string; args: Record<string, unknown> }>();
const connectionWaiters = new Set<() => void>();
function emit(name: string, payload: unknown) {
  for (const listener of listeners.get(name) ?? []) listener({ event: name, id: 0, payload });
}
function post(frame: unknown) { window.ThingMakerNative!.postMessage(JSON.stringify(frame)); }
function lost(message: string) {
  connected = false;
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject({ code: "OUTCOME_UNKNOWN", message, retry: "after_reconcile" }); }
  pending.clear();
}
if (isRemote) {
  window.ThingMakerNative!.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.ready) {
      connected = true;
      for (const wake of connectionWaiters) wake(); connectionWaiters.clear();
      if (everConnected) {
        for (const subscription of subscriptions.values()) void invoke(subscription.command, subscription.args).catch(() => undefined);
        emit("thingmaker://remote-reconnected", null);
      }
      everConnected = true;
      emit("thingmaker://connection", "connected");
    } else if (frame.status) {
      if (frame.status !== "connected") lost("Conexión interrumpida. Comprueba el estado antes de volver a enviar una acción.");
      emit("thingmaker://connection", frame.status);
    } else if (frame.channel) channels.get(frame.channel)?.onmessage(frame.payload);
    else if (frame.event) emit(frame.event, frame.payload);
    else if (frame.id) {
      const entry = pending.get(frame.id); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(frame.id);
      if (frame.error) entry.reject(frame.error); else entry.resolve(frame.result);
    }
  };
  post({ command: "hello" });
}
async function ready() {
  if (connected) return;
  await new Promise<void>((resolve, reject) => {
    const wake = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { connectionWaiters.delete(wake); reject({ code: "IO", message: "No se pudo conectar con ThingMaker en el PC", retry: "safe" }); }, 20000);
    connectionWaiters.add(wake);
  });
}
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isRemote) {
    const result = await tauriInvoke<T>(command, args);
    if (["workspace_remove", "workspace_trust", "session_open", "session_stop", "session_archive", "session_pin", "session_rename"].includes(command)) {
      try { void tauriEmit("thingmaker://remote-state-changed", null).catch(() => undefined); } catch { /* Event host may be shutting down. */ }
    }
    return result;
  }
  await ready();
  if (command.endsWith("_subscribe")) {
    const channel = args.onEvent as RemoteChannel<unknown>;
    subscriptions.set(channel.id, { command, args });
  }
  return new Promise<T>((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject({ code: "OUTCOME_UNKNOWN", message: "La operación tarda más de lo esperado. Revisa su estado antes de repetirla.", retry: "after_reconcile" }); }, 120000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    post({ id, command, args });
  });
}
class RemoteChannel<T> {
  id = `channel-${++sequence}`;
  onmessage: (message: T) => void = () => undefined;
  constructor() { channels.set(this.id, this as RemoteChannel<unknown>); }
  toJSON() { return { __remoteChannel: this.id }; }
}
export const Channel: typeof TauriChannel = (isRemote ? RemoteChannel : TauriChannel) as typeof TauriChannel;
export async function listen<T>(name: string, handler: EventCallback<T>): Promise<() => void> {
  if (!isRemote) return tauriListen<T>(name, handler);
  const set = listeners.get(name) ?? new Set(); listeners.set(name, set);
  set.add(handler as EventCallback<unknown>);
  return () => { set.delete(handler as EventCallback<unknown>); };
}
export function getCurrentWebview(): ReturnType<typeof tauriWebview> {
  if (!isRemote) return tauriWebview();
  return { onDragDropEvent: async (_handler: (event: Event<unknown>) => void) => () => undefined } as ReturnType<typeof tauriWebview>;
}
export function disconnectRemote() { if (isRemote) post({ command: "disconnect" }); }
