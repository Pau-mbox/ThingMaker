/**
 * Changing a goal while it runs (docs/plans/odyssey.md §3.2).
 *
 * The user has more to say after the run started. It is carried to the model
 * on its next prompt — never submitted on its own, because the session is
 * usually mid-turn — and the *model* decides where it belongs and when to act
 * on it. It answers with an amendment block, which this module reads back.
 *
 * Deliberately a list of explicit operations rather than a re-proposed plan.
 * A whole new list would let a milestone disappear silently; `add`, `revise`
 * and `drop` each name their target, can each be refused on their own, and
 * each leave a journal row saying what happened.
 */
import type { AmendmentRecord, CheckKind, MilestoneRecord, OdysseyStep } from "@thingmaker/contracts";
import { readDepends, type ProposedTask } from "./odysseyPlan";

/** The block Odyssey looks for, quoted verbatim in the prompt and the skill. */
export const AMEND_GRAMMAR = `ODYSSEY-AMEND
add: <title>
after: <milestone number, or "end">
detail: <one line, optional>
section: <heading or line range in the plan document, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, optional, repeatable>
depends: <numbers of earlier tasks the one above waits for, optional>
revise: <milestone number>
title: <new title, optional>
detail: <new detail, optional>
section: <new section reference, optional>
check: <new check, optional>
step: <a task to add to it, optional, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
drop: <milestone number>
reason: <one line>
drop_task: <task number, e.g. 7.4>
reason: <one line>
revise_task: <task number>
title: <new title, optional>
detail: <new detail, optional>
depends: <numbers of the milestone's tasks it waits for, optional>
split_task: <task number>
step: <each task that replaces it, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
move_task: <task number>
after: <task number in the same milestone, or "start">
END-ODYSSEY-AMEND`;

/** Continuations to leave between tellings of the same amendment. */
export const RETELL_AFTER_CONTINUATIONS = 3;

/** Tellings before it stops asking and hands the amendment back to the user. */
export const MAX_TELLS = 3;

const MAX_OPS = 20;
const MAX_TITLE = 120;
/** Matches the plan parser: a milestone's detail is its working spec. */
const MAX_DETAIL = 3_000;
const MAX_STEPS = 20;

export type AmendOp =
  | { op: "add"; title: string; detail: string; section: string | null; checkKind: CheckKind; checkSpec: string | null; steps: ProposedTask[]; after: number | "end" }
  | { op: "revise"; target: number; title: string | null; detail: string | null; section: string | null; checkKind: CheckKind | null; checkSpec: string | null; steps: ProposedTask[] }
  | { op: "drop"; target: number; reason: string }
  | { op: "drop_task"; ref: TaskRef; reason: string }
  | { op: "revise_task"; ref: TaskRef; title: string | null; detail: string | null; depends: number[] | null; reason: string }
  | { op: "split_task"; ref: TaskRef; steps: ProposedTask[]; reason: string }
  | { op: "move_task"; ref: TaskRef; after: number | "start"; reason: string };

/** `7.4`: milestone 7, its fourth task, both as the agent was shown them. */
export type TaskRef = { milestone: number; task: number };

function taskRef(value: string): TaskRef | null {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const milestone = Number.parseInt(match[1] ?? "", 10);
  const task = Number.parseInt(match[2] ?? "", 10);
  return milestone >= 1 && task >= 1 ? { milestone, task } : null;
}

export function taskLabel(ref: TaskRef): string {
  return `${ref.milestone}.${ref.task}`;
}

export type Amendment = {
  ops: AmendOp[];
  /** What was adjusted or refused while reading the block. */
  notes: string[];
};

const CHECK_KINDS: CheckKind[] = ["manual", "command", "tests_pass", "files_exist"];

function clamp(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Like `clamp`, but keeps line breaks — the same rule the plan parser uses.
 * A milestone's detail is its working specification; several `detail:` lines
 * are structure, and collapsing them into one paragraph threw that away.
 */
function clampLines(text: string, limit: number): string {
  const trimmed = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function joinDetail(existing: string | null | undefined, value: string): string {
  return clampLines(existing ? `${existing}\n${value}` : value, MAX_DETAIL);
}

function bare(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** Same rule as the plan block: the kind has to be named, never guessed. */
function readCheck(value: string): { checkKind: CheckKind; checkSpec: string | null; note?: string } {
  const text = value.trim().replace(/^`|`$/g, "").trim();
  const kind = CHECK_KINDS.find((candidate) => text === candidate || text.toLowerCase().startsWith(`${candidate} `));
  if (!kind) return { checkKind: "manual", checkSpec: null, note: `A check of "${clamp(text, 60)}" does not name one of ${CHECK_KINDS.join(", ")}, so it was left for you to tick.` };
  if (kind === "manual") return { checkKind: "manual", checkSpec: null };
  const spec = text.slice(kind.length).trim().replace(/^`(.*)`$/, "$1").trim();
  if (!spec || spec.includes("\n")) return { checkKind: "manual", checkSpec: null, note: `A ${kind} check was proposed with nothing usable to run, so it was left for you to tick.` };
  return { checkKind: kind, checkSpec: spec };
}

function position(value: string): number | null {
  const match = /^(\d+)/.exec(value.trim());
  if (!match) return null;
  const index = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(index) && index >= 1 ? index : null;
}

/**
 * Reads the amendment block out of a model reply. The last block wins and a
 * missing or unreadable one means "the model has not amended the plan" — never
 * a partial amendment guessed from prose.
 */
export function parseAmendment(text: string): Amendment | null {
  if (!text) return null;
  const blocks = [...text.matchAll(/^[^\S\n]*(?:\*\*)?ODYSSEY-AMEND(?:\*\*)?[^\S\n]*$([\s\S]*?)^[^\S\n]*(?:\*\*)?END-ODYSSEY-AMEND(?:\*\*)?[^\S\n]*$/gm)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;

  const ops: AmendOp[] = [];
  const notes: string[] = [];
  let dropped = 0;
  for (const raw of body.split("\n")) {
    const line = bare(raw);
    const match = /^(add|revise|drop|drop_task|revise_task|split_task|move_task|after|title|detail|section|check|step|task|depends|reason)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();

    if (key === "drop_task" || key === "revise_task" || key === "split_task" || key === "move_task") {
      if (ops.length >= MAX_OPS) {
        dropped += 1;
        continue;
      }
      const ref = taskRef(value);
      if (!ref) {
        notes.push(`A ${key.replace("_", " ")} named "${clamp(value, 40)}" rather than a task number like 7.4, so it was ignored.`);
        continue;
      }
      if (key === "drop_task") ops.push({ op: "drop_task", ref, reason: "" });
      else if (key === "revise_task") ops.push({ op: "revise_task", ref, title: null, detail: null, depends: null, reason: "" });
      else if (key === "split_task") ops.push({ op: "split_task", ref, steps: [], reason: "" });
      else ops.push({ op: "move_task", ref, after: "start", reason: "" });
      continue;
    }

    if (key === "add" || key === "revise" || key === "drop") {
      if (ops.length >= MAX_OPS) {
        dropped += 1;
        continue;
      }
      if (key === "add") {
        if (!value) continue;
        ops.push({ op: "add", title: clamp(value, MAX_TITLE), detail: "", section: null, checkKind: "manual", checkSpec: null, steps: [], after: "end" });
      } else {
        const target = position(value);
        if (target === null) {
          notes.push(`A ${key} named "${clamp(value, 40)}" rather than a milestone number, so it was ignored.`);
          continue;
        }
        if (key === "revise") ops.push({ op: "revise", target, title: null, detail: null, section: null, checkKind: null, checkSpec: null, steps: [] });
        else ops.push({ op: "drop", target, reason: "" });
      }
      continue;
    }

    // The keys below describe the operation above them.
    const current = ops.at(-1);
    if (!current) continue;
    if (key === "after" && current.op === "add") {
      current.after = /^end$/i.test(value) ? "end" : (position(value) ?? "end");
    } else if (key === "after" && current.op === "move_task") {
      // Only the task part matters: the move stays inside the task's milestone.
      current.after = /^start$/i.test(value) ? "start" : (taskRef(value)?.task ?? position(value) ?? "start");
    } else if (key === "title" && (current.op === "revise" || current.op === "revise_task")) {
      if (value) current.title = clamp(value, MAX_TITLE);
    } else if (key === "detail") {
      if (current.op === "add") current.detail = joinDetail(current.detail, value);
      else if (current.op === "revise" || current.op === "revise_task") current.detail = joinDetail(current.detail, value);
    } else if (key === "section" && (current.op === "add" || current.op === "revise")) {
      if (value) current.section = clamp(value.replace(/`/g, ""), 200);
    } else if ((key === "step" || key === "task") && (current.op === "add" || current.op === "revise" || current.op === "split_task")) {
      if (value && current.steps.length < MAX_STEPS) current.steps.push({ title: clamp(value, MAX_TITLE), depends: [] });
    } else if (key === "depends" && current.op === "revise_task") {
      current.depends = readDepends(value);
    } else if (key === "depends" && (current.op === "add" || current.op === "revise" || current.op === "split_task")) {
      // Numbers are the milestone's task numbers as the agent was shown them;
      // for a revise they may name tasks that already exist.
      const task = current.steps.at(-1);
      if (task) task.depends = readDepends(value);
    } else if (key === "check" && (current.op === "add" || current.op === "revise")) {
      const check = readCheck(value);
      current.checkKind = check.checkKind;
      current.checkSpec = check.checkSpec;
      if (check.note) notes.push(check.note);
    } else if (key === "reason" && (current.op === "drop" || current.op === "drop_task" || current.op === "revise_task" || current.op === "split_task" || current.op === "move_task")) {
      current.reason = clamp(value, MAX_DETAIL);
    }
  }

  if (ops.length === 0) return null;
  if (dropped > 0) notes.push(`The block asked for more than ${MAX_OPS} changes; ${dropped} beyond the limit were ignored.`);
  return { ops, notes };
}

export type ResolvedOp = { op: AmendOp; milestone: MilestoneRecord | null; step: OdysseyStep | null; refused: string | null };

/**
 * Ties each operation to the milestone it names, and refuses the ones that
 * cannot be honoured.
 *
 * Targets are resolved against the list as it was *before* anything is
 * applied, so an add in the middle cannot shift the numbers the model meant.
 * Verified milestones are settled work: a check ran or the user ticked it, and
 * a later reply revising or dropping that is not an amendment, it is a loss.
 */
export function resolveOps(ops: AmendOp[], milestones: MilestoneRecord[]): ResolvedOp[] {
  return ops.map((op) => {
    if (op.op === "add") return { op, milestone: null, step: null, refused: null };
    if (op.op === "revise" || op.op === "drop") {
      const milestone = milestones[op.target - 1] ?? null;
      if (!milestone) return { op, milestone: null, step: null, refused: `there is no milestone ${op.target}` };
      if (milestone.state === "verified") return { op, milestone, step: null, refused: `milestone ${op.target} is already verified, and verified work is not rewritten` };
      return { op, milestone, step: null, refused: null };
    }
    const milestone = milestones[op.ref.milestone - 1] ?? null;
    if (!milestone) return { op, milestone: null, step: null, refused: `there is no milestone ${op.ref.milestone}` };
    if (milestone.state === "verified") return { op, milestone, step: null, refused: `milestone ${op.ref.milestone} is already verified, and verified work is not rewritten` };
    const step = milestone.steps[op.ref.task - 1] ?? null;
    if (!step) return { op, milestone, step: null, refused: `milestone ${op.ref.milestone} has no task ${op.ref.task}` };
    if ((op.op === "drop_task" || op.op === "split_task") && step.state === "done") return { op, milestone, step, refused: `task ${taskLabel(op.ref)} is done, and done work is not rewritten` };
    if (op.op === "split_task" && op.steps.length < 2) return { op, milestone, step, refused: `a split needs at least two tasks to replace ${taskLabel(op.ref)}` };
    return { op, milestone, step, refused: null };
  });
}

/** One line of the plan diff: what kind of change, and what it says. */
export type DiffLine = { sign: "+" | "−" | "~" | "⇄" | "↕"; text: string; refused: string | null; reason: string | null };

/**
 * The diff the user reads before a plan change lands: one line per
 * operation, in the block's order, refusals included so nothing that was
 * asked for disappears silently.
 */
export function planDiff(resolved: ResolvedOp[]): DiffLine[] {
  return resolved.map(({ op, milestone, step, refused }) => {
    const where = milestone ? ` "${milestone.title}"` : "";
    const task = step ? ` "${step.title}"` : "";
    const line = (sign: DiffLine["sign"], text: string, reason: string | null = null): DiffLine => ({ sign, text, refused, reason: reason?.trim() || null });
    switch (op.op) {
      case "add":
        return line("+", `Add milestone "${op.title}" ${op.after === "end" ? "at the end" : `after milestone ${op.after}`}${op.steps.length > 0 ? ` with ${op.steps.length} task${op.steps.length === 1 ? "" : "s"}` : ""}`);
      case "revise": {
        const parts = [
          op.title ? `title → "${op.title}"` : null,
          op.detail ? "detail" : null,
          op.section ? `spec → ${op.section}` : null,
          op.checkKind ? `check → ${op.checkKind}${op.checkSpec ? ` ${op.checkSpec}` : ""}` : null,
          op.steps.length > 0 ? `+${op.steps.length} task${op.steps.length === 1 ? "" : "s"}: ${op.steps.map((entry) => entry.title).join(", ")}` : null,
        ].filter(Boolean);
        return line("~", `Revise milestone ${op.target}${where}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`);
      }
      case "drop":
        return line("−", `Drop milestone ${op.target}${where}`, op.reason);
      case "drop_task":
        return line("−", `Drop task ${taskLabel(op.ref)}${task}`, op.reason);
      case "revise_task": {
        const parts = [
          op.title ? `title → "${op.title}"` : null,
          op.detail ? "detail" : null,
          op.depends ? `depends on ${op.depends.length > 0 ? op.depends.map((n) => `${op.ref.milestone}.${n}`).join(", ") : "nothing"}` : null,
        ].filter(Boolean);
        return line("~", `Revise task ${taskLabel(op.ref)}${task}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`, op.reason);
      }
      case "split_task":
        return line("⇄", `Split task ${taskLabel(op.ref)}${task} into ${op.steps.length}: ${op.steps.map((entry) => entry.title).join(", ")}`, op.reason);
      case "move_task":
        return line("↕", `Move task ${taskLabel(op.ref)}${task} ${op.after === "start" ? "to the start" : `after ${op.ref.milestone}.${op.after}`}`, op.reason);
    }
  });
}

/**
 * Whether an operation changes what a milestone *is* — its existence, its
 * title or its check — or only how its work is cut into tasks. The first
 * kind is a decision about scope and waits for the user by default; the
 * second is the agent's own housekeeping and lands on its own.
 */
export function isMilestoneScope(op: AmendOp): boolean {
  if (op.op === "add" || op.op === "drop") return true;
  if (op.op === "revise") return op.title !== null || op.checkKind !== null;
  return false;
}

/** The diff as text, for the record and the prompt. */
export function diffText(lines: DiffLine[]): string {
  return lines.map((entry) => `${entry.sign} ${entry.text}${entry.reason ? ` (${entry.reason})` : ""}${entry.refused ? ` — refused: ${entry.refused}` : ""}`).join("\n");
}

/** One line per operation, for the journal and the screen. */
export function describeOp(resolved: ResolvedOp): string {
  const [entry] = planDiff([resolved]);
  return entry ? `${entry.text}${entry.reason ? ` (${entry.reason})` : ""}${entry.refused ? ` — refused: ${entry.refused}` : ""}` : "";
}

/**
 * How an amendment reads in the prompt that carries it.
 *
 * References are paths, not contents: the agent opens them with its own tools,
 * so a folder of 48 sprites costs one line. Only a document from outside the
 * workspace — which the agent cannot reach — is inlined, and it is bounded.
 */
export function describeAmendment(record: Pick<AmendmentRecord, "note" | "refs" | "documentSource" | "kind">, document: string | null): string[] {
  // A note asks for nothing back; saying "fold this into the plan" about it
  // made the model look for a plan change that was not there.
  const lines = [record.kind === "note" ? `- A note from the user: ${record.note}` : `- The user added something to fold into the plan: ${record.note}`];
  for (const reference of record.refs) lines.push(`  Reference: \`${reference.path}\` (${reference.kind}, ${reference.detail}) — open it yourself.`);
  if (record.documentSource && document) {
    lines.push(`  Document \`${record.documentSource}\` (it is not in the workspace, so it is quoted here):`);
    lines.push(`  --- ${record.documentSource} ---`);
    lines.push(document);
    lines.push(`  --- end of ${record.documentSource} ---`);
  }
  return lines;
}

/** The instruction appended once when any amendment is carried. */
export const AMEND_INSTRUCTION = `Fold the above into the plan when it fits — you decide where and when. Reply with an ODYSSEY-AMEND block to change the milestones, and keep working in the same reply if you have work to do. If it needs no change to the plan, say so and no block.`;

/**
 * Whether this amendment belongs on the next prompt.
 *
 * Telling once was the bug. An amendment carried on a single prompt and never
 * mentioned again is forgotten the moment that prompt compacts out of the
 * model's context — one sat `told` through forty-six continuations, which from
 * the model's side was indistinguishable from never having been asked.
 *
 * So it is repeated, spaced out, and bounded: a model that keeps declining
 * should reach the user rather than keep costing turns.
 */
export function shouldCarry(record: Pick<AmendmentRecord, "state" | "tellCount" | "toldAtContinuation">, continuationsUsed: number): boolean {
  if (record.state === "pending") return true;
  if (record.state !== "told") return false;
  if (record.tellCount >= MAX_TELLS) return false;
  // No recorded point means it was told before this was tracked; that is
  // exactly the stuck case, so it is due.
  if (record.toldAtContinuation === undefined) return true;
  return continuationsUsed - record.toldAtContinuation >= RETELL_AFTER_CONTINUATIONS;
}

/** How an amendment reads on screen, in the words of what actually happened. */
export function amendmentStatus(record: Pick<AmendmentRecord, "state" | "tellCount" | "kind">): string {
  if (record.kind === "note" && record.state === "applied") return "delivered";
  switch (record.state) {
    case "pending":
      return "queued for the next prompt";
    case "told":
      if (record.tellCount >= MAX_TELLS) return `the agent was told ${record.tellCount} times and has not folded it in — it is yours now`;
      return record.tellCount > 1 ? `with the agent · told ${record.tellCount} times` : "with the agent";
    case "applied":
      return "folded into the plan";
    case "discarded":
      return "discarded";
  }
}

/** The line appended when an amendment has been asked for before. */
export function retellNote(record: Pick<AmendmentRecord, "tellCount">): string {
  return record.tellCount === 1
    ? "  You were asked this once already and have not folded it in. Do it now, or say in your reply why it does not belong in the plan."
    : `  You were asked this ${record.tellCount} times already. Fold it in now, or say plainly that you will not and why.`;
}
