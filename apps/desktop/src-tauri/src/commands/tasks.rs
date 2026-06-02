//! Tauri commands for task operations

use crate::core::db::models::Task;
use crate::core::db::repository::{
    delete_tasks_for_note, get_all_tasks, get_tasks_by_filter, get_tasks_for_note, insert_tasks,
    TaskFilter,
};
use crate::core::db::task_scanner::scan_tasks;
use crate::state::DbStateWrapper;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn is_windows_absolute_path(path: &str) -> bool {
    let normalized = normalize_slashes(path);
    let bytes = normalized.as_bytes();
    bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' && bytes[0].is_ascii_alphabetic()
}

fn normalize_relative_path(vault_path: &Path, file_path: &Path, original_path: &str) -> String {
    if let Ok(relative) = file_path.strip_prefix(vault_path) {
        return normalize_slashes(&relative.to_string_lossy());
    }

    let normalized_file = normalize_slashes(&file_path.to_string_lossy());
    let normalized_vault = normalize_slashes(&vault_path.to_string_lossy())
        .trim_end_matches('/')
        .to_string();

    if let Some(relative) = normalized_file.strip_prefix(&(normalized_vault + "/")) {
        return relative.to_string();
    }

    normalize_slashes(original_path)
        .trim_start_matches('/')
        .to_string()
}

/// Scan a single note for tasks and store them in DB
/// Supports both absolute paths and relative paths
#[tauri::command]
pub fn scan_note_tasks(db: State<DbStateWrapper>, note_path: String) -> Result<Vec<Task>, String> {
    let vault_path =
        db.0.vault_path
            .lock()
            .unwrap()
            .clone()
            .ok_or("No vault open")?;

    // Determine if path is absolute or relative. Windows paths can arrive as
    // C:\foo or C:/foo from the webview, so don't rely only on Path::is_absolute.
    let note_path_normalized = normalize_slashes(&note_path);
    let is_absolute = Path::new(&note_path).is_absolute()
        || note_path.starts_with("\\\\")
        || note_path_normalized.starts_with("//")
        || is_windows_absolute_path(&note_path);
    let file_path = if is_absolute {
        PathBuf::from(&note_path)
    } else {
        vault_path.join(&note_path_normalized)
    };

    // Calculate relative path for storage (used as key in DB)
    let relative_path = if is_absolute {
        normalize_relative_path(&vault_path, &file_path, &note_path)
    } else {
        note_path_normalized.trim_start_matches('/').to_string()
    };

    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Scan for tasks using relative path for storage
    let tasks = scan_tasks(&content, &relative_path);

    // Insert tasks and then query back to get IDs
    let result =
        db.0.with_connection(|conn| {
            // 确保 notes 表有该文件记录（同步来的文件可能从未打开过）
            // INSERT OR IGNORE: 已存在则跳过
            // notes 表有 NOT NULL 约束: path, title, extension, mtime, size
            let p = std::path::Path::new(&relative_path);
            let extension = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            let title = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let (mtime, size) = {
                let full = vault_path.join(&relative_path);
                match std::fs::metadata(&full) {
                    Ok(meta) => {
                        let mt = meta.modified().ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        (mt, meta.len() as i64)
                    }
                    Err(_) => (0i64, 0i64),
                }
            };
            conn.execute(
                "INSERT OR IGNORE INTO notes (path, title, extension, mtime, size) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![relative_path, title, extension, mtime, size],
            )?;

            // Delete existing tasks for this note (by relative path)
            delete_tasks_for_note(conn, &relative_path)?;

            // Insert new tasks
            if !tasks.is_empty() {
                insert_tasks(conn, &tasks)?;
            }

            // Query tasks back to get IDs assigned by SQLite
            get_tasks_for_note(conn, &relative_path)
        })
        .map_err(|e| format!("Failed to store tasks: {}", e))?;

    log::debug!(
        "📋 [Task] Scanned {} tasks in: {}",
        result.len(),
        relative_path
    );
    Ok(result)
}

/// Get all tasks across all notes
#[tauri::command]
pub fn get_tasks(db: State<DbStateWrapper>) -> Result<Vec<Task>, String> {
    db.0.with_connection(|conn| get_all_tasks(conn))
}

/// Get tasks for a specific note
#[tauri::command]
pub fn get_note_tasks(db: State<DbStateWrapper>, note_path: String) -> Result<Vec<Task>, String> {
    db.0.with_connection(|conn| get_tasks_for_note(conn, &note_path))
}

/// Update only the local task cache. This is used after task-bypass succeeds:
/// the server has accepted the checkbox change, but the local markdown file may
/// not be pulled yet, so rewriting the source file here would trigger a solo
/// body push. Keeping SQLite current makes get_tasks immediately accurate.
#[tauri::command]
pub fn update_task_completion_state(
    db: State<DbStateWrapper>,
    note_path: String,
    task_text: String,
    is_completed: bool,
) -> Result<usize, String> {
    let vault_path =
        db.0.vault_path
            .lock()
            .unwrap()
            .clone()
            .ok_or("No vault open")?;

    let note_path_normalized = normalize_slashes(&note_path);
    let is_absolute = Path::new(&note_path).is_absolute()
        || note_path.starts_with("\\\\")
        || note_path_normalized.starts_with("//")
        || is_windows_absolute_path(&note_path);
    let relative_path = if is_absolute {
        normalize_relative_path(&vault_path, &PathBuf::from(&note_path), &note_path)
    } else {
        note_path_normalized.trim_start_matches('/').to_string()
    };
    let task_text = task_text.trim().to_string();

    db.0.with_connection(|conn| {
        conn.execute(
            r#"UPDATE tasks
               SET is_completed = ?1, updated_at = unixepoch()
               WHERE (note_path = ?2 OR ?2 LIKE '%' || note_path OR note_path LIKE '%' || ?2)
                 AND (raw_text = ?3 OR raw_text LIKE '%' || ?3 || '%' OR ?3 LIKE '%' || raw_text || '%')"#,
            rusqlite::params![is_completed, relative_path, task_text],
        )
    })
    .map_err(|e| format!("Failed to update local task state: {}", e))
}

/// Get tasks matching filter criteria
#[tauri::command]
pub fn filter_tasks(db: State<DbStateWrapper>, filter: TaskFilter) -> Result<Vec<Task>, String> {
    db.0.with_connection(|conn| get_tasks_by_filter(conn, &filter))
}

/// Scan all notes for tasks (batch operation)
#[tauri::command]
pub fn scan_all_tasks(db: State<DbStateWrapper>) -> Result<usize, String> {
    let vault_path =
        db.0.vault_path
            .lock()
            .unwrap()
            .clone()
            .ok_or("No vault open")?;

    let mut total_tasks = 0;

    db.0.with_connection(|conn| {
        // Get all markdown files
        let mut stmt = conn.prepare("SELECT path FROM notes WHERE extension = 'md'")?;

        let paths: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        for note_path in paths {
            let file_path = vault_path.join(&note_path);

            if let Ok(content) = fs::read_to_string(&file_path) {
                let tasks = scan_tasks(&content, &note_path);

                // Delete and re-insert
                let _ = delete_tasks_for_note(conn, &note_path);
                if !tasks.is_empty() {
                    let _ = insert_tasks(conn, &tasks);
                    total_tasks += tasks.len();
                }
            }
        }

        Ok(())
    })?;

    log::debug!("📋 [Task] Batch scan complete: {} total tasks", total_tasks);
    Ok(total_tasks)
}

/// Update task completion status in DB and source file
#[tauri::command]
pub fn update_task_completion(
    db: State<DbStateWrapper>,
    note_path: String,
    task_text: String,
    is_completed: bool,
) -> Result<(), String> {
    let vault_path =
        db.0.vault_path
            .lock()
            .unwrap()
            .clone()
            .ok_or("No vault open")?;

    // Update source file
    let file_path = vault_path.join(&note_path);
    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let lines: Vec<&str> = content.lines().collect();

    // Find the line containing the task by matching raw_text content
    // raw_text is the task content after the checkbox, e.g. "Buy milk 📅2024-01-25"
    let task_text = task_text.trim();
    log::debug!(
        "📝 [Task] Looking for task text: \"{}\" in {}",
        task_text,
        note_path
    );

    let mut found_line_idx: Option<usize> = None;

    for (idx, line) in lines.iter().enumerate() {
        let line_trimmed = line.trim();
        let is_task_line = line_trimmed.starts_with("- [ ]")
            || line_trimmed.starts_with("* [ ]")
            || line_trimmed.starts_with("+ [ ]")
            || line_trimmed.starts_with("- [x]")
            || line_trimmed.starts_with("- [X]")
            || line_trimmed.starts_with("* [x]")
            || line_trimmed.starts_with("* [X]")
            || line_trimmed.starts_with("+ [x]")
            || line_trimmed.starts_with("+ [X]");

        if is_task_line {
            // 安全性保证：由于 starts_with 匹配了 5 字节的 ASCII，所以直接切片 5.. 是绝对合法的字符边界
            let line_task_content = line_trimmed[5..].trim();
            if line_task_content.contains(task_text) || task_text.contains(line_task_content) {
                found_line_idx = Some(idx);
                log::debug!("📝 [Task] Found at line {}: \"{}\"", idx + 1, line);
                break;
            }
        }
    }

    let line_idx = found_line_idx.ok_or_else(|| {
        format!(
            "Could not find task \"{}\" in file {}",
            task_text, note_path
        )
    })?;

    // Build the new content with modified checkbox
    let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    let old_line = &new_lines[line_idx];

    let new_line = if is_completed {
        // Mark as complete
        let re = Regex::new(r"^(\s*[-*+]\s*)\[[xX ]\](\s?)").unwrap();
        let replaced = re.replace(old_line, "${1}[x]${2}").to_string();
        log::debug!(
            "📝 [Task] Marking complete: \"{}\" -> \"{}\"",
            old_line,
            replaced
        );
        replaced
    } else {
        // Mark as incomplete
        let re = Regex::new(r"^(\s*[-*+]\s*)\[[xX ]\](\s?)").unwrap();
        let replaced = re.replace(old_line, "${1}[ ]${2}").to_string();
        log::debug!(
            "📝 [Task] Marking incomplete: \"{}\" -> \"{}\"",
            old_line,
            replaced
        );
        replaced
    };

    // Check if replacement happened (could be already up to date)
    if new_line == *old_line {
        log::debug!("⚠️ [Task] No change detected - task checkbox is already in desired state.");
        return Ok(());
    }

    new_lines[line_idx] = new_line;

    // Write back to file
    let new_content = new_lines.join("\n");
    fs::write(&file_path, &new_content).map_err(|e| format!("Failed to write file: {}", e))?;

    // 直接更新数据库以确保即时一致性，防止拖拽回弹
    db.0.with_connection(|conn| -> Result<(), rusqlite::Error> {
        let relative_path = note_path.clone();
        let vault = std::path::Path::new(&vault_path);
        let file_path = vault.join(&relative_path);
        if file_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&file_path) {
                let tasks = crate::core::db::task_scanner::scan_tasks(&content, &relative_path);
                let _ = crate::core::db::repository::delete_tasks_for_note(conn, &relative_path)?;
                if !tasks.is_empty() {
                    let _ = crate::core::db::repository::insert_tasks(conn, &tasks)?;
                }
            }
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    log::debug!(
        "✅ [Task] Updated task \"{}\" in {} line {}: is_completed = {}",
        task_text,
        note_path,
        line_idx + 1,
        is_completed
    );
    Ok(())
}
