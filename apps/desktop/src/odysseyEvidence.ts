/**
 * The agent-run, desktop-read verification lane (docs/plans/odyssey.md §5.1).
 *
 * The model — or a subagent it raised, which is the natural use for one — runs
 * the milestone's check itself. Super Thing does not believe the prose about it:
 * it looks in the settled turn's tool results for a shell result whose command
 * is the milestone's check, and reads that result's exit code.
 *
 * Everything here is a refusal machine. If the turn's results do not clearly
 * contain the check, nothing is claimed and the milestone stays reported. A
 * wrong "verified" is worse than no verification at all, so every ambiguous
 * shape returns a reason instead of a verdict.
 */
import type { CheckKind } from "@thingmaker/contracts";
import type { ShellResult } from "./toolSummary";

/** Lines of a failing check's output sent back to the model (§5.2). */
export const FAILURE_TAIL_LINES = 2;

export type Evidence =
  /** A shell result that is this milestone's check, with its exit code. */
  | { kind: "found"; result: ShellResult; how: string }
  /** The check was not among the turn's results. */
  | { kind: "absent"; reason: string }
  /** Something ran, but nothing says it was this check. */
  | { kind: "ambiguous"; reason: string };

/**
 * Compares two command strings the way a reader would: whitespace collapsed,
 * a trailing `;` dropped. Nothing looser — `pnpm test` and `pnpm test -- foo`
 * are different commands, and treating them as one is how a check gets
 * credited to a run that never happened.
 */
export function sameCommand(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").replace(/;+$/, "");
  return normalize(left) === normalize(right) && normalize(left).length > 0;
}

/** Whether a check kind is one a shell result could ever be evidence for. */
export function readableFromToolResults(kind: CheckKind): boolean {
  return kind === "command" || kind === "tests_pass";
}

/**
 * Finds the milestone's check among a turn's shell results.
 *
 * When several results are the same command the last one wins: a check re-run
 * after a fix is the current state of the world, not the first attempt.
 */
export function evidenceFor(spec: string | undefined, results: ShellResult[]): Evidence {
  const wanted = (spec ?? "").trim();
  if (!wanted) return { kind: "absent", reason: "the milestone names no command, so there is nothing to look for" };
  if (results.length === 0) return { kind: "absent", reason: "the turn recorded no shell results" };

  const matches = results.filter((result) => result.command && sameCommand(result.command, wanted));
  const last = matches.at(-1);
  if (last) return { kind: "found", result: last, how: `the agent ran \`${last.command}\` and its tool result exited ${last.exitCode}` };

  const named = results.filter((result) => !!result.command);
  if (named.length > 0) {
    return { kind: "absent", reason: `the turn ran ${named.length === 1 ? "a command" : `${named.length} commands`}, none of them \`${wanted}\`` };
  }

  // Nothing reported its own command string. One result is still readable —
  // there is only one thing it could be — but several are not (§5.1).
  if (results.length === 1) {
    const only = results[0] as ShellResult;
    return { kind: "found", result: only, how: `the turn's only shell result exited ${only.exitCode}; the tool did not report which command it ran` };
  }
  return { kind: "ambiguous", reason: `the turn ran ${results.length} commands and none reported which command it was, so none of them can be credited to this check` };
}

/** The tail of a failing check, for the delta the model is told (§5.2). */
export function failureTail(result: Pick<ShellResult, "stdout" | "stderr">, lines = FAILURE_TAIL_LINES): string {
  const source = result.stderr.trim() || result.stdout.trim();
  return source
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

/**
 * Only shell results from calls the runner has not already seen count.
 *
 * The projection accumulates tool calls for the life of the session, so
 * without a baseline a check that passed three turns ago would verify a
 * milestone the model has only just claimed. The runner snapshots the ids it
 * knows about before it submits; anything else is this turn's.
 */
export function newCallIds(current: Iterable<string>, baseline: readonly string[] | undefined): string[] | null {
  if (!baseline) return null;
  const seen = new Set(baseline);
  return [...current].filter((id) => !seen.has(id));
}
