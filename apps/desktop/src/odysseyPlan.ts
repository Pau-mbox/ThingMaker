/**
 * Planning a goal from a document (docs/plans/odyssey.md §3.1).
 *
 * A dropped roadmap is not parsed for milestones. It is handed to the session's
 * model, which reads it and proposes the plan in a block this module parses
 * back. The division is the same one the rest of Super Thing keeps: the model
 * proposes, the record decides, and a human presses Start before anything runs.
 *
 * Everything here is pure. `parsePlan` is a refusal machine like
 * `parseReport`: a missing or unreadable block means "no plan was proposed",
 * never a partial plan invented from prose.
 */
import type { CheckKind, MilestoneRecord, OdysseyRecord } from "@thingmaker/contracts";

/** The block Super Thing looks for, quoted verbatim in the prompt and the skill. */
export const PLAN_GRAMMAR = `SUPERTHING-PLAN
milestone: <title>
detail: <one line, optional>
section: <the heading or line range of the document this milestone comes from, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, repeatable — three to eight per milestone, in order>
depends: <numbers of earlier tasks in this milestone the one above waits for, optional>
END-SUPERTHING-PLAN`;

/** Largest document handed to a model in one planning turn. */
export const MAX_PLAN_DOCUMENT_BYTES = 64 * 1024;

/** Bounds, so a long document cannot produce an unusable plan. */
export const MAX_MILESTONES = 40;
const MAX_STEPS = 20;
const MAX_TITLE = 120;
/**
 * A milestone's detail is the working spec for that milestone.
 *
 * It used to be a 400-character summary, which meant a 54 KB design document
 * arrived as roughly 9% of itself and the rest was unreachable once the
 * planning turn compacted away. The detail now holds the substance of its
 * section, so the continuation that carries it carries something worth having.
 */
const MAX_DETAIL = 3_000;
/** A section reference is a heading or a line range, not a paragraph. */
const MAX_SECTION = 200;

/** A task as the plan or an amendment proposes it; `depends` are 1-based numbers within the same milestone. */
export type ProposedTask = { title: string; depends: number[] };

export type ProposedMilestone = {
  title: string;
  detail: string;
  /** Where in the document it came from, when the model said. */
  section: string | null;
  checkKind: CheckKind;
  checkSpec: string | null;
  steps: ProposedTask[];
};

/** Reads `depends: 1, 3` into numbers; anything that is not a number is ignored. */
export function readDepends(value: string): number[] {
  return [...new Set(value.split(/[,\s;]+/).map((part) => Number.parseInt(part.replace(/^\d+\./, ""), 10)).filter((n) => Number.isFinite(n) && n >= 1))];
}

export type ProposedPlan = {
  milestones: ProposedMilestone[];
  /** What was adjusted or ignored while reading the block. */
  notes: string[];
};

const CHECK_KINDS: CheckKind[] = ["manual", "command", "tests_pass", "files_exist"];

/** Like `clamp`, but keeps line breaks: a spec is not a sentence. */
function clampLines(text: string, limit: number): string {
  const trimmed = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function clamp(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/** Strips the decoration a model tends to add around a keyed line. */
function bare(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * Reads a `check:` value. The kind has to be named: guessing "run this" from a
 * bare string is how a document turns into a command nobody chose.
 */
function readCheck(value: string): { checkKind: CheckKind; checkSpec: string | null; note?: string } {
  const text = value.trim().replace(/^`|`$/g, "").trim();
  const kind = CHECK_KINDS.find((candidate) => text === candidate || text.toLowerCase().startsWith(`${candidate} `));
  if (!kind) {
    return { checkKind: "manual", checkSpec: null, note: `A check of "${clamp(text, 60)}" does not name one of ${CHECK_KINDS.join(", ")}, so that milestone is yours to tick.` };
  }
  if (kind === "manual") return { checkKind: "manual", checkSpec: null };
  const spec = text
    .slice(kind.length)
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .trim();
  if (!spec) return { checkKind: "manual", checkSpec: null, note: `A ${kind} check was proposed with nothing to run, so that milestone is yours to tick.` };
  // A multi-line spec is not a command; it is a paste that went wrong.
  if (spec.includes("\n")) return { checkKind: "manual", checkSpec: null, note: "A check spanning several lines was ignored." };
  return { checkKind: kind, checkSpec: spec };
}

/**
 * Parses the plan block out of a model reply. The last block wins, so a model
 * that revises its plan in one reply is read as it intended. Returns `null`
 * when there is no readable plan at all.
 */
export function parsePlan(text: string): ProposedPlan | null {
  if (!text) return null;
  const blocks = [...text.matchAll(/^[^\S\n]*(?:\*\*)?(?:SUPERTHING|ODYSSEY)-PLAN(?:\*\*)?[^\S\n]*$([\s\S]*?)^[^\S\n]*(?:\*\*)?END-(?:SUPERTHING|ODYSSEY)-PLAN(?:\*\*)?[^\S\n]*$/gm)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;

  const milestones: ProposedMilestone[] = [];
  const notes: string[] = [];
  let dropped = 0;
  for (const raw of body.split("\n")) {
    const line = bare(raw);
    const match = /^(milestone|detail|section|check|step|task|depends)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();

    if (key === "milestone") {
      if (!value) continue;
      if (milestones.length >= MAX_MILESTONES) {
        dropped += 1;
        continue;
      }
      milestones.push({ title: clamp(value, MAX_TITLE), detail: "", section: null, checkKind: "manual", checkSpec: null, steps: [] });
      continue;
    }

    // The keys below describe the milestone above them; before the first
    // `milestone:` there is nothing for them to describe.
    const current = milestones.at(-1);
    if (!current) continue;
    // Several `detail:` lines join as lines, not as one run-on paragraph: a
    // milestone's spec has structure worth keeping.
    if (key === "detail") current.detail = clampLines(current.detail ? `${current.detail}\n${value}` : value, MAX_DETAIL);
    else if (key === "section") {
      if (value) current.section = clamp(value.replace(/`/g, ""), MAX_SECTION);
    } else if (key === "step" || key === "task") {
      if (value && current.steps.length < MAX_STEPS) current.steps.push({ title: clamp(value, MAX_TITLE), depends: [] });
    } else if (key === "depends") {
      const task = current.steps.at(-1);
      // A task may only wait on tasks above it in the same milestone.
      if (task) task.depends = readDepends(value).filter((n) => n < current.steps.length);
    } else if (key === "check") {
      const check = readCheck(value);
      current.checkKind = check.checkKind;
      current.checkSpec = check.checkSpec;
      if (check.note) notes.push(check.note);
    }
  }

  if (milestones.length === 0) return null;
  if (dropped > 0) notes.push(`The plan proposed more than ${MAX_MILESTONES} milestones; ${dropped} beyond the limit were dropped.`);
  const runnable = milestones.filter((entry) => entry.checkSpec).length;
  if (runnable > 0) notes.push(`${runnable} milestone${runnable === 1 ? " has a check" : "s have checks"} Super Thing can run. Read the commands before you start the run.`);
  else notes.push(ALL_MANUAL_NOTE);
  return { milestones, notes };
}

/**
 * Said when no milestone can be checked by a command. On the first real run
 * this was every milestone, so every claim waited for a human — eight hours,
 * once — and the whole verification ladder went unused.
 */
export const ALL_MANUAL_NOTE = "Every milestone is manual, so the run will stop at each claim until you tick it. Set a test command in Settings and ask again, or edit the checks.";

/** Whether a plan has nothing Super Thing can verify by itself. */
export function allManual(milestones: { checkKind: CheckKind; checkSpec?: string | null }[]): boolean {
  return milestones.length > 0 && milestones.every((milestone) => milestone.checkKind === "manual" || !milestone.checkSpec);
}

/**
 * The planning prompt: the document, and what to turn it into.
 *
 * Deliberately not a briefing — the goal has no milestones yet, so there is
 * nothing to work. This turn produces the plan and nothing else.
 */
export function buildPlanningPrompt(input: { goal: Pick<OdysseyRecord, "title" | "brief" | "defaultCheck">; document: string; source: string | null }): string {
  const { goal, document, source } = input;
  const defaultCheck = goal.defaultCheck?.trim();
  const checkRule = defaultCheck
    ? `- **Every milestone gets a check Super Thing can run.** The project's test command is \`${defaultCheck}\`; use \`check: tests_pass ${defaultCheck}\` unless the document names a better command for that milestone (\`command <cmd>\` for something else that must exit 0, \`files_exist <paths>\` for artefacts). Super Thing runs these commands itself, so do not invent one that is not there. \`manual\` stalls the run at that milestone until a human ticks it; use it only when nothing can be run.`
    : "- **Prefer a check Super Thing can run.** If the repository has a test command you can see — a package script, a Makefile target, `cargo test`, a script under `Tools/` — use `tests_pass <cmd>` for milestones whose work it covers, and `command <cmd>` or `files_exist <paths>` where the document names something else that must hold. Super Thing runs these commands itself, so do not invent one. `manual` stalls the run at that milestone until a human ticks it; use it only when nothing can be run.";
  return [
    "You are setting up a Super Thing goal, ThingMaker's long-horizon runner. This turn is planning only: do not start the work, do not edit any files, and do not run anything.",
    "",
    `Goal: ${goal.title}`,
    ...(goal.brief ? [goal.brief] : []),
    "",
    `Read the ${source ? `document below (\`${source}\`)` : "document below"} and turn it into an ordered list of milestones for this goal.`,
    "",
    "What makes a good milestone here:",
    "- One reviewable outcome, in the order it has to happen. Between 3 and 12 is usual.",
    "- **Carry the document's substance across, do not summarise it.** A milestone's `detail:` is the working specification for that milestone, and for most of the run it is all anyone sees — the document itself is not re-sent every turn. Move the relevant section into it: the specific names, numbers, formats, ordering rules and constraints, in the document's own words where they are precise. Aim for a few hundred words per milestone rather than a sentence.",
    "- Use several `detail:` lines to keep that structure; they are joined as separate lines.",
    "- Break each milestone into three to eight `step:` tasks, in order, each one thing a subagent can be given; add `depends:` under a task that has to wait for earlier ones (their numbers within the milestone). The run tracks these tasks — who ran each, and when — so they should be real units of work, not headings.",
    "- Name where each milestone came from with `section:` — the document's heading, or a line range — so the agent can read that part of the file rather than all of it.",
    checkRule,
    "- Skip anything the document records as already finished, and say so in that milestone's detail rather than adding it as work.",
    "",
    "Between them, the milestones should cover the document. A reader with only your milestones should be able to build the thing without the document in front of them.",
    "",
    "Reply with nothing but this block, in exactly this shape:",
    "",
    PLAN_GRAMMAR,
    "",
    "Repeat the `milestone:` group once per milestone, in order. If the document is not a plan for this goal, reply with no block and say what you found instead.",
    "",
    source ? `--- ${source} ---` : "--- document ---",
    document,
    source ? `--- end of ${source} ---` : "--- end of document ---",
  ].join("\n");
}

/** A one-line description of the plan a goal was created from, for the UI. */
export function planSummary(goal: Pick<OdysseyRecord, "planSource" | "planDocumentBytes">): string | null {
  if (!goal.planSource && !goal.planDocumentBytes) return null;
  const size = goal.planDocumentBytes ? `${Math.max(1, Math.round(goal.planDocumentBytes / 1024))} KB` : null;
  return [goal.planSource ?? "a document", size].filter(Boolean).join(" · ");
}

/** Milestones the model proposed but that no one has approved yet. */
export function awaitingApproval(goal: Pick<OdysseyRecord, "state">, milestones: MilestoneRecord[]): boolean {
  return goal.state === "draft" && milestones.length > 0;
}
