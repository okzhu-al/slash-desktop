use rusqlite::{params, Connection, Result as SqliteResult};

// ============================================================================
// FOLDER EMBEDDINGS (Smart Classification)
// ============================================================================

/// Folder embedding data for Smart Classification
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct FolderEmbedding {
    pub folder_path: String,
    pub embedding: Option<Vec<f32>>,
    pub semantic_profile: Option<String>,
    pub last_calculated_at: Option<i64>,
    pub is_dirty: bool,
    pub access_count: i64,
    pub last_active_at: Option<i64>,
}

/// Upsert folder embedding
pub fn upsert_folder_embedding(
    conn: &Connection,
    folder_path: &str,
    embedding: Option<&[f32]>,
    semantic_profile: Option<&str>,
) -> SqliteResult<()> {
    let embedding_blob =
        embedding.map(|e| e.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<u8>>());

    conn.execute(
        r#"
        INSERT INTO folder_embeddings (folder_path, embedding, semantic_profile, last_calculated_at, is_dirty)
        VALUES (?1, ?2, ?3, unixepoch(), 0)
        ON CONFLICT(folder_path) DO UPDATE SET
            embedding = excluded.embedding,
            semantic_profile = excluded.semantic_profile,
            last_calculated_at = excluded.last_calculated_at,
            is_dirty = 0
        "#,
        params![folder_path, embedding_blob, semantic_profile],
    )?;
    Ok(())
}

/// Mark a folder as dirty (needs embedding recalculation)
pub fn mark_folder_dirty(conn: &Connection, folder_path: &str) -> SqliteResult<()> {
    // First, try to insert a new dirty record if folder doesn't exist
    conn.execute(
        r#"
        INSERT INTO folder_embeddings (folder_path, is_dirty, last_active_at)
        VALUES (?1, 1, unixepoch())
        ON CONFLICT(folder_path) DO UPDATE SET
            is_dirty = 1,
            last_active_at = unixepoch(),
            access_count = access_count + 1
        "#,
        params![folder_path],
    )?;
    Ok(())
}

/// Get all dirty folders that need embedding recalculation
#[allow(dead_code)]
pub fn get_dirty_folders(conn: &Connection) -> SqliteResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT folder_path FROM folder_embeddings WHERE is_dirty = 1")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// Get all folder embeddings (for vector search)
pub fn get_all_folder_embeddings(conn: &Connection) -> SqliteResult<Vec<FolderEmbedding>> {
    let mut stmt = conn.prepare(
        r#"SELECT folder_path, embedding, semantic_profile, last_calculated_at, 
                  is_dirty, access_count, last_active_at 
           FROM folder_embeddings 
           WHERE embedding IS NOT NULL"#,
    )?;

    let rows = stmt.query_map([], |row| {
        let embedding_blob: Option<Vec<u8>> = row.get(1)?;
        let embedding = embedding_blob.map(|blob| {
            blob.chunks(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect()
        });

        Ok(FolderEmbedding {
            folder_path: row.get(0)?,
            embedding,
            semantic_profile: row.get(2)?,
            last_calculated_at: row.get(3)?,
            is_dirty: row.get(4)?,
            access_count: row.get(5)?,
            last_active_at: row.get(6)?,
        })
    })?;

    rows.collect()
}

/// Get folder statistics for building semantic profile
/// Returns: (top_tags, recent_titles, note_count)
pub fn get_folder_stats(
    conn: &Connection,
    folder_path: &str,
) -> SqliteResult<(Vec<String>, Vec<String>, i64)> {
    // Get note count in this folder
    let note_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE parent_folder = ?1",
        params![folder_path],
        |row| row.get(0),
    )?;

    // Get top 5 tags used in this folder (from user_tags and ai_tags)
    let mut tag_stmt = conn.prepare(
        r#"
        SELECT tag, COUNT(*) as cnt FROM (
            SELECT value as tag FROM notes n, json_each(n.user_tags)
            WHERE n.parent_folder = ?1 AND n.user_tags IS NOT NULL AND n.user_tags != ''
            UNION ALL
            SELECT value as tag FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id, json_each(a.tags)
            WHERE n.parent_folder = ?1 AND a.tags IS NOT NULL AND a.tags != ''
        )
        GROUP BY tag ORDER BY cnt DESC LIMIT 5
        "#,
    )?;
    let top_tags: Vec<String> = tag_stmt
        .query_map(params![folder_path], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Get 5 most recent note titles in this folder
    let mut title_stmt = conn.prepare(
        r#"
        SELECT title FROM notes 
        WHERE parent_folder = ?1 
        ORDER BY mtime DESC LIMIT 5
        "#,
    )?;
    let recent_titles: Vec<String> = title_stmt
        .query_map(params![folder_path], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    Ok((top_tags, recent_titles, note_count))
}

/// Get all folders in vault (excluding special folders)
#[allow(dead_code)]
pub fn get_all_folders(conn: &Connection) -> SqliteResult<Vec<String>> {
    // Get folders from notes table (folders that contain notes)
    let mut stmt = conn.prepare(
        r#"
        SELECT DISTINCT parent_folder FROM notes 
        WHERE parent_folder IS NOT NULL 
          AND parent_folder != ''
          AND parent_folder NOT LIKE '%/assets%'
          AND parent_folder NOT LIKE '%/attachments%'
          AND parent_folder NOT LIKE '00_Inbox%'
          AND parent_folder NOT LIKE '04_Archives%'
        ORDER BY parent_folder
        "#,
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut folders: Vec<String> = rows.filter_map(|r| r.ok()).collect();

    // Also get folders that already have embeddings (including manually created ones)
    let mut stmt2 = conn.prepare(
        r#"
        SELECT DISTINCT folder_path FROM folder_embeddings 
        WHERE folder_path IS NOT NULL 
          AND folder_path != ''
          AND folder_path NOT LIKE '%/assets%'
          AND folder_path NOT LIKE '%/attachments%'
          AND folder_path NOT LIKE '00_Inbox%'
          AND folder_path NOT LIKE '04_Archives%'
        ORDER BY folder_path
        "#,
    )?;
    let rows2 = stmt2.query_map([], |row| row.get::<_, String>(0))?;
    for folder in rows2.filter_map(|r| r.ok()) {
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }

    folders.sort();
    Ok(folders)
}
