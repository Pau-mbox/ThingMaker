import { useCallback, useEffect, useState } from "react";
import type { RepositoryInfo, WorktreeView } from "@thingmaker/contracts";
import { api, toDesktopError } from "../ipc";
import { useStore } from "../store";
import { t } from "../i18n";

/**
 * Worktrees for parallel writers (GIT-01..04). Created from an explicitly
 * selected ref under the application data directory, never inside the repo.
 * Uncommitted changes are carried over only when the user says so. Removal
 * previews live sessions and dirty files, snapshots them, then confirms.
 */
export function WorktreesSection({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<WorktreeView | null>(null);
  const [info, setInfo] = useState<RepositoryInfo | null>(null);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [carry, setCarry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const addWorkspaceByPath = useStore((s) => s.addWorkspaceByPath);
  const report = (error: unknown) => useStore.setState({ error: toDesktopError(error) });

  const load = useCallback(async () => {
    try {
      const [worktrees, repository] = await Promise.all([api.worktreeList(workspaceId), api.gitInfo(workspaceId)]);
      setView(worktrees);
      setInfo(repository);
      if (!base) setBase(repository.head);
    } catch (error) {
      setMessage(toDesktopError(error).message);
    }
  }, [workspaceId, base]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const create = async () => {
    if (!branch.trim() || !base) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.worktreeCreate(workspaceId, branch.trim(), base, carry);
      const where = { path: created.record.path, branch: created.record.branch, base: created.record.baseRef };
      setMessage(
        carry
          ? t(
              "Created {path} on {branch} from {base} (carried {bytes} bytes of patch and {files} untracked file(s)). It is a separate workspace: review and trust it before starting sessions there.",
              { ...where, bytes: created.carriedPatchBytes, files: created.carriedUntracked },
            )
          : t("Created {path} on {branch} from {base}. It is a separate workspace: review and trust it before starting sessions there.", where),
      );
      setBranch("");
      await load();
      await addWorkspaceByPath(created.workspace.displayPath);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (worktreeId: string) => {
    setBusy(true);
    try {
      const preview = await api.worktreeRemovePreview(workspaceId, worktreeId);
      if (preview.liveSessions.length > 0) {
        setMessage(
          preview.liveSessions.length === 1
            ? t("1 live session still uses {path}. Stop it first.", { path: preview.path })
            : t("{count} live sessions still use {path}. Stop them first.", { count: preview.liveSessions.length, path: preview.path }),
        );
        return;
      }
      const details = [
        t("Path: {path}", { path: preview.path }),
        t("Branch: {branch} (the branch itself is kept)", { branch: preview.branch }),
        preview.dirtyFiles.length ? t("Modified files (snapshotted before removal): {files}", { files: preview.dirtyFiles.join(", ") }) : t("No modified tracked files."),
        preview.untrackedFiles.length ? t("Untracked files (snapshotted before removal): {files}", { files: preview.untrackedFiles.join(", ") }) : t("No untracked files."),
      ].join("\n");
      const ok = await api.confirmDialog({ title: t("Remove worktree?"), message: details, okLabel: t("Remove worktree"), cancelLabel: t("Keep"), warning: true });
      if (!ok) return;
      const snapshot = await api.worktreeRemove(workspaceId, worktreeId);
      setMessage(snapshot ? t("Removed. Dirty and untracked content was saved as baseline {id}.", { id: snapshot.slice(0, 8) }) : t("Removed."));
      await load();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const pin = async (worktreeId: string, pinned: boolean) => {
    try {
      await api.worktreePin(worktreeId, pinned);
      await load();
    } catch (error) {
      report(error);
    }
  };

  if (!info) {
    return message ? <p className="small muted">{message}</p> : null;
  }

  return (
    <section>
      <h3>{t("Worktrees")}</h3>
      <p className="small muted">
        {t(
          "A worktree gives a parallel session its own working copy on its own branch. It isolates edits, not host access, and shares the repository's metadata. Managed worktrees live under",
        )}{" "}
        <span className="mono">{view?.managedRoot}</span>.
      </p>
      <div className="row wrap">
        <input aria-label={t("New branch name")} className="input inline" onChange={(e) => setBranch(e.target.value)} placeholder="new-branch-name" value={branch} />
        <label className="small">
          {t("from")}{" "}
          <select aria-label={t("Base ref")} className="input inline" onChange={(e) => setBase(e.target.value)} value={base}>
            {info.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="check small" title={t("Tracked changes are applied as a patch and untracked files copied. Nothing is stashed or reset in this checkout.")}>
          <input checked={carry} onChange={(e) => setCarry(e.target.checked)} type="checkbox" /> {t("carry uncommitted changes")}
        </label>
        <button className="button" disabled={busy || !branch.trim()} onClick={() => void create()} type="button">
          {t("Create worktree")}
        </button>
      </div>
      {message && <p className="small muted">{message}</p>}
      <ul className="sessions">
        {view?.managed.map((worktree) => (
          <li className="row wrap" key={worktree.id}>
            <span className="mono small">{worktree.path}</span>
            <span className="chip small">{worktree.branch}</span>
            <span className="small muted">{t("from {ref}", { ref: worktree.baseRef })}</span>
            {worktree.pinned && <span className="chip small chip-active">{t("pinned")}</span>}
            <button className="link small" onClick={() => void addWorkspaceByPath(worktree.path)} type="button">
              {t("open as workspace")}
            </button>
            <button className="link small" onClick={() => void pin(worktree.id, !worktree.pinned)} type="button">
              {worktree.pinned ? t("unpin") : t("pin")}
            </button>
            <button className="link small" disabled={busy || worktree.pinned} onClick={() => void remove(worktree.id)} type="button">
              {t("remove…")}
            </button>
          </li>
        ))}
        {view?.git
          .filter((g) => !g.isMain && !view.managed.some((m) => m.path === g.path))
          .map((g) => (
            <li className="row wrap" key={g.path}>
              <span className="mono small">{g.path}</span>
              <span className="chip small">{g.branch ?? g.head ?? t("detached")}</span>
              <span className="small muted">{t("not managed by the desktop")}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
