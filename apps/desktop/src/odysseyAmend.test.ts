/**
 * Amending a running goal. The rules these protect: the model names what it
 * changes, verified work is never rewritten, and an unreadable reply changes
 * nothing at all.
 */
import { describe, expect, it } from "vitest";
import type { MilestoneRecord } from "@thingmaker/contracts";
import { AMEND_GRAMMAR, MAX_TELLS, RETELL_AFTER_CONTINUATIONS, amendmentStatus, describeAmendment, describeOp, diffText, parseAmendment, planDiff, resolveOps, retellNote, shouldCarry } from "./odysseyAmend";

function milestone(overrides: Partial<MilestoneRecord> & { id: string; title: string; position: number }): MilestoneRecord {
  return { odysseyId: "o1", detail: "", state: "planned", checkKind: "manual", steps: [], ...overrides };
}

const plan = [
  milestone({ id: "m1", title: "Foundation", position: 0, state: "verified" }),
  milestone({ id: "m2", title: "Domain", position: 1, state: "active" }),
  milestone({ id: "m3", title: "Economy", position: 2 }),
];

describe("reading an amendment", () => {
  const reply = `I can fit the ships in after the domain work.

ODYSSEY-AMEND
add: Ship art pipeline
after: 2
detail: Import the generated ships and wire them to the trading UI.
check: tests_pass pnpm test
step: Import the sprites
step: Bind them to the ship definitions
revise: 3
title: Economy with ship classes
detail: Now also covers per-class capacity.
drop: 3
reason: folded into the milestone above
END-ODYSSEY-AMEND`;

  it("reads each operation with the fields that belong to it", () => {
    const amendment = parseAmendment(reply);
    expect(amendment?.ops).toHaveLength(3);
    expect(amendment?.ops[0]).toMatchObject({
      op: "add",
      title: "Ship art pipeline",
      after: 2,
      checkKind: "tests_pass",
      checkSpec: "pnpm test",
      steps: [
        { title: "Import the sprites", depends: [] },
        { title: "Bind them to the ship definitions", depends: [] },
      ],
    });
    expect(amendment?.ops[1]).toMatchObject({ op: "revise", target: 3, title: "Economy with ship classes" });
    expect(amendment?.ops[2]).toMatchObject({ op: "drop", target: 3, reason: "folded into the milestone above" });
  });

  it("defaults an add with no position to the end", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nadd: Something\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops[0]).toMatchObject({ op: "add", after: "end" });
  });

  it("takes the last block, and tolerates a model's decoration", () => {
    const decorated = `**ODYSSEY-AMEND**\n- **add:** First\n**END-ODYSSEY-AMEND**\n\nActually:\n\nODYSSEY-AMEND\nadd: Second\nEND-ODYSSEY-AMEND`;
    expect(parseAmendment(decorated)?.ops).toEqual([expect.objectContaining({ title: "Second" })]);
  });

  it("changes nothing when there is no block, or it is unterminated, or it is empty", () => {
    expect(parseAmendment("The plan already covers that, no change needed.")).toBeNull();
    expect(parseAmendment("ODYSSEY-AMEND\nadd: One")).toBeNull();
    expect(parseAmendment("ODYSSEY-AMEND\nreason: orphan\nEND-ODYSSEY-AMEND")).toBeNull();
    expect(parseAmendment("")).toBeNull();
  });

  it("ignores an operation that names prose instead of a milestone number", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\ndrop: the economy one\nadd: Real one\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops).toHaveLength(1);
    expect(amendment?.ops[0]).toMatchObject({ op: "add" });
    expect(amendment?.notes.join(" ")).toContain("rather than a milestone number");
  });

  it("never turns an unnamed check into a command it would run", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nadd: Clean up\ncheck: `rm -rf ~/.cache`\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops[0]).toMatchObject({ checkKind: "manual", checkSpec: null });
    expect(amendment?.notes.join(" ")).toContain("does not name one of");
  });

  it("stops at the operation limit and says it did", () => {
    const many = `ODYSSEY-AMEND\n${Array.from({ length: 23 }, (_, index) => `add: Item ${index}`).join("\n")}\nEND-ODYSSEY-AMEND`;
    const amendment = parseAmendment(many);
    expect(amendment?.ops).toHaveLength(20);
    expect(amendment?.notes.join(" ")).toContain("3 beyond the limit were ignored");
  });
});

describe("tying operations to milestones", () => {
  it("resolves a target against the list as it was before anything changed", () => {
    const resolved = resolveOps(parseAmendment("ODYSSEY-AMEND\nrevise: 2\ntitle: New\nEND-ODYSSEY-AMEND")!.ops, plan);
    expect(resolved[0]?.milestone?.id).toBe("m2");
    expect(resolved[0]?.refused).toBeNull();
  });

  it("refuses to rewrite verified work", () => {
    const resolved = resolveOps(parseAmendment("ODYSSEY-AMEND\ndrop: 1\nreason: no longer needed\nEND-ODYSSEY-AMEND")!.ops, plan);
    expect(resolved[0]?.refused).toContain("already verified");
    expect(describeOp(resolved[0]!)).toContain("refused");
  });

  it("refuses a target that does not exist", () => {
    const resolved = resolveOps(parseAmendment("ODYSSEY-AMEND\nrevise: 9\ntitle: x\nEND-ODYSSEY-AMEND")!.ops, plan);
    expect(resolved[0]?.refused).toBe("there is no milestone 9");
  });

  it("describes an add without needing a target", () => {
    const resolved = resolveOps(parseAmendment("ODYSSEY-AMEND\nadd: Ships\nafter: 2\nEND-ODYSSEY-AMEND")!.ops, plan);
    expect(resolved[0]?.refused).toBeNull();
    expect(describeOp(resolved[0]!)).toBe('Add milestone "Ships" after milestone 2');
  });
});

describe("how an amendment reads in the prompt", () => {
  it("hands over references as paths, for the agent to open itself", () => {
    const lines = describeAmendment(
      { note: "Generate the ships and embed them", refs: [{ path: "Assets/Art/Ships", kind: "directory", detail: "48 files" }] },
      null,
    );
    expect(lines[0]).toContain("Generate the ships and embed them");
    expect(lines[1]).toContain("`Assets/Art/Ships` (directory, 48 files)");
    expect(lines[1]).toContain("open it yourself");
    // The folder's contents are not in the prompt: that is the whole point.
    expect(lines.join("\n")).not.toContain("sprite");
  });

  it("quotes a document only when it is one the agent cannot reach", () => {
    const withDocument = describeAmendment({ note: "read this", refs: [], documentSource: "ships.md" }, "# Ships\nOne per class.");
    expect(withDocument.join("\n")).toContain("One per class.");
    expect(withDocument.join("\n")).toContain("it is not in the workspace");

    const withoutText = describeAmendment({ note: "read this", refs: [], documentSource: "ships.md" }, null);
    expect(withoutText.join("\n")).not.toContain("ships.md");
  });

  it("quotes the grammar the parser reads, and that grammar parses", () => {
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
    const amendment = parseAmendment(filled);
    expect(amendment?.ops.map((op) => op.op)).toEqual(["add", "revise", "drop"]);
  });
});

/**
 * Asking more than once. Telling the model a single time was the bug: an
 * amendment sat `told` through forty-six continuations, long after the prompt
 * that carried it had compacted out of context, and nothing asked again.
 */
describe("carrying an amendment again", () => {
  const told = (tellCount: number, toldAtContinuation?: number) => ({
    state: "told" as const,
    tellCount,
    ...(toldAtContinuation === undefined ? {} : { toldAtContinuation }),
  });

  it("always carries one that has never been told", () => {
    expect(shouldCarry({ state: "pending", tellCount: 0 }, 40)).toBe(true);
  });

  it("leaves a fresh telling alone for a few continuations", () => {
    expect(shouldCarry(told(1, 20), 20)).toBe(false);
    expect(shouldCarry(told(1, 20), 20 + RETELL_AFTER_CONTINUATIONS - 1)).toBe(false);
    expect(shouldCarry(told(1, 20), 20 + RETELL_AFTER_CONTINUATIONS)).toBe(true);
  });

  it("treats an untracked telling as due, which is exactly the stuck case", () => {
    // Rows written before the counter existed: told once, long ago, silently.
    expect(shouldCarry(told(0), 46)).toBe(true);
  });

  it("stops asking rather than repeating for ever", () => {
    expect(shouldCarry(told(MAX_TELLS, 1), 999)).toBe(false);
  });

  it("never carries one that is settled", () => {
    expect(shouldCarry({ state: "applied", tellCount: 1 }, 99)).toBe(false);
    expect(shouldCarry({ state: "discarded", tellCount: 1 }, 99)).toBe(false);
  });

  it("says on screen what actually happened to it", () => {
    expect(amendmentStatus({ state: "pending", tellCount: 0 })).toBe("queued for the next prompt");
    expect(amendmentStatus({ state: "told", tellCount: 1 })).toBe("with the agent");
    expect(amendmentStatus({ state: "told", tellCount: 2 })).toContain("told 2 times");
    // The give-up state has to read as the user's problem now, not the agent's.
    expect(amendmentStatus({ state: "told", tellCount: MAX_TELLS })).toContain("it is yours now");
    expect(amendmentStatus({ state: "applied", tellCount: 2 })).toBe("folded into the plan");
  });

  it("tells the model it is being asked again, not asked afresh", () => {
    expect(retellNote({ tellCount: 1 })).toContain("asked this once already");
    expect(retellNote({ tellCount: 2 })).toContain("asked this 2 times already");
    expect(retellNote({ tellCount: 2 })).toMatch(/say plainly that you will not and why/);
  });
});

describe("section references in an amendment", () => {
  it("reads a section for an added or revised milestone", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nadd: Ship art\nsection: `## 7. Ships`\nrevise: 2\nsection: lines 40–90\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops[0]).toMatchObject({ op: "add", title: "Ship art", section: "## 7. Ships" });
    expect(amendment?.ops[1]).toMatchObject({ op: "revise", target: 2, section: "lines 40–90" });
    expect(parseAmendment("ODYSSEY-AMEND\nadd: Plain\nEND-ODYSSEY-AMEND")?.ops[0]).toMatchObject({ section: null });
  });
});

describe("a revised detail keeps its lines", () => {
  it("joins several detail lines as lines, the way the plan parser does", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nrevise: 6\ndetail: Twenty cities, ten goods.\ndetail: Prices follow §5.3.\nadd: New\ndetail: First.\ndetail: Second.\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops[0]).toMatchObject({ op: "revise", detail: "Twenty cities, ten goods.\nPrices follow §5.3." });
    expect(amendment?.ops[1]).toMatchObject({ op: "add", detail: "First.\nSecond." });
  });
});

describe("tasks in an amendment", () => {
  it("adds tasks to an existing milestone, with what they wait for", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nrevise: 6\nstep: Author city anchors\nstep: Validate the network\ndepends: 1, 3\nEND-ODYSSEY-AMEND");
    expect(amendment?.ops[0]).toMatchObject({
      op: "revise",
      target: 6,
      steps: [
        { title: "Author city anchors", depends: [] },
        { title: "Validate the network", depends: [1, 3] },
      ],
    });
  });
});

describe("task operations and the plan diff", () => {
  const withTasks: MilestoneRecord[] = [
    { id: "m1", odysseyId: "o1", position: 0, title: "Foundation", detail: "", state: "verified", checkKind: "manual", steps: [] },
    {
      id: "m2",
      odysseyId: "o1",
      position: 1,
      title: "Economy",
      detail: "",
      state: "active",
      checkKind: "manual",
      steps: [
        { id: "t1", milestoneId: "m2", position: 0, title: "Model", state: "done", note: "", detail: "", dependsOn: [] },
        { id: "t2", milestoneId: "m2", position: 1, title: "Pricing", state: "pending", note: "", detail: "", dependsOn: ["t1"] },
      ],
    },
  ];

  it("reads the four task operations with what belongs to each", () => {
    const amendment = parseAmendment(
      "ODYSSEY-AMEND\ndrop_task: 2.2\nreason: folded in\nrevise_task: 2.1\ntitle: World model\ndepends: 2\nsplit_task: 2.2\nstep: A\nstep: B\ndepends: 1\nmove_task: 2.2\nafter: start\nEND-ODYSSEY-AMEND",
    );
    expect(amendment?.ops).toEqual([
      { op: "drop_task", ref: { milestone: 2, task: 2 }, reason: "folded in" },
      { op: "revise_task", ref: { milestone: 2, task: 1 }, title: "World model", detail: null, depends: [2], reason: "" },
      { op: "split_task", ref: { milestone: 2, task: 2 }, steps: [{ title: "A", depends: [] }, { title: "B", depends: [1] }], reason: "" },
      { op: "move_task", ref: { milestone: 2, task: 2 }, after: "start", reason: "" },
    ]);
  });

  it("refuses what cannot be rewritten and says why in the diff", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\ndrop_task: 2.1\nsplit_task: 2.2\nstep: only one\ndrop_task: 2.9\nrevise_task: 1.1\nEND-ODYSSEY-AMEND")!;
    const lines = planDiff(resolveOps(amendment.ops, withTasks));
    expect(lines.map((line) => line.refused)).toEqual([
      "task 2.1 is done, and done work is not rewritten",
      "a split needs at least two tasks to replace 2.2",
      "milestone 2 has no task 9",
      "milestone 1 is already verified, and verified work is not rewritten",
    ]);
    expect(diffText(lines)).toContain('− Drop task 2.1 "Model" — refused: task 2.1 is done');
  });

  it("renders one readable line per operation", () => {
    const amendment = parseAmendment("ODYSSEY-AMEND\nsplit_task: 2.2\nstep: Price model\nstep: Slippage\nreason: two owners\nmove_task: 2.2\nafter: 2.1\nadd: Risk\nafter: 2\nEND-ODYSSEY-AMEND")!;
    const text = diffText(planDiff(resolveOps(amendment.ops, withTasks)));
    expect(text.split("\n")).toEqual(['⇄ Split task 2.2 "Pricing" into 2: Price model, Slippage (two owners)', '↕ Move task 2.2 "Pricing" after 2.1', '+ Add milestone "Risk" after milestone 2']);
  });
});

describe("a note to the agent", () => {
  it("is described as a note, not as work to place, and reads as delivered once told", () => {
    expect(describeAmendment({ note: "Do not block on quota.", refs: [], kind: "note" }, null)).toEqual(["- A note from the user: Do not block on quota."]);
    expect(describeAmendment({ note: "Add ships.", refs: [] }, null)[0]).toContain("fold into the plan");
    expect(amendmentStatus({ state: "applied", tellCount: 1, kind: "note" })).toBe("delivered");
  });
});
