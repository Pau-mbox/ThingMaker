/**
 * The Claude account's usage, from the only thing that reports it
 * (docs/plans/odyssey-second-orchestrator.md §2.4).
 *
 * There is no `wham/usage` equivalent on this side: nothing answers "how much
 * of the window is left". What answers is the refusal itself, and it is
 * specific enough to act on. Verbatim from adapter 0.76.0, prompting a spent
 * Pro subscription:
 *
 *     Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)
 *
 * So the account is only ever in one of two states the runner can see: *known
 * spent, until this time*, or *nothing says otherwise*. The second is
 * represented as no snapshot at all, which `usageVerdict` already reads as
 * "there is room" — absence of data is not evidence of exhaustion, and the
 * cost of being wrong is one refused prompt that immediately teaches us the
 * truth.
 */
import type { UsageSnapshot } from "@thingmaker/contracts";

/**
 * How long a recorded Claude refusal stands before the run tries again.
 *
 * Not "until the reset time it named". That time is a claim, and a wrong one
 * is expensive: a refusal recorded against the wrong account — which is a
 * thing that happens, and did — would otherwise park a perfectly healthy run
 * for hours. These windows also roll, so capacity comes back before the named
 * reset even when the refusal was right.
 *
 * A refused prompt costs no tokens, so the cheapest correct behaviour is to
 * keep asking. Matched to the other account's parked re-sample interval.
 */
export const CLAUDE_RETRY_MS = 5 * 60_000;

/**
 * Whether a line is the account saying it is spent.
 *
 * Deliberately narrower than the engine's `looks_like_quota_error`: that one
 * is a hint to go and re-sample a real endpoint, so a false positive costs a
 * fetch. This one parks a run, so a model that merely *mentions* rate limits
 * must not match.
 */
export function looksLikeClaudeLimit(message: string | null | undefined): boolean {
  if (!message) return false;
  return /hit your (?:session )?limit|usage limit reached|rate[ _-]?limit/i.test(message);
}

/**
 * The reset time a limit message names, as epoch ms, or `null` when it names
 * none that can be placed on a clock.
 *
 * The zone in the message is read but not applied: resolving it would need a
 * tz database the desktop does not carry, and the machine running the desktop
 * is overwhelmingly the machine the account is used from. Being wrong by a
 * zone costs one early retry that is refused again, which is how the runner
 * would learn the right time anyway.
 */
export function claudeResetAt(message: string, now: number): number | null {
  const after = message.toLowerCase().split(/resets?/)[1];
  if (!after) return null;
  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(after);
  if (!match) return null;
  let hour = Number.parseInt(match[1] ?? "", 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  const suffix = match[3];
  // 12am is midnight and 12pm is noon; a naive +12 turns both into 24:00.
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  let until = at.getTime();
  if (until <= now) until += 24 * 60 * 60_000;
  return until;
}

/**
 * A snapshot for the Claude account in the shape `usageVerdict` reads, or
 * `null` when the message is not a limit at all.
 *
 * `usedPercent` is 100 rather than a measurement, because the account has
 * told us the only thing it ever tells us: there is no room. The runner's
 * floor is 98, so 100 parks it; the windows are named `primary` because that
 * is the field the verdict looks at first, and there is no second window to
 * report.
 */
export function claudeUsageFrom(message: string | null | undefined, now: number): UsageSnapshot | null {
  if (!looksLikeClaudeLimit(message) || !message) return null;
  const resetAt = claudeResetAt(message, now);
  return {
    fetchedAtUnixMs: now,
    allowed: false,
    limitReached: true,
    primary: {
      usedPercent: 100,
      // Claude's limits roll on a five-hour session window, the same length
      // as the one the other account reports, which is what the strip's
      // "5-hour" label reads off.
      windowSeconds: 5 * 3600,
      ...(resetAt !== null ? { resetAtUnix: Math.floor(resetAt / 1000) } : {}),
    },
  };
}
