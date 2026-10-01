/**
 * Transcript cards that summarise work the session did (CTX/GIT surfaces).
 *
 * Both cards report facts from a source that is named on the card itself: the
 * code-changes card reads the review diff for the workspace, and the tests
 * card reads the tool call's own shell result. Neither is derived from the
 * model's prose, and a count is only shown when a runner printed one (with the
 * matched line available on hover), so nothing here can claim a result that
 * did not happen.
 */
import { useEffect, useState } from "react";
import type { DiffReport } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import type { EditedFile, TestRun } from "../toolSummary";
import { IconAlertCircle, IconCheckCircle, IconCode } from "./icons";

function signedCounts(additions: number, deletions: number) {
  return (
    <>
      {additions > 0 && <span className="diff-add">+{additions}</span>}
      {deletions > 0 && <span className="diff-del">−{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="muted">no line changes</span>}
    </>
  );
}

const KIND_MARK: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", mode_changed: "T" };

/**
 * A path with the directory truncating and the file name kept whole: the file
 * name is what identifies the row, so it must not be the part that is elided.
 */
function FilePath({ path, title }: { path: string; title?: string }) {
  const cut = path.lastIndexOf("/");
  const directory = cut < 0 ? "" : path.slice(0, cut + 1);
  const name = cut < 0 ? path : path.slice(cut + 1);
  return (
    <span className="file-path" title={title ?? path}>
      {directory && <span className="file-dir">{directory}</span>}
      <span className="file-name">{name}</span>
    </span>
  );
}

/** How many file rows to show before collapsing the tail into a count. */
const FILE_LIMIT = 8;

/**
 * Files this workspace has changed, with the real per-file line counts from
 * the review diff. Rendered against the newest settled turn, so it reads as
 * "changes so far" rather than a snapshot of a past moment.
 */
export function CodeChangesCard({ workspaceId, sessionId, refreshKey }: { workspaceId: string; sessionId: string; refreshKey: number }) {
  const setSessionTab = useStore((s) => s.setSessionTab);
  const repo = useStore((s) => s.repoInfo[workspaceId]);
  const [report, setReport] = useState<DiffReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Match the Changes tab's default so the card and the tab agree: the
    // working tree for a repository, the session baseline otherwise.
    const scope = repo ? "working_tree" : "baseline";
    api
      .reviewDiff(workspaceId, scope, sessionId)
      .then((response) => {
        if (cancelled) return;
        setReport(response.report);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionId, refreshKey, repo]);

  // Nothing to say yet, nothing changed, or no review surface here: stay out
  // of the transcript rather than showing an empty card.
  if (failed || !report || report.files.length === 0) return null;

  const additions = report.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = report.files.reduce((sum, file) => sum + file.deletions, 0);
  const shown = expanded ? report.files : report.files.slice(0, FILE_LIMIT);
  const hidden = report.files.length - shown.length;

  return (
    <section className="card work-card">
      <header className="work-head">
        <span className="work-glyph">
          <IconCode size={14} />
        </span>
        <span className="work-title">Code changes</span>
        <span className="work-meta">
          {report.files.length} file{report.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="work-counts">{signedCounts(additions, deletions)}</span>
        <button className="button button-small" onClick={() => setSessionTab("changes")} type="button">
          View diff
        </button>
      </header>
      <ul className="work-files">
        {shown.map((file) => (
          <li key={file.path}>
            <span className={`file-kind kind-${file.kind}`} title={file.kind.replace("_", " ")}>
              {KIND_MARK[file.kind] ?? "?"}
            </span>
            <FilePath path={file.path} {...(file.renamedFrom ? { title: `${file.path} (renamed from ${file.renamedFrom})` } : {})} />
            <span className="work-counts">{file.binary ? <span className="muted">binary</span> : signedCounts(file.additions, file.deletions)}</span>
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button className="link small" onClick={() => setExpanded(true)} type="button">
              {hidden} more file{hidden === 1 ? "" : "s"}
            </button>
          </li>
        )}
      </ul>
      <p className="work-foot small muted">
        {report.label}
        {report.truncated ? " · truncated by the diff limits" : ""}
      </p>
    </section>
  );
}

/**
 * A test run, from the shell result of the tool call that ran it. The exit
 * code decides pass or fail; a printed count is shown next to it when the
 * runner stated one.
 */
export function TestsCard({ run, millis }: { run: TestRun; millis: number | null }) {
  const [showOutput, setShowOutput] = useState(false);
  const counts = run.counts;
  const total = counts ? (counts.total ?? counts.passed + counts.failed) : null;

  return (
    <section className={`card work-card ${run.ok ? "work-ok" : "work-fail"}`}>
      <header className="work-head">
        <span className={`work-glyph ${run.ok ? "glyph-ok" : "glyph-fail"}`}>{run.ok ? <IconCheckCircle size={14} /> : <IconAlertCircle size={14} />}</span>
        <span className="work-title">Tests</span>
        <span className="work-meta">
          {counts ? (
            <span title={`read from the runner output: ${counts.evidence}`}>
              {counts.passed}/{total} passed
              {counts.failed > 0 ? `, ${counts.failed} failed` : ""}
            </span>
          ) : (
            <span title={`exit code ${run.exitCode}; the runner printed no count`}>{run.ok ? "passed" : "failed"}</span>
          )}
        </span>
        {millis !== null && <span className="work-counts muted">{millis >= 1000 ? `${(millis / 1000).toFixed(millis >= 10_000 ? 0 : 1)}s` : `${millis}ms`}</span>}
        {run.output && (
          <button className="button button-small" onClick={() => setShowOutput(!showOutput)} type="button">
            {showOutput ? "Hide output" : "View output"}
          </button>
        )}
      </header>
      {run.command && (
        <p className="work-command mono small" title="the command this tool call ran">
          {run.command}
        </p>
      )}
      {!run.ok && !counts && <p className="small muted">Exit code {run.exitCode}. The runner printed no summary line, so no count is shown.</p>}
      {showOutput && <pre className="text work-output">{run.output}</pre>}
    </section>
  );
}

/** Files a tool call reported writing, as returned by Kit's `edit` tool. */
export function EditedFilesList({ files }: { files: EditedFile[] }) {
  return (
    <ul className="work-files work-files-inline">
      {files.map((file) => (
        <li key={`${file.status}-${file.path}`}>
          <span className={`file-kind kind-${file.status === "edited" ? "modified" : file.status}`} title={file.status}>
            {KIND_MARK[file.status === "edited" ? "modified" : file.status] ?? "?"}
          </span>
          <FilePath path={file.path} />
          <span className="work-counts muted">{file.status}</span>
        </li>
      ))}
    </ul>
  );
}
