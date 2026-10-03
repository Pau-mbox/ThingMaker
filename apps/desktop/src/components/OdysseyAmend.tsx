/**
 * Asking for a change while the goal runs (docs/plans/odyssey.md §3.2).
 *
 * The dialog collects an instruction and what it refers to; the runner carries
 * it on the model's next prompt and the model decides where it belongs. It
 * never submits anything itself, so opening this while a turn is in flight is
 * safe — which is the whole point of it existing.
 */
import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AmendmentRecord, AmendmentRef } from "@thingmaker/contracts";
import { useStore } from "../store";
import { api } from "../ipc";
import { fileNameOf, isPlanDocument, summarize } from "../odysseyDocument";
import { MAX_TELLS, amendmentStatus } from "../odysseyAmend";
import { IconBox, IconFolder, IconX } from "./icons";

/** Largest document inlined into a prompt, matching the native guard. */
const MAX_DOCUMENT_BYTES = 32 * 1024;

export function AmendDialog({
  sessionId,
  odysseyId,
  workspaceId,
  onClose,
  initialPaths,
}: {
  sessionId: string;
  odysseyId: string;
  workspaceId: string;
  onClose: () => void;
  /** Files to start with, as if dropped: a document sent from the transcript. */
  initialPaths?: string[];
}) {
  const addAmendment = useStore((s) => s.odysseyAddAmendment);
  const setError = useStore((s) => s.setError);
  const [note, setNote] = useState("");
  const [refs, setRefs] = useState<AmendmentRef[]>([]);
  const [document, setDocument] = useState<{ name: string; text: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  // An instruction, not work: carried once, closed as delivered, never
  // re-asked and never shown as a change the agent ignored.
  const [isNote, setIsNote] = useState(false);

  const addRefs = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const inspected = await api.odysseyInspectRefs(workspaceId, paths);
        setRefs((current) => [...current.filter((entry) => !inspected.some((added) => added.path === entry.path)), ...inspected]);
      } catch (error) {
        setError(error);
      }
    },
    [workspaceId, setError],
  );

  /**
   * A dropped file inside the workspace becomes a reference, not an
   * attachment: the agent opens it with its own tools, so a folder of 48
   * sprites costs the prompt one line. Only a document from outside — which
   * the agent cannot reach — is read and quoted.
   */
  const handleDrop = useCallback(
    async (paths: string[]) => {
      const inside: string[] = [];
      for (const path of paths) {
        try {
          const [inspected] = await api.odysseyInspectRefs(workspaceId, [path]);
          if (inspected) inside.push(path);
        } catch {
          if (!isPlanDocument(path)) {
            setError({ code: "UNSUPPORTED", message: `${fileNameOf(path)} is outside this workspace and is not a document, so the agent has no way to read it.`, retry: "user_action" });
            continue;
          }
          try {
            const text = await api.odysseyReadPlan(path);
            const measured = summarize(text, fileNameOf(path));
            if (measured.bytes > MAX_DOCUMENT_BYTES) {
              setError({
                code: "LIMIT_EXCEEDED",
                message: `${fileNameOf(path)} is ${Math.round(measured.bytes / 1024)} KB. A document outside the workspace is quoted in the agent's prompt, so it has to be under ${MAX_DOCUMENT_BYTES / 1024} KB — put it in the project and drop it again to reference it instead.`,
                retry: "user_action",
              });
              continue;
            }
            setDocument({ name: fileNameOf(path), text });
          } catch (error) {
            setError(error);
          }
        }
      }
      await addRefs(inside);
    },
    [workspaceId, addRefs, setError],
  );

  const startWith = initialPaths?.join("\n") ?? "";
  useEffect(() => {
    if (startWith) void handleDrop(startWith.split("\n"));
    // Once, for what the dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWith]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setDropping(true);
        else if (event.payload.type === "leave") setDropping(false);
        else if (event.payload.type === "drop") {
          setDropping(false);
          void handleDrop(event.payload.paths);
        }
      })
      .then((fn) => {
        stop = fn;
      });
    return () => stop?.();
  }, [handleDrop]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await addAmendment(sessionId, {
        odysseyId,
        note: note.trim(),
        refs,
        kind: isNote ? "note" : "change",
        ...(document ? { document: document.text, documentSource: document.name } : {}),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div aria-modal="true" className="modal-backdrop" onClick={onClose} role="dialog">
      <div className={`modal odyssey-amend ${dropping ? "drop-target" : ""}`} onClick={(event) => event.stopPropagation()}>
        <h2>Add or change work</h2>
        <p className="small muted">
          This does not interrupt the run. It is carried to the agent on its next prompt, and the agent decides where it belongs in the plan and when to do it.
        </p>

        <textarea
          aria-label="What you want"
          autoFocus
          className="textarea"
          onChange={(event) => setNote(event.target.value)}
          placeholder={isNote ? "Prefer the built-in harness for the rest of this milestone; the delegates are slow today." : "Generate the ships from the new art and embed them in the trading UI at some point."}
          rows={4}
          value={note}
        />
        <label className="row small odyssey-amend-kind">
          <input checked={isNote} onChange={(event) => setIsNote(event.target.checked)} type="checkbox" />
          <span>
            Just a note to the agent, no plan change expected. <span className="muted">Carried once and closed as delivered; a change is re-asked until the agent folds it in.</span>
          </span>
        </label>

        <div className="odyssey-amend-refs">
          <label className="small muted" htmlFor="odyssey-ref-input">
            Point the agent at files or folders in the project — it opens them itself, so a whole folder costs nothing to mention.
          </label>
          <form
            className="odyssey-amend-add"
            onSubmit={(event) => {
              event.preventDefault();
              const value = typed.trim();
              if (!value) return;
              setTyped("");
              void addRefs([value]);
            }}
          >
            <input className="input" id="odyssey-ref-input" onChange={(event) => setTyped(event.target.value)} placeholder="Assets/Art/Ships" value={typed} />
            <button className="button button-small" type="submit">
              Add
            </button>
          </form>

          {refs.length === 0 && !document && <p className="small muted odyssey-dropzone">…or drop files and folders here.</p>}

          <ul className="odyssey-amend-list">
            {refs.map((reference) => (
              <li key={reference.path}>
                {reference.kind === "directory" ? <IconFolder size={13} /> : <IconBox size={13} />}
                <span className="small mono">{reference.path}</span>
                <span className="small muted">{reference.detail}</span>
                <button aria-label={`Remove ${reference.path}`} className="icon-button icon-button-xs" onClick={() => setRefs(refs.filter((entry) => entry.path !== reference.path))} type="button">
                  <IconX size={12} />
                </button>
              </li>
            ))}
            {document && (
              <li>
                <IconBox size={13} />
                <span className="small mono">{document.name}</span>
                <span className="small muted">quoted in the prompt · outside the workspace</span>
                <button aria-label={`Remove ${document.name}`} className="icon-button icon-button-xs" onClick={() => setDocument(null)} type="button">
                  <IconX size={12} />
                </button>
              </li>
            )}
          </ul>
        </div>

        <div className="row wrap">
          <button className="button button-primary" disabled={!note.trim() || busy} onClick={() => void submit()} type="button">
            {busy ? "Queueing…" : "Queue for the agent"}
          </button>
          <button className="button" onClick={onClose} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}



/** What the user has asked for, and how far each request has got. */
export function AmendmentList({ sessionId, amendments }: { sessionId: string; amendments: AmendmentRecord[] }) {
  const discard = useStore((s) => s.odysseyDiscardAmendment);
  const open = amendments.filter((record) => record.state === "pending" || record.state === "told");
  if (open.length === 0) return null;

  return (
    <section className="card odyssey-amendments">
      <header className="work-head">
        <span className="work-title">Your changes</span>
        <span className="work-meta small muted">{open.length} waiting</span>
      </header>
      <ul className="odyssey-amend-list">
        {open.map((record) => (
          <li className="odyssey-amend-row" key={record.id}>
            <span className="small">{record.note}</span>
            <span className={`small ${record.tellCount >= MAX_TELLS ? "chip-warn-text" : "muted"}`}>{amendmentStatus(record)}</span>
            {record.refs.map((reference) => (
              <span className="small muted mono" key={reference.path}>
                {reference.path}
              </span>
            ))}
            {record.state === "pending" && (
              <button className="link small" onClick={() => void discard(sessionId, record.id)} type="button">
                discard
              </button>
            )}
          </li>
        ))}
      </ul>
      {open.some((record) => record.tellCount >= MAX_TELLS) ? (
        <p className="small chip-warn">
          The agent was asked and did not fold this in. It will not be asked again — say it yourself in the prompt, or add the milestone by hand.
        </p>
      ) : (
        <p className="small muted">
          The agent folds these in when it reaches a point where they fit; nothing is interrupted. It is asked again every few continuations until it does.
        </p>
      )}
    </section>
  );
}
