/**
 * The Markdown documents a turn produced or pointed at, so the transcript can
 * show each one as a document — a preview, open it, show it in Finder, plan
 * a Big Thing from it — rather than a path in a tool call.
 *
 * Paths come from what the tools reported writing and from what the agent's
 * message names. Only workspace-relative paths are returned; a path outside
 * the workspace has nothing the desktop may open.
 */
import type { ToolPatch } from "@thingmaker/contracts";
import { editedFilesIn } from "./toolSummary";
import { relativePath } from "./toolSteps";

const DOC = /\.(md|markdown|mdx)$/i;

export function isMarkdownPath(path: string): boolean {
  return DOC.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path inside the workspace, relative to it; null for anything outside. */
export function insideWorkspace(path: string, roots: string[]): string | null {
  const clean = path.trim().replace(/^file:\/\//, "");
  if (!clean || /^[a-z]+:\/\//i.test(clean)) return null;
  if (clean.startsWith("/")) {
    const relative = relativePath(clean, roots);
    return relative === clean || relative === "." ? null : relative;
  }
  const trimmed = clean.replace(/^\.\//, "");
  return trimmed.startsWith("../") ? null : trimmed;
}

/** Markdown files a tool call wrote. */
export function docsWrittenBy(patch: ToolPatch, roots: string[]): string[] {
  const paths: string[] = [];
  // A shell command can write a file too; only its reported writes count.
  if (patch.toolKind === "edit" || patch.toolKind === "move") collectEdit(patch, paths);
  for (const file of editedFilesIn(patch.rawOutput)) if (file.status !== "deleted") paths.push(file.path);
  return [...new Set(paths)].filter(isMarkdownPath).map((path) => insideWorkspace(path, roots)).filter((path): path is string => path !== null);
}

function collectEdit(patch: ToolPatch, paths: string[]) {
  if (Array.isArray(patch.locations)) for (const location of patch.locations) if (isRecord(location) && typeof location.path === "string") paths.push(location.path);
  const input = isRecord(patch.rawInput) ? patch.rawInput : null;
  for (const key of ["file_path", "path", "filePath", "notebook_path"]) if (typeof input?.[key] === "string") paths.push(input[key] as string);
  if (Array.isArray(input?.changes)) for (const change of input.changes as unknown[]) if (isRecord(change) && typeof change.path === "string" && change.kind !== "delete") paths.push(change.path);
}

/** Markdown paths an agent's message names, in code spans, links or plain text. */
export function docsNamedIn(text: string, roots: string[]): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s`(["'<])((?:~|\.{1,2})?\/?[\w@+\-./]*[\w\-]\.(?:md|markdown|mdx))(?=$|[\s`)\]"'>,:;!?]|\.(?:\s|$))/gim;
  for (const match of text.matchAll(pattern)) {
    const path = insideWorkspace(match[1] as string, roots);
    if (path && !path.startsWith("~") && !found.includes(path)) found.push(path);
  }
  return found.slice(0, 4);
}
