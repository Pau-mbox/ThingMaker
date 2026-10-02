/**
 * What the screen says about a goal's plan: the document it came from, and
 * whether Big Thing can verify any of it by itself.
 */
import { describe, expect, it } from "vitest";
import { allManual, planSummary } from "./odysseyPlan";

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

describe("the check rule", () => {
  it("says so when no milestone can be checked by a command", () => {
    expect(allManual([{ checkKind: "manual" }, { checkKind: "manual", checkSpec: null }])).toBe(true);
    expect(allManual([{ checkKind: "tests_pass", checkSpec: "pnpm test" }, { checkKind: "manual" }])).toBe(false);
    expect(allManual([])).toBe(false);
  });
});
