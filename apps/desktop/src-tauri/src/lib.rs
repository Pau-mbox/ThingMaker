//! ThingMaker Tauri host.
//!
//! This crate is deliberately thin (ADR-03): it wires the narrow command
//! surface in [`commands`] to the native supervisor and manages application
//! state (storage, live session actors, provider resolution). No generic RPC
//! tunnel, shell execution or unrestricted filesystem access is exposed.
//!
//! Window lifecycle (ARCH-02): closing the last window never silently stops
//! local work. Depending on the stored preference the window hides to the
//! tray, the app quits after stopping agents, or the renderer asks.

pub mod commands;
pub mod state;

use tauri::{
    Emitter, Manager, RunEvent, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

use commands::app::{CloseBehavior, load_settings, quit_and_stop, show_main_window};

pub const CLOSE_REQUESTED_EVENT: &str = "thingmaker://close-requested";

/// Handle used to attach the rolling file layer once the data directory is
/// known (REL-05). Logs never carry prompt content or credentials.
type FileLayer = Option<Box<dyn tracing_subscriber::Layer<tracing_subscriber::Registry> + Send + Sync>>;

/// Brings data over from before the app was called ThingMaker.
///
/// The bundle identifier was `dev.claudex.desktop` and the database
/// `claudex.db`; a new identifier is a new data directory, which would start
/// the app empty. On the first start without a database, the old directory
/// is copied (never moved: it stays as it was, as a backup) and its database
/// renamed. The team socket is not copied: the running app makes its own.
fn migrate_legacy_data(data_dir: &std::path::Path) {
    if data_dir.join("thingmaker.db").exists() {
        return;
    }
    let Some(parent) = data_dir.parent() else { return };
    let legacy_id = if data_dir.ends_with("dev.thingmaker.desktop.dev") { "dev.claudex.desktop.dev" } else { "dev.claudex.desktop" };
    let legacy = parent.join(legacy_id);
    if !legacy.join("claudex.db").is_file() {
        return;
    }
    fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().ends_with(".sock") {
                continue;
            }
            let kind = entry.file_type()?;
            let target = to.join(&name);
            if kind.is_dir() {
                copy_tree(&entry.path(), &target)?;
            } else if kind.is_file() {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    match copy_tree(&legacy, data_dir) {
        Ok(()) => {
            for suffix in ["", "-wal", "-shm"] {
                let old = data_dir.join(format!("claudex.db{suffix}"));
                if old.exists() {
                    let _ = std::fs::rename(&old, data_dir.join(format!("thingmaker.db{suffix}")));
                }
            }
            eprintln!("ThingMaker: brought data over from {}", legacy.display());
        }
        Err(error) => eprintln!("ThingMaker: could not bring data over from {}: {error}", legacy.display()),
    }
}

pub fn run() {
    use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};
    // One global filter for both outputs: per-layer filters cannot live inside
    // a reloadable slot that starts empty (they would have no FilterId).
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let (file_layer, file_handle) = tracing_subscriber::reload::Layer::<FileLayer, tracing_subscriber::Registry>::new(None);
    let file_handle = std::sync::Arc::new(file_handle);
    tracing_subscriber::registry()
        .with(file_layer)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(filter)
        .init();
    // Kept alive for the process lifetime so buffered log lines are flushed.
    static LOG_GUARD: std::sync::OnceLock<tracing_appender::non_blocking::WorkerGuard> = std::sync::OnceLock::new();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let file_handle = std::sync::Arc::clone(&file_handle);
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("app data dir unavailable: {error}"))?;
            migrate_legacy_data(&data_dir);
            let logs_dir = data_dir.join("logs");
            if std::fs::create_dir_all(&logs_dir).is_ok() {
                commands::support::prune_logs(&data_dir);
                let appender = tracing_appender::rolling::daily(&logs_dir, "desktop.log");
                let (writer, guard) = tracing_appender::non_blocking(appender);
                let _ = LOG_GUARD.set(guard);
                let layer = tracing_subscriber::fmt::layer().with_ansi(false).with_target(true).with_writer(writer).boxed();
                let _ = file_handle.modify(|slot| *slot = Some(layer));
            }
            let resource_dir = app.path().resource_dir().ok();
            let state = state::AppState::initialize(&data_dir, resource_dir.as_deref())
                .map_err(|error| format!("could not initialize desktop state: {error}"))?;
            app.manage(state);
            // Delegation is an addition, not a precondition: without its
            // socket, sessions open as plain ones.
            if let Err(error) = commands::delegation::start(app.handle()) {
                tracing::warn!(%error, "delegation unavailable");
            }
            // Super Thing runs in the host, whether or not a window is open.
            commands::superthing::start(app.handle());

            let show = MenuItem::with_id(app, "show", "Show ThingMaker", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit and stop local tasks", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("ThingMaker")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        tauri::async_runtime::spawn(quit_and_stop(app.clone(), true));
                    }
                    _ => {}
                });
            // A transparent silhouette, not the Dock tile. macOS template rendering
            // automatically supplies the right color for light and dark menu bars.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            tray = tray.icon(tray_icon).icon_as_template(cfg!(target_os = "macos"));
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let behavior = app
                    .try_state::<state::AppState>()
                    .map(|state| load_settings(&state).close_behavior)
                    .unwrap_or_default();
                match behavior {
                    CloseBehavior::Tray => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    CloseBehavior::Quit => {
                        api.prevent_close();
                        tauri::async_runtime::spawn(quit_and_stop(app, true));
                    }
                    CloseBehavior::Ask => {
                        api.prevent_close();
                        let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::execution_profiles,
            commands::workspace::workspace_inspect,
            commands::workspace::workspace_trust,
            commands::workspace::workspace_list,
            commands::workspace::workspace_remove,
            commands::workspace::workspace_pick,
            commands::workspace::reveal_in_finder,
            commands::session::session_open,
            commands::session::session_subscribe,
            commands::session::session_snapshot,
            commands::session::session_submit,
            commands::session::session_steer,
            commands::session::session_cancel,
            commands::session::session_set_config_option,
            commands::session::session_stop,
            commands::session::session_list_open,
            commands::session::session_history,
            commands::session::session_token_usage,
            commands::session::outbox_list,
            commands::session::outbox_resolve,
            commands::terminal::terminal_open,
            commands::terminal::terminal_list,
            commands::terminal::terminal_subscribe,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_export,
            commands::terminal::save_text_file,
            commands::skills::context_sources_for_workspace,
            commands::skills::config_read_file,
            commands::skills::config_write_file,
            commands::skills::skill_create,
            commands::skills::skill_import_pick,
            commands::skills::skill_import_from_paths,
            commands::skills::skill_import_annotate,
            commands::skills::skill_import_apply,
            commands::skills::skill_import_discard,
            commands::skills::skill_remove,
            commands::runtime_env::runtime_env_list,
            commands::runtime_env::runtime_env_set,
            commands::runtime_env::runtime_env_remove,
            commands::review::workspace_image,
            commands::review::generated_image,
            commands::attachments::attachment_pick,
            commands::attachments::attachment_add_paths,
            commands::attachments::attachment_add_bytes,
            commands::attachments::attachment_preview,
            commands::attachments::workspace_search_files,
            commands::artifacts::artifacts_refresh,
            commands::artifacts::artifacts_list,
            commands::artifacts::artifact_read,
            commands::artifacts::artifacts_export_preview,
            commands::artifacts::artifacts_export,
            commands::support::support_bundle_preview,
            commands::support::storage_inspect,
            commands::support::cleanup_preview,
            commands::support::cleanup_run,
            commands::app::pref_get,
            commands::app::pref_set,
            commands::session::session_archive,
            commands::session::session_pin,
            commands::session::session_rename,
            commands::superthing::superthing_start,
            commands::superthing::superthing_pause,
            commands::superthing::superthing_tick,
            commands::superthing::superthing_move,
            commands::superthing::superthing_verify,
            commands::superthing::superthing_run_check,
            commands::superthing::superthing_request_plan,
            commands::superthing::superthing_amend,
            commands::superthing::superthing_decide_plan_change,
            commands::superthing::superthing_answer,
            commands::superthing::superthing_runtime,
            commands::superthing::superthing_briefing,
            commands::superthing::superthing_commits,
            commands::superthing::superthing_rollback,
            commands::superthing::superthing_merge,
            commands::superthing::memory_list,
            commands::superthing::memory_write,
            commands::superthing::memory_delete,
            commands::odyssey::odyssey_read_plan,
            commands::odyssey::odyssey_adopt_plan,
            commands::odyssey::odyssey_for_session,
            commands::odyssey::odyssey_view,
            commands::odyssey::odyssey_repoint,
            commands::odyssey::odyssey_claude_preflight,
            commands::odyssey::odyssey_install_delegate,
            commands::odyssey::odyssey_list,
            commands::odyssey::odyssey_create,
            commands::odyssey::odyssey_edit_goal,
            commands::odyssey::odyssey_delete,
            commands::odyssey::odyssey_add_milestone,
            commands::odyssey::odyssey_edit_milestone,
            commands::odyssey::odyssey_reorder_milestones,
            commands::odyssey::odyssey_delete_milestone,
            commands::odyssey::odyssey_set_state,
            commands::odyssey::odyssey_record_continuation,
            commands::odyssey::odyssey_set_milestone_state,
            commands::odyssey::odyssey_record_report,
            commands::odyssey::odyssey_record_check,
            commands::odyssey::odyssey_run_check,
            commands::odyssey::odyssey_install_skill,
            commands::odyssey::odyssey_set_plan,
            commands::odyssey::odyssey_plan_document,
            commands::odyssey::odyssey_inspect_refs,
            commands::odyssey::odyssey_amend_add,
            commands::odyssey::odyssey_amend_list,
            commands::odyssey::odyssey_amend_document,
            commands::odyssey::odyssey_amend_set_state,
            commands::odyssey::odyssey_amend_mark_told,
            commands::odyssey::odyssey_journal_append,
            commands::odyssey::odyssey_add_step,
            commands::odyssey::odyssey_set_step_state,
            commands::odyssey::odyssey_delete_step,
            commands::odyssey::odyssey_edit_step,
            commands::odyssey::odyssey_assign_step,
            commands::odyssey::odyssey_reorder_steps,
            commands::odyssey::odyssey_plan_change_add,
            commands::odyssey::odyssey_plan_change_list,
            commands::odyssey::odyssey_plan_change_decide,
            commands::odyssey::odyssey_question_add,
            commands::odyssey::odyssey_question_list,
            commands::odyssey::odyssey_question_settle,
            commands::odyssey::odyssey_checkpoint,
            commands::odyssey::odyssey_usage_sample_add,
            commands::odyssey::odyssey_spend_model,
            commands::odyssey::odyssey_workspace_notes,
            commands::session::session_records,
            commands::providers::open_external,
            commands::providers::providers_status,
            commands::providers::provider_set_location,
            commands::providers::provider_login_start,
            commands::providers::provider_login_cancel,
            commands::providers::provider_models,
            commands::providers::provider_quota,
            commands::providers::provider_logout,
            commands::delegation::delegation_combo_get,
            commands::delegation::delegation_combo_set,
            commands::delegation::delegation_default_combo_get,
            commands::delegation::delegation_default_combo_set,
            commands::delegation::delegation_jobs,
            commands::delegation::delegation_job_cancel,
            commands::delegation::delegation_quota,
            commands::delegation::delegation_job_retry,
            commands::delegation::delegation_retry_policy_get,
            commands::delegation::delegation_retry_policy_set,
            commands::app::settings_get,
            commands::app::settings_set,
            commands::app::app_hide_to_tray,
            commands::app::app_quit,
            commands::app::confirm_dialog,
            commands::app::app_activity,
            commands::review::workspace_list_dir,
            commands::review::file_read,
            commands::review::file_write_checked,
            commands::review::review_capture_baseline,
            commands::review::review_baselines,
            commands::review::review_diff,
            commands::git::git_info,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_revert_file,
            commands::git::git_apply_hunk,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::review_file_versions,
            commands::git::worktree_list,
            commands::git::worktree_create,
            commands::git::worktree_remove_preview,
            commands::git::worktree_remove,
            commands::git::worktree_pin,
            commands::git::open_in_editor,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ThingMaker");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main_window(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
