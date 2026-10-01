/**
 * Prompt-cache readout derived from Kit's own reported counters (CTX-03).
 *
 * Every figure here comes from the transcript the runtime wrote: nothing is
 * estimated from message text, and a call that reported no cached figure marks
 * the result as an estimate rather than being counted as a miss.
 */
import type { UsageTotals } from "@thingmaker/contracts";

export type CacheEfficiency = {
  /** Input tokens the provider did not serve from cache. */
  paidInputTokens: number;
  /** Prefix re-sent after an earlier call already sent it. */
  cacheablePrefixTokens: number;
  /** Cacheable prefix the provider did not serve from cache. */
  missedPrefixTokens: number;
  /** Missed share of the re-sent prefix, 0..1. */
  missedShare: number;
  /** Missed share of what was actually paid for, 0..1, or null when nothing was paid. */
  missedShareOfPaid: number | null;
  /** A call reported no cached figure, so these are estimates. */
  estimate: boolean;
};

/**
 * Returns null until a session has re-sent a prefix at least once — before
 * that there is nothing a cache could have served, and a 0% readout would
 * read as a failure rather than as "not measurable yet".
 */
export function cacheEfficiency(totals: UsageTotals | undefined): CacheEfficiency | null {
  if (!totals || totals.cacheablePrefixTokens <= 0) return null;
  return {
    paidInputTokens: totals.paidInputTokens,
    cacheablePrefixTokens: totals.cacheablePrefixTokens,
    missedPrefixTokens: totals.missedPrefixTokens,
    missedShare: totals.missedPrefixTokens / totals.cacheablePrefixTokens,
    missedShareOfPaid: totals.paidInputTokens > 0 ? totals.missedPrefixTokens / totals.paidInputTokens : null,
    estimate: totals.cachePartial,
  };
}

export function percent(share: number | null): string {
  return share === null ? "unknown" : `${(share * 100).toFixed(1)}%`;
}
