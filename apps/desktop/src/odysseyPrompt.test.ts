import { describe, expect, it } from "vitest";
import { ODYSSEY_AGENT_NOTES_DIR, ODYSSEY_DELEGATE, ODYSSEY_STATE_NOTE, type MilestoneRecord, type OdysseyRecord } from "@thingmaker/contracts";
import type { WorkspaceNotes } from "@thingmaker/contracts";
import { agentNotesSince, buildBriefing, buildContinuation, checkLabel, handoffLine, REPORT_GRAMMAR, type Delta } from "./odysseyPrompt";

const goal: OdysseyRecord = {
  id: "o1",
  workspaceId: "w1",
  sessionId: "s1",
  title: "Ship onboarding v2",
  brief: "Design and implement a new user onboarding experience.",
  state: "draft",
  stopCondition: "goal_complete",
  onUsageReset: "notify_only",
  onReport: "continue",
  onPlanChange: "review",
  orchestrator: "codex",
  deadTurnMinutes: 30,
  maxContinuations: 50,
  continuationsUsed: 0,
  tokenBudget: 200_000,
  tokensUsed: 0,
  createdAt: 0,
  updatedAt: 0,
};

function milestone(overrides: Partial<MilestoneRecord> & { title: string }): MilestoneRecord {
  return {
    id: `m-${overrides.title}`,
    odysseyId: "o1",
    position: 0,
    detail: "",
    state: "planned",
    checkKind: "manual",
    steps: [],
    ...overrides,
  };
}

describe("check labels", () => {
  it("names the command that has to exit 0", () => {
    expect(checkLabel("command", "cargo test -p foo")).toBe("check: `cargo test -p foo` must exit 0");
    expect(checkLabel("tests_pass", "pnpm test")).toBe("check: `pnpm test` must exit 0");
  });

  it("lists the files that have to exist", () => {
    expect(checkLabel("files_exist", "docs/a.md\ndocs/b.md")).toBe("check: these files must exist: docs/a.md, docs/b.md");
  });

  it("says who decides a manual milestone", () => {
    expect(checkLabel("manual", null)).toBe("check: the user ticks it");
  });

  it("does not pretend a check exists when no spec is set", () => {
    expect(checkLabel("command", null)).toContain("not set yet");
  });
});

describe("the briefing", () => {
  const milestones = [
    milestone({ title: "Audit existing flow", detail: "Review the current flow.", position: 0 }),
    milestone({ title: "Define acceptance tests", checkKind: "tests_pass", checkSpec: "pnpm test", position: 1 }),
  ];

  it("tells the model the mechanics it cannot infer", () => {
    const text = buildBriefing(goal, milestones);
    expect(text).toContain("You are working under Super Thing");
    expect(text).toContain("Do not ask permission to continue");
    expect(text).toContain("A long gap between turns is normal and means nothing failed");
    expect(text).toContain("A milestone is done when its check passes, not when you say so");
    expect(text).toContain("including from a subagent");
    expect(text).toContain(REPORT_GRAMMAR);
  });

  it("lists every milestone with its check", () => {
    const text = buildBriefing(goal, milestones);
    expect(text).toContain("1. Audit existing flow — Review the current flow.  [check: the user ticks it]");
    expect(text).toContain("2. Define acceptance tests  [check: `pnpm test` must exit 0]");
  });

  it("states the stop condition and the budget", () => {
    expect(buildBriefing(goal, milestones)).toContain("Work through every milestone in order.");
    expect(buildBriefing({ ...goal, stopCondition: "milestone_complete" }, milestones)).toContain("Stop after each milestone");
    expect(buildBriefing(goal, milestones)).toContain("at most 50 continuations, and 200,000 tokens");
    const { tokenBudget: _budget, ...noBudget } = goal;
    expect(buildBriefing(noBudget, milestones)).toContain("at most 50 continuations.");
  });

  it("asks for milestones instead of pretending there is a plan", () => {
    expect(buildBriefing(goal, [])).toContain("none yet; ask the user for them");
  });
});

describe("the continuation", () => {
  const active = milestone({
    title: "Build onboarding screens",
    detail: "Implement the new onboarding UI.",
    position: 2,
    state: "active",
    checkKind: "tests_pass",
    checkSpec: "pnpm test",
    steps: [
      { id: "s1", milestoneId: "m1", position: 0, title: "Set up components", state: "done", note: "", detail: "", dependsOn: [] },
      { id: "s2", milestoneId: "m1", position: 1, title: "Implement screens", state: "in_progress", note: "", detail: "", dependsOn: [] },
      { id: "s3", milestoneId: "m1", position: 2, title: "Add analytics", state: "pending", note: "", detail: "", dependsOn: [] },
    ],
  });

  it("points at the milestone and lists every task with the state the record holds", () => {
    const text = buildContinuation({ milestone: active, index: 2, total: 5, deltas: [] });
    expect(text.split("\n")[0]).toBe("Continue. Milestone 3/5: Build onboarding screens.");
    // Done tasks are listed too: a session that lost its thread must not redo them.
    expect(text).toContain("3.1 [done] Set up components");
    expect(text).toContain("3.2 [in progress] Implement screens");
    expect(text).toContain("3.3 [ready] Add analytics");
    expect(text).toContain("Report task moves with: SUPERTHING-TASK:");
    expect(text).toContain("Its check: `pnpm test` must exit 0");
  });

  it("stays short: no goal restatement, no plan dump", () => {
    const text = buildContinuation({ milestone: active, index: 2, total: 5, deltas: [] });
    expect(text).not.toContain("Ship onboarding v2");
    expect(text).not.toContain("You are working under Super Thing");
    expect(text.length).toBeLessThan(700);
  });

  it("says what a task waits for, and who is on it", () => {
    const waiting = milestone({
      title: "Economy",
      state: "active",
      steps: [
        { id: "t1", milestoneId: "m", position: 0, title: "Model", state: "in_progress", note: "", detail: "", dependsOn: [], agentName: "6.1-model" },
        { id: "t2", milestoneId: "m", position: 1, title: "Pricing", state: "pending", note: "", detail: "", dependsOn: ["t1"] },
      ],
    });
    const text = buildContinuation({ milestone: waiting, index: 5, total: 12, deltas: [] });
    expect(text).toContain("6.1 [in progress] Model — 6.1-model");
    expect(text).toContain("6.2 [waiting on 6.1] Pricing");
  });

  it("omits the check line for a milestone only the user can tick", () => {
    const manual = milestone({ title: "Review and handoff", steps: [] });
    expect(buildContinuation({ milestone: manual, index: 4, total: 5, deltas: [] })).not.toContain("Its check");
  });

  it("tells the model every state change once, in the record's words", () => {
    const deltas: Delta[] = [
      { kind: "verified", milestone: 2, title: "Define acceptance tests", evidence: "pnpm test exited 0" },
      { kind: "check_failed", milestone: 3, title: "Build screens", command: "pnpm test", exitCode: 1, tail: "2 failed" },
      { kind: "plan_edited", summary: 'milestone 4 added "Verify accessibility"' },
      { kind: "resumed", waitedMs: 8_000_000, checkpointFiles: 12 },
      { kind: "budget", continuationsLeft: 3 },
    ];
    const text = buildContinuation({ milestone: active, index: 2, total: 5, deltas });
    expect(text).toContain("- Milestone 2 verified (pnpm test exited 0).");
    expect(text).toContain("- Milestone 3 check failed: `pnpm test` exited 1. Tail: 2 failed");
    expect(text).toContain('- Plan edited: milestone 4 added "Verify accessibility"');
    expect(text).toContain("- Resumed after waiting 2h13m for the usage window; the last checkpoint was 12 files.");
    expect(text).toContain("- 3 continuations left in the budget.");
  });

  it("phrases a short wait and a missing checkpoint without inventing detail", () => {
    const text = buildContinuation({
      milestone: active,
      index: 0,
      total: 1,
      deltas: [{ kind: "resumed", waitedMs: 20_000, checkpointFiles: null }],
    });
    expect(text).toContain("- Resumed after waiting under a minute for the usage window.");
    expect(text).not.toContain("checkpoint was");
  });
});

describe("the document the briefing points at", () => {
  const milestones: MilestoneRecord[] = [{ id: "m1", odysseyId: "o1", position: 0, title: "Do it", detail: "", state: "planned", checkKind: "manual", steps: [] }];

  it("names the file so the agent can go back to it", () => {
    // The document is not re-sent — 54 KB a turn is the whole budget — so one
    // line naming it is what keeps it reachable after the planning turn
    // compacts away.
    const text = buildBriefing({ ...goal, planPath: "docs/Mare_Nostrum_GDD.md" }, milestones);
    expect(text).toContain("The full specification is at `docs/Mare_Nostrum_GDD.md`");
    expect(text).toContain("read the file whenever you need more than they say");
  });

  it("says nothing about a document the agent cannot open", () => {
    expect(buildBriefing(goal, milestones)).not.toContain("full specification");
  });
});

describe("the skill the briefing offers", () => {
  const milestones: MilestoneRecord[] = [{ id: "m1", odysseyId: "o1", position: 0, title: "Do it", detail: "", state: "planned", checkKind: "manual", steps: [] }];

  it("offers it by default", () => {
    expect(buildBriefing(goal, milestones)).toContain("Load the `super-thing` skill");
  });

  it("says nothing about it when it could not be installed", () => {
    expect(buildBriefing(goal, milestones, { skillAvailable: false })).not.toContain("odyssey` skill");
  });
});

describe("the run's memory on disk", () => {
  const now = 1_700_000_000_000;
  const kept: WorkspaceNotes = {
    state: { path: "docs/super-thing/STATE.md", bytes: 900, modifiedAtUnixMs: now - 12 * 60_000 },
    agentNotes: [
      { path: "docs/super-thing/agents/economy.md", bytes: 200, modifiedAtUnixMs: now - 60_000 },
      { path: "docs/super-thing/agents/ships.md", bytes: 300, modifiedAtUnixMs: now - 3 * 60 * 60_000 },
    ],
  };

  it("says the note exists and how old it is, or asks for it to be created", () => {
    expect(handoffLine(kept, now)).toBe("Handoff note: `docs/super-thing/STATE.md` (updated 12m ago) — read it if you have lost the thread, update it before you report.");
    expect(handoffLine({ agentNotes: [] }, now)).toContain("does not exist yet — create it this turn");
    // When the workspace could not be read the line is generic rather than
    // wrong about a file's existence.
    expect(handoffLine(null, now)).toContain("keep it current");
    expect(handoffLine(null, now)).not.toContain("does not exist");
  });

  it("names only the subagent notes written since the model last worked", () => {
    expect(agentNotesSince(kept, now - 2 * 60 * 60_000)).toEqual(["docs/super-thing/agents/economy.md"]);
    expect(agentNotesSince(kept, null)).toHaveLength(2);
    expect(agentNotesSince(null, null)).toEqual([]);
  });

  it("carries the note, the spec reference and the new subagent notes in a continuation", () => {
    const active = milestone({ title: "Economy", detail: "Twenty cities, ten goods.", section: "§4 Economy", state: "active" });
    const text = buildContinuation({ milestone: active, index: 3, total: 12, deltas: [], planPath: "docs/GDD.md", notes: kept, agentNotes: ["docs/super-thing/agents/economy.md"], now });
    expect(text).toContain("Spec: §4 Economy in `docs/GDD.md`.");
    expect(text).toContain("Handoff note: `docs/super-thing/STATE.md` (updated 12m ago)");
    expect(text).toContain("Subagent notes written since your last turn: `docs/super-thing/agents/economy.md`. Read them before raising any of that work again.");
    // Without notes the continuation is exactly what it was.
    expect(buildContinuation({ milestone: active, index: 3, total: 12, deltas: [] })).not.toContain("Handoff note");
  });

  it("briefs the model on the note, the subagent notes folder and its own role", () => {
    const text = buildBriefing(goal, [milestone({ title: "Economy", section: "§4 Economy" })], { notes: { agentNotes: [] }, now });
    expect(text).toContain("Handoff note: `docs/super-thing/STATE.md` does not exist yet");
    expect(text).toContain("writes its result to `docs/super-thing/agents/<name>.md` before it returns");
    expect(text).toContain("routine implementation belongs in a subagent");
    expect(text).toContain("1. Economy  (spec: §4 Economy)  [check: the user ticks it]");
  });
});

describe("the briefing a session gets when it inherits a run", () => {
  const milestones = [
    milestone({ title: "Groundwork", state: "verified" }),
    milestone({ title: "Pricing", state: "reported" }),
    milestone({ title: "Rollout", state: "planned" }),
  ];

  it("says where the work it did not do is written down", () => {
    // The transcript does not move with the goal, so this model has no
    // memory of the run at all. Without this it starts milestone 1 again.
    const text = buildBriefing(goal, milestones, { handedOver: true });
    expect(text).toContain("picked up a run another session started");
    expect(text).toContain(ODYSSEY_STATE_NOTE);
    expect(text).toContain(ODYSSEY_AGENT_NOTES_DIR);
  });

  it("carries the milestone states, because nothing else in the prompt does", () => {
    const text = buildBriefing(goal, milestones, { handedOver: true });
    expect(text).toContain("done — its check passed; do not redo it");
    // A claim is still a claim on the other side of a move: a new
    // orchestrator that reads "reported" as "done" inherits the mistake
    // instead of being the thing that catches it.
    expect(text).toContain("claimed done by the previous session, never verified");
    expect(text).toContain("not started");
  });

  it("says none of it on a goal's first briefing", () => {
    const text = buildBriefing(goal, milestones);
    expect(text).not.toContain("picked up a run");
    expect(text).not.toContain("do not redo it");
    // The plan itself is unchanged: the state tags are the only difference.
    expect(text).toContain("1. Groundwork");
  });
});

describe("the model a run delegates on", () => {
  it("names the delegate to a Claude orchestrator, which has no role table", () => {
    // A Claude subagent's model is a field on its agent definition and
    // nowhere else, so the default subagent type runs on the account default
    // rather than on what the run intends.
    const text = buildBriefing(goal, [milestone({ title: "Groundwork" })], { agent: "claude" });
    expect(text).toContain(`subagent_type: ${ODYSSEY_DELEGATE}`);
  });

  it("says nothing about it to Kit, whose subagents are chosen by role", () => {
    const text = buildBriefing(goal, [milestone({ title: "Groundwork" })], { agent: "codex" });
    expect(text).not.toContain(ODYSSEY_DELEGATE);
    // Kit's own lane is unchanged: roles, not model names.
    expect(text).toContain("routine implementation belongs in a subagent");
  });
});
