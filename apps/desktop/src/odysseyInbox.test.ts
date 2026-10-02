/** What lands in the user's inbox (docs/plans/odyssey.md §11.10). */
import { describe, expect, it } from "vitest";
import { inboxItems } from "./odysseyInbox";
import type { AmendmentRecord, MilestoneRecord, OdysseyJournalEntry } from "@thingmaker/contracts";

describe("what lands in the inbox", () => {
  const milestone = (overrides: Partial<MilestoneRecord> & { id: string; title: string; position: number }): MilestoneRecord => ({ odysseyId: "o1", detail: "", state: "planned", checkKind: "manual", steps: [], ...overrides });
  const check = (id: string, milestoneId: string, at: number, passed: boolean): OdysseyJournalEntry => ({ id, odysseyId: "o1", at, kind: "check", milestoneId, summary: `Big Thing ran the check for milestone 2: ${passed ? "passed" : "failed"}`, detail: passed ? "ok" : "2 tests failed" });
  const amendment = (overrides: Partial<AmendmentRecord> & { id: string }): AmendmentRecord => ({ odysseyId: "o1", at: 1, note: "do it", refs: [], state: "told", tellCount: 1, ...overrides });
  const base = { goal: { state: "running" as const, onReport: "continue" as const }, milestones: [], journal: [], questions: [], planChanges: [], amendments: [], sessionAttention: null, now: 1_000 };

  it("is empty while the run decides everything itself", () => {
    expect(inboxItems(base)).toEqual([]);
  });

  it("surfaces a check that failed three times in a row, and forgets it once it passes", () => {
    const m2 = milestone({ id: "m2", title: "Economy", position: 1, state: "failed" });
    const failing = inboxItems({ ...base, milestones: [m2], journal: [check("c4", "m2", 40, false), check("c3", "m2", 30, false), check("c2", "m2", 20, false), check("c1", "m2", 10, true)] });
    expect(failing).toMatchObject([{ kind: "repeated_failure", failures: 3, lastOutput: "2 tests failed" }]);
    // Two failures are still the agent's to fix.
    expect(inboxItems({ ...base, milestones: [m2], journal: [check("c3", "m2", 30, false), check("c2", "m2", 20, false), check("c1", "m2", 10, true)] })).toEqual([]);
    expect(inboxItems({ ...base, milestones: [m2], journal: [check("c5", "m2", 50, true), check("c4", "m2", 40, false), check("c3", "m2", 30, false), check("c2", "m2", 20, false)] })).toEqual([]);
  });

  it("surfaces a claim only when the run is set to wait for the tick", () => {
    const claimed = milestone({ id: "m3", title: "Screens", position: 2, state: "reported" });
    expect(inboxItems({ ...base, milestones: [claimed] })).toEqual([]);
    expect(inboxItems({ ...base, goal: { state: "running", onReport: "wait" }, milestones: [claimed] })).toMatchObject([{ kind: "claim", index: 0 }]);
  });

  it("surfaces a stuck amendment, a blocked run and a session asking for input, newest first", () => {
    const items = inboxItems({
      ...base,
      goal: { state: "blocked", onReport: "continue" },
      journal: [{ id: "g1", odysseyId: "o1", at: 500, kind: "guard", summary: "3 turns in a row changed nothing" }],
      amendments: [amendment({ id: "a1", tellCount: 3, toldAt: 700 }), amendment({ id: "a2", tellCount: 1 })],
      sessionAttention: "needs_input",
    });
    expect(items.map((item) => item.kind)).toEqual(["needs_input", "amendment_stuck", "blocked"]);
    expect(items[2]).toMatchObject({ kind: "blocked", reason: "3 turns in a row changed nothing" });
  });
});
