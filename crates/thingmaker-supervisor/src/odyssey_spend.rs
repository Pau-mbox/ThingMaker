//! What a subscription window charges, learned from the run's own samples
//! (docs/research/odyssey-review.md §4.1).
//!
//! The one fact every spend decision hinges on is whether the provider's
//! rolling window counts cached input. Nothing published says. The evidence
//! is in the run: the desktop samples the window every minute while a goal
//! works, and the agent's transcript records paid, cached and output tokens per
//! call. Differencing consecutive samples inside one window gives pairs of
//! (tokens spent, percent consumed); fitting a line through the origin under
//! each hypothesis and comparing the residuals says which one the meter
//! agrees with.
//!
//! This is a measurement, not a verdict about the provider: the account's
//! other sessions and subagents spend from the same window and are not in
//! these counters, and the window rolls so old usage ages out mid-sample.
//! Pairs where the percentage fell are dropped for that reason; the rest
//! carry that noise and the fit says how much.

use serde::{Deserialize, Serialize};

use crate::storage::odyssey::UsageSample;

/// Fewest usable pairs before the fit is worth reading.
pub const MIN_PAIRS: usize = 5;

/// How much better the best hypothesis has to fit than the runner-up before
/// the model commits to it. Residual ratio, so 0.8 means a fifth better.
const DECISIVE_RATIO: f64 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendVerdict {
    /// Cached input is charged like paid input: context size is the bill.
    CachedCounts,
    /// Cached input is free: paid input and output are the bill.
    CachedFree,
    /// Only output moves the meter.
    OutputOnly,
    /// Enough pairs, but no hypothesis fits clearly better than the others.
    Inconclusive,
    /// Fewer than [`MIN_PAIRS`] usable pairs so far.
    Insufficient,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hypothesis {
    pub verdict: SpendVerdict,
    /// What the hypothesis counts as spend.
    pub counts: String,
    /// Tokens (as counted by this hypothesis) that move the window by one
    /// percent. `None` when the fit found no slope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_per_percent: Option<f64>,
    /// Root-mean-square residual in percentage points.
    pub rmse: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendModel {
    pub samples: usize,
    /// Consecutive samples inside one window where the meter rose or held.
    pub pairs: usize,
    pub hypotheses: Vec<Hypothesis>,
    pub verdict: SpendVerdict,
    /// One sentence for the screen.
    pub note: String,
}

struct Pair {
    percent: f64,
    paid: f64,
    cached: f64,
    output: f64,
}

fn pairs_of(samples: &[UsageSample]) -> Vec<Pair> {
    let mut ordered = samples.to_vec();
    ordered.sort_by_key(|sample| (sample.at, sample.id));
    let mut pairs = Vec::new();
    for window in ordered.windows(2) {
        let (before, after) = (&window[0], &window[1]);
        let (Some(from), Some(to)) = (before.primary_used_percent, after.primary_used_percent) else { continue };
        // A different reset time means the window rolled over between the
        // two readings, so the difference measures nothing.
        if before.primary_reset_at != after.primary_reset_at {
            continue;
        }
        if to < from {
            continue;
        }
        let paid = (after.paid_input_tokens - before.paid_input_tokens).max(0) as f64;
        let cached = (after.cached_input_tokens - before.cached_input_tokens).max(0) as f64;
        let output = (after.output_tokens - before.output_tokens).max(0) as f64;
        if paid + cached + output <= 0.0 {
            continue;
        }
        pairs.push(Pair { percent: (to - from) as f64, paid, cached, output });
    }
    pairs
}

fn fit_one(pairs: &[Pair], verdict: SpendVerdict, counts: &str, x_of: impl Fn(&Pair) -> f64) -> Hypothesis {
    let (mut xy, mut xx) = (0.0, 0.0);
    for pair in pairs {
        let x = x_of(pair);
        xy += x * pair.percent;
        xx += x * x;
    }
    let slope = if xx > 0.0 { xy / xx } else { 0.0 };
    let residual = pairs.iter().map(|pair| (pair.percent - slope * x_of(pair)).powi(2)).sum::<f64>();
    let rmse = if pairs.is_empty() { 0.0 } else { (residual / pairs.len() as f64).sqrt() };
    Hypothesis { verdict, counts: counts.to_string(), tokens_per_percent: (slope > 0.0).then(|| 1.0 / slope), rmse }
}

fn thousands(value: f64) -> String {
    if value >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.0}K", value / 1_000.0)
    } else {
        format!("{value:.0}")
    }
}

/// Fits the three hypotheses to the run's samples and says which one the
/// provider's meter agrees with, if any.
pub fn fit(samples: &[UsageSample]) -> SpendModel {
    let pairs = pairs_of(samples);
    let hypotheses = vec![
        fit_one(&pairs, SpendVerdict::CachedCounts, "paid input + cached input + output", |pair| pair.paid + pair.cached + pair.output),
        fit_one(&pairs, SpendVerdict::CachedFree, "paid input + output", |pair| pair.paid + pair.output),
        fit_one(&pairs, SpendVerdict::OutputOnly, "output only", |pair| pair.output),
    ];

    if pairs.len() < MIN_PAIRS {
        return SpendModel {
            samples: samples.len(),
            pairs: pairs.len(),
            hypotheses,
            verdict: SpendVerdict::Insufficient,
            note: format!("{} usable pair{} so far; {MIN_PAIRS} are needed before the fit means anything.", pairs.len(), if pairs.len() == 1 { "" } else { "s" }),
        };
    }

    let mut ranked = hypotheses.iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| a.rmse.partial_cmp(&b.rmse).unwrap_or(std::cmp::Ordering::Equal));
    let (best, second) = (ranked[0], ranked[1]);
    let decisive = second.rmse > 0.0 && best.rmse <= second.rmse * DECISIVE_RATIO;
    let verdict = if decisive { best.verdict } else { SpendVerdict::Inconclusive };
    let rate = best.tokens_per_percent.map(|tokens| format!("1% of the window ≈ {} tokens counted as {}.", thousands(tokens), best.counts));
    let note = match verdict {
        SpendVerdict::CachedCounts => format!("Cached input appears to count: the meter tracks context size. {}", rate.unwrap_or_default()),
        SpendVerdict::CachedFree => format!("Cached input appears to be free: the meter tracks paid input and output. {}", rate.unwrap_or_default()),
        SpendVerdict::OutputOnly => format!("Only output appears to move the meter. {}", rate.unwrap_or_default()),
        _ => format!("{} pairs, but no hypothesis fits clearly better than the others yet.", pairs.len()),
    };
    SpendModel { samples: samples.len(), pairs: pairs.len(), hypotheses, verdict, note: note.trim().to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Samples whose meter follows `percent_of(paid, cached, output)`.
    fn series(percent_of: impl Fn(f64, f64, f64) -> f64, steps: usize) -> Vec<UsageSample> {
        let mut samples = Vec::new();
        let (mut paid, mut cached, mut output) = (0.0, 0.0, 0.0);
        for index in 0..steps {
            // Uneven steps, so the three hypotheses are distinguishable:
            // cached grows fastest, output slowest.
            paid += 3_000.0 + (index % 3) as f64 * 1_000.0;
            cached += 40_000.0 + (index % 2) as f64 * 30_000.0;
            output += 800.0 + (index % 4) as f64 * 100.0;
            samples.push(UsageSample {
                id: index as i64,
                odyssey_id: "o1".into(),
                at: 60_000 * index as i64,
                primary_used_percent: Some(percent_of(paid, cached, output).round() as i64),
                primary_reset_at: Some(1_700_000_000),
                secondary_used_percent: Some(10),
                secondary_reset_at: Some(1_700_500_000),
                calls: index as i64,
                paid_input_tokens: paid as i64,
                cached_input_tokens: cached as i64,
                output_tokens: output as i64,
                reasoning_tokens: 0,
            });
        }
        samples
    }

    #[test]
    fn a_meter_that_tracks_the_whole_context_says_cached_input_counts() {
        let model = fit(&series(|paid, cached, output| (paid + cached + output) / 8_000.0, 12));
        assert_eq!(model.verdict, SpendVerdict::CachedCounts, "{}", model.note);
        assert_eq!(model.pairs, 11);
        let best = model.hypotheses.iter().find(|h| h.verdict == SpendVerdict::CachedCounts).unwrap();
        let tokens = best.tokens_per_percent.unwrap();
        assert!((7_000.0..9_000.0).contains(&tokens), "≈8,000 tokens per percent, got {tokens}");
        assert!(model.note.contains("Cached input appears to count"));
    }

    #[test]
    fn a_meter_that_ignores_cached_input_says_so() {
        let model = fit(&series(|paid, _cached, output| (paid + output) / 500.0, 12));
        assert_eq!(model.verdict, SpendVerdict::CachedFree, "{}", model.note);
        assert!(model.note.contains("Cached input appears to be free"));
    }

    #[test]
    fn too_few_pairs_is_said_rather_than_guessed() {
        let model = fit(&series(|paid, cached, output| (paid + cached + output) / 8_000.0, 4));
        assert_eq!(model.verdict, SpendVerdict::Insufficient);
        assert_eq!(model.pairs, 3);
        assert!(model.note.contains("3 usable pairs"));
    }

    #[test]
    fn a_window_that_rolled_over_between_two_samples_is_not_a_pair() {
        let mut samples = series(|paid, cached, output| (paid + cached + output) / 8_000.0, 8);
        // The meter drops to 2% with a new reset time: a rollover, not a refund.
        samples[4].primary_reset_at = Some(1_700_018_000);
        samples[4].primary_used_percent = Some(2);
        for sample in &mut samples[5..] {
            sample.primary_reset_at = Some(1_700_018_000);
            sample.primary_used_percent = Some(sample.primary_used_percent.unwrap() - 40);
        }
        let model = fit(&samples);
        // Seven consecutive pairs, minus the one across the rollover.
        assert_eq!(model.pairs, 6);
    }

    #[test]
    fn a_flat_meter_over_real_spend_is_inconclusive_not_a_verdict() {
        let mut samples = series(|_, _, _| 0.0, 8);
        for sample in &mut samples {
            sample.primary_used_percent = Some(42);
        }
        let model = fit(&samples);
        assert_eq!(model.verdict, SpendVerdict::Inconclusive, "{}", model.note);
    }
}
