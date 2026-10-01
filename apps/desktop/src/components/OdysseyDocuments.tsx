/**
 * The documents a run reads and writes, listed in the Super Thing rail and
 * readable in place.
 *
 * The plan document, the files and documents the user's amendments pointed
 * the agent at, and the notes the agent keeps were each reachable only from
 * somewhere else — the Files tab, the amendment dialog, the transcript. A
 * long-horizon run is followed from this tab, so they are read from here.
 * Nothing here is editable: this is a reader of what the run has.
 */
import { useEffect, useMemo, useState } from "react";
import type { OdysseyView } from "@thingmaker/contracts";
import { api } from "../ipc";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { GROUP_LABEL, documentEntries, type DocumentEntry, type DocumentSource } from "../odysseyDocuments";
import { IconBox, IconFolder, IconMessage, IconX } from "./icons";

/** Lines read in one go; the largest plan document so far was 2,400. */
const READ_LINES = 20_000;

type Loaded = { text: string; note: string | null };

async function load(workspaceId: string, source: DocumentSource, fallbackGoalId: string | null): Promise<Loaded> {
  switch (source.kind) {
    case "file": {
      try {
        const read = await api.fileRead(workspaceId, source.path, 0, READ_LINES);
        if (read.binary) return { text: "", note: "This file is binary and cannot be shown here." };
        return { text: read.content, note: read.truncated ? `Showing the first ${read.returnedLines.toLocaleString()} of ${read.totalLines.toLocaleString()} lines.` : null };
      } catch (error) {
        // A plan document that has gone from the workspace still exists as
        // the copy stored with the goal; say which one is being shown.
        if (fallbackGoalId) {
          const stored = await api.odysseyPlanDocument(fallbackGoalId);
          if (stored) return { text: stored, note: "The file could not be read from the workspace; this is the copy stored with the goal when it was created." };
        }
        throw error;
      }
    }
    case "stored_plan": {
      const stored = await api.odysseyPlanDocument(source.goalId);
      if (!stored) throw new Error("This goal has no stored plan document.");
      return { text: stored, note: "The copy stored with the goal when it was created." };
    }
    case "amendment": {
      const document = await api.odysseyAmendDocument(source.amendmentId);
      if (!document) throw new Error("This amendment's document is no longer stored.");
      return { text: document, note: "Quoted to the agent in its prompt, because the file is outside the workspace." };
    }
  }
}

function DocumentViewer({ entry, workspaceId, goalId, onClose }: { entry: DocumentEntry; workspaceId: string; goalId: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(!entry.markdown);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    if (!entry.source) return;
    load(workspaceId, entry.source, entry.group === "plan" ? goalId : null)
      .then((value) => {
        if (!cancelled) setLoaded(value);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : ((failure as { message?: string }).message ?? String(failure)));
      });
    return () => {
      cancelled = true;
    };
  }, [entry, workspaceId, goalId]);

  return (
    <div aria-modal="true" className="modal-backdrop" onClick={onClose} role="dialog" aria-label={entry.label}>
      <div className="modal modal-wide odyssey-document" onClick={(event) => event.stopPropagation()}>
        <header className="row wrap odyssey-document-head">
          <div className="odyssey-document-title">
            <h2>{entry.label}</h2>
            <span className="small muted mono">{entry.meta}</span>
          </div>
          <span className="row-actions">
            {entry.markdown && (
              <button className="link small" onClick={() => setRaw(!raw)} type="button">
                {raw ? "rendered" : "raw text"}
              </button>
            )}
            <button aria-label="Close" className="icon-button" onClick={onClose} type="button">
              <IconX size={14} />
            </button>
          </span>
        </header>
        {loaded?.note && <p className="small muted">{loaded.note}</p>}
        {error && <p className="small chip-warn">{error}</p>}
        <div className="odyssey-document-body">
          {loaded === null && !error && <p className="small muted">Reading…</p>}
          {loaded && (raw ? <pre className="text">{loaded.text}</pre> : <Markdown source={loaded.text} />)}
        </div>
      </div>
    </div>
  );
}

/**
 * The rail card. Absent when the goal has nothing to read yet — a goal typed
 * in by hand with no amendments and no notes has no documents, and an empty
 * card would only say so.
 */
export function DocumentsCard({ sessionId, view }: { sessionId: string; view: OdysseyView }) {
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId);
  const amendments = useStore((s) => s.odysseyAmendments[sessionId]);
  const notes = useStore((s) => s.odysseyNotes[sessionId]);
  const [open, setOpen] = useState<DocumentEntry | null>(null);

  const entries = useMemo(() => documentEntries({ goal: view.goal, amendments: amendments ?? [], notes, now: Date.now() }), [view.goal, amendments, notes]);
  if (!workspaceId || entries.length === 0) return null;

  const groups = (["plan", "added", "notes"] as const).map((group) => ({ group, items: entries.filter((entry) => entry.group === group) })).filter((group) => group.items.length > 0);

  return (
    <section aria-label="Documents" className="card odyssey-documents">
      <header className="work-head">
        <span className="work-title">Documents</span>
        <span className="work-meta small muted">
          {entries.length} item{entries.length === 1 ? "" : "s"}
        </span>
      </header>
      {groups.map(({ group, items }) => (
        <div className="odyssey-documents-group" key={group}>
          <span className="small muted odyssey-documents-label">{GROUP_LABEL[group]}</span>
          <ul className="odyssey-documents-list">
            {items.map((entry) => (
              <li key={entry.id}>
                {entry.source === null ? <IconFolder size={12} /> : entry.group === "notes" ? <IconMessage size={12} /> : <IconBox size={12} />}
                <span className="odyssey-documents-name">
                  <span className="small">{entry.label}</span>
                  <span className="small muted odyssey-documents-meta" title={entry.meta}>
                    {entry.meta}
                  </span>
                </span>
                {entry.source !== null && (
                  <button className="link small" onClick={() => setOpen(entry)} type="button">
                    View
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {open && <DocumentViewer entry={open} goalId={view.goal.id} onClose={() => setOpen(null)} workspaceId={workspaceId} />}
    </section>
  );
}
