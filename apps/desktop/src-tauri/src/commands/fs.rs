use crate::core::db::repository;
use crate::state::{DbStateWrapper, RefactoringState};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;


// ============================================================================
// Protected Constitution Directories
// ============================================================================

/// Directories that cannot be deleted or renamed at the root level
const PROTECTED_ROOT_DIRS: &[&str] = &[
    "00_Inbox",
    "01_Projects",
    "02_Areas",
    "03_Resources",
    "04_Archives",
    "assets",
    ".slash",
];

fn normalize_path_to_string(path: &Path) -> String {
    let mut s = path.to_string_lossy().to_string();
    if s.starts_with(r#"\\?\"#) {
        s = s[4..].to_string();
    }
    let mut s = s.replace('\\', "/");
    if s.starts_with("//?/") {
        s = s[4..].to_string();
    }
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    s
}

/// Helper to validate if a path is located inside the vault to prevent Path Traversal
fn validate_path_in_vault(path: &Path, vault: &Path) -> Result<(), String> {
    let abs_vault = vault.canonicalize().map_err(|e| format!("Invalid vault path: {}", e))?;
    let abs_vault_norm = normalize_path_to_string(&abs_vault);

    if path.exists() {
        let abs_path = path.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
        if !normalize_path_to_string(&abs_path).starts_with(&abs_vault_norm) {
            return Err("Access denied: path is outside vault".to_string());
        }
        return Ok(());
    }

    let mut ancestor = path;
    while let Some(parent) = ancestor.parent() {
        if parent.exists() {
            let abs_parent = parent.canonicalize().map_err(|e| format!("Invalid parent path: {}", e))?;
            if !normalize_path_to_string(&abs_parent).starts_with(&abs_vault_norm) {
                return Err("Access denied: path traversal detected via parent".to_string());
            }
            return Ok(());
        }
        ancestor = parent;
    }

    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        abs_vault.join(path)
    };

    let mut components = Vec::new();
    for comp in abs_path.components() {
        match comp {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::Normal(_) |
            std::path::Component::RootDir |
            std::path::Component::Prefix(_) => {
                components.push(comp);
            }
            std::path::Component::CurDir => {}
        }
    }
    let cleaned_path: PathBuf = components.into_iter().collect();
    if !normalize_path_to_string(&cleaned_path).starts_with(&abs_vault_norm) {
        return Err("Access denied: path traversal detected".to_string());
    }

    Ok(())
}


/// Check if a path is a protected root directory
fn is_protected_root_dir(path: &Path) -> bool {
    // Get the file/folder name
    let file_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name,
        None => return false,
    };

    // Check if it's in the protected list
    if !PROTECTED_ROOT_DIRS.contains(&file_name) {
        return false;
    }

    // Check if it's at root level (parent is the vault, not a subdirectory)
    // We consider it root-level if the parent's parent doesn't contain any PARA folders
    // Simpler check: if path has exactly 2 components after vault (vault/00_Inbox), it's root
    let parent = match path.parent() {
        Some(p) => p,
        None => return false,
    };

    // If the parent contains a .slash folder, it's likely the vault root
    parent.join(".slash").exists() || parent.join("00_Inbox").exists()
}

#[tauri::command]
pub fn move_to_trash(
    path: String,
    vault_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    let path_obj = Path::new(&path);

    // Guard: Check if this is a protected constitution directory
    if is_protected_root_dir(path_obj) {
        return Err(
            "🚫 System directory cannot be deleted. This is a protected PARA folder.".to_string(),
        );
    }

    // Compute relative path for database cleanup
    let vault = Path::new(&vault_path);

    // Validate path to prevent path traversal
    validate_path_in_vault(path_obj, vault)?;

    let relative_path = path_obj
        .strip_prefix(vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.clone());

    // Clean up database records BEFORE deleting file
    log::debug!("🗑️ [FS] Cleaning up database for: {}", relative_path);
    let _ = db_state
        .0
        .with_connection(|conn| repository::delete_note(conn, &relative_path));

    // 🔎 [DIAG] 资产引用计数诊断（仅 .md 文件）
    if path_obj.extension().map(|e| e == "md").unwrap_or(false) {
        if let Ok(content) = fs::read_to_string(path_obj) {
            let deleted_refs = crate::commands::assets::extract_asset_refs_public(&content);
            let asset_refs: Vec<&String> = deleted_refs.iter()
                .filter(|r| r.starts_with("assets/"))
                .collect();

            if !asset_refs.is_empty() {
                log::debug!(
                    "🔎 [AssetRefCount] Deleted note '{}' references {} asset(s): {:?}",
                    relative_path, asset_refs.len(), asset_refs
                );

                // 扫描所有其他 .md 文件，计算每个资产的剩余引用数
                let mut global_refs: std::collections::HashMap<String, Vec<String>> =
                    std::collections::HashMap::new();

                for entry in walkdir::WalkDir::new(vault)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    let ep = entry.path();
                    if ep == path_obj { continue; } // 跳过被删除的文件本身
                    if ep.is_file() && ep.extension().map(|e| e == "md").unwrap_or(false) {
                        if let Ok(other_content) = fs::read_to_string(ep) {
                            let other_refs = crate::commands::assets::extract_asset_refs_public(&other_content);
                            let other_relative = ep.strip_prefix(vault)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_default();
                            for r in other_refs {
                                if asset_refs.contains(&&r) {
                                    global_refs.entry(r).or_default().push(other_relative.clone());
                                }
                            }
                        }
                    }
                }

                for asset in &asset_refs {
                    let remaining = global_refs.get(*asset);
                    match remaining {
                        Some(notes) => {
                            log::debug!(
                                "🔎 [AssetRefCount] '{}' still referenced by {} note(s): {:?} → KEEP",
                                asset, notes.len(), notes
                            );
                        }
                        None => {
                            log::debug!(
                                "🔎 [AssetRefCount] '{}' has 0 remaining references → ORPHAN (should be cleaned)",
                                asset
                            );
                        }
                    }
                }
            }
        }
    }

    // Delete file to system trash
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Purge all stale AI data for a given note path.
/// Called when creating a new note to ensure no leftover data from a previously
/// deleted/renamed note with the same filename pollutes the new note.
#[tauri::command]
pub fn purge_stale_note_data(
    note_path: String,
    vault_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<usize, String> {
    let vault = Path::new(&vault_path);

    // Validate note path to prevent path traversal
    validate_path_in_vault(Path::new(&note_path), vault)?;

    let relative_path = Path::new(&note_path)
        .strip_prefix(vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| note_path.clone());

    log::debug!("🧹 [FS] Purging stale data for new note: {}", relative_path);

    db_state.0.with_connection(|conn| {
        let mut total = 0usize;

        // Clean embeddings_v2
        total += conn
            .execute(
                "DELETE FROM embeddings_v2 WHERE note_path = ?1",
                rusqlite::params![&relative_path],
            )
            .unwrap_or(0);

        // Clean AI skill state
        total += conn
            .execute(
                "DELETE FROM ai_skill_state WHERE note_path = ?1",
                rusqlite::params![&relative_path],
            )
            .unwrap_or(0);

        // Clean AI suggestion cache (as source)
        total += conn
            .execute(
                "DELETE FROM ai_suggestion_cache WHERE source_path = ?1",
                rusqlite::params![&relative_path],
            )
            .unwrap_or(0);

        // Clean classification cache
        total += conn
            .execute(
                "DELETE FROM classification_cache WHERE note_path = ?1",
                rusqlite::params![&relative_path],
            )
            .unwrap_or(0);

        if total > 0 {
            log::debug!(
                "🧹 [FS] Purged {} stale records for: {}",
                total, relative_path
            );
        }

        Ok(total)
    })
}

/// Move a file to a different folder
#[tauri::command]
pub fn move_file(
    source_path: String,
    dest_folder: String,
    vault_path: String,
    db_state: State<DbStateWrapper>,
    refactoring_state: State<'_, RefactoringState>,
) -> Result<String, String> {
    let source = Path::new(&source_path);
    let dest_dir = Path::new(&dest_folder);
    let vault = Path::new(&vault_path);

    // Validate source and destination paths to prevent path traversal
    validate_path_in_vault(source, vault)?;
    validate_path_in_vault(dest_dir, vault)?;

    // Validate source exists
    if !source.exists() {
        return Err(format!("Source does not exist: {}", source_path));
    }

    // Validate destination is a folder
    if !dest_dir.is_dir() {
        return Err(format!("Destination is not a folder: {}", dest_folder));
    }

    // Get the name (file or folder)
    let name = source
        .file_name()
        .ok_or("Could not extract name")?
        .to_str()
        .ok_or("Invalid name encoding")?;

    // Build destination path
    let dest_path = dest_dir.join(name);

    // RAII Guard to ignore watcher events during this rename/move operation
    struct RefactorGuard<'a> {
        state: &'a RefactoringState,
        paths: Vec<PathBuf>,
    }

    impl<'a> Drop for RefactorGuard<'a> {
        fn drop(&mut self) {
            if let Ok(mut set) = self.state.0.lock() {
                for p in &self.paths {
                    set.remove(p);
                    log::debug!("🔓 [FS] RefactorGuard removed path from ignore list: {:?}", p);
                }
            }
        }
    }

    let _guard = RefactorGuard {
        state: &*refactoring_state,
        paths: vec![source.to_path_buf(), dest_path.clone()],
    };

    // Add paths to ignored set
    if let Ok(mut set) = refactoring_state.0.lock() {
        set.insert(source.to_path_buf());
        set.insert(dest_path.clone());
        log::debug!(
            "🔒 [FS] RefactorGuard added paths to ignore list: {:?}, {:?}",
            source, dest_path
        );
    }

    // Check if already exists at destination
    if dest_path.exists() {
        return Err(format!(
            "'{}' already exists in the destination folder",
            name
        ));
    }

    // Check not moving to same location
    if source.parent() == Some(dest_dir) {
        return Err("Item is already in this folder".to_string());
    }

    // Check not moving folder into itself or its children
    if source.is_dir() {
        let source_canonical = source.canonicalize().map_err(|e| e.to_string())?;
        let dest_canonical = dest_dir.canonicalize().map_err(|e| e.to_string())?;
        if dest_canonical.starts_with(&source_canonical) {
            return Err("Cannot move a folder into itself or its subfolder".to_string());
        }
    }

    // For directories, update database entries for all sub-notes BEFORE moving to prevent Watcher deletion/UUID reset
    if source.is_dir() {
        let old_relative = source
            .strip_prefix(vault)
            .map(|p| repository::normalize_path(&p.to_string_lossy()))
            .unwrap_or_else(|_| source_path.clone());

        let new_relative = dest_path
            .strip_prefix(vault)
            .map(|p| repository::normalize_path(&p.to_string_lossy()))
            .unwrap_or_else(|_| dest_path.to_string_lossy().to_string());

        log::debug!("📂 [FS] Moving folder: {} -> {}", old_relative, new_relative);

        let prefix_pattern = format!("{}/%", old_relative);
        let rename_result = db_state.0.with_connection(|conn| {
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

            for old_note_path in paths {
                let suffix = &old_note_path[old_relative.len()..];
                let new_note_path = format!("{}{}", new_relative, suffix);
                log::debug!("🔄 [FS] Renaming sub-note in DB: {} -> {}", old_note_path, new_note_path);
                if let Err(e) = repository::rename_note_in_db(conn, &old_note_path, &new_note_path) {
                    log::warn!("⚠️ [FS] Failed to rename sub-note {} during folder move: {}", old_note_path, e);
                }
            }
            Ok::<(), rusqlite::Error>(())
        });

        if let Err(e) = rename_result {
            log::warn!("⚠️ [FS] Failed to update DB for folder move: {}", e);
        }
    }

    // For markdown files, update database BEFORE moving to preserve associated data (tasks, links, etc)
    if source.extension().map(|e| e == "md").unwrap_or(false) {
        let old_relative = source
            .strip_prefix(vault)
            .map(|p| repository::normalize_path(&p.to_string_lossy()))
            .unwrap_or_else(|_| source_path.clone());

        let new_relative = dest_path
            .strip_prefix(vault)
            .map(|p| repository::normalize_path(&p.to_string_lossy()))
            .unwrap_or_else(|_| dest_path.to_string_lossy().to_string());

        log::debug!("📦 [FS] Moving note: {} -> {}", old_relative, new_relative);

        // Call rename_note_in_db to migrate all associated data (tasks, links, embeddings, etc)
        if let Err(e) = db_state.0.with_connection(|conn| {
            repository::rename_note_in_db(conn, &old_relative, &new_relative)
        }) {
            log::warn!("⚠️ [FS] Failed to update DB during move: {}", e);
            // Continue with file move anyway
        }
    }

    // Perform the move (works for both files and folders)
    fs::rename(&source, &dest_path).map_err(|e| format!("Failed to move: {}", e))?;

    // Return the new path
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn show_in_folder(path: String) {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .unwrap();

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(
            std::path::Path::new(&path)
                .parent()
                .unwrap_or(std::path::Path::new("/")),
        )
        .spawn()
        .unwrap();

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.replace("/", "\\")))
        .spawn()
        .unwrap();
}
