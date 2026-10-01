/**
 * Reads structure out of an agent's tool call so the transcript can render it
 * as something better than a JSON blob, and so Big Thing can read a check's
 * exit code from a command the agent ran.
 *
 * Everything here is derived from what the tool itself reported. Nothing is
 * inferred from the model's prose and nothing is estimated: a test count is
 * only produced when a runner actually printed one, and the matched line is
 * carried along so the UI can show where the number came from. When a shape
 * is not recognised the result is `null` and the caller falls back to the raw
 * view.
 */

import type { Provider } from "@thingmaker/contracts";

/** How deep to walk a compose result before giving up. */
const MAX_DEPTH = 5;

export type ShellResult = {
  /** The command, when the program made it recoverable; otherwise null. */
  command: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type EditedFile = {
  path: string;
  status: "added" | "edited" | "deleted";
};

/** A count a test runner printed, with the line it was read from. */
export type TestCounts = {
  passed: number;
  failed: number;
  /** Only when the runner stated a total distinct from passed + failed. */
  total: number | null;
  /** The matched output line, so the reader can check the number. */
  evidence: string;
};

export type TestRun = {
  command: string | null;
  /** Exit status is the authority on pass/fail; counts are extra detail. */
  ok: boolean;
  exitCode: number;
  counts: TestCounts | null;
  output: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Collects shell-shaped results anywhere in a compose output. A compose
 * program returns one object per named binding, so a result can arrive bare
 * (`{exit_code, stdout, …}`) or nested under arbitrary keys (`{a: {…}}`).
 */
export function shellResultsIn(output: unknown, depth = 0): ShellResult[] {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(output)) return output.flatMap((entry) => shellResultsIn(entry, depth + 1));
  if (!isRecord(output)) return [];
  if (typeof output.exit_code === "number") {
    return [
      {
        command: typeof output.command === "string" ? output.command : null,
        exitCode: output.exit_code,
        stdout: asString(output.stdout),
        stderr: asString(output.stderr),
      },
    ];
  }
  return Object.values(output).flatMap((value) => shellResultsIn(value, depth + 1));
}

/**
 * A shell command's result as each provider reports it on the stream
 * (captured from the real programs):
 *
 * - **Codex** (bridged app-server): `rawInput.command`, and `rawOutput`
 *   `{exitCode, output}`.
 * - **Claude Code**: `rawInput.command`, the call's `status` (`completed` or
 *   `failed`), and a plain-text `rawOutput` that starts with `Exit code N` on
 *   a failure.
 * - **Gemini** (`agy`): `rawInput.CommandLine`, but a failing command is
 *   reported `completed` with no exit code, so nothing it reports can be read
 *   as a pass or a fail. It yields no result rather than a wrong one.
 * - The earlier runtime's `{exit_code, stdout, …}`, wherever it appears.
 */
export function shellResultsOf(patch: ToolPatchLike | undefined, provider: Provider | undefined): ShellResult[] {
  if (!patch) return [];
  const legacy = shellResultsIn(patch.rawOutput);
  if (legacy.length > 0) return legacy;
  const input = isRecord(patch.rawInput) ? patch.rawInput : {};
  const raw = input.command ?? input.CommandLine ?? input.cmd;
  const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : null;
  const output = patch.rawOutput;
  if (provider === "codex" || (isRecord(output) && typeof output.exitCode === "number")) {
    if (!isRecord(output) || typeof output.exitCode !== "number") return [];
    return [{ command, exitCode: output.exitCode, stdout: asString(output.output ?? output.aggregatedOutput), stderr: "" }];
  }
  if (provider === "claude") {
    if (patch.toolKind !== "execute" || !command) return [];
    if (patch.status !== "completed" && patch.status !== "failed") return [];
    const text = typeof output === "string" ? output : contentText(patch.content);
    const code = /^Exit code (\d+)\s*\n?/.exec(text);
    const exitCode = patch.status === "completed" ? 0 : code ? Number(code[1]) : 1;
    return [{ command, exitCode, stdout: code ? text.slice(code[0].length) : text, stderr: "" }];
  }
  return [];
}

/** The fields of a tool call the readers here use. */
export type ToolPatchLike = { toolKind?: string | null; status?: string | null; rawInput?: unknown; rawOutput?: unknown; content?: unknown };

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => (isRecord(entry) && isRecord(entry.content) && typeof entry.content.text === "string" ? entry.content.text : ""))
    .join("\n")
    .replace(/^```[a-z]*\n?|\n?```$/g, "");
}

/** Collects `{path, status}` results, which is what Kit's `edit` tool returns. */
export function editedFilesIn(output: unknown, depth = 0): EditedFile[] {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(output)) return output.flatMap((entry) => editedFilesIn(entry, depth + 1));
  if (!isRecord(output)) return [];
  const status = output.status;
  if (typeof output.path === "string" && (status === "added" || status === "edited" || status === "deleted")) {
    return [{ path: output.path, status }];
  }
  return Object.values(output).flatMap((value) => editedFilesIn(value, depth + 1));
}

/**
 * Pulls the `command:` strings out of a Runlet program. This is a best-effort
 * read of the script the model wrote, used only for labelling; a miss shows
 * the card without a command rather than a wrong one.
 */
export function commandsIn(input: unknown): string[] {
  const script = isRecord(input) ? asString(input.script) : typeof input === "string" ? input : "";
  if (!script) return [];
  const found: string[] = [];
  const pattern = /command\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const match of script.matchAll(pattern)) {
    const raw = match[1] ?? "";
    const body = raw.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    if (body.trim()) found.push(body.trim());
  }
  return found;
}

/** Commands that mean "this call ran a test suite". */
const TEST_COMMAND = /(^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|vitest|jest)|cargo\s+(?:test|nextest)|pytest|go\s+test|dotnet\s+test|gradle(?:w)?\s+test|mvn\s+test|rspec|phpunit|vitest|jest|ctest)\b/;

/**
 * Ordered so the most specific runner format wins. Each entry maps a match to
 * counts; `null` means the pattern matched but the numbers were not usable.
 */
const COUNT_PATTERNS: { pattern: RegExp; read: (m: RegExpMatchArray) => TestCounts | null }[] = [
  {
    // cargo: `test result: ok. 131 passed; 0 failed; 5 ignored; …`
    pattern: /test result: \w+\. (\d+) passed; (\d+) failed/,
    read: (m) => ({ passed: Number(m[1]), failed: Number(m[2]), total: null, evidence: m[0] }),
  },
  {
    // vitest: `Tests  25 passed (25)` / `Tests  1 failed | 24 passed (25)`
    pattern: /Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed \((\d+)\)/,
    read: (m) => ({ passed: Number(m[2]), failed: Number(m[1] ?? 0), total: Number(m[3]), evidence: m[0] }),
  },
  {
    // jest: `Tests:       3 failed, 39 passed, 42 total`
    pattern: /Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed,\s*(\d+) total/,
    read: (m) => ({ passed: Number(m[2]), failed: Number(m[1] ?? 0), total: Number(m[3]), evidence: m[0] }),
  },
  {
    // mocha: `12 passing` / `2 failing`
    pattern: /(\d+) passing(?:[\s\S]{0,80}?(\d+) failing)?/,
    read: (m) => ({ passed: Number(m[1]), failed: Number(m[2] ?? 0), total: null, evidence: m[0].split("\n")[0] ?? m[0] }),
  },
  {
    // pytest: `=== 12 passed, 1 failed in 3.2s ===`
    pattern: /(\d+) passed(?:, (\d+) failed)?/,
    read: (m) => ({ passed: Number(m[1]), failed: Number(m[2] ?? 0), total: null, evidence: m[0] }),
  },
];

/** Reads a count out of runner output, or null when none is stated. */
export function testCountsIn(output: string): TestCounts | null {
  for (const { pattern, read } of COUNT_PATTERNS) {
    const match = output.match(pattern);
    if (!match) continue;
    const counts = read(match);
    if (counts && Number.isFinite(counts.passed) && Number.isFinite(counts.failed)) return counts;
  }
  return null;
}

/**
 * Recognises a tool call that ran tests. Returns null unless a test-shaped
 * command and a shell result are both present, so an ordinary shell call is
 * never dressed up as a test report.
 */
export function detectTestRun(input: unknown, output: unknown, known?: ShellResult[]): TestRun | null {
  const results = known && known.length > 0 ? known : shellResultsIn(output);
  if (results.length === 0) return null;
  const commands = commandsIn(input);
  const scriptLooksLikeTests = commands.some((command) => TEST_COMMAND.test(command));

  // Prefer the result whose own command names a runner; otherwise, when the
  // script ran exactly one command and it was a test command, use that result.
  const byOwnCommand = results.find((result) => result.command !== null && TEST_COMMAND.test(result.command));
  const chosen = byOwnCommand ?? (scriptLooksLikeTests && results.length === 1 ? results[0] : undefined);
  if (!chosen) return null;

  const command = chosen.command ?? commands.find((entry) => TEST_COMMAND.test(entry)) ?? null;
  const combined = [chosen.stdout, chosen.stderr].filter(Boolean).join("\n");
  return {
    command,
    ok: chosen.exitCode === 0,
    exitCode: chosen.exitCode,
    counts: testCountsIn(combined),
    output: combined,
  };
}
