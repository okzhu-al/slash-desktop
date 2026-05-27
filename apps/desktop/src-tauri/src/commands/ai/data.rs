//! AI Data Retrieval
//!
//! Commands for querying AI-generated data for notes.

use std::path::Path;
use tauri::State;

use crate::DbStateWrapper;
use crate::core::db::repository::frontmatter::{AdoptedContent, write_adopted_to_file};

// ============================================================================
// Data Types
// ============================================================================

/// AI data for a note
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct NoteAIData {
    pub ai_tags: Vec<String>,
    pub ai_summary: Option<String>,
    /// True if user has edited summary AND AI has a different (newer) suggestion
    pub has_summary_update: bool,
    /// True if user has edited tags AND AI has different (newer) suggestions
    pub has_tags_update: bool,
    /// AI-generated title suggestion (for default-named notes)
    pub ai_title: Option<String>,
    /// User-confirmed title (takes precedence over ai_title)
    pub user_title: Option<String>,
    /// True if AI has suggested a title and user hasn't confirmed it yet
    pub has_title_suggestion: bool,
    /// True if AI has suggested a summary and user hasn't confirmed it yet
    pub has_summary_suggestion: bool,
}

// ============================================================================
// Data Retrieval Commands
// ============================================================================

/// Get AI data (tags, summary) for a note by path
#[tauri::command]
pub fn get_note_ai_data(
    note_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<NoteAIData, String> {
    // Convert absolute path to relative path for DB query
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

    // Path conversion done (silent)

    db_state.0.with_connection(|conn| {
        let result: Result<
            (
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ),
            _,
        > = conn.query_row(
            "SELECT a.tags, a.summary, n.user_tags, n.user_summary, a.title, n.user_title FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
            rusqlite::params![relative_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        );

        match result {
            Ok((ai_tags_json, ai_summary, user_tags_json, user_summary, ai_title, user_title)) => {
                // Data found, processing (silent)
                let ai_tags: Vec<String> = ai_tags_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                // Check if user has edited and AI has different (newer) suggestions
                let has_summary_update = match (&user_summary, &ai_summary) {
                    (Some(user_s), Some(ai_s)) => user_s != ai_s,
                    _ => false,
                };

                let has_tags_update = match (&user_tags_json, &ai_tags_json) {
                    (Some(user_t), Some(ai_t)) => user_t != ai_t,
                    _ => false,
                };

                // Title suggestion: AI has renamed the file but user hasn't confirmed yet
                let has_title_suggestion = ai_title.is_some() && user_title.is_none();
                
                // Summary suggestion: AI has a summary but user hasn't confirmed yet
                let has_summary_suggestion = ai_summary.is_some() && user_summary.is_none();

                Ok(NoteAIData {
                    ai_tags,
                    ai_summary,
                    has_summary_update,
                    has_tags_update,
                    ai_title,
                    user_title,
                    has_title_suggestion,
                    has_summary_suggestion,
                })
            }
            Err(_) => {
                // Note not in DB, return default
                Ok(NoteAIData::default())
            }
        }
    })
}

// ============================================================================
// Title Management Commands
// ============================================================================

/// Accept AI-suggested title - sets user_title = current title (confirming AI's choice),
/// then writes adopted content to YAML frontmatter.
#[tauri::command]
pub fn accept_ai_title(note_path: String, db_state: State<DbStateWrapper>) -> Result<(), String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    log::debug!("✅ [Rust] accept_ai_title for: {}", relative_path);

    // 1. Update SQLite: set user_title = ai_title
    db_state.0.with_connection(|conn| {
        conn.execute(
            "UPDATE notes SET user_title = (SELECT title FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)) WHERE path = ?1",
            rusqlite::params![relative_path],
        )?;

        Ok(())
    })?;

    // 2. Write adopted content to YAML frontmatter (including title)
    let adopted = db_state.0.with_connection(|conn| {
        let (user_tags_json, user_summary, title, ai_provider, ai_model): (
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
            title, // Include title for title adoption
            ai_provider,
            ai_model,
            ai_processed_at: Some(now),
        })
    })?;

    write_adopted_to_file(vault_path.as_path(), &relative_path, &adopted)
        .map(|_| ()) // Discard the bool (changed/unchanged)
}


// ============================================================================
// YAML Helper Functions
// ============================================================================

/// Update the YAML frontmatter title in note content (delegates to unified frontmatter module)
fn update_yaml_title(content: &str, new_title: &str) -> String {
    crate::core::db::repository::frontmatter::update_frontmatter_field(content, "title", new_title)
}

/// Set user-defined title - user has chosen a custom title
/// This renames the file and migrates all data
#[tauri::command]
pub fn set_user_title(
    old_path: String,
    new_title: String,
    db_state: State<DbStateWrapper>,
) -> Result<String, String> {
    use crate::core::db::repository;

    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let old_relative = Path::new(&old_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(old_path.clone());

    // Construct new path
    let parent_dir = Path::new(&old_relative)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("");
    let new_filename = format!("{}.md", new_title);
    let new_relative = if parent_dir.is_empty() {
        new_filename.clone()
    } else {
        format!("{}/{}", parent_dir, new_filename)
    };

    log::debug!(
        "📝 [Rust] set_user_title: {} -> {}",
        old_relative, new_relative
    );

    // Rename file on disk
    let old_absolute = vault_path.join(&old_relative);
    let new_absolute = vault_path.join(&new_relative);

    std::fs::rename(&old_absolute, &new_absolute)
        .map_err(|e| format!("Failed to rename file: {}", e))?;

    // Update YAML frontmatter title in the renamed file
    let content = std::fs::read_to_string(&new_absolute)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let updated_content = update_yaml_title(&content, &new_title);
    std::fs::write(&new_absolute, updated_content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    db_state.0.with_connection(|conn| {
        // Migrate database records
        repository::rename_note_in_db(conn, &old_relative, &new_relative)?;

        // Set user_title to confirm this is user's choice
        conn.execute(
            "UPDATE notes SET user_title = ?1, title = ?1 WHERE path = ?2",
            rusqlite::params![new_title, new_relative],
        )?;

        // Update WikiLinks in other files: [[old_title]] → [[new_title]]
        let old_title = std::path::Path::new(&old_relative)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if !old_title.is_empty() {
            let vault_path_buf = std::path::PathBuf::from(&vault_path);
            let _ = repository::update_wikilinks_on_rename(
                conn,
                &vault_path_buf,
                old_title,
                &new_title,
            );
        }

        Ok(())
    })?;

    // Return new absolute path for frontend navigation
    Ok(new_absolute.to_string_lossy().to_string())
}

// ============================================================================
// Sidebar Title Suggestion Indicator
// ============================================================================

/// Get all notes that have pending AI title suggestions
/// (ai_title IS NOT NULL AND user_title IS NULL)
/// Returns a list of relative paths
#[tauri::command]
pub fn get_notes_with_pending_title(
    db_state: State<DbStateWrapper>,
) -> Result<Vec<String>, String> {
    db_state.0.with_connection(|conn| {
        let mut stmt = conn
            .prepare("SELECT n.path FROM notes n INNER JOIN ai_metadata a ON n.id = a.note_id WHERE a.title IS NOT NULL AND n.user_title IS NULL")?;

        let paths: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(paths)
    })
}
