import { useCallback, useEffect, useState } from "react";
import type { RepositoryInfo, WorktreeView } from "@thingmaker/contracts";
import { api, toDesktopError } from "../ipc";
import { useStore } from "../store";

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
      setMessage(
        `Created ${created.record.path} on ${created.record.branch} from ${created.record.baseRef}${carry ? ` (carried ${created.carriedPatchBytes} bytes of patch and ${created.carriedUntracked} untracked file(s))` : ""}. It is a separate workspace: review and trust it before starting sessions there.`,
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
        setMessage(`${preview.liveSessions.length} live session(s) still use ${preview.path}. Stop them first.`);
        return;
      }
      const details = [
        `Path: ${preview.path}`,
        `Branch: ${preview.branch} (the branch itself is kept)`,
        preview.dirtyFiles.length ? `Modified files (snapshotted before removal): ${preview.dirtyFiles.join(", ")}` : "No modified tracked files.",
        preview.untrackedFiles.length ? `Untracked files (snapshotted before removal): ${preview.untrackedFiles.join(", ")}` : "No untracked files.",
      ].join("\n");
      const ok = await api.confirmDialog({ title: "Remove worktree?", message: details, okLabel: "Remove worktree", cancelLabel: "Keep", warning: true });
      if (!ok) return;
      const snapshot = await api.worktreeRemove(workspaceId, worktreeId);
      setMessage(snapshot ? `Removed. Dirty and untracked content was saved as baseline ${snapshot.slice(0, 8)}.` : "Removed.");
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
      <h3>Worktrees</h3>
      <p className="small muted">
        A worktree gives a parallel session its own working copy on its own branch. It isolates edits, not host access, and shares the
        repository's metadata. Managed worktrees live under <span className="mono">{view?.managedRoot}</span>.
      </p>
      <div className="row wrap">
        <input aria-label="New branch name" className="input inline" onChange={(e) => setBranch(e.target.value)} placeholder="new-branch-name" value={branch} />
        <label className="small">
          from{" "}
          <select aria-label="Base ref" className="input inline" onChange={(e) => setBase(e.target.value)} value={base}>
            {info.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="check small" title="Tracked changes are applied as a patch and untracked files copied. Nothing is stashed or reset in this checkout.">
          <input checked={carry} onChange={(e) => setCarry(e.target.checked)} type="checkbox" /> carry uncommitted changes
        </label>
        <button className="button" disabled={busy || !branch.trim()} onClick={() => void create()} type="button">
          Create worktree
        </button>
      </div>
      {message && <p className="small muted">{message}</p>}
      <ul className="sessions">
        {view?.managed.map((worktree) => (
          <li className="row wrap" key={worktree.id}>
            <span className="mono small">{worktree.path}</span>
            <span className="chip small">{worktree.branch}</span>
            <span className="small muted">from {worktree.baseRef}</span>
            {worktree.pinned && <span className="chip small chip-active">pinned</span>}
            <button className="link small" onClick={() => void addWorkspaceByPath(worktree.path)} type="button">
              open as workspace
            </button>
            <button className="link small" onClick={() => void pin(worktree.id, !worktree.pinned)} type="button">
              {worktree.pinned ? "unpin" : "pin"}
            </button>
            <button className="link small" disabled={busy || worktree.pinned} onClick={() => void remove(worktree.id)} type="button">
              remove…
            </button>
          </li>
        ))}
        {view?.git
          .filter((g) => !g.isMain && !view.managed.some((m) => m.path === g.path))
          .map((g) => (
            <li className="row wrap" key={g.path}>
              <span className="mono small">{g.path}</span>
              <span className="chip small">{g.branch ?? g.head ?? "detached"}</span>
              <span className="small muted">not managed by the desktop</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
