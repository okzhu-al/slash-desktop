use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use super::feedback::insert_ai_feedback;

// ============================================================================
// AI Skill Configuration Functions
// ============================================================================

/// Skill configuration row from database
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillConfigRow {
    pub skill_id: String,
    pub enabled: bool,
    pub config: String, // JSON config for skill-specific settings
    // Rule expressions per state (JSON-serialized RuleExpression)
    pub rule_open: Option<String>,
    pub rule_active: Option<String>,
    pub rule_idle: Option<String>,
    pub rule_blur: Option<String>,
}

/// Load all skill configurations from database
pub fn load_skill_configs(conn: &Connection) -> SqliteResult<Vec<SkillConfigRow>> {
    let mut stmt = conn.prepare(
        "SELECT skill_id, enabled, COALESCE(config, '{}'), rule_open, rule_active, rule_idle, rule_blur
         FROM ai_skill_config",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(SkillConfigRow {
            skill_id: row.get(0)?,
            enabled: row.get::<_, i32>(1)? != 0,
            config: row.get(2)?,
            rule_open: row.get(3)?,
            rule_active: row.get(4)?,
            rule_idle: row.get(5)?,
            rule_blur: row.get(6)?,
        })
    })?;

    rows.collect()
}

/// Load single skill configuration by ID
pub fn load_skill_config(
    conn: &Connection,
    skill_id: &str,
) -> SqliteResult<Option<SkillConfigRow>> {
    conn.query_row(
        "SELECT skill_id, enabled, COALESCE(config, '{}'), rule_open, rule_active, rule_idle, rule_blur
         FROM ai_skill_config WHERE skill_id = ?1",
        params![skill_id],
        |row| {
            Ok(SkillConfigRow {
                skill_id: row.get(0)?,
                enabled: row.get::<_, i32>(1)? != 0,
                config: row.get(2)?,
                rule_open: row.get(3)?,
                rule_active: row.get(4)?,
                rule_idle: row.get(5)?,
                rule_blur: row.get(6)?,
            })
        },
    )
    .optional()
}

/// Upsert skill configuration
pub fn upsert_skill_config(conn: &Connection, config: &SkillConfigRow) -> SqliteResult<()> {
    conn.execute(
        r#"
        INSERT INTO ai_skill_config (skill_id, enabled, config, rule_open, rule_active, rule_idle, rule_blur, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())
        ON CONFLICT(skill_id) DO UPDATE SET
            enabled = excluded.enabled,
            config = excluded.config,
            rule_open = excluded.rule_open,
            rule_active = excluded.rule_active,
            rule_idle = excluded.rule_idle,
            rule_blur = excluded.rule_blur,
            updated_at = unixepoch()
        "#,
        params![
            config.skill_id,
            config.enabled as i32,
            config.config,
            config.rule_open,
            config.rule_active,
            config.rule_idle,
            config.rule_blur
        ],
    )?;
    Ok(())
}

// ============================================================================
// Ghost Link Blacklist Functions
// 独立表设计（Won't merge into ai_feedback）：语义清晰、引用分散（~15 处），合并 ROI 不划算。
// ============================================================================

/// Add a pair to the ghost link blacklist
pub fn add_ghost_link_blacklist(
    conn: &Connection,
    source_path: &str,
    target_path: &str,
) -> SqliteResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO ghost_link_blacklist (source_path, target_path) VALUES (?1, ?2)",
        params![source_path, target_path],
    )?;
    Ok(())
}

/// Check if a pair is in the ghost link blacklist
#[allow(dead_code)]
pub fn is_ghost_link_blacklisted(
    conn: &Connection,
    source_path: &str,
    target_path: &str,
) -> SqliteResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ghost_link_blacklist WHERE source_path = ?1 AND target_path = ?2",
        params![source_path, target_path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get all blacklisted targets for a source note
#[allow(dead_code)]
pub fn get_blacklisted_targets(conn: &Connection, source_path: &str) -> SqliteResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT target_path FROM ghost_link_blacklist WHERE source_path = ?1")?;
    let rows = stmt.query_map(params![source_path], |row| row.get(0))?;
    rows.collect()
}

// ============================================================================
// AI SUGGESTION CACHE
// ============================================================================

/// Get cached suggestion if mtime matches (cache hit)
/// Returns (relation, reason) if cache is valid, None otherwise
pub fn get_cached_suggestion(
    conn: &Connection,
    source_path: &str,
    target_path: &str,
    source_mtime: i64,
    target_mtime: i64,
    provider_key: &str,
) -> SqliteResult<Option<(String, String)>> {
    conn.query_row(
        r#"SELECT relation, reason FROM ai_suggestion_cache 
           WHERE source_path = ?1 AND target_path = ?2 
           AND source_mtime = ?3 AND target_mtime = ?4
           AND provider_key = ?5
           AND reason IS NOT NULL AND reason != ''"#,
        params![
            source_path,
            target_path,
            source_mtime,
            target_mtime,
            provider_key
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// Insert or update suggestion cache
pub fn upsert_suggestion_cache(
    conn: &Connection,
    source_path: &str,
    target_path: &str,
    source_mtime: i64,
    target_mtime: i64,
    relation: &str,
    reason: &str,
    provider_key: &str,
) -> SqliteResult<()> {
    // Don't cache empty reasons - they represent LLM failures that should be retried
    if reason.trim().is_empty() {
        log::error!(
            "⏭️ [Cache] Skipping write for {} -> {}: empty reason",
            source_path, target_path
        );
        return Ok(());
    }
    conn.execute(
        r#"INSERT INTO ai_suggestion_cache 
           (source_path, target_path, provider_key, source_mtime, target_mtime, relation, reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(source_path, target_path, provider_key) DO UPDATE SET
             source_mtime = excluded.source_mtime,
             target_mtime = excluded.target_mtime,
             relation = excluded.relation,
             reason = excluded.reason,
             created_at = unixepoch()"#,
        params![
            source_path,
            target_path,
            provider_key,
            source_mtime,
            target_mtime,
            relation,
            reason
        ],
    )?;
    Ok(())
}

/// Invalidate cache entries when a note changes
/// Clears entries where the note is either source or target
pub fn invalidate_suggestion_cache(conn: &Connection, note_path: &str) -> SqliteResult<usize> {
    let count = conn.execute(
        "DELETE FROM ai_suggestion_cache WHERE source_path = ?1 OR target_path = ?1",
        params![note_path],
    )?;
    Ok(count)
}

// ============================================================================
// Tag RAG Functions
// ============================================================================

/// Get existing tags from both ai_tags and user_tags, sorted by frequency
/// Returns vec of (tag_name, usage_count) for RAG injection into tagging prompt
pub fn get_existing_tags_with_frequency(
    conn: &Connection,
    limit: usize,
) -> SqliteResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT tag, COUNT(*) as freq FROM (
            SELECT json_each.value as tag FROM ai_metadata, json_each(tags) WHERE tags IS NOT NULL
            UNION ALL
            SELECT json_each.value as tag FROM notes, json_each(user_tags) WHERE user_tags IS NOT NULL
        )
        GROUP BY tag
        ORDER BY freq DESC
        LIMIT ?1
        "#,
    )?;

    let results = stmt
        .query_map(params![limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

// ============================================================================
// AI SKILL STATE (Orchestrator Persistence)
// ============================================================================

/// Skill execution state for a note
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillState {
    pub note_path: String,
    pub skill_id: String,
    pub last_content_hash: Option<String>,
    pub last_run_time: Option<u64>,
    pub execution_count: i64,
    pub last_result: Option<String>,
}

/// Get skill state for a specific note and skill
#[allow(dead_code)]
pub fn get_skill_state(
    conn: &Connection,
    note_path: &str,
    skill_id: &str,
) -> SqliteResult<Option<SkillState>> {
    conn.query_row(
        r#"SELECT note_path, skill_id, last_content_hash, last_run_time, 
                  execution_count, last_result 
           FROM ai_skill_state 
           WHERE note_path = ?1 AND skill_id = ?2"#,
        params![note_path, skill_id],
        |row| {
            Ok(SkillState {
                note_path: row.get(0)?,
                skill_id: row.get(1)?,
                last_content_hash: row.get(2)?,
                last_run_time: row.get(3)?,
                execution_count: row.get(4)?,
                last_result: row.get(5)?,
            })
        },
    )
    .optional()
}

/// Get all skill states for a note
#[allow(dead_code)]
pub fn get_skill_states_for_note(
    conn: &Connection,
    note_path: &str,
) -> SqliteResult<Vec<SkillState>> {
    let mut stmt = conn.prepare(
        r#"SELECT note_path, skill_id, last_content_hash, last_run_time, 
                  execution_count, last_result 
           FROM ai_skill_state 
           WHERE note_path = ?1"#,
    )?;

    let rows = stmt.query_map(params![note_path], |row| {
        Ok(SkillState {
            note_path: row.get(0)?,
            skill_id: row.get(1)?,
            last_content_hash: row.get(2)?,
            last_run_time: row.get(3)?,
            execution_count: row.get(4)?,
            last_result: row.get(5)?,
        })
    })?;

    rows.collect()
}

/// Update or insert skill state after execution
pub fn upsert_skill_state(
    conn: &Connection,
    note_path: &str,
    skill_id: &str,
    content_hash: &str,
    char_count: usize,
    run_time: u64,
    result: &str,
) -> SqliteResult<()> {
    conn.execute(
        r#"INSERT INTO ai_skill_state 
           (note_path, skill_id, last_content_hash, char_count, last_run_time, execution_count, last_result)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
           ON CONFLICT(note_path, skill_id) DO UPDATE SET
             last_content_hash = excluded.last_content_hash,
             char_count = excluded.char_count,
             last_run_time = excluded.last_run_time,
             execution_count = execution_count + 1,
             last_result = excluded.last_result,
             updated_at = unixepoch()"#,
        params![note_path, skill_id, content_hash, char_count as i64, run_time as i64, result],
    )?;
    Ok(())
}

/// Check if skill should run based on content hash
/// Returns true if content has changed since last run
#[allow(dead_code)]
pub fn should_skill_run(
    conn: &Connection,
    note_path: &str,
    skill_id: &str,
    current_hash: &str,
) -> SqliteResult<bool> {
    let last_hash: Option<String> = conn
        .query_row(
            "SELECT last_content_hash FROM ai_skill_state WHERE note_path = ?1 AND skill_id = ?2",
            params![note_path, skill_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    Ok(last_hash.as_deref() != Some(current_hash))
}

/// Delete all skill states for a note (when note is deleted)
#[allow(dead_code)]
pub fn delete_skill_states_for_note(conn: &Connection, note_path: &str) -> SqliteResult<usize> {
    conn.execute(
        "DELETE FROM ai_skill_state WHERE note_path = ?1",
        params![note_path],
    )
}

// ============================================================================
// CLASSIFICATION CACHE
// ============================================================================

/// Get cached classification result if content hash matches
/// Returns the cached JSON string if found and hash matches, None otherwise
pub fn get_classification_cache(
    conn: &Connection,
    note_path: &str,
    current_hash: &str,
) -> SqliteResult<Option<String>> {
    conn.query_row(
        "SELECT suggestions FROM classification_cache WHERE note_path = ?1 AND content_hash = ?2",
        params![note_path, current_hash],
        |row| row.get(0),
    )
    .optional()
}

/// Save classification result to cache
/// Uses UPSERT to replace existing cache for the note
pub fn save_classification_cache(
    conn: &Connection,
    note_path: &str,
    content_hash: &str,
    suggestions_json: &str,
    has_pending_tasks: bool,
) -> SqliteResult<()> {
    conn.execute(
        r#"INSERT INTO classification_cache (note_path, content_hash, suggestions, has_pending_tasks, created_at)
           VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
           ON CONFLICT(note_path) DO UPDATE SET
             content_hash = excluded.content_hash,
             suggestions = excluded.suggestions,
             has_pending_tasks = excluded.has_pending_tasks,
             created_at = excluded.created_at"#,
        params![note_path, content_hash, suggestions_json, has_pending_tasks as i32],
    )?;
    Ok(())
}

/// Delete classification cache for a note (when note is deleted or moved)
#[allow(dead_code)]
pub fn delete_classification_cache(conn: &Connection, note_path: &str) -> SqliteResult<usize> {
    conn.execute(
        "DELETE FROM classification_cache WHERE note_path = ?1",
        params![note_path],
    )
}

/// Get the last recorded char_count for a note (for any skill)
/// Used for delta calculation in orchestrator
#[allow(dead_code)]
pub fn get_last_char_count(conn: &Connection, note_path: &str) -> SqliteResult<Option<usize>> {
    let result: Option<i64> = conn
        .query_row(
            "SELECT MAX(char_count) FROM ai_skill_state WHERE note_path = ?1 AND char_count > 0",
            params![note_path],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    Ok(result.map(|c| c as usize))
}

/// Get hash and char_count for delta comparison
/// Prefer _tracking record (always updated), fallback to any skill record
pub fn get_skill_state_for_delta(
    conn: &Connection,
    note_path: &str,
) -> SqliteResult<Option<(String, usize)>> {
    // First try _tracking record (guaranteed to be latest)
    let tracking_result = conn
        .query_row(
            "SELECT last_content_hash, char_count FROM ai_skill_state 
         WHERE note_path = ?1 AND skill_id = '_tracking' AND last_content_hash IS NOT NULL",
            params![note_path],
            |row| {
                let hash: String = row.get(0)?;
                let char_count: i64 = row.get(1)?;
                Ok((hash, char_count as usize))
            },
        )
        .optional()?;

    if tracking_result.is_some() {
        return Ok(tracking_result);
    }

    // Fallback to most recent skill record
    conn.query_row(
        "SELECT last_content_hash, char_count FROM ai_skill_state 
         WHERE note_path = ?1 AND last_content_hash IS NOT NULL 
         ORDER BY last_run_time DESC LIMIT 1",
        params![note_path],
        |row| {
            let hash: String = row.get(0)?;
            let char_count: i64 = row.get(1)?;
            Ok((hash, char_count as usize))
        },
    )
    .optional()
}

// ============================================================================
// AI FEEDBACK TAG/SUMMARY OPERATIONS
// (Accept/reject functions that combine DB updates + feedback logging)
// ============================================================================

/// Accept an AI tag: move from ai_tags to user_tags
/// - input_snapshot: Note content at time of AI processing (first 4k chars)
/// - model_name: Which model generated the tag
pub fn accept_ai_tag(
    conn: &Connection,
    note_path: &str,
    tag: &str,
    input_snapshot: Option<&str>,
    model_name: Option<&str>,
) -> SqliteResult<()> {
    // Get current tags
    let (ai_tags_json, user_tags_json): (Option<String>, Option<String>) = conn.query_row(
        "SELECT a.tags, n.user_tags FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
        params![note_path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // Parse JSON arrays
    let mut ai_tags: Vec<String> = ai_tags_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let mut user_tags: Vec<String> = user_tags_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // Move tag from AI to user
    ai_tags.retain(|t| t != tag);
    if !user_tags.contains(&tag.to_string()) {
        user_tags.push(tag.to_string());
    }

    // Update database
    conn.execute(
        "UPDATE notes SET user_tags = ?1, updated_at = unixepoch() WHERE path = ?2",
        params![
            serde_json::to_string(&user_tags).unwrap_or_default(),
            note_path
        ],
    )?;
    
    let updated = conn.execute(
        "UPDATE ai_metadata SET tags = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
        params![
            serde_json::to_string(&ai_tags).unwrap_or_default(),
            note_path
        ],
    )?;

    if updated == 0 {
        conn.execute(
            "INSERT INTO ai_metadata (note_id, tags) SELECT id, ?1 FROM notes WHERE path = ?2",
            params![
                serde_json::to_string(&ai_tags).unwrap_or_default(),
                note_path
            ],
        )?;
    }

    // Log feedback with complete training triplet
    insert_ai_feedback(
        conn,
        note_path,
        "tag_accept",
        input_snapshot,
        tag,
        None,
        model_name,
    )?;

    // BUG-D09: 更新 tag_dictionary 频率统计
    update_tag_dictionary(conn, tag)?;

    Ok(())
}

/// Reject an AI tag: remove from ai_tags
/// - input_snapshot: Note content at time of AI processing (first 4k chars)
/// - model_name: Which model generated the tag
pub fn reject_ai_tag(
    conn: &Connection,
    note_path: &str,
    tag: &str,
    input_snapshot: Option<&str>,
    model_name: Option<&str>,
) -> SqliteResult<()> {
    // Get current AI tags
    let ai_tags_json: Option<String> = conn.query_row(
        "SELECT a.tags FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
        params![note_path],
        |row| row.get(0),
    )?;

    // Parse and remove tag
    let mut ai_tags: Vec<String> = ai_tags_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    ai_tags.retain(|t| t != tag);

    // Update database
    conn.execute(
        "UPDATE notes SET updated_at = unixepoch() WHERE path = ?1",
        params![note_path],
    )?;

    let updated = conn.execute(
        "UPDATE ai_metadata SET tags = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
        params![
            serde_json::to_string(&ai_tags).unwrap_or_default(),
            note_path
        ],
    )?;

    if updated == 0 {
        conn.execute(
            "INSERT INTO ai_metadata (note_id, tags) SELECT id, ?1 FROM notes WHERE path = ?2",
            params![
                serde_json::to_string(&ai_tags).unwrap_or_default(),
                note_path
            ],
        )?;
    }

    // Log feedback with complete training triplet
    insert_ai_feedback(
        conn,
        note_path,
        "tag_reject",
        input_snapshot,
        tag,
        None,
        model_name,
    )?;

    Ok(())
}

/// Accept AI summary: copy to user_summary (optionally with edits)
/// - input_snapshot: Note content at time of AI processing (first 4k chars)
/// - model_name: Which model generated the summary
pub fn accept_ai_summary(
    conn: &Connection,
    note_path: &str,
    edited_summary: Option<&str>,
    input_snapshot: Option<&str>,
    model_name: Option<&str>,
) -> SqliteResult<()> {
    // Get current AI summary
    let ai_summary: Option<String> = conn.query_row(
        "SELECT a.summary FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
        params![note_path],
        |row| row.get(0),
    )?;

    let final_summary = edited_summary.map(|s| s.to_string()).or(ai_summary.clone());

    // Update user_summary
    conn.execute(
        "UPDATE notes SET user_summary = ?1, updated_at = unixepoch() WHERE path = ?2",
        params![final_summary, note_path],
    )?;

    // Log feedback with complete training triplet
    let feedback_type = if edited_summary.is_some() {
        "summary_edit"
    } else {
        "summary_accept"
    };
    insert_ai_feedback(
        conn,
        note_path,
        feedback_type,
        input_snapshot,
        ai_summary.as_deref().unwrap_or(""),
        edited_summary,
        model_name,
    )?;

    Ok(())
}

// ============================================================================
// TAG DICTIONARY
// ============================================================================

/// BUG-D09: Update tag_dictionary frequency statistics
/// Called when a tag is accepted (AI or manual) to track usage patterns
pub fn update_tag_dictionary(conn: &Connection, tag: &str) -> SqliteResult<()> {
    conn.execute(
        r#"INSERT INTO tag_dictionary (name, usage_count, created_at, updated_at)
           VALUES (?1, 1, unixepoch(), unixepoch())
           ON CONFLICT(name) DO UPDATE SET
               usage_count = usage_count + 1,
               updated_at = unixepoch()"#,
        params![tag],
    )?;
    Ok(())
}
