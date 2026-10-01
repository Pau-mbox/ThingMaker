import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { DiffResponse, DiffScope, FileChange, FileVersions, RepositoryInfo } from "@thingmaker/contracts";
import { api, toDesktopError } from "../ipc";
import { useStore } from "../store";
import { hunkPatch, parseHunks } from "../diffHunks";

const MonacoDiff = lazy(() => import("./MonacoEditor").then((m) => ({ default: m.DiffEditor })));

function UnifiedView({
  change,
  onStageHunk,
  onRevertHunk,
}: {
  change: FileChange;
  onStageHunk?: ((patch: string) => void) | undefined;
  onRevertHunk?: ((patch: string) => void) | undefined;
}) {
  if (!change.unified) {
    return <p className="small muted">{change.omitted ?? (change.kind === "renamed" ? `Renamed from ${change.renamedFrom}` : change.kind === "mode_changed" ? `Mode ${change.beforeMode?.toString(8)} → ${change.afterMode?.toString(8)}` : "No textual diff.")}</p>;
  }
  const parsed = parseHunks(change.unified);
  return (
    <div className="hunks">
      {parsed.hunks.map((hunk) => (
        <div className="hunk" key={hunk.index}>
          <div className="row wrap hunk-header">
            <span className="mono small diff-hunk">{hunk.header}</span>
            <span className="small diff-add">+{hunk.additions}</span>
            <span className="small diff-del">-{hunk.deletions}</span>
            {onStageHunk && (
              <button className="link small" onClick={() => onStageHunk(hunkPatch(parsed, hunk))} type="button">
                stage hunk
              </button>
            )}
            {onRevertHunk && (
              <button className="link small" onClick={() => onRevertHunk(hunkPatch(parsed, hunk))} type="button">
                revert hunk
              </button>
            )}
          </div>
          <pre className="diff">
            {hunk.body.split("\n").map((line, index) => {
              const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "";
              return (
                <span className={`diff-line ${cls}`} key={index}>
                  {line}
                  {"\n"}
                </span>
              );
            })}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Review scopes and actions (REV-01, REV-04, REV-05). Session baseline works
 * without Git; working tree and staged scopes add stage/unstage/revert per
 * file or hunk, commit and explicit push. Reverts are hash-checked so a stale
 * review cannot destroy newer edits.
 */
export function ChangesPane({ workspaceId, sessionId, isGit }: { workspaceId: string; sessionId: string; isGit: boolean }) {
  const [scope, setScope] = useState<DiffScope>(isGit ? "working_tree" : "baseline");
  const [response, setResponse] = useState<DiffResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<RepositoryInfo | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [commitMessage, setCommitMessage] = useState("");

  const report = (error: unknown) => useStore.setState({ error: toDesktopError(error) });

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await api.reviewDiff(workspaceId, scope, sessionId);
      setResponse(result);
      if (isGit) setInfo(await api.gitInfo(workspaceId));
      setSelected((current) => (result.report.files.some((f) => f.path === current) ? current : result.report.files[0]?.path ?? null));
    } catch (error) {
      setResponse(null);
      setMessage(toDesktopError(error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, scope, sessionId, isGit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const files = response?.report.files ?? [];
  const current = files.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (!sideBySide || !current) {
      setVersions(null);
      return;
    }
    api
      .reviewFileVersions(workspaceId, scope, current.path, current.beforeHash)
      .then(setVersions)
      .catch((error) => {
        setVersions(null);
        report(error);
      });
  }, [sideBySide, current, workspaceId, scope]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await action();
      setMessage(label);
      await refresh();
    } catch (error) {
      report(error);
      setLoading(false);
    }
  };

  const confirm = (title: string, text: string, ok: string) =>
    api.confirmDialog({ title, message: text, okLabel: ok, cancelLabel: "Cancel", warning: true });

  const revertFile = async (file: FileChange) => {
    const untracked = scope === "working_tree" && file.kind === "added";
    const versionsNow = await api.reviewFileVersions(workspaceId, scope, file.path, file.beforeHash);
    if (!versionsNow.afterHash) {
      report({ code: "CONFLICT", message: "Cannot hash the current file; refresh first.", retry: "after_reconcile" });
      return;
    }
    const ok = await confirm(
      untracked ? "Delete untracked file?" : "Revert file?",
      untracked
        ? `${file.path} is untracked and will be deleted from the working tree. This is a file action; it does not undo commands the agent ran.`
        : `${file.path} will be restored to the index version. Unstaged edits in it are lost. This does not undo shell commands, remote changes or database effects.`,
      untracked ? "Delete file" : "Revert file",
    );
    if (!ok) return;
    await run(`Reverted ${file.path}.`, () => api.gitRevertFile(workspaceId, file.path, versionsNow.afterHash!, untracked));
  };

  const resetBaseline = async () => {
    await run("Baseline reset to the current tree.", () => api.reviewCaptureBaseline(workspaceId, sessionId));
  };

  const commit = async () => {
    if (!info) return;
    const staged = files.length;
    const ok = await confirm("Commit staged changes?", `Repository ${info.root}\nBranch ${info.head}\n${staged} staged file(s)\n\n${commitMessage.trim().split("\n")[0] ?? ""}`, "Commit");
    if (!ok) return;
    await run("Committed.", async () => {
      const outcome = await api.gitCommit(workspaceId, commitMessage);
      setCommitMessage("");
      setMessage(`Committed ${outcome.commit}: ${outcome.summary}`);
    });
  };

  const push = async (remote: string) => {
    if (!info) return;
    const ok = await confirm(
      "Push to remote?",
      `This publishes commits outside your machine.\n\nRepository ${info.root}\nBranch ${info.head} → ${remote}${info.upstream ? ` (upstream ${info.upstream})` : " (sets upstream)"}\nAhead ${info.ahead}, behind ${info.behind}\n\nGit's own credential helper is used; nothing is forced.`,
      `Push to ${remote}`,
    );
    if (!ok) return;
    await run(`Pushed to ${remote}.`, () => api.gitPush(workspaceId, remote));
  };

  const gitScope = scope === "working_tree" || scope === "staged";

  return (
    <div className="changes-pane">
      <div className="row wrap">
        <span className="segmented" role="radiogroup" aria-label="Diff scope">
          {(["baseline", "working_tree", "staged"] as DiffScope[]).map((s) => (
            <button aria-checked={scope === s} className={`seg ${scope === s ? "seg-on" : ""}`} disabled={s !== "baseline" && !isGit} key={s} onClick={() => setScope(s)} role="radio" type="button">
              {s === "baseline" ? "Session baseline" : s === "working_tree" ? "Working tree" : "Staged"}
            </button>
          ))}
        </span>
        <button className="button small" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? "Working…" : "Refresh"}
        </button>
        {scope === "baseline" && (
          <button className="button small" disabled={loading} onClick={() => void resetBaseline()} type="button">
            Reset baseline to now
          </button>
        )}
        <label className="check small">
          <input checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} type="checkbox" /> side by side
        </label>
        {info && (
          <span className="chip small" title={info.root}>
            {info.detached ? info.head : `branch ${info.head}`}
            {info.upstream ? ` · ${info.upstream} ↑${info.ahead} ↓${info.behind}` : " · no upstream"}
          </span>
        )}
        {response && (
          <span className="small muted">
            {response.report.label} · base {response.report.baseRef} · {new Date(response.report.computedAtUnixMs).toLocaleTimeString()}
            {response.baseline ? ` · ${response.baseline.fileCount} files in baseline${response.baseline.omittedCount ? `, ${response.baseline.omittedCount} not retained` : ""}` : ""}
          </span>
        )}
      </div>
      {message && <p className="small muted">{message}</p>}
      {!isGit && <p className="small muted">Not a Git repository: only the baseline scope is available. Non-Git folders are first-class.</p>}
      <div className="changes-body">
        <ul className="change-list">
          {files.length === 0 && response && <li className="small muted">No changes in this scope.</li>}
          {files.map((file) => (
            <li className="change-row" key={file.path}>
              <button className={`tree-item ${selected === file.path ? "selected" : ""}`} onClick={() => setSelected(file.path)} type="button">
                <span className={`chip small kind-${file.kind}`}>{file.kind.replace("_", " ")}</span>
                <span className="tree-name mono">{file.path}</span>
                <span className="small diff-add">+{file.additions}</span> <span className="small diff-del">-{file.deletions}</span>
                {file.binary && <span className="chip small">binary</span>}
              </button>
              {gitScope && (
                <span className="row">
                  {scope === "working_tree" && (
                    <>
                      <button className="link small" disabled={loading} onClick={() => void run(`Staged ${file.path}.`, () => api.gitStage(workspaceId, [file.path]))} type="button">
                        stage
                      </button>
                      <button className="link small" disabled={loading} onClick={() => void revertFile(file)} type="button">
                        {file.kind === "added" ? "delete" : "revert"}
                      </button>
                    </>
                  )}
                  {scope === "staged" && (
                    <button className="link small" disabled={loading} onClick={() => void run(`Unstaged ${file.path}.`, () => api.gitUnstage(workspaceId, [file.path]))} type="button">
                      unstage
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
          {response?.report.truncated && <li className="small muted">List truncated.</li>}
          {scope === "working_tree" && files.length > 0 && (
            <li className="row">
              <button className="link small" disabled={loading} onClick={() => void run("Staged all listed files.", () => api.gitStage(workspaceId, files.map((f) => f.path)))} type="button">
                stage all listed
              </button>
            </li>
          )}
        </ul>
        <section className="diff-pane">
          {current ? (
            <>
              <div className="row wrap small muted">
                <span className="mono">{current.path}</span>
                {current.renamedFrom && <span>from {current.renamedFrom}</span>}
                {current.beforeHash && <span title="baseline hash">{current.beforeHash.slice(0, 10)}</span>}
                {current.afterHash && <span title="current hash">→ {current.afterHash.slice(0, 10)}</span>}
              </div>
              {sideBySide && versions && versions.before !== null && versions.after !== null ? (
                <Suspense fallback={<p className="small muted">Loading editor…</p>}>
                  <MonacoDiff modified={versions.after} original={versions.before} path={current.path} />
                </Suspense>
              ) : (
                <UnifiedView
                  change={current}
                  onRevertHunk={scope === "working_tree" ? (patch) => void (async () => {
                    const ok = await confirm("Revert hunk?", `Back out this hunk from ${current.path} in the working tree. Unstaged edits in it are lost.`, "Revert hunk");
                    if (ok) await run("Hunk reverted.", () => api.gitApplyHunk(workspaceId, patch, false, true));
                  })() : undefined}
                  onStageHunk={scope === "working_tree" ? (patch) => void run("Hunk staged.", () => api.gitApplyHunk(workspaceId, patch, true, false)) : undefined}
                />
              )}
              {sideBySide && versions && (versions.before === null || versions.after === null) && <p className="small muted">One side is unavailable (new, deleted, binary or truncated); showing unified text instead.</p>}
            </>
          ) : (
            <p className="muted">Select a change to see its diff. Changes here are workspace changes; the desktop cannot prove which were made by the agent.</p>
          )}
        </section>
      </div>
      {scope === "staged" && isGit && (
        <section className="commit-box">
          <textarea
            aria-label="Commit message"
            className="textarea"
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message (first line is the summary)"
            rows={3}
            value={commitMessage}
          />
          <div className="row wrap">
            <button className="button button-primary" disabled={loading || !commitMessage.trim() || files.length === 0} onClick={() => void commit()} type="button">
              Commit {files.length} staged file(s)
            </button>
            {info?.remotes.map((remote) => (
              <button className="button" disabled={loading || info.detached} key={remote} onClick={() => void push(remote)} type="button">
                Push to {remote}…
              </button>
            ))}
            {info && info.remotes.length === 0 && <span className="small muted">No remotes configured.</span>}
            <span className="small muted">Commit uses only staged content. Push is a separate publication step with its own confirmation.</span>
          </div>
        </section>
      )}
    </div>
  );
}
