//! Prompt attachments and file mentions (UX-05..07).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use thingmaker_supervisor::{
    DesktopError,
    attachments::{AttachmentSnapshot, AttachmentStore, MAX_ATTACHMENT_BYTES},
    workspace::search_files,
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

fn store(state: &AppState) -> AttachmentStore {
    AttachmentStore::new(&state.data_dir)
}

fn record(state: &AppState, snapshot: &AttachmentSnapshot) -> CommandResult<()> {
    let relative = format!("attachments/{}", snapshot.id);
    state
        .with_storage(|s| s.attachment_upsert(&snapshot.id, &snapshot.id, &relative, &snapshot.mime, snapshot.bytes as i64))
        .map_err(storage_error)
}

/// An image attachment's bytes, for the composer thumbnail of something not
/// sent yet. Bounded and image-only: a thumbnail is a convenience, never a
/// reason to move a large or non-image blob through the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub id: String,
    pub mime: String,
    pub data_base64: String,
}

/// Largest attachment rendered as a composer thumbnail. Above this the chip
/// stays text-only rather than pushing megabytes into the page.
const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub id: String,
}

#[tauri::command]
pub fn attachment_preview(request: PreviewRequest, state: State<'_, AppState>) -> CommandResult<AttachmentPreview> {
    let (snapshot, bytes) = store(&state).load(&request.id)?;
    if snapshot.kind != thingmaker_supervisor::attachments::MediaKind::Image {
        return Err(DesktopError::unsupported("only image attachments have a preview"));
    }
    if snapshot.bytes > MAX_PREVIEW_BYTES {
        return Err(DesktopError::limit_exceeded("attachment is too large to preview"));
    }
    Ok(AttachmentPreview {
        id: snapshot.id,
        mime: snapshot.mime,
        data_base64: thingmaker_supervisor::attachments::base64(&bytes),
    })
}

/// Native multi-file picker; each file is validated and snapshotted.
#[tauri::command]
pub async fn attachment_pick(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Vec<AttachmentSnapshot>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Images and audio", &["png", "jpg", "jpeg", "gif", "webp", "wav", "mp3"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| DesktopError::io(e.to_string()))?;
    let Some(paths) = picked else { return Ok(Vec::new()) };
    let store = store(&state);
    let mut out = Vec::new();
    for path in paths {
        let path = path.into_path().map_err(|e| DesktopError::io(e.to_string()))?;
        let snapshot = store.add_path(&path)?;
        record(&state, &snapshot)?;
        out.push(snapshot);
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachPathsRequest {
    pub paths: Vec<String>,
}

/// Drag-and-drop paths from the OS. Each is read once and snapshotted.
#[tauri::command]
pub fn attachment_add_paths(request: AttachPathsRequest, state: State<'_, AppState>) -> CommandResult<Vec<AttachmentSnapshot>> {
    if request.paths.len() > 8 {
        return Err(DesktopError::limit_exceeded("at most 8 files at once"));
    }
    let store = store(&state);
    let mut out = Vec::new();
    for path in request.paths {
        let snapshot = store.add_path(&PathBuf::from(path))?;
        record(&state, &snapshot)?;
        out.push(snapshot);
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachBytesRequest {
    pub name: String,
    /// Base64 payload from a clipboard paste in the renderer.
    pub data_base64: String,
}

fn decode_base64(input: &str) -> Result<Vec<u8>, DesktopError> {
    const fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut acc: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            let v = val(*c).ok_or_else(|| DesktopError::io("invalid base64"))?;
            acc |= u32::from(v) << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        match chunk.len() {
            4 => out.extend_from_slice(&bytes[1..4]),
            3 => out.extend_from_slice(&bytes[1..3]),
            2 => out.push(bytes[1]),
            _ => return Err(DesktopError::io("invalid base64 length")),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn attachment_add_bytes(request: AttachBytesRequest, state: State<'_, AppState>) -> CommandResult<AttachmentSnapshot> {
    if request.data_base64.len() as u64 > MAX_ATTACHMENT_BYTES * 4 / 3 + 4 {
        return Err(DesktopError::limit_exceeded("attachment exceeds 10 MiB"));
    }
    let bytes = decode_base64(&request.data_base64)?;
    let snapshot = store(&state).add_bytes(&request.name, &bytes, None)?;
    record(&state, &snapshot)?;
    Ok(snapshot)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchRequest {
    pub workspace_id: String,
    pub query: String,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub matches: Vec<String>,
    pub truncated: bool,
}

/// Mention autocomplete over the ignore-aware tree (UX-05). Bounded walk; no
/// content is read.
#[tauri::command]
pub fn workspace_search_files(request: FileSearchRequest, state: State<'_, AppState>) -> CommandResult<FileSearchResult> {
    let record = state
        .with_storage(|s| s.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    let (matches, truncated) = search_files(&PathBuf::from(record.canonical_root), &request.query, request.limit.clamp(1, 200));
    Ok(FileSearchResult { matches, truncated })
}
