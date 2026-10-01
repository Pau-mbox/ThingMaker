import { describe, expect, it } from "vitest";
import { hunkPatch, parseHunks } from "./diffHunks";

const diff = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
+zero
 one
 two
 three
@@ -10,2 +11,1 @@
-old
 keep
`;

describe("hunk parsing", () => {
  it("separates the file header from hunks and counts changes", () => {
    const parsed = parseHunks(diff);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.fileHeader.split("\n")).toHaveLength(4);
    expect(parsed.hunks[0]).toMatchObject({ index: 0, additions: 1, deletions: 0 });
    expect(parsed.hunks[1]).toMatchObject({ index: 1, additions: 0, deletions: 1 });
    const patch = hunkPatch(parsed, parsed.hunks[1]!);
    expect(patch).toBe(`${parsed.fileHeader}\n@@ -10,2 +11,1 @@\n-old\n keep\n`);
    expect(patch).not.toContain("+zero");
  });

  it("handles the header-only form produced for baseline diffs", () => {
    const parsed = parseHunks("--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+new\n");
    expect(parsed.fileHeader).toBe("--- a/x\n+++ b/x");
    expect(parsed.hunks).toHaveLength(1);
  });
});
