/** `@tauri-apps/api/event` for the phone build: the Mac's events, as the bridge forwards them. */
import { bridge } from "../bridge";

export type UnlistenFn = () => void;
export type Event<T> = { event: string; id: number; payload: T };

let next = 1;

export async function listen<T>(name: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  return bridge().listen(name, (payload) => handler({ event: name, id: next++, payload: payload as T }));
}
