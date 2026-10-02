import { describe, expect, it } from "vitest";
import { checkLabel } from "./odysseyPrompt";

describe("check labels", () => {
  it("names the command that has to exit 0", () => {
    expect(checkLabel("command", "cargo test -p foo")).toBe("check: `cargo test -p foo` must exit 0");
    expect(checkLabel("tests_pass", "pnpm test")).toBe("check: `pnpm test` must exit 0");
  });

  it("lists the files that have to exist", () => {
    expect(checkLabel("files_exist", "docs/a.md\ndocs/b.md")).toBe("check: these files must exist: docs/a.md, docs/b.md");
  });

  it("says who decides a manual milestone", () => {
    expect(checkLabel("manual", null)).toBe("check: the user ticks it");
  });

  it("does not pretend a check exists when no spec is set", () => {
    expect(checkLabel("command", null)).toContain("not set yet");
  });
});
