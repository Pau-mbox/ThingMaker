/**
 * The planning turn: the model reads the document, Odyssey reads the block.
 *
 * The rule these tests protect is that nothing is invented. A reply with no
 * block proposes no plan, an unnamed check never becomes a command Odyssey
 * would run, and the prompt tells the model that its checks get executed.
 */
import { describe, expect, it } from "vitest";
import { ALL_MANUAL_NOTE, MAX_MILESTONES, PLAN_GRAMMAR, allManual, buildPlanningPrompt, parsePlan, planSummary } from "./odysseyPlan";

const goal = { title: "Ship onboarding v2", brief: "A new first-run experience." };

describe("reading the model's plan", () => {
  const reply = `Here is what the roadmap contains.

ODYSSEY-PLAN
milestone: Audit the current flow
detail: Collect the complaints and the funnel numbers.
check: manual
step: Read the support tickets
step: Pull the funnel numbers
milestone: Define the acceptance tests
check: tests_pass pnpm test
milestone: Build the screens
detail: From the new tokens.
END-ODYSSEY-PLAN

Tell me if you want them reordered.`;

  it("reads one milestone per group, in order, with its steps", () => {
    const plan = parsePlan(reply);
    expect(plan?.milestones.map((entry) => entry.title)).toEqual(["Audit the current flow", "Define the acceptance tests", "Build the screens"]);
    expect(plan?.milestones[0]?.steps.map((task) => task.title)).toEqual(["Read the support tickets", "Pull the funnel numbers"]);
    expect(plan?.milestones[0]?.detail).toBe("Collect the complaints and the funnel numbers.");
  });

  it("reads a named check into a kind and a spec", () => {
    const plan = parsePlan(reply);
    expect(plan?.milestones[1]).toMatchObject({ checkKind: "tests_pass", checkSpec: "pnpm test" });
    expect(plan?.milestones[0]).toMatchObject({ checkKind: "manual", checkSpec: null });
    expect(plan?.milestones[2]).toMatchObject({ checkKind: "manual", checkSpec: null });
  });

  it("says how many checks it would run, so they get read before a run starts", () => {
    expect(parsePlan(reply)?.notes.join(" ")).toContain("Read the commands before you start the run");
  });

  it("tolerates the decoration a model adds", () => {
    const decorated = `**ODYSSEY-PLAN**
- **milestone:** First thing
  - step: do it
* milestone: Second thing
**END-ODYSSEY-PLAN**`;
    expect(parsePlan(decorated)?.milestones.map((entry) => entry.title)).toEqual(["First thing", "Second thing"]);
    expect(parsePlan(decorated)?.milestones[0]?.steps).toEqual([{ title: "do it", depends: [] }]);
  });

  it("takes the last block when a reply revises itself", () => {
    const twice = `ODYSSEY-PLAN\nmilestone: Draft\nEND-ODYSSEY-PLAN\n\nOn reflection:\n\nODYSSEY-PLAN\nmilestone: Better\nEND-ODYSSEY-PLAN`;
    expect(parsePlan(twice)?.milestones.map((entry) => entry.title)).toEqual(["Better"]);
  });

  it("accepts a plan inside a fenced code block", () => {
    const fenced = "```text\nODYSSEY-PLAN\nmilestone: One\nmilestone: Two\nEND-ODYSSEY-PLAN\n```";
    expect(parsePlan(fenced)?.milestones).toHaveLength(2);
  });
});

describe("what it refuses", () => {
  it("proposes nothing when there is no block", () => {
    expect(parsePlan("The document is a design note, not a plan. I did not find milestones in it.")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });

  it("proposes nothing from an unterminated block", () => {
    expect(parsePlan("ODYSSEY-PLAN\nmilestone: One\nmilestone: Two")).toBeNull();
  });

  it("proposes nothing from a block with no milestones", () => {
    expect(parsePlan("ODYSSEY-PLAN\ndetail: some prose\nstep: a step\nEND-ODYSSEY-PLAN")).toBeNull();
  });

  it("never turns an unnamed check into a command it would run", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Clean up\ncheck: `rm -rf ~/.cache`\nmilestone: Ship\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]).toMatchObject({ checkKind: "manual", checkSpec: null });
    expect(plan?.notes.join(" ")).toContain("does not name one of");
  });

  it("ignores a check with a kind but nothing to run", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Test it\ncheck: tests_pass\nmilestone: Ship\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]).toMatchObject({ checkKind: "manual", checkSpec: null });
    expect(plan?.notes.join(" ")).toContain("nothing to run");
  });

  it("ignores keyed lines that have no milestone to belong to", () => {
    const plan = parsePlan("ODYSSEY-PLAN\ndetail: orphan\nstep: orphan\nmilestone: Real\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones).toHaveLength(1);
    expect(plan?.milestones[0]).toMatchObject({ title: "Real", detail: "", steps: [] });
  });

  it("stops at the milestone limit and says it did", () => {
    const many = `ODYSSEY-PLAN\n${Array.from({ length: MAX_MILESTONES + 3 }, (_, index) => `milestone: Item ${index + 1}`).join("\n")}\nEND-ODYSSEY-PLAN`;
    const plan = parsePlan(many);
    expect(plan?.milestones).toHaveLength(MAX_MILESTONES);
    expect(plan?.notes.join(" ")).toContain("3 beyond the limit were dropped");
  });

  it("bounds a title and a detail however long the model writes them", () => {
    const plan = parsePlan(`ODYSSEY-PLAN\nmilestone: ${"t".repeat(400)}\ndetail: ${"d".repeat(9_000)}\nEND-ODYSSEY-PLAN`);
    expect(plan?.milestones[0]?.title.length).toBeLessThanOrEqual(120);
    expect(plan?.milestones[0]?.detail.length).toBeLessThanOrEqual(3_000);
  });

  it("keeps a multi-line detail as lines, because a spec has structure", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Economy\ndetail: 20 cities, 10 goods.\ndetail: Prices follow marginal cost.\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]?.detail).toBe("20 cities, 10 goods.\nPrices follow marginal cost.");
  });
});

describe("the planning prompt", () => {
  const prompt = buildPlanningPrompt({ goal, document: "# Roadmap\n\n## Phase one\nDo the thing.", source: "roadmap.md" });

  it("carries the document and names where it came from", () => {
    expect(prompt).toContain("## Phase one");
    expect(prompt).toContain("roadmap.md");
    expect(prompt).toContain(goal.title);
  });

  it("quotes the grammar the parser reads, character for character", () => {
    expect(prompt).toContain(PLAN_GRAMMAR);
    // And the block it asks for parses.
    const echoed = prompt.slice(prompt.indexOf("ODYSSEY-PLAN"));
    expect(echoed.startsWith("ODYSSEY-PLAN")).toBe(true);
  });

  it("says this turn plans and nothing else", () => {
    expect(prompt).toContain("do not start the work");
    expect(prompt).toMatch(/do not run anything/);
  });

  it("asks for the document's substance rather than a summary", () => {
    // A 400-character summary of a 54 KB document left ~9% of it reachable
    // once the planning turn compacted away.
    expect(prompt).toMatch(/Carry the document's substance across, do not summarise it/);
    expect(prompt).toMatch(/it is all anyone sees/);
    expect(prompt).toMatch(/A reader with only your milestones should be able to build the thing/);
  });

  it("warns that a proposed check is a command Odyssey will run", () => {
    expect(prompt).toContain("Odyssey runs these commands itself, so do not invent one");
  });

  it("asks for the block and nothing else, and allows a refusal", () => {
    expect(prompt).toContain("Reply with nothing but this block");
    expect(prompt).toContain("reply with no block");
  });
});

describe("describing the source document", () => {
  it("names the file and its size", () => {
    expect(planSummary({ planSource: "roadmap.md", planDocumentBytes: 4_096 })).toBe("roadmap.md · 4 KB");
  });

  it("rounds a small document up rather than reporting 0 KB", () => {
    expect(planSummary({ planSource: "a.md", planDocumentBytes: 12 })).toBe("a.md · 1 KB");
  });

  it("is absent when the goal was not planned from a document", () => {
    expect(planSummary({})).toBeNull();
  });
});

describe("section references and the check rule", () => {
  it("reads where a milestone came from in the document", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Economy\nsection: `## 4. Economy` (lines 210–305)\ncheck: tests_pass pnpm test\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]).toMatchObject({ title: "Economy", section: "## 4. Economy (lines 210–305)", checkKind: "tests_pass" });
    expect(parsePlan("ODYSSEY-PLAN\nmilestone: Economy\nEND-ODYSSEY-PLAN")?.milestones[0]?.section).toBeNull();
  });

  it("says so when no milestone can be checked by a command", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: One\nmilestone: Two\ncheck: manual\nEND-ODYSSEY-PLAN");
    expect(plan?.notes).toContain(ALL_MANUAL_NOTE);
    expect(allManual(plan?.milestones ?? [])).toBe(true);
    const checked = parsePlan("ODYSSEY-PLAN\nmilestone: One\ncheck: tests_pass pnpm test\nmilestone: Two\nEND-ODYSSEY-PLAN");
    expect(checked?.notes).not.toContain(ALL_MANUAL_NOTE);
    expect(allManual(checked?.milestones ?? [])).toBe(false);
    expect(allManual([])).toBe(false);
  });

  it("hands the planner the project's test command and asks it to use it", () => {
    const prompt = buildPlanningPrompt({ goal: { title: "Ship it", brief: "", defaultCheck: "python3 Tools/check.py" }, document: "# Plan", source: "plan.md" });
    expect(prompt).toContain("Every milestone gets a check Odyssey can run");
    expect(prompt).toContain("check: tests_pass python3 Tools/check.py");
    expect(prompt).toContain("`manual` stalls the run");
    expect(prompt).toContain("Name where each milestone came from with `section:`");
    // Without one it still asks for a runnable check and says what `manual` costs.
    const bare = buildPlanningPrompt({ goal: { title: "Ship it", brief: "" }, document: "# Plan", source: null });
    expect(bare).toContain("Prefer a check Odyssey can run");
    expect(bare).toContain("`manual` stalls the run");
  });
});

describe("tasks and what they wait for", () => {
  it("reads tasks in order and a task's dependencies on earlier ones", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Economy\nstep: Model\nstep: Pricing\ndepends: 1\nstep: Validation\ndepends: 1, 2, 3, 7\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]?.steps).toEqual([
      { title: "Model", depends: [] },
      { title: "Pricing", depends: [1] },
      // Only earlier tasks can be waited for: itself and a later number are dropped.
      { title: "Validation", depends: [1, 2] },
    ]);
  });

  it("accepts task: as a synonym and tolerates dotted numbers", () => {
    const plan = parsePlan("ODYSSEY-PLAN\nmilestone: Economy\ntask: Model\ntask: Pricing\ndepends: 6.1\nEND-ODYSSEY-PLAN");
    expect(plan?.milestones[0]?.steps[1]).toEqual({ title: "Pricing", depends: [1] });
  });

  it("asks the planner for tasks a subagent can be given", () => {
    const prompt = buildPlanningPrompt({ goal: { title: "Ship it", brief: "" }, document: "# Plan", source: null });
    expect(prompt).toContain("three to eight `step:` tasks");
    expect(prompt).toContain("`depends:`");
  });
});
