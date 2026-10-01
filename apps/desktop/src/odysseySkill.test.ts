/**
 * O6's gate: the `super-thing` skill is the protocol the code actually implements.
 *
 * A skill that drifts from the parser is worse than no skill — it teaches the
 * model a grammar Super Thing will ignore. So every example line in the document
 * is parsed here with the real parser, and the enumerations it documents are
 * compared against the real ones.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ODYSSEY_AGENT_NOTES_DIR, ODYSSEY_DELEGATE, ODYSSEY_STATE_NOTE, type CheckKind, type MilestoneState, type OdysseyState } from "@thingmaker/contracts";
import { parseReport } from "./odysseyReport";
import { REPORT_GRAMMAR, milestoneStateLabel } from "./odysseyPrompt";
import { PLAN_GRAMMAR, parsePlan } from "./odysseyPlan";
import { AMEND_GRAMMAR, parseAmendment } from "./odysseyAmend";
import { TASK_GRAMMAR, parseTaskLines } from "./odysseyTasks";
import { ASK_GRAMMAR, parseAsks } from "./odysseyAsk";

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, "../../../runtime/skills/super-thing/SKILL.md");
const skill = readFileSync(path, "utf8");

/** Backticked identifiers inside one `##` section of the document. */
function tokensIn(heading: string): Set<string> {
  const start = skill.indexOf(`## ${heading}`);
  expect(start, `the skill has a "${heading}" section`).toBeGreaterThan(-1);
  const rest = skill.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  const body = next < 0 ? rest : rest.slice(0, next);
  return new Set([...body.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string));
}

describe("the skill the agents load", () => {
  it("has front matter of the shape agents require, named after its directory", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(front, "front matter delimited by --- at the top of the file").toBeTruthy();
    const body = front?.[1] ?? "";
    expect(/^name: super-thing$/m.test(body)).toBe(true);
    const description = /^description: (.+)$/m.exec(body)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(40);
    // A description that spans lines does not survive the front matter.
    expect(description).not.toContain("\n");
  });

  it("says when to load it, so the model can find it from a continuation", () => {
    expect(/^description: .*\bUse when\b/m.test(skill)).toBe(true);
  });
});

describe("the report grammar it teaches", () => {
  it("quotes the grammar the prompt quotes, character for character", () => {
    expect(skill).toContain(REPORT_GRAMMAR);
  });

  it("parses every example line it gives, to the meaning it claims", () => {
    const examples = [...skill.matchAll(/^SUPERTHING-REPORT: (?!milestone=<).*$/gm)].map((match) => match[0]);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) {
      const report = parseReport(example);
      expect(report, `the skill's example must parse: ${example}`).not.toBeNull();
      expect(report?.milestone).toBeGreaterThan(0);
      expect(report?.note.length).toBeGreaterThan(0);
    }
    // Both outcomes are shown, because a run that can only succeed is a lie.
    const statuses = examples.map((example) => parseReport(example)?.status);
    expect(new Set(statuses)).toEqual(new Set(["complete", "blocked"]));
  });

  it("tells the model to omit the line rather than invent one", () => {
    expect(skill).toContain("Omit the line while you are mid-work");
    expect(skill).toMatch(/nothing claimed/);
  });

  it("never tells the model its report verifies anything", () => {
    expect(skill).toMatch(/is a \*\*claim\*\*, not a verification/);
    // The word "verified" must never be something the model produces.
    expect(skill).toMatch(/Only a check or the user produces `verified`/);
  });
});

describe("the plan grammar it teaches", () => {
  it("quotes the grammar the parser reads, character for character", () => {
    expect(skill).toContain(PLAN_GRAMMAR);
  });

  it("shows a block the parser can read", () => {
    // The documented shape, filled in the way a model would fill it.
    const filled = PLAN_GRAMMAR.replace("<title>", "Phase one")
      .replace("<one line, optional>", "Do the thing.")
      .replace("<manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>", "tests_pass cargo test")
      .replace("<task title, repeatable — three to eight per milestone, in order>", "first step")
      .replace("<numbers of earlier tasks in this milestone the one above waits for, optional>", "");
    const plan = parsePlan(filled);
    expect(plan?.milestones).toHaveLength(1);
    expect(plan?.milestones[0]).toMatchObject({ title: "Phase one", detail: "Do the thing.", checkKind: "tests_pass", checkSpec: "cargo test", steps: [{ title: "first step", depends: [] }] });
  });

  it("says a proposed check is a command Super Thing will run", () => {
    expect(skill).toMatch(/A check is a command Super Thing will run itself/);
    expect(skill).toMatch(/leave it `manual`/);
  });

  it("allows a refusal instead of an invented plan", () => {
    expect(skill).toMatch(/reply with \*\*no block\*\*/);
    expect(skill).toMatch(/an invented plan is not/);
  });

  it("says the plan is a draft a human starts", () => {
    expect(skill).toMatch(/The plan lands as a draft/);
    expect(skill).toMatch(/nothing you propose runs until a human has\s+seen it/);
  });
});

describe("the amendment grammar it teaches", () => {
  it("quotes the grammar the parser reads, character for character", () => {
    expect(skill).toContain(AMEND_GRAMMAR);
  });

  it("shows a block the parser can read", () => {
    const filled = AMEND_GRAMMAR.replace("<title>", "Ship art")
      .replace('<milestone number, or "end">', "2")
      .replace("<one line, optional>", "Import them.")
      .replace("<manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>", "manual")
      .replace("<title, optional, repeatable>", "Import the sprites")
      .replace("revise: <milestone number>", "revise: 3")
      .replace("<new title, optional>", "Economy")
      .replace("<new detail, optional>", "Wider.")
      .replace("<new check, optional>", "manual")
      .replace("drop: <milestone number>", "drop: 4")
      .replace("<one line>", "merged");
    expect(parseAmendment(filled)?.ops.map((op) => op.op)).toEqual(["add", "revise", "drop"]);
  });

  it("says references are opened by the agent, not shipped to it", () => {
    expect(skill).toMatch(/\*\*Open those yourself\*\*/);
    expect(skill).toMatch(/a folder of a hundred assets costs one line/);
  });

  it("says the agent chooses when, and that verified work is settled", () => {
    expect(skill).toMatch(/\*\*You decide where it belongs, but not whether to answer\.\*\*/);
    expect(skill).toMatch(/A verified milestone cannot be revised or dropped/);
  });

  it("allows a no-change answer instead of an invented milestone", () => {
    expect(skill).toMatch(/send \*\*no block\*\*/);
    expect(skill).toMatch(/Do not invent a milestone to look responsive/);
  });
});

describe("what it says about subagents", () => {
  it("says a subagent spends the orchestrator's own subscription, whichever provider that is", () => {
    const section = flat("Subagents");
    expect(section).toContain("If you are Claude Code");
    expect(section).toContain("If you are Codex");
    expect(section).toContain("on the same subscription as you");
  });

  it("refuses the model the option of silently deferring an amendment", () => {
    // One was deferred and lost: the prompt carrying it compacted away and
    // nothing recorded that it had ever been asked.
    expect(skill).toMatch(/Deferring silently loses it/);
    expect(skill).toMatch(/One of\s+those three, every time/);
    expect(skill).toMatch(/not whether to answer/);
  });

  it("warns that a subagent cannot ask for permission", () => {
    expect(skill).toMatch(/A subagent cannot ask for permission/);
  });
});

describe("the enumerations it documents", () => {
  it("lists exactly the real check kinds", () => {
    const kinds: CheckKind[] = ["manual", "command", "files_exist", "tests_pass"];
    const documented = tokensIn("What makes a milestone done");
    for (const kind of kinds) expect(documented.has(kind), `${kind} is documented`).toBe(true);
    // And nothing that is not a check kind is presented as one.
    const table = skill.slice(skill.indexOf("| Check | Done when |"));
    const rows = [...table.slice(0, table.indexOf("\n\n")).matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(new Set(rows)).toEqual(new Set(kinds));
  });

  it("lists exactly the real run states", () => {
    const states: OdysseyState[] = ["draft", "running", "waiting_usage", "paused", "blocked", "complete", "abandoned"];
    const documented = tokensIn("Run states");
    for (const state of states) expect(documented.has(state), `${state} is documented`).toBe(true);
    const bullets = [...skill.matchAll(/^- `([a-z_]+)` — /gm)].map((match) => match[1]);
    expect(new Set(bullets)).toEqual(new Set(states));
  });

  it("names every milestone state the runner can put a milestone in", () => {
    const states: MilestoneState[] = ["planned", "active", "reported", "verified", "failed", "skipped"];
    const documented = tokensIn("Run states");
    for (const state of states) expect(documented.has(state), `${state} is documented`).toBe(true);
  });
});

describe("what it says about the two lanes", () => {
  it("explains how to make an agent-run check readable", () => {
    expect(skill).toContain("as its own shell call");
    expect(skill).toMatch(/exactly as the briefing states it/);
  });

  it("says plainly that an unattributable turn claims nothing", () => {
    expect(skill).toMatch(/claims nothing/);
    expect(skill).toMatch(/stays `reported`/);
  });

  it("points at a subagent for verification, and says why the exit code is what counts", () => {
    expect(skill).toMatch(/subagent/i);
    expect(skill).toMatch(/exit code in\s+the tool record is what counts/);
  });

  it("warns about the no-progress guard rather than letting a loop find it", () => {
    expect(skill).toMatch(/changes nothing on disk and nothing in the plan trips a guard/);
  });
});

describe("the task line it teaches", () => {
  it("quotes the grammar the parser reads, character for character", () => {
    expect(skill).toContain(TASK_GRAMMAR);
  });

  it("parses every example line it gives", () => {
    const examples = [...skill.matchAll(/^SUPERTHING-TASK: (?!milestone=<).*$/gm)].map((match) => match[0]);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const example of examples) expect(parseTaskLines(example), example).toHaveLength(1);
    expect(new Set(examples.flatMap((example) => parseTaskLines(example)).map((line) => line.status))).toEqual(new Set(["in_progress", "done", "blocked"]));
  });

  it("tells the model to name subagents after their task, and that done is its word", () => {
    expect(skill).toMatch(/Name each subagent after its task/);
    expect(skill).toMatch(/A task's `done` is your word/);
  });
});

describe("the ask line and replanning it teaches", () => {
  it("quotes the ask grammar the parser reads, character for character", () => {
    expect(skill).toContain(ASK_GRAMMAR);
  });

  it("parses every ask example it gives", () => {
    const examples = [...skill.matchAll(/^SUPERTHING-ASK: (?!kind=<).*$/gm)].map((match) => match[0]);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) expect(parseAsks(example), example).toHaveLength(1);
  });

  it("tells the model never to wait, and that a plan change is a proposal", () => {
    expect(skill).toMatch(/\*\*Never wait for the answer\.\*\*/);
    expect(skill).toMatch(/are a proposal until the user accepts it/);
    expect(skill).toMatch(/\*\*Task changes land at once\*\*/);
    expect(skill).toMatch(/Quota, harness choice, tooling, workers/);
    expect(skill).toMatch(/Never block or ask for\s+this/);
    expect(skill).toMatch(/Done tasks and verified milestones are not rewritten/);
  });
});

/** A section with its wrapping and emphasis removed, so a phrase can be
 *  matched against the prompt's wording rather than against Markdown. */
function flat(heading: string): string {
  const start = skill.indexOf(`## ${heading}`);
  expect(start, `the skill has a "${heading}" section`).toBeGreaterThan(-1);
  const end = skill.indexOf("\n## ", start + 4);
  return skill
    .slice(start, end < 0 ? undefined : end)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ");
}

describe("what the skill says about a run that changed sessions", () => {
  it("tells a fresh orchestrator where the work it did not do is written down", () => {
    // A goal outlives its session now (docs/plans/odyssey-second-orchestrator.md
    // §2.3), and a model that starts milestone 1 again because nothing told it
    // otherwise is the failure this section exists to prevent.
    const section = flat("You may be picking up someone else's run");
    expect(section).toContain(ODYSSEY_STATE_NOTE);
    expect(section).toContain(ODYSSEY_AGENT_NOTES_DIR);
    // The two milestone states the briefing writes have to read the same in
    // both places, or the skill teaches the model to misread the briefing.
    expect(section).toContain(milestoneStateLabel({ state: "verified" }));
    expect(section).toContain(milestoneStateLabel({ state: "reported" }));
  });

  it("says the briefing is per session, not per goal", () => {
    expect(skill).toContain("briefing** once per session");
    expect(skill).not.toContain("briefing** once per goal");
  });

  it("leaves no instruction that only worked under Kit", () => {
    // `model:` roles, `harness: "acp.kit"` and "an external harness" were
    // Kit's. Left in, they are instructions that silently fail.
    expect(skill).not.toContain("acp.kit");
    expect(skill).not.toContain("acp.claude");
    expect(skill).not.toMatch(/\bKit\b/);
  });
});

describe("what the skill says about delegating under Claude", () => {
  it("names the same delegate the briefing does", () => {
    const section = flat("Subagents");
    expect(section).toContain(`subagent_type: ${ODYSSEY_DELEGATE}`);
    // And says why, because "use this one" without a reason is a rule a model
    // drops the moment it is inconvenient.
    expect(section).toContain("model is a field on its definition");
  });
});

describe("the skill and a session that leads a team", () => {
  it("says how to delegate to workers and what a worker's check is worth", () => {
    const section = flat("Leading a team");
    expect(section).toContain("`delegate`");
    expect(section).toContain("`6.3-pricing: …`");
    expect(section).toContain("not evidence for the run");
  });

  it("no longer says the run ignores the agent's own tool results", () => {
    expect(skill).not.toContain("rather than reading an exit code out of your tool results");
  });
});
