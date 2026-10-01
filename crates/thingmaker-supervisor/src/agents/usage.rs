//! Token usage for one session, in one convention whichever agent ran it
//! (CTX-03).
//!
//! Each provider's transcript reader (`claude::transcript_usage`, and Codex's
//! `thread/tokenUsage/updated` totals) reduces what it finds to these types,
//! so the budget a goal is charged against, the answered-turn check and the
//! Context tab never learn which agent ran.
//!
//! The convention: `input_tokens` *includes* cached reads and cache writes,
//! and the cached figure is shown as a subset, never added again.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCall {
    pub generation: u64,
    pub item_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Ids of the further transcript items that carried this same response's
    /// usage. Empty when the response emitted a single item.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folded_item_ids: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// The provider's own cost field when present; `None` means not reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
    /// Prefix this call re-sent that the provider could have served from its
    /// cache but did not. `None` for the first call of a session (nothing had
    /// been sent yet) and whenever the provider reported no cached figure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missed_prefix_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    /// Model responses, not transcript items: see the module comment.
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    /// Transcript items folded into an earlier call because they repeated its
    /// usage object. Counting them separately is the 1.79x over-report.
    pub folded_items: u64,
    /// Input the provider did not serve from its prompt cache. This is the
    /// part of a session that is actually paid for at full rate.
    pub paid_input_tokens: u64,
    /// Prefix already sent on an earlier call and sent again, measured as
    /// `min(previous input, this input)` rounded down to a whole cache block.
    /// The ceiling on what caching could have saved.
    pub cacheable_prefix_tokens: u64,
    /// Cacheable prefix the provider did not serve from cache.
    pub missed_prefix_tokens: u64,
    /// True when a call reported no cached figure, so the three fields above
    /// are estimates rather than measurements.
    pub cache_partial: bool,
    /// True when at least one call lacked a reasoning/cached figure, so the
    /// corresponding total is a lower bound.
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUsage {
    pub path: PathBuf,
    pub bytes: u64,
    pub lines: u64,
    pub parse_errors: u64,
    pub schema_versions: Vec<u64>,
    pub calls: Vec<UsageCall>,
    pub totals: UsageTotals,
}
