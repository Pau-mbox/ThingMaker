//! Context sources, skills and instruction files (CTX-01, CFG-10).
//!
//! Reads carry provenance; writes are hash-checked, atomic and backed up.
//! Nothing here contacts an agent: a save is a file change each agent reads at
//! its next session start, and the UI says so ("saved, read at next session
//! start"), never "active".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    integrations::{ContextSources, SkillFrontmatter, SkillScope, context_sources, parse_frontmatter, write_config_checked},
    storage::content_hash,
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

fn home(state: &AppState) -> CommandResult<PathBuf> {
    state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set; the user skills directory is unknown"))
}

fn workspace_root(state: &AppState, workspace_id: &str) -> CommandResult<PathBuf> {
    let record = state
        .with_storage(|s| s.workspace_get(workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    Ok(PathBuf::from(record.canonical_root))
}

#[tauri::command]
pub fn context_sources_for_workspace(workspace_id: String, state: State<'_, AppState>) -> CommandResult<ContextSources> {
    let root = workspace_root(&state, &workspace_id)?;
    Ok(context_sources(&root, state.home.as_deref()))
}

/// Which editable file a read/write addresses. Every target resolves to a
/// path the desktop is allowed to edit; arbitrary paths are refused.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase", tag = "kind")]
pub enum ConfigTarget {
    /// A workspace's `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code).
    Instructions { workspace_id: String, file: InstructionFileName },
    Skill { scope: SkillScope, workspace_id: Option<String>, directory_name: String },
}

/// The instruction files the desktop edits, one per provider convention.
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum InstructionFileName {
    #[serde(rename = "AGENTS.md")]
    Agents,
    #[serde(rename = "CLAUDE.md")]
    Claude,
}

impl InstructionFileName {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Claude => "CLAUDE.md",
        }
    }
}

fn skill_dir_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !name.starts_with('.')
}

pub(crate) fn resolve_target(state: &AppState, target: &ConfigTarget) -> CommandResult<(PathBuf, &'static str)> {
    match target {
        ConfigTarget::Instructions { workspace_id, file } => Ok((workspace_root(state, workspace_id)?.join(file.as_str()), "markdown")),
        ConfigTarget::Skill { scope, workspace_id, directory_name } => {
            if !skill_dir_name_ok(directory_name) {
                return Err(DesktopError::io("invalid skill directory name"));
            }
            let base = match scope {
                SkillScope::Project => {
                    let id = workspace_id.as_deref().ok_or_else(|| DesktopError::io("project skills need a workspace"))?;
                    workspace_root(state, id)?.join(".agents/skills")
                }
                SkillScope::User => home(state)?.join(".agents/skills"),
            };
            Ok((base.join(directory_name).join("SKILL.md"), "markdown"))
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub language: &'static str,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill: Option<SkillFrontmatter>,
}

#[tauri::command]
pub fn config_read_file(target: ConfigTarget, state: State<'_, AppState>) -> CommandResult<ConfigFile> {
    let (path, language) = resolve_target(&state, &target)?;
    let (content, hash, exists) = match std::fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(DesktopError::limit_exceeded("configuration file exceeds 4 MiB"));
            }
            (String::from_utf8_lossy(&bytes).into_owned(), Some(content_hash(&bytes)), true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), None, false),
        Err(error) => return Err(DesktopError::io(error.to_string())),
    };
    let is_skill = matches!(target, ConfigTarget::Skill { .. });
    let skill = (is_skill && exists).then(|| parse_frontmatter(&content));
    Ok(ConfigFile {
        path: path.to_string_lossy().into_owned(),
        exists,
        language,
        content,
        content_hash: hash,
        skill,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteRequest {
    pub target: ConfigTarget,
    pub expected_hash: Option<String>,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteOutcome {
    pub path: String,
    pub content_hash: String,
    /// Always "saved_pending_reload": agents read these files when a session
    /// starts, so a save changes the next session, not the running one.
    pub status: &'static str,
}

#[tauri::command]
pub fn config_write_file(request: ConfigWriteRequest, state: State<'_, AppState>) -> CommandResult<ConfigWriteOutcome> {
    let (path, language) = resolve_target(&state, &request.target)?;
    if request.content.len() > 4 * 1024 * 1024 {
        return Err(DesktopError::limit_exceeded("configuration file exceeds 4 MiB"));
    }
    if language == "markdown" && matches!(request.target, ConfigTarget::Skill { .. }) {
        let frontmatter = parse_frontmatter(&request.content);
        if !frontmatter.problems.is_empty() {
            return Err(DesktopError::io(format!("SKILL.md is invalid: {}", frontmatter.problems.join("; "))));
        }
    }
    let hash = write_config_checked(&path, request.expected_hash.as_deref(), &request.content)?;
    Ok(ConfigWriteOutcome {
        path: path.to_string_lossy().into_owned(),
        content_hash: hash,
        status: "saved_pending_reload",
    })
}

pub(crate) fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_dir() {
                    total += dir_size(&entry.path());
                } else {
                    total += metadata.len();
                }
            }
        }
    }
    total
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateRequest {
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub directory_name: String,
}

/// Creates a skill directory with a template SKILL.md (CFG-10). Fails if it
/// already exists so nothing is overwritten.
#[tauri::command]
pub fn skill_create(request: SkillCreateRequest, state: State<'_, AppState>) -> CommandResult<ConfigFile> {
    let target = ConfigTarget::Skill {
        scope: request.scope,
        workspace_id: request.workspace_id,
        directory_name: request.directory_name.clone(),
    };
    let (path, _) = resolve_target(&state, &target)?;
    if path.exists() {
        return Err(DesktopError::conflict("a skill with this directory name already exists"));
    }
    let parent = path.parent().ok_or_else(|| DesktopError::io("invalid skill path"))?;
    std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
    let template = format!(
        "---\nname: {}\ndescription: Describe when an agent should load this skill\n---\n\n# {}\n\nInstructions the agent follows after loading this skill.\n",
        request.directory_name.to_ascii_lowercase().replace(['_', '.'], "-"),
        request.directory_name
    );
    write_config_checked(&path, None, &template)?;
    config_read_file(target, state)
}


// ---------------------------------------------------------------------------
// Skill import (CFG-10)
// ---------------------------------------------------------------------------

use thingmaker_supervisor::integrations::{AppliedSkill, ImportPlan, RemovedSkill, annotate_collisions, apply_import, remove_skill, stage_import};

fn staging_dir(state: &AppState, staging_id: &str) -> CommandResult<PathBuf> {
    if staging_id.len() != 36 || !staging_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(DesktopError::io("invalid staging id"));
    }
    Ok(state.data_dir.join("imports").join(staging_id))
}

fn skills_root_for(state: &AppState, scope: SkillScope, workspace_id: Option<&str>) -> CommandResult<(PathBuf, PathBuf)> {
    match scope {
        SkillScope::Project => {
            let id = workspace_id.ok_or_else(|| DesktopError::io("project skills need a workspace"))?;
            let root = workspace_root(state, id)?;
            Ok((root.join(".agents/skills"), root))
        }
        SkillScope::User => {
            let home = home(state)?;
            Ok((home.join(".agents/skills"), home))
        }
    }
}

fn stage_and_annotate(state: &AppState, source: &Path, scope: SkillScope, workspace_id: Option<&str>) -> CommandResult<ImportPlan> {
    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging = staging_dir(state, &staging_id)?;
    let mut plan = match stage_import(source, &staging, &staging_id) {
        Ok(plan) => plan,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let root = match scope {
        SkillScope::Project => workspace_id.map(|id| workspace_root(state, id)).transpose()?.unwrap_or_else(|| PathBuf::from("/nonexistent")),
        SkillScope::User => PathBuf::from("/nonexistent"),
    };
    annotate_collisions(&mut plan, scope, &root, state.home.as_deref());
    let cache = serde_json::to_vec(&plan).map_err(|e| DesktopError::io(e.to_string()))?;
    std::fs::write(staging.join(".plan.json"), cache).map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(plan)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportPickRequest {
    /// "folder" or "zip".
    pub kind: String,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
}

/// Native picker for a skill folder or a .zip archive; stages and describes it.
#[tauri::command]
pub async fn skill_import_pick(request: SkillImportPickRequest, app: tauri::AppHandle, state: State<'_, AppState>) -> CommandResult<Option<ImportPlan>> {
    use tauri_plugin_dialog::DialogExt;
    let kind = request.kind.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        if kind == "zip" { dialog.add_filter("Zip archive", &["zip"]).blocking_pick_file() } else { dialog.blocking_pick_folder() }
    })
    .await
    .map_err(|e| DesktopError::io(e.to_string()))?;
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| DesktopError::io(e.to_string()))?;
    stage_and_annotate(&state, &path, request.scope, request.workspace_id.as_deref()).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportPathsRequest {
    pub paths: Vec<String>,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
}

/// Drag-and-drop entry point: the first folder or .zip among the dropped paths.
#[tauri::command]
pub fn skill_import_from_paths(request: SkillImportPathsRequest, state: State<'_, AppState>) -> CommandResult<Option<ImportPlan>> {
    let Some(path) = request.paths.iter().map(PathBuf::from).find(|p| p.is_dir() || p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("zip"))) else {
        return Err(DesktopError::unsupported("drop a skill folder or a .zip archive"));
    };
    stage_and_annotate(&state, &path, request.scope, request.workspace_id.as_deref()).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportAnnotateRequest {
    pub staging_id: String,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
}

/// Recomputes collisions for a staged plan when the target scope changes.
#[tauri::command]
pub fn skill_import_annotate(request: SkillImportAnnotateRequest, state: State<'_, AppState>) -> CommandResult<ImportPlan> {
    let staging = staging_dir(&state, &request.staging_id)?;
    let plan_path = staging.join(".plan.json");
    let mut plan: ImportPlan = match std::fs::read(&plan_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| DesktopError::io(e.to_string()))?,
        Err(_) => {
            // Plan cache missing: re-describe the staged content in place.
            stage_import(&staging, &staging.join(".rescan"), &request.staging_id)?
        }
    };
    let root = match request.scope {
        SkillScope::Project => request.workspace_id.as_deref().map(|id| workspace_root(&state, id)).transpose()?.unwrap_or_else(|| PathBuf::from("/nonexistent")),
        SkillScope::User => PathBuf::from("/nonexistent"),
    };
    annotate_collisions(&mut plan, request.scope, &root, state.home.as_deref());
    Ok(plan)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportApplyRequest {
    pub staging_id: String,
    pub selected: Vec<String>,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub replace: bool,
}

#[tauri::command]
pub fn skill_import_apply(request: SkillImportApplyRequest, state: State<'_, AppState>) -> CommandResult<Vec<AppliedSkill>> {
    let staging = staging_dir(&state, &request.staging_id)?;
    let plan_bytes = std::fs::read(staging.join(".plan.json")).map_err(|_| DesktopError::not_ready("import staging expired; pick the source again"))?;
    let plan: ImportPlan = serde_json::from_slice(&plan_bytes).map_err(|e| DesktopError::io(e.to_string()))?;
    let (skills_root, _) = skills_root_for(&state, request.scope, request.workspace_id.as_deref())?;
    let backups = skill_backup_root(&state, request.scope);
    let applied = apply_import(&staging, &plan, &request.selected, &skills_root, request.replace, &backups)?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(applied)
}

#[tauri::command]
pub fn skill_import_discard(staging_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let staging = staging_dir(&state, &staging_id)?;
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    Ok(())
}


/// Backups of replaced or removed skills live in the app data directory, never
/// inside a skills root (agents would list them).
pub(crate) fn skill_backup_root(state: &AppState, scope: SkillScope) -> PathBuf {
    state.data_dir.join("skill-backups").join(match scope {
        SkillScope::Project => "project",
        SkillScope::User => "user",
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemoveRequest {
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub directory_name: String,
    /// Move to the app's skill-backups folder instead of deleting outright.
    pub keep_backup: bool,
}

/// Removes an installed skill (CFG-10). Reversible when `keep_backup` is set.
#[tauri::command]
pub fn skill_remove(request: SkillRemoveRequest, state: State<'_, AppState>) -> CommandResult<RemovedSkill> {
    let (skills_root, _) = skills_root_for(&state, request.scope, request.workspace_id.as_deref())?;
    let backups = skill_backup_root(&state, request.scope);
    remove_skill(&skills_root, &request.directory_name, request.keep_backup.then_some(backups.as_path()))
}
