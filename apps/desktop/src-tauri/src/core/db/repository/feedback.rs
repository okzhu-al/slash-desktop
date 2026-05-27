use rusqlite::{params, Connection, Result as SqliteResult};

// ============================================================================
// AI Feedback Functions
// ============================================================================

/// Log AI feedback for model training (training triplet: input/negative/positive)
/// - content_snippet: Note content when AI processed (first 4k chars)
/// - ai_output: What AI generated (negative example for DPO)
/// - user_final: User's final choice (positive example for SFT)
/// - model_name: Which model generated the output
pub fn insert_ai_feedback(
    conn: &Connection,
    note_path: &str,
    feedback_type: &str,
    input_snapshot: Option<&str>,
    ai_output: &str,
    user_correction: Option<&str>,
    model_name: Option<&str>,
) -> SqliteResult<i64> {
    // BUG-D08: 当前端未传 model_name 时，从 ai_settings 表读取当前配置的模型
    let effective_model: Option<String> = model_name.map(|s| s.to_string()).or_else(|| {
        conn.query_row(
            "SELECT value FROM ai_settings WHERE key = 'model'",
            [],
            |row| row.get(0),
        )
        .ok()
    });
    conn.execute(
        r#"
        INSERT INTO ai_feedback (skill_id, note_path, action, ai_output, user_final, content_snippet, model)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![feedback_type, note_path, feedback_type, ai_output, user_correction, input_snapshot, effective_model],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Log tag correction: records the complete final state of tags
/// - ai_tags: JSON array of all AI-generated tags
/// - user_tags: JSON array of all final user tags (the "correct answer")
pub fn log_tag_correction(
    conn: &Connection,
    note_path: &str,
    ai_tags: &[String],
    user_tags: &[String],
    input_snapshot: Option<&str>,
    model_name: Option<&str>,
) -> SqliteResult<i64> {
    let ai_tags_json = serde_json::to_string(ai_tags).unwrap_or_default();
    let user_tags_json = serde_json::to_string(user_tags).unwrap_or_default();

    insert_ai_feedback(
        conn,
        note_path,
        "tag_correction",
        input_snapshot,
        &ai_tags_json,
        Some(&user_tags_json),
        model_name,
    )
}

/// 从 ai_feedback 表获取最近 N 条 tag 纠正记录，用于 few-shot 注入 (L2)
/// 返回 (content_snippet, user_final_tags) 对
pub fn get_recent_tag_corrections(
    conn: &Connection,
    limit: usize,
) -> SqliteResult<Vec<(String, Vec<String>)>> {
    let mut stmt = conn.prepare(
        r#"SELECT content_snippet, user_final
           FROM ai_feedback
           WHERE skill_id = 'tag_correction'
             AND user_final IS NOT NULL
             AND content_snippet IS NOT NULL
           GROUP BY content_snippet
           ORDER BY MAX(created_at) DESC
           LIMIT ?1"#,
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        let snippet: String = row.get(0)?;
        let tags_json: String = row.get(1)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        Ok((snippet, tags))
    })?;
    rows.collect()
}
