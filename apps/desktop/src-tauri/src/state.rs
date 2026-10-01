//! Application state owned by the Tauri host.
//!
//! Session actors live here, not in React components (F01): closing a pane
//! only drops a subscription. Storage access is serialized through a mutex
//! with short critical sections (no awaits while held).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use thingmaker_supervisor::{
    DesktopError,
    agents::{Provider, claude, gemini},
    storage::Storage,
    supervisor::SessionActor,
    terminal::TerminalManager,
};

/// Settings key (scope `providers`) for an explicit program location.
pub const PROVIDER_LOCATION_KEY: &str = "location";

/// Where a provider's program is, as chosen in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLocation {
    /// The executable: Node for Claude's adapter, `codex` for Codex.
    pub program: PathBuf,
    /// Claude only: the adapter's `dist/index.js`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<PathBuf>,
}

/// A provider's program, resolved: what to run, and the arguments that come
/// before anything the session adds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProvider {
    pub provider: Provider,
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
    /// How it was found: `settings`, `environment` or `discovered`.
    pub source: &'static str,
}

pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    pub actors: Mutex<HashMap<String, SessionActor>>,
    /// Canonical root per live session id, for worktree cleanup safety.
    pub actor_roots: Mutex<HashMap<String, PathBuf>>,
    /// The id the *agent* knows a live attachment by, per attachment handle.
    ///
    /// Agents choose their own session ids and only say so in the
    /// `session/new` reply, so the handle the desktop addresses a new
    /// attachment by is not the id its session row, its transcript or its
    /// resume are under. Anything that reaches storage has to go through this
    /// (docs/plans/odyssey-second-orchestrator.md §2.1).
    pub agent_session_ids: Mutex<HashMap<String, String>>,
    /// Cancellation handles for in-progress provider sign-ins by run id.
    pub auth_runs: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    pub home: Option<PathBuf>,
    pub terminals: TerminalManager,
    pub terminal_workspaces: Mutex<HashMap<String, String>>,
    pub data_dir: PathBuf,
    /// Tauri resource directory in packaged builds.
    pub resource_dir: Option<PathBuf>,
    /// Teams and jobs, and the socket agents' ThingMaker MCP children reach
    /// them on. Set once in `setup`.
    pub delegation: std::sync::OnceLock<thingmaker_supervisor::delegation::Delegation>,
    pub delegation_socket: std::sync::OnceLock<thingmaker_supervisor::delegation::socket::DelegationSocket>,
}

impl AppState {
    pub fn initialize(data_dir: &Path, resource_dir: Option<&Path>) -> Result<Self, String> {
        let storage = Storage::open(&data_dir.join("thingmaker.db")).map_err(|e| e.to_string())?;
        tracing::info!(?data_dir, "desktop state initialized");
        Ok(Self {
            storage: Arc::new(Mutex::new(storage)),
            actors: Mutex::new(HashMap::new()),
            agent_session_ids: Mutex::new(HashMap::new()),
            actor_roots: Mutex::new(HashMap::new()),
            auth_runs: Arc::new(Mutex::new(HashMap::new())),
            home: std::env::var_os("HOME").map(PathBuf::from),
            terminals: TerminalManager::new(),
            terminal_workspaces: Mutex::new(HashMap::new()),
            data_dir: data_dir.to_path_buf(),
            resource_dir: resource_dir.map(Path::to_path_buf),
            delegation: std::sync::OnceLock::new(),
            delegation_socket: std::sync::OnceLock::new(),
        })
    }

    pub fn with_storage<T>(&self, f: impl FnOnce(&Storage) -> T) -> T {
        let guard = self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&guard)
    }

    pub fn actor(&self, id: &str) -> Option<SessionActor> {
        self.actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    /// Registers a live attachment. `agent_session_id` is the id the agent
    /// itself uses.
    pub fn insert_actor(&self, id: String, agent_session_id: String, actor: SessionActor, root: PathBuf) {
        self.actor_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), root);
        self.agent_session_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), agent_session_id);
        self.actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, actor);
    }

    /// The id the agent knows this attachment by, for anything that has to
    /// find its session row, its transcript or its resume. Falls back to the
    /// handle, which is right for a resumed attachment (its handle is the
    /// agent's id).
    pub fn agent_session_id(&self, id: &str) -> String {
        self.agent_session_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_string())
    }

    pub fn remove_actor(&self, id: &str) -> Option<SessionActor> {
        self.actor_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        self.agent_session_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        self.actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id)
    }

    /// Live sessions with their canonical roots.
    pub fn actor_entries(&self) -> Vec<(String, PathBuf)> {
        self.actor_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(id, root)| (id.clone(), root.clone()))
            .collect()
    }

    /// Live session ids whose root is `root` (or inside it).
    pub fn actors_under(&self, root: &Path) -> Vec<String> {
        self.actor_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(_, path)| path.starts_with(root))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Storage handle for blocking background tasks.
    pub fn inner_arc(&self) -> StorageHandle {
        StorageHandle(Arc::clone(&self.storage))
    }

    pub fn auth_runs_arc(&self) -> Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> {
        Arc::clone(&self.auth_runs)
    }

    pub fn actor_ids(&self) -> Vec<String> {
        self.actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect()
    }
}

impl AppState {
    /// The explicit location chosen in Settings for a provider, if any.
    pub fn provider_location(&self, provider: Provider) -> Option<ProviderLocation> {
        self.with_storage(|s| s.setting_get::<ProviderLocation>(PROVIDER_LOCATION_KEY, &format!("provider:{}", provider.as_str())))
            .ok()
            .flatten()
    }

    /// Finds a provider's program. Resolved each time it is needed rather
    /// than once at startup, so installing or updating a CLI takes effect on
    /// the next session without restarting the app.
    pub fn resolve_provider(&self, provider: Provider) -> Result<ResolvedProvider, DesktopError> {
        let configured = self.provider_location(provider);
        let home = self.home.clone().unwrap_or_default();
        match provider {
            Provider::Claude => {
                let chosen = configured.as_ref().and_then(|location| Some((location.program.clone(), location.script.clone()?)));
                let source = if chosen.is_some() {
                    "settings"
                } else if std::env::var_os(claude::launch::ADAPTER_ENV).is_some() {
                    "environment"
                } else {
                    "discovered"
                };
                let (node, script) = claude::launch::locate_adapter(&home, chosen, std::env::var(claude::launch::ADAPTER_ENV).ok())?;
                Ok(ResolvedProvider {
                    provider,
                    program: node,
                    prefix_args: vec![script.to_string_lossy().into_owned()],
                    source,
                })
            }
            Provider::Codex => {
                if let Some(location) = configured {
                    return Ok(ResolvedProvider { provider, program: location.program, prefix_args: Vec::new(), source: "settings" });
                }
                if let Some(path) = std::env::var_os("THINGMAKER_CODEX").map(PathBuf::from).filter(|path| path.is_file()) {
                    return Ok(ResolvedProvider { provider, program: path, prefix_args: Vec::new(), source: "environment" });
                }
                let program = find_codex(&home).ok_or_else(|| {
                    DesktopError::not_ready(
                        "Codex is not installed. Install the Codex CLI (`npm install -g @openai/codex`) or the ChatGPT app, or choose the `codex` binary in Settings.",
                    )
                })?;
                Ok(ResolvedProvider { provider, program, prefix_args: Vec::new(), source: "discovered" })
            }
            Provider::Gemini => {
                if let Some(location) = configured {
                    return Ok(ResolvedProvider { provider, program: location.program, prefix_args: Vec::new(), source: "settings" });
                }
                if let Some(path) = std::env::var_os(gemini::launch::PROGRAM_ENV).map(PathBuf::from).filter(|path| path.is_file()) {
                    return Ok(ResolvedProvider { provider, program: path, prefix_args: Vec::new(), source: "environment" });
                }
                let program = gemini::launch::find_program(&home).ok_or_else(|| {
                    DesktopError::not_ready(
                        "Antigravity CLI (agy) is not installed. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or choose the `agy` binary in Settings.",
                    )
                })?;
                Ok(ResolvedProvider { provider, program, prefix_args: Vec::new(), source: "discovered" })
            }
        }
    }
}

/// `codex` on PATH, in the usual global install prefixes, or the one the
/// ChatGPT and Codex apps ship. A desktop app launched from the Dock has no
/// shell PATH, so the prefixes are searched explicitly.
fn find_codex(home: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&path_var).map(|dir| dir.join(name)).collect();
    let mut nvm: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join("bin").join(name))
        .collect();
    nvm.sort();
    nvm.reverse();
    candidates.extend(nvm);
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        home.join(".local/bin").join(name),
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin").join(name),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex-cli/bin").join(name),
    ]);
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Cloneable storage access for tasks that outlive a command.
#[derive(Clone)]
pub struct StorageHandle(Arc<Mutex<Storage>>);

impl StorageHandle {
    pub fn with_storage<T>(&self, f: impl FnOnce(&Storage) -> T) -> T {
        let guard = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&guard)
    }
}
