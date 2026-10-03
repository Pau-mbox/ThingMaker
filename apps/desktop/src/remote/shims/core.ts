/** `@tauri-apps/api/core` for the phone build: commands go to the Mac over the bridge. */
import { bridge } from "../bridge";

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return (await bridge().call(command, args ?? {})) as T;
}

/** A stream the Mac fills: `session_subscribe`'s events. */
export class Channel<T = unknown> {
  readonly __remoteChannel = bridge().channelId();
  onmessage: ((message: T) => void) | null = null;
}

export function isTauri(): boolean {
  return false;
}
