//! A session's team, and which worker a task goes to.
//!
//! The orchestrator is the session itself; the combo is everything it may
//! hand work to. It is plain data the user edits in the picker and can change
//! at any time: the next `delegate` reads whatever the combo says then.
//!
//! Routing is by the orchestrator's choice first (a named worker), then by
//! capability, then by headroom. A worker whose provider has said it is spent
//! is skipped, and among the rest the one whose account is least used wins,
//! so one subscription is not drained while another has room (goal G1 in
//! docs/research/multi-provider-viability.md).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agents::{
    Provider,
    events::{QuotaSnapshot, QuotaStatus},
};

/// Capabilities the picker offers. Free text is accepted too; these are the
/// ones the orchestrator's guidance explains.
pub const KNOWN_CAPABILITIES: [&str; 6] = ["code", "image", "fast", "review", "research", "ui"];

/// One worker the orchestrator may delegate to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSlot {
    /// Unique within the combo; what the orchestrator names it by.
    pub name: String,
    pub provider: Provider,
    /// By the provider's own id; `None` is the account default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// What this worker is for (`code`, `image`, `fast`, …).
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// A line for the orchestrator: when to use this worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl WorkerSlot {
    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|own| own.eq_ignore_ascii_case(capability))
    }

    /// `Codex · gpt-6-luna · low`, for a report or an error.
    pub fn describe(&self) -> String {
        let mut text = self.provider.label().to_string();
        if let Some(model) = &self.model {
            text.push_str(" · ");
            text.push_str(model);
        }
        if let Some(effort) = &self.effort {
            text.push_str(" · ");
            text.push_str(effort);
        }
        text
    }
}

/// The team behind one orchestrator session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Combo {
    #[serde(default)]
    pub workers: Vec<WorkerSlot>,
    /// Whether the orchestrator may also start its own provider's subagents
    /// (Claude's `Agent`/`Task`, Codex's multi-agent). Off by default once
    /// there is a worker, so the combo is the truth about who works. Read
    /// when the session starts: the providers take it at launch only.
    #[serde(default)]
    pub native_subagents: bool,
}

impl Combo {
    /// Names made unique and non-empty, blank capabilities dropped. What the
    /// picker sends is trusted to be close, not exact.
    pub fn normalized(mut self) -> Self {
        let mut seen: HashMap<String, usize> = HashMap::new();
        for (index, worker) in self.workers.iter_mut().enumerate() {
            let mut base = worker.name.trim().to_string();
            if base.is_empty() {
                base = worker.model.clone().unwrap_or_else(|| format!("{}-{}", worker.provider.as_str(), index + 1));
            }
            let count = seen.entry(base.to_ascii_lowercase()).or_insert(0);
            *count += 1;
            worker.name = if *count == 1 { base } else { format!("{base}-{count}") };
            worker.capabilities.retain(|capability| !capability.trim().is_empty());
            for capability in &mut worker.capabilities {
                *capability = capability.trim().to_ascii_lowercase();
            }
        }
        self
    }

    /// Whether the orchestrator's native subagents are withheld: only when
    /// there is someone else to hand work to.
    pub fn withholds_native_subagents(&self) -> bool {
        !self.workers.is_empty() && !self.native_subagents
    }

    pub fn worker(&self, name: &str) -> Option<&WorkerSlot> {
        self.workers.iter().find(|worker| worker.name.eq_ignore_ascii_case(name.trim()))
    }
}

/// The latest quota each provider reported, from any session on it, and the
/// capabilities a provider has a limit of its own on (Codex's image tool has
/// one apart from the account's).
#[derive(Debug, Clone, Default)]
pub struct QuotaBook {
    latest: HashMap<Provider, QuotaSnapshot>,
    blocked: HashMap<(Provider, String), u64>,
}

impl QuotaBook {
    /// Keeps the newer of two reports for a provider.
    pub fn note(&mut self, snapshot: QuotaSnapshot) {
        match self.latest.get(&snapshot.provider) {
            Some(existing) if existing.observed_at_unix_ms > snapshot.observed_at_unix_ms => {}
            _ => {
                self.latest.insert(snapshot.provider, snapshot);
            }
        }
    }

    /// Marks a provider spent now, from a turn that failed as a rate limit
    /// before any quota report said so.
    pub fn note_refusal(&mut self, provider: Provider, now_unix_ms: u64) {
        let windows = self.latest.get(&provider).map(|snapshot| snapshot.windows.clone()).unwrap_or_default();
        self.note(QuotaSnapshot { provider, status: QuotaStatus::Rejected, windows, plan: None, observed_at_unix_ms: now_unix_ms });
    }

    pub fn get(&self, provider: Provider) -> Option<&QuotaSnapshot> {
        self.latest.get(&provider)
    }

    /// Records that a provider cannot do one capability until `until`.
    pub fn block_capability(&mut self, provider: Provider, capability: &str, until_unix_ms: u64) {
        self.blocked.insert((provider, capability.to_ascii_lowercase()), until_unix_ms);
    }

    /// Until when a provider cannot do a capability, if it cannot now.
    pub fn capability_blocked(&self, provider: Provider, capability: &str, now_unix_ms: u64) -> Option<u64> {
        self.blocked.get(&(provider, capability.to_ascii_lowercase())).copied().filter(|until| *until > now_unix_ms)
    }

    /// When the provider is usable again, for a spent one: in milliseconds.
    pub fn available_again_ms(&self, provider: Provider, now_unix_ms: u64) -> Option<u64> {
        if !self.is_spent(provider, now_unix_ms) {
            return None;
        }
        self.latest.get(&provider).and_then(QuotaSnapshot::available_again_at).map(|reset| reset.saturating_mul(1000))
    }

    /// Whether the provider is spent at `now`: it said so, and the reset it
    /// named (if any) has not passed.
    pub fn is_spent(&self, provider: Provider, now_unix_ms: u64) -> bool {
        let Some(snapshot) = self.latest.get(&provider) else { return false };
        if snapshot.status != QuotaStatus::Rejected {
            return false;
        }
        match snapshot.available_again_at() {
            Some(reset) => reset.saturating_mul(1000) > now_unix_ms,
            None => true,
        }
    }

    /// How much of the provider's tightest window is used, 0–100; 0 when it
    /// has not said.
    pub fn pressure(&self, provider: Provider) -> f64 {
        self.latest
            .get(&provider)
            .map(|snapshot| snapshot.windows.iter().filter_map(|window| window.used_percent).fold(0.0, f64::max))
            .unwrap_or(0.0)
    }
}

/// Where a task goes, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub slot: WorkerSlot,
    /// Set when the worker asked for was passed over, with the reason.
    pub rerouted_from: Option<String>,
}

/// Picks the worker for a task.
///
/// - A named worker is used unless its provider is spent; then another
///   worker with one of its capabilities is found instead, and the result
///   says so.
/// - Otherwise the workers with the capability asked for (all of them when
///   none is asked for) are ranked by headroom.
/// - `exclude` names providers to skip, for a retry after a refusal.
pub fn route(combo: &Combo, worker: Option<&str>, capability: Option<&str>, quotas: &QuotaBook, exclude: &[Provider], now_unix_ms: u64) -> Result<Route, String> {
    if combo.workers.is_empty() {
        return Err("This session has no workers. The user adds them in ThingMaker's team panel; until then, do the work yourself.".into());
    }
    let wanted = capability.filter(|capability| !capability.trim().is_empty());
    let usable = |slot: &WorkerSlot| {
        !exclude.contains(&slot.provider)
            && !quotas.is_spent(slot.provider, now_unix_ms)
            && wanted.is_none_or(|capability| quotas.capability_blocked(slot.provider, capability, now_unix_ms).is_none())
    };
    let rank = |candidates: Vec<&WorkerSlot>| -> Option<WorkerSlot> {
        let mut ordered: Vec<(usize, &WorkerSlot)> = candidates.into_iter().enumerate().collect();
        // Stable: equal pressure keeps the user's order.
        ordered.sort_by(|(a_index, a), (b_index, b)| {
            quotas
                .pressure(a.provider)
                .partial_cmp(&quotas.pressure(b.provider))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a_index.cmp(b_index))
        });
        ordered.first().map(|(_, slot)| (*slot).clone())
    };
    let spent_note = |slot: &WorkerSlot| {
        if let Some(capability) = wanted
            && let Some(until) = quotas.capability_blocked(slot.provider, capability, now_unix_ms)
        {
            return format!("{}'s {capability} limit is spent until {}", slot.provider.label(), format_reset(until / 1000));
        }
        let when = quotas
            .get(slot.provider)
            .and_then(QuotaSnapshot::available_again_at)
            .map(|reset| format!(" until {}", format_reset(reset)))
            .unwrap_or_default();
        format!("{} is out of quota{when}", slot.provider.label())
    };

    if let Some(name) = worker.filter(|name| !name.trim().is_empty()) {
        let Some(named) = combo.worker(name) else {
            let names: Vec<&str> = combo.workers.iter().map(|worker| worker.name.as_str()).collect();
            return Err(format!("No worker is called {name:?}. The team is: {}.", names.join(", ")));
        };
        if usable(named) {
            return Ok(Route { slot: named.clone(), rerouted_from: None });
        }
        let reason = if exclude.contains(&named.provider) { format!("{} refused the task", named.provider.label()) } else { spent_note(named) };
        let alternatives: Vec<&WorkerSlot> = combo
            .workers
            .iter()
            .filter(|slot| slot.name != named.name && usable(slot))
            .filter(|slot| named.capabilities.is_empty() || named.capabilities.iter().any(|capability| slot.has(capability)))
            .collect();
        return match rank(alternatives) {
            Some(slot) => Ok(Route { rerouted_from: Some(format!("{} ({reason})", named.name)), slot }),
            None => Err(format!("{} cannot take the task: {reason}, and no other worker has its capabilities.", named.name)),
        };
    }

    let candidates: Vec<&WorkerSlot> = match capability.filter(|capability| !capability.trim().is_empty()) {
        Some(capability) => {
            let fit: Vec<&WorkerSlot> = combo.workers.iter().filter(|slot| slot.has(capability)).collect();
            if fit.is_empty() {
                let names: Vec<String> = combo.workers.iter().map(|worker| format!("{} [{}]", worker.name, worker.capabilities.join(", "))).collect();
                return Err(format!("No worker has the capability {capability:?}. The team is: {}.", names.join("; ")));
            }
            fit
        }
        None => combo.workers.iter().collect(),
    };
    let open: Vec<&WorkerSlot> = candidates.iter().copied().filter(|slot| usable(slot)).collect();
    match rank(open) {
        Some(slot) => Ok(Route { slot, rerouted_from: None }),
        None => {
            let reasons: Vec<String> = candidates.iter().map(|slot| format!("{}: {}", slot.name, spent_note(slot))).collect();
            Err(format!("Every worker that fits is unavailable ({}). Do the task yourself or wait for a reset.", reasons.join("; ")))
        }
    }
}

/// A reset time as the orchestrator reads it: UTC, to the minute.
pub fn format_reset(unix_seconds: u64) -> String {
    let days = unix_seconds / 86_400;
    let seconds = unix_seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", seconds / 3600, (seconds % 3600) / 60)
}

/// Howard Hinnant's days-to-civil.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::events::QuotaWindow;

    fn slot(name: &str, provider: Provider, capabilities: &[&str]) -> WorkerSlot {
        WorkerSlot {
            name: name.into(),
            provider,
            model: None,
            effort: None,
            capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
            note: None,
        }
    }

    fn quota(provider: Provider, status: QuotaStatus, used: f64, resets_at: u64) -> QuotaSnapshot {
        QuotaSnapshot {
            provider,
            status,
            windows: vec![QuotaWindow { kind: "primary".into(), used_percent: Some(used), window_minutes: Some(300), resets_at: Some(resets_at) }],
            plan: None,
            observed_at_unix_ms: 1,
        }
    }

    fn team() -> Combo {
        Combo {
            workers: vec![slot("sonnet", Provider::Claude, &["code", "review"]), slot("luna", Provider::Codex, &["image", "fast", "code"])],
            native_subagents: false,
        }
    }

    #[test]
    fn a_named_worker_is_used_and_a_capability_finds_its_workers() {
        let quotas = QuotaBook::default();
        assert_eq!(route(&team(), Some("LUNA"), None, &quotas, &[], 0).unwrap().slot.name, "luna");
        assert_eq!(route(&team(), None, Some("image"), &quotas, &[], 0).unwrap().slot.name, "luna");
        assert_eq!(route(&team(), None, Some("review"), &quotas, &[], 0).unwrap().slot.name, "sonnet");
        let unknown = route(&team(), Some("gemini"), None, &quotas, &[], 0).unwrap_err();
        assert!(unknown.contains("sonnet, luna"), "{unknown}");
        assert!(route(&team(), None, Some("audio"), &quotas, &[], 0).unwrap_err().contains("luna [image, fast, code]"));
        assert!(route(&Combo::default(), None, None, &quotas, &[], 0).unwrap_err().contains("no workers"));
    }

    #[test]
    fn the_least_used_account_takes_the_work_and_a_spent_one_is_passed_over() {
        let mut quotas = QuotaBook::default();
        quotas.note(quota(Provider::Claude, QuotaStatus::Allowed, 80.0, 10_000));
        quotas.note(quota(Provider::Codex, QuotaStatus::Allowed, 10.0, 10_000));
        assert_eq!(route(&team(), None, Some("code"), &quotas, &[], 0).unwrap().slot.name, "luna", "spread: Codex has more room");

        quotas.note(QuotaSnapshot { observed_at_unix_ms: 2, ..quota(Provider::Codex, QuotaStatus::Rejected, 100.0, 10_000) });
        let rerouted = route(&team(), Some("luna"), None, &quotas, &[], 5_000_000).unwrap();
        assert_eq!(rerouted.slot.name, "sonnet");
        assert!(rerouted.rerouted_from.unwrap().contains("Codex is out of quota until 1970-01-01 02:46 UTC"));
        // Nobody else can make images.
        let error = route(&team(), None, Some("image"), &quotas, &[], 5_000_000).unwrap_err();
        assert!(error.contains("luna: Codex is out of quota"), "{error}");
        // Once the window has reset, Codex is back.
        assert_eq!(route(&team(), None, Some("image"), &quotas, &[], 10_000_001).unwrap().slot.name, "luna");
        // A refusal the stream reported excludes the provider for the retry.
        let retry = route(&team(), None, Some("code"), &QuotaBook::default(), &[Provider::Claude], 0).unwrap();
        assert_eq!(retry.slot.name, "luna");
    }

    #[test]
    fn a_capability_with_its_own_limit_is_routed_around_until_it_lifts() {
        let mut quotas = QuotaBook::default();
        quotas.block_capability(Provider::Codex, "Image", 10_000);
        let error = route(&team(), None, Some("image"), &quotas, &[], 5_000).unwrap_err();
        assert!(error.contains("Codex's image limit is spent until"), "{error}");
        // Codex still takes code; only images are limited.
        assert_eq!(route(&team(), Some("luna"), None, &quotas, &[], 5_000).unwrap().slot.name, "luna");
        assert_eq!(quotas.capability_blocked(Provider::Codex, "image", 5_000), Some(10_000));
        assert_eq!(route(&team(), None, Some("image"), &quotas, &[], 10_001).unwrap().slot.name, "luna", "lifted");
    }

    #[test]
    fn a_combo_is_tidied_before_it_is_kept() {
        let combo = Combo {
            workers: vec![
                WorkerSlot { model: Some("gpt-6-luna".into()), ..slot(" ", Provider::Codex, &[" Image ", ""]) },
                slot("luna", Provider::Codex, &[]),
                slot("coder", Provider::Claude, &[]),
            ],
            native_subagents: false,
        }
        .normalized();
        let names: Vec<&str> = combo.workers.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, ["gpt-6-luna", "luna", "coder"]);
        assert_eq!(combo.workers[0].capabilities, ["image"]);
        let doubled = Combo { workers: vec![slot("a", Provider::Codex, &[]), slot("A", Provider::Claude, &[])], native_subagents: true }.normalized();
        assert_eq!(doubled.workers[1].name, "A-2");
        assert!(!doubled.withholds_native_subagents());
        assert!(combo.withholds_native_subagents());
        assert!(!Combo::default().withholds_native_subagents(), "nobody to delegate to: native subagents stay");
        assert_eq!(format_reset(1_790_785_099), "2026-09-30 16:18 UTC");
    }
}
