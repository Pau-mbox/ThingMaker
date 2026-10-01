//! Artifact gallery, safe viewing and export (ART-01, ART-02, ART-04).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use thingmaker_supervisor::{
    DesktopError,
    artifacts::{
        ArtifactBlobs, ArtifactCandidate, ExportManifestEntry, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_TEXT_BYTES, Viewer, classify,
        export_file_name, observed_candidates, sensitive_hits,
    },
    review::{BlobStore, baseline::capture_baseline, diff::diff_against_baseline},
    storage::artifacts::{ArtifactRecord, NewArtifact},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsRefreshRequest {
    pub workspace_id: String,
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsRefreshOutcome {
    pub scanned: usize,
    pub new_versions: usize,
    pub artifacts: Vec<ArtifactRecord>,
    pub notes: Vec<String>,
}

/// Scans the workspace changes against the session baseline, recording new
/// versions where content changed. Files an agent reports producing are
/// recorded as they are reported, not here.
#[tauri::command]
pub async fn artifacts_refresh(request: ArtifactsRefreshRequest, state: State<'_, AppState>) -> CommandResult<ArtifactsRefreshOutcome> {
    let record = state
        .with_storage(|s| s.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    let root = PathBuf::from(&record.canonical_root);
    let data_dir = state.data_dir.clone();
    let storage = state.inner_arc();
    let workspace_id = record.id.clone();
    let agent_session_id = request.agent_session_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<ArtifactsRefreshOutcome> {
        let mut notes = Vec::new();
        let mut candidates: Vec<ArtifactCandidate> = Vec::new();
        if let Some(agent_id) = &agent_session_id {
            let desktop_session = storage.with_storage(|s| s.session_by_agent_id(&workspace_id, agent_id)).map_err(storage_error)?.map(|s| s.id);
            let latest = storage.with_storage(|s| s.baseline_latest(&workspace_id, desktop_session.as_deref())).map_err(storage_error)?;
            match latest {
                Some(latest) => {
                    if let Some((_, manifest)) = storage.with_storage(|s| s.baseline_get(&latest.id)).map_err(storage_error)? {
                        let blobs = BlobStore::new(data_dir.join("blobs"));
                        let current = capture_baseline(&root, &blobs)?;
                        let report = diff_against_baseline(&manifest, &current, &blobs, "session_baseline", "artifact scan", "")?;
                        candidates.extend(observed_candidates(&root, &report));
                    }
                }
                None => notes.push("No session baseline exists, so observed workspace changes were not scanned.".into()),
            }
        } else {
            notes.push("Without a session, only previously recorded artifacts are listed.".into());
        }
        let blobs = ArtifactBlobs::new(&data_dir);
        let mut new_versions = 0;
        let scanned = candidates.len();
        for candidate in candidates {
            let bytes = match std::fs::read(&candidate.source_path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    notes.push(format!("{}: {error}", candidate.logical_path));
                    continue;
                }
            };
            let classification = classify(&candidate.source_path, &bytes);
            let hash = blobs.put(&bytes)?;
            let (_, inserted) = storage
                .with_storage(|s| {
                    s.artifact_record_version(NewArtifact {
                        workspace_id: &workspace_id,
                        agent_session_id: agent_session_id.as_deref(),
                        call_id: candidate.call_id.as_deref(),
                        logical_path: &candidate.logical_path,
                        mime: &classification.mime,
                        viewer: classification.viewer,
                        content_hash: &hash,
                        bytes: bytes.len() as i64,
                        provenance: candidate.provenance,
                        source_path: &candidate.source_path.to_string_lossy(),
                    })
                })
                .map_err(storage_error)?;
            if inserted {
                new_versions += 1;
            }
        }
        let artifacts = storage.with_storage(|s| s.artifact_list(&workspace_id, agent_session_id.as_deref(), 500)).map_err(storage_error)?;
        Ok(ArtifactsRefreshOutcome { scanned, new_versions, artifacts, notes })
    })
    .await
    .map_err(|e| DesktopError::io(e.to_string()))?
}

#[tauri::command]
pub fn artifacts_list(workspace_id: String, agent_session_id: Option<String>, state: State<'_, AppState>) -> CommandResult<Vec<ArtifactRecord>> {
    state
        .with_storage(|s| s.artifact_list(&workspace_id, agent_session_id.as_deref(), 500))
        .map_err(storage_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub record: ArtifactRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub truncated: bool,
    /// Why inline viewing is unavailable, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Returns viewable content for one version. Images are re-validated
/// (sniffed type and decoded dimensions) before any bytes reach the renderer.
#[tauri::command]
pub fn artifact_read(id: String, state: State<'_, AppState>) -> CommandResult<ArtifactContent> {
    let record = state
        .with_storage(|s| s.artifact_get(&id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("artifact not found"))?;
    let bytes = ArtifactBlobs::new(&state.data_dir).get(&record.content_hash)?;
    let mut content = ArtifactContent { record: record.clone(), text: None, data_base64: None, width: None, height: None, truncated: false, unavailable: None };
    match record.viewer {
        Viewer::Image => {
            let sniffed = thingmaker_supervisor::attachments::sniff_media(&bytes);
            match sniffed {
                Some((thingmaker_supervisor::attachments::MediaKind::Image, mime)) => {
                    let dims = thingmaker_supervisor::attachments::image_dimensions(&bytes, mime);
                    match dims {
                        Some((w, h)) if u64::from(w) * u64::from(h) <= thingmaker_supervisor::attachments::MAX_IMAGE_PIXELS && bytes.len() <= MAX_INLINE_IMAGE_BYTES => {
                            content.width = Some(w);
                            content.height = Some(h);
                            content.data_base64 = Some(base64(&bytes));
                        }
                        _ => content.unavailable = Some("image is too large to preview inline; open it externally".into()),
                    }
                }
                _ => content.unavailable = Some("content no longer sniffs as an image".into()),
            }
        }
        Viewer::External => content.unavailable = Some("this type is not previewed in the app; open it with an external application".into()),
        _ => {
            let slice = &bytes[..bytes.len().min(MAX_INLINE_TEXT_BYTES)];
            content.truncated = slice.len() < bytes.len();
            content.text = Some(String::from_utf8_lossy(slice).into_owned());
        }
    }
    Ok(content)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub directory: Option<String>,
    pub written: Vec<ExportManifestEntry>,
    pub excluded: Vec<ExportExclusion>,
    pub sensitive_hits: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportExclusion {
    pub id: String,
    pub reason: String,
}

/// Preview of what an export would contain (exclusions and sensitive-data
/// warnings) without writing anything.
#[tauri::command]
pub fn artifacts_export_preview(request: ExportRequest, state: State<'_, AppState>) -> CommandResult<ExportOutcome> {
    let (written, excluded, hits) = plan_export(&request.ids, &state)?;
    Ok(ExportOutcome { directory: None, written, excluded, sensitive_hits: hits })
}

fn plan_export(ids: &[String], state: &AppState) -> CommandResult<(Vec<ExportManifestEntry>, Vec<ExportExclusion>, usize)> {
    if ids.len() > 500 {
        return Err(DesktopError::limit_exceeded("export at most 500 artifacts at once"));
    }
    let blobs = ArtifactBlobs::new(&state.data_dir);
    let mut written = Vec::new();
    let mut excluded = Vec::new();
    let mut hits = 0;
    for id in ids {
        let Some(record) = state.with_storage(|s| s.artifact_get(id)).map_err(storage_error)? else {
            excluded.push(ExportExclusion { id: id.clone(), reason: "unknown artifact".into() });
            continue;
        };
        let bytes = match blobs.get(&record.content_hash) {
            Ok(bytes) => bytes,
            Err(error) => {
                excluded.push(ExportExclusion { id: id.clone(), reason: error.message });
                continue;
            }
        };
        if matches!(record.viewer, Viewer::Text | Viewer::Markdown | Viewer::Json | Viewer::Code | Viewer::MarkupSource) {
            hits += sensitive_hits(&String::from_utf8_lossy(&bytes));
        }
        written.push(ExportManifestEntry {
            id: record.id.clone(),
            logical_path: record.logical_path.clone(),
            exported_as: export_file_name(&record.logical_path, record.version),
            content_hash: record.content_hash.clone(),
            bytes: bytes.len() as u64,
            mime: record.mime.clone(),
            provenance: record.provenance,
            call_id: record.call_id.clone(),
            agent_session_id: record.agent_session_id.clone(),
            version: record.version,
            created_at: record.created_at,
        });
    }
    Ok((written, excluded, hits))
}

/// Writes the selected versions plus `artifact-manifest.json` into a folder
/// chosen through the native dialog. Local export only; publishing is a
/// separate adapter that does not exist in this release.
#[tauri::command]
pub async fn artifacts_export(request: ExportRequest, app: AppHandle, state: State<'_, AppState>) -> CommandResult<ExportOutcome> {
    use tauri_plugin_dialog::DialogExt;
    let (written, excluded, hits) = plan_export(&request.ids, &state)?;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| DesktopError::io(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(ExportOutcome { directory: None, written: Vec::new(), excluded, sensitive_hits: hits });
    };
    let folder = folder.into_path().map_err(|e| DesktopError::io(e.to_string()))?;
    let blobs = ArtifactBlobs::new(&state.data_dir);
    for entry in &written {
        let bytes = blobs.get(&entry.content_hash)?;
        let target = folder.join(&entry.exported_as);
        if target.exists() {
            return Err(DesktopError::conflict(format!("{} already exists in the chosen folder", entry.exported_as)));
        }
        std::fs::write(&target, bytes).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    let manifest = serde_json::json!({
        "generatedAt": thingmaker_supervisor::storage::now_unix_ms(),
        "generator": "ThingMaker",
        "hashAlgorithm": "blake3",
        "artifacts": written,
        "excluded": excluded,
        "sensitiveHits": hits,
        "note": "Provenance 'observed' means the desktop saw the file change during the session; it is not proof the agent produced it.",
    });
    std::fs::write(folder.join("artifact-manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap_or_default())
        .map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(ExportOutcome { directory: Some(folder.to_string_lossy().into_owned()), written, excluded, sensitive_hits: hits })
}
