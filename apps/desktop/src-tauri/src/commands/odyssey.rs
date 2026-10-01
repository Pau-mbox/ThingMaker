//! Super Thing goals (docs/plans/odyssey.md): the command surface over the record.
//!
//! These commands read and write the record. They never submit a prompt and
//! never decide anything: the runner in the renderer chooses, writes its
//! decision here first, and then acts. `odyssey_record_report` stores a claim
//! and `odyssey_record_check` stores evidence — the two are separate calls on
//! purpose, so a claim can never become a verification by accident.

use serde::{Deserialize, Serialize};
use tauri::State;
use thingmaker_supervisor::odyssey_check::{self, CheckOutcome};
use thingmaker_supervisor::odyssey_checkpoint::{self, Checkpoint};
use thingmaker_supervisor::odyssey_notes::{self, WorkspaceNotes};
use thingmaker_supervisor::odyssey_spend::{self, SpendModel};
use thingmaker_supervisor::review::BlobStore;
use thingmaker_supervisor::storage::workspaces::TrustState;
use thingmaker_supervisor::storage::odyssey::{
    AmendmentRecord, AmendmentRef, AmendmentState, CheckKind, CheckSource, NewAmendment, NewUsageSample, GoalEdit, JournalEntry, JournalKind, MilestoneEdit, MilestoneRecord, MilestoneState, NewOdyssey, OdysseyRecord, OdysseyState, OdysseyView, OnReport, OnUsageReset,
    NewQuestion, PlanChangeRecord, PlanChangeState, QuestionRecord, QuestionState, StepEdit, StepRecord, StepState, StopCondition, UsageSample,
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

/// The protocol the briefing points the model at. Kept next to the code that
/// implements it, and gated by `odysseySkill.test.ts` against drifting from it.
const SKILL_MD: &str = include_str!("../../../../../runtime/skills/super-thing/SKILL.md");

/// The delegate a Claude orchestrator raises
/// (docs/plans/odyssey.md §12.9).
///
/// Claude Code has no role table for subagents: a subagent's model is a field on an
/// *agent definition*, so pinning delegates to Opus 5 means putting one of
/// those where Claude Code looks. It is installed into the workspace rather
/// than the user's home, because it is a fact about this project's run and
/// should be visible and reviewable in the repository rather than changing
/// every Claude Code session on the machine.
const DELEGATE_MD: &str = include_str!("../../../../../runtime/agents/super-thing-delegate.md");

/// Where Claude Code looks for a project's agent definitions.
const DELEGATE_PATH: &str = ".claude/agents/super-thing-delegate.md";

/// Largest Markdown document read for a plan. A roadmap is prose; anything
/// this size is not one, and the parser bounds what it produces anyway.
const MAX_PLAN_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPlanRequest {
    pub path: String,
}

/// Reads a Markdown document the user dropped onto the goal form.
///
/// An absolute path outside any workspace is allowed because the user dropping
/// a file *is* the consent, the same way dropping an attachment is. It is
/// read-only, text-only, extension-checked and size-capped, and the parsed
/// result is a draft the user edits before anything is created.
#[tauri::command]
pub fn odyssey_read_plan(request: ReadPlanRequest, _state: State<'_, AppState>) -> CommandResult<String> {
    let path = std::path::PathBuf::from(&request.path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "mdx" | "txt") {
        return Err(thingmaker_supervisor::DesktopError::unsupported("a plan has to be a Markdown or text file"));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| thingmaker_supervisor::DesktopError::io(format!("could not read {}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(thingmaker_supervisor::DesktopError::unsupported("that is not a file"));
    }
    if metadata.len() > MAX_PLAN_BYTES {
        return Err(thingmaker_supervisor::DesktopError::limit_exceeded("that file is larger than 1 MiB"));
    }
    let bytes = std::fs::read(&path).map_err(|error| thingmaker_supervisor::DesktopError::io(format!("could not read {}: {error}", path.display())))?;
    String::from_utf8(bytes).map_err(|_| thingmaker_supervisor::DesktopError::unsupported("that file is not UTF-8 text"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckRequest {
    pub workspace_id: String,
    pub milestone_id: String,
}

/// A check the desktop ran, with the record it produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckResponse {
    pub outcome: CheckOutcome,
    pub milestone: MilestoneRecord,
}

/// Runs a milestone's check here and records the result as desktop evidence.
///
/// This is the lane the plan calls unambiguous: the command comes from the
/// milestone, the exit code comes from the process, and the agent is not
/// involved. It is executable code, so an untrusted workspace is refused —
/// the same gate the Git actions use.
#[tauri::command]
pub fn odyssey_run_check(request: RunCheckRequest, state: State<'_, AppState>) -> CommandResult<RunCheckResponse> {
    let workspace = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    if workspace.trust_state == TrustState::Untrusted {
        return Err(thingmaker_supervisor::DesktopError::untrusted("Choose an execution profile for this workspace before Super Thing runs checks in it."));
    }
    let milestone = state
        .with_storage(|storage| storage.milestone_get(&request.milestone_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("milestone not found"))?;

    let outcome = odyssey_check::run_check(std::path::Path::new(&workspace.canonical_root), milestone.check_kind, milestone.check_spec.as_deref())?;
    // Evidence and verdict are written together: a run that is not recorded
    // never happened as far as the record is concerned.
    let evidence = if outcome.output.trim().is_empty() {
        outcome.summary.clone()
    } else {
        format!("{}\n\n{}", outcome.summary, outcome.output)
    };
    let milestone = state
        .with_storage(|storage| storage.milestone_record_check(&request.milestone_id, outcome.passed, &evidence, CheckSource::Desktop))
        .map_err(storage_error)?;
    Ok(RunCheckResponse { outcome, milestone })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRequest {
    pub workspace_id: String,
    pub odyssey_id: String,
}

/// Takes a per-turn checkpoint: the tree now, against the tree at the goal's
/// previous checkpoint (docs/research/odyssey-review.md §3.5).
///
/// Read-only for the workspace; the capture lives under the app's data
/// directory, per goal, and the blobs are shared with the review surface.
#[tauri::command]
pub fn odyssey_checkpoint(request: CheckpointRequest, state: State<'_, AppState>) -> CommandResult<Checkpoint> {
    let workspace = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    // The goal has to exist, so a stale renderer cannot make the desktop keep
    // captures for an id that means nothing.
    state
        .with_storage(|storage| storage.odyssey_get(&request.odyssey_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("goal not found"))?;
    let store = state.data_dir.join("odyssey").join(&request.odyssey_id);
    let blobs = BlobStore::new(state.data_dir.join("blobs"));
    odyssey_checkpoint::take_checkpoint(std::path::Path::new(&workspace.canonical_root), &store, &blobs)
}

/// Records one usage reading with the session's token counters at that
/// moment (docs/research/odyssey-review.md §4.1). `None` when the reading
/// repeated the previous one.
#[tauri::command]
pub fn odyssey_usage_sample_add(request: NewUsageSample, state: State<'_, AppState>) -> CommandResult<Option<UsageSample>> {
    state.with_storage(|storage| storage.usage_sample_add(&request)).map_err(storage_error)
}

/// Samples kept for the spend model; enough for days of one-a-minute readings.
const SPEND_MODEL_SAMPLES: usize = 20_000;

/// What the run's samples say the subscription window charges.
#[tauri::command]
pub fn odyssey_spend_model(odyssey_id: String, state: State<'_, AppState>) -> CommandResult<SpendModel> {
    let samples = state.with_storage(|storage| storage.usage_samples(&odyssey_id, SPEND_MODEL_SAMPLES)).map_err(storage_error)?;
    Ok(odyssey_spend::fit(&samples))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesRequest {
    pub workspace_id: String,
}

/// The handoff note and subagent notes the run has written into the
/// workspace, with their ages. Read-only.
#[tauri::command]
pub fn odyssey_workspace_notes(request: NotesRequest, state: State<'_, AppState>) -> CommandResult<WorkspaceNotes> {
    let workspace = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    odyssey_notes::read_notes(std::path::Path::new(&workspace.canonical_root))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderStepsRequest {
    pub milestone_id: String,
    pub ordered_ids: Vec<String>,
}

#[tauri::command]
pub fn odyssey_reorder_steps(request: ReorderStepsRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.step_reorder(&request.milestone_id, &request.ordered_ids)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangeAddRequest {
    pub odyssey_id: String,
    /// The operations as the renderer parsed them, JSON.
    pub ops: String,
    pub summary: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub state: PlanChangeState,
}

/// Holds a plan change the agent proposed (docs/plans/odyssey.md §11.9).
#[tauri::command]
pub fn odyssey_plan_change_add(request: PlanChangeAddRequest, state: State<'_, AppState>) -> CommandResult<PlanChangeRecord> {
    state
        .with_storage(|storage| storage.plan_change_add(&request.odyssey_id, &request.ops, &request.summary, request.reason.as_deref(), request.state))
        .map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_plan_change_list(odyssey_id: String, state: State<'_, AppState>) -> CommandResult<Vec<PlanChangeRecord>> {
    state.with_storage(|storage| storage.plan_change_list(&odyssey_id, 100)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangeDecideRequest {
    pub id: String,
    pub state: PlanChangeState,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub fn odyssey_plan_change_decide(request: PlanChangeDecideRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.plan_change_decide(&request.id, request.state, request.note.as_deref())).map_err(storage_error)
}

/// Records a decision the agent handed to the user (docs/plans/odyssey.md §11.10).
#[tauri::command]
pub fn odyssey_question_add(request: NewQuestion, state: State<'_, AppState>) -> CommandResult<QuestionRecord> {
    state.with_storage(|storage| storage.question_add(&request)).map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_question_list(odyssey_id: String, state: State<'_, AppState>) -> CommandResult<Vec<QuestionRecord>> {
    state.with_storage(|storage| storage.question_list(&odyssey_id, 100)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSettleRequest {
    pub id: String,
    pub state: QuestionState,
    #[serde(default)]
    pub answer: Option<String>,
}

#[tauri::command]
pub fn odyssey_question_settle(request: QuestionSettleRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.question_settle(&request.id, request.state, request.answer.as_deref())).map_err(storage_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    pub path: String,
    /// False when the installed copy was already identical.
    pub changed: bool,
}

/// Installs the `super-thing` skill into the user's skills directory.
///
/// The briefing tells the model it can load this skill, so the skill has to
/// exist for that sentence to be true. Idempotent: an identical copy is left
/// alone and reported as unchanged, so the runner can call it before every
/// briefing without churning the user's files.
#[tauri::command]
pub fn odyssey_install_skill(state: State<'_, AppState>) -> CommandResult<SkillInstall> {
    let home = state.home.clone().ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("HOME is not set"))?;
    let target = home.join(".agents/skills/super-thing/SKILL.md");
    // The same skill, installed under its earlier name, would be offered to
    // the model twice; a copy that is ours (by its name line) is retired.
    let legacy = home.join(".agents/skills/odyssey");
    if std::fs::read_to_string(legacy.join("SKILL.md")).is_ok_and(|existing| existing.starts_with("---\nname: odyssey\n")) {
        let _ = std::fs::remove_dir_all(&legacy);
    }
    if std::fs::read_to_string(&target).is_ok_and(|existing| existing == SKILL_MD) {
        return Ok(SkillInstall { path: target.to_string_lossy().into_owned(), changed: false });
    }

    // Through the same staging and backup path as any other skill import, so a
    // hand-edited copy is backed up rather than overwritten silently.
    let staging_root = state.data_dir.join("imports").join(format!("odyssey-skill-{}", std::process::id()));
    let source = staging_root.join("source").join("super-thing");
    std::fs::create_dir_all(&source).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
    std::fs::write(source.join("SKILL.md"), SKILL_MD).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
    let staging = staging_root.join("staging");
    let outcome = (|| {
        let plan = thingmaker_supervisor::integrations::stage_import(&source, &staging, "odyssey-skill")?;
        let skills_root = home.join(".agents/skills");
        let backups = super::skills::skill_backup_root(&state, thingmaker_supervisor::integrations::SkillScope::User);
        let applied = thingmaker_supervisor::integrations::apply_import(&staging, &plan, std::slice::from_ref(&"super-thing".to_string()), &skills_root, true, &backups)?;
        Ok::<SkillInstall, thingmaker_supervisor::DesktopError>(SkillInstall {
            path: applied.first().map(|entry| entry.path.to_string_lossy().into_owned()).unwrap_or_else(|| target.to_string_lossy().into_owned()),
            changed: true,
        })
    })();
    let _ = std::fs::remove_dir_all(&staging_root);
    outcome
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPlanRequest {
    pub id: String,
    #[serde(default)]
    pub source: Option<String>,
    /// The document text; `None` clears it.
    #[serde(default)]
    pub document: Option<String>,
    /// Workspace-relative path the agent can open for itself.
    #[serde(default)]
    pub path: Option<String>,
}

/// Attaches the plan document a goal was created from, or clears it.
#[tauri::command]
pub fn odyssey_set_plan(request: SetPlanRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.odyssey_set_plan(&request.id, request.source.as_deref(), request.document.as_deref(), request.path.as_deref()))
        .map_err(storage_error)
}

/// The stored plan document. Read only when the planning prompt is built, so
/// the goal view stays small.
#[tauri::command]
pub fn odyssey_plan_document(id: String, state: State<'_, AppState>) -> CommandResult<Option<String>> {
    state.with_storage(|storage| storage.odyssey_plan_document(&id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForSessionRequest {
    pub workspace_id: String,
    /// The agent's id for the session. The desktop row it maps to is resolved here.
    pub agent_session_id: String,
}

/// Largest document inlined into an amendment prompt. A file inside the
/// workspace is referenced by path instead and read by the agent itself, so
/// this only bounds the ones it cannot reach.
const MAX_AMENDMENT_DOCUMENT: usize = 32 * 1024;

/// How many entries of a referenced directory are counted before giving up.
const MAX_DIR_SCAN: usize = 5_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRefsRequest {
    pub workspace_id: String,
    /// Absolute paths, as a drop gives them, or workspace-relative ones.
    pub paths: Vec<String>,
}

/// Describes files and folders the agent could open for itself.
///
/// References are workspace-relative on purpose: the agent reads them with its
/// own tools, so a folder of 48 ship sprites costs the prompt one line instead
/// of 48 attachments. A path outside the workspace is refused here rather than
/// quietly turned into something the agent cannot open.
#[tauri::command]
pub fn odyssey_inspect_refs(request: InspectRefsRequest, state: State<'_, AppState>) -> CommandResult<Vec<AmendmentRef>> {
    let workspace = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    let root = std::path::PathBuf::from(&workspace.canonical_root);
    let canonical_root = std::fs::canonicalize(&root).unwrap_or(root.clone());

    let mut out = Vec::new();
    for raw in &request.paths {
        let candidate = std::path::Path::new(raw);
        // A drop hands over absolute paths; make them relative to the
        // workspace so the agent can use them, and refuse what is outside it.
        let relative = if candidate.is_absolute() {
            let canonical = std::fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf());
            match canonical.strip_prefix(&canonical_root) {
                Ok(rest) => rest.to_string_lossy().into_owned(),
                Err(_) => {
                    return Err(thingmaker_supervisor::DesktopError::unsupported(format!(
                        "{} is outside this workspace, and the agent can only open files inside it",
                        candidate.display()
                    )));
                }
            }
        } else {
            raw.trim_start_matches("./").to_string()
        };
        if relative.is_empty() {
            continue;
        }

        let resolved = thingmaker_supervisor::workspace::explorer::resolve_contained(&root, &relative)?;
        let metadata = std::fs::metadata(&resolved).map_err(|error| thingmaker_supervisor::DesktopError::io(format!("could not read {relative}: {error}")))?;
        let (kind, detail) = if metadata.is_dir() {
            let mut files = 0usize;
            let mut folders = 0usize;
            let entries = std::fs::read_dir(&resolved).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
            for entry in entries.take(MAX_DIR_SCAN).flatten() {
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    folders += 1;
                } else {
                    files += 1;
                }
            }
            let mut parts = Vec::new();
            if files > 0 {
                parts.push(format!("{files} file{}", if files == 1 { "" } else { "s" }));
            }
            if folders > 0 {
                parts.push(format!("{folders} folder{}", if folders == 1 { "" } else { "s" }));
            }
            ("directory", if parts.is_empty() { "empty".to_string() } else { parts.join(", ") })
        } else {
            ("file", format!("{} bytes", metadata.len()))
        };
        out.push(AmendmentRef { path: relative, kind: kind.to_string(), detail });
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAmendmentRequest {
    pub odyssey_id: String,
    pub note: String,
    /// A document from outside the workspace, inlined because the agent
    /// cannot open it. One inside the workspace belongs in `refs`.
    #[serde(default)]
    pub document: Option<String>,
    #[serde(default)]
    pub document_source: Option<String>,
    #[serde(default)]
    pub refs: Vec<AmendmentRef>,
    /// `change` (default) or `note`; see the storage record.
    #[serde(default)]
    pub kind: Option<String>,
}

#[tauri::command]
pub fn odyssey_amend_add(request: AddAmendmentRequest, state: State<'_, AppState>) -> CommandResult<AmendmentRecord> {
    if let Some(document) = &request.document
        && document.len() > MAX_AMENDMENT_DOCUMENT
    {
        return Err(thingmaker_supervisor::DesktopError::limit_exceeded(format!(
            "that document is {} KB. A document the agent cannot open itself is inlined in its prompt, so it has to be under {} KB — put it in the workspace and reference it instead.",
            document.len() / 1024,
            MAX_AMENDMENT_DOCUMENT / 1024
        )));
    }
    state
        .with_storage(|storage| {
            storage.amendment_add(&NewAmendment {
                odyssey_id: request.odyssey_id.clone(),
                note: request.note.clone(),
                document: request.document.clone(),
                document_source: request.document_source.clone(),
                refs: request.refs.clone(),
                kind: request.kind.clone(),
            })
        })
        .map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_amend_list(odyssey_id: String, state: State<'_, AppState>) -> CommandResult<Vec<AmendmentRecord>> {
    state.with_storage(|storage| storage.amendment_list(&odyssey_id)).map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_amend_document(id: String, state: State<'_, AppState>) -> CommandResult<Option<String>> {
    state.with_storage(|storage| storage.amendment_document(&id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendStateRequest {
    pub id: String,
    pub state: AmendmentState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendToldRequest {
    pub id: String,
    /// The goal's continuation count when this prompt carried it.
    pub continuations_used: i64,
}

/// Records that a prompt carried this amendment, counting the attempt.
#[tauri::command]
pub fn odyssey_amend_mark_told(request: AmendToldRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.amendment_mark_told(&request.id, request.continuations_used))
        .map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_amend_set_state(request: AmendStateRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.amendment_set_state(&request.id, request.state)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptPlanRequest {
    pub workspace_id: String,
    /// Absolute path of the dropped document.
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedPlan {
    /// Workspace-relative path the agent can open.
    pub path: String,
    /// True when the file had to be copied in to get there.
    pub copied: bool,
}

/// Makes a plan document something the agent can read for itself.
///
/// A document inlined once into the planning prompt is unreachable the moment
/// that turn compacts away — which is how a 54 KB specification came to
/// survive only as the fraction its milestone details carried. A path in the
/// workspace lasts for the life of the run and costs the briefing one line.
///
/// A file already inside the workspace is just named. One outside is copied
/// in, because that is the only way to make it readable — never overwriting,
/// and only when the caller asked for it.
#[tauri::command]
pub fn odyssey_adopt_plan(request: AdoptPlanRequest, state: State<'_, AppState>) -> CommandResult<AdoptedPlan> {
    let workspace = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    let root = std::path::PathBuf::from(&workspace.canonical_root);
    let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let source = std::path::Path::new(&request.path);
    let canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());

    if let Ok(relative) = canonical.strip_prefix(&canonical_root) {
        return Ok(AdoptedPlan { path: relative.to_string_lossy().into_owned(), copied: false });
    }

    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| thingmaker_supervisor::DesktopError::unsupported("that file has no name"))?;
    // `docs/` when the project already keeps documents there, so the copy
    // lands where a reader would look for it.
    let folder = if root.join("docs").is_dir() { "docs" } else { "" };
    let mut relative = if folder.is_empty() { name.to_string() } else { format!("{folder}/{name}") };
    let (stem, extension) = name.rsplit_once('.').map_or((name, ""), |(stem, ext)| (stem, ext));
    let mut attempt = 2;
    while root.join(&relative).exists() {
        // Never overwrite: a same-named file in the project is not ours.
        let candidate = if extension.is_empty() { format!("{stem}-{attempt}") } else { format!("{stem}-{attempt}.{extension}") };
        relative = if folder.is_empty() { candidate } else { format!("{folder}/{candidate}") };
        attempt += 1;
    }

    let destination = thingmaker_supervisor::workspace::explorer::resolve_contained(&root, &relative)?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
    }
    std::fs::copy(source, &destination).map_err(|error| thingmaker_supervisor::DesktopError::io(format!("could not copy the document into the project: {error}")))?;
    Ok(AdoptedPlan { path: relative, copied: true })
}

/// The live goal for a session, with its milestones and journal.
#[tauri::command]
pub fn odyssey_for_session(request: ForSessionRequest, state: State<'_, AppState>) -> CommandResult<Option<OdysseyView>> {
    // A session with no desktop row cannot have a goal yet, so read-only
    // resolution is enough and nothing is created by looking.
    let Some(session_id) = state
        .with_storage(|storage| storage.odyssey_session_row(&request.workspace_id, &request.agent_session_id, None))
        .map_err(storage_error)?
    else {
        return Ok(None);
    };
    let goal = state.with_storage(|storage| storage.odyssey_for_session(&session_id)).map_err(storage_error)?;
    let Some(goal) = goal else { return Ok(None) };
    state.with_storage(|storage| storage.odyssey_view(&goal.id)).map_err(storage_error)
}

/// What the Claude account says about itself, in the shape the runner's usage
/// guard already understands (docs/plans/odyssey-second-orchestrator.md §2.4).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountStatus {
    /// False only when something said so. An account nobody could ask is
    /// `true` with a `problem`: absence of data is not evidence of
    /// exhaustion, and parking every goal on a failed probe would be worse
    /// than trying a prompt that might be refused.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at_unix: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Why the account could not be asked, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// Asks whether the Claude account can be *used at all*, before a goal is
/// moved onto it.
///
/// This is a sign-in check, not a quota check, and the distinction was
/// learned the hard way: the plan assumed a spent account would refuse the
/// model catalog, and it does not. `session/new` succeeds and the catalog
/// comes back in full while every prompt is refused — verified against the
/// live adapter on a spent Pro account. So there is no cheap way to ask this
/// side "is there room"; the only answer comes from a prompt being refused.
///
/// What it does prove is worth having before a move: that the adapter runs,
/// that it is signed in, and that the account has models to offer. Moving a
/// run onto an adapter that cannot answer at all is how a goal ends up on a
/// session that will never take a prompt.
#[tauri::command]
pub fn odyssey_claude_preflight(state: State<'_, AppState>) -> CommandResult<ClaudeAccountStatus> {
    use thingmaker_supervisor::agents::{Provider, claude::{auth, quota}};

    let resolved = state.resolve_provider(Provider::Claude)?;
    // First, Claude Code's own usage data: it answers in about a second,
    // proves the account is signed in, and — unlike the model list — says
    // whether the account has room. A spent account is no place to move a run.
    let home = state.home.clone().unwrap_or_default();
    let script = resolved.prefix_args.first().map(std::path::PathBuf::from).unwrap_or_default();
    if let Some(binary) = thingmaker_supervisor::agents::claude::usage_probe::locate_claude_binary(&script, &home)
        && let Ok(snapshot) = thingmaker_supervisor::agents::claude::usage_probe::read_quota(&binary, std::time::Duration::from_secs(20))
    {
        if let Some(delegation) = state.delegation.get() {
            delegation.note_quota(snapshot.clone());
        }
        if snapshot.status == thingmaker_supervisor::agents::events::QuotaStatus::Rejected {
            return Ok(ClaudeAccountStatus {
                available: false,
                reset_at_unix: snapshot.available_again_at(),
                message: Some("the Claude account's usage window is spent".into()),
                problem: None,
            });
        }
        return Ok(ClaudeAccountStatus { available: true, reset_at_unix: None, message: None, problem: None });
    }
    // Without it, the model list: slower, and it proves sign-in only.
    let scratch = state.data_dir.join("provider-probe");
    match auth::read_models(&resolved.program, &resolved.prefix_args, &scratch, std::time::Duration::from_secs(45)) {
        Ok(models) if !models.is_empty() => Ok(ClaudeAccountStatus { available: true, reset_at_unix: None, message: None, problem: None }),
        Ok(_) => Ok(ClaudeAccountStatus {
            available: false,
            reset_at_unix: None,
            message: None,
            problem: Some("the adapter listed no models, so the Claude account is not signed in. Sign in from Settings first.".into()),
        }),
        Err(problem) => {
            if quota::looks_like_rate_limit(&problem) {
                let limit = quota::rate_limit_from_text(&problem, now_unix_seconds());
                return Ok(ClaudeAccountStatus {
                    available: false,
                    reset_at_unix: limit.reset_at_unix,
                    message: Some(limit.message),
                    problem: None,
                });
            }
            Ok(ClaudeAccountStatus { available: true, reset_at_unix: None, message: None, problem: Some(problem) })
        }
    }
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Installs the delegate definition into a workspace, so subagents a Claude
/// orchestrator raises run on Opus 5 rather than the account default.
///
/// Never overwrites a hand-edited copy: the file is the user's once it is in
/// their repository, and a run silently rewriting it would be a run editing
/// the project outside its own plan.
#[tauri::command]
pub fn odyssey_install_delegate(workspace_id: String, state: State<'_, AppState>) -> CommandResult<SkillInstall> {
    let record = state
        .with_storage(|storage| storage.workspace_get(&workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("workspace not found"))?;
    let record = super::workspace::ensure_trusted(&state, record)?;
    // The delegate as it was installed under the feature's earlier name: an
    // untouched copy is retired, so the agent is not offered two of them. A
    // tuned one stays; it is the user's.
    let legacy = std::path::Path::new(&record.canonical_root).join(".claude/agents/odyssey-delegate.md");
    let legacy_text = DELEGATE_MD.replace("super-thing-delegate", "odyssey-delegate").replace("a Super Thing", "an Odyssey").replace("Super Thing", "Odyssey");
    if std::fs::read_to_string(&legacy).is_ok_and(|existing| existing == legacy_text) {
        let _ = std::fs::remove_file(&legacy);
    }
    let target = std::path::Path::new(&record.canonical_root).join(DELEGATE_PATH);
    match std::fs::read_to_string(&target) {
        Ok(existing) if existing == DELEGATE_MD => {
            return Ok(SkillInstall { path: target.to_string_lossy().into_owned(), changed: false });
        }
        // Somebody has tuned it. That is theirs to keep.
        Ok(_) => return Ok(SkillInstall { path: target.to_string_lossy().into_owned(), changed: false }),
        Err(_) => {}
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
    }
    std::fs::write(&target, DELEGATE_MD).map_err(|error| thingmaker_supervisor::DesktopError::io(error.to_string()))?;
    Ok(SkillInstall { path: target.to_string_lossy().into_owned(), changed: true })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepointRequest {
    pub id: String,
    pub workspace_id: String,
    /// The agent's own id for the session to move to, as the renderer knows
    /// it. Resolved to the desktop row the goal's foreign key points at.
    pub agent_session_id: String,
    /// The provider that session runs on, for a session with no row yet.
    #[serde(default)]
    pub provider: Option<thingmaker_supervisor::agents::Provider>,
}

/// Points a goal at a different session
/// (docs/plans/odyssey-second-orchestrator.md §2.3).
///
/// This is the one-click "restart the session without losing the run", and
/// the mechanism failover is built out of. The record, the plan and the
/// workspace notes carry across; the transcript does not, which is why the
/// move journals a row the runner reads as "brief this one from scratch".
#[tauri::command]
pub fn odyssey_repoint(request: RepointRequest, state: State<'_, AppState>) -> CommandResult<OdysseyView> {
    let session_id = state
        .with_storage(|storage| storage.odyssey_session_row(&request.workspace_id, &request.agent_session_id, Some(request.provider.unwrap_or_default())))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("that session has no desktop record"))?;
    let goal = state.with_storage(|storage| storage.odyssey_repoint(&request.id, &session_id)).map_err(storage_error)?;
    state
        .with_storage(|storage| storage.odyssey_view(&goal.id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::not_ready("the goal went away while it was moving"))
}

#[tauri::command]
pub fn odyssey_view(id: String, state: State<'_, AppState>) -> CommandResult<Option<OdysseyView>> {
    state.with_storage(|storage| storage.odyssey_view(&id)).map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_list(workspace_id: String, state: State<'_, AppState>) -> CommandResult<Vec<OdysseyRecord>> {
    state.with_storage(|storage| storage.odyssey_list(&workspace_id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub workspace_id: String,
    /// The agent's id for the session this goal drives; resolved to the desktop row.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// The provider that session runs on, for a session with no row yet.
    #[serde(default)]
    pub provider: Option<thingmaker_supervisor::agents::Provider>,
    pub title: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub stop_condition: StopCondition,
    #[serde(default)]
    pub on_usage_reset: OnUsageReset,
    #[serde(default)]
    pub on_report: OnReport,
    pub max_continuations: i64,
    #[serde(default)]
    pub token_budget: Option<i64>,
    #[serde(default)]
    pub plan_source: Option<String>,
    #[serde(default)]
    pub plan_document: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub default_check: Option<String>,
}

#[tauri::command]
pub fn odyssey_create(request: CreateRequest, state: State<'_, AppState>) -> CommandResult<OdysseyView> {
    // The goal is created for a live session, so its desktop row is upserted
    // rather than required: the catalog may not have reconciled it yet.
    let session_id = match &request.agent_session_id {
        Some(agent_session_id) => state
            .with_storage(|storage| storage.odyssey_session_row(&request.workspace_id, agent_session_id, Some(request.provider.unwrap_or_default())))
            .map_err(storage_error)?,
        None => None,
    };
    let new = NewOdyssey {
        workspace_id: request.workspace_id,
        session_id,
        title: request.title,
        brief: request.brief,
        stop_condition: request.stop_condition,
        on_usage_reset: request.on_usage_reset,
        on_report: request.on_report,
        max_continuations: request.max_continuations,
        token_budget: request.token_budget,
        plan_source: request.plan_source,
        plan_document: request.plan_document,
        plan_path: request.plan_path,
        default_check: request.default_check,
    };
    let created = state.with_storage(|storage| storage.odyssey_create(&new)).map_err(storage_error)?;
    state
        .with_storage(|storage| storage.odyssey_view(&created.id))
        .map_err(storage_error)?
        .ok_or_else(|| thingmaker_supervisor::DesktopError::io("the goal disappeared after it was created"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditGoalRequest {
    pub id: String,
    #[serde(flatten)]
    pub edit: GoalEdit,
}

#[tauri::command]
pub fn odyssey_edit_goal(request: EditGoalRequest, state: State<'_, AppState>) -> CommandResult<OdysseyRecord> {
    state.with_storage(|storage| storage.odyssey_edit_goal(&request.id, &request.edit)).map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_delete(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.odyssey_delete(&id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMilestoneRequest {
    pub odyssey_id: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub check_kind: CheckKind,
    #[serde(default)]
    pub check_spec: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
}

#[tauri::command]
pub fn odyssey_add_milestone(request: AddMilestoneRequest, state: State<'_, AppState>) -> CommandResult<MilestoneRecord> {
    state
        .with_storage(|storage| storage.milestone_add(&request.odyssey_id, &request.title, &request.detail, request.check_kind, request.check_spec.as_deref(), request.section.as_deref()))
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMilestoneRequest {
    pub id: String,
    #[serde(flatten)]
    pub edit: MilestoneEdit,
}

#[tauri::command]
pub fn odyssey_edit_milestone(request: EditMilestoneRequest, state: State<'_, AppState>) -> CommandResult<MilestoneRecord> {
    state.with_storage(|storage| storage.milestone_edit(&request.id, &request.edit)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderRequest {
    pub odyssey_id: String,
    /// Every milestone of the goal, in the order they should end up.
    pub ordered_ids: Vec<String>,
}

#[tauri::command]
pub fn odyssey_reorder_milestones(request: ReorderRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.milestone_reorder(&request.odyssey_id, &request.ordered_ids))
        .map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_delete_milestone(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.milestone_delete(&id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStateRequest {
    pub id: String,
    pub state: OdysseyState,
}

/// Moves a goal between runner states. The runner writes every transition here
/// before acting on it, so a reload continues from the record.
#[tauri::command]
pub fn odyssey_set_state(request: SetStateRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.odyssey_set_state(&request.id, request.state)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationRequest {
    pub id: String,
    /// Tokens this continuation cost, from the transcript reader.
    pub tokens: i64,
}

#[tauri::command]
pub fn odyssey_record_continuation(request: ContinuationRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.odyssey_record_continuation(&request.id, request.tokens))
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneStateRequest {
    pub id: String,
    pub state: MilestoneState,
}

#[tauri::command]
pub fn odyssey_set_milestone_state(request: MilestoneStateRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.milestone_set_state(&request.id, request.state)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    pub id: String,
    pub note: String,
}

/// Records the model's own claim. It moves the milestone to `reported`; only a
/// check or the user can verify it.
#[tauri::command]
pub fn odyssey_record_report(request: ReportRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.milestone_record_report(&request.id, &request.note)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    pub id: String,
    pub passed: bool,
    pub output: String,
    /// Which lane produced this evidence; the badge shows it.
    pub source: CheckSource,
}

#[tauri::command]
pub fn odyssey_record_check(request: CheckRequest, state: State<'_, AppState>) -> CommandResult<MilestoneRecord> {
    state
        .with_storage(|storage| storage.milestone_record_check(&request.id, request.passed, &request.output, request.source))
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRequest {
    pub odyssey_id: String,
    pub kind: JournalKind,
    #[serde(default)]
    pub milestone_id: Option<String>,
    #[serde(default)]
    pub baseline_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[tauri::command]
pub fn odyssey_journal_append(request: JournalRequest, state: State<'_, AppState>) -> CommandResult<JournalEntry> {
    state
        .with_storage(|storage| {
            storage.odyssey_journal_append(
                &request.odyssey_id,
                request.kind,
                request.milestone_id.as_deref(),
                request.baseline_id.as_deref(),
                &request.summary,
                request.detail.as_deref(),
            )
        })
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddStepRequest {
    pub milestone_id: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[tauri::command]
pub fn odyssey_add_step(request: AddStepRequest, state: State<'_, AppState>) -> CommandResult<StepRecord> {
    state
        .with_storage(|storage| storage.step_add(&request.milestone_id, &request.title, &request.detail, &request.depends_on))
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStepRequest {
    pub id: String,
    #[serde(flatten)]
    pub edit: StepEdit,
}

#[tauri::command]
pub fn odyssey_edit_step(request: EditStepRequest, state: State<'_, AppState>) -> CommandResult<StepRecord> {
    state.with_storage(|storage| storage.step_edit(&request.id, &request.edit)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignStepRequest {
    pub id: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Records who is doing a task. The name comes from the agent's task line or
/// from a subagent named after the task; the harness and model come from the
/// session stream, so they are evidence rather than the agent's word.
#[tauri::command]
pub fn odyssey_assign_step(request: AssignStepRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.step_assign(&request.id, request.agent_name.as_deref(), request.harness.as_deref(), request.model.as_deref()))
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepStateRequest {
    pub id: String,
    pub state: StepState,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub fn odyssey_set_step_state(request: StepStateRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .with_storage(|storage| storage.step_set_state(&request.id, request.state, request.note.as_deref()))
        .map_err(storage_error)
}

#[tauri::command]
pub fn odyssey_delete_step(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|storage| storage.step_delete(&id)).map_err(storage_error)
}
