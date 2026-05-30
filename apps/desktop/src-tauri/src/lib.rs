// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, Submenu, PredefinedMenuItem};

mod commands;
pub mod core;
#[allow(dead_code)]
mod query_expander;
mod state;
mod diagnostics;

use crate::state::{AIStateWrapper, AssetIndex, AssetIndexState, DbStateWrapper, SessionStateWrapper, WatcherState, SyncingState, RefactoringState};
use crate::core::sidecar::{SidecarManager, SidecarState};


pub struct MediaEmbeddingLock(pub tokio::sync::Mutex<()>);

// ============================================================================
// Misc
// ============================================================================

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_sidecar_url(state: tauri::State<'_, SidecarState>) -> String {
    state.0.base_url_or_fallback()
}

#[tauri::command]
fn relaunch_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

#[tauri::command]
fn safe_dir_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn safe_create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

// ============================================================================
// App Entry Point
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set NO_PROXY to bypass local proxy for Ollama
    std::env::set_var("NO_PROXY", "localhost,127.0.0.1,::1");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tauri_appslash_lib", log::LevelFilter::Debug)
                .level_for("slash", log::LevelFilter::Debug)
                .level_for("webview", log::LevelFilter::Debug)
                // Keep the most recent 7 rotated log files.
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(7))
                // Set max file size to 5 MB per file (ensuring we export ~1 day per file minimum on average)
                .max_file_size(5_000_000)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .setup(|app| {
            // 建立极简的系统菜单，防止 macOS 默认菜单吞噬 Cmd+N/Cmd+F/Cmd+S 等前端快捷键，同时保留 Cmd+C/V 等原生剪贴板
            #[cfg(target_os = "macos")]
            {
                let app_menu = Submenu::new(app, "Slash", true)?;
                app_menu.append(&PredefinedMenuItem::about(app, None, None)?)?;
                app_menu.append(&PredefinedMenuItem::separator(app)?)?;
                app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
                app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
                app_menu.append(&PredefinedMenuItem::separator(app)?)?;
                app_menu.append(&PredefinedMenuItem::quit(app, None)?)?;

                let edit_menu = Submenu::new(app, "Edit", true)?;
                edit_menu.append(&PredefinedMenuItem::undo(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::redo(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
                edit_menu.append(&PredefinedMenuItem::cut(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::copy(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::paste(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::select_all(app, None)?)?;

                let menu = Menu::new(app)?;
                menu.append(&app_menu)?;
                menu.append(&edit_menu)?;
                
                app.set_menu(menu)?;
            }

            let app_handle = app.handle().clone();
            let ai_state = app.state::<AIStateWrapper>();
            let queue_manager = core::ai::queue::AIQueueManager::new(ai_state.runtime.clone(), app_handle.clone());
            let _ = ai_state.queue.set(queue_manager);

            // Phase 6: 启动 TransferManager 后台 scheduler
            core::transfer_manager::TransferManager::start_scheduler(app_handle.clone());

            // 启动 Sidecar (MarkItDown)
            let sidecar_state = app.state::<SidecarState>();
            if let Err(e) = sidecar_state.0.start() {
                log::error!("🔧 [Sidecar] Failed to start: {}", e);
            }

            #[cfg(any(debug_assertions, target_os = "windows"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    #[cfg(debug_assertions)]
                    {
                        let _ = window.show();
                        window.open_devtools();
                    }

                    #[cfg(target_os = "windows")]
                    {
                        let _ = window.set_decorations(false);
                    }
                }
            }
            Ok(())
        })
        .manage(DbStateWrapper::default())
        .manage(WatcherState::default())
        .manage(AIStateWrapper::default())
        .manage(AssetIndexState(Mutex::new(AssetIndex::default())))
        .manage(SessionStateWrapper::default())
        .manage(crate::state::SyncCapabilitiesState::default())
        .manage(crate::state::TransferNotifyState::default())
        .manage(SyncingState::default())
        .manage(RefactoringState::default())
        .manage(MediaEmbeddingLock(tokio::sync::Mutex::new(())))
        .manage(SidecarState(SidecarManager::new()))
        .invoke_handler(tauri::generate_handler![
            greet,
            get_sidecar_url,
            // Auth (New)
            commands::auth::secure_store_tokens,
            commands::auth::get_access_token,
            commands::auth::secure_logout,
            commands::auth::refresh_session,
            commands::auth::save_login_credential,
            commands::auth::get_login_credential,
            commands::auth::delete_login_credential,
            // Assets (New)
            commands::assets::save_asset,
            commands::assets::save_asset_from_path,
            commands::assets::clean_unused_assets,
            commands::assets::rebuild_asset_index,
            commands::assets::load_asset_index,
            commands::assets::get_clipboard_file_paths,
            // FS (New)
            commands::fs::move_to_trash,
            commands::fs::purge_stale_note_data,
            commands::fs::move_file,
            commands::fs::show_in_folder,
            // AI Skills
            commands::ai::trigger_ai_skill,
            commands::ai::get_ai_skill_configs,
            commands::ai::update_ai_skill_config,
            // AI Data
            commands::ai::get_note_ai_data,
            commands::ai::accept_ai_title,
            commands::ai::set_user_title,
            commands::ai::get_notes_with_pending_title,
            commands::ai::get_ghost_links,
            commands::ai::ignore_ghost_link,
            // AI Reasoning
            commands::ai::get_ghost_link_reasons,
            commands::ai::get_cached_ghost_link_reasons,
            commands::ai::add_note_relation,
            commands::ai::infer_wikilink_relation,
            // AI Feedback
            commands::ai::accept_ai_tag,
            commands::ai::reject_ai_tag,
            commands::ai::accept_ai_summary,
            commands::ai::log_tag_correction,
            // AI Service
            commands::ai::check_ai_connection,
            commands::ai::check_effective_ai_connection,
            commands::ai::get_ai_config,
            commands::ai::get_effective_provider_type,
            commands::ai::process_single_note,
            commands::ai::process_dirty_notes_batch,
            commands::ai::get_dirty_notes_count,
            // AI Orchestrator (Embedding Pipeline Only)
            commands::ai::trigger_ai_orchestrated,
            // AI Magic Wand (UX v2: Atomic Skill Triggers)
            commands::ai::run_summary,
            commands::ai::run_tagging,
            commands::ai::run_smart_rename,
            commands::ai::abort_note_ai_jobs,
            commands::ai::register_active_note_ai,
            // AI Usage Logs
            commands::ai::get_ai_usage_logs,
            // AI Provider Config
            commands::ai::get_ai_provider_config,
            commands::ai::set_ai_provider_config,
            commands::ai::get_folder_ai_config,
            commands::ai::save_folder_ai_config,
            commands::ai::fetch_online_models,
            commands::ai::fetch_saved_provider_models,
            commands::ai::check_ollama_model,
            commands::ai::list_ollama_models,
            commands::ai::restore_ai_config,
            commands::ai::pull_ollama_model,
            commands::ai::get_online_providers,
            commands::ai::save_online_provider,
            commands::ai::activate_online_provider,
            commands::ai::delete_online_provider,
            // Custom Skills (User-defined YAML Skills)
            commands::ai::list_custom_skills,
            commands::ai::load_custom_skill_yaml,
            commands::ai::save_custom_skill,
            commands::ai::delete_custom_skill,
            commands::ai::execute_custom_skill,
            commands::db::init_db,
            commands::db::close_db,
            commands::db::scan_vault,
            commands::db::scan_single_file,
            commands::db::get_notes,
            commands::db::get_links,
            commands::db::get_dirty_notes,
            commands::db::check_note_exists,
            commands::db::get_note_preview,
            commands::db::rename_note_in_db,
            commands::db::rebuild_from_files,
            commands::db::ensure_para_structure,
            // Watcher
            commands::db::start_watcher,
            // Graph (New)
            commands::graph::get_note_graph,
            commands::graph::get_global_graph,
            commands::graph::get_note_backlinks_by_section,
            // Tasks (New)
            commands::tasks::scan_note_tasks,
            commands::tasks::get_tasks,
            commands::tasks::get_note_tasks,
            commands::tasks::filter_tasks,
            commands::tasks::scan_all_tasks,
            commands::tasks::update_task_completion,
            // Classification (Smart Archiving)
            commands::ai::get_classification_suggestions,
            commands::ai::get_cached_classification,
            commands::ai::save_classification_suggestions,
            commands::ai::accept_classification,
            commands::ai::refresh_folder_embeddings,
            commands::ai::init_folder_embeddings,
            commands::ai::get_all_available_folders,
            // Search (Hybrid + HyDE + RAG)
            commands::search::hybrid_search,
            commands::search::quick_search,
            commands::search::hyde_search,
            commands::search::deep_search,
            // Embedding Pipeline
            commands::embedding::get_embedding_stats,
            commands::embedding::check_embedding_version_mismatch,
            commands::embedding::trigger_embedding_rebuild,
            commands::embedding::trigger_note_embedding_rebuild,
            commands::embedding::pause_embedding_pipeline,
            commands::embedding::clear_embedding_cache,
            commands::embedding::clear_note_embeddings,
            commands::embedding::retry_failed_embeddings,
            commands::embedding::clean_abandoned_embeddings,
            commands::embedding::rebuild_all_embeddings,
            commands::embedding::get_notes_needing_rebuild,
            commands::embedding::process_note_embedding,
            commands::embedding::start_embedding_worker,
            commands::embedding::process_all_embeddings,
            // Media Embedding (Phase 6)
            commands::embedding::get_media_pending_count,
            commands::embedding::get_note_media_status,
            commands::embedding::trigger_media_embedding,
            commands::embedding::trigger_schedule_note,
            commands::embedding::get_enriched_content,
            commands::embedding::save_media_enrich_cache,
            // Drawing (Tldraw Canvas)
            commands::drawing::save_drawing,
            commands::drawing::load_drawing_json,
            commands::drawing::delete_drawing,
            // Screenshot (Native Window Capture)
            commands::screenshot::capture_element_screenshot,
            // Sync (Server Sync Protocol)
            commands::sync::personal::sync_vault,
            commands::sync::promote::push_directory_to_vault,
            commands::sync::team::check_sync_connection,
            commands::sync::team::ensure_team_sync_state,
            commands::sync::team::get_sync_capabilities,
            commands::sync::team::update_local_sync_capabilities,
            // Maintenance
            commands::maintenance::export_diagnostics,
            // Transfer Manager (Phase 6)
            commands::transfer::transfer_get_queue,
            commands::transfer::transfer_enqueue_upload,
            commands::transfer::transfer_enqueue_download,
            commands::transfer::transfer_recover_missing_asset,
            commands::transfer::transfer_retry_task,
            commands::transfer::transfer_clear_completed,
            // Editor Metadata
            commands::editor::batch_update_editor,
            relaunch_app,
            safe_dir_exists,
            safe_create_dir,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Err(e) = window.emit("slash://file-drop", paths) {
                    log::error!("❌ [Rust] Failed to emit slash://file-drop: {}", e);
                }
            }
        });

    let app = builder.build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                log::info!("🛑 [Tauri] App is exiting, shutting down sidecar...");
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    state.0.shutdown();
                }
            }
            _ => {}
        }
    });
}
