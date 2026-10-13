//! A session's title, from where its provider keeps it.
//!
//! A live session reads its title off the stream, but nothing on the stream
//! survives the session closing, so the desktop keeps one in its own record
//! (`sessions.auto_title`). The best one is the provider's own, the same the
//! provider's app shows: Claude Code writes `ai-title` (and `custom-title`
//! for a rename in Claude) records into the transcript, and Codex keeps
//! `thread_name`s in `session_index.jsonl`. Failing that, the first thing the
//! person asked. Gemini's `agy` keeps titles in a database of its own, so its
//! sessions keep their first prompt.
//!
//! Only read, never written: the transcripts stay the provider's (ADR-006).

use std::{
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::Value;

use super::{Provider, claude, codex};

/// Characters a kept title is cut to.
pub const TITLE_CHARS: usize = 80;

/// A title made from a prompt: its first line with words in it, without
/// Markdown's leading marks, cut to [`TITLE_CHARS`].
pub fn title_from_prompt(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(|line| line.trim().trim_start_matches(['#', '>', '*', '-', ' ']).trim())
        .find(|line| line.chars().any(char::is_alphanumeric))?;
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(cut(&collapsed))
}

fn cut(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= TITLE_CHARS {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(TITLE_CHARS - 1).collect();
    if let Some(space) = kept.rfind(' ').filter(|space| *space > TITLE_CHARS / 2) {
        kept.truncate(space);
    }
    format!("{}…", kept.trim_end())
}

/// Text the provider put in a user turn that the person did not type: the
/// environment, instructions files, command wrappers.
fn injected(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with('<') || text.starts_with("# AGENTS.md") || text.starts_with("Caveat:")
}

fn first_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| matches!(block.get("type").and_then(Value::as_str), Some("text" | "input_text")))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .find(|text| !injected(text))
            .map(str::to_string),
        _ => None,
    }
}

/// Claude Code's own title for a transcript: the last rename made in Claude
/// (`custom-title`), else its last generated one (`ai-title`), else the first
/// prompt.
pub fn claude_title(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    let (mut custom, mut generated, mut first) = (None, None, None);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Most lines are tool traffic; only parse the ones that can matter.
        let titled = line.contains("\"type\":\"ai-title\"") || line.contains("\"type\":\"custom-title\"");
        let asked = first.is_none() && line.contains("\"type\":\"user\"");
        if !titled && !asked {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => custom = record.get("customTitle").and_then(Value::as_str).map(str::to_string).or(custom),
            Some("ai-title") => generated = record.get("aiTitle").and_then(Value::as_str).map(str::to_string).or(generated),
            Some("user") if !record.get("isMeta").and_then(Value::as_bool).unwrap_or(false) => {
                first = record.get("message").and_then(|message| message.get("content")).and_then(first_text).filter(|text| !injected(text));
            }
            _ => {}
        }
    }
    custom.or(generated).map(|title| cut(&title)).filter(|title| !title.is_empty()).or_else(|| first.as_deref().and_then(title_from_prompt))
}

/// Codex's own name for a thread (the last `thread_name` it recorded), else
/// the first prompt in its rollout.
pub fn codex_title(codex_home: &Path, thread_id: &str) -> Option<String> {
    let named = std::fs::File::open(codex_home.join("session_index.jsonl")).ok().and_then(|file| {
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| line.contains(thread_id))
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(thread_id))
            .filter_map(|entry| entry.get("thread_name").and_then(Value::as_str).map(str::to_string))
            .filter(|name| !name.trim().is_empty())
            .last()
    });
    if let Some(name) = named {
        return Some(cut(&name));
    }
    let rollout = codex::transcript_usage::find_rollout(codex_home, thread_id)?;
    let file = std::fs::File::open(rollout).ok()?;
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("\"role\":\"user\""))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|record| {
            let payload = record.get("payload")?;
            (payload.get("type").and_then(Value::as_str) == Some("message") && payload.get("role").and_then(Value::as_str) == Some("user"))
                .then(|| payload.get("content").and_then(first_text))
                .flatten()
        })
        .find_map(|text| title_from_prompt(&text))
}

/// The provider's title for a session, where it keeps one it can be read
/// from. `home` is the user's home; `root` the workspace the session ran in.
pub fn provider_title(provider: Provider, home: &Path, root: &Path, agent_session_id: &str) -> Option<String> {
    match provider {
        Provider::Claude => claude_title(&claude::transcript_usage::transcript_path(home, root, agent_session_id)),
        Provider::Codex => {
            let codex_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            codex_title(&codex_home, agent_session_id)
        }
        Provider::Gemini => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_becomes_its_first_meaningful_line_cut_short() {
        assert_eq!(title_from_prompt("\n\n## Fix the loading screen\nmore").as_deref(), Some("Fix the loading screen"));
        assert_eq!(title_from_prompt("  make   it    fast  ").as_deref(), Some("make it fast"));
        assert_eq!(title_from_prompt("---\n\n"), None);
        let long = "word ".repeat(40);
        let title = title_from_prompt(&long).unwrap();
        assert!(title.chars().count() <= TITLE_CHARS && title.ends_with('…'), "{title}");
    }

    #[test]
    fn claude_codes_own_title_wins_over_the_first_prompt_and_a_rename_in_claude_over_both() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let lines = [
            r#"{"type":"user","isMeta":true,"message":{"content":"<command-name>/init</command-name>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"I'd like a quick loading screen for the game"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(claude_title(&path).as_deref(), Some("I'd like a quick loading screen for the game"), "the first prompt, past what Claude Code injected");

        let mut more = lines.join("\n");
        more.push_str("\n{\"type\":\"ai-title\",\"aiTitle\":\"Loading screen draft\",\"sessionId\":\"s\"}");
        more.push_str("\n{\"type\":\"ai-title\",\"aiTitle\":\"Game loading screen with chibi animation\",\"sessionId\":\"s\"}");
        std::fs::write(&path, &more).unwrap();
        assert_eq!(claude_title(&path).as_deref(), Some("Game loading screen with chibi animation"), "the latest generated title");

        more.push_str("\n{\"type\":\"custom-title\",\"customTitle\":\"Loading screen\",\"sessionId\":\"s\"}");
        std::fs::write(&path, &more).unwrap();
        assert_eq!(claude_title(&path).as_deref(), Some("Loading screen"));
        assert_eq!(claude_title(&dir.path().join("missing.jsonl")), None);
    }

    #[test]
    fn codex_names_a_thread_in_its_index_and_otherwise_its_first_prompt_is_used() {
        let home = tempfile::tempdir().unwrap();
        let id = "019c33e4-f2af-7943-955f-a40262173441";
        let day = home.path().join("sessions/2026/10/12");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-10-12T10-00-00-{id}.jsonl")),
            [
                r#"{"type":"session_meta","payload":{"id":"x"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Document the repo contents\nin detail"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(codex_title(home.path(), id).as_deref(), Some("Document the repo contents"));

        std::fs::write(
            home.path().join("session_index.jsonl"),
            format!("{{\"id\":\"{id}\",\"thread_name\":\"Docs\"}}\n{{\"id\":\"other\",\"thread_name\":\"No\"}}\n{{\"id\":\"{id}\",\"thread_name\":\"Document repo contents\"}}\n"),
        )
        .unwrap();
        assert_eq!(codex_title(home.path(), id).as_deref(), Some("Document repo contents"), "the last name the index recorded");
        assert_eq!(codex_title(home.path(), "nope"), None);
    }
}
