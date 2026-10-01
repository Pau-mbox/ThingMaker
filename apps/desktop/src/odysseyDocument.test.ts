import { describe, expect, it } from "vitest";
import { MAX_PLAN_DOCUMENT_BYTES } from "./odysseyPlan";
import { fileNameOf, isPlanDocument, summarize } from "./odysseyDocument";

describe("recognising a document", () => {
  it("accepts the text formats plans are written in", () => {
    for (const path of ["/a/plan.md", "plan.MARKDOWN", "x.mdx", "notes.txt"]) expect(isPlanDocument(path)).toBe(true);
  });

  it("rejects anything else, without opening it", () => {
    for (const path of ["/a/archive.zip", "photo.png", "script.sh", "Makefile"]) expect(isPlanDocument(path)).toBe(false);
  });

  it("reads a file name off either separator", () => {
    expect(fileNameOf("/Users/x/plans/q3.md")).toBe("q3.md");
    expect(fileNameOf("C:\\plans\\q3.md")).toBe("q3.md");
  });
});

describe("measuring a document", () => {
  it("suggests the first heading as the goal name", () => {
    const summary = summarize("# Ship onboarding v2\n\n## Phase one\ntext\n", "plan.md");
    expect(summary.suggestedTitle).toBe("Ship onboarding v2");
    expect(summary.headings).toBe(2);
  });

  it("falls back to the file name when there is no heading", () => {
    expect(summarize("- [ ] a\n- [ ] b\n", "q3-roadmap.md").suggestedTitle).toBe("q3 roadmap");
  });

  it("does not mine a fenced code block for headings", () => {
    const summary = summarize("```\n# not a heading\n```\n# Real\n", "p.md");
    expect(summary.suggestedTitle).toBe("Real");
    expect(summary.headings).toBe(1);
  });

  it("reports a document too large to hand to a model in one turn", () => {
    const summary = summarize("x".repeat(MAX_PLAN_DOCUMENT_BYTES + 1), "big.md");
    expect(summary.tooLarge).toContain("has to be under 64 KB");
    expect(summarize("small", "s.md").tooLarge).toBeNull();
  });

  it("counts bytes, not characters, so a size is the real size", () => {
    expect(summarize("é", "p.md").bytes).toBe(2);
  });
});
