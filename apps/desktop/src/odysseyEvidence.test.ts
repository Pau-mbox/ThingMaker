/**
 * O5's gate for the agent-run lane: an ambiguous turn claims nothing.
 */
import { describe, expect, it } from "vitest";
import { evidenceFor, failureTail, newCallIds, readableFromToolResults, sameCommand } from "./odysseyEvidence";
import type { ShellResult } from "./toolSummary";

function result(overrides: Partial<ShellResult> = {}): ShellResult {
  return { command: null, exitCode: 0, stdout: "", stderr: "", ...overrides };
}

describe("comparing commands", () => {
  it("ignores whitespace and a trailing semicolon", () => {
    expect(sameCommand("pnpm  test", "pnpm test")).toBe(true);
    expect(sameCommand("cargo test;", "cargo test")).toBe(true);
  });

  it("does not treat a different invocation as the same command", () => {
    expect(sameCommand("pnpm test", "pnpm test -- onboarding")).toBe(false);
    expect(sameCommand("pnpm test", "pnpm run test")).toBe(false);
    expect(sameCommand("", "")).toBe(false);
  });
});

describe("finding the check in a turn's tool results", () => {
  it("reads the exit code of the matching command", () => {
    const evidence = evidenceFor("pnpm test", [result({ command: "npm run lint" }), result({ command: "pnpm test", exitCode: 0 })]);
    expect(evidence.kind).toBe("found");
    if (evidence.kind === "found") {
      expect(evidence.result.exitCode).toBe(0);
      expect(evidence.how).toContain("pnpm test");
    }
  });

  it("takes the last run of the command, not the first attempt", () => {
    const evidence = evidenceFor("cargo test", [result({ command: "cargo test", exitCode: 101 }), result({ command: "cargo test", exitCode: 0 })]);
    expect(evidence.kind === "found" && evidence.result.exitCode).toBe(0);
  });

  it("says the check is absent when the turn ran other commands instead", () => {
    const evidence = evidenceFor("pnpm test", [result({ command: "git status" })]);
    expect(evidence.kind).toBe("absent");
    expect(evidence.kind === "absent" && evidence.reason).toContain("none of them");
  });

  it("claims nothing when several unnamed commands ran", () => {
    const evidence = evidenceFor("pnpm test", [result({ exitCode: 0 }), result({ exitCode: 0 })]);
    expect(evidence.kind).toBe("ambiguous");
    expect(evidence.kind === "ambiguous" && evidence.reason).toContain("none reported which command");
  });

  it("reads a lone unnamed result, and admits it does not know the command", () => {
    const evidence = evidenceFor("pnpm test", [result({ exitCode: 1 })]);
    expect(evidence.kind).toBe("found");
    expect(evidence.kind === "found" && evidence.how).toContain("did not report which command");
  });

  it("refuses when there is nothing to look for or nothing to look in", () => {
    expect(evidenceFor(undefined, [result({ command: "pnpm test" })]).kind).toBe("absent");
    expect(evidenceFor("pnpm test", []).kind).toBe("absent");
  });

  it("only reads shell results for check kinds a command could satisfy", () => {
    expect(readableFromToolResults("tests_pass")).toBe(true);
    expect(readableFromToolResults("command")).toBe(true);
    expect(readableFromToolResults("manual")).toBe(false);
    // Paths are cheap to check here; the desktop lane owns that one.
    expect(readableFromToolResults("files_exist")).toBe(false);
  });
});

describe("the tail sent back to the model", () => {
  it("prefers stderr and keeps the last lines", () => {
    const tail = failureTail({ stdout: "a\nb", stderr: "one\ntwo\nthree" });
    expect(tail).toBe("two\nthree");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(failureTail({ stdout: "only this", stderr: "  " })).toBe("only this");
  });
});

describe("scoping results to this turn", () => {
  it("returns the calls the runner had not already seen", () => {
    expect(newCallIds(["a", "b", "c"], ["a"])).toEqual(["b", "c"]);
  });

  it("returns null with no baseline, so the caller refuses instead of guessing", () => {
    expect(newCallIds(["a", "b"], undefined)).toBeNull();
  });
});
