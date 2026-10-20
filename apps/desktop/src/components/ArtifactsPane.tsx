/**
 * Artifact gallery (ART-01, ART-02, ART-04).
 *
 * Versions are grouped by logical path. Viewing is limited to text, Markdown
 * (safe renderer), JSON, code (read-only editor), and validated images; HTML
 * and SVG are shown as source; anything else opens externally on request.
 * Export writes selected versions and a manifest into a chosen folder after a
 * preview of exclusions and sensitive-content warnings.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ArtifactContent, ArtifactRecord, ExportOutcome } from "@thingmaker/contracts";
import { t } from "../i18n";
import { api } from "../ipc";
import { useStore } from "../store";
import { Markdown } from "../markdown";

const CodeEditor = lazy(() => import("./MonacoEditor"));

/** Where a version came from, in words. */
function provenanceWord(provenance: string): string {
  return provenance === "observed" ? t("observed") : t("runtime-reported");
}

/** How a version is shown, in words. */
function viewerWord(viewer: string): string {
  switch (viewer) {
    case "text":
      return t("text");
    case "markdown":
      return "Markdown";
    case "json":
      return "JSON";
    case "code":
      return t("code");
    case "image":
      return t("image");
    case "markup_source":
      return t("markup source");
    case "external":
      return t("external");
    default:
      return viewer.replace("_", " ");
  }
}

/** A sentence with one piece of markup in it, at `{name}`. */
function around(text: string, name: string, node: ReactNode) {
  const [before, after] = text.split(`{${name}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

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
      setNotes([t("scanned {scanned} candidate(s), {versions} new version(s)", { scanned: outcome.scanned, versions: outcome.newVersions }), ...outcome.notes]);
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
          {busy ? t("Scanning…") : t("Scan for new versions")}
        </button>
        <button className="button" disabled={checked.size === 0} onClick={() => void previewExport()} type="button">
          {t("Export selected ({n})…", { n: checked.size })}
        </button>
        <span className="small muted">
          {t("Sources: files the agent reported producing (runtime-reported) and workspace files changed since the session baseline (observed).")}
        </span>
      </div>
      {notes.map((note) => (
        <p className="small muted" key={note}>
          {note}
        </p>
      ))}
      <div className="artifacts-body">
        <ul className="artifact-list">
          {groups.length === 0 && <li className="muted small">{t("No artifacts recorded. Scan after the agent has produced output.")}</li>}
          {groups.map((group) => (
            <li className="artifact-group" key={group.key}>
              <div className="row wrap">
                <span className={`chip small ${group.versions[0]?.provenance === "observed" ? "chip-warn" : ""}`}>
                  {provenanceWord(group.versions[0]?.provenance ?? "")}
                </span>
                <strong className="mono small">{group.versions[0]?.logicalPath}</strong>
                {group.versions[0]?.callId && <span className="small muted">{t("call {id}", { id: group.versions[0].callId })}</span>}
              </div>
              <ul className="call-list nested">
                {group.versions.map((record) => (
                  <li className="row wrap" key={record.id}>
                    <input aria-label={t("select version {n}", { n: record.version })} checked={checked.has(record.id)} onChange={() => toggle(record.id)} type="checkbox" />
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
          {!selected && <p className="muted small">{t("Select a version to view it.")}</p>}
          {selected && !content && <p className="muted small">{t("Loading…")}</p>}
          {content && (
            <>
              <div className="row wrap">
                <span className="chip small">{viewerWord(content.record.viewer)}</span>
                <span className="mono small muted">{content.record.sourcePath}</span>
                {content.truncated && <span className="chip small chip-warn">{t("preview truncated at 2 MiB")}</span>}
                {(content.record.viewer === "external" || content.unavailable) && (
                  <button className="button button-small" onClick={() => void openUrl(`file://${content.record.sourcePath}`)} type="button">
                    {t("Open externally")}
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
                <Suspense fallback={<p className="muted small">{t("Loading editor…")}</p>}>
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
            <h2>{t("Export {n} artifact version(s)", { n: exportPreview.written.length })}</h2>
            <p className="small muted">
              {around(
                t("Files are written with a version suffix plus {manifest} (hashes and provenance). Publishing anywhere is a separate step you would take yourself; nothing leaves this machine."),
                "manifest",
                <code>artifact-manifest.json</code>,
              )}
            </p>
            {exportPreview.sensitiveHits > 0 && (
              <p className="banner banner-error">
                {t("{n} secret-looking pattern(s) were found in text artifacts. Review them before sharing the export.", { n: exportPreview.sensitiveHits })}
              </p>
            )}
            {exportPreview.excluded.length > 0 && (
              <ul className="call-list">
                {exportPreview.excluded.map((e) => (
                  <li className="small chip-warn" key={e.id}>
                    {t("excluded {id}: {reason}", { id: e.id.slice(0, 8), reason: e.reason })}
                  </li>
                ))}
              </ul>
            )}
            <ul className="call-list">
              {exportPreview.written.map((w) => (
                <li className="small mono" key={w.id}>
                  {w.exportedAs} · {bytes(w.bytes)} · {provenanceWord(w.provenance)}
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <button className="button button-primary" onClick={() => void runExport()} type="button">
                {t("Choose folder and export…")}
              </button>
              <button className="button" onClick={() => setExportPreview(null)} type="button">
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      {exportResult && exportResult.directory && (
        <p className="small">
          {around(t("Exported {n} file(s) to {directory}.", { n: exportResult.written.length }), "directory", <span className="mono">{exportResult.directory}</span>)}{" "}
          <button className="link" onClick={() => setExportResult(null)} type="button">
            {t("dismiss")}
          </button>
        </p>
      )}
    </div>
  );
}
