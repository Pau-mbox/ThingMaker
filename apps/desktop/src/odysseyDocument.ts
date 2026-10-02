/**
 * What a dropped document *is*, not what it says.
 *
 * Big Thing does not read a roadmap for milestones — the session's model does
 * that, in a planning turn the Rust engine runs. This module only measures the
 * file so the drop can be described honestly before anything is created, and
 * lifts the first heading as a suggested goal name, which is a name and not a
 * plan.
 */
import { MAX_PLAN_DOCUMENT_BYTES } from "./odysseyPlan";

export type DocumentSummary = {
  /** The first `#` heading, or the file name with its extension dropped. */
  suggestedTitle: string;
  bytes: number;
  lines: number;
  /** ATX headings outside fenced code, as a rough measure of structure. */
  headings: number;
  /** Set when the document is too large to hand to a model in one turn. */
  tooLarge: string | null;
};

const EXTENSIONS = /\.(md|markdown|mdx|txt)$/i;

/** Whether a dropped path is a document Big Thing will read at all. */
export function isPlanDocument(path: string): boolean {
  return EXTENSIONS.test(path);
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function summarize(text: string, filename: string): DocumentSummary {
  const lines = text.split("\n");
  let inFence = false;
  let headings = 0;
  let heading: string | null = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    headings += 1;
    if (heading === null && match[1]?.length === 1) heading = (match[2] ?? "").trim();
  }

  const bytes = new TextEncoder().encode(text).length;
  const fallback = fileNameOf(filename)
    .replace(EXTENSIONS, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return {
    suggestedTitle: (heading ?? fallback).slice(0, 120).trim() || "Imported plan",
    bytes,
    lines: lines.length,
    headings,
    tooLarge:
      bytes > MAX_PLAN_DOCUMENT_BYTES
        ? `That document is ${Math.round(bytes / 1024)} KB. Big Thing hands the whole plan to the model in one turn, so it has to be under ${MAX_PLAN_DOCUMENT_BYTES / 1024} KB — point it at the plan itself rather than a whole folder of notes.`
        : null,
  };
}
