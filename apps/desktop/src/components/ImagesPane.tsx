/**
 * Session-linked image gallery. Images are artifact versions (ART-01) whose
 * content sniffs as an image: files the agent produced in the workspace since
 * the session baseline, plus anything Kit wrote under its own artifact
 * directory for this session. The gallery rescans when a turn settles and on
 * request; every version stays addressable, nothing is overwritten.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtifactContent, ArtifactRecord } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";

function Thumb({ record, onOpen }: { record: ArtifactRecord; onOpen: (content: ArtifactContent) => void }) {
  const [content, setContent] = useState<ArtifactContent | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .artifactRead(record.id)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [record.id]);
  const src = content?.dataBase64 ? `data:${record.mime};base64,${content.dataBase64}` : null;
  return (
    <button className="gallery-tile" disabled={!content} onClick={() => content && onOpen(content)} title={record.logicalPath} type="button">
      {src ? <img alt={record.logicalPath} src={src} /> : <span className="gallery-placeholder small muted">{content?.unavailable ?? "loading…"}</span>}
      <span className="gallery-caption">
        <span className="mono small">{record.logicalPath.split("/").pop()}</span>
        <span className="small muted">
          v{record.version}
          {content?.width ? ` · ${content.width}×${content.height}` : ""}
        </span>
      </span>
    </button>
  );
}

export function ImagesPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const setError = useStore((s) => s.setError);
  const openUrl = useStore((s) => s.openUrl);
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<ArtifactContent | null>(null);
  const [showAllVersions, setShowAllVersions] = useState(false);
  const workspaceId = session?.workspaceId ?? null;
  const agentSessionId = session?.snapshot.agentSessionId ?? null;
  const settledCount = session ? session.projection.cards.filter((c) => c.kind === "turn").length : 0;
  const active = !!session && (session.projection.foreground === "running" || session.projection.foreground === "cancelling");

  const scan = useCallback(async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const outcome = await api.artifactsRefresh(workspaceId, agentSessionId);
      setRecords(outcome.artifacts.filter((a) => a.viewer === "image"));
      setNote(outcome.newVersions > 0 ? `${outcome.newVersions} new image version(s)` : null);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }, [workspaceId, agentSessionId, setError]);

  // Rescan on mount and whenever a turn settles; never while a turn is running.
  useEffect(() => {
    if (!active) void scan();
  }, [scan, settledCount, active]);

  const shown = useMemo(() => {
    if (showAllVersions) return records;
    const latest = new Map<string, ArtifactRecord>();
    for (const r of records) {
      const current = latest.get(r.logicalPath);
      if (!current || r.version > current.version) latest.set(r.logicalPath, r);
    }
    return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [records, showAllVersions]);

  if (!session) return null;
  return (
    <div className="images-pane">
      <div className="row wrap">
        <button className="button button-small" disabled={busy} onClick={() => void scan()} type="button">
          {busy ? "Scanning…" : "Rescan"}
        </button>
        <label className="check small">
          <input checked={showAllVersions} onChange={(e) => setShowAllVersions(e.target.checked)} type="checkbox" /> show every version
        </label>
        <span className="small muted">
          {shown.length} image{shown.length === 1 ? "" : "s"}
          {note ? ` · ${note}` : ""} · files produced in this workspace since the session baseline, plus images the agent reported producing
        </span>
      </div>
      {shown.length === 0 && !busy && (
        <p className="muted small">
          No images yet. Generated files that land in the workspace (for example <span className="mono">output/imagegen/*.png</span>) appear here after the turn settles.
        </p>
      )}
      <div className="gallery">
        {shown.map((record) => (
          <Thumb key={record.id} onOpen={setOpen} record={record} />
        ))}
      </div>
      {open && (
        <div aria-modal="true" className="modal-backdrop" onClick={() => setOpen(null)} role="dialog">
          <div className="image-lightbox" onClick={(e) => e.stopPropagation()}>
            {open.dataBase64 ? <img alt={open.record.logicalPath} src={`data:${open.record.mime};base64,${open.dataBase64}`} /> : <p className="muted">{open.unavailable}</p>}
            <div className="row wrap">
              <span className="mono small">{open.record.logicalPath}</span>
              <span className="chip small">v{open.record.version}</span>
              <span className={`chip small ${open.record.provenance === "observed" ? "chip-warn" : ""}`}>{open.record.provenance.replace("_", "-")}</span>
              <span className="small muted">
                {open.width}×{open.height} · {(open.record.bytes / 1024).toFixed(0)} KiB · blake3 {open.record.contentHash.slice(0, 12)} · {new Date(open.record.createdAt).toLocaleString()}
              </span>
              <button className="button button-small" onClick={() => void openUrl(`file://${open.record.sourcePath}`)} type="button">
                Open externally
              </button>
              <button className="button button-small" onClick={() => setOpen(null)} type="button">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
