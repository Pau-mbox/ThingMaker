/**
 * The tasks inside a milestone (docs/plans/odyssey.md §11.8): number, title,
 * who is on it, its state, what it waits for, and when it last moved.
 *
 * Every column is read from the record. The owner is the harness and model
 * the desktop saw the task's subagent running on — or, before any subagent
 * has appeared, the name the agent gave — and a working subagent that is
 * matched to a row shows live. "Waiting" is derived from dependencies and
 * never stored. A human can move a task by hand; the record stamps that too.
 */
import { useState } from "react";
import type { MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";
import { useStore } from "../store";
import { TASK_STATUS_LABEL, dependencyNumbers, matchAgentToTask, taskNumber, taskOwner, taskStatus, type TaskStatus } from "../odysseyTasks";
import { describeModel } from "./OdysseyActivity";
import { IconAgents, IconChevron } from "./icons";

function ago(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip small task-status task-status-${status}`}>{TASK_STATUS_LABEL[status]}</span>;
}

export function TaskTable({ milestone, milestoneIndex, sessionId }: { milestone: MilestoneRecord; milestoneIndex: number; sessionId: string }) {
  const agents = useStore((s) => s.sessions[sessionId]?.projection.inspector.agents);
  const milestones = useStore((s) => s.odyssey[sessionId]?.milestones) ?? [];
  const addStep = useStore((s) => s.addStep);
  const requestTasks = useStore((s) => s.odysseyRequestTasks);
  const [title, setTitle] = useState("");
  const [asked, setAsked] = useState(false);
  // Descriptions open one at a time on request: eight of them unfolded is
  // the specification again, not a task list.
  const [open, setOpen] = useState<string | null>(null);
  const steps = milestone.steps;
  const now = Date.now();

  // A subagent working right now on one of these tasks, by the same matching
  // the observer uses, so the row shows what the stream shows.
  const live = new Map<string, { harness: string; model: string | null; status: string }>();
  for (const agent of agents?.values() ?? []) {
    if (agent.status !== "working" && agent.status !== "starting") continue;
    const match = matchAgentToTask(agent.name, milestones);
    if (match && match.milestone.id === milestone.id) live.set(match.step.id, { harness: agent.harness, model: agent.model, status: agent.status });
  }

  const owner = (step: OdysseyStep) => {
    const running = live.get(step.id);
    if (running) return describeModel({ harness: running.harness, model: running.model });
    return taskOwner(step);
  };

  return (
    <div className="odyssey-tasks">
      {steps.length > 0 && (
        <table className="odyssey-task-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Task</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Depends on</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => {
              const status = taskStatus(step, steps);
              const running = live.has(step.id);
              const who = owner(step);
              const depends = dependencyNumbers(step, steps, milestoneIndex);
              const number = taskNumber(milestoneIndex, index);
              const unfolded = open === step.id;
              const hasMore = Boolean(step.detail || (step.note && status !== "pending"));
              return (
                <tr className={`task-row task-${status} ${running ? "task-live" : ""}`} key={step.id}>
                  <td className="odyssey-task-number mono">{number}</td>
                  <td className="odyssey-task-cell">
                    {hasMore ? (
                      <button aria-expanded={unfolded} className="odyssey-task-title" onClick={() => setOpen(unfolded ? null : step.id)} type="button">
                        <span>{step.title}</span>
                        <IconChevron open={unfolded} size={11} />
                      </button>
                    ) : (
                      <span className="odyssey-task-title">{step.title}</span>
                    )}
                    {unfolded && step.detail && <p className="odyssey-task-detail">{step.detail}</p>}
                    {unfolded && step.note && status !== "pending" && (
                      <p className="odyssey-task-detail odyssey-task-note" title="the agent's note on this task">
                        {step.note}
                      </p>
                    )}
                  </td>
                  <td>
                    {who ? (
                      <span className="odyssey-task-owner" title={step.agentName ?? undefined}>
                        <IconAgents size={11} />
                        <span className="mono">{who}</span>
                        {running && <span className="spinner spinner-xs" aria-label="working" />}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <TaskStatusChip status={status} />
                  </td>
                  <td className="mono muted odyssey-task-depends">{depends.length > 0 ? depends.join(", ") : "—"}</td>
                  <td className="muted odyssey-task-updated">{step.updatedAt ? ago(now - step.updatedAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(
        <div className="row wrap odyssey-task-add">
          <form
            className="row odyssey-task-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              void addStep(sessionId, milestone.id, title.trim());
              setTitle("");
            }}
          >
            <input aria-label="New task" className="input" onChange={(event) => setTitle(event.target.value)} placeholder="Add a task…" value={title} />
          </form>
          {milestone.state !== "verified" && milestone.state !== "skipped" && (
            <button
              className="link small"
              disabled={asked}
              onClick={() => {
                setAsked(true);
                void requestTasks(sessionId, milestoneIndex);
              }}
              title="Queues a change for the agent: break this milestone into tasks in its next reply"
              type="button"
            >
              {asked ? "asked — it arrives with the next prompt" : steps.length === 0 ? "ask the agent to break it into tasks" : "ask the agent for more tasks"}
            </button>
          )}
          {steps.length === 0 && !asked && <span className="small muted">No tasks yet.</span>}
        </div>
      )}
    </div>
  );
}
