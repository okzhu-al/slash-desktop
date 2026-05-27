//! File System Watcher Module
//!
//! Monitors the vault directory for external file changes and keeps
//! the SQLite database synchronized. Uses notify crate with debouncing.

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, Debouncer};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::core::db::DbState;

/// File watcher that monitors vault for external changes
pub struct FileWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl FileWatcher {
    /// Start watching a vault directory
    pub fn start(
        vault_path: PathBuf,
        db_state: Arc<DbState>,
        app_handle: AppHandle,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = channel();

        // Canonicalize the path to get the real filesystem case (important for macOS)
        let canonical_path = vault_path.canonicalize().unwrap_or(vault_path);

        // Create debouncer with 200ms delay to coalesce rapid events
        let mut debouncer = new_debouncer(Duration::from_millis(200), tx)?;

        // Watch the vault directory recursively
        debouncer
            .watcher()
            .watch(&canonical_path, RecursiveMode::Recursive)?;

        log::debug!(
            "📂 [Watcher] Started watching: {}",
            canonical_path.display()
        );

        // Spawn event handler thread
        let vault_path_clone = canonical_path.clone();
        thread::spawn(move || {
            handle_events(rx, vault_path_clone, db_state, app_handle);
        });

        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

/// Handle debounced file system events
fn handle_events(
    rx: Receiver<Result<Vec<DebouncedEvent>, notify::Error>>,
    vault_path: PathBuf,
    db_state: Arc<DbState>,
    app_handle: AppHandle,
) {
    use tauri::Manager;
    for result in rx {
        match result {
            Ok(events) => {
                // ── 如果正在同步，则静默忽略物理事件，防止竞态删除 AI 缓存与关系链 ──
                if let Some(syncing_state) = app_handle.try_state::<crate::state::SyncingState>() {
                    if syncing_state.0.load(std::sync::atomic::Ordering::Relaxed) {
                        log::debug!("⏳ [Watcher] Syncing is active, ignoring {} filesystem events", events.len());
                        continue;
                    }
                }

                // ── 过滤掉处于重构状态的路径 ──
                let refactoring_paths = app_handle.try_state::<crate::state::RefactoringState>()
                    .map(|state| {
                        state.0.lock().map(|set| set.clone()).unwrap_or_default()
                    })
                    .unwrap_or_default();

                let mut filtered_events = Vec::new();
                for event in events {
                    let path = &event.path;
                    let is_ignored = refactoring_paths.iter().any(|ignored| {
                        path.starts_with(ignored) || ignored.starts_with(path)
                    });
                    if is_ignored {
                        log::debug!("⏳ [Watcher] Path is undergoing refactoring, ignoring event: {:?}", path);
                    } else {
                        filtered_events.push(event);
                    }
                }

                if filtered_events.is_empty() {
                    continue;
                }

                // ── 第一阶段：检测外部重命名并优先在数据库中进行 UUID 碰缘合并平移 ──
                let merge_result = db_state.with_connection(|conn| {
                    for event in &filtered_events {
                        let path = &event.path;
                        if path.exists() && is_markdown_file(path) {
                            if let Ok(rel) = path.strip_prefix(&vault_path) {
                                let new_relative = crate::core::db::repository::normalize_path(&rel.to_string_lossy());
                                if let Ok(content) = std::fs::read_to_string(path) {
                                    let fm = crate::core::db::repository::scanner::parse_frontmatter(&content);
                                    if let Some(ref uuid) = fm.slash_id {
                                        // 查询是否在 notes 中已存在相同 UUID 的旧路径
                                        let old_path_opt: Option<String> = conn
                                            .query_row(
                                                "SELECT path FROM notes WHERE slash_id = ?1",
                                                [uuid],
                                                |row| row.get(0),
                                            )
                                            .ok();

                                        if let Some(old_path) = old_path_opt {
                                            if old_path != new_relative {
                                                // 确认物理上旧路径对应的文件已不复存在
                                                let old_physical = vault_path.join(&old_path);
                                                if !old_physical.exists() {
                                                    log::info!(
                                                        "🔄 [Watcher] UUID Match! External rename/move detected: {} -> {} (UUID: {})",
                                                        old_path, new_relative, uuid
                                                    );
                                                    if let Err(e) = crate::core::db::repository::rename_note_in_db(conn, &old_path, &new_relative) {
                                                        log::error!("⚠️ [Watcher] Failed to rename note in DB for UUID merge: {}", e);
                                                    } else {
                                                        // 广播重命名事件给前端（Bug 2 修复）
                                                        let new_physical = path.to_string_lossy().to_string();
                                                        let old_physical_str = old_physical.to_string_lossy().to_string();
                                                        let new_title = path
                                                            .file_stem()
                                                            .and_then(|s| s.to_str())
                                                            .unwrap_or("")
                                                            .to_string();

                                                        #[derive(Clone, serde::Serialize)]
                                                        struct RenamePayload {
                                                            #[serde(rename = "oldId")]
                                                            old_id: String,
                                                            #[serde(rename = "newId")]
                                                            new_id: String,
                                                            #[serde(rename = "newTitle")]
                                                            new_title: String,
                                                            #[serde(rename = "newPath")]
                                                            new_path: String,
                                                        }

                                                        let payload = RenamePayload {
                                                            old_id: old_physical_str,
                                                            new_id: new_physical.clone(),
                                                            new_title,
                                                            new_path: new_physical,
                                                        };

                                                        if let Err(e) = app_handle.emit("note-renamed", payload) {
                                                            log::warn!("⚠️ [Watcher] Failed to emit note-renamed: {}", e);
                                                        } else {
                                                            log::debug!("📡 [Watcher] Emitted note-renamed for external rename");
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok::<(), rusqlite::Error>(())
                });

                if let Err(e) = merge_result {
                    log::error!("⚠️ [Watcher] Error in UUID merge phase: {}", e);
                }

                let mut needs_refresh = false;

                for event in filtered_events {
                    let path = &event.path;

                    // Filter: only process .md files for DB operations
                    // But directory events (rename/create/delete) still trigger vault:refresh
                    if !is_markdown_file(path) {
                        // 目录变更（重命名/新建/删除）→ 触发 vault:refresh → sync
                        if path.is_dir() || (!path.exists() && path.extension().is_none()) {
                            if !is_in_slash_dir(path, &vault_path) {
                                needs_refresh = true;

                                // 目录移动/重命名后，递归扫描目录内所有 .md 文件并更新数据库路径
                                // 这是必需的，因为 notify 对目录 rename 只生成一个目录级事件，
                                // 不会为内部的每个 .md 文件单独生成事件
                                if path.is_dir() {
                                    log::debug!("📂 [Watcher] Directory changed, scanning .md files inside: {}", path.display());
                                    if let Ok(entries) = walkdir_md_files(path) {
                                        for md_path in entries {
                                            if let Ok(rel) = md_path.strip_prefix(&vault_path) {
                                                let relative_path = rel.to_string_lossy().to_string();
                                                let normalized = crate::core::db::repository::normalize_path(&relative_path);
                                                let scan_result = db_state.with_connection(|conn| {
                                                    match crate::core::db::repository::scan_and_upsert(conn, &vault_path, &normalized) {
                                                        Ok(_) => Ok(()),
                                                        Err(e) => Err(rusqlite::Error::ToSqlConversionFailure(e.into())),
                                                    }
                                                });
                                                if let Err(e) = scan_result {
                                                    log::warn!("⚠️ [Watcher] Failed to upsert moved file {}: {}", relative_path, e);
                                                }
                                            }
                                        }
                                    }
                                } else if !path.exists() {
                                    // 目录已被删除或移走 → 级联清理数据库中以该目录路径为前缀的所有 note 及其关联 AI 数据
                                    if let Ok(rel) = path.strip_prefix(&vault_path) {
                                        let dir_prefix = crate::core::db::repository::normalize_path(
                                            &rel.to_string_lossy()
                                        );
                                        let prefix_pattern = format!("{}/%", dir_prefix);
                                        log::debug!("🗑️ [Watcher] Directory removed, cascade cleaning DB notes with prefix: {}", dir_prefix);
                                        if let Err(e) = db_state.with_connection(|conn| {
                                            let mut stmt = conn.prepare("SELECT path FROM notes WHERE path LIKE ?1")?;
                                            let note_paths = stmt.query_map(rusqlite::params![prefix_pattern], |row| {
                                                row.get::<_, String>(0)
                                            })?;

                                            let mut paths = Vec::new();
                                            for path_res in note_paths {
                                                if let Ok(p) = path_res {
                                                    paths.push(p);
                                                }
                                            }

                                            for p in paths {
                                                if let Err(err) = crate::core::db::repository::delete_note(conn, &p) {
                                                    log::warn!("⚠️ [Watcher] Failed to cascade delete note {}: {}", p, err);
                                                }
                                            }
                                            Ok(())
                                        }) {
                                            log::warn!("⚠️ [Watcher] Failed to clean notes for deleted dir {}: {}", dir_prefix, e);
                                        }
                                    }
                                }
                            }
                        }
                        continue;
                    }

                    // Filter: ignore .slash directory
                    if is_in_slash_dir(path, &vault_path) {
                        continue;
                    }

                    // Get relative path for database operations
                    let relative_path = match path.strip_prefix(&vault_path) {
                        Ok(p) => p.to_string_lossy().to_string(),
                        Err(_) => continue,
                    };

                    // Check if file exists to determine event type
                    let file_exists = path.exists();

                    log::debug!(
                        "📝 [Watcher] Detected change: {} (exists: {})",
                        relative_path, file_exists
                    );

                    // Determine if this is a structural change (create/delete/rename)
                    // vs a content modification
                    let is_structural_change = db_state
                        .with_connection(|conn| {
                            use crate::core::db::repository;

                            if !file_exists {
                                // File deleted - structural change
                                let normalized = repository::normalize_path(&relative_path);

                                // Invalidate AI suggestion cache for deleted note
                                if let Ok(count) =
                                    repository::invalidate_suggestion_cache(conn, &normalized)
                                {
                                    if count > 0 {
                                        log::debug!(
                                            "🧹 [Watcher] Invalidated {} cache entries for: {}",
                                            count, normalized
                                        );
                                    }
                                }

                                repository::delete_note(conn, &normalized).ok();
                                log::debug!("🗑️ [Watcher] File deleted: {}", relative_path);
                                return Ok(true);
                            }

                            // File exists - check if it's new or renamed (including case change)
                            let normalized = repository::normalize_path(&relative_path);

                            // Check if note with EXACT path (case-sensitive) exists
                            let existing: Option<String> = conn
                                .query_row(
                                    "SELECT path FROM notes WHERE path = ?1 COLLATE BINARY",
                                    [&normalized],
                                    |row| row.get(0),
                                )
                                .ok();

                            let is_new_or_renamed = existing.is_none();

                            // Perform upsert
                            if let Err(e) =
                                repository::scan_and_upsert(conn, &vault_path, &relative_path)
                            {
                                log::warn!("⚠️ [Watcher] scan_and_upsert failed: {}", e);
                            }

                            // Invalidate AI suggestion cache when file content changes
                            // This ensures stale reasoning results are refreshed
                            if let Ok(count) =
                                repository::invalidate_suggestion_cache(conn, &normalized)
                            {
                                if count > 0 {
                                    log::debug!(
                                        "🧹 [Watcher] Invalidated {} cache entries for: {}",
                                        count, normalized
                                    );
                                }
                            }

                            if is_new_or_renamed {
                                // Clean up any stale AI skill states from a previous note
                                // with the same path (e.g., delete + recreate within debounce window)
                                if let Ok(deleted) = repository::delete_skill_states_for_note(conn, &normalized) {
                                    if deleted > 0 {
                                        log::debug!(
                                            "🧹 [Watcher] Cleaned {} stale skill states for new note: {}",
                                            deleted, normalized
                                        );
                                    }
                                }
                                log::debug!(
                                    "✨ [Watcher] New/renamed file detected: {}",
                                    relative_path
                                );
                            }

                            // Emit content update event for valid modifications
                            if !is_new_or_renamed {
                                if let Err(e) =
                                    app_handle.emit("note:updated", relative_path.clone())
                                {
                                    log::warn!("⚠️ [Watcher] Failed to emit note:updated: {}", e);
                                } else {
                                    log::debug!(
                                        "📡 [Watcher] Emitted note:updated for {}",
                                        relative_path
                                    );
                                }
                            }

                            Ok(is_new_or_renamed)
                        })
                        .unwrap_or(false);

                    if is_structural_change {
                        needs_refresh = true;
                    }
                }

                // Emit refresh event if any structural changes were processed
                if needs_refresh {
                    if let Err(e) = app_handle.emit("vault:refresh", ()) {
                        log::warn!("⚠️ [Watcher] Failed to emit refresh: {}", e);
                    } else {
                        log::debug!("🔄 [Watcher] Emitted vault:refresh");
                    }
                }
            }
            Err(e) => {
                log::warn!("⚠️ [Watcher] Error receiving events: {:?}", e);
            }
        }
    }

    log::debug!("📂 [Watcher] Event handler stopped");
}

/// Check if path is a markdown file
fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_lowercase() == "md")
        .unwrap_or(false)
}

/// Check if path is inside .slash directory
fn is_in_slash_dir(path: &Path, vault_path: &Path) -> bool {
    if let Ok(relative) = path.strip_prefix(vault_path) {
        let path_str = relative.to_string_lossy();
        path_str.starts_with(".slash") || path_str.contains("/.slash")
    } else {
        false
    }
}

/// Recursively collect all .md files inside a directory
fn walkdir_md_files(dir: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut results = Vec::new();
    if !dir.is_dir() {
        return Ok(results);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            // Skip .slash directories
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == ".slash" || name.starts_with('.') {
                continue;
            }
            if let Ok(sub) = walkdir_md_files(&path) {
                results.extend(sub);
            }
        } else if is_markdown_file(&path) {
            results.push(path);
        }
    }
    Ok(results)
}
