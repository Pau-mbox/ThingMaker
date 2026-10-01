/**
 * The documents a run reads and writes, gathered for the screen.
 *
 * Three kinds arrive over the life of a goal and used to be visible nowhere
 * together: the plan document the milestones were read from, the files and
 * documents the user's amendments pointed the agent at, and the notes the
 * agent itself keeps in the workspace. This module only lists them — what
 * each one is, where it lives, and how to fetch it. Fetching and rendering
 * belong to the component.
 */
import type { AmendmentRecord, OdysseyRecord, WorkspaceNotes } from "@thingmaker/contracts";
import { fileNameOf, isPlanDocument } from "./odysseyDocument";

export type DocumentSource =
  /** A file in the workspace, read through the explorer. */
  | { kind: "file"; path: string }
  /** The copy of the plan stored with the goal, for goals created before plans had a path. */
  | { kind: "stored_plan"; goalId: string }
  /** A document from outside the workspace, inlined into an amendment. */
  | { kind: "amendment"; amendmentId: string };

export type DocumentEntry = {
  id: string;
  group: "plan" | "added" | "notes";
  /** The file name, or the document's given name. */
  label: string;
  /** Where it is or where it came from, and how big or how old. */
  meta: string;
  /** How to fetch it; `null` for a folder, which is listed but not opened. */
  source: DocumentSource | null;
  /** Rendered as Markdown rather than shown as text. */
  markdown: boolean;
};

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function age(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dayOf(at: number): string {
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Everything the run has to read, in the order it arrived: the plan first,
 * then what amendments added, then the notes the agent keeps. A path named
 * twice — the plan document handed back as a reference, say — is listed once.
 */
export function documentEntries(input: {
  goal: Pick<OdysseyRecord, "id" | "planPath" | "planSource" | "planDocumentBytes">;
  amendments: AmendmentRecord[];
  notes: WorkspaceNotes | null | undefined;
  now: number;
}): DocumentEntry[] {
  const { goal, amendments, notes, now } = input;
  const entries: DocumentEntry[] = [];
  const seen = new Set<string>();

  if (goal.planPath) {
    seen.add(goal.planPath);
    entries.push({ id: "plan", group: "plan", label: fileNameOf(goal.planPath), meta: goal.planPath, source: { kind: "file", path: goal.planPath }, markdown: isPlanDocument(goal.planPath) });
  } else if (goal.planSource) {
    entries.push({
      id: "plan",
      group: "plan",
      label: goal.planSource,
      meta: `stored with the goal${goal.planDocumentBytes ? ` · ${kilobytes(goal.planDocumentBytes)}` : ""}`,
      source: { kind: "stored_plan", goalId: goal.id },
      markdown: isPlanDocument(goal.planSource),
    });
  }

  const kept = [...amendments].filter((record) => record.state !== "discarded").sort((a, b) => a.at - b.at);
  for (const record of kept) {
    if (record.documentSource) {
      entries.push({
        id: `doc-${record.id}`,
        group: "added",
        label: record.documentSource,
        meta: `attached ${dayOf(record.at)}${record.documentBytes ? ` · ${kilobytes(record.documentBytes)}` : ""} · not in the workspace`,
        source: { kind: "amendment", amendmentId: record.id },
        markdown: isPlanDocument(record.documentSource),
      });
    }
    for (const reference of record.refs) {
      if (seen.has(reference.path)) continue;
      seen.add(reference.path);
      const folder = reference.kind === "directory";
      entries.push({
        id: `ref-${record.id}-${reference.path}`,
        group: "added",
        label: fileNameOf(reference.path),
        meta: `${reference.path} · ${reference.detail} · added ${dayOf(record.at)}`,
        source: folder ? null : { kind: "file", path: reference.path },
        markdown: !folder && isPlanDocument(reference.path),
      });
    }
  }

  if (notes?.state) {
    entries.push({
      id: "state-note",
      group: "notes",
      label: fileNameOf(notes.state.path),
      meta: `${notes.state.path} · updated ${age(now - notes.state.modifiedAtUnixMs)}`,
      source: { kind: "file", path: notes.state.path },
      markdown: true,
    });
  }
  for (const note of notes?.agentNotes ?? []) {
    if (seen.has(note.path)) continue;
    seen.add(note.path);
    entries.push({ id: `agent-${note.path}`, group: "notes", label: fileNameOf(note.path), meta: `${note.path} · written ${age(now - note.modifiedAtUnixMs)}`, source: { kind: "file", path: note.path }, markdown: true });
  }

  return entries;
}

export const GROUP_LABEL: Record<DocumentEntry["group"], string> = {
  plan: "Plan",
  added: "Added along the way",
  notes: "The agent's notes",
};
