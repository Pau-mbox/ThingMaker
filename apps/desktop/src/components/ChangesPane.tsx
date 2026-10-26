import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { ChangeKind, DiffResponse, DiffScope, FileChange, FileVersions, RepositoryInfo } from "@thingmaker/contracts";
import { api, toDesktopError } from "../ipc";
import { useStore } from "../store";
import { hunkPatch, parseHunks } from "../diffHunks";
import { IS_REMOTE } from "../remote/mode";
import { t } from "../i18n";

/** A change's kind as its chip reads. */
function kindName(kind: ChangeKind): string {
  switch (kind) {
    case "added": return t("added");
    case "modified": return t("modified");
    case "deleted": return t("deleted");
    case "renamed": return t("renamed");
    case "mode_changed": return t("mode changed");
    default: return String(kind).replace("_", " ");
  }
}

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
    return <p className="small muted">{change.omitted ??
          (change.kind === "renamed"
            ? t("Renamed from {path}", { path: change.renamedFrom ?? "" })
            : change.kind === "mode_changed"
              ? t("Mode {before} → {after}", { before: change.beforeMode?.toString(8) ?? "", after: change.afterMode?.toString(8) ?? "" })
              : t("No textual diff."))}</p>;
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
                {t("stage hunk")}
              </button>
            )}
            {onRevertHunk && (
              <button className="link small" onClick={() => onRevertHunk(hunkPatch(parsed, hunk))} type="button">
                {t("revert hunk")}
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
  const focus = useStore((s) => s.changesFocus);
  const [scope, setScope] = useState<DiffScope>(focus ?? (isGit ? "working_tree" : "baseline"));
  useEffect(() => {
    if (!focus) return;
    setScope(focus);
    useStore.setState({ changesFocus: null });
  }, [focus]);
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
    api.confirmDialog({ title, message: text, okLabel: ok, cancelLabel: t("Cancel"), warning: true });

  const revertFile = async (file: FileChange) => {
    const untracked = scope === "working_tree" && file.kind === "added";
    const versionsNow = await api.reviewFileVersions(workspaceId, scope, file.path, file.beforeHash);
    if (!versionsNow.afterHash) {
      report({ code: "CONFLICT", message: t("Cannot hash the current file; refresh first."), retry: "after_reconcile" });
      return;
    }
    const ok = await confirm(
      untracked ? t("Delete untracked file?") : t("Revert file?"),
      untracked
        ? t("{path} is untracked and will be deleted from the working tree. This is a file action; it does not undo commands the agent ran.", { path: file.path })
        : t("{path} will be restored to the index version. Unstaged edits in it are lost. This does not undo shell commands, remote changes or database effects.", { path: file.path }),
      untracked ? t("Delete file") : t("Revert file"),
    );
    if (!ok) return;
    await run(t("Reverted {path}.", { path: file.path }), () => api.gitRevertFile(workspaceId, file.path, versionsNow.afterHash!, untracked));
  };

  const resetBaseline = async () => {
    await run(t("Baseline reset to the current tree."), () => api.reviewCaptureBaseline(workspaceId, sessionId));
  };

  const commit = async () => {
    if (!info) return;
    const staged = files.length;
    const details = [
      t("Repository {root}", { root: info.root }),
      t("Branch {head}", { head: info.head }),
      staged === 1 ? t("1 staged file") : t("{count} staged files", { count: staged }),
    ].join("\n");
    const ok = await confirm(t("Commit staged changes?"), `${details}\n\n${commitMessage.trim().split("\n")[0] ?? ""}`, t("Commit"));
    if (!ok) return;
    await run(t("Committed."), async () => {
      const outcome = await api.gitCommit(workspaceId, commitMessage);
      setCommitMessage("");
      setMessage(t("Committed {commit}: {summary}", { commit: outcome.commit, summary: outcome.summary }));
    });
  };

  const push = async (remote: string) => {
    if (!info) return;
    const ok = await confirm(
      t("Push to remote?"),
      [
        t("This publishes commits outside your machine."),
        "",
        t("Repository {root}", { root: info.root }),
        info.upstream
          ? t("Branch {head} → {remote} (upstream {upstream})", { head: info.head, remote, upstream: info.upstream })
          : t("Branch {head} → {remote} (sets upstream)", { head: info.head, remote }),
        t("Ahead {ahead}, behind {behind}", { ahead: info.ahead, behind: info.behind }),
        "",
        t("Git's own credential helper is used; nothing is forced."),
      ].join("\n"),
      t("Push to {remote}", { remote }),
    );
    if (!ok) return;
    await run(t("Pushed to {remote}.", { remote }), () => api.gitPush(workspaceId, remote));
  };

  const gitScope = scope === "working_tree" || scope === "staged";

  return (
    <div className="changes-pane">
      <div className="row wrap">
        <span className="segmented" role="radiogroup" aria-label={t("Diff scope")}>
          {(["turn", "baseline", "working_tree", "staged"] as DiffScope[]).map((s) => (
            <button aria-checked={scope === s} className={`seg ${scope === s ? "seg-on" : ""}`} disabled={(s === "working_tree" || s === "staged") && !isGit} key={s} onClick={() => setScope(s)} role="radio" type="button">
              {s === "turn" ? t("Last prompt") : s === "baseline" ? t("Session baseline") : s === "working_tree" ? t("Working tree") : t("Staged")}
            </button>
          ))}
        </span>
        <button className="button small" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? t("Working…") : t("Refresh")}
        </button>
        {scope === "baseline" && !IS_REMOTE && (
          <button className="button small" disabled={loading} onClick={() => void resetBaseline()} type="button">
            {t("Reset baseline to now")}
          </button>
        )}
        <label className="check small">
          <input checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} type="checkbox" /> {t("side by side")}
        </label>
        {info && (
          <span className="chip small" title={info.root}>
            {info.detached ? info.head : t("branch {head}", { head: info.head })}
            {info.upstream ? ` · ${info.upstream} ↑${info.ahead} ↓${info.behind}` : ` · ${t("no upstream")}`}
          </span>
        )}
        {response && (
          <span className="small muted">
            {response.report.label} · {t("base {ref}", { ref: response.report.baseRef })} · {new Date(response.report.computedAtUnixMs).toLocaleTimeString()}
            {response.baseline
              ? ` · ${response.baseline.fileCount === 1 ? t("1 file in baseline") : t("{count} files in baseline", { count: response.baseline.fileCount })}${
                  response.baseline.omittedCount ? `, ${t("{count} not retained", { count: response.baseline.omittedCount })}` : ""
                }`
              : ""}
          </span>
        )}
      </div>
      {message && <p className="small muted">{message}</p>}
      {!isGit && <p className="small muted">{t("Not a Git repository: only the baseline scope is available. Non-Git folders are first-class.")}</p>}
      <div className="changes-body">
        <ul className="change-list">
          {files.length === 0 && response && <li className="small muted">{t("No changes in this scope.")}</li>}
          {files.map((file) => (
            <li className="change-row" key={file.path}>
              <button className={`tree-item ${selected === file.path ? "selected" : ""}`} onClick={() => setSelected(file.path)} type="button">
                <span className={`chip small kind-${file.kind}`}>{kindName(file.kind)}</span>
                <span className="tree-name mono">{file.path}</span>
                <span className="small diff-add">+{file.additions}</span> <span className="small diff-del">-{file.deletions}</span>
                {file.binary && <span className="chip small">{t("binary")}</span>}
              </button>
              {/* From the phone, changes are read; git writes stay on the computer. */}
              {gitScope && !IS_REMOTE && (
                <span className="row">
                  {scope === "working_tree" && (
                    <>
                      <button className="link small" disabled={loading} onClick={() => void run(t("Staged {path}.", { path: file.path }), () => api.gitStage(workspaceId, [file.path]))} type="button">
                        {t("stage")}
                      </button>
                      <button className="link small" disabled={loading} onClick={() => void revertFile(file)} type="button">
                        {file.kind === "added" ? t("delete") : t("revert")}
                      </button>
                    </>
                  )}
                  {scope === "staged" && (
                    <button className="link small" disabled={loading} onClick={() => void run(t("Unstaged {path}.", { path: file.path }), () => api.gitUnstage(workspaceId, [file.path]))} type="button">
                      {t("unstage")}
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
          {response?.report.truncated && <li className="small muted">{t("List truncated.")}</li>}
          {scope === "working_tree" && files.length > 0 && !IS_REMOTE && (
            <li className="row">
              <button className="link small" disabled={loading} onClick={() => void run(t("Staged all listed files."), () => api.gitStage(workspaceId, files.map((f) => f.path)))} type="button">
                {t("stage all listed")}
              </button>
            </li>
          )}
        </ul>
        <section className="diff-pane">
          {current ? (
            <>
              <div className="row wrap small muted">
                <span className="mono">{current.path}</span>
                {current.renamedFrom && <span>{t("from {path}", { path: current.renamedFrom })}</span>}
                {current.beforeHash && <span title={t("baseline hash")}>{current.beforeHash.slice(0, 10)}</span>}
                {current.afterHash && <span title={t("current hash")}>→ {current.afterHash.slice(0, 10)}</span>}
              </div>
              {sideBySide && versions && versions.before !== null && versions.after !== null ? (
                <Suspense fallback={<p className="small muted">{t("Loading editor…")}</p>}>
                  <MonacoDiff modified={versions.after} original={versions.before} path={current.path} />
                </Suspense>
              ) : (
                <UnifiedView
                  change={current}
                  onRevertHunk={scope === "working_tree" && !IS_REMOTE ? (patch) => void (async () => {
                    const ok = await confirm(
                      t("Revert hunk?"),
                      t("Back out this hunk from {path} in the working tree. Unstaged edits in it are lost.", { path: current.path }),
                      t("Revert hunk"),
                    );
                    if (ok) await run(t("Hunk reverted."), () => api.gitApplyHunk(workspaceId, patch, false, true));
                  })() : undefined}
                  onStageHunk={scope === "working_tree" && !IS_REMOTE ? (patch) => void run(t("Hunk staged."), () => api.gitApplyHunk(workspaceId, patch, true, false)) : undefined}
                />
              )}
              {sideBySide && versions && (versions.before === null || versions.after === null) && <p className="small muted">{t("One side is unavailable (new, deleted, binary or truncated); showing unified text instead.")}</p>}
            </>
          ) : (
            <p className="muted">{t("Select a change to see its diff. Changes here are workspace changes; the desktop cannot prove which were made by the agent.")}</p>
          )}
        </section>
      </div>
      {scope === "staged" && isGit && !IS_REMOTE && (
        <section className="commit-box">
          <textarea
            aria-label={t("Commit message")}
            className="textarea"
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={t("Commit message (first line is the summary)")}
            rows={3}
            value={commitMessage}
          />
          <div className="row wrap">
            <button className="button button-primary" disabled={loading || !commitMessage.trim() || files.length === 0} onClick={() => void commit()} type="button">
              {files.length === 1 ? t("Commit 1 staged file") : t("Commit {count} staged files", { count: files.length })}
            </button>
            {info?.remotes.map((remote) => (
              <button className="button" disabled={loading || info.detached} key={remote} onClick={() => void push(remote)} type="button">
                {t("Push to {remote}…", { remote })}
              </button>
            ))}
            {info && info.remotes.length === 0 && <span className="small muted">{t("No remotes configured.")}</span>}
            <span className="small muted">{t("Commit uses only staged content. Push is a separate publication step with its own confirmation.")}</span>
          </div>
        </section>
      )}
    </div>
  );
}
