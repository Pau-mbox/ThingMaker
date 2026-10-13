//! Which version of each provider's program is installed, whether a newer
//! one is out, and how to update it.
//!
//! The Codex app and Claude Desktop keep the agents they bundle current by
//! themselves; ThingMaker runs whatever is installed, so it has to say when
//! that falls behind (the Claude adapter here was five releases old when this
//! was written). Every answer and every update comes from the provider's own
//! tooling, never a download of ThingMaker's:
//!
//! - the Claude adapter is a global npm package, so its version is in its
//!   `package.json`, the newest is `npm view`, and an update is `npm install
//!   -g` with the npm installed beside it, into the prefix it already lives in;
//! - a Codex inside an app (the ChatGPT app ships one) updates with that app;
//!   an npm-installed one updates like the adapter; anything else with its
//!   own `codex update`;
//! - Antigravity's `agy` updates with `agy update` (it also updates itself).

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use serde::Serialize;

use super::Provider;
use crate::security::EnvironmentProfile;

const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const VIEW_TIMEOUT: Duration = Duration::from_secs(45);
pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(600);
const OUTPUT_TAIL_BYTES: usize = 4096;

/// The newest release of each provider's program that ThingMaker was last
/// checked against (docs/release.md, REL-07). An update past it is allowed,
/// and said so: renamed ids are what bite (0.89 renamed Fable's).
pub fn tested_with(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Claude => Some("0.89.1"),
        Provider::Codex | Provider::Gemini => None,
    }
}

/// A global npm install: the package and the Node toolchain it came with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpmInstall {
    pub package_dir: PathBuf,
    pub name: String,
    pub version: Option<String>,
    /// The global prefix (`<prefix>/lib/node_modules/...`).
    pub prefix: PathBuf,
    pub node: PathBuf,
    pub npm_cli: PathBuf,
}

/// How a provider's program is kept current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Channel {
    Npm(NpmInstall),
    /// The program's own `update` subcommand.
    SelfUpdate { program: PathBuf },
    /// Shipped inside an app, which updates it.
    App { app: String },
    /// Installed some other way; `hint` says how to update it.
    Unmanaged { hint: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderVersion {
    pub provider: Provider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<String>,
    /// The newest release, where it can be asked without updating.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    pub update_available: bool,
    /// The release ThingMaker was last checked against, where it keeps one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tested: Option<String>,
    /// ThingMaker can run the update itself.
    pub can_update: bool,
    /// How it updates, in words.
    pub how: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

impl ProviderVersion {
    pub fn missing(provider: Provider, problem: impl Into<String>) -> Self {
        Self { provider, installed: None, latest: None, update_available: false, tested: None, can_update: false, how: String::new(), problem: Some(problem.into()) }
    }
}

/// The npm global install a package directory belongs to, when it is one:
/// `<prefix>/lib/node_modules/[@scope/]name`, with `node` and npm installed
/// under the same prefix (nvm, Homebrew and the Node installer all lay it
/// out this way).
pub fn npm_install(package_dir: &Path) -> Option<NpmInstall> {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    let name = manifest.get("name")?.as_str()?.to_string();
    let modules = package_dir.ancestors().find(|dir| dir.file_name().is_some_and(|name| name == "node_modules"))?;
    let lib = modules.parent().filter(|dir| dir.file_name().is_some_and(|name| name == "lib"))?;
    let prefix = lib.parent()?.to_path_buf();
    let node = prefix.join("bin/node");
    let npm_cli = prefix.join("lib/node_modules/npm/bin/npm-cli.js");
    (node.is_file() && npm_cli.is_file()).then(|| NpmInstall {
        package_dir: package_dir.to_path_buf(),
        name,
        version: manifest.get("version").and_then(|value| value.as_str()).map(str::to_string),
        prefix,
        node,
        npm_cli,
    })
}

/// The package directory that holds `file`, by the nearest `package.json`
/// naming `name`.
fn package_dir_of(file: &Path, name: &str) -> Option<PathBuf> {
    file.ancestors().skip(1).take(6).find(|dir| {
        std::fs::read(dir.join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|manifest| manifest.get("name").and_then(|value| value.as_str()) == Some(name))
    })
    .map(Path::to_path_buf)
}

/// How a provider's resolved program updates. `prefix_args` carries the
/// Claude adapter's script, which is what the version belongs to (the
/// program is the Node that runs it).
pub fn channel(provider: Provider, program: &Path, prefix_args: &[String]) -> Channel {
    match provider {
        Provider::Claude => {
            let script = prefix_args.first().map(PathBuf::from);
            match script.as_deref().and_then(|script| package_dir_of(script, super::claude::launch::ADAPTER_PACKAGE)).and_then(|dir| npm_install(&dir)) {
                Some(install) => Channel::Npm(install),
                None => Channel::Unmanaged { hint: format!("Update it with `npm install -g {}@latest`.", super::claude::launch::ADAPTER_PACKAGE) },
            }
        }
        Provider::Codex => {
            let real = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
            let text = real.to_string_lossy();
            if let Some(end) = text.find(".app/Contents/") {
                let app = Path::new(&text[..end]).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "its app".into());
                return Channel::App { app };
            }
            if let Some(install) = package_dir_of(&real, "@openai/codex").and_then(|dir| npm_install(&dir)) {
                return Channel::Npm(install);
            }
            if text.contains("/Cellar/") || text.starts_with("/opt/homebrew/") {
                return Channel::Unmanaged { hint: "Installed with Homebrew: update it with `brew upgrade codex`.".into() };
            }
            Channel::SelfUpdate { program: program.to_path_buf() }
        }
        Provider::Gemini => Channel::SelfUpdate { program: program.to_path_buf() },
    }
}

/// The first `1.2.3`-shaped word in a program's `--version` output
/// (`codex-cli 0.162.0-alpha.17.2`, `1.3.4`).
pub fn version_in(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|word| word.trim_start_matches('v').trim_end_matches(|c: char| !c.is_ascii_alphanumeric()))
        .find(|word| {
            let core = word.split(['-', '+']).next().unwrap_or("");
            let parts: Vec<&str> = core.split('.').collect();
            parts.len() >= 2 && parts.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_string)
}

/// Whether `latest` is a later release than `installed`. A pre-release is
/// older than its release; anything that does not parse is not newer.
pub fn newer(latest: &str, installed: &str) -> bool {
    fn parse(version: &str) -> Option<(Vec<u64>, bool)> {
        let (core, pre) = match version.split_once('-') {
            Some((core, _)) => (core, true),
            None => (version.split('+').next().unwrap_or(version), false),
        };
        let numbers = core.split('.').map(|part| part.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
        Some((numbers, pre))
    }
    let (Some((a, a_pre)), Some((b, b_pre))) = (parse(latest), parse(installed)) else { return false };
    let width = a.len().max(b.len());
    let pad = |mut v: Vec<u64>| {
        v.resize(width, 0);
        v
    };
    match pad(a).cmp(&pad(b)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => b_pre && !a_pre,
    }
}

/// Runs a command to completion with a deadline, reading both streams as it
/// goes (an `npm install` that fills a pipe nobody reads would hang until the
/// deadline). Returns success and the tail of what it printed.
pub fn run_capturing(mut command: Command, timeout: Duration) -> Result<(bool, String), String> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| error.to_string())?;
    let drain = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let out = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it did not finish within {}s", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let mut text = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    let tail = match text.char_indices().rev().nth(OUTPUT_TAIL_BYTES) {
        Some((cut, _)) => text[cut..].to_string(),
        None => text,
    };
    Ok((status.success(), tail.trim().to_string()))
}

/// The environment a provider's tooling runs in: the same trusted-local
/// profile sessions get, with the install's own Node first on `PATH` so npm
/// and its scripts use it.
fn command(program: &Path, node_bin: Option<&Path>) -> Command {
    let mut env = EnvironmentProfile::trusted_local().resolve(std::env::vars());
    if let Some(bin) = node_bin {
        let path = env.get("PATH").cloned().unwrap_or_else(|| "/usr/bin:/bin".into());
        env.insert("PATH".into(), format!("{}:{path}", bin.display()));
    }
    let mut command = Command::new(program);
    command.env_clear().envs(env).current_dir(std::env::temp_dir());
    command
}

fn npm(install: &NpmInstall, args: &[&str]) -> Command {
    let mut command = command(&install.node, install.node.parent());
    command.arg(&install.npm_cli).args(args);
    command
}

fn version_of(program: &Path) -> Result<String, String> {
    let mut command = command(program, None);
    command.arg("--version");
    let (ok, output) = run_capturing(command, VERSION_TIMEOUT)?;
    version_in(&output).ok_or_else(|| if ok { format!("`--version` printed no version: {output}") } else { format!("`--version` failed: {output}") })
}

/// Installed and (when `ask_latest`) newest versions, and how it updates.
pub fn check(provider: Provider, program: &Path, prefix_args: &[String], ask_latest: bool) -> ProviderVersion {
    let mut answer = ProviderVersion {
        provider,
        installed: None,
        latest: None,
        update_available: false,
        tested: tested_with(provider).map(str::to_string),
        can_update: false,
        how: String::new(),
        problem: None,
    };
    match channel(provider, program, prefix_args) {
        Channel::Npm(install) => {
            answer.installed = install.version.clone();
            answer.can_update = true;
            answer.how = format!("npm package {} in {}", install.name, install.prefix.display());
            if ask_latest {
                match run_capturing(npm(&install, &["view", &install.name, "version"]), VIEW_TIMEOUT) {
                    Ok((true, output)) => answer.latest = version_in(&output),
                    Ok((false, output)) | Err(output) => answer.problem = Some(format!("could not ask npm for the newest version: {output}")),
                }
            }
        }
        Channel::SelfUpdate { program } => {
            answer.can_update = true;
            answer.how = format!("its own `{} update`", program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
            match version_of(&program) {
                Ok(version) => answer.installed = Some(version),
                Err(problem) => answer.problem = Some(problem),
            }
        }
        Channel::App { app } => {
            answer.how = format!("updates with {app}");
            match version_of(program) {
                Ok(version) => answer.installed = Some(version),
                Err(problem) => answer.problem = Some(problem),
            }
        }
        Channel::Unmanaged { hint } => {
            answer.how = hint;
            match version_of(program) {
                Ok(version) => answer.installed = Some(version),
                Err(problem) => answer.problem = Some(problem),
            }
        }
    }
    answer.update_available = match (&answer.latest, &answer.installed) {
        (Some(latest), Some(installed)) => newer(latest, installed),
        _ => false,
    };
    answer
}

/// Runs the provider's own update and returns the tail of what it printed.
/// Sessions already open keep the program they started with; new sessions
/// start the updated one.
pub fn update(provider: Provider, program: &Path, prefix_args: &[String]) -> Result<String, String> {
    let (ok, output) = match channel(provider, program, prefix_args) {
        Channel::Npm(install) => {
            let prefix = install.prefix.to_string_lossy().into_owned();
            let target = format!("{}@latest", install.name);
            run_capturing(
                npm(&install, &["install", "--global", "--prefix", &prefix, "--no-fund", "--no-audit", "--loglevel=error", &target]),
                UPDATE_TIMEOUT,
            )?
        }
        Channel::SelfUpdate { program } => {
            let mut command = command(&program, None);
            command.arg("update");
            run_capturing(command, UPDATE_TIMEOUT)?
        }
        Channel::App { app } => return Err(format!("This one ships inside {app}; update {app} and it comes along.")),
        Channel::Unmanaged { hint } => return Err(hint),
    };
    if ok { Ok(output) } else { Err(if output.is_empty() { "the update failed without saying why".into() } else { output }) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_releases() {
        assert!(newer("0.89.1", "0.84.0"));
        assert!(newer("0.10.0", "0.9.9"), "numerically, not as text");
        assert!(!newer("0.84.0", "0.84.0"));
        assert!(!newer("0.84.0", "0.89.1"));
        assert!(newer("1.0.0", "1.0.0-rc.1"), "a release is newer than its pre-release");
        assert!(!newer("1.0.0-rc.2", "1.0.0"));
        assert!(newer("2.1", "2.0.9"));
        assert!(!newer("garbage", "1.0.0"));
    }

    #[test]
    fn a_version_is_read_out_of_what_a_program_prints() {
        assert_eq!(version_in("codex-cli 0.162.0-alpha.17.2").as_deref(), Some("0.162.0-alpha.17.2"));
        assert_eq!(version_in("1.3.4\n").as_deref(), Some("1.3.4"));
        assert_eq!(version_in("0.89.1").as_deref(), Some("0.89.1"));
        assert_eq!(version_in("Antigravity CLI v2.0.1 (build 7)").as_deref(), Some("2.0.1"));
        assert_eq!(version_in("no version here"), None);
    }

    fn fake_prefix(root: &Path, package: &str, version: &str) -> PathBuf {
        let dir = root.join("lib/node_modules").join(package);
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("package.json"), format!(r#"{{"name":"{package}","version":"{version}"}}"#)).unwrap();
        std::fs::write(dir.join("dist/index.js"), "").unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin/node"), "").unwrap();
        std::fs::create_dir_all(root.join("lib/node_modules/npm/bin")).unwrap();
        std::fs::write(root.join("lib/node_modules/npm/bin/npm-cli.js"), "").unwrap();
        dir
    }

    #[test]
    fn the_claude_adapter_is_found_as_the_global_npm_install_it_runs_from() {
        let root = tempfile::tempdir().unwrap();
        let dir = fake_prefix(root.path(), "@agentclientprotocol/claude-agent-acp", "0.84.0");
        let script = dir.join("dist/index.js").to_string_lossy().into_owned();
        let Channel::Npm(install) = channel(Provider::Claude, &root.path().join("bin/node"), &[script]) else { panic!("an npm install") };
        assert_eq!(install.version.as_deref(), Some("0.84.0"));
        assert_eq!(install.name, "@agentclientprotocol/claude-agent-acp");
        assert_eq!(install.prefix, root.path());
        assert_eq!(install.npm_cli, root.path().join("lib/node_modules/npm/bin/npm-cli.js"));
    }

    #[test]
    fn an_adapter_outside_an_npm_prefix_is_not_updated_by_guesswork() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("checkout");
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"@agentclientprotocol/claude-agent-acp","version":"0.90.0-dev"}"#).unwrap();
        let script = dir.join("dist/index.js").to_string_lossy().into_owned();
        assert!(matches!(channel(Provider::Claude, Path::new("/usr/bin/node"), &[script]), Channel::Unmanaged { .. }));
    }

    #[test]
    fn a_codex_inside_an_app_updates_with_the_app() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::write(&program, "").unwrap();
        assert_eq!(channel(Provider::Codex, &program, &[]), Channel::App { app: "ChatGPT".into() });
    }

    #[test]
    fn output_is_read_while_the_program_runs_and_its_tail_kept() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done; echo done >&2"]);
        let (ok, tail) = run_capturing(command, Duration::from_secs(20)).expect("ran");
        assert!(ok);
        assert!(tail.ends_with("done"), "stderr follows stdout: {}", &tail[tail.len().saturating_sub(40)..]);
        assert!(tail.len() <= OUTPUT_TAIL_BYTES + 8);
    }
}
