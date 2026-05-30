use crate::state::DbStateWrapper;
use tauri::State;

// --- Graph ---

#[tauri::command]
pub fn get_note_graph(
    vault_path: String,
    note_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<crate::core::db::repository::NoteGraph, String> {
    // Convert absolute path to relative path
    let normalized_note_path = crate::core::db::repository::normalize_path(&note_path);
    let normalized_vault_path = crate::core::db::repository::normalize_path(&vault_path);
    let relative_path = if normalized_note_path.starts_with(&normalized_vault_path) {
        normalized_note_path
            .strip_prefix(&normalized_vault_path)
            .unwrap_or(&normalized_note_path)
            .trim_start_matches('/')
            .to_string()
    } else {
        normalized_note_path
    };

    log::debug!(
        "[get_note_graph] vault_path: {}, note_path: {}, relative_path: {}",
        vault_path, note_path, relative_path
    );

    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_note_graph(conn, &relative_path))
}

#[tauri::command]
pub fn get_global_graph(
    _vault_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<crate::core::db::repository::NoteGraph, String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_global_graph(conn))
}

#[tauri::command]
pub fn get_note_backlinks_by_section(
    note_name: String,
    db_state: State<DbStateWrapper>,
) -> Result<std::collections::HashMap<String, Vec<crate::core::db::repository::BacklinkInfo>>, String>
{
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::get_note_backlinks_by_section(conn, &note_name)
    })
}
