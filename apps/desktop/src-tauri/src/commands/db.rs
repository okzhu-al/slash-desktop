use crate::state::{DbStateWrapper, WatcherState};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use walkdir::WalkDir;

// --- PARA ---

/// Required PARA folders with numerical prefixes for proper sorting
const PARA_FOLDERS: &[&str] = &[
    "00_Inbox",
    "01_Projects",
    "02_Areas",
    "03_Resources",
    "04_Archives",
    "assets",
];

/// Ensures the PARA directory structure exists in the vault
#[tauri::command]
pub fn ensure_para_structure(vault_path: String) -> Result<Vec<String>, String> {
    let vault = Path::new(&vault_path);

    if !vault.exists() {
        return Err(format!("Vault path does not exist: {}", vault_path));
    }

    let mut created_folders: Vec<String> = Vec::new();

    for folder_name in PARA_FOLDERS {
        let folder_path = vault.join(folder_name);

        if !folder_path.exists() {
            match std::fs::create_dir_all(&folder_path) {
                Ok(_) => {
                    log::debug!("✅ [PARA] Initialized {}", folder_name);
                    created_folders.push(folder_name.to_string());
                }
                Err(e) => {
                    return Err(format!("Failed to create {}: {}", folder_name, e));
                }
            }
        } else {
            // log::debug!("📁 [PARA] {} already exists", folder_name);
        }
    }

    if created_folders.is_empty() {
        // log::debug!("✅ [PARA] All PARA folders already exist");
    } else {
        log::debug!("✅ [PARA] Created {} folder(s)", created_folders.len());
    }

    Ok(created_folders)
}

// --- Database & Watcher ---

#[tauri::command]
pub fn init_db(vault_path: String, db_state: State<DbStateWrapper>) -> Result<String, String> {
    let path = Path::new(&vault_path);
    db_state.0.init(path).map_err(|e| e.to_string())?;
    log::info!("🔌 [DB] Initialized database connection for vault: {}", path.display());

    // Phase 6: 崩溃恢复 — 将 transfer_queue 中残留的 active 任务重置为 pending
    if let Ok(conn_guard) = db_state.0.connection.lock() {
        if let Some(conn) = conn_guard.as_ref() {
            match crate::core::transfer_manager::TransferManager::recover_active_tasks(conn) {
                Ok(n) => { if n > 0 { log::info!("[init_db] Phase 6: recovered {} stale transfer tasks", n); } }
                Err(e) => log::error!("[init_db] Phase 6: transfer recovery failed: {}", e),
            }
        }
    }

    Ok(format!(
        "Database initialized at {}",
        crate::core::db::DbState::db_path(path).display()
    ))
}

#[tauri::command]
pub fn start_watcher(
    vault_path: String,
    _db_state: State<DbStateWrapper>,
    watcher_state: State<WatcherState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let path = PathBuf::from(&vault_path);

    // Create Arc for DbState (watcher needs its own connection for thread safety)
    let db_state_arc = Arc::new(crate::core::db::DbState::default());

    // Initialize the Arc'd DbState with the vault
    db_state_arc.init(&path).map_err(|e| e.to_string())?;

    // Start the file watcher
    let watcher = crate::core::watcher::FileWatcher::start(path.clone(), db_state_arc, app_handle)
        .map_err(|e| e.to_string())?;

    // Store the watcher
    let mut guard = watcher_state.0.lock().unwrap();
    *guard = Some(watcher);

    Ok(format!("Watcher started for {}", vault_path))
}

#[tauri::command]
pub fn close_db(
    db_state: State<DbStateWrapper>,
    watcher_state: State<WatcherState>,
) -> Result<(), String> {
    // Explicitly release and drop the file watcher instance to avoid locking DB and thread leakage
    let mut guard = watcher_state.0.lock().unwrap();
    if let Some(_watcher) = guard.take() {
        log::debug!("🛑 [FS] Stopped file watcher during database close");
    }

    db_state.0.close();
    log::info!("🔌 [DB] Closed database connection successfully");
    Ok(())
}

#[tauri::command]
pub fn scan_vault(vault_path: String, db_state: State<DbStateWrapper>) -> Result<usize, String> {
    let vault = Path::new(&vault_path);

    // Collect all .md files currently on disk
    let mut scanned = 0;
    let mut existing_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    db_state.0.with_connection(|conn| {
        // Phase 1: Scan and upsert all existing files
        for entry in WalkDir::new(&vault)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
        {
            if let Ok(relative) = entry.path().strip_prefix(&vault) {
                let relative_str = relative.to_string_lossy().to_string();
                let normalized = crate::core::db::repository::normalize_path(&relative_str);

                // Skip hidden folders
                if normalized.starts_with('.') || normalized.contains("/.") {
                    continue;
                }

                // Track this path as existing
                existing_paths.insert(normalized.clone());

                match crate::core::db::repository::scan_and_upsert(conn, vault, &relative_str) {
                    Ok(_) => scanned += 1,
                    Err(e) => log::error!("⚠️ [scan_vault] Failed to scan {}: {}", relative_str, e),
                }
            }
        }

        // Phase 2: Delete notes that no longer exist on disk
        let db_notes = crate::core::db::repository::get_all_notes(conn)?;
        for note in db_notes {
            if !existing_paths.contains(&note.path) {
                log::info!("🗑️ [scan_vault] Removing deleted note: {}", note.path);
                if let Err(e) = crate::core::db::repository::delete_note(conn, &note.path) {
                    log::error!("⚠️ [scan_vault] Failed to delete {}: {}", note.path, e);
                }
            }
        }

        Ok(scanned)
    })
}

#[tauri::command]
pub fn scan_single_file(
    vault_path: String,
    relative_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<String, String> {
    let vault = Path::new(&vault_path);
    let file_path = vault.join(&relative_path);

    db_state
        .0
        .with_connection(|conn| {
            // Scan note metadata and links
            let result = crate::core::db::repository::scan_and_upsert(conn, vault, &relative_path)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;

            // Also scan for tasks if file exists and is markdown
            if file_path.exists() && relative_path.ends_with(".md") {
                if let Ok(content) = std::fs::read_to_string(&file_path) {
                    let tasks = crate::core::db::task_scanner::scan_tasks(&content, &relative_path);

                    // Delete old tasks and insert new ones
                    let _ =
                        crate::core::db::repository::delete_tasks_for_note(conn, &relative_path);
                    if !tasks.is_empty() {
                        let _ = crate::core::db::repository::insert_tasks(conn, &tasks);
                        log::debug!("📋 [Task] Scanned {} tasks in: {}",
                            tasks.len(),
                            relative_path
                        );
                    }
                }
            }

            serde_json::to_string(&result).map_err(|_e| rusqlite::Error::InvalidQuery)
        })
        .map_err(|e| e.to_string())
}

use crate::core::db::{Link, Note};

#[tauri::command]
pub fn get_notes(db_state: State<DbStateWrapper>) -> Result<Vec<Note>, String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_all_notes(conn))
}

#[tauri::command]
pub fn get_links(db_state: State<DbStateWrapper>) -> Result<Vec<Link>, String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_all_links(conn))
}

#[tauri::command]
pub fn get_dirty_notes(db_state: State<DbStateWrapper>) -> Result<Vec<Note>, String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_dirty_notes(conn))
}

#[tauri::command]
pub fn check_note_exists(
    note_name: String,
    exclude_path: Option<String>,
    db_state: State<DbStateWrapper>,
) -> Result<bool, String> {
    db_state.0.with_connection(|conn| {
        let exclude_relative = exclude_path.as_ref().map(|path| {
            let vault_path = db_state.0.vault_path.lock().unwrap().clone();
            if let Some(vault_path) = vault_path {
                Path::new(path)
                    .strip_prefix(&vault_path)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| path.replace('\\', "/"))
            } else {
                path.replace('\\', "/")
            }
        });

        crate::core::db::repository::check_note_exists_by_name(
            conn,
            &note_name,
            exclude_relative.as_deref(),
        )
    })
}

#[tauri::command]
pub fn get_note_preview(
    vault_path: String,
    note_name: String,
    db_state: State<DbStateWrapper>,
) -> Result<crate::core::db::repository::NotePreview, String> {
    let vault = Path::new(&vault_path);
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::get_note_preview_by_name(conn, vault, &note_name)
    })
}

/// Rename a note in the database, migrating all related data (AI data, links, embeddings, etc.)
/// This should be called AFTER the filesystem rename but BEFORE the watcher processes the event.
#[tauri::command]
pub fn rename_note_in_db(
    old_relative_path: String,
    new_relative_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::rename_note_in_db(conn, &old_relative_path, &new_relative_path)
    })
}

/// Rebuild database from files: clear all AI-derived data and rescan vault.
/// Preserves user-adopted data (user_tags, user_summary) but clears AI-generated state.
/// Use this when AI data becomes inconsistent or after major model changes.
#[tauri::command]
pub fn rebuild_from_files(
    vault_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<usize, String> {
    let vault = Path::new(&vault_path);

    if !vault.exists() {
        return Err(format!("Vault path does not exist: {}", vault_path));
    }

    db_state.0.with_connection(|conn| {
        // Phase 0: Clear AI-derived state (keep user-adopted data: user_tags, user_summary)
        log::info!("🔄 [rebuild] Phase 0: Clearing AI-derived data...");
        conn.execute_batch(
            r#"
            DELETE FROM ai_skill_state;
            DELETE FROM classification_cache;
            DELETE FROM ai_suggestion_cache;
            DELETE FROM ai_metadata;
            UPDATE embeddings_v2 SET status = 'pending', retry_count = 0
                WHERE status = 'done';
            "#,
        )
        .map_err(|e| rusqlite::Error::from(e))?;
        log::info!("🔄 [rebuild] AI derived data cleared");

        // Phase 1 & 2: Full scan (same logic as scan_vault)
        let mut scanned = 0;
        let mut existing_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for entry in WalkDir::new(&vault)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
        {
            if let Ok(relative) = entry.path().strip_prefix(&vault) {
                let relative_str = relative.to_string_lossy().to_string();
                let normalized = crate::core::db::repository::normalize_path(&relative_str);

                // Skip hidden folders
                if normalized.starts_with('.') || normalized.contains("/.") {
                    continue;
                }

                existing_paths.insert(normalized.clone());

                match crate::core::db::repository::scan_and_upsert(conn, vault, &relative_str) {
                    Ok(_) => scanned += 1,
                    Err(e) => log::error!("⚠️ [rebuild] Failed to scan {}: {}", relative_str, e),
                }
            }
        }

        // Phase 3: Delete notes that no longer exist on disk
        let db_notes = crate::core::db::repository::get_all_notes(conn)?;
        for note in db_notes {
            if !existing_paths.contains(&note.path) {
                log::error!("🗑️ [rebuild] Removing deleted note: {}", note.path);
                if let Err(e) = crate::core::db::repository::delete_note(conn, &note.path) {
                    log::error!("⚠️ [rebuild] Failed to delete {}: {}", note.path, e);
                }
            }
        }

        log::info!("✅ [rebuild] Complete: {} files scanned", scanned);
        Ok(scanned)
    })
}
