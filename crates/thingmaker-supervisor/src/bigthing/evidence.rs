//! The agent-run, desktop-read verification lane.
//!
//! The model (or a subagent it raised) runs the milestone's check itself, and
//! Big Thing does not believe the prose about it: it looks in the turn's own
//! tool results for a shell result whose command is the check, and reads its
//! exit code. A refusal machine: an ambiguous turn claims nothing.

use serde_json::Value;

use crate::acp::updates::ToolPatch;
use crate::agents::Provider;
use crate::storage::odyssey::CheckKind;

/// Lines of a failing check's output sent back to the model.
pub const FAILURE_TAIL_LINES: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellResult {
    /// The command, when the program made it recoverable.
    pub command: Option<String>,
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
}

const MAX_DEPTH: usize = 6;

/// Shell-shaped results anywhere in an output (`{exit_code, stdout, …}`),
/// bare or nested.
fn shell_results_in(output: &Value, depth: usize) -> Vec<ShellResult> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    match output {
        Value::Array(items) => items.iter().flat_map(|item| shell_results_in(item, depth + 1)).collect(),
        Value::Object(map) => {
            if let Some(code) = map.get("exit_code").and_then(Value::as_i64) {
                let text = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                return vec![ShellResult { command: map.get("command").and_then(Value::as_str).map(str::to_string), exit_code: code, stdout: text("stdout"), stderr: text("stderr") }];
            }
            map.values().flat_map(|value| shell_results_in(value, depth + 1)).collect()
        }
        _ => Vec::new(),
    }
}

fn content_text(content: Option<&Value>) -> String {
    let Some(Value::Array(entries)) = content else { return String::new() };
    let text = entries
        .iter()
        .map(|entry| entry.get("content").and_then(|inner| inner.get("text")).and_then(Value::as_str).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.strip_prefix("```").map(|rest| rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest)).unwrap_or(&text).to_string();
    text.strip_suffix("```").map(|rest| rest.strip_suffix('\n').unwrap_or(rest).to_string()).unwrap_or(text)
}

/// A tool call's shell results, read the way each provider reports them
/// (captured from the real programs):
///
/// - Codex: `rawOutput` is `{exitCode, output}`;
/// - Claude Code: an `execute` call whose `rawInput.command` is the command;
///   `completed` is exit 0, `failed` starts its text with `Exit code N`;
/// - Gemini: nothing readable — every call says completed, with no code.
pub fn shell_results_of(patch: &ToolPatch, provider: Provider) -> Vec<ShellResult> {
    if let Some(output) = patch.raw_output.as_ref() {
        let legacy = shell_results_in(output, 0);
        if !legacy.is_empty() {
            return legacy;
        }
    }
    let input = patch.raw_input.as_ref().and_then(Value::as_object);
    let raw = input.and_then(|input| input.get("command").or_else(|| input.get("CommandLine")).or_else(|| input.get("cmd")));
    let command = match raw {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        _ => None,
    };
    let output = patch.raw_output.as_ref();
    let codex_shape = output.and_then(Value::as_object).and_then(|object| object.get("exitCode")).and_then(Value::as_i64);
    if provider == Provider::Codex || codex_shape.is_some() {
        let Some(code) = codex_shape else { return Vec::new() };
        let object = output.and_then(Value::as_object);
        let stdout = object.and_then(|object| object.get("output").or_else(|| object.get("aggregatedOutput"))).and_then(Value::as_str).unwrap_or("").to_string();
        return vec![ShellResult { command, exit_code: code, stdout, stderr: String::new() }];
    }
    if provider == Provider::Claude {
        let Some(command) = command else { return Vec::new() };
        if patch.kind.as_deref() != Some("execute") {
            return Vec::new();
        }
        let status = patch.status.as_deref();
        if status != Some("completed") && status != Some("failed") {
            return Vec::new();
        }
        let text = match output {
            Some(Value::String(text)) => text.clone(),
            _ => content_text(patch.content.as_ref()),
        };
        let parsed = text.strip_prefix("Exit code ").and_then(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let code: i64 = digits.parse().ok()?;
            let after = &rest[digits.len()..];
            let after = after.trim_start_matches([' ', '\t']);
            Some((code, after.strip_prefix('\n').unwrap_or(after).to_string()))
        });
        let exit_code = if status == Some("completed") { 0 } else { parsed.as_ref().map(|(code, _)| *code).unwrap_or(1) };
        let stdout = parsed.map(|(_, rest)| rest).unwrap_or(text);
        return vec![ShellResult { command: Some(command), exit_code, stdout, stderr: String::new() }];
    }
    Vec::new()
}

/// Two commands are the same when only whitespace or a trailing `;` differs.
pub fn same_command(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ").trim_end_matches(';').to_string();
    let left = normalize(left);
    !left.is_empty() && left == normalize(right)
}

/// Whether a shell result could ever be evidence for this kind of check.
pub fn readable_from_tool_results(kind: CheckKind) -> bool {
    matches!(kind, CheckKind::Command | CheckKind::TestsPass)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Evidence {
    Found { result: ShellResult, how: String },
    Absent { reason: String },
    Ambiguous { reason: String },
}

/// The milestone's check among a turn's shell results; the last run wins.
pub fn evidence_for(spec: Option<&str>, results: &[ShellResult]) -> Evidence {
    let wanted = spec.unwrap_or("").trim();
    if wanted.is_empty() {
        return Evidence::Absent { reason: "the milestone names no command, so there is nothing to look for".into() };
    }
    if results.is_empty() {
        return Evidence::Absent { reason: "the turn recorded no shell results".into() };
    }
    if let Some(last) = results.iter().rfind(|result| result.command.as_deref().is_some_and(|command| same_command(command, wanted))) {
        return Evidence::Found { result: last.clone(), how: format!("the agent ran `{}` and its tool result exited {}", last.command.as_deref().unwrap_or(""), last.exit_code) };
    }
    let named = results.iter().filter(|result| result.command.is_some()).count();
    if named > 0 {
        return Evidence::Absent { reason: format!("the turn ran {}, none of them `{wanted}`", if named == 1 { "a command".to_string() } else { format!("{named} commands") }) };
    }
    if results.len() == 1 {
        let only = &results[0];
        return Evidence::Found { result: only.clone(), how: format!("the turn's only shell result exited {}; the tool did not report which command it ran", only.exit_code) };
    }
    Evidence::Ambiguous { reason: format!("the turn ran {} commands and none reported which command it was, so none of them can be credited to this check", results.len()) }
}

/// The tail of a failing check, for the delta the model is told.
pub fn failure_tail(result: &ShellResult) -> String {
    let source = if result.stderr.trim().is_empty() { result.stdout.trim() } else { result.stderr.trim() };
    let lines: Vec<&str> = source.split('\n').map(str::trim_end).filter(|line| !line.is_empty()).collect();
    lines[lines.len().saturating_sub(FAILURE_TAIL_LINES)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(kind: Option<&str>, status: Option<&str>, input: Value, output: Option<Value>, content: Option<Value>) -> ToolPatch {
        let mut object = serde_json::Map::new();
        object.insert("toolCallId".into(), json!("t1"));
        if let Some(kind) = kind {
            object.insert("kind".into(), json!(kind));
        }
        if let Some(status) = status {
            object.insert("status".into(), json!(status));
        }
        object.insert("rawInput".into(), input);
        if let Some(output) = output {
            object.insert("rawOutput".into(), output);
        }
        if let Some(content) = content {
            object.insert("content".into(), content);
        }
        ToolPatch::from_object(&object)
    }

    #[test]
    fn each_provider_s_shell_result_is_read_its_own_way() {
        let codex = patch(None, Some("completed"), json!({"command": ["bash", "-lc", "pnpm test"]}), Some(json!({"exitCode": 1, "output": "1 failed"})), None);
        assert_eq!(shell_results_of(&codex, Provider::Codex), vec![ShellResult { command: Some("bash -lc pnpm test".into()), exit_code: 1, stdout: "1 failed".into(), stderr: String::new() }]);
        let failed = patch(Some("execute"), Some("failed"), json!({"command": "pnpm test"}), Some(json!("Exit code 2\nboom")), None);
        assert_eq!(shell_results_of(&failed, Provider::Claude)[0].exit_code, 2);
        assert_eq!(shell_results_of(&failed, Provider::Claude)[0].stdout, "boom");
        let passed = patch(Some("execute"), Some("completed"), json!({"command": "pnpm test"}), None, Some(json!([{"type": "content", "content": {"type": "text", "text": "```\nok\n```"}}])));
        assert_eq!(shell_results_of(&passed, Provider::Claude), vec![ShellResult { command: Some("pnpm test".into()), exit_code: 0, stdout: "ok".into(), stderr: String::new() }]);
        let running = patch(Some("execute"), Some("in_progress"), json!({"command": "pnpm test"}), None, None);
        assert!(shell_results_of(&running, Provider::Claude).is_empty());
        let gemini = patch(Some("execute"), Some("completed"), json!({"CommandLine": "pnpm test"}), Some(json!("ok")), None);
        assert!(shell_results_of(&gemini, Provider::Gemini).is_empty(), "no exit code to read");
    }

    #[test]
    fn only_the_milestone_s_own_command_is_evidence() {
        let result = |command: Option<&str>, code| ShellResult { command: command.map(str::to_string), exit_code: code, stdout: String::new(), stderr: "a\nb\nc".into() };
        assert!(matches!(evidence_for(Some("pnpm test"), &[result(Some("pnpm  test;"), 1), result(Some("pnpm test"), 0)]), Evidence::Found { result, .. } if result.exit_code == 0));
        assert!(matches!(evidence_for(Some("pnpm test"), &[result(Some("pnpm test -- foo"), 0)]), Evidence::Absent { .. }));
        assert!(matches!(evidence_for(Some("pnpm test"), &[result(None, 0)]), Evidence::Found { .. }));
        assert!(matches!(evidence_for(Some("pnpm test"), &[result(None, 0), result(None, 1)]), Evidence::Ambiguous { .. }));
        assert!(matches!(evidence_for(None, &[result(None, 0)]), Evidence::Absent { .. }));
        assert_eq!(failure_tail(&result(None, 1)), "b\nc");
    }
}
