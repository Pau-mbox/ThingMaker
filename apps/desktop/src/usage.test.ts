import { describe, expect, it } from "vitest";
import type { UsageTotals } from "@thingmaker/contracts";
import { windowDelta } from "./store";
import { cacheEfficiency, percent } from "./usage";

/** The three-response fixture from the supervisor's own unit test: a cold
 *  first call, a near-perfect hit, then a call that cached nothing. */
const totals: UsageTotals = {
  calls: 3,
  inputTokens: 21_000,
  outputTokens: 300,
  reasoningTokens: 0,
  cachedInputTokens: 4_992,
  cacheWriteInputTokens: 0,
  foldedItems: 0,
  paidInputTokens: 16_008,
  cacheablePrefixTokens: 11_904,
  missedPrefixTokens: 6_912,
  cachePartial: false,
  partial: false,
};

describe("prompt cache efficiency", () => {
  it("reports the missed share of the re-sent prefix and of paid input", () => {
    const efficiency = cacheEfficiency(totals);
    expect(efficiency).toEqual({
      paidInputTokens: 16_008,
      cacheablePrefixTokens: 11_904,
      missedPrefixTokens: 6_912,
      missedShare: 6_912 / 11_904,
      missedShareOfPaid: 6_912 / 16_008,
      estimate: false,
    });
    expect(percent(efficiency!.missedShare)).toBe("58.1%");
  });

  it("is not measurable until a prefix has been re-sent", () => {
    expect(cacheEfficiency({ ...totals, cacheablePrefixTokens: 0 })).toBeNull();
    expect(cacheEfficiency(undefined)).toBeNull();
  });

  it("marks the readout as an estimate when a call reported no cached figure", () => {
    expect(cacheEfficiency({ ...totals, cachePartial: true })?.estimate).toBe(true);
  });

  it("shows an unknown share as unknown rather than zero", () => {
    expect(cacheEfficiency({ ...totals, paidInputTokens: 0 })?.missedShareOfPaid).toBeNull();
    expect(percent(null)).toBe("unknown");
  });
});

describe("subscription usage deltas", () => {
  it("differences two samples of the same window", () => {
    const delta = windowDelta({ usedPercent: 69, windowSeconds: 18000, resetAtUnix: 100 }, { usedPercent: 72, windowSeconds: 18000, resetAtUnix: 100 });
    expect(delta).toEqual({ before: 69, after: 72, delta: 3, reset: false });
  });

  it("marks a window reset instead of producing a negative or guessed delta", () => {
    const delta = windowDelta({ usedPercent: 98, windowSeconds: 18000, resetAtUnix: 100 }, { usedPercent: 2, windowSeconds: 18000, resetAtUnix: 118100 });
    expect(delta).toEqual({ before: 98, after: 2, delta: null, reset: true });
  });

  it("returns null when either sample lacks the window", () => {
    expect(windowDelta(undefined, { usedPercent: 1, windowSeconds: 1 })).toBeNull();
  });
});
