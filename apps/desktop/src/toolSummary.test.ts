import { describe, expect, it } from "vitest";
import { commandsIn, detectTestRun, editedFilesIn, shellResultsIn, shellResultsOf, testCountsIn } from "./toolSummary";

describe("shell results in a compose output", () => {
  it("reads a bare result", () => {
    expect(shellResultsIn({ exit_code: 0, stdout: "ok\n", stderr: "", success: true })).toEqual([
      { command: null, exitCode: 0, stdout: "ok\n", stderr: "" },
    ]);
  });

  it("reads results nested under the program's bindings", () => {
    // The shape a two-binding Runlet program returns, taken from a real transcript.
    const output = { a: { exit_code: 1, stderr: "boom", stdout: "", success: false }, b: { servers: [], truncated: false } };
    expect(shellResultsIn(output)).toEqual([{ command: null, exitCode: 1, stdout: "", stderr: "boom" }]);
  });

  it("ignores anything without an exit code", () => {
    expect(shellResultsIn({ preview: "…", artifact: "/tmp/a.json", original_bytes: 13761 })).toEqual([]);
    expect(shellResultsIn("plain text")).toEqual([]);
  });
});

describe("edited files in a compose output", () => {
  it("reads the edit tool's own result shape", () => {
    expect(editedFilesIn({ first: { path: "src/a.ts", status: "edited" }, second: { path: "src/b.ts", status: "added" } })).toEqual([
      { path: "src/a.ts", status: "edited" },
      { path: "src/b.ts", status: "added" },
    ]);
  });

  it("does not treat an arbitrary path field as an edit", () => {
    expect(editedFilesIn({ path: "src/a.ts", status: "queued" })).toEqual([]);
  });
});

describe("commands in a Runlet program", () => {
  it("reads quoted command arguments", () => {
    const script = 'out = shell({ command: "cargo test --workspace" })\nreturn out';
    expect(commandsIn({ script })).toEqual(["cargo test --workspace"]);
  });

  it("unescapes and keeps every command", () => {
    const script = 'a = shell({command: "echo \\"hi\\""}) b = shell({ command: \'pnpm test\' }) return {a, b}';
    expect(commandsIn({ script })).toEqual(['echo "hi"', "pnpm test"]);
  });

  it("returns nothing when there is no script", () => {
    expect(commandsIn({})).toEqual([]);
    expect(commandsIn(null)).toEqual([]);
  });
});

describe("test counts read from runner output", () => {
  it("reads cargo", () => {
    expect(testCountsIn("test result: ok. 131 passed; 0 failed; 5 ignored; 0 measured")).toEqual({
      passed: 131,
      failed: 0,
      total: null,
      evidence: "test result: ok. 131 passed; 0 failed",
    });
  });

  it("reads vitest, including a failing run", () => {
    expect(testCountsIn("  Test Files  8 passed (8)\n       Tests  25 passed (25)")).toMatchObject({ passed: 25, failed: 0, total: 25 });
    expect(testCountsIn("Tests  1 failed | 24 passed (25)")).toMatchObject({ passed: 24, failed: 1, total: 25 });
  });

  it("reads jest and mocha", () => {
    expect(testCountsIn("Tests:       3 failed, 39 passed, 42 total")).toMatchObject({ passed: 39, failed: 3, total: 42 });
    expect(testCountsIn("  12 passing (340ms)\n  2 failing")).toMatchObject({ passed: 12, failed: 2 });
  });

  it("reads pytest", () => {
    expect(testCountsIn("======== 12 passed, 1 failed in 3.20s ========")).toMatchObject({ passed: 12, failed: 1 });
  });

  it("returns null rather than guessing when no runner said anything", () => {
    expect(testCountsIn("Compiling kit v0.1.129\nFinished in 28s")).toBeNull();
    expect(testCountsIn("")).toBeNull();
  });
});

describe("detecting a test run", () => {
  const script = 'out = shell({ command: "pnpm run test" })\nreturn out';

  it("pairs a test command with its shell result", () => {
    const run = detectTestRun({ script }, { exit_code: 0, stdout: "Tests  25 passed (25)", stderr: "", success: true });
    expect(run).toMatchObject({ command: "pnpm run test", ok: true, exitCode: 0 });
    expect(run?.counts).toMatchObject({ passed: 25, failed: 0 });
  });

  it("trusts the exit code over the printed counts", () => {
    const run = detectTestRun({ script }, { exit_code: 1, stdout: "Tests  1 failed | 24 passed (25)", stderr: "", success: false });
    expect(run?.ok).toBe(false);
    expect(run?.counts).toMatchObject({ passed: 24, failed: 1 });
  });

  it("reports the run without counts when the runner printed none", () => {
    const run = detectTestRun({ script }, { exit_code: 0, stdout: "done", stderr: "", success: true });
    expect(run).toMatchObject({ ok: true, counts: null });
  });

  it("leaves an ordinary shell call alone", () => {
    const build = 'out = shell({ command: "cargo build" })\nreturn out';
    expect(detectTestRun({ script: build }, { exit_code: 0, stdout: "Finished", stderr: "" })).toBeNull();
  });

  it("does not claim a test run when the script ran several commands and none names a runner in its result", () => {
    const mixed = 'a = shell({ command: "cargo test" }) b = shell({ command: "git status" }) return {a, b}';
    const output = { a: { exit_code: 0, stdout: "test result: ok. 3 passed; 0 failed", stderr: "" }, b: { exit_code: 0, stdout: "clean", stderr: "" } };
    // Two results, neither carrying its own command: which one ran the tests
    // is not knowable from the output, so nothing is claimed.
    expect(detectTestRun({ script: mixed }, output)).toBeNull();
  });

  it("uses the result's own command when the program reports it", () => {
    const mixed = 'a = shell({ command: "cargo test" }) b = shell({ command: "git status" }) return {a, b}';
    const output = {
      a: { command: "cargo test", exit_code: 0, stdout: "test result: ok. 3 passed; 0 failed", stderr: "" },
      b: { command: "git status", exit_code: 0, stdout: "clean", stderr: "" },
    };
    expect(detectTestRun({ script: mixed }, output)).toMatchObject({ command: "cargo test", ok: true });
  });

  it("returns null without a shell result", () => {
    expect(detectTestRun({ script }, { preview: "…" })).toBeNull();
  });
});

describe("a shell command's result, as each provider reports it", () => {
  // Captured from the real programs on 1 October 2026.
  it("reads Claude Code's status and its `Exit code N` prefix", () => {
    const passed = { toolKind: "execute", status: "completed", rawInput: { command: "echo pass-marker" }, rawOutput: "pass-marker" };
    expect(shellResultsOf(passed, "claude")).toEqual([{ command: "echo pass-marker", exitCode: 0, stdout: "pass-marker", stderr: "" }]);
    const failed = { toolKind: "execute", status: "failed", rawInput: { command: "sh -c 'exit 3'" }, rawOutput: "Exit code 3\nfail-marker" };
    expect(shellResultsOf(failed, "claude")).toEqual([{ command: "sh -c 'exit 3'", exitCode: 3, stdout: "fail-marker", stderr: "" }]);
    expect(shellResultsOf({ ...passed, status: "in_progress" }, "claude")).toEqual([]);
    expect(shellResultsOf({ ...passed, toolKind: "read" }, "claude")).toEqual([]);
  });

  it("reads Codex's exitCode", () => {
    const run = { toolKind: "execute", status: "failed", rawInput: { command: "pnpm test", cwd: "/w" }, rawOutput: { exitCode: 1, output: "1 failed", durationMs: 9 } };
    expect(shellResultsOf(run, "codex")).toEqual([{ command: "pnpm test", exitCode: 1, stdout: "1 failed", stderr: "" }]);
  });

  it("never reads Gemini's, which reports a failing command as completed with no exit code", () => {
    const run = { toolKind: "execute", status: "completed", rawInput: { CommandLine: "sh -c 'exit 3'" }, rawOutput: "fail-marker\r\n" };
    expect(shellResultsOf(run, "gemini")).toEqual([]);
  });

  it("still reads the earlier runtime's shape, and a test run from any of them", () => {
    expect(shellResultsOf({ rawOutput: { exit_code: 0, stdout: "ok", stderr: "", command: "x" } }, "claude")).toHaveLength(1);
    const tests = { toolKind: "execute", status: "completed", rawInput: { command: "pnpm test" }, rawOutput: "Tests  12 passed (12)" };
    const run = detectTestRun(tests.rawInput, tests.rawOutput, shellResultsOf(tests, "claude"));
    expect(run?.ok).toBe(true);
    expect(run?.command).toBe("pnpm test");
  });
});
