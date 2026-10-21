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
import type { LoopAtLimit, MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";
import { useStore } from "../store";
import { TASK_STATUS_LABEL, dependencyNumbers, flowBadges, matchAgentToTask, taskNumber, taskOwner, taskStatus, type TaskStatus } from "../odysseyTasks";
import { describeModel } from "./OdysseyActivity";
import { IconAgents, IconChevron } from "./icons";
import { t } from "../i18n";

function ago(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes}m ago", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("{hours}h ago", { hours });
  return t("{days}d ago", { days: Math.floor(hours / 24) });
}

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip small task-status task-status-${status}`}>{TASK_STATUS_LABEL[status]}</span>;
}

/**
 * How a task moves beyond what it waits for: who does it, which earlier
 * results it is given, and where the work goes back to when it asks for
 * changes. Each choice is saved as it is made.
 */
function TaskFlowEditor({ sessionId, milestones, milestoneIndex, stepIndex }: { sessionId: string; milestones: MilestoneRecord[]; milestoneIndex: number; stepIndex: number }) {
  const editStep = useStore((s) => s.odysseyEditStep);
  const steps = milestones[milestoneIndex]?.steps ?? [];
  const step = steps[stepIndex];
  if (!step) return null;
  const uses = step.uses ?? [];
  // Earlier milestones' tasks and this milestone's other tasks can feed it.
  const sources = milestones.slice(0, milestoneIndex + 1).flatMap((milestone, index) =>
    milestone.steps.map((candidate, position) => ({ id: candidate.id, label: `${taskNumber(index, position)} ${candidate.title}` })).filter((candidate) => candidate.id !== step.id),
  );
  const earlier = steps.slice(0, stepIndex);
  const save = (edit: Parameters<typeof editStep>[2]) => void editStep(sessionId, step.id, edit);
  return (
    <div className="odyssey-task-flow">
      <label className="row small">
        <span className="muted">{t("Who does it")}</span>
        <select className="input" onChange={(event) => save({ kind: event.target.value === "approval" ? "approval" : "work" })} value={step.kind ?? "work"}>
          <option value="work">{t("the team")}</option>
          <option value="approval">{t("you: the run stops and asks you to approve")}</option>
        </select>
      </label>
      {sources.length > 0 && (
        <fieldset className="odyssey-task-uses">
          <legend className="small muted">{t("Given the results of")}</legend>
          {sources.map((source) => (
            <label className="row small" key={source.id}>
              <input
                checked={uses.includes(source.id)}
                onChange={(event) => save({ uses: event.target.checked ? [...uses, source.id] : uses.filter((id) => id !== source.id) })}
                type="checkbox"
              />
              <span>{source.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {earlier.length > 0 && (
        <label className="row small">
          <span className="muted">{step.kind === "approval" ? t("When you send it back, go back to") : t("When it asks for changes, go back to")}</span>
          <select className="input" onChange={(event) => save({ loopTo: event.target.value })} value={step.loopTo ?? ""}>
            <option value="">{step.kind === "approval" ? t("the tasks it waits on") : t("nowhere: no loop")}</option>
            {earlier.map((candidate, index) => (
              <option key={candidate.id} value={candidate.id}>
                {taskNumber(milestoneIndex, index)} {candidate.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {step.loopTo && step.kind !== "approval" && (
        <div className="row wrap small">
          <label className="row">
            <span className="muted">{t("Rounds")}</span>
            <input
              aria-label={t("Rounds")}
              className="input odyssey-task-rounds"
              min={1}
              onChange={(event) => save({ loopLimit: Number.parseInt(event.target.value, 10) || 0 })}
              placeholder={t("no limit")}
              type="number"
              value={step.loopLimit ?? ""}
            />
          </label>
          {step.loopLimit && (
            <label className="row">
              <span className="muted">{t("then")}</span>
              <select className="input" onChange={(event) => save({ loopAtLimit: event.target.value as LoopAtLimit })} value={step.loopAtLimit ?? "ask"}>
                <option value="ask">{t("ask me")}</option>
                <option value="stop">{t("stop the run")}</option>
                <option value="continue">{t("carry on with the work as it is")}</option>
              </select>
            </label>
          )}
        </div>
      )}
      {step.loopTo && step.kind !== "approval" && <p className="small muted">{t("The worker on this task ends its reply with a verdict; changes send the work back and the tasks in between run again with what was asked.")}</p>}
    </div>
  );
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
              <th>{t("Task")}</th>
              <th>{t("Owner")}</th>
              <th>{t("Status")}</th>
              <th>{t("Depends on")}</th>
              <th>{t("Updated")}</th>
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
              const badges = flowBadges(step, milestones.length > 0 ? milestones : [milestone], milestones.length > 0 ? milestoneIndex : 0);
              return (
                <tr className={`task-row task-${status} ${running ? "task-live" : ""}`} key={step.id}>
                  <td className="odyssey-task-number mono">{number}</td>
                  <td className="odyssey-task-cell">
                    <button aria-expanded={unfolded} className="odyssey-task-title" onClick={() => setOpen(unfolded ? null : step.id)} type="button">
                      <span>{step.title}</span>
                      <IconChevron open={unfolded} size={11} />
                    </button>
                    {badges.length > 0 && (
                      <span className="row wrap odyssey-task-badges">
                        {badges.map((badge) => (
                          <span className={`chip small ${step.kind === "approval" && badge === badges[0] ? "chip-accent" : ""}`} key={badge}>
                            {badge}
                          </span>
                        ))}
                      </span>
                    )}
                    {unfolded && step.detail && <p className="odyssey-task-detail">{step.detail}</p>}
                    {unfolded && step.note && status !== "pending" && (
                      <p className="odyssey-task-detail odyssey-task-note" title={t("the agent's note on this task")}>
                        {step.note}
                      </p>
                    )}
                    {unfolded && step.result && (
                      <details className="odyssey-task-result">
                        <summary className="small muted">{t("Result")}</summary>
                        <pre className="text odyssey-inbox-output">{step.result}</pre>
                      </details>
                    )}
                    {unfolded && <TaskFlowEditor milestoneIndex={milestones.length > 0 ? milestoneIndex : 0} milestones={milestones.length > 0 ? milestones : [milestone]} sessionId={sessionId} stepIndex={index} />}
                  </td>
                  <td>
                    {who ? (
                      <span className="odyssey-task-owner" title={step.agentName ?? undefined}>
                        <IconAgents size={11} />
                        <span className="mono">{who}</span>
                        {running && <span className="spinner spinner-xs" aria-label={t("working")} />}
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
            <input aria-label={t("New task")} className="input" onChange={(event) => setTitle(event.target.value)} placeholder={t("Add a task…")} value={title} />
          </form>
          {milestone.state !== "verified" && milestone.state !== "skipped" && (
            <button
              className="link small"
              disabled={asked}
              onClick={() => {
                setAsked(true);
                void requestTasks(sessionId, milestoneIndex);
              }}
              title={t("Queues a change for the agent: break this milestone into tasks in its next reply")}
              type="button"
            >
              {asked ? t("asked — it arrives with the next prompt") : steps.length === 0 ? t("ask the agent to break it into tasks") : t("ask the agent for more tasks")}
            </button>
          )}
          {steps.length === 0 && !asked && <span className="small muted">{t("No tasks yet.")}</span>}
        </div>
      )}
    </div>
  );
}
