//! `session/update` decoding with exact patch semantics (F04, F10, P17).
//!
//! Rules ported from the reviewed desktop adapter and covered by fixtures:
//!
//! - Chunk updates append one block; full messages replace content.
//! - For a full message, an omitted `content` means "no content supplied"
//!   (`has_content == false`), `null` means "clear", an array replaces.
//! - Tool patches track which fields were supplied and which were cleared.
//!   Missing means unchanged, `null` clears, a value replaces.
//! - Unknown update kinds become inspectable cards with a bounded raw payload.
//!   They are never silently dropped.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::transport::limits;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpdateError {
    #[error("session update is not an object")]
    NotAnObject,
    #[error("{0}")]
    Malformed(&'static str),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    Audio {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    ResourceLink {
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    Resource {
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        blob: Option<String>,
    },
    Unknown {
        #[serde(rename = "originalType")]
        original_type: String,
        raw: Value,
    },
}

fn string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn from_value(value: &Value) -> Result<Self, UpdateError> {
        let object = value
            .as_object()
            .ok_or(UpdateError::Malformed("content block is not an object"))?;
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("unknown");
        Ok(match kind {
            "text" => Self::Text {
                text: string(object, "text").unwrap_or_default(),
            },
            "image" => Self::Image {
                data: string(object, "data"),
                mime_type: string(object, "mimeType"),
                uri: string(object, "uri"),
            },
            "audio" => Self::Audio {
                data: string(object, "data"),
                mime_type: string(object, "mimeType"),
            },
            "resource_link" => Self::ResourceLink {
                uri: string(object, "uri").ok_or(UpdateError::Malformed("resource_link omitted uri"))?,
                name: string(object, "name"),
                mime_type: string(object, "mimeType"),
            },
            "resource" => {
                let resource = object
                    .get("resource")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                Self::Resource {
                    uri: string(&resource, "uri"),
                    mime_type: string(&resource, "mimeType"),
                    text: string(&resource, "text"),
                    blob: string(&resource, "blob"),
                }
            }
            other => Self::Unknown {
                original_type: other.to_string(),
                raw: bounded_value(value, limits::UNKNOWN_PAYLOAD_LIMIT_BYTES).0,
            },
        })
    }

    fn limited(self, max_bytes: usize, preview_bytes: usize) -> Self {
        match self {
            Self::Text { text } => Self::Text {
                text: limit_string(&text, max_bytes, preview_bytes),
            },
            Self::Image { data, mime_type, uri } => Self::Image {
                data: data.map(|d| limit_string(&d, max_bytes, preview_bytes)),
                mime_type,
                uri,
            },
            Self::Audio { data, mime_type } => Self::Audio {
                data: data.map(|d| limit_string(&d, max_bytes, preview_bytes)),
                mime_type,
            },
            Self::Resource { uri, mime_type, text, blob } => Self::Resource {
                uri,
                mime_type,
                text: text.map(|t| limit_string(&t, max_bytes, preview_bytes)),
                blob: blob.map(|b| limit_string(&b, max_bytes, preview_bytes)),
            },
            other => other,
        }
    }
}

/// Truncates a string to a preview when it exceeds `max_bytes`, matching the
/// reviewed adapter's presentation.
pub fn limit_string(value: &str, max_bytes: usize, preview_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let preview = cap_chars(value, preview_bytes);
    format!("{preview}\n… [truncated {} bytes]", value.len() - preview.len())
}

/// Applies [`limit_string`] to every string nested in a JSON value.
pub fn limit_payload_strings(value: Value, max_bytes: usize, preview_bytes: usize) -> Value {
    match value {
        Value::String(text) => Value::String(limit_string(&text, max_bytes, preview_bytes)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| limit_payload_strings(item, max_bytes, preview_bytes))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, limit_payload_strings(item, max_bytes, preview_bytes)))
                .collect(),
        ),
        other => other,
    }
}

/// Returns the value unchanged when it serializes within `max_bytes`, else a
/// preview record. The boolean reports truncation.
pub fn bounded_value(value: &Value, max_bytes: usize) -> (Value, bool) {
    let serialized = serde_json::to_string(value).unwrap_or_default();
    if serialized.len() <= max_bytes {
        (value.clone(), false)
    } else {
        (
            json!({
                "truncated": true,
                "bytes": serialized.len(),
                "preview": cap_chars(&serialized, limits::PAYLOAD_PREVIEW_BYTES),
            }),
            true,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUpdate {
    pub message_id: String,
    pub content: Vec<ContentBlock>,
    /// True for full messages, false for chunks.
    pub replace: bool,
    /// False only when a full message omitted `content` entirely.
    pub has_content: bool,
}

pub const TOOL_PATCH_FIELDS: [&str; 9] = [
    "title",
    "kind",
    "status",
    "content",
    "rawInput",
    "rawOutput",
    "name",
    "locations",
    "_meta",
];

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPatch {
    pub tool_call_id: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    /// The wire `kind` field. Serialized as `toolKind` so it cannot collide
    /// with the `kind` discriminator of `SessionUpdate`.
    #[serde(rename = "toolKind")]
    pub kind: Option<String>,
    pub content: Option<Value>,
    pub raw_input: Option<Value>,
    pub raw_output: Option<Value>,
    pub name: Option<String>,
    pub locations: Option<Value>,
    pub meta: Option<Value>,
    /// Fields supplied by any patch so far.
    pub present: BTreeSet<String>,
    /// Fields whose latest supplied value was `null`.
    pub cleared: BTreeSet<String>,
}

impl ToolPatch {
    pub fn from_object(object: &Map<String, Value>) -> Self {
        let mut present = BTreeSet::new();
        let mut cleared = BTreeSet::new();
        for field in TOOL_PATCH_FIELDS {
            if let Some(value) = object.get(field) {
                present.insert(field.to_string());
                if value.is_null() {
                    cleared.insert(field.to_string());
                }
            }
        }
        Self {
            tool_call_id: string(object, "toolCallId"),
            title: string(object, "title"),
            status: string(object, "status"),
            kind: string(object, "kind"),
            content: object.get("content").cloned(),
            raw_input: object.get("rawInput").cloned(),
            raw_output: object.get("rawOutput").cloned(),
            name: string(object, "name"),
            locations: object.get("locations").cloned(),
            meta: object.get("_meta").cloned(),
            present,
            cleared,
        }
    }

    /// Exact absence/null/replacement merge: a field missing from `patch` is
    /// unchanged; supplied-and-null clears it; supplied-with-value replaces.
    pub fn merging(&self, patch: &ToolPatch) -> ToolPatch {
        let mut result = self.clone();
        let supplied = |field: &str| patch.present.contains(field);
        let clears = |field: &str| patch.cleared.contains(field);
        if supplied("title") {
            result.title = if clears("title") { None } else { patch.title.clone() };
        }
        if supplied("kind") {
            result.kind = if clears("kind") { None } else { patch.kind.clone() };
        }
        if supplied("status") {
            result.status = if clears("status") { None } else { patch.status.clone() };
        }
        if supplied("content") {
            result.content = if clears("content") { None } else { patch.content.clone() };
        }
        if supplied("rawInput") {
            result.raw_input = if clears("rawInput") { None } else { patch.raw_input.clone() };
        }
        if supplied("rawOutput") {
            result.raw_output = if clears("rawOutput") { None } else { patch.raw_output.clone() };
        }
        if supplied("name") {
            result.name = if clears("name") { None } else { patch.name.clone() };
        }
        if supplied("locations") {
            result.locations = if clears("locations") { None } else { patch.locations.clone() };
        }
        if supplied("_meta") {
            result.meta = if clears("_meta") { None } else { patch.meta.clone() };
        }
        if patch.tool_call_id.is_some() {
            result.tool_call_id = patch.tool_call_id.clone();
        }
        result.present.extend(patch.present.iter().cloned());
        result.cleared = result
            .cleared
            .difference(&patch.present)
            .cloned()
            .collect::<BTreeSet<_>>()
            .union(&patch.cleared)
            .cloned()
            .collect();
        result
    }

    /// Agents mark background calls with `rawInput.background == true`.
    pub fn is_background(&self) -> bool {
        self.raw_input
            .as_ref()
            .and_then(|input| input.get("background"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn limited(mut self, max_bytes: usize, preview_bytes: usize) -> Self {
        self.raw_input = self
            .raw_input
            .map(|value| limit_payload_strings(value, max_bytes, preview_bytes));
        self.raw_output = self
            .raw_output
            .map(|value| limit_payload_strings(value, max_bytes, preview_bytes));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "planType", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PlanContent {
    Items { id: String, entries: Vec<PlanEntry> },
    File { id: String, uri: String },
    Markdown { id: String, content: String },
    Unknown { id: String, original_type: String, raw: Value },
}

impl PlanContent {
    pub fn id(&self) -> &str {
        match self {
            Self::Items { id, .. } | Self::File { id, .. } | Self::Markdown { id, .. } | Self::Unknown { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageUpdate {
    pub used: Option<u64>,
    pub size: Option<u64>,
    /// The agent's `_meta`, kept whole: `claude-agent-acp` carries the
    /// account's rate-limit state in it (`_claude/rateLimit`), which the
    /// session actor lifts into a provider-neutral quota event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
}

impl TokenUsage {
    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let field = |key: &str| object.get(key).and_then(Value::as_u64);
        Some(Self {
            total_tokens: field("totalTokens"),
            input_tokens: field("inputTokens"),
            output_tokens: field("outputTokens"),
            thought_tokens: field("thoughtTokens"),
            cached_read_tokens: field("cachedReadTokens"),
            cached_write_tokens: field("cachedWriteTokens"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommand {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub title_present: bool,
    pub updated_at_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub severity: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub compaction_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Vec<ContentBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateUpdate {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownUpdate {
    /// The wire `sessionUpdate` discriminator. Named to avoid colliding with
    /// the serde tag `kind` on `SessionUpdate`.
    pub original_kind: String,
    pub raw: Value,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SessionUpdate {
    UserMessage(MessageUpdate),
    AgentMessage(MessageUpdate),
    AgentThought(MessageUpdate),
    /// Legacy fixture compatibility: full `tool_call` records.
    ToolCall(ToolPatch),
    ToolCallUpdate(ToolPatch),
    ToolCallContent { tool_call_id: String, content: Value },
    Plan(PlanContent),
    PlanRemoved { id: String },
    Usage(UsageUpdate),
    /// Struct variants are used for array/opaque payloads because an
    /// internally tagged newtype variant cannot wrap a JSON array.
    ConfigOptions { config_options: Value },
    SessionInfo(SessionInfo),
    AvailableCommands { commands: Vec<AvailableCommand> },
    CurrentMode { raw: Value },
    Notice(Notice),
    Compaction(Compaction),
    CompactionChunk { compaction_id: String, content: ContentBlock },
    State(SessionStateUpdate),
    Unknown(UnknownUpdate),
}

/// Truncates on a character boundary at or below `max_bytes`.
pub fn cap_chars(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub fn decode_update(raw: &Value) -> Result<SessionUpdate, UpdateError> {
    let object = raw.as_object().ok_or(UpdateError::NotAnObject)?;
    let kind = object
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    let message = |replace: bool| -> Result<MessageUpdate, UpdateError> {
        // Optional on the wire: `claude-agent-acp` sends none on its chunks.
        // Empty means "the agent did not say", and the session actor assigns
        // a stable id of its own before anything is grouped by it.
        let message_id = string(object, "messageId").unwrap_or_default();
        if replace {
            return Ok(match object.get("content") {
                None => MessageUpdate {
                    message_id,
                    content: Vec::new(),
                    replace: true,
                    has_content: false,
                },
                Some(Value::Null) => MessageUpdate {
                    message_id,
                    content: Vec::new(),
                    replace: true,
                    has_content: true,
                },
                Some(Value::Array(items)) => MessageUpdate {
                    message_id,
                    content: items
                        .iter()
                        .map(ContentBlock::from_value)
                        .collect::<Result<Vec<_>, _>>()?,
                    replace: true,
                    has_content: true,
                },
                Some(_) => return Err(UpdateError::Malformed("message content is not an array")),
            });
        }
        let block = object
            .get("content")
            .ok_or(UpdateError::Malformed("message chunk omitted content"))?;
        Ok(MessageUpdate {
            message_id,
            content: vec![ContentBlock::from_value(block)?],
            replace: false,
            has_content: true,
        })
    };

    let entries = |value: &Value| -> Result<Vec<PlanEntry>, UpdateError> {
        value
            .as_array()
            .ok_or(UpdateError::Malformed("plan entries are not an array"))?
            .iter()
            .map(|entry| {
                let entry = entry
                    .as_object()
                    .ok_or(UpdateError::Malformed("plan entry is not an object"))?;
                Ok(PlanEntry {
                    content: string(entry, "content")
                        .ok_or(UpdateError::Malformed("plan entry omitted content"))?,
                    status: string(entry, "status"),
                    priority: string(entry, "priority"),
                })
            })
            .collect()
    };

    Ok(match kind {
        "user_message_chunk" => SessionUpdate::UserMessage(message(false)?),
        "user_message" => SessionUpdate::UserMessage(message(true)?),
        "agent_message_chunk" => SessionUpdate::AgentMessage(message(false)?),
        "agent_message" => SessionUpdate::AgentMessage(message(true)?),
        "agent_thought_chunk" => SessionUpdate::AgentThought(message(false)?),
        "agent_thought" => SessionUpdate::AgentThought(message(true)?),
        "tool_call" => SessionUpdate::ToolCall(ToolPatch::from_object(object)),
        "tool_call_update" => SessionUpdate::ToolCallUpdate(ToolPatch::from_object(object)),
        "tool_call_content_chunk" => SessionUpdate::ToolCallContent {
            tool_call_id: string(object, "toolCallId")
                .ok_or(UpdateError::Malformed("Malformed tool content chunk"))?,
            content: object
                .get("content")
                .cloned()
                .ok_or(UpdateError::Malformed("Malformed tool content chunk"))?,
        },
        "plan" => SessionUpdate::Plan(PlanContent::Items {
            id: "default".into(),
            entries: object
                .get("entries")
                .and_then(|value| entries(value).ok())
                .unwrap_or_default(),
        }),
        "plan_update" => {
            let raw_plan = object
                .get("plan")
                .ok_or(UpdateError::Malformed("Malformed plan update"))?;
            let plan = raw_plan
                .as_object()
                .ok_or(UpdateError::Malformed("Malformed plan update"))?;
            let id = string(plan, "planId").ok_or(UpdateError::Malformed("Malformed plan update"))?;
            match plan.get("type").and_then(Value::as_str) {
                Some("items") => SessionUpdate::Plan(PlanContent::Items {
                    id,
                    entries: entries(
                        plan.get("entries")
                            .ok_or(UpdateError::Malformed("Item plan omitted entries"))?,
                    )?,
                }),
                Some("file") => SessionUpdate::Plan(PlanContent::File {
                    id,
                    uri: string(plan, "uri").ok_or(UpdateError::Malformed("File plan omitted uri"))?,
                }),
                Some("markdown") => SessionUpdate::Plan(PlanContent::Markdown {
                    id,
                    content: string(plan, "content")
                        .ok_or(UpdateError::Malformed("Markdown plan omitted content"))?,
                }),
                Some(other) => SessionUpdate::Plan(PlanContent::Unknown {
                    id,
                    original_type: other.to_string(),
                    raw: bounded_value(raw_plan, limits::UNKNOWN_PAYLOAD_LIMIT_BYTES).0,
                }),
                None => return Err(UpdateError::Malformed("Plan update omitted type")),
            }
        }
        "plan_removed" => SessionUpdate::PlanRemoved {
            id: string(object, "planId").ok_or(UpdateError::Malformed("Plan removal omitted planId"))?,
        },
        "usage_update" => SessionUpdate::Usage(UsageUpdate {
            used: object.get("used").and_then(Value::as_u64),
            size: object.get("size").and_then(Value::as_u64),
            meta: object.get("_meta").filter(|meta| !meta.is_null()).cloned(),
        }),
        "config_option_update" => SessionUpdate::ConfigOptions {
            config_options: object
                .get("configOptions")
                .cloned()
                .unwrap_or(Value::Array(Vec::new())),
        },
        "session_info_update" => SessionUpdate::SessionInfo(SessionInfo {
            title: string(object, "title"),
            updated_at: string(object, "updatedAt"),
            title_present: object.contains_key("title"),
            updated_at_present: object.contains_key("updatedAt"),
        }),
        "available_commands_update" => SessionUpdate::AvailableCommands {
            commands: object
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|commands| {
                    commands
                        .iter()
                        .filter_map(|command| {
                            let command = command.as_object()?;
                            Some(AvailableCommand {
                                name: string(command, "name")?,
                                description: string(command, "description"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "state_update" => SessionUpdate::State(SessionStateUpdate {
            state: string(object, "state").ok_or(UpdateError::Malformed("state_update omitted state"))?,
            stop_reason: string(object, "stopReason"),
            usage: object.get("usage").and_then(TokenUsage::from_value),
        }),
        "notice" => SessionUpdate::Notice(Notice {
            severity: string(object, "severity"),
            title: string(object, "title").ok_or(UpdateError::Malformed("notice omitted title"))?,
            description: string(object, "description"),
        }),
        "compaction_update" => SessionUpdate::Compaction(Compaction {
            compaction_id: string(object, "compactionId")
                .ok_or(UpdateError::Malformed("compaction omitted compactionId"))?,
            status: string(object, "status").ok_or(UpdateError::Malformed("compaction omitted status"))?,
            summary: match object.get("summary") {
                Some(Value::Array(items)) => Some(
                    items
                        .iter()
                        .map(ContentBlock::from_value)
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                _ => None,
            },
            error: string(object, "error"),
        }),
        "compaction_summary_chunk" => SessionUpdate::CompactionChunk {
            compaction_id: string(object, "compactionId")
                .ok_or(UpdateError::Malformed("Malformed compaction chunk"))?,
            content: ContentBlock::from_value(
                object
                    .get("content")
                    .ok_or(UpdateError::Malformed("Malformed compaction chunk"))?,
            )?,
        },
        "current_mode_update" => SessionUpdate::CurrentMode { raw: raw.clone() },
        other => {
            let (bounded, truncated) = bounded_value(raw, limits::UNKNOWN_PAYLOAD_LIMIT_BYTES);
            SessionUpdate::Unknown(UnknownUpdate {
                original_kind: other.to_string(),
                raw: bounded,
                truncated,
            })
        }
    })
}

impl SessionUpdate {
    /// Text chunks of the same role and message id may be coalesced for
    /// presentation. Full messages and non-text chunks never coalesce.
    pub fn coalescing_key(&self) -> Option<String> {
        let (role, message) = match self {
            Self::UserMessage(m) => ("user", m),
            Self::AgentMessage(m) => ("agent", m),
            Self::AgentThought(m) => ("thought", m),
            _ => return None,
        };
        if message.replace || message.content.len() != 1 {
            return None;
        }
        match &message.content[0] {
            ContentBlock::Text { .. } => Some(format!("{role}|{}", message.message_id)),
            _ => None,
        }
    }

    pub fn text_chunk(&self) -> Option<&str> {
        let message = match self {
            Self::UserMessage(m) | Self::AgentMessage(m) | Self::AgentThought(m) => m,
            _ => return None,
        };
        if message.replace || message.content.len() != 1 {
            return None;
        }
        match &message.content[0] {
            ContentBlock::Text { text } => Some(text),
            _ => None,
        }
    }

    pub fn replacing_text(&self, text: String) -> SessionUpdate {
        let replace = |message: &MessageUpdate| MessageUpdate {
            message_id: message.message_id.clone(),
            content: vec![ContentBlock::Text { text }],
            replace: message.replace,
            has_content: message.has_content,
        };
        match self {
            Self::UserMessage(m) => Self::UserMessage(replace(m)),
            Self::AgentMessage(m) => Self::AgentMessage(replace(m)),
            Self::AgentThought(m) => Self::AgentThought(replace(m)),
            other => other.clone(),
        }
    }

    /// Caps large strings for presentation. The native projection keeps the
    /// full data; only the renderer copy is limited (P19).
    pub fn limited(self, max_bytes: usize, preview_bytes: usize) -> SessionUpdate {
        let limit_message = |mut message: MessageUpdate| {
            message.content = message
                .content
                .into_iter()
                .map(|block| block.limited(max_bytes, preview_bytes))
                .collect();
            message
        };
        match self {
            Self::UserMessage(m) => Self::UserMessage(limit_message(m)),
            Self::AgentMessage(m) => Self::AgentMessage(limit_message(m)),
            Self::AgentThought(m) => Self::AgentThought(limit_message(m)),
            Self::ToolCall(patch) => Self::ToolCall(patch.limited(max_bytes, preview_bytes)),
            Self::ToolCallUpdate(patch) => Self::ToolCallUpdate(patch.limited(max_bytes, preview_bytes)),
            other => other,
        }
    }

    /// The same update under another message id. Used by the session actor
    /// to name messages an agent sent without an id.
    pub fn with_message_id(self, message_id: String) -> SessionUpdate {
        match self {
            Self::UserMessage(m) => Self::UserMessage(MessageUpdate { message_id, ..m }),
            Self::AgentMessage(m) => Self::AgentMessage(MessageUpdate { message_id, ..m }),
            Self::AgentThought(m) => Self::AgentThought(MessageUpdate { message_id, ..m }),
            other => other,
        }
    }

    pub fn message_id(&self) -> Option<&str> {
        match self {
            Self::UserMessage(m) | Self::AgentMessage(m) | Self::AgentThought(m) => Some(&m.message_id),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(value: Value) -> SessionUpdate {
        decode_update(&value).unwrap()
    }

    #[test]
    fn full_message_distinguishes_omitted_null_and_array_content() {
        let SessionUpdate::UserMessage(omitted) = decode(json!({"sessionUpdate": "user_message", "messageId": "m"})) else { panic!() };
        assert!(omitted.replace && !omitted.has_content && omitted.content.is_empty());
        let SessionUpdate::UserMessage(null) = decode(json!({"sessionUpdate": "user_message", "messageId": "m", "content": null})) else { panic!() };
        assert!(null.replace && null.has_content && null.content.is_empty());
        let SessionUpdate::UserMessage(empty) = decode(json!({"sessionUpdate": "user_message", "messageId": "m", "content": []})) else { panic!() };
        assert!(empty.replace && empty.has_content && empty.content.is_empty());
        let SessionUpdate::AgentMessage(chunk) = decode(json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "text", "text": "hi"}})) else { panic!() };
        assert!(!chunk.replace && chunk.content == vec![ContentBlock::text("hi")]);
        assert!(decode_update(&json!({"sessionUpdate": "agent_message_chunk", "messageId": "a"})).is_err());
        // No id is not an error: `claude-agent-acp` sends none, and the
        // session actor names the message.
        let SessionUpdate::AgentMessage(unnamed) = decode(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}})) else { panic!() };
        assert_eq!(unnamed.message_id, "");
    }

    #[test]
    fn tool_patch_merging_follows_absence_null_replacement_rules() {
        let base = ToolPatch::from_object(json!({"toolCallId": "c", "title": "Cleared background", "rawInput": {"background": true}}).as_object().unwrap());
        assert!(base.is_background());
        assert_eq!(base.present, BTreeSet::from(["title".to_string(), "rawInput".to_string()]));
        let unchanged = base.merging(&ToolPatch::from_object(json!({"toolCallId": "c"}).as_object().unwrap()));
        assert_eq!(unchanged.title.as_deref(), Some("Cleared background"));
        assert!(unchanged.is_background());
        let cleared = base.merging(&ToolPatch::from_object(json!({"toolCallId": "c", "rawInput": null}).as_object().unwrap()));
        assert!(cleared.raw_input.is_none());
        assert!(!cleared.is_background());
        assert!(cleared.cleared.contains("rawInput"));
        assert!(cleared.present.contains("rawInput"));
        let restored = cleared.merging(&ToolPatch::from_object(json!({"toolCallId": "c", "rawInput": {"background": true}, "status": "completed"}).as_object().unwrap()));
        assert!(restored.is_background());
        assert!(!restored.cleared.contains("rawInput"));
        assert_eq!(restored.status.as_deref(), Some("completed"));
        // Title untouched throughout.
        assert_eq!(restored.title.as_deref(), Some("Cleared background"));
    }

    #[test]
    fn plans_usage_state_and_notices_decode() {
        let plan = decode(json!({"sessionUpdate": "plan_update", "plan": {"type": "items", "planId": "main", "entries": [{"content": "Inspect", "priority": "high", "status": "completed"}]}}));
        assert!(matches!(plan, SessionUpdate::Plan(PlanContent::Items { ref id, ref entries }) if id == "main" && entries.len() == 1));
        let future = decode(json!({"sessionUpdate": "plan_update", "plan": {"type": "graph", "planId": "g", "nodes": []}}));
        assert!(matches!(future, SessionUpdate::Plan(PlanContent::Unknown { ref original_type, .. }) if original_type == "graph"));
        assert!(decode_update(&json!({"sessionUpdate": "plan_update", "plan": {"planId": "x"}})).is_err());
        let legacy = decode(json!({"sessionUpdate": "plan", "entries": [{"content": "a"}]}));
        assert_eq!(legacy, SessionUpdate::Plan(PlanContent::Items { id: "default".into(), entries: vec![PlanEntry { content: "a".into(), status: None, priority: None }] }));
        let state = decode(json!({"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn", "usage": {"totalTokens": 12, "inputTokens": 7, "outputTokens": 5}}));
        let SessionUpdate::State(state) = state else { panic!() };
        assert_eq!(state.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(state.usage.unwrap().total_tokens, Some(12));
        assert_eq!(decode(json!({"sessionUpdate": "usage_update", "used": 10, "size": 100})), SessionUpdate::Usage(UsageUpdate { used: Some(10), size: Some(100), meta: None }));
        let SessionUpdate::Notice(notice) = decode(json!({"sessionUpdate": "notice", "severity": "warning", "title": "Interrupted"})) else { panic!() };
        assert_eq!(notice.severity.as_deref(), Some("warning"));
        let SessionUpdate::SessionInfo(info) = decode(json!({"sessionUpdate": "session_info_update", "title": null})) else { panic!() };
        assert!(info.title_present && info.title.is_none() && !info.updated_at_present);
    }

    #[test]
    fn unknown_kinds_are_preserved_with_bounded_raw_payload() {
        let SessionUpdate::Unknown(unknown) = decode(json!({"sessionUpdate": "vendor_future_update", "opaque": {"value": 1}})) else { panic!() };
        assert_eq!(unknown.original_kind, "vendor_future_update");
        assert_eq!(unknown.raw["opaque"]["value"], 1);
        assert!(!unknown.truncated);
        let huge = "x".repeat(limits::UNKNOWN_PAYLOAD_LIMIT_BYTES + 10);
        let SessionUpdate::Unknown(unknown) = decode(json!({"sessionUpdate": "huge", "blob": huge})) else { panic!() };
        assert!(unknown.truncated);
        assert_eq!(unknown.raw["truncated"], true);
        assert!(unknown.raw["preview"].as_str().unwrap().len() <= limits::PAYLOAD_PREVIEW_BYTES);
        let SessionUpdate::AgentMessage(message) = decode(json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "hologram", "x": 1}})) else { panic!() };
        assert!(matches!(&message.content[0], ContentBlock::Unknown { original_type, .. } if original_type == "hologram"));
    }

    #[test]
    fn coalescing_only_applies_to_single_text_chunks() {
        let chunk = decode(json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "text", "text": "latest "}}));
        assert_eq!(chunk.coalescing_key().as_deref(), Some("agent|a"));
        assert_eq!(chunk.text_chunk(), Some("latest "));
        let merged = chunk.replacing_text("latest thought".into());
        assert_eq!(merged.text_chunk(), Some("latest thought"));
        let image = decode(json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"}}));
        assert!(image.coalescing_key().is_none());
        let full = decode(json!({"sessionUpdate": "agent_message", "messageId": "a", "content": [{"type": "text", "text": "x"}]}));
        assert!(full.coalescing_key().is_none());
    }

    #[test]
    fn every_update_kind_serializes_with_its_discriminator_intact() {
        // Internally tagged enums must not lose or overwrite the `kind` tag
        // (field collisions) and must not wrap bare arrays (serde rejects it).
        let samples = [
            json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "text", "text": "x"}}),
            json!({"sessionUpdate": "user_message", "messageId": "u", "content": []}),
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "c", "kind": "execute", "status": "completed", "rawInput": {"background": true}}),
            json!({"sessionUpdate": "tool_call", "toolCallId": "c", "title": "t"}),
            json!({"sessionUpdate": "tool_call_content_chunk", "toolCallId": "c", "content": {"x": 1}}),
            json!({"sessionUpdate": "plan_update", "plan": {"type": "items", "planId": "p", "entries": []}}),
            json!({"sessionUpdate": "plan_removed", "planId": "p"}),
            json!({"sessionUpdate": "usage_update", "used": 1, "size": 2}),
            json!({"sessionUpdate": "config_option_update", "configOptions": [{"configId": "model"}]}),
            json!({"sessionUpdate": "session_info_update", "title": "t"}),
            json!({"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "compact"}]}),
            json!({"sessionUpdate": "current_mode_update", "modeId": "ask"}),
            json!({"sessionUpdate": "notice", "severity": "warning", "title": "n"}),
            json!({"sessionUpdate": "compaction_update", "compactionId": "k", "status": "done"}),
            json!({"sessionUpdate": "compaction_summary_chunk", "compactionId": "k", "content": {"type": "text", "text": "s"}}),
            json!({"sessionUpdate": "state_update", "state": "idle"}),
            json!({"sessionUpdate": "vendor_future", "x": 1}),
        ];
        let expected_tags = [
            "agent_message", "user_message", "tool_call_update", "tool_call", "tool_call_content", "plan", "plan_removed",
            "usage", "config_options", "session_info", "available_commands", "current_mode", "notice", "compaction",
            "compaction_chunk", "state", "unknown",
        ];
        for (sample, expected) in samples.iter().zip(expected_tags) {
            let update = decode_update(sample).unwrap();
            let text = serde_json::to_string(&update).unwrap_or_else(|error| panic!("{expected} failed to serialize: {error}"));
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["kind"], expected, "tag preserved for {expected}: {text}");
            assert_eq!(text.matches("\"kind\":").count(), 1, "exactly one kind key for {expected}: {text}");
        }
        let tool = decode(json!({"sessionUpdate": "tool_call_update", "toolCallId": "c", "kind": "execute"}));
        assert_eq!(serde_json::to_value(&tool).unwrap()["toolKind"], "execute");
        // Struct-variant fields must be camelCase for the renderer contract.
        let chunk = serde_json::to_value(decode(json!({"sessionUpdate": "tool_call_content_chunk", "toolCallId": "c", "content": 1}))).unwrap();
        assert!(chunk.get("toolCallId").is_some() && chunk.get("tool_call_id").is_none(), "{chunk}");
        let options = serde_json::to_value(decode(json!({"sessionUpdate": "config_option_update", "configOptions": []}))).unwrap();
        assert!(options.get("configOptions").is_some(), "{options}");
        let compaction = serde_json::to_value(decode(json!({"sessionUpdate": "compaction_summary_chunk", "compactionId": "k", "content": {"type": "text", "text": "s"}}))).unwrap();
        assert!(compaction.get("compactionId").is_some(), "{compaction}");
        let plan = serde_json::to_value(decode(json!({"sessionUpdate": "plan_update", "plan": {"type": "graph", "planId": "g"}}))).unwrap();
        assert!(plan.get("originalType").is_some(), "{plan}");
    }

    #[test]
    fn limiting_truncates_only_oversized_strings() {
        let text = "y".repeat(100);
        let update = decode(json!({"sessionUpdate": "agent_message_chunk", "messageId": "a", "content": {"type": "text", "text": text}})).limited(50, 10);
        let limited = update.text_chunk().unwrap();
        assert!(limited.starts_with("yyyyyyyyyy\n… [truncated 90 bytes]"));
        let small = decode(json!({"sessionUpdate": "tool_call_update", "toolCallId": "c", "rawOutput": {"nested": ["ok"]}})).limited(50, 10);
        assert!(matches!(small, SessionUpdate::ToolCallUpdate(patch) if patch.raw_output == Some(json!({"nested": ["ok"]}))));
    }
}
