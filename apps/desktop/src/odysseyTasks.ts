/**
 * Tasks inside milestones (docs/plans/odyssey.md §11.8).
 *
 * A milestone's steps were titles with a state that nothing moved. A task is
 * the same row with three more facts on it: who is doing it, what it waits
 * for, and when it moved. Those come from three lanes, the same three the
 * rest of Super Thing uses — the plan proposes tasks, the agent reports their
 * state on a line, the desktop records the subagent it saw doing them.
 *
 * Pure: parsing, derivation and formatting. The store applies.
 */
import type { MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";

/** The task line the agent writes, several per reply, quoted in the briefing and the skill. */
export const TASK_GRAMMAR = "SUPERTHING-TASK: milestone=<m> task=<t> status=<in_progress|done|blocked> agent=<subagent name, optional> note=<one line, optional>";

export type TaskLine = { milestone: number; task: number; status: "in_progress" | "done" | "blocked"; agent: string | null; note: string };

/** Every readable task line in a reply, in order. A malformed line is skipped, never guessed. */
export function parseTaskLines(text: string): TaskLine[] {
  if (!text) return [];
  const lines: TaskLine[] = [];
  for (const match of text.matchAll(/^\s*(?:SUPERTHING|ODYSSEY)-TASK:\s*(.+)$/gim)) {
    const body = match[1] ?? "";
    const milestone = /(?:^|\s)milestone\s*=\s*(\d+)/i.exec(body);
    const task = /(?:^|\s)task\s*=\s*(\d+)/i.exec(body);
    const status = /(?:^|\s)status\s*=\s*(in_progress|done|blocked)/i.exec(body);
    if (!milestone || !task || !status) continue;
    const m = Number.parseInt(milestone[1] ?? "", 10);
    const t = Number.parseInt(task[1] ?? "", 10);
    if (!Number.isFinite(m) || !Number.isFinite(t) || m < 1 || t < 1) continue;
    // `agent=` runs to the next key or the end; a name has no spaces.
    const agent = /(?:^|\s)agent\s*=\s*([^\s]+)/i.exec(body)?.[1]?.replace(/^`|`$/g, "") ?? null;
    const note = /(?:^|\s)note\s*=\s*(.*)$/i.exec(body)?.[1]?.trim() ?? "";
    lines.push({ milestone: m, task: t, status: status[1]?.toLowerCase() as TaskLine["status"], agent: agent && agent !== "-" ? agent : null, note });
  }
  return lines;
}

/** A task's state for the screen: `waiting` is derived, never stored. */
export type TaskStatus = "pending" | "waiting" | "in_progress" | "done" | "blocked";

export function taskStatus(step: Pick<OdysseyStep, "state" | "dependsOn">, siblings: Pick<OdysseyStep, "id" | "state">[]): TaskStatus {
  if (step.state !== "pending") return step.state;
  const blocked = step.dependsOn.some((id) => {
    const dependency = siblings.find((sibling) => sibling.id === id);
    return dependency !== undefined && dependency.state !== "done";
  });
  return blocked ? "waiting" : "pending";
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "To do",
  waiting: "Waiting",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
};

/** `6.3`: the milestone's number and the task's place in it, both 1-based. */
export function taskNumber(milestoneIndex: number, taskIndex: number): string {
  return `${milestoneIndex + 1}.${taskIndex + 1}`;
}

/** The numbers of the tasks this one waits for, in the milestone's order. */
export function dependencyNumbers(step: Pick<OdysseyStep, "dependsOn">, siblings: Pick<OdysseyStep, "id">[], milestoneIndex: number): string[] {
  return step.dependsOn
    .map((id) => siblings.findIndex((sibling) => sibling.id === id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .map((index) => taskNumber(milestoneIndex, index));
}

/** Tasks that can start now: not started, and nothing they wait for is open. */
export function readyTasks(steps: OdysseyStep[]): OdysseyStep[] {
  return steps.filter((step) => taskStatus(step, steps) === "pending");
}

export function taskProgress(milestones: Pick<MilestoneRecord, "steps">[]): { done: number; total: number } {
  const steps = milestones.flatMap((milestone) => milestone.steps);
  return { done: steps.filter((step) => step.state === "done").length, total: steps.length };
}

/** Who is on a task, for a column: the observed harness and model, else the name, else nothing. */
export function taskOwner(step: Pick<OdysseyStep, "agentName" | "harness" | "model">): string | null {
  if (step.model) return `${step.harness ?? "harness"} · ${step.model}`;
  if (step.harness) return `${step.harness} · default`;
  return step.agentName ?? null;
}

/**
 * The milestone's tasks as the continuation lists them, one line each with
 * the state the record holds — so a resumed or compacted session knows what
 * is done without redoing it, and what it may start.
 */
export function taskLinesFor(milestoneIndex: number, steps: OdysseyStep[]): string[] {
  return steps.map((step, index) => {
    const status = taskStatus(step, steps);
    const label =
      status === "waiting"
        ? `waiting on ${dependencyNumbers(step, steps, milestoneIndex).join(", ")}`
        : status === "pending"
          ? "ready"
          : status.replace("_", " ");
    const owner = step.agentName ? ` — ${step.agentName}` : "";
    return `${taskNumber(milestoneIndex, index)} [${label}] ${step.title}${owner}`;
  });
}

/**
 * The task a subagent is working on, from its name: the name the agent gave
 * on a task line, or a name that starts with the task's number (`6.3-pricing`).
 * Nothing else matches — a guess here would put a model on the wrong row.
 */
export function matchAgentToTask(agentName: string, milestones: MilestoneRecord[]): { milestone: MilestoneRecord; milestoneIndex: number; step: OdysseyStep; stepIndex: number } | null {
  const name = agentName.trim();
  if (!name) return null;
  for (const [milestoneIndex, milestone] of milestones.entries()) {
    const byName = milestone.steps.findIndex((step) => step.agentName === name);
    if (byName >= 0) return { milestone, milestoneIndex, step: milestone.steps[byName] as OdysseyStep, stepIndex: byName };
  }
  const numbered = /^(\d+)\.(\d+)(?:\b|[-_ ])/.exec(name);
  if (numbered) {
    const milestone = milestones[Number.parseInt(numbered[1] ?? "", 10) - 1];
    const stepIndex = Number.parseInt(numbered[2] ?? "", 10) - 1;
    const step = milestone?.steps[stepIndex];
    if (milestone && step) return { milestone, milestoneIndex: milestones.indexOf(milestone), step, stepIndex };
  }
  return null;
}
