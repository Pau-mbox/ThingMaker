/**
 * Tasks inside milestones (docs/plans/odyssey.md §11.8): the line the agent
 * writes, the state the screen derives, and how a subagent is tied to a task.
 */
import { describe, expect, it } from "vitest";
import type { MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";
import { dependencyNumbers, matchAgentToTask, parseTaskLines, readyTasks, taskLinesFor, taskOwner, taskProgress, taskStatus } from "./odysseyTasks";

const step = (overrides: Partial<OdysseyStep> & { id: string; title: string }): OdysseyStep => ({
  milestoneId: "m6",
  position: 0,
  state: "pending",
  note: "",
  detail: "",
  dependsOn: [],
  ...overrides,
});

const steps = [
  step({ id: "t1", title: "Model", state: "done", agentName: "6.1-model", harness: "acp.claude", model: "sonnet" }),
  step({ id: "t2", title: "Pricing", state: "in_progress", position: 1, agentName: "pricing-core" }),
  step({ id: "t3", title: "Validation", position: 2, dependsOn: ["t2"] }),
  step({ id: "t4", title: "Docs", position: 3, dependsOn: ["t1"] }),
];

const milestone = (id: string, list: OdysseyStep[]): MilestoneRecord => ({ id, odysseyId: "o1", position: 5, title: "Economy", detail: "", state: "active", checkKind: "manual", steps: list });

describe("the task line", () => {
  it("reads every line in a reply, in order, with its optional parts", () => {
    const lines = parseTaskLines("work\nODYSSEY-TASK: milestone=6 task=2 status=done agent=pricing-core note=prices converge\nODYSSEY-TASK: milestone=6 task=3 status=in_progress\nODYSSEY-TASK: milestone=6 task=5 status=blocked note=needs harbour data");
    expect(lines).toEqual([
      { milestone: 6, task: 2, status: "done", agent: "pricing-core", note: "prices converge" },
      { milestone: 6, task: 3, status: "in_progress", agent: null, note: "" },
      { milestone: 6, task: 5, status: "blocked", agent: null, note: "needs harbour data" },
    ]);
  });

  it("skips a malformed line rather than guessing", () => {
    expect(parseTaskLines("ODYSSEY-TASK: milestone=6 status=done")).toEqual([]);
    expect(parseTaskLines("ODYSSEY-TASK: milestone=6 task=2 status=finished")).toEqual([]);
    expect(parseTaskLines("ODYSSEY-TASK: milestone=0 task=2 status=done")).toEqual([]);
    expect(parseTaskLines("")).toEqual([]);
  });
});

describe("what a task's state means on the screen", () => {
  it("derives waiting from an unfinished dependency and never stores it", () => {
    expect(taskStatus(steps[2] as OdysseyStep, steps)).toBe("waiting");
    expect(taskStatus(steps[3] as OdysseyStep, steps)).toBe("pending");
    expect(taskStatus(steps[1] as OdysseyStep, steps)).toBe("in_progress");
    expect(readyTasks(steps).map((task) => task.id)).toEqual(["t4"]);
  });

  it("numbers dependencies the way the agent was shown them", () => {
    expect(dependencyNumbers(steps[2] as OdysseyStep, steps, 5)).toEqual(["6.2"]);
    expect(taskLinesFor(5, steps)).toEqual(["6.1 [done] Model — 6.1-model", "6.2 [in progress] Pricing — pricing-core", "6.3 [waiting on 6.2] Validation", "6.4 [ready] Docs"]);
  });

  it("shows the observed harness and model as the owner, else the name", () => {
    expect(taskOwner(steps[0] as OdysseyStep)).toBe("acp.claude · sonnet");
    expect(taskOwner(steps[1] as OdysseyStep)).toBe("pricing-core");
    expect(taskOwner(steps[2] as OdysseyStep)).toBeNull();
    expect(taskProgress([milestone("m6", steps)])).toEqual({ done: 1, total: 4 });
  });
});

describe("tying a subagent to its task", () => {
  const milestones = [milestone("m1", []), milestone("m6", steps)];

  it("matches by the name the agent gave, or by a name that starts with the task number", () => {
    expect(matchAgentToTask("pricing-core", milestones)?.step.id).toBe("t2");
    // Milestone numbers are 1-based positions in the list, so 2.3 is the third task of the second milestone here.
    expect(matchAgentToTask("2.3-validation", milestones)?.step.id).toBe("t3");
    expect(matchAgentToTask("2.4 docs", milestones)?.step.id).toBe("t4");
  });

  it("matches nothing rather than guessing", () => {
    expect(matchAgentToTask("economy-backend", milestones)).toBeNull();
    expect(matchAgentToTask("2.9-nothing", milestones)).toBeNull();
    expect(matchAgentToTask("23-not-a-task", milestones)).toBeNull();
    expect(matchAgentToTask("", milestones)).toBeNull();
  });
});
