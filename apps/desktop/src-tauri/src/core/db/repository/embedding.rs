use rusqlite::{Connection, Result as SqliteResult};

// ============================================================================
// Embedding Functions (Legacy V1)
// ============================================================================

/// Upsert embedding for a note (Legacy - No-op)
pub fn upsert_embedding(
    _conn: &Connection,
    note_path: &str,
    _embedding: &[f32],
    _model: &str,
) -> SqliteResult<()> {
    log::error!(
        "❌ [Legacy] upsert_embedding called for {} - ignored (table removed)",
        note_path
    );
    Ok(())
}

/// Get embedding for a note (Legacy - No-op)
#[allow(dead_code)]
pub fn get_embedding(_conn: &Connection, note_path: &str) -> SqliteResult<Option<Vec<f32>>> {
    log::error!(
        "❌ [Legacy] get_embedding called for {} - ignored (table removed)",
        note_path
    );
    Ok(None)
}
