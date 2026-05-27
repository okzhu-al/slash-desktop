//! AI Feedback Commands
//!
//! Commands for user feedback on AI-generated tags and summaries.
//! After user adoption, writes adopted content to YAML frontmatter.

use std::path::{Path, PathBuf};
use tauri::State;

use crate::core::db::repository::frontmatter::{write_adopted_to_file, AdoptedContent};
use crate::DbStateWrapper;

// ============================================================================
// Tag Feedback
// ============================================================================

/// Accept an AI tag: move from ai_tags to user_tags, then write to YAML
#[tauri::command]
pub fn accept_ai_tag(
    note_path: String,
    tag: String,
    input_snapshot: Option<String>,
    model_name: Option<String>,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    // Convert absolute path to relative path
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    // 1. Update SQLite
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::accept_ai_tag(
            conn,
            &relative_path,
            &tag,
            input_snapshot.as_deref(),
            model_name.as_deref(),
        )
    })?;

    // 2. Write adopted content to YAML frontmatter
    write_adopted_to_yaml(&db_state, &vault_path_str, &relative_path)?;

    Ok(())
}

/// Reject an AI tag: remove from ai_tags
#[tauri::command]
pub fn reject_ai_tag(
    note_path: String,
    tag: String,
    input_snapshot: Option<String>,
    model_name: Option<String>,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    // Convert absolute path to relative path
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    db_state.0.with_connection(|conn| {
        crate::core::db::repository::reject_ai_tag(
            conn,
            &relative_path,
            &tag,
            input_snapshot.as_deref(),
            model_name.as_deref(),
        )
    })
}

// ============================================================================
// Summary Feedback
// ============================================================================

/// Accept AI summary: copy to user_summary (optionally with edits), then write to YAML
#[tauri::command]
pub fn accept_ai_summary(
    note_path: String,
    edited_summary: Option<String>,
    input_snapshot: Option<String>,
    model_name: Option<String>,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    // Convert absolute path to relative path
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    // 1. Update SQLite
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::accept_ai_summary(
            conn,
            &relative_path,
            edited_summary.as_deref(),
            input_snapshot.as_deref(),
            model_name.as_deref(),
        )
    })?;

    // 2. Write adopted content to YAML frontmatter
    write_adopted_to_yaml(&db_state, &vault_path_str, &relative_path)?;

    Ok(())
}

// ============================================================================
// YAML Writeback Helper
// ============================================================================

/// Read adopted data from SQLite and write to YAML frontmatter.
///
/// Queries `user_tags`, `user_summary`, `title` from notes table,
/// builds `AdoptedContent`, and calls `write_adopted_to_file()`.
/// Skips write if no change is needed (idempotent).
fn write_adopted_to_yaml(
    db_state: &State<DbStateWrapper>,
    vault_path: &PathBuf,
    relative_path: &str,
) -> Result<(), String> {
    // Read adopted data from SQLite
    let adopted = db_state.0.with_connection(|conn| {
        let (user_tags_json, user_summary, _title, ai_provider, ai_model): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT n.user_tags, n.user_summary, n.title, a.provider, a.model FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                rusqlite::params![relative_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|_| rusqlite::Error::QueryReturnedNoRows)?;

        let tags: Option<Vec<String>> = user_tags_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .filter(|t: &Vec<String>| !t.is_empty());

        let now = chrono::Local::now().to_rfc3339();

        Ok(AdoptedContent {
            tags,
            summary: user_summary,
            title: None, // Don't write title on tag/summary adoption
            ai_provider,
            ai_model,
            ai_processed_at: Some(now),
        })
    })?;

    write_adopted_to_file(vault_path.as_path(), relative_path, &adopted).map(|_| ())
    // Discard the bool (changed/unchanged)
}

// ============================================================================
// Correction Logging
// ============================================================================

/// Log tag correction: records final state of all tags when user finishes editing
#[tauri::command]
pub fn log_tag_correction(
    note_path: String,
    ai_tags: Vec<String>,
    user_tags: Vec<String>,
    input_snapshot: Option<String>,
    model_name: Option<String>,
    db_state: State<DbStateWrapper>,
) -> Result<i64, String> {
    // Convert absolute path to relative path
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    db_state.0.with_connection(|conn| {
        crate::core::db::repository::log_tag_correction(
            conn,
            &relative_path,
            &ai_tags,
            &user_tags,
            input_snapshot.as_deref(),
            model_name.as_deref(),
        )
    })
}
