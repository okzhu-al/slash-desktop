use crate::core::db::models::Note;
use rusqlite::{params, Connection, Result as SqliteResult};
use std::fs;
use std::path::Path;

// ============================================================================
// NOTE CRUD FUNCTIONS
// ============================================================================

/// Upsert a note into the database
pub fn upsert_note(conn: &Connection, note: &Note) -> SqliteResult<i64> {
    // UUID-First: a pulled team note may keep the same slash_id while its local
    // path changes because of team directory mapping/conflict avoidance.
    // The scanner has already regenerated slash_id for real alive-file copies,
    // so a remaining duplicate here is a stale DB row from the old path.
    if let Some(slash_id) = note.slash_id.as_deref() {
        conn.execute(
            "DELETE FROM notes WHERE slash_id = ?1 AND path <> ?2",
            params![slash_id, note.path],
        )?;
    }

    conn.execute(
        r#"
        INSERT INTO notes (
            path, title, extension, mtime, size, category, parent_folder,
            is_embedded, last_processed_at, user_tags, user_summary, slash_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            mtime = excluded.mtime,
            size = excluded.size,
            category = excluded.category,
            parent_folder = excluded.parent_folder,
            user_tags = excluded.user_tags,
            user_summary = excluded.user_summary,
            slash_id = excluded.slash_id,
            updated_at = unixepoch()
        "#,
        params![
            note.path,
            note.title,
            note.extension,
            note.mtime,
            note.size,
            note.category,
            note.parent_folder,
            note.is_embedded,
            note.last_processed_at,
            note.user_tags,
            note.user_summary,
            note.slash_id,
        ],
    )?;

    let note_id: i64 = conn.query_row("SELECT id FROM notes WHERE path = ?1", params![note.path], |row| row.get(0))?;

    if note.ai_summary.is_some() || note.ai_tags.is_some() || note.ai_title.is_some() {
        conn.execute(
            r#"
            INSERT INTO ai_metadata (note_id, title, summary, tags) 
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(note_id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                tags = excluded.tags
            "#,
            params![note_id, note.ai_title, note.ai_summary, note.ai_tags]
        )?;
    }

    Ok(note_id)
}

/// Delete a note and its related data (links, embeddings, blacklist, AI caches)
pub fn delete_note(conn: &Connection, path: &str) -> SqliteResult<()> {
    log::debug!("🗑️ [DB] Deleting note and all related data: {}", path);

    conn.execute("DELETE FROM notes WHERE path = ?1", params![path])?;
    // Links are deleted via CASCADE

    // Clean up embeddings (legacy table removed)
    // conn.execute("DELETE FROM embeddings WHERE note_path = ?1", params![path])?;

    // Clean up embeddings_v2 (new multi-product pipeline)
    conn.execute(
        "DELETE FROM embeddings_v2 WHERE note_path = ?1",
        params![path],
    )?;

    // Clean up ghost link blacklist (both as source and target)
    conn.execute(
        "DELETE FROM ghost_link_blacklist WHERE source_path = ?1 OR target_path = ?1",
        params![path],
    )?;

    // Clean up AI skill state (tracking data for orchestration)
    conn.execute(
        "DELETE FROM ai_skill_state WHERE note_path = ?1",
        params![path],
    )?;

    // Clean up AI suggestion cache (ghostlink reasoning cache)
    conn.execute(
        "DELETE FROM ai_suggestion_cache WHERE source_path = ?1 OR target_path = ?1",
        params![path],
    )?;

    // Clean up classification cache
    conn.execute(
        "DELETE FROM classification_cache WHERE note_path = ?1",
        params![path],
    )?;

    // Clean up AI task suggestions
    conn.execute(
        "DELETE FROM ai_task_suggestions WHERE note_path = ?1",
        params![path],
    )?;

    // Clean up AI feedback records
    conn.execute(
        "DELETE FROM ai_feedback WHERE note_path = ?1",
        params![path],
    )?;

    log::debug!("✅ [DB] Note cleanup complete: {}", path);
    Ok(())
}

/// Rename a note in the database, migrating all related data to the new path.
/// This preserves AI data, user data, embeddings, links, and skill states.
///
/// Safety: Uses SAVEPOINT for atomicity and scope-guard pattern to guarantee
/// `PRAGMA foreign_keys = ON` is restored even on panic or error.
pub fn rename_note_in_db(conn: &Connection, old_path: &str, new_path: &str) -> SqliteResult<usize> {
    log::debug!("🔄 [DB] Renaming note: {} -> {}", old_path, new_path);

    // ── Scope-guard: temporarily disable FK, guaranteed restore ──
    // FK must be disabled because links.source_path FK → notes.path has no ON UPDATE CASCADE.
    // Updating notes.path first would leave links with dangling FK references.
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;

    // Execute all mutations inside a closure; FK is restored on ALL exit paths.
    let result = (|| -> SqliteResult<usize> {
        // Use SAVEPOINT for atomicity — rollback on any error
        conn.execute_batch("SAVEPOINT rename_note")?;

        let inner_result = (|| -> SqliteResult<usize> {
            // 1. Update the notes table (main record)
            let updated = conn.execute(
                "UPDATE notes SET path = ?1, updated_at = unixepoch() WHERE path = ?2",
                params![new_path, old_path],
            )?;

            if updated == 0 {
                log::warn!("⚠️ [DB] Note not found for rename: {}", old_path);
                return Ok(0);
            }

            // 2. Update links where this note is the source
            conn.execute(
                "UPDATE links SET source_path = ?1 WHERE source_path = ?2",
                params![new_path, old_path],
            )?;

            // 3. Update links where this note is the target
            conn.execute(
                "UPDATE links SET target_path = ?1 WHERE target_path = ?2",
                params![new_path, old_path],
            )?;

            // 4. Update embeddings_v2 (delete conflict first, then migrate)
            conn.execute(
                "DELETE FROM embeddings_v2 WHERE note_path = ?1",
                params![new_path],
            )?;
            conn.execute(
                "UPDATE embeddings_v2 SET note_path = ?1 WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            // 4c. Clean up stale pending/processing embedding jobs for old_path
            let stale_cleaned = conn.execute(
                "DELETE FROM embeddings_v2 WHERE note_path = ?1 AND status IN ('pending', 'processing')",
                params![old_path],
            )?;
            if stale_cleaned > 0 {
                log::debug!(
                    "🧹 [DB] Cleaned {} stale embedding jobs for old path: {}",
                    stale_cleaned, old_path
                );
            }

            // 5. Update ghost link blacklist (source)
            conn.execute(
                "UPDATE ghost_link_blacklist SET source_path = ?1 WHERE source_path = ?2",
                params![new_path, old_path],
            )?;

            // 6. Update ghost link blacklist (target)
            conn.execute(
                "UPDATE ghost_link_blacklist SET target_path = ?1 WHERE target_path = ?2",
                params![new_path, old_path],
            )?;

            // 7. Update ai_skill_state (delete existing for new_path first to avoid UNIQUE conflict)
            conn.execute(
                "DELETE FROM ai_skill_state WHERE note_path = ?1",
                params![new_path],
            )?;
            conn.execute(
                "UPDATE ai_skill_state SET note_path = ?1 WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            // 7b. Update ai_suggestion_cache (source and target paths)
            conn.execute(
                "UPDATE ai_suggestion_cache SET source_path = ?1 WHERE source_path = ?2",
                params![new_path, old_path],
            )?;
            conn.execute(
                "UPDATE ai_suggestion_cache SET target_path = ?1 WHERE target_path = ?2",
                params![new_path, old_path],
            )?;

            // 8. Update tasks table (migrate tasks to new note path)
            conn.execute(
                "UPDATE tasks SET note_path = ?1, updated_at = unixepoch() WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            // 9. Update classification_cache (delete existing for new_path first to avoid PK conflict)
            conn.execute(
                "DELETE FROM classification_cache WHERE note_path = ?1",
                params![new_path],
            )?;
            conn.execute(
                "UPDATE classification_cache SET note_path = ?1 WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            // 10. Update ai_task_suggestions (migrate AI-extracted tasks)
            conn.execute(
                "UPDATE ai_task_suggestions SET note_path = ?1 WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            // 11. Update ai_feedback (migrate feedback records)
            conn.execute(
                "UPDATE ai_feedback SET note_path = ?1 WHERE note_path = ?2",
                params![new_path, old_path],
            )?;

            Ok(updated)
        })();

        match inner_result {
            Ok(updated) => {
                conn.execute_batch("RELEASE SAVEPOINT rename_note")?;
                log::debug!("✅ [DB] Note renamed successfully with all related data migrated");
                Ok(updated)
            }
            Err(e) => {
                log::error!("❌ [DB] Rename failed, rolling back: {}", e);
                conn.execute_batch("ROLLBACK TO SAVEPOINT rename_note").ok();
                conn.execute_batch("RELEASE SAVEPOINT rename_note").ok();
                Err(e)
            }
        }
    })();

    // ── GUARANTEED FK RESTORE ── runs on success, error, AND panic ──
    if let Err(e) = conn.execute_batch("PRAGMA foreign_keys = ON") {
        log::error!("🚨 [DB] CRITICAL: Failed to re-enable foreign_keys: {}", e);
    }

    result
}

/// Get notes that need AI processing (mtime > last_processed_at)
pub fn get_dirty_notes(conn: &Connection) -> SqliteResult<Vec<Note>> {
    let mut stmt = conn.prepare(
        r#"
            SELECT 
                n.id, n.path, n.title, n.extension, n.mtime, n.size, n.category, n.parent_folder,
                n.is_embedded, n.last_processed_at, 
                a.summary, 
                a.tags, 
                n.user_tags, n.user_summary, 
                a.title, n.user_title, 
                n.created_at, n.updated_at,
                n.slash_id
            FROM notes n 
            LEFT JOIN ai_metadata a ON n.id = a.note_id
            WHERE n.mtime > n.last_processed_at OR n.last_processed_at = 0
            "#,
    )?;

    let notes = stmt
        .query_map([], |row| {
            Ok(Note {
                id: Some(row.get(0)?),
                path: row.get(1)?,
                title: row.get(2)?,
                extension: row.get(3)?,
                mtime: row.get(4)?,
                size: row.get(5)?,
                category: row.get(6)?,
                parent_folder: row.get(7)?,
                is_embedded: row.get(8)?,
                last_processed_at: row.get(9)?,
                ai_summary: row.get(10)?,
                ai_tags: row.get(11)?,
                user_tags: row.get(12)?,
                user_summary: row.get(13)?,
                ai_title: row.get(14).ok(),
                user_title: row.get(15).ok(),
                slash_id: row.get(18).ok(),
                created_at: row.get(16).ok(),
                updated_at: row.get(17).ok(),
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(notes)
}

/// Get all notes
pub fn get_all_notes(conn: &Connection) -> SqliteResult<Vec<Note>> {
    let mut stmt = conn.prepare(
        r#"
            SELECT 
                n.id, n.path, n.title, n.extension, n.mtime, n.size, n.category, n.parent_folder,
                n.is_embedded, n.last_processed_at, 
                a.summary, 
                a.tags, 
                n.user_tags, n.user_summary, 
                a.title, n.user_title, 
                n.created_at, n.updated_at,
                n.slash_id
            FROM notes n 
            LEFT JOIN ai_metadata a ON n.id = a.note_id
            ORDER BY n.path
        "#,
    )?;

    let notes = stmt
        .query_map([], |row| {
            Ok(Note {
                id: Some(row.get(0)?),
                path: row.get(1)?,
                title: row.get(2)?,
                extension: row.get(3)?,
                mtime: row.get(4)?,
                size: row.get(5)?,
                category: row.get(6)?,
                parent_folder: row.get(7)?,
                is_embedded: row.get(8)?,
                last_processed_at: row.get(9)?,
                ai_summary: row.get(10)?,
                ai_tags: row.get(11)?,
                user_tags: row.get(12)?,
                user_summary: row.get(13)?,
                ai_title: row.get(14).ok(),
                user_title: row.get(15).ok(),
                slash_id: row.get(18).ok(),
                created_at: row.get(16).ok(),
                updated_at: row.get(17).ok(),
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(notes)
}

/// Check if a note exists by name (title without extension)
/// Searches for notes where title matches (case-insensitive)
pub fn check_note_exists_by_name(conn: &Connection, note_name: &str) -> SqliteResult<bool> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE LOWER(title) = LOWER(?1)",
        params![note_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Note preview data for hover card
#[derive(Debug, Clone, serde::Serialize)]
pub struct NotePreview {
    pub exists: bool,
    pub title: String,
    pub path: Option<String>,
    pub summary: Option<String>,
    pub content_preview: Option<String>,
}

/// Get note preview by name for hover card
/// Returns title, summary (if exists) or first 200 chars of content
pub fn get_note_preview_by_name(
    conn: &Connection,
    vault_path: &Path,
    note_name: &str,
) -> SqliteResult<NotePreview> {
    // Try to find the note by title (case-insensitive)
    let result: Result<(String, String, Option<String>, Option<String>), _> = conn.query_row(
        r#"
            SELECT n.title, n.path, a.summary, n.user_summary
            FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id
            WHERE LOWER(n.title) = LOWER(?1) LIMIT 1
        "#,
        params![note_name],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    );

    match result {
        Ok((title, path, ai_summary, user_summary)) => {
            // Prefer user_summary, then ai_summary
            let summary = user_summary.or(ai_summary);

            // If no summary, read first 200 chars from file
            let content_preview = if summary.is_none() {
                let file_path = vault_path.join(&path);
                if let Ok(content) = fs::read_to_string(&file_path) {
                    // Skip frontmatter if present
                    let body = if content.starts_with("---") {
                        content
                            .split("---")
                            .skip(2)
                            .collect::<Vec<_>>()
                            .join("---")
                            .trim()
                            .to_string()
                    } else {
                        content.trim().to_string()
                    };

                    // Take first 200 chars
                    if body.len() > 200 {
                        Some(format!(
                            "{}...",
                            &body.chars().take(200).collect::<String>()
                        ))
                    } else if !body.is_empty() {
                        Some(body)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            Ok(NotePreview {
                exists: true,
                title,
                path: Some(path),
                summary,
                content_preview,
            })
        }
        Err(_) => Ok(NotePreview {
            exists: false,
            title: note_name.to_string(),
            path: None,
            summary: None,
            content_preview: None,
        }),
    }
}

/// Update WikiLinks in other files when a note is renamed.
/// Changes all [[old_title]] to [[new_title]] in files that reference the renamed note.
/// Returns the list of files that were updated.
pub fn update_wikilinks_on_rename(
    conn: &Connection,
    vault_path: &std::path::Path,
    old_title: &str,
    new_title: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    // Find all files that link to the old title
    let mut updated_files = Vec::new();

    // Query links table to find source files that might contain WikiLinks to this note
    let mut stmt = conn.prepare(
        "SELECT DISTINCT source_path FROM links WHERE target_path LIKE ?1 OR label = ?2",
    )?;

    // Match by filename (without extension) or by label
    let old_title_pattern = format!("%{}.md", old_title);
    let source_paths: Vec<String> = stmt
        .query_map(params![old_title_pattern, old_title], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    log::debug!(
        "🔗 [WikiLink] Found {} files potentially linking to '{}'",
        source_paths.len(),
        old_title
    );

    for source_path in source_paths {
        let file_path = vault_path.join(&source_path);

        if !file_path.exists() {
            continue;
        }

        // Read file content
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("⚠️ [WikiLink] Failed to read {}: {}", source_path, e);
                continue;
            }
        };

        // Replace WikiLinks: [[old_title]] → [[new_title]]
        // Also handle [[old_title|alias]] → [[new_title|alias]]
        // And [[old_title#anchor]] → [[new_title#anchor]]

        let patterns = [
            // Simple: [[old_title]]
            (format!("[[{}]]", old_title), format!("[[{}]]", new_title)),
            // With alias: [[old_title|
            (format!("[[{}|", old_title), format!("[[{}|", new_title)),
            // With anchor: [[old_title#
            (format!("[[{}#", old_title), format!("[[{}#", new_title)),
        ];

        let mut new_content = content.clone();
        let mut modified = false;

        for (old_pattern, new_pattern) in &patterns {
            if new_content.contains(old_pattern) {
                new_content = new_content.replace(old_pattern, new_pattern);
                modified = true;
            }
        }

        if modified {
            // Write back the updated content
            match std::fs::write(&file_path, &new_content) {
                Ok(_) => {
                    log::debug!("✅ [WikiLink] Updated links in: {}", source_path);
                    updated_files.push(source_path);
                }
                Err(e) => {
                    log::warn!("❌ [WikiLink] Failed to write {}: {}", source_path, e);
                }
            }
        }
    }

    log::debug!(
        "🔗 [WikiLink] Updated {} files with new WikiLinks",
        updated_files.len()
    );
    Ok(updated_files)
}
