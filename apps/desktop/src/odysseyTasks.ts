/**
 * Tasks inside milestones (docs/plans/odyssey.md §11.8).
 *
 * A milestone's steps were titles with a state that nothing moved. A task is
 * the same row with three more facts on it: who is doing it, what it waits
 * for, and when it moved. The Rust engine reads the agent's task lines and
 * records them; this module only derives and formats what the screen shows.
 */
import type { MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";

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
