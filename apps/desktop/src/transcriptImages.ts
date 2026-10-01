/**
 * Which images the transcript shows, and where.
 *
 * Agents make and look at images in several ways, and none of them is an
 * image block on the wire: Claude Code reads a PNG by its absolute path,
 * Codex's image tool saves under `$CODEX_HOME/generated_images`, and either
 * names the file it wrote in its reply. So images are found by path, in
 * agent messages and in the tools that read, view or make files, and each
 * image is shown once, where it first appears. Shell commands are left out:
 * `ls`, `cp` and `sips` name images without showing them, and a command line
 * is not where anyone looks for the picture.
 */
import type { ToolPatch } from "@thingmaker/contracts";
import type { Card } from "./projection";

/** An image the renderer can read: inside the workspace, or one Codex generated. */
export type ImageRef = { kind: "workspace"; relative: string } | { kind: "generated"; path: string };

const EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i;
// Absolute paths (no spaces), then workspace-relative ones.
const ABSOLUTE = /(?:file:\/\/)?(\/(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:png|jpe?g|webp|gif))(?![\w/])/gi;
const RELATIVE = /(?:^|[\s"'`(\[])((?:\.\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\],;:!?])/gi;

export function keyOf(ref: ImageRef): string {
  return ref.kind === "workspace" ? `w:${ref.relative}` : `g:${ref.path}`;
}

/** Reads one path as an image the renderer may show, or null. */
export function imageRefFor(path: string, root: string): ImageRef | null {
  const clean = path.trim().replace(/^file:\/\//, "");
  if (!EXTENSION.test(clean) || /^[a-z]+:\/\//i.test(clean)) return null;
  if (clean.startsWith("/")) {
    const base = root.replace(/\/+$/, "");
    if (base && clean.startsWith(`${base}/`)) return { kind: "workspace", relative: clean.slice(base.length + 1) };
    if (/\/\.codex\/generated_images\//.test(clean)) return { kind: "generated", path: clean };
    return null;
  }
  const relative = clean.replace(/^\.\//, "");
  if (relative.split("/").includes("..")) return null;
  return { kind: "workspace", relative };
}

/** Every image a piece of text names, in order, without repeats. */
export function imageRefsIn(text: string, root: string): ImageRef[] {
  const found = new Map<string, ImageRef>();
  const add = (path: string | undefined) => {
    if (!path) return;
    const ref = imageRefFor(path, root);
    if (ref && !found.has(keyOf(ref))) found.set(keyOf(ref), ref);
  };
  const absolute = [...text.matchAll(ABSOLUTE)].map((match) => ({ index: match.index ?? 0, path: match[1] }));
  // Relative matches inside an absolute one are the same file seen again.
  const covered = (index: number) => absolute.some((entry) => index >= entry.index && index < entry.index + (entry.path?.length ?? 0) + 8);
  const relative = [...text.matchAll(RELATIVE)].filter((match) => !covered(match.index ?? 0)).map((match) => ({ index: match.index ?? 0, path: match[1] }));
  for (const entry of [...absolute, ...relative].sort((a, b) => a.index - b.index)) add(entry.path);
  return [...found.values()];
}

/** How much of a tool's input and output is read for paths. A file read or
 *  a test run returns megabytes; the paths worth showing are near the top. */
const SCAN_CHARS = 24_000;

/** The strings in a value, up to a budget, without serialising all of it. */
export function textOf(value: unknown, budget = SCAN_CHARS): string {
  const parts: string[] = [];
  let left = budget;
  const walk = (node: unknown, depth: number) => {
    if (left <= 0 || node === null || node === undefined || depth > 8) return;
    if (typeof node === "string") {
      const piece = node.length > left ? node.slice(0, left) : node;
      parts.push(piece);
      left -= piece.length;
    } else if (Array.isArray(node)) {
      for (const item of node) {
        if (left <= 0) break;
        walk(item, depth + 1);
      }
    } else if (typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) {
        if (left <= 0) break;
        walk(item, depth + 1);
      }
    }
  };
  walk(value, 0);
  return parts.join("\n");
}

/**
 * Each card's images, found once. Cards, messages and tool patches are
 * replaced, never changed in place, when an update arrives, so the object is
 * the cache key: a transcript that streams rescans only what changed, not
 * every tool output it has ever held.
 */
const scanned = new WeakMap<object, ImageRef[]>();

function cached(key: object, scan: () => ImageRef[]): ImageRef[] {
  let refs = scanned.get(key);
  if (!refs) {
    refs = scan();
    scanned.set(key, refs);
  }
  return refs;
}

/** Whether a tool's paths are worth showing as pictures. */
function showsImages(patch: ToolPatch): boolean {
  return patch.toolKind !== "execute";
}

/**
 * The images to show under each card, by card key: each image at its first
 * appearance only, so a file the worker made, the orchestrator read and the
 * reply named is one picture, not three.
 */
export function assignImages(cards: Card[], tools: Map<string, ToolPatch>, root: string): Map<string, ImageRef[]> {
  const seen = new Set<string>();
  const out = new Map<string, ImageRef[]>();
  const take = (key: string, refs: ImageRef[]) => {
    const fresh = refs.filter((ref) => !seen.has(keyOf(ref)));
    for (const ref of fresh) seen.add(keyOf(ref));
    if (fresh.length > 0) out.set(key, fresh.slice(0, 6));
  };
  for (const card of cards) {
    if (card.kind === "message" && card.message.role === "agent") {
      const message = card.message;
      take(card.key, cached(message, () => imageRefsIn(textOf(message.blocks.map((block) => (block.type === "text" ? block.text : ""))), root)));
    } else if (card.kind === "tool") {
      const patch = tools.get(card.toolCallId);
      if (!patch || !showsImages(patch)) continue;
      take(card.key, cached(patch, () => imageRefsIn([textOf(patch.rawInput, 8_000), textOf(patch.rawOutput), textOf(patch.content)].join("\n"), root)));
    }
  }
  return out;
}
