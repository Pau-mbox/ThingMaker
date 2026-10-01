import { describe, expect, it } from "vitest";
import { claudeResetAt, claudeUsageFrom, looksLikeClaudeLimit } from "./odysseyClaudeQuota";
import { usageVerdict } from "./odysseyRunner";

/**
 * The message in these tests is verbatim from adapter 0.76.0, prompting a
 * spent Pro subscription. It is the whole of what that account ever reports
 * about itself, so the parser is the quota signal.
 */
const REAL = "Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)";

describe("what a spent Claude account says", () => {
  it("recognises the real refusal and not a model talking about limits", () => {
    expect(looksLikeClaudeLimit(REAL)).toBe(true);
    expect(looksLikeClaudeLimit("usage limit reached")).toBe(true);
    // This one parks a run, so a false positive is expensive. A model
    // *discussing* rate limiting must not stop the goal.
    expect(looksLikeClaudeLimit("I added a retry for when the API is busy")).toBe(false);
    expect(looksLikeClaudeLimit("")).toBe(false);
    expect(looksLikeClaudeLimit(null)).toBe(false);
  });

  it("places the reset on the next time that clock comes round", () => {
    const now = new Date("2026-09-17T20:00:00").getTime();
    const at = claudeResetAt(REAL, now);
    expect(at).not.toBeNull();
    expect(at).toBeGreaterThan(now);
    expect(at! - now).toBeLessThanOrEqual(24 * 60 * 60_000);
    expect(new Date(at!).getHours()).toBe(0);
    expect(new Date(at!).getMinutes()).toBe(20);

    // 12am is midnight and 12pm is noon; a naive +12 makes both 24:00.
    const noon = claudeResetAt("resets 12:00pm", now)!;
    expect(new Date(noon).getHours()).toBe(12);

    // A message that names no clock is not a failure: the runner parks on an
    // unknown reset and re-samples rather than inventing a time.
    expect(claudeResetAt("You've hit your limit", now)).toBeNull();
    expect(claudeResetAt("resets 99:99", now)).toBeNull();
  });

  it("produces a snapshot the runner's existing guard parks on", () => {
    const now = Date.now();
    const snapshot = claudeUsageFrom(REAL, now)!;
    // 100% rather than a measurement: the account has told us the only thing
    // it ever tells us, which is that there is no room.
    expect(snapshot.primary?.usedPercent).toBe(100);
    expect(snapshot.limitReached).toBe(true);
    const verdict = usageVerdict(snapshot);
    expect(verdict.kind).toBe("exhausted");
    expect(verdict.kind === "exhausted" && verdict.resumeAt).toBeGreaterThan(now);

    // Nothing said the account is spent, so nothing parks: absence of data is
    // not evidence of exhaustion.
    expect(claudeUsageFrom("something else went wrong", now)).toBeNull();
    expect(usageVerdict(null).kind).toBe("ok");
  });
});
