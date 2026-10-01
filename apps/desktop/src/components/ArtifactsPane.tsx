/**
 * Artifact gallery (ART-01, ART-02, ART-04).
 *
 * Versions are grouped by logical path. Viewing is limited to text, Markdown
 * (safe renderer), JSON, code (read-only editor), and validated images; HTML
 * and SVG are shown as source; anything else opens externally on request.
 * Export writes selected versions and a manifest into a chosen folder after a
 * preview of exclusions and sensitive-content warnings.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { ArtifactContent, ArtifactRecord, ExportOutcome } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { Markdown } from "../markdown";

const CodeEditor = lazy(() => import("./MonacoEditor"));

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function ArtifactsPane({ workspaceId, agentSessionId }: { workspaceId: string; agentSessionId: string | null }) {
  const setError = useStore((s) => s.setError);
  const openUrl = useStore((s) => s.openUrl);
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exportPreview, setExportPreview] = useState<ExportOutcome | null>(null);
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null);

  const load = useCallback(async () => {
    try {
      setRecords(await api.artifactsList(workspaceId, agentSessionId));
    } catch (error) {
      setError(error);
    }
  }, [workspaceId, agentSessionId, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      const outcome = await api.artifactsRefresh(workspaceId, agentSessionId);
      setRecords(outcome.artifacts);
      setNotes([`scanned ${outcome.scanned} candidate(s), ${outcome.newVersions} new version(s)`, ...outcome.notes]);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const view = async (id: string) => {
    setSelected(id);
    setContent(null);
    try {
      setContent(await api.artifactRead(id));
    } catch (error) {
      setError(error);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, ArtifactRecord[]>();
    for (const record of records) {
      const key = `${record.provenance}|${record.logicalPath}`;
      map.set(key, [...(map.get(key) ?? []), record]);
    }
    return [...map.entries()].map(([key, versions]) => ({ key, versions: versions.sort((a, b) => b.version - a.version) }));
  }, [records]);

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const previewExport = async () => {
    try {
      setExportPreview(await api.artifactsExportPreview([...checked]));
    } catch (error) {
      setError(error);
    }
  };

  const runExport = async () => {
    try {
      const outcome = await api.artifactsExport([...checked]);
      setExportPreview(null);
      setExportResult(outcome);
    } catch (error) {
      setError(error);
    }
  };

  return (
    <div className="artifacts-pane">
      <div className="row wrap">
        <button className="button button-primary" disabled={busy} onClick={() => void refresh()} type="button">
          {busy ? "Scanning…" : "Scan for new versions"}
        </button>
        <button className="button" disabled={checked.size === 0} onClick={() => void previewExport()} type="button">
          Export selected ({checked.size})…
        </button>
        <span className="small muted">
          Sources: files the agent reported producing (runtime-reported) and workspace files changed since the session baseline (observed).
        </span>
      </div>
      {notes.map((note) => (
        <p className="small muted" key={note}>
          {note}
        </p>
      ))}
      <div className="artifacts-body">
        <ul className="artifact-list">
          {groups.length === 0 && <li className="muted small">No artifacts recorded. Scan after the agent has produced output.</li>}
          {groups.map((group) => (
            <li className="artifact-group" key={group.key}>
              <div className="row wrap">
                <span className={`chip small ${group.versions[0]?.provenance === "observed" ? "chip-warn" : ""}`}>
                  {group.versions[0]?.provenance === "observed" ? "observed" : "runtime-reported"}
                </span>
                <strong className="mono small">{group.versions[0]?.logicalPath}</strong>
                {group.versions[0]?.callId && <span className="small muted">call {group.versions[0].callId}</span>}
              </div>
              <ul className="call-list nested">
                {group.versions.map((record) => (
                  <li className="row wrap" key={record.id}>
                    <input aria-label={`select version ${record.version}`} checked={checked.has(record.id)} onChange={() => toggle(record.id)} type="checkbox" />
                    <button className={`link ${selected === record.id ? "link-on" : ""}`} onClick={() => void view(record.id)} type="button">
                      v{record.version}
                    </button>
                    <span className="small muted">
                      {record.mime} · {bytes(record.bytes)} · {new Date(record.createdAt).toLocaleString()} · blake3 {record.contentHash.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="artifact-viewer">
          {!selected && <p className="muted small">Select a version to view it.</p>}
          {selected && !content && <p className="muted small">Loading…</p>}
          {content && (
            <>
              <div className="row wrap">
                <span className="chip small">{content.record.viewer.replace("_", " ")}</span>
                <span className="mono small muted">{content.record.sourcePath}</span>
                {content.truncated && <span className="chip small chip-warn">preview truncated at 2 MiB</span>}
                {(content.record.viewer === "external" || content.unavailable) && (
                  <button className="button button-small" onClick={() => void openUrl(`file://${content.record.sourcePath}`)} type="button">
                    Open externally
                  </button>
                )}
              </div>
              {content.unavailable && <p className="small muted">{content.unavailable}</p>}
              {content.dataBase64 && (
                <img
                  alt={content.record.logicalPath}
                  className="artifact-image"
                  height={content.height}
                  src={`data:${content.record.mime};base64,${content.dataBase64}`}
                  width={content.width}
                />
              )}
              {content.text !== undefined && content.record.viewer === "markdown" && (
                <Markdown onLink={(url) => void openUrl(url)} source={content.text} />
              )}
              {content.text !== undefined && content.record.viewer === "json" && (
                <pre className="text">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(content.text), null, 2);
                    } catch {
                      return content.text;
                    }
                  })()}
                </pre>
              )}
              {content.text !== undefined && (content.record.viewer === "code" || content.record.viewer === "markup_source") && (
                <Suspense fallback={<p className="muted small">Loading editor…</p>}>
                  <CodeEditor path={content.record.logicalPath} readOnly value={content.text} />
                </Suspense>
              )}
              {content.text !== undefined && content.record.viewer === "text" && <pre className="text">{content.text}</pre>}
            </>
          )}
        </div>
      </div>

      {exportPreview && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal modal-wide">
            <h2>Export {exportPreview.written.length} artifact version(s)</h2>
            <p className="small muted">
              Files are written with a version suffix plus <code>artifact-manifest.json</code> (hashes and provenance). Publishing anywhere is a separate
              step you would take yourself; nothing leaves this machine.
            </p>
            {exportPreview.sensitiveHits > 0 && (
              <p className="banner banner-error">
                {exportPreview.sensitiveHits} secret-looking pattern(s) were found in text artifacts. Review them before sharing the export.
              </p>
            )}
            {exportPreview.excluded.length > 0 && (
              <ul className="call-list">
                {exportPreview.excluded.map((e) => (
                  <li className="small chip-warn" key={e.id}>
                    excluded {e.id.slice(0, 8)}: {e.reason}
                  </li>
                ))}
              </ul>
            )}
            <ul className="call-list">
              {exportPreview.written.map((w) => (
                <li className="small mono" key={w.id}>
                  {w.exportedAs} · {bytes(w.bytes)} · {w.provenance}
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <button className="button button-primary" onClick={() => void runExport()} type="button">
                Choose folder and export…
              </button>
              <button className="button" onClick={() => setExportPreview(null)} type="button">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {exportResult && exportResult.directory && (
        <p className="small">
          Exported {exportResult.written.length} file(s) to <span className="mono">{exportResult.directory}</span>.{" "}
          <button className="link" onClick={() => setExportResult(null)} type="button">
            dismiss
          </button>
        </p>
      )}
    </div>
  );
}
