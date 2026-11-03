//! Updates of ThingMaker itself, from its GitHub releases (REL-03).
//!
//! The release pipeline publishes signed bundles and a `latest.json`; the
//! updater plugin reads it from the endpoint in `tauri.conf.json` and checks
//! every download against the public key pinned there before installing. A
//! check keeps the update it found, so installing is the one the person saw.

use serde::Serialize;
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_updater::UpdaterExt;
use thingmaker_supervisor::DesktopError;

use super::CommandResult;
use crate::state::AppState;

/// A newer release than the running one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    /// The release notes, as written on the release.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The version running now.
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<AvailableUpdate>,
}

/// How far the download is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Asks the release endpoint whether there is a newer version.
#[tauri::command]
pub async fn app_update_check(app: AppHandle, state: State<'_, AppState>) -> CommandResult<UpdateCheck> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|error| DesktopError::unsupported(format!("updates are not available in this build: {error}")))?;
    let found = updater.check().await.map_err(|error| DesktopError::io(format!("could not check for updates: {error}")))?;
    let available = found.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        published_at_unix_ms: update.date.map(|date| date.unix_timestamp() * 1000),
    });
    *state.pending_update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = found;
    Ok(UpdateCheck { current, available })
}

/// Downloads the update the last check found, verifies and installs it, and
/// restarts into it. On Windows the installer closes the app itself.
#[tauri::command]
pub async fn app_update_install(app: AppHandle, on_progress: Channel<UpdateProgress>, state: State<'_, AppState>) -> CommandResult<()> {
    let update = state
        .pending_update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
        .ok_or_else(|| DesktopError::not_ready("there is no update to install; check again"))?;
    tracing::info!(from = %update.current_version, to = %update.version, "installing an update");
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                // About every 256 KiB, so the screen moves without a flood of messages.
                if downloaded - reported >= 256 * 1024 || total.is_some_and(|total| downloaded >= total) {
                    reported = downloaded;
                    let _ = on_progress.send(UpdateProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|error| DesktopError::io(format!("the update could not be installed: {error}")))?;
    tracing::info!("update installed; restarting");
    app.restart()
}
