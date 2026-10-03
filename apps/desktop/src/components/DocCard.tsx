/**
 * A Markdown document the agent wrote or pointed at, shown as a document:
 * its name and size, the top of it rendered, and what you would do with it
 * — read it whole, show it in Finder, open it in an editor, or hand it to
 * Big Thing to plan a goal from (or to add to the goal already running).
 */
import { useEffect, useState } from "react";
import type { FileRead } from "@thingmaker/contracts";
import { api } from "../ipc";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { workspaceImageRenderer } from "./InlineImage";
import { IconDoc, IconExternal, IconFolder, IconSummit, IconX } from "./icons";

/** Lines read for the card; the viewer reads the whole file. */
const PREVIEW_LINES = 80;
/** Lines rendered while the card is folded. */
const FOLDED_LINES = 14;

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(at: number | null): string | null {
  if (!at) return null;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The first lines, cut at a line rather than mid-block where it can be. */
function head(content: string, lines: number): { text: string; cut: boolean } {
  const all = content.split("\n");
  if (all.length <= lines) return { text: content, cut: false };
  let end = lines;
  // Never leave a code fence open: it would swallow the rest as code.
  const fences = all.slice(0, end).filter((line) => line.trimStart().startsWith("```")).length;
  if (fences % 2 === 1) {
    const close = all.findIndex((line, index) => index >= end && line.trimStart().startsWith("```"));
    let open = end - 1;
    while (open > 0 && !(all[open] as string).trimStart().startsWith("```")) open -= 1;
    end = close >= 0 && close < end + 20 ? close + 1 : open;
  }
  return { text: all.slice(0, Math.max(1, end)).join("\n"), cut: true };
}

function useDocActions(sessionId: string, workspaceId: string, relative: string) {
  const root = useStore((s) => s.workspaces.find((entry) => entry.id === workspaceId)?.canonicalRoot ?? null);
  const send = useStore((s) => s.sendDocToBigThing);
  const hasGoal = useStore((s) => Boolean(s.odyssey[sessionId]));
  const setError = useStore((s) => s.setError);
  const absolute = root ? `${root.replace(/\/$/, "")}/${relative}` : null;
  return {
    hasGoal,
    reveal: () => (absolute ? void api.revealInFinder(absolute).catch(setError) : undefined),
    edit: () => void api.openInEditor(workspaceId, relative, "system").catch(setError),
    toBigThing: () => (absolute ? send(sessionId, absolute) : undefined),
  };
}

function Actions({ sessionId, workspaceId, relative, onOpen }: { sessionId: string; workspaceId: string; relative: string; onOpen?: () => void }) {
  const actions = useDocActions(sessionId, workspaceId, relative);
  return (
    <span className="doc-actions">
      {onOpen && (
        <button className="doc-action" onClick={onOpen} title="Read the whole document here" type="button">
          <IconDoc size={13} /> Open
        </button>
      )}
      <button className="doc-action" onClick={actions.reveal} title="Show it in Finder" type="button">
        <IconFolder size={13} /> Finder
      </button>
      <button className="doc-action" onClick={actions.edit} title="Open it in the system's editor for Markdown" type="button">
        <IconExternal size={13} /> Editor
      </button>
      <button
        className="doc-action doc-action-bigthing"
        onClick={actions.toBigThing}
        title={actions.hasGoal ? "Add this document to the running Big Thing as new work" : "Plan a Big Thing from this document"}
        type="button"
      >
        <IconSummit size={13} /> {actions.hasGoal ? "Add to Big Thing" : "Big Thing"}
      </button>
    </span>
  );
}

/** The whole document, rendered, over the session. */
export function DocViewer({ sessionId, workspaceId, relative, onClose }: { sessionId: string; workspaceId: string; relative: string; onClose: () => void }) {
  const [file, setFile] = useState<FileRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .fileRead(workspaceId, relative, 0, 20_000)
      .then((read) => live && setFile(read))
      .catch((error: unknown) => live && setFailed(error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)));
    return () => {
      live = false;
    };
  }, [workspaceId, relative]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div aria-label={relative} aria-modal="true" className="modal-backdrop" onClick={onClose} role="dialog">
      <div className="modal doc-viewer" onClick={(event) => event.stopPropagation()}>
        <header className="doc-viewer-head">
          <IconDoc size={16} />
          <strong className="mono">{relative}</strong>
          {file && (
            <span className="small muted">
              {file.totalLines.toLocaleString()} lines · {size(file.bytes)}
            </span>
          )}
          <Actions relative={relative} sessionId={sessionId} workspaceId={workspaceId} />
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">
            <IconX size={14} />
          </button>
        </header>
        <div className="doc-viewer-body">
          {failed ? (
            <p className="small muted">Could not read it: {failed}</p>
          ) : file ? (
            <>
              <Markdown onImage={workspaceImageRenderer(workspaceId)} source={file.content} />
              {file.truncated && <p className="small muted">Shown up to line {file.returnedLines.toLocaleString()}. Open it in an editor for the rest.</p>}
            </>
          ) : (
            <p className="small muted">Reading…</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A document in the transcript. `version` changes whenever the agent writes
 * it again, so the preview follows the file.
 */
export function DocCard({ sessionId, workspaceId, relative, version, verb }: { sessionId: string; workspaceId: string; relative: string; version: string; verb: "wrote" | "named" }) {
  const [file, setFile] = useState<FileRead | null>(null);
  const [missing, setMissing] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .fileRead(workspaceId, relative, 0, PREVIEW_LINES)
      .then((read) => {
        if (!live) return;
        setFile(read);
        setMissing(false);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [workspaceId, relative, version]);

  // A path the agent named that is not there is not a document.
  if (missing || (file && file.binary)) return null;
  const cut = slash(relative);
  const preview = file ? head(file.content, unfolded ? PREVIEW_LINES : FOLDED_LINES) : null;
  const more = Boolean(preview?.cut || file?.truncated);

  return (
    <section className="doc-card">
      <header className="doc-card-head">
        <IconDoc size={15} />
        <button className="doc-card-name" onClick={() => setViewing(true)} title={`Open ${relative}`} type="button">
          {cut.dir && <span className="muted">{cut.dir}</span>}
          <span>{cut.name}</span>
        </button>
        {file && (
          <span className="small muted doc-card-meta">
            {verb === "wrote" ? "written" : "mentioned"} · {file.totalLines.toLocaleString()} lines · {size(file.bytes)}
            {ago(file.modifiedUnixMs) ? ` · ${ago(file.modifiedUnixMs)}` : ""}
          </span>
        )}
        <Actions onOpen={() => setViewing(true)} relative={relative} sessionId={sessionId} workspaceId={workspaceId} />
      </header>
      {preview && (
        <div className={`doc-card-preview ${more && !unfolded ? "doc-card-folded" : ""}`}>
          <Markdown onImage={workspaceImageRenderer(workspaceId)} source={preview.text} />
        </div>
      )}
      {more && (
        <button className="link small doc-card-more" onClick={() => (unfolded && file?.truncated ? setViewing(true) : setUnfolded(!unfolded))} type="button">
          {!unfolded ? "Show more" : file?.truncated ? `Read all ${file.totalLines.toLocaleString()} lines` : "Show less"}
        </button>
      )}
      {viewing && <DocViewer onClose={() => setViewing(false)} relative={relative} sessionId={sessionId} workspaceId={workspaceId} />}
    </section>
  );
}

function slash(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
