/**
 * The parts of a Big Thing run that are about who works and where
 * (ADR-010): how the plan is handed out, the account policy, the run's own
 * branch, the timeline of who did each milestone, and the project's shared
 * memory. All of it reads the record; actions go to the engine.
 */
import { useCallback, useEffect, useState } from "react";
import { PROVIDER_LABELS, type AccountPolicy, type Dispatch, type GoalEdit, type MemoryEntry, type MemoryKind, type OdysseyView, type Provider, type RunCommit } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";

const DISPATCH_LABEL: Record<Dispatch, string> = { agent: "The orchestrator delegates", runner: "Big Thing hands out the tasks" };
const DISPATCH_HINT: Record<Dispatch, string> = {
  agent: "The orchestrator decides which task goes to which worker, through its team tools.",
  runner: "Ready tasks — nothing they depend on is still open — go to the team's workers in parallel, by the capability each task names. The orchestrator plans, verifies and reports.",
};
const POLICY_LABEL: Record<AccountPolicy, string> = { drain: "Use one account until it runs out", spread: "Spread across the accounts" };
const POLICY_HINT: Record<AccountPolicy, string> = {
  drain: "The run stays where it is and moves only when this account is spent and another is not. Each move costs a fresh briefing.",
  spread: "At a milestone boundary the run moves to the account with clearly more room left, so both windows last longer. Needs “Either account”.",
};

/** Settings rows for the engine's options. */
export function RunOptions({ view, onEdit }: { view: OdysseyView; onEdit: (edit: GoalEdit) => void }) {
  const { goal } = view;
  const dispatch = goal.dispatch ?? "agent";
  const policy = goal.accountPolicy ?? "drain";
  const isolated = !!goal.worktreePath;
  return (
    <>
      <label className="odyssey-field">
        <span className="small">Who hands out the tasks</span>
        <select aria-label="Who hands out the tasks" className="select" onChange={(event) => onEdit({ dispatch: event.target.value as Dispatch })} value={dispatch}>
          {(Object.keys(DISPATCH_LABEL) as Dispatch[]).map((value) => (
            <option key={value} value={value}>
              {DISPATCH_LABEL[value]}
            </option>
          ))}
        </select>
        <span className="small muted">{DISPATCH_HINT[dispatch]}</span>
      </label>
      {dispatch === "runner" && (
        <label className="odyssey-toggle">
          <input checked={!!goal.reviewTasks} onChange={(event) => onEdit({ reviewTasks: event.target.checked })} type="checkbox" />
          <span className="small">Review every finished task on another provider before it counts as done</span>
        </label>
      )}
      <label className="odyssey-field">
        <span className="small">How it spends the accounts</span>
        <select aria-label="How it spends the accounts" className="select" onChange={(event) => onEdit({ accountPolicy: event.target.value as AccountPolicy })} value={policy}>
          {(Object.keys(POLICY_LABEL) as AccountPolicy[]).map((value) => (
            <option key={value} value={value}>
              {POLICY_LABEL[value]}
            </option>
          ))}
        </select>
        <span className="small muted">
          {POLICY_HINT[policy]} Either way, a turn the forecast says would not fit is moved or held until the reset before it is sent.
        </span>
      </label>
      <label className="odyssey-toggle">
        <input checked={!!goal.isolate || isolated} disabled={isolated || goal.state !== "draft"} onChange={(event) => onEdit({ isolate: event.target.checked })} type="checkbox" />
        <span className="small">
          {isolated ? (
            <>
              Runs in its own worktree on <span className="mono">{goal.branch}</span>
            </>
          ) : (
            "Run in its own branch and worktree (Git repositories; chosen before the run starts)"
          )}
        </span>
      </label>
    </>
  );
}

/** The run's own branch: its checkpoints, a rollback, and the merge back. */
export function WorktreeCard({ view, sessionId }: { view: OdysseyView; sessionId: string }) {
  const { goal } = view;
  const setError = useStore((s) => s.setError);
  const refresh = useStore((s) => s.refreshOdyssey);
  const [commits, setCommits] = useState<RunCommit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState<string | null>(null);
  const load = useCallback(() => {
    void api
      .bigthingCommits(goal.id)
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [goal.id]);
  useEffect(load, [load, goal.updatedAt]);
  if (!goal.branch) return null;

  const rollback = async (commit: RunCommit) => {
    const confirmed = await api.confirmDialog({
      title: "Roll the run back to this checkpoint?",
      message: `Everything the run did after “${commit.subject}” is dropped from its worktree, including files it has not committed. Your own checkout is not touched. The run is paused afterwards.`,
      okLabel: "Roll back",
      cancelLabel: "Keep it",
      warning: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.bigthingRollback(goal.id, commit.commit);
      await refresh(sessionId, goal.id);
      load();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    setBusy(true);
    try {
      const outcome = await api.bigthingMerge(goal.id);
      setMerged(outcome.outcome === "merged" ? `Merged (${outcome.commit.slice(0, 10)}).` : outcome.outcome === "up_to_date" ? "Nothing to merge." : `It would conflict in ${outcome.files.join(", ")}; nothing was changed.`);
      await refresh(sessionId, goal.id);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card odyssey-branch">
      <header className="work-head">
        <span className="work-title">Branch</span>
        <span className="small mono">{goal.branch}</span>
      </header>
      <p className="small muted">
        The run works in <span className="mono">{goal.worktreePath}</span>. Every turn that changed something is a commit here; your checkout stays as it was until
        you merge.
      </p>
      <div className="row wrap">
        <button className="button button-small button-primary" disabled={busy} onClick={() => void merge()} type="button">
          Merge into the checkout
        </button>
        {merged && <span className="small">{merged}</span>}
      </div>
      {commits && commits.length > 0 ? (
        <ol className="odyssey-commits">
          {commits.map((commit) => (
            <li className="row" key={commit.commit}>
              <span className="mono small">{commit.commit.slice(0, 8)}</span>
              <span className="small odyssey-grow">{commit.subject}</span>
              <button className="link small" disabled={busy} onClick={() => void rollback(commit)} type="button">
                roll back to here
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">No checkpoints committed yet.</p>
      )}
    </section>
  );
}

type Worked = { provider?: Provider; model?: string; prompts: number; first: number; last: number };

/** Who worked each milestone, from the record: the prompts and the tasks. */
export function Timeline({ view }: { view: OdysseyView }) {
  const rows = view.milestones.map((milestone, index) => {
    const prompts = view.journal.filter((entry) => entry.kind === "continuation" && entry.milestoneId === milestone.id);
    const by = new Map<string, Worked>();
    for (const entry of prompts) {
      const key = `${entry.provider ?? "?"}|${entry.model ?? ""}`;
      const current = by.get(key) ?? { ...(entry.provider ? { provider: entry.provider } : {}), ...(entry.model ? { model: entry.model } : {}), prompts: 0, first: entry.at, last: entry.at };
      current.prompts += 1;
      current.first = Math.min(current.first, entry.at);
      current.last = Math.max(current.last, entry.at);
      by.set(key, current);
    }
    const workers = milestone.steps.filter((step) => step.agentName || step.harness).map((step) => ({ step, owner: step.model ? `${step.harness ?? "worker"} · ${step.model}` : (step.harness ?? step.agentName ?? "") }));
    return { milestone, index, orchestrators: [...by.values()], workers };
  });
  return (
    <section className="card odyssey-team-timeline">
      <header className="work-head">
        <span className="work-title">Who did what</span>
      </header>
      {rows.length === 0 ? (
        <p className="small muted">No milestones yet.</p>
      ) : (
        <ol className="odyssey-who">
          {rows.map(({ milestone, index, orchestrators, workers }) => (
            <li key={milestone.id}>
              <div className="row wrap">
                <strong className="small">
                  {index + 1}. {milestone.title}
                </strong>
                <span className="chip small">{milestone.state}</span>
              </div>
              {orchestrators.length === 0 && workers.length === 0 && <p className="small muted">Not worked yet.</p>}
              {orchestrators.map((entry) => (
                <p className="small" key={`${entry.provider}-${entry.model}`}>
                  Led by {entry.provider ? PROVIDER_LABELS[entry.provider] : "an earlier build"}
                  {entry.model ? ` · ${entry.model}` : ""} — {entry.prompts} continuation{entry.prompts === 1 ? "" : "s"},{" "}
                  {new Date(entry.first).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </p>
              ))}
              {workers.map(({ step, owner }) => (
                <p className="small muted" key={step.id}>
                  {step.agentName ?? step.title}: {owner}
                  {step.review ? ` · review: ${step.review}` : ""}
                </p>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const KINDS: MemoryKind[] = ["decision", "convention", "fact", "todo", "warning"];

/** The project's shared memory: what the team wrote down, and what you add. */
export function MemoryPanel({ workspaceId, goalUpdatedAt }: { workspaceId: string; goalUpdatedAt: number }) {
  const setError = useStore((s) => s.setError);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(() => {
    void api
      .memoryList(workspaceId)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspaceId]);
  useEffect(load, [load, goalUpdatedAt]);

  const add = async () => {
    if (!title.trim()) return;
    try {
      await api.memoryWrite(workspaceId, { kind, title: title.trim(), body: body.trim() });
      setTitle("");
      setBody("");
      load();
    } catch (error) {
      setError(error);
    }
  };

  return (
    <section className="card odyssey-memory">
      <header className="work-head">
        <span className="work-title">Project memory</span>
        <span className="small muted">{entries ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}` : ""}</span>
      </header>
      <p className="small muted">The orchestrator and its workers read this with memory_read and add to it with memory_write. What you add here they see on their next read.</p>
      <form
        className="odyssey-memory-add"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <select aria-label="Kind" className="select" onChange={(event) => setKind(event.target.value as MemoryKind)} value={kind}>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input aria-label="Memory title" className="input" onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Prices are integers in cents" value={title} />
        <textarea aria-label="Memory body" className="textarea" onChange={(event) => setBody(event.target.value)} placeholder="Why, and anything the team must respect." rows={2} value={body} />
        <button className="button button-small" disabled={!title.trim()} type="submit">
          Add to memory
        </button>
      </form>
      {entries && entries.length > 0 && (
        <ul className="odyssey-memory-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="row wrap">
                <span className="chip small">{entry.kind}</span>
                <strong className="small odyssey-grow">{entry.title}</strong>
                <span className="small muted">{entry.author}</span>
                <button
                  className="link small"
                  onClick={() =>
                    void api
                      .memoryDelete(entry.id)
                      .then(load)
                      .catch((error) => setError(error))
                  }
                  type="button"
                >
                  remove
                </button>
              </div>
              {entry.body && <p className="small muted">{entry.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
