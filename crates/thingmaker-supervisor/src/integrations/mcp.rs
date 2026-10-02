//! MCP servers: what each provider has configured, and installing new ones
//! through each provider's own `mcp` command.
//!
//! ThingMaker keeps no MCP registry of its own. A server is added with the
//! provider's official CLI (`claude mcp add-json`, `codex mcp add`,
//! `agy mcp add`), so it lands where that provider looks for it, works in the
//! provider's own app and terminal too, and is picked up by every session
//! ThingMaker starts on that provider. Reading back is from the providers'
//! own config files; secret values are never returned, only their names.
//!
//! A value written as `${NAME}` is a reference to an environment variable, so
//! a token can live in ThingMaker's runtime environment (the keychain) rather
//! than in a config file: Claude Code expands it itself, and for Codex the
//! name is added to the server's `env_vars`, which forwards it from the
//! session's environment.

use std::{
    collections::{BTreeMap, HashMap},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{agents::Provider, error::DesktopError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

/// A server to install, as the user described it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub name: String,
    pub transport: McpTransport,
}

/// Where a provider keeps a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpScope {
    /// Every project: Claude's user scope, Codex's and Antigravity's only scope.
    User,
    /// Claude Code only: this project, for you alone.
    Local,
    /// Claude Code's shared `.mcp.json`; read, never written here.
    Project,
}

/// A server a provider has configured. No secret values: names only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledServer {
    pub name: String,
    pub provider: Provider,
    pub scope: McpScope,
    /// `stdio` or `http`.
    pub kind: String,
    /// The command line, or the URL.
    pub summary: String,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub enabled: bool,
    pub source: PathBuf,
}

/// Where each provider's files are; `None` means the default under `home`.
#[derive(Debug, Clone, Default)]
pub struct ConfigHomes {
    pub home: PathBuf,
    pub claude_config_dir: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
}

impl ConfigHomes {
    pub fn from_env(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            codex_home: std::env::var_os("CODEX_HOME").map(PathBuf::from),
        }
    }

    fn claude_json(&self) -> PathBuf {
        match &self.claude_config_dir {
            Some(dir) => dir.join(".claude.json"),
            None => self.home.join(".claude.json"),
        }
    }

    pub fn codex_config(&self) -> PathBuf {
        self.codex_home.clone().unwrap_or_else(|| self.home.join(".codex")).join("config.toml")
    }

    fn agy_config(&self) -> PathBuf {
        self.home.join(".gemini/config/mcp_config.json")
    }
}

fn keys(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_object).map(|map| map.keys().cloned().collect()).unwrap_or_default()
}

fn command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command.to_string()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ")
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// A server out of a JSON config entry (Claude's, Antigravity's, Cursor's…).
fn json_server(provider: Provider, scope: McpScope, name: &str, entry: &Value, source: &Path) -> InstalledServer {
    let url = entry.get("url").or_else(|| entry.get("serverUrl")).or_else(|| entry.get("httpUrl")).and_then(Value::as_str);
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
    InstalledServer {
        name: name.to_string(),
        provider,
        scope,
        kind: if url.is_some() { "http".into() } else { "stdio".into() },
        summary: url.map(str::to_string).unwrap_or_else(|| command_line(command, &strings(entry.get("args")))),
        env_keys: keys(entry.get("env")),
        header_keys: keys(entry.get("headers")),
        enabled: !entry.get("disabled").and_then(Value::as_bool).unwrap_or(false),
        source: source.to_path_buf(),
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every MCP server the three providers have configured for this workspace.
pub fn installed(homes: &ConfigHomes, root: Option<&Path>) -> Vec<InstalledServer> {
    let mut out = Vec::new();
    let claude = homes.claude_json();
    if let Some(config) = read_json(&claude) {
        for (name, entry) in config.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
            out.push(json_server(Provider::Claude, McpScope::User, name, entry, &claude));
        }
        if let Some(root) = root {
            let project = config.get("projects").and_then(|projects| projects.get(root.to_string_lossy().as_ref()));
            for (name, entry) in project.and_then(|project| project.get("mcpServers")).and_then(Value::as_object).into_iter().flatten() {
                out.push(json_server(Provider::Claude, McpScope::Local, name, entry, &claude));
            }
        }
    }
    if let Some(root) = root {
        let shared = root.join(".mcp.json");
        if let Some(config) = read_json(&shared) {
            for (name, entry) in config.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
                out.push(json_server(Provider::Claude, McpScope::Project, name, entry, &shared));
            }
        }
    }
    let codex = homes.codex_config();
    if let Ok(text) = std::fs::read_to_string(&codex)
        && let Ok(config) = text.parse::<toml::Table>()
    {
        for (name, entry) in config.get("mcp_servers").and_then(toml::Value::as_table).into_iter().flatten() {
            let url = entry.get("url").and_then(toml::Value::as_str);
            let command = entry.get("command").and_then(toml::Value::as_str).unwrap_or("");
            let args: Vec<String> = entry.get("args").and_then(toml::Value::as_array).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let mut env_keys: Vec<String> = entry.get("env").and_then(toml::Value::as_table).map(|table| table.keys().cloned().collect()).unwrap_or_default();
            env_keys.extend(entry.get("env_vars").and_then(toml::Value::as_array).into_iter().flatten().filter_map(|item| item.as_str().map(str::to_string)));
            let mut header_keys: Vec<String> = entry.get("http_headers").and_then(toml::Value::as_table).map(|table| table.keys().cloned().collect()).unwrap_or_default();
            if entry.get("bearer_token_env_var").is_some() {
                header_keys.push("Authorization".into());
            }
            out.push(InstalledServer {
                name: name.clone(),
                provider: Provider::Codex,
                scope: McpScope::User,
                kind: if url.is_some() { "http".into() } else { "stdio".into() },
                summary: url.map(str::to_string).unwrap_or_else(|| command_line(command, &args)),
                env_keys,
                header_keys,
                enabled: entry.get("enabled").and_then(toml::Value::as_bool).unwrap_or(true),
                source: codex.clone(),
            });
        }
    }
    let agy = homes.agy_config();
    if let Some(config) = read_json(&agy) {
        for (name, entry) in config.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
            out.push(json_server(Provider::Gemini, McpScope::User, name, entry, &agy));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.provider.cmp(&b.provider)));
    out
}

/// A name a provider accepts: letters, digits, `-` and `_`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn tidy_name(name: &str) -> String {
    let cleaned: String = name.trim().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    cleaned.trim_matches('-').to_string()
}

/// One server out of a JSON entry in any of the common config shapes.
fn spec_from_json(name: &str, entry: &Value) -> Result<McpServerSpec, String> {
    let name = tidy_name(name);
    if !valid_name(&name) {
        return Err(format!("\"{name}\" is not a usable server name"));
    }
    let object = entry.as_object().ok_or_else(|| format!("{name}: not an object"))?;
    let string_map = |key: &str| -> BTreeMap<String, String> {
        object.get(key).and_then(Value::as_object).map(|map| map.iter().map(|(key, value)| (key.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))).collect()).unwrap_or_default()
    };
    if let Some(url) = object.get("url").or_else(|| object.get("serverUrl")).or_else(|| object.get("httpUrl")).and_then(Value::as_str) {
        return Ok(McpServerSpec { name, transport: McpTransport::Http { url: url.to_string(), headers: string_map("headers") } });
    }
    let command = object.get("command").and_then(Value::as_str).ok_or_else(|| format!("{name}: no command or url"))?;
    let mut args = strings(object.get("args"));
    // `"command": "npx -y pkg"` is common in READMEs: split it.
    let mut parts = shell_words(command);
    let command = if parts.len() > 1 {
        let head = parts.remove(0);
        parts.extend(args);
        args = parts;
        head
    } else {
        command.to_string()
    };
    Ok(McpServerSpec { name, transport: McpTransport::Stdio { command, args, env: string_map("env") } })
}

/// Splits a command line the way a shell would, for quotes and spaces only.
pub fn shell_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for c in text.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() || any {
                    words.push(std::mem::take(&mut current));
                }
                any = false;
            }
            (None, '\\') => {}
            (None, c) => current.push(c),
        }
    }
    if !current.is_empty() || any {
        words.push(current);
    }
    words
}

/// A command line as a server: `claude mcp add …`, `codex mcp add …`,
/// `agy mcp add …`, or a bare `npx -y pkg`.
fn spec_from_command(text: &str, name: Option<&str>) -> Result<McpServerSpec, String> {
    let words = shell_words(text.trim().trim_start_matches('$').trim());
    let mut words = words.into_iter().peekable();
    let tool = words.peek().cloned().unwrap_or_default();
    let is_cli = ["claude", "codex", "agy", "gemini"].contains(&tool.as_str());
    if !is_cli {
        let mut all: Vec<String> = words.collect();
        if all.is_empty() {
            return Err("nothing to install".into());
        }
        let command = all.remove(0);
        let name = name.map(tidy_name).unwrap_or_else(|| guess_name(&command, &all));
        if command.starts_with("http://") || command.starts_with("https://") {
            return Ok(McpServerSpec { name, transport: McpTransport::Http { url: command, headers: BTreeMap::new() } });
        }
        return Ok(McpServerSpec { name, transport: McpTransport::Stdio { command, args: all, env: BTreeMap::new() } });
    }
    words.next();
    if words.next().as_deref() != Some("mcp") || words.next().as_deref() != Some("add") {
        return Err(format!("only `{tool} mcp add …` commands can be read"));
    }
    let mut env = BTreeMap::new();
    let mut headers = BTreeMap::new();
    let mut url: Option<String> = None;
    let mut positional: Vec<String> = Vec::new();
    let mut after_dashes = false;
    let pair = |text: &str, separator: char| text.split_once(separator).map(|(key, value)| (key.trim().to_string(), value.trim().to_string()));
    while let Some(word) = words.next() {
        if after_dashes {
            positional.push(word);
            continue;
        }
        match word.as_str() {
            "--" => after_dashes = true,
            "-e" | "--env" => {
                if let Some((key, value)) = words.next().as_deref().and_then(|value| pair(value, '=')) {
                    env.insert(key, value);
                }
            }
            "-H" | "--header" => {
                if let Some((key, value)) = words.next().as_deref().and_then(|value| pair(value, ':')) {
                    headers.insert(key, value);
                }
            }
            "--url" => url = words.next(),
            "--bearer-token-env-var" => {
                if let Some(variable) = words.next() {
                    headers.insert("Authorization".into(), format!("Bearer ${{{variable}}}"));
                }
            }
            "-s" | "--scope" | "-t" | "--transport" | "--type" | "-c" | "--config" => {
                words.next();
            }
            flag if flag.starts_with('-') => {}
            _ => positional.push(word),
        }
    }
    if positional.is_empty() {
        return Err("the command names no server".into());
    }
    let server_name = tidy_name(&positional.remove(0));
    let name = name.map(tidy_name).unwrap_or(server_name);
    if let Some(url) = url.or_else(|| positional.first().filter(|first| first.starts_with("http://") || first.starts_with("https://")).cloned()) {
        return Ok(McpServerSpec { name, transport: McpTransport::Http { url, headers } });
    }
    if positional.is_empty() {
        return Err("the command names no program to run".into());
    }
    let command = positional.remove(0);
    Ok(McpServerSpec { name, transport: McpTransport::Stdio { command, args: positional, env } })
}

/// A name from a package: `@playwright/mcp@latest` → `playwright`.
fn guess_name(command: &str, args: &[String]) -> String {
    let package = args.iter().find(|arg| !arg.starts_with('-')).cloned().unwrap_or_else(|| command.to_string());
    let base = package.rsplit('/').next().unwrap_or(&package);
    let base = base.split('@').find(|part| !part.is_empty()).unwrap_or(base);
    let scope = package.strip_prefix('@').and_then(|rest| rest.split('/').next()).unwrap_or("");
    let name = if base == "mcp" && !scope.is_empty() { scope.to_string() } else { base.trim_start_matches("mcp-server-").trim_start_matches("server-").trim_end_matches("-mcp").to_string() };
    let name = tidy_name(&name);
    if name.is_empty() { "server".into() } else { name }
}

/// Reads what a user pasted: a JSON config (`{"mcpServers": {...}}`, VS
/// Code's `{"servers": {...}}`, a bare map, or one server object), or a
/// command line. `name` names a single server that came without one.
pub fn parse_snippet(text: &str, name: Option<&str>) -> Result<Vec<McpServerSpec>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("paste a config or a command".into());
    }
    if text.starts_with('{') {
        let value: Value = serde_json::from_str(text).map_err(|error| format!("that is not valid JSON: {error}"))?;
        let map = value
            .get("mcpServers")
            .or_else(|| value.get("servers"))
            .or_else(|| value.get("mcp").and_then(|mcp| mcp.get("servers")))
            .and_then(Value::as_object)
            .cloned();
        let map: Map<String, Value> = match map {
            Some(map) => map,
            None if value.get("command").is_some() || value.get("url").is_some() || value.get("serverUrl").is_some() => {
                let name = name.map(str::to_string).or_else(|| value.get("name").and_then(Value::as_str).map(str::to_string)).ok_or("give the server a name")?;
                let mut single = Map::new();
                single.insert(name, value.clone());
                single
            }
            None => value.as_object().cloned().ok_or("expected an object of servers")?,
        };
        let specs: Result<Vec<_>, _> = map.iter().map(|(name, entry)| spec_from_json(name, entry)).collect();
        let specs = specs?;
        if specs.is_empty() {
            return Err("no servers in that config".into());
        }
        return Ok(specs);
    }
    Ok(vec![spec_from_command(text, name)?])
}

/// Environment variables a server's values refer to as `${NAME}`.
pub fn references(spec: &McpServerSpec) -> Vec<String> {
    let values: Vec<&String> = match &spec.transport {
        McpTransport::Stdio { env, args, .. } => env.values().chain(args.iter()).collect(),
        McpTransport::Http { headers, url } => headers.values().chain(std::iter::once(url)).collect(),
    };
    let mut names = Vec::new();
    for value in values {
        let mut rest = value.as_str();
        while let Some(start) = rest.find("${") {
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else { break };
            let name = &after[..end];
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !names.iter().any(|known| known == name) {
                names.push(name.to_string());
            }
            rest = &after[end..];
        }
    }
    names
}

/// The arguments for a provider's own `mcp add`.
pub fn install_args(provider: Provider, spec: &McpServerSpec, scope: McpScope) -> Result<Vec<String>, String> {
    if !valid_name(&spec.name) {
        return Err(format!("\"{}\" is not a usable server name: letters, digits, - and _ only", spec.name));
    }
    match provider {
        Provider::Claude => {
            let json = match &spec.transport {
                McpTransport::Stdio { command, args, env } => json!({ "type": "stdio", "command": command, "args": args, "env": env }),
                McpTransport::Http { url, headers } => json!({ "type": "http", "url": url, "headers": headers }),
            };
            let scope = match scope {
                McpScope::Local => "local",
                _ => "user",
            };
            Ok(vec!["mcp".into(), "add-json".into(), "-s".into(), scope.into(), spec.name.clone(), json.to_string()])
        }
        Provider::Codex => {
            let mut args = vec!["mcp".into(), "add".into(), spec.name.clone()];
            match &spec.transport {
                McpTransport::Stdio { command, args: rest, env } => {
                    for (key, value) in env {
                        // A reference is forwarded from the session's
                        // environment instead (`env_vars`), never written.
                        if value != &format!("${{{key}}}") {
                            args.push("--env".into());
                            args.push(format!("{key}={value}"));
                        }
                    }
                    args.push("--".into());
                    args.push(command.clone());
                    args.extend(rest.iter().cloned());
                }
                McpTransport::Http { url, headers } => {
                    args.push("--url".into());
                    args.push(url.clone());
                    for (key, value) in headers {
                        let variable = value.strip_prefix("Bearer ${").and_then(|rest| rest.strip_suffix('}'));
                        match (key.eq_ignore_ascii_case("authorization"), variable) {
                            (true, Some(variable)) => {
                                args.push("--bearer-token-env-var".into());
                                args.push(variable.to_string());
                            }
                            _ => return Err(format!("Codex takes an HTTP server's credentials only as `Authorization: Bearer ${{VARIABLE}}`; the {key} header cannot be set through it")),
                        }
                    }
                }
            }
            Ok(args)
        }
        Provider::Gemini => {
            let mut args = vec!["mcp".into(), "add".into()];
            match &spec.transport {
                McpTransport::Stdio { command, args: rest, env } => {
                    for (key, value) in env {
                        args.push("--env".into());
                        args.push(format!("{key}={value}"));
                    }
                    args.push(spec.name.clone());
                    args.push("--".into());
                    args.push(command.clone());
                    args.extend(rest.iter().cloned());
                }
                McpTransport::Http { url, headers } => {
                    for (key, value) in headers {
                        args.push("--header".into());
                        args.push(format!("{key}: {value}"));
                    }
                    args.push(spec.name.clone());
                    args.push(url.clone());
                }
            }
            Ok(args)
        }
    }
}

/// The arguments for a provider's own `mcp remove`.
pub fn remove_args(provider: Provider, name: &str, scope: McpScope) -> Vec<String> {
    match provider {
        Provider::Claude => vec!["mcp".into(), "remove".into(), "-s".into(), if scope == McpScope::Local { "local".into() } else { "user".into() }, name.into()],
        Provider::Codex | Provider::Gemini => vec!["mcp".into(), "remove".into(), name.into()],
    }
}

/// After `codex mcp add`: the variables the server's values referred to are
/// forwarded from the session's environment (`env_vars`). Comment-preserving.
pub fn codex_forward_env(config: &Path, name: &str, variables: &[String]) -> Result<(), DesktopError> {
    if variables.is_empty() {
        return Ok(());
    }
    let text = std::fs::read_to_string(config).map_err(|error| DesktopError::io(format!("could not read {}: {error}", config.display())))?;
    let mut document: toml_edit::DocumentMut = text.parse().map_err(|error| DesktopError::io(format!("{} is not valid TOML: {error}", config.display())))?;
    let server = document
        .get_mut("mcp_servers")
        .and_then(|servers| servers.get_mut(name))
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or_else(|| DesktopError::not_ready(format!("Codex did not record the server {name}")))?;
    let mut list = toml_edit::Array::new();
    for variable in variables {
        list.push(variable.as_str());
    }
    server.insert("env_vars", toml_edit::value(list));
    std::fs::write(config, document.to_string()).map_err(|error| DesktopError::io(error.to_string()))?;
    Ok(())
}

/// What a test start of a server found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub server: Option<String>,
    pub version: Option<String>,
    pub tools: Vec<String>,
}

/// Expands `${NAME}` from `env`.
fn expand(value: &str, env: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                out.push_str(env.get(&after[..end]).map(String::as_str).unwrap_or(""));
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn tools_of(result: &Value) -> Vec<String> {
    result.get("tools").and_then(Value::as_array).map(|tools| tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default()
}

fn server_info(result: &Value) -> (Option<String>, Option<String>) {
    let info = result.get("serverInfo");
    (info.and_then(|info| info.get("name")).and_then(Value::as_str).map(str::to_string), info.and_then(|info| info.get("version")).and_then(Value::as_str).map(str::to_string))
}

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"thingmaker","version":"0"}}}"#;

/// Starts the server the way a session would and asks it for its tools.
/// `env` is the environment a session gets, which `${NAME}` values expand
/// from. A first `npx` start downloads the package, so the timeout is long.
pub fn probe(spec: &McpServerSpec, env: &HashMap<String, String>, cwd: &Path, timeout: Duration) -> Result<ProbeResult, String> {
    match &spec.transport {
        McpTransport::Stdio { command, args, env: own } => {
            let mut child = Command::new(command)
                .args(args.iter().map(|arg| expand(arg, env)))
                .current_dir(cwd)
                .env_clear()
                .envs(env)
                .envs(own.iter().map(|(key, value)| (key.clone(), expand(value, env))))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("could not start {command}: {error}"))?;
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            let stdout = child.stdout.take().ok_or("no stdout")?;
            let stderr = child.stderr.take();
            let (sender, receiver) = mpsc::channel::<Value>();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Ok(value) = serde_json::from_str::<Value>(&line)
                        && sender.send(value).is_err()
                    {
                        break;
                    }
                }
            });
            let (error_sender, error_receiver) = mpsc::channel::<String>();
            if let Some(stderr) = stderr {
                std::thread::spawn(move || {
                    let tail: Vec<String> = BufReader::new(stderr).lines().map_while(Result::ok).collect();
                    let _ = error_sender.send(tail.into_iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"));
                });
            }
            let deadline = std::time::Instant::now() + timeout;
            let wait_for = |id: i64| -> Result<Value, String> {
                loop {
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    match receiver.recv_timeout(left) {
                        Ok(message) if message.get("id").and_then(Value::as_i64) == Some(id) => {
                            if let Some(error) = message.get("error") {
                                return Err(error.get("message").and_then(Value::as_str).unwrap_or("the server answered with an error").to_string());
                            }
                            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                        }
                        Ok(_) => continue,
                        Err(_) => return Err("no answer in time".into()),
                    }
                }
            };
            let outcome = (|| {
                writeln!(stdin, "{INITIALIZE}").map_err(|error| error.to_string())?;
                let initialized = wait_for(1)?;
                writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).map_err(|error| error.to_string())?;
                writeln!(stdin, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#).map_err(|error| error.to_string())?;
                let listed = wait_for(2).unwrap_or(Value::Null);
                let (server, version) = server_info(&initialized);
                Ok::<_, String>(ProbeResult { server, version, tools: tools_of(&listed) })
            })();
            let _ = child.kill();
            let _ = child.wait();
            outcome.map_err(|error| {
                let tail = error_receiver.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
                if tail.trim().is_empty() { error } else { format!("{error}\n{tail}") }
            })
        }
        McpTransport::Http { url, headers } => {
            let client = reqwest::blocking::Client::builder().timeout(timeout).build().map_err(|error| error.to_string())?;
            let post = |body: &str, session: Option<&str>| {
                let mut request = client.post(url).header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream").body(body.to_string());
                for (key, value) in headers {
                    request = request.header(key, expand(value, env));
                }
                if let Some(session) = session {
                    request = request.header("Mcp-Session-Id", session);
                }
                request.send().map_err(|error| error.to_string())
            };
            let read = |response: reqwest::blocking::Response| -> Result<Value, String> {
                let status = response.status();
                let text = response.text().map_err(|error| error.to_string())?;
                if !status.is_success() {
                    return Err(format!("the server answered {status}{}", if status.as_u16() == 401 { " — it needs credentials (a header, or a sign-in the provider runs)" } else { "" }));
                }
                // Streamable HTTP may answer as an event stream.
                let body = text.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim).find(|line| line.starts_with('{')).map(str::to_string).unwrap_or(text);
                let message: Value = serde_json::from_str(&body).map_err(|_| "the answer was not JSON-RPC".to_string())?;
                if let Some(error) = message.get("error") {
                    return Err(error.get("message").and_then(Value::as_str).unwrap_or("error").to_string());
                }
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let response = post(INITIALIZE, None)?;
            let session = response.headers().get("mcp-session-id").and_then(|value| value.to_str().ok()).map(str::to_string);
            let initialized = read(response)?;
            let _ = post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, session.as_deref());
            let listed = post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#, session.as_deref()).and_then(read).unwrap_or(Value::Null);
            let (server, version) = server_info(&initialized);
            Ok(ProbeResult { server, version, tools: tools_of(&listed) })
        }
    }
}

/// A well-known server, one click to install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub homepage: &'static str,
    /// The server, with `{folder}` standing for the workspace root.
    pub spec: McpServerSpec,
    /// What has to be installed for it to start: `node` (npx) or `uv` (uvx).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs: Option<&'static str>,
    /// Environment variables it reads a secret from, with where to get one.
    pub secrets: Vec<(&'static str, &'static str)>,
}

fn stdio(name: &str, command: &str, args: &[&str]) -> McpServerSpec {
    McpServerSpec { name: name.into(), transport: McpTransport::Stdio { command: command.into(), args: args.iter().map(|arg| arg.to_string()).collect(), env: BTreeMap::new() } }
}

pub fn catalog() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry { id: "playwright", title: "Playwright", description: "Drive a real browser: open pages, click, type, read the page and take screenshots.", homepage: "https://github.com/microsoft/playwright-mcp", spec: stdio("playwright", "npx", &["-y", "@playwright/mcp@latest"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry { id: "chrome-devtools", title: "Chrome DevTools", description: "Inspect and debug a live Chrome: console, network, performance traces.", homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp", spec: stdio("chrome-devtools", "npx", &["-y", "chrome-devtools-mcp@latest"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry { id: "context7", title: "Context7", description: "Current documentation and code examples for libraries, fetched when the agent asks.", homepage: "https://github.com/upstash/context7", spec: stdio("context7", "npx", &["-y", "@upstash/context7-mcp@latest"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry { id: "fetch", title: "Fetch", description: "Fetch a web page and hand it to the agent as Markdown.", homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch", spec: stdio("fetch", "uvx", &["mcp-server-fetch"]), needs: Some("uv"), secrets: vec![] },
        CatalogEntry { id: "filesystem", title: "Filesystem", description: "Read and write files in one folder, outside the agent's own tools.", homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem", spec: stdio("filesystem", "npx", &["-y", "@modelcontextprotocol/server-filesystem", "{folder}"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry { id: "sequential-thinking", title: "Sequential thinking", description: "A scratchpad for step-by-step reasoning the agent can revise.", homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking", spec: stdio("sequential-thinking", "npx", &["-y", "@modelcontextprotocol/server-sequential-thinking"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry { id: "memory", title: "Knowledge graph memory", description: "A persistent graph of entities and facts the agent can store and recall.", homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory", spec: stdio("memory", "npx", &["-y", "@modelcontextprotocol/server-memory"]), needs: Some("node"), secrets: vec![] },
        CatalogEntry {
            id: "github",
            title: "GitHub",
            description: "Issues, pull requests, code search and Actions, through GitHub's own hosted server.",
            homepage: "https://github.com/github/github-mcp-server",
            spec: McpServerSpec {
                name: "github".into(),
                transport: McpTransport::Http { url: "https://api.githubcopilot.com/mcp/".into(), headers: BTreeMap::from([("Authorization".into(), "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}".into())]) },
            },
            needs: None,
            secrets: vec![("GITHUB_PERSONAL_ACCESS_TOKEN", "a personal access token from github.com/settings/tokens")],
        },
        CatalogEntry {
            id: "figma",
            title: "Figma (desktop app)",
            description: "Frames, components and variables from the Figma desktop app's local Dev Mode server.",
            homepage: "https://help.figma.com/hc/en-us/articles/32132100833559",
            spec: McpServerSpec { name: "figma".into(), transport: McpTransport::Http { url: "http://127.0.0.1:3845/mcp".into(), headers: BTreeMap::new() } },
            needs: None,
            secrets: vec![],
        },
    ]
}

/// The catalog entry with `{folder}` filled in.
pub fn catalog_spec(id: &str, folder: &Path) -> Option<McpServerSpec> {
    let mut spec = catalog().into_iter().find(|entry| entry.id == id)?.spec;
    if let McpTransport::Stdio { args, .. } = &mut spec.transport {
        for arg in args.iter_mut() {
            *arg = arg.replace("{folder}", &folder.to_string_lossy());
        }
    }
    Some(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_config_in_any_common_shape_reads_as_servers() {
        let claude = parse_snippet(r#"{"mcpServers": {"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}, "remote": {"type": "http", "url": "https://x.dev/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}}}"#, None).unwrap();
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0].name, "playwright");
        assert!(matches!(&claude[1].transport, McpTransport::Http { url, headers } if url == "https://x.dev/mcp" && headers["Authorization"] == "Bearer ${TOKEN}"));
        let vscode = parse_snippet(r#"{"servers": {"fs": {"command": "npx -y @modelcontextprotocol/server-filesystem /work"}}}"#, None).unwrap();
        assert!(matches!(&vscode[0].transport, McpTransport::Stdio { command, args, .. } if command == "npx" && args == &["-y", "@modelcontextprotocol/server-filesystem", "/work"]));
        let single = parse_snippet(r#"{"command": "uvx", "args": ["mcp-server-fetch"]}"#, Some("fetch")).unwrap();
        assert_eq!(single[0].name, "fetch");
        assert!(parse_snippet(r#"{"command": "uvx"}"#, None).is_err(), "a single server needs a name");
        let gemini = parse_snippet(r#"{"mcpServers": {"web": {"serverUrl": "https://a.b/mcp"}}}"#, None).unwrap();
        assert!(matches!(&gemini[0].transport, McpTransport::Http { .. }));
    }

    #[test]
    fn a_pasted_command_line_reads_as_a_server() {
        let claude = parse_snippet("claude mcp add my-server -e API_KEY=${KEY} -- npx my-mcp-server --flag", None).unwrap();
        assert_eq!(claude[0].name, "my-server");
        assert!(matches!(&claude[0].transport, McpTransport::Stdio { command, args, env } if command == "npx" && args == &["my-mcp-server", "--flag"] && env["API_KEY"] == "${KEY}"));
        let http = parse_snippet("claude mcp add --transport http sentry https://mcp.sentry.dev/mcp --header \"X-Key: abc\"", None).unwrap();
        assert!(matches!(&http[0].transport, McpTransport::Http { url, headers } if url == "https://mcp.sentry.dev/mcp" && headers["X-Key"] == "abc"));
        let codex = parse_snippet("codex mcp add web --url https://a.b/mcp --bearer-token-env-var TOK", None).unwrap();
        assert!(matches!(&codex[0].transport, McpTransport::Http { headers, .. } if headers["Authorization"] == "Bearer ${TOK}"));
        let bare = parse_snippet("npx -y @playwright/mcp@latest", None).unwrap();
        assert_eq!(bare[0].name, "playwright");
        assert_eq!(parse_snippet("uvx mcp-server-fetch", None).unwrap()[0].name, "fetch");
        assert_eq!(parse_snippet("npx -y @upstash/context7-mcp", None).unwrap()[0].name, "context7");
        assert!(parse_snippet("claude mcp list", None).is_err());
    }

    #[test]
    fn each_provider_gets_its_own_mcp_add() {
        let spec = McpServerSpec { name: "gh".into(), transport: McpTransport::Stdio { command: "npx".into(), args: vec!["-y".into(), "gh-mcp".into()], env: BTreeMap::from([("GITHUB_TOKEN".into(), "${GITHUB_TOKEN}".into()), ("MODE".into(), "ro".into())]) } };
        let claude = install_args(Provider::Claude, &spec, McpScope::User).unwrap();
        assert_eq!(&claude[..5], ["mcp", "add-json", "-s", "user", "gh"]);
        assert!(claude[5].contains("\"GITHUB_TOKEN\":\"${GITHUB_TOKEN}\""), "Claude Code expands the reference itself");
        let codex = install_args(Provider::Codex, &spec, McpScope::User).unwrap();
        assert_eq!(codex, ["mcp", "add", "gh", "--env", "MODE=ro", "--", "npx", "-y", "gh-mcp"], "a reference is forwarded, never written");
        assert_eq!(references(&spec), ["GITHUB_TOKEN"]);
        let agy = install_args(Provider::Gemini, &spec, McpScope::User).unwrap();
        assert_eq!(&agy[..2], ["mcp", "add"]);
        assert!(agy.contains(&"gh".to_string()) && agy.iter().position(|a| a == "gh") < agy.iter().position(|a| a == "--"), "flags before the name");
        let web = McpServerSpec { name: "web".into(), transport: McpTransport::Http { url: "https://a.b/mcp".into(), headers: BTreeMap::from([("Authorization".into(), "Bearer ${TOK}".into())]) } };
        assert_eq!(install_args(Provider::Codex, &web, McpScope::User).unwrap(), ["mcp", "add", "web", "--url", "https://a.b/mcp", "--bearer-token-env-var", "TOK"]);
        let keyed = McpServerSpec { name: "web".into(), transport: McpTransport::Http { url: "https://a.b".into(), headers: BTreeMap::from([("X-Key".into(), "abc".into())]) } };
        assert!(install_args(Provider::Codex, &keyed, McpScope::User).is_err());
        let bad = McpServerSpec { name: "no spaces".into(), ..spec };
        assert!(install_args(Provider::Claude, &bad, McpScope::User).is_err());
        assert_eq!(remove_args(Provider::Claude, "gh", McpScope::Local), ["mcp", "remove", "-s", "local", "gh"]);
    }

    #[test]
    fn installed_servers_are_read_from_every_provider_without_their_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let root = home.join("work");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            serde_json::to_string(&json!({"mcpServers": {"a": {"command": "npx", "args": ["x"], "env": {"TOKEN": "secret"}}}, "projects": {root.to_string_lossy(): {"mcpServers": {"b": {"type": "http", "url": "https://b"}}}}})).unwrap(),
        )
        .unwrap();
        std::fs::write(root.join(".mcp.json"), r#"{"mcpServers": {"c": {"command": "uvx", "args": ["c"]}}}"#).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "# keep\n[mcp_servers.d]\ncommand = \"npx\"\nargs = [\"d\"]\n[mcp_servers.d.env]\nKEY = \"secret\"\n").unwrap();
        std::fs::create_dir_all(home.join(".gemini/config")).unwrap();
        std::fs::write(home.join(".gemini/config/mcp_config.json"), r#"{"mcpServers": {"e": {"serverUrl": "https://e", "disabled": true, "headers": {"Authorization": "Bearer s"}}}}"#).unwrap();
        let homes = ConfigHomes { home: home.to_path_buf(), ..ConfigHomes::default() };
        let servers = installed(&homes, Some(&root));
        let summary: Vec<(String, Provider, McpScope)> = servers.iter().map(|server| (server.name.clone(), server.provider, server.scope)).collect();
        assert_eq!(summary, [("a".into(), Provider::Claude, McpScope::User), ("b".into(), Provider::Claude, McpScope::Local), ("c".into(), Provider::Claude, McpScope::Project), ("d".into(), Provider::Codex, McpScope::User), ("e".into(), Provider::Gemini, McpScope::User)]);
        let text = serde_json::to_string(&servers).unwrap();
        assert!(!text.contains("secret") && !text.contains("Bearer s"), "values never leave");
        assert_eq!(servers[0].env_keys, ["TOKEN"]);
        assert!(!servers[4].enabled);
        codex_forward_env(&homes.codex_config(), "d", &["GITHUB_TOKEN".into()]).unwrap();
        let config = std::fs::read_to_string(homes.codex_config()).unwrap();
        assert!(config.starts_with("# keep") && config.contains("env_vars = [\"GITHUB_TOKEN\"]"), "{config}");
    }

    #[test]
    fn a_test_start_lists_the_tools_of_a_stdio_server() {
        let Ok(python) = which_python() else { return };
        let script = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"serverInfo": {"name": "demo", "version": "1.2"}, "capabilities": {}}}), flush=True)
    elif m.get("method") == "tools/list":
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": [{"name": "echo"}, {"name": "add"}]}}), flush=True)
"#;
        let spec = McpServerSpec { name: "demo".into(), transport: McpTransport::Stdio { command: python, args: vec!["-c".into(), script.into()], env: BTreeMap::new() } };
        let env: HashMap<String, String> = std::env::vars().collect();
        let result = probe(&spec, &env, &std::env::temp_dir(), Duration::from_secs(20)).unwrap();
        assert_eq!(result, ProbeResult { server: Some("demo".into()), version: Some("1.2".into()), tools: vec!["echo".into(), "add".into()] });
        let missing = McpServerSpec { name: "x".into(), transport: McpTransport::Stdio { command: "/nonexistent/program".into(), args: vec![], env: BTreeMap::new() } };
        assert!(probe(&missing, &env, &std::env::temp_dir(), Duration::from_secs(2)).unwrap_err().contains("could not start"));
    }

    fn which_python() -> Result<String, ()> {
        for candidate in ["python3", "python"] {
            if Command::new(candidate).arg("--version").output().is_ok_and(|output| output.status.success()) {
                return Ok(candidate.to_string());
            }
        }
        Err(())
    }

    #[test]
    fn the_catalog_fills_in_the_folder_and_names_are_valid() {
        for entry in catalog() {
            assert!(valid_name(&entry.spec.name), "{}", entry.id);
        }
        let spec = catalog_spec("filesystem", Path::new("/work/app")).unwrap();
        assert!(matches!(spec.transport, McpTransport::Stdio { args, .. } if args.last().map(String::as_str) == Some("/work/app")));
        assert_eq!(references(&catalog_spec("github", Path::new("/")).unwrap()), ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    }
}
