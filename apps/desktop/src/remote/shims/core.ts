/**
 * `@tauri-apps/api/core` for the phone build: commands go to the computer
 * over the bridge, except those that would open something on the computer's
 * screen, which the phone does itself — confirmations, saving a file,
 * picking attachments — or does not offer.
 */
import { askNative, bridge } from "../bridge";

type Args = Record<string, unknown> | undefined;
type Picked = { name: string; dataBase64: string };

/** Refused here, so nothing waits on the computer's screen. */
function notOnThePhone(what: string): never {
  throw { code: "UNSUPPORTED", message: `${what} is done on the computer, not from the phone.`, retry: "never" };
}

/** Commands answered on the phone; undefined when the computer answers. */
const LOCAL: Record<string, (args: Args) => Promise<unknown>> = {
  async confirm_dialog(args) {
    const request = (args?.request ?? {}) as { title?: string; message?: string };
    return window.confirm([request.title, request.message].filter(Boolean).join("\n\n"));
  },
  async save_text_file(args) {
    const request = (args?.request ?? {}) as { suggestedName?: string; content?: string };
    const name = request.suggestedName ?? "ThingMaker.txt";
    const content = request.content ?? "";
    const native = window.ThingMakerNative;
    if (native?.saveText) return askNative<string | null>((id) => native.saveText?.(id, name, content));
    // A desktop browser, testing: a download.
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    link.download = name;
    link.click();
    return name;
  },
  async attachment_pick() {
    const native = window.ThingMakerNative;
    if (!native?.pickFiles) return [];
    const files = await askNative<Picked[]>((id) => native.pickFiles?.(id));
    // Each file goes to the computer, which keeps it as an attachment.
    const added = [];
    for (const file of files) added.push(await bridge().call("attachment_add_bytes", { request: file }));
    return added;
  },
  async open_external(args) {
    // Leaving the screens opens it outside the app.
    window.location.href = String(args?.url ?? "");
    return null;
  },
  async workspace_pick() {
    return null;
  },
  async attachment_add_paths() {
    return notOnThePhone("Attaching files by path");
  },
  async reveal_in_finder() {
    return notOnThePhone("Showing a file in its folder");
  },
  async open_in_editor() {
    return notOnThePhone("Opening a file in an editor");
  },
};

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const local = LOCAL[command];
  if (local) return (await local(args)) as T;
  return (await bridge().call(command, args ?? {})) as T;
}

/** A stream the computer fills: `session_subscribe`'s events. */
export class Channel<T = unknown> {
  readonly __remoteChannel = bridge().channelId();
  onmessage: ((message: T) => void) | null = null;
}

export function isTauri(): boolean {
  return false;
}
