//! Smarter use of the accounts: measured turn costs, and the forecast that
//! reads them.
//!
//! Every answered turn is charged in percent of the account's 5-hour window:
//! the reading just before the prompt went out against the reading after it
//! settled, inside one window. From those the engine predicts what the next
//! turn and the next milestone will cost, and acts before a turn that would
//! not fit instead of after it is refused:
//!
//! - a turn that would not fit moves the run to an account that has room (a
//!   goal set to either orchestrator), or holds it until the window resets;
//! - a milestone too big for what is left of a window that resets soon waits
//!   for the reset rather than starting half-way;
//! - under the spread policy a run moves, at a milestone boundary, to the
//!   account with clearly more room.

use serde::{Deserialize, Serialize};

use super::{
    clock,
    decide::FAILOVER_COOLDOWN_MS,
    engine::{Engine, GoalState, Loaded, MoveTarget, PendingTurn, goal_scope},
    host::LiveSession,
    journal,
    usage::{USAGE_FLOOR_PERCENT, UsageSnapshot},
};
use crate::agents::Provider;
use crate::storage::odyssey::{AccountPolicy, JournalKind, Orchestrator};

const COSTS_KEY: &str = "superthingTurnCosts";
/// Measured turns kept per goal.
const MAX_COSTS: usize = 40;
/// Measured turns before the forecast has an opinion.
pub const MIN_COSTS: usize = 3;
/// A milestone waits for a reset only when the reset is this close.
pub const HEAVY_WAIT_MAX_MS: i64 = 45 * 60_000;
/// Points of headroom another account needs over this one for `spread` to move.
pub const SPREAD_MARGIN: f64 = 25.0;
/// How old a reading may be and still count as "just before".
const FRESH_READING_MS: i64 = 60_000;

/// One answered turn's measured cost.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCost {
    pub at: i64,
    pub provider: Provider,
    /// Index of the milestone the turn worked; none for a briefing.
    #[serde(default)]
    pub milestone: Option<usize>,
    /// Percentage points of the 5-hour window it moved.
    pub percent: f64,
}

/// What the forecast says about the next turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Forecast {
    /// Nothing to say, or it fits.
    Fits,
    /// The next turn would not fit in what is left.
    TurnTooBig { need: f64, left: f64 },
    /// The milestone about to start would not fit, and the window resets soon.
    MilestoneWaits { need: f64, left: f64, reset_at: i64 },
}

/// A high percentile of what turns on this provider have cost.
pub fn turn_estimate(costs: &[TurnCost], provider: Provider) -> Option<f64> {
    let mut values: Vec<f64> = costs.iter().filter(|cost| cost.provider == provider).map(|cost| cost.percent).collect();
    if values.len() < MIN_COSTS {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let index = ((values.len() as f64 - 1.0) * 0.75).round() as usize;
    Some(values[index.min(values.len() - 1)])
}

/// What a whole milestone has cost on average, from the milestones the
/// measured turns worked.
pub fn milestone_estimate(costs: &[TurnCost], provider: Provider) -> Option<f64> {
    let mut by_milestone: std::collections::BTreeMap<usize, f64> = std::collections::BTreeMap::new();
    for cost in costs.iter().filter(|cost| cost.provider == provider) {
        if let Some(milestone) = cost.milestone {
            *by_milestone.entry(milestone).or_default() += cost.percent;
        }
    }
    // The milestone in flight is not finished, so it does not count.
    let last = by_milestone.keys().next_back().copied();
    let done: Vec<f64> = by_milestone.iter().filter(|(milestone, _)| Some(**milestone) != last).map(|(_, total)| *total).collect();
    if done.len() < 2 {
        return None;
    }
    Some(done.iter().sum::<f64>() / done.len() as f64)
}

/// The forecast for the next continuation.
pub fn forecast(costs: &[TurnCost], provider: Provider, usage: Option<&UsageSnapshot>, starting_milestone: bool, now: i64) -> Forecast {
    let Some(window) = usage.and_then(|usage| usage.primary.as_ref()) else { return Forecast::Fits };
    let left = (USAGE_FLOOR_PERCENT - window.used_percent).max(0.0);
    if let Some(need) = turn_estimate(costs, provider)
        && need > left
    {
        return Forecast::TurnTooBig { need, left };
    }
    if starting_milestone
        && let (Some(need), Some(reset)) = (milestone_estimate(costs, provider), window.reset_at_unix)
    {
        let reset_at = reset as i64 * 1000;
        if need > left && reset_at > now && reset_at - now <= HEAVY_WAIT_MAX_MS {
            return Forecast::MilestoneWaits { need, left, reset_at };
        }
    }
    Forecast::Fits
}

fn headroom(usage: Option<&UsageSnapshot>) -> Option<f64> {
    usage.and_then(|usage| usage.primary.as_ref()).map(|window| (USAGE_FLOOR_PERCENT - window.used_percent).max(0.0))
}

fn points(value: f64) -> String {
    format!("{}%", value.round() as i64)
}

impl Engine {
    pub(crate) fn turn_costs(&self, goal_id: &str) -> Vec<TurnCost> {
        self.db(|storage| storage.setting_get::<Vec<TurnCost>>(COSTS_KEY, &goal_scope(goal_id))).ok().flatten().unwrap_or_default()
    }

    /// The 5-hour reading, taken fresh when the one in the book is old.
    pub(crate) async fn window_reading(&self, provider: Provider) -> Option<(f64, Option<u64>)> {
        let now = clock::now_ms();
        let stale = self.usage_for(provider).is_none_or(|usage| now - usage.fetched_at_unix_ms > FRESH_READING_MS);
        let usage = if stale { self.refresh_usage(provider).await } else { self.usage_for(provider) };
        usage.and_then(|usage| usage.primary).map(|window| (window.used_percent, window.reset_at_unix))
    }

    /// Charges a settled turn in percent of the window it ran in.
    pub(crate) async fn measure_turn(&self, goal_id: &str, pending: &PendingTurn) {
        let Some((before, reset_before)) = pending.window_at_submit else { return };
        let Some((after, reset_after)) = self.window_reading(pending.provider).await else { return };
        // A different reset means the window rolled over under the turn.
        if reset_before != reset_after || after < before {
            return;
        }
        let mut costs = self.turn_costs(goal_id);
        costs.push(TurnCost { at: clock::now_ms(), provider: pending.provider, milestone: pending.milestone, percent: after - before });
        let start = costs.len().saturating_sub(MAX_COSTS);
        let _ = self.db(|storage| storage.setting_set(COSTS_KEY, &goal_scope(goal_id), &costs[start..].to_vec()));
    }

    /// Before a continuation: move or hold when the forecast says the turn
    /// would not fit, and spread across accounts at a milestone boundary.
    /// Returns whether it acted instead of the prompt.
    pub(crate) async fn forecast_guard(&self, state: &mut GoalState, loaded: &Loaded, live: &LiveSession, index: usize, now: i64) -> bool {
        let goal = &loaded.goal;
        let costs = self.turn_costs(&goal.id);
        let usage = self.usage_for(live.provider);
        let last_milestone = loaded.journal.iter().find(|entry| entry.kind == JournalKind::Continuation).and_then(|entry| entry.milestone_id.clone());
        let starting = last_milestone.as_deref() != Some(loaded.milestones[index].id.as_str());
        let may_move = goal.orchestrator == Orchestrator::Either && journal::last_move_at(&loaded.journal).is_none_or(|at| now - at >= FAILOVER_COOLDOWN_MS);
        let others: Vec<Provider> = self.inner.host.usable_providers().into_iter().filter(|provider| *provider != live.provider && provider.can_orchestrate()).collect();

        let verdict = forecast(&costs, live.provider, usage.as_ref(), starting, now);
        let note = match &verdict {
            Forecast::Fits => None,
            Forecast::TurnTooBig { need, left } => Some(format!("the next turn needs about {} of the 5-hour window and {} is left", points(*need), points(*left))),
            Forecast::MilestoneWaits { need, left, .. } => Some(format!("milestone {} needs about {} and {} is left", index + 1, points(*need), points(*left))),
        };
        self.patch_runtime(&goal.id, |runtime| runtime.forecast = note.clone());

        if let Some(reason) = note {
            if may_move {
                for other in &others {
                    let room = headroom(self.usage_for(*other).as_ref());
                    let need = match verdict {
                        Forecast::TurnTooBig { need, .. } | Forecast::MilestoneWaits { need, .. } => need,
                        Forecast::Fits => 0.0,
                    };
                    if room.is_some_and(|room| room >= need) {
                        let summary = format!("Moving to {} before the turn: {reason}", other.label());
                        self.announce(goal, &summary);
                        if self.perform_move(state, &goal.id, MoveTarget::New { provider: *other }, Some(summary)).await.is_ok() {
                            return true;
                        }
                    }
                }
            }
            let reset_at = usage.as_ref().and_then(|usage| usage.primary.as_ref()).and_then(|window| window.reset_at_unix).map(|at| at as i64 * 1000);
            if let Some(reset_at) = reset_at.filter(|at| *at > now) {
                self.park(goal, &format!("{reason}, so it waits for the reset"), Some(reset_at), Some("Held by the spend forecast before a turn that would not fit."));
                return true;
            }
        }

        // Spread: at a milestone boundary, the account with clearly more room.
        if starting && may_move && goal.account_policy == AccountPolicy::Spread {
            let here = headroom(usage.as_ref()).unwrap_or(USAGE_FLOOR_PERCENT);
            let best = others.iter().filter_map(|other| headroom(self.usage_for(*other).as_ref()).map(|room| (*other, room))).max_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((other, room)) = best
                && room >= here + SPREAD_MARGIN
            {
                let summary = format!("Moving to {} at milestone {}: it has {} of its window left and {} has {}", other.label(), index + 1, points(room), live.provider.label(), points(here));
                self.announce(goal, &summary);
                if self.perform_move(state, &goal.id, MoveTarget::New { provider: other }, Some(summary)).await.is_ok() {
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::superthing::usage::tests::{usage, window};

    fn cost(milestone: usize, percent: f64) -> TurnCost {
        TurnCost { at: 0, provider: Provider::Codex, milestone: Some(milestone), percent }
    }

    #[test]
    fn a_turn_that_would_not_fit_is_seen_before_it_is_sent() {
        let costs = vec![cost(0, 4.0), cost(0, 5.0), cost(1, 6.0), cost(1, 30.0)];
        assert_eq!(turn_estimate(&costs, Provider::Codex), Some(6.0));
        assert_eq!(turn_estimate(&costs[..2], Provider::Codex), None, "too few turns to say");
        assert_eq!(turn_estimate(&costs, Provider::Claude), None, "another account's turns say nothing");
        let tight = usage(Some(window(94.0, Some(10))), None);
        assert!(matches!(forecast(&costs, Provider::Codex, Some(&tight), false, 0), Forecast::TurnTooBig { need, left } if need == 6.0 && left == 4.0));
        let roomy = usage(Some(window(50.0, Some(10))), None);
        assert_eq!(forecast(&costs, Provider::Codex, Some(&roomy), false, 0), Forecast::Fits);
        assert_eq!(forecast(&costs, Provider::Codex, None, false, 0), Forecast::Fits, "no reading, no opinion");
    }

    #[test]
    fn a_heavy_milestone_waits_for_a_reset_that_is_close() {
        // Milestones 0 and 1 cost 20 points each; 2 is in flight.
        let costs = vec![cost(0, 10.0), cost(0, 10.0), cost(1, 10.0), cost(1, 10.0), cost(2, 1.0)];
        assert_eq!(milestone_estimate(&costs, Provider::Codex), Some(20.0));
        let now = 1_000_000;
        let soon = (now + 20 * 60_000) / 1000;
        let near = usage(Some(window(85.0, Some(soon as u64))), None);
        assert!(matches!(forecast(&costs, Provider::Codex, Some(&near), true, now), Forecast::MilestoneWaits { .. }));
        assert_eq!(forecast(&costs, Provider::Codex, Some(&near), false, now), Forecast::Fits, "only when a milestone starts");
        let far = usage(Some(window(85.0, Some(((now + 3 * 3_600_000) / 1000) as u64))), None);
        assert_eq!(forecast(&costs, Provider::Codex, Some(&far), true, now), Forecast::Fits, "a reset hours away is not worth waiting for");
    }
}
