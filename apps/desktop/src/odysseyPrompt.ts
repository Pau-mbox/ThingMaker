/**
 * The text Super Thing submits to the session (docs/plans/odyssey.md §4.2).
 *
 * Two kinds, sized deliberately. The **briefing** goes in once at the start,
 * so it lands early in the transcript and is served from the provider's prefix
 * cache from the second turn onward. Every **continuation** after it is a
 * pointer plus what changed, because restating the goal each turn is exactly
 * the prefix growth measured in docs/research/kit-token-optimization.md.
 *
 * This module is pure: it formats strings and decides nothing. It is also what
 * the user is shown before a run starts, so the text here is the contract, not
 * a paraphrase of one.
 */
import { ODYSSEY_AGENT_NOTES_DIR, ODYSSEY_DELEGATE, ODYSSEY_STATE_NOTE, type CheckKind, type MilestoneRecord, type OdysseyRecord, type Provider, type WorkspaceNotes } from "@thingmaker/contracts";
import { TASK_GRAMMAR, taskLinesFor } from "./odysseyTasks";
import { ASK_GRAMMAR } from "./odysseyAsk";

/** One thing that changed since the last continuation, told to the model once. */
export type Delta =
  | { kind: "verified"; milestone: number; title: string; evidence: string }
  | { kind: "check_failed"; milestone: number; title: string; command: string; exitCode: number; tail: string }
  | { kind: "plan_edited"; summary: string }
  | { kind: "resumed"; waitedMs: number; checkpointFiles: number | null }
  | { kind: "budget"; continuationsLeft: number }
  /** The agent's plan change is held for the user; the plan it sees is unchanged. */
  | { kind: "plan_change_pending"; summary: string }
  | { kind: "plan_change_rejected"; summary: string; note: string | null }
  | { kind: "question_answered"; question: string; answer: string | null };

/** How long ago a note was written, for the prompt. */
function ageOf(modifiedAtUnixMs: number, now: number): string {
  return duration(Math.max(0, now - modifiedAtUnixMs));
}

/**
 * The line that tells the model where its memory lives.
 *
 * The transcript compacts, and a session can be replaced by a fresh one; the
 * milestone list survives both, the model's sense of *where it is inside a
 * milestone* survives neither. A note it keeps in the workspace does. The
 * line is truthful about whether the note exists, because "update it" about
 * a file that is not there teaches the model the prompt is unreliable.
 */
export function handoffLine(notes: WorkspaceNotes | null | undefined, now: number): string {
  if (!notes) return `Handoff note: \`${ODYSSEY_STATE_NOTE}\` — keep it current: what is done, what is in flight, which files you own, what you learned that the plan does not say.`;
  if (!notes.state) return `Handoff note: \`${ODYSSEY_STATE_NOTE}\` does not exist yet — create it this turn: what is done, what is in flight, which files you own, what you learned that the plan does not say. Update it before every report.`;
  return `Handoff note: \`${ODYSSEY_STATE_NOTE}\` (updated ${ageOf(notes.state.modifiedAtUnixMs, now)} ago) — read it if you have lost the thread, update it before you report.`;
}

/** Subagent notes written after `since`, which a resumed or restarted turn should read before raising work again. */
export function agentNotesSince(notes: WorkspaceNotes | null | undefined, since: number | null): string[] {
  if (!notes) return [];
  return notes.agentNotes.filter((note) => since === null || note.modifiedAtUnixMs > since).map((note) => note.path);
}

/** Human phrasing for a milestone's check, used in the briefing and deltas. */
export function checkLabel(kind: CheckKind, spec: string | null | undefined): string {
  switch (kind) {
    case "command":
      return spec ? `check: \`${spec}\` must exit 0` : "check: a command that must exit 0 (not set yet)";
    case "tests_pass":
      return spec ? `check: \`${spec}\` must exit 0` : "check: a test command that must exit 0 (not set yet)";
    case "files_exist":
      return spec ? `check: these files must exist: ${spec.split("\n").filter(Boolean).join(", ")}` : "check: files that must exist (not set yet)";
    case "manual":
      return "check: the user ticks it";
  }
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

/**
 * What the record holds about a milestone, in the words the run uses for it.
 *
 * `reported` is deliberately not "done": it is the previous model's claim and
 * nothing checked it, and a new orchestrator that treats a claim as evidence
 * inherits the mistake instead of catching it.
 */
export function milestoneStateLabel(milestone: Pick<MilestoneRecord, "state">): string {
  switch (milestone.state) {
    case "verified":
      return "done — its check passed; do not redo it";
    case "reported":
      return "claimed done by the previous session, never verified";
    case "active":
      return "in flight when the run moved";
    case "failed":
      return "reported blocked";
    case "skipped":
      return "skipped";
    case "planned":
      return "not started";
  }
}

/** The report line Super Thing looks for, quoted in the briefing and parsed back. */
export const REPORT_GRAMMAR = "SUPERTHING-REPORT: milestone=<n> status=<complete|blocked> note=<one line>";

/**
 * Submitted once, before the first continuation. It explains the mechanics the
 * model cannot infer — that continuations arrive on their own, that a gap
 * between turns is a usage pause rather than a failure, and that a check
 * decides completion rather than its own say-so.
 */
export function buildBriefing(
  goal: OdysseyRecord,
  milestones: MilestoneRecord[],
  options: {
    skillAvailable?: boolean;
    notes?: WorkspaceNotes | null;
    now?: number;
    /**
     * True when this session picked the run up from another one
     * (docs/plans/odyssey-second-orchestrator.md §2.3). The transcript does
     * not move with the goal, so this model has no memory of the work at all
     * — only the plan below and what the run wrote to the workspace. Saying so
     * is the difference between a model that reads the notes first and one
     * that starts milestone 7 from nothing.
     */
    handedOver?: boolean;
    /** Which agent is being briefed; some of the protocol differs by it. */
    agent?: Provider;
  } = {},
): string {
  // A goal that moved needs its milestone states in the text: the new model
  // has no transcript to read them out of, and the difference between "done"
  // and "not started" is whether it redoes a milestone.
  const state = (milestone: MilestoneRecord): string => (options.handedOver ? `  [${milestoneStateLabel(milestone)}]` : "");
  const plan = milestones.map(
    (milestone, index) =>
      `${index + 1}. ${milestone.title}${milestone.detail ? ` — ${milestone.detail}` : ""}${milestone.section ? `  (spec: ${milestone.section})` : ""}${state(milestone)}  [${checkLabel(milestone.checkKind, milestone.checkSpec)}]`,
  );
  const stop =
    goal.stopCondition === "goal_complete"
      ? "Work through every milestone in order."
      : goal.stopCondition === "milestone_complete"
        ? "Stop after each milestone; the user restarts you for the next one."
        : "The user decides when to stop.";
  const inherited = options.handedOver
    ? [
        `This session picked up a run another session started, so some of the milestones below may already be done — the record says which. Nothing of that session's conversation came with the goal; \`${ODYSSEY_STATE_NOTE}\` is where it left off, and \`${ODYSSEY_AGENT_NOTES_DIR}/\` is what its subagents wrote. Read both before you touch anything, and do not redo work they say is finished.`,
        "",
      ]
    : [];
  return [
    "You are working under Super Thing, ThingMaker's long-horizon runner.",
    "",
    ...inherited,
    "How this works:",
    "- The goal below is broken into ordered milestones. You work the active one.",
    "- After each of your turns Super Thing takes a checkpoint of the working tree and sends you the next continuation. Do not ask permission to continue and do not wait for a human between milestones.",
    "- Super Thing pauses the run when the account's usage window is spent and resumes it when the provider's quota resets. A long gap between turns is normal and means nothing failed.",
    "- A milestone is done when its check passes, not when you say so. Each check is listed below. You may run it yourself, including from a subagent, and Super Thing reads the exit code out of your tool results.",
    `- When you finish a milestone, end that reply with a single line: ${REPORT_GRAMMAR}. While you are still working, send no report line.`,
    // Only when the skill is actually installed: pointing at a skill that is
    // not there teaches the model that the briefing is unreliable.
    ...(options.skillAvailable === false ? [] : ["- Load the `super-thing` skill if you want the full protocol."]),
    "",
    // The document itself is not re-sent: at 54 KB that would be the whole
    // budget. One line naming it gives the agent the rest on demand, for the
    // life of the run.
    ...(goal.planPath
      ? [`- The full specification is at \`${goal.planPath}\`. The milestone details below carry its substance, but read the file whenever you need more than they say. A milestone's \`spec:\` names the part of it to read for that milestone.`]
      : []),
    `- ${handoffLine(options.notes, options.now ?? Date.now())}`,
    `- Every subagent you raise writes its result to \`${ODYSSEY_AGENT_NOTES_DIR}/<name>.md\` before it returns, and gets the handoff note and the milestone's spec reference in its prompt. When a turn is resumed or restarted, read that folder before raising anything again: a subagent that died at a quota wall may have finished on disk.`,
    "- Plan, delegate, read results and report. Run the shell yourself to verify a subagent's claim or the milestone's check; routine implementation belongs in a subagent.",
    // Claude Code has no role table for subagents, so the delegate is named
    // here and its model is a field on the definition that was just installed.
    ...(options.agent === "claude"
      ? [`- Raise every subagent with \`subagent_type: ${ODYSSEY_DELEGATE}\`, which this project defines. It pins the model the run is meant to delegate on; the default subagent type does not.`]
      : []),
    `- When the plan no longer fits what you found, change it with an SUPERTHING-AMEND block — add, revise, drop, split or move tasks and milestones — and give a \`reason:\`. ${goal.onPlanChange === "auto" ? "It is applied at once and the user sees the diff." : goal.onPlanChange === "review" ? "It is shown to the user as a diff and applied when they accept; until then, work to the plan as it stands." : "Task changes land at once. Adding or dropping a milestone, or changing its title or check, is shown to the user as a diff and lands when they accept; until then, work to the plan as it stands."}`,
    `- Decisions only a human can make — an ambiguous requirement, an architectural fork, constraints that conflict, a failure that keeps recurring, a permission you cannot grant yourself — go on one line: ${ASK_GRAMMAR}. Name what you will do meanwhile and carry on; never wait for the answer. Everything else you decide.`,
    `- Milestones are broken into numbered tasks (6.3 is the third task of milestone 6). Name each subagent after its task, \`6.3-<slug>\`, so the run can show which model did it, and when a task starts, finishes or cannot be done, put a line in your reply: ${TASK_GRAMMAR}. Several lines per reply are fine.`,
    "",
    `Goal: ${goal.title}`,
    ...(goal.brief ? [goal.brief] : []),
    "",
    milestones.length > 0 ? "Milestones:" : "Milestones: none yet; ask the user for them before starting work.",
    ...plan,
    "",
    stop,
    `Budget: at most ${goal.maxContinuations} continuations${goal.tokenBudget ? `, and ${goal.tokenBudget.toLocaleString()} tokens` : ""}. Super Thing stops the run at the ceiling, so keep turns purposeful.`,
  ].join("\n");
}

function deltaLine(delta: Delta): string {
  switch (delta.kind) {
    case "verified":
      return `- Milestone ${delta.milestone} verified (${delta.evidence}).`;
    case "check_failed":
      return `- Milestone ${delta.milestone} check failed: \`${delta.command}\` exited ${delta.exitCode}.${delta.tail ? ` Tail: ${delta.tail}` : ""}`;
    case "plan_edited":
      return `- Plan edited: ${delta.summary}`;
    case "resumed":
      return `- Resumed after waiting ${duration(delta.waitedMs)} for the usage window${delta.checkpointFiles === null ? "" : `; the last checkpoint was ${delta.checkpointFiles} file${delta.checkpointFiles === 1 ? "" : "s"}`}.`;
    case "budget":
      return `- ${delta.continuationsLeft} continuation${delta.continuationsLeft === 1 ? "" : "s"} left in the budget.`;
    case "plan_change_pending":
      return `- Your plan change is waiting for the user's decision; the plan below is unchanged until then, so work to it and do not send the change again: ${delta.summary}`;
    case "plan_change_rejected":
      return `- The user rejected your plan change (${delta.summary})${delta.note ? `: ${delta.note}` : "."} Work to the plan as it stands.`;
    case "question_answered":
      return delta.answer ? `- You asked "${delta.question}". The user answered: ${delta.answer}` : `- You asked "${delta.question}". The user dismissed it without an answer: keep your default.`;
  }
}

/**
 * Submitted after each settled turn. Short on purpose: the history is already
 * in the transcript, so this carries the pointer and the deltas only.
 */
export function buildContinuation(input: {
  milestone: MilestoneRecord;
  index: number;
  total: number;
  deltas: Delta[];
  /** Where the specification lives, so the section reference has a file. */
  planPath?: string | null;
  /** What the run has written to the workspace; omitted when not read. */
  notes?: WorkspaceNotes | null;
  /** Subagent notes newer than the model's last turn, by path. */
  agentNotes?: string[];
  now?: number;
}): string {
  const { milestone, index, total, deltas } = input;
  const steps = milestone.steps ?? [];
  const lines = [`Continue. Milestone ${index + 1}/${total}: ${milestone.title}.`];
  if (milestone.detail) lines.push(milestone.detail);
  if (milestone.section) lines.push(`Spec: ${milestone.section}${input.planPath ? ` in \`${input.planPath}\`` : ""}.`);
  if (steps.length > 0) {
    // Every task with the state the record holds: a session that lost its
    // thread must not redo a done task, and must see what it may start.
    lines.push("Tasks:", ...taskLinesFor(index, steps), `Report task moves with: ${TASK_GRAMMAR}`);
  }
  if (milestone.checkKind !== "manual") lines.push(checkLabel(milestone.checkKind, milestone.checkSpec).replace(/^check: /, "Its check: "));
  if (input.notes !== undefined) lines.push(handoffLine(input.notes, input.now ?? Date.now()));
  if (input.agentNotes && input.agentNotes.length > 0) {
    lines.push(`Subagent notes written since your last turn: ${input.agentNotes.map((path) => `\`${path}\``).join(", ")}. Read them before raising any of that work again.`);
  }
  if (deltas.length > 0) lines.push("", ...deltas.map(deltaLine));
  return lines.join("\n");
}
