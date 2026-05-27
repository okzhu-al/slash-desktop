//! WikiLink Relation Commands
//!
//! Infer semantic relationship between two notes when a WikiLink is created.
//! Uses the ReasoningSkill for single-pair analysis.

use tauri::{Emitter, State};

use crate::{AIStateWrapper, DbStateWrapper};

/// Infer the relation between two notes (triggered when user creates a WikiLink)
/// Submits to HeavyQueue and returns immediately.
#[tauri::command]
pub async fn infer_wikilink_relation(
    source_path: String,
    target_path: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!(
        "🔗 [WikiLinkRelation] Submitting to queue: {} -> {}",
        source_path, target_path
    );

    if let Some(queue) = ai_state.queue.get() {
        let _ = queue.submit_heavy(crate::core::ai::queue::HeavyJob::WikiLinkRelation {
            source_path: source_path.clone(),
            target_path: target_path.clone(),
        }).await;
        Ok(())
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_heavy_wikilink_relation(
    app_handle: tauri::AppHandle,
    source_path: String,
    target_path: String,
) {
    use tauri::Manager;
    use crate::core::ai::skills::reasoning::{build_pairwise_prompt, ReasoningSkill};
    use crate::core::db::repository::{get_cached_suggestion, upsert_suggestion_cache};

    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    // Get vault path for relative path conversion
    let vault_str = match db_state.0.vault_path.lock().unwrap().clone() {
        Some(v) => v.to_string_lossy().to_string(),
        None => {
            log::warn!("⚠️ [WikiLinkRelation] Vault path not set");
            return;
        }
    };

    let relative_source = if source_path.starts_with(&vault_str) {
        source_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        source_path.clone()
    };

    let relative_target = if target_path.starts_with(&vault_str) {
        target_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        target_path.clone()
    };

    // Build provider_key for cache isolation
    let provider_key = {
        let svc = ai_state.service();
        let cfg = svc.config();
        let model = if cfg.provider_type == "online" {
            &cfg.online_model
        } else {
            &cfg.generation_model
        };
        format!("{}|{}", cfg.provider_type, model)
    };

    // Strip #section anchor for note lookup (e.g. "第二大脑#第一部分" → "第二大脑")
    let target_note_name = relative_target
        .split('#')
        .next()
        .unwrap_or(&relative_target)
        .to_string();

    // Get note summaries and mtimes from database
    let db_result = db_state.0.with_connection(|conn| {
        let (st, ss, sm): (String, String, i64) = conn
            .query_row(
                "SELECT n.title, COALESCE(n.user_summary, a.summary, ''), n.mtime FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                rusqlite::params![&relative_source],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or(("".to_string(), "".to_string(), 0));

        // target_path from frontend may include #section anchor
        // Use target_note_name (stripped) for title/path lookup
        let (tt, ts, tm): (String, String, i64) = conn
            .query_row(
                "SELECT n.title, COALESCE(n.user_summary, a.summary, ''), n.mtime FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE LOWER(n.title) = LOWER(?1)",
                rusqlite::params![&target_note_name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .or_else(|_| {
                conn.query_row(
                    "SELECT n.title, COALESCE(n.user_summary, a.summary, ''), n.mtime FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                    rusqlite::params![&target_note_name],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap_or(("".to_string(), "".to_string(), 0));

        Ok((st, ss, sm, tt, ts, tm))
    });

    // Check if the relation is already explicitly defined in the `links` table first
    let explicit_relation: Option<String> = db_state.0.with_connection(|conn| {
        use rusqlite::OptionalExtension;
        let pattern = format!("%{}%", target_note_name);
        conn.query_row(
            "SELECT label FROM links WHERE source_path = ?1 AND target_anchor LIKE ?2 AND label IS NOT NULL AND label != '' LIMIT 1",
            rusqlite::params![&relative_source, &pattern],
            |row| row.get(0),
        ).optional()
    }).unwrap_or(None);

    if let Some(label) = explicit_relation {
        log::debug!(
            "✅ [WikiLinkRelation] Explicit Label HIT: {} -> {}: {}",
            relative_source, relative_target, label
        );
        let _ = app_handle.emit(
            "wikilink-relation-result",
            serde_json::json!({
                "source_path": source_path,
                "target_path": target_path,
                "relation": label,
                "reason": "explicit",
                "from_cache": true
            }),
        );
        return;
    }

    let (source_title, source_summary, source_mtime, target_title, target_summary, target_mtime) = match db_result {
        Ok(vals) => vals,
        Err(e) => {
            log::warn!("⚠️ [WikiLinkRelation] DB error: {}", e);
            return;
        }
    };

    // Skip if either summary is empty
    if source_summary.trim().is_empty() || target_summary.trim().is_empty() {
        log::debug!("⏭️ [WikiLinkRelation] Skipping - summary empty");
        let _ = app_handle.emit(
            "wikilink-relation-result",
            serde_json::json!({
                "source_path": source_path,
                "target_path": target_path,
                "relation": "related",
                "reason": "",
                "from_cache": false
            }),
        );
        return;
    }

    // Check cache first
    let cached = db_state.0.with_connection(|conn| {
        get_cached_suggestion(
            conn,
            &relative_source,
            &relative_target,
            source_mtime,
            target_mtime,
            &provider_key,
        )
    });

    if let Ok(Some((relation, reason))) = cached {
        log::debug!(
            "✅ [WikiLinkRelation] Cache HIT: {} -> {}: {}",
            relative_source, relative_target, relation
        );
        let _ = app_handle.emit(
            "wikilink-relation-result",
            serde_json::json!({
                "source_path": source_path,
                "target_path": target_path,
                "relation": relation,
                "reason": reason,
                "from_cache": true
            }),
        );
        return;
    }

    // Build prompt for single-pair reasoning
    let prompt_content = build_pairwise_prompt(
        &source_title,
        &source_summary,
        &target_title,
        &target_summary,
    );

    let service = ai_state.resolve_for_path(std::path::Path::new(&vault_str), &relative_source);
    
    log::debug!("🧠 [WikiLinkRelation] Starting LLM call in worker...");
    let start_time = std::time::Instant::now();
    
    let llm_result = service
        .execute_skill(&ReasoningSkill, &prompt_content)
        .await;
        
    let elapsed = start_time.elapsed();
    log::debug!("🧠 [WikiLinkRelation] LLM call took {:?}", elapsed);

    match llm_result {
        Ok(results) => {
            let (relation, reason) = if let Some(first) = results.first() {
                (first.relation.clone(), first.reason.clone())
            } else {
                ("related".to_string(), "".to_string())
            };

            // Cache the result + update links.label
            let db_path = std::path::Path::new(&vault_str)
                .join(".slash")
                .join("slash.db");
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let _ = upsert_suggestion_cache(
                    &conn,
                    &relative_source,
                    &relative_target,
                    source_mtime,
                    target_mtime,
                    &relation,
                    &reason,
                    &provider_key,
                );
                log::debug!(
                    "💾 [WikiLinkRelation] Cached: {} -> {}: {}",
                    relative_source, relative_target, relation
                );

                // Directly update links.label — the sole authority for relation
                if !relation.is_empty() {
                    let target_anchor_pattern = format!("%{}%", target_title);
                    let updated = conn.execute(
                        "UPDATE links SET label = ?1 WHERE source_path = ?2 AND target_anchor LIKE ?3 AND (label IS NULL OR label = '')",
                        rusqlite::params![&relation, &relative_source, &target_anchor_pattern],
                    ).unwrap_or(0);
                    log::debug!(
                        "🔗 [WikiLinkRelation] Updated {} link(s) label: {} -> {} ({})",
                        updated, relative_source, target_title, relation
                    );
                }
            }

            // Write relation to source note's YAML frontmatter (file-level persistence)
            // Safe: scan_file auto-cleans orphaned YAML relations when WikiLink is deleted
            if !relation.is_empty() {
                let vault_path_obj = std::path::Path::new(&vault_str);
                if let Err(e) = crate::commands::ai::relations::update_note_with_relation(
                    &relative_source,
                    &relation,
                    &target_title,
                    vault_path_obj,
                ) {
                    log::warn!("⚠️ [WikiLinkRelation] Failed to write YAML: {}", e);
                }
            }

            let _ = app_handle.emit(
                "wikilink-relation-result",
                serde_json::json!({
                    "source_path": source_path,
                    "target_path": target_path,
                    "relation": relation,
                    "reason": reason,
                    "from_cache": false
                }),
            );
        }
        Err(e) => {
            log::warn!("⚠️ [WikiLinkRelation] LLM failed: {}", e);
            let _ = app_handle.emit(
                "wikilink-relation-result",
                serde_json::json!({
                    "source_path": source_path,
                    "target_path": target_path,
                    "relation": "related",
                    "reason": "",
                    "error": e.to_string()
                }),
            );
        }
    }
}
