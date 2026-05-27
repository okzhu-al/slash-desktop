//! AI Skills - Trigger and Configuration
//!
//! Commands for triggering AI skill processing and managing skill configurations.

use std::path::Path;
use tauri::{Emitter, State};

use crate::{AIStateWrapper, DbStateWrapper};

// ============================================================================
// AI Skill Trigger
// ============================================================================

/// Trigger AI skill processing based on event type (NON-BLOCKING)
/// Spawns background task and returns immediately
/// trigger_type: "on_button" | "on_blur" | "on_idle"
#[tauri::command]
pub fn trigger_ai_skill(
    trigger_type: String,
    note_path: String,
    content: String,
    db_state: State<DbStateWrapper>,
    ai_state: State<AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use crate::core::ai::TriggerType;

    log::debug!(
        "🎯 [Rust] trigger_ai_skill CALLED: type={}, path_len={}",
        trigger_type,
        note_path.len()
    );

    // Parse trigger type
    let trigger = match trigger_type.as_str() {
        "on_button" => TriggerType::OnButton,
        "on_blur" => TriggerType::OnBlur,
        "on_idle" => TriggerType::OnIdle(5000),
        _ => return Err(format!("Unknown trigger type: {}", trigger_type)),
    };

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

    // Get DB path for background task
    let db_path = Path::new(&vault_path_str).join(".slash").join("slash.db");

    log::debug!(
        "🎯 [Rust] trigger_ai_skill: type={}, path={} (spawning background)",
        trigger_type, relative_path
    );

    // Clone for background task
    let mut service = ai_state.service().clone();
    let runtime = ai_state.runtime.clone();
    let app_handle_clone = app_handle.clone();

    // Spawn background task - returns immediately!
    std::thread::spawn(move || {
        runtime.block_on(async move {
            // Auto-detect and update model names
            match service.check_connection().await {
                Ok(status) => {
                    service.update_config(&status);
                    log::debug!(
                        "✅ [Rust] AI Config updated: gen={}, emb={}",
                        service.config().generation_model,
                        service.config().embedding_model
                    );
                }
                Err(e) => {
                    log::warn!(
                        "⚠️ [Rust] Failed to check Ollama connection: {}, using default config",
                        e
                    );
                }
            }

            // Determine what to run
            let should_tag = matches!(
                trigger,
                TriggerType::OnButton | TriggerType::OnBlur | TriggerType::OnIdle(_)
            );
            let should_summarize = matches!(
                trigger,
                TriggerType::OnButton | TriggerType::OnBlur | TriggerType::OnIdle(_)
            );
            // FIX: Enable embedding on idle so GhostLink can update without switching notes
            let should_embed = matches!(
                trigger,
                TriggerType::OnButton | TriggerType::OnBlur | TriggerType::OnIdle(_)
            );

            // Run AI generation
            let tags = if should_tag {
                // RAG: Get existing tags for consistency
                let existing_tags = if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    crate::core::db::repository::get_existing_tags_with_frequency(&conn, 100)
                        .ok()
                        .map(|v| v.into_iter().map(|(tag, _)| tag).collect())
                        .unwrap_or_default()
                } else {
                    vec![]
                };

                let res = if existing_tags.is_empty() {
                    service.generate_tags(&content).await
                } else {
                    service
                        .generate_tags_with_existing(&content, existing_tags)
                        .await
                };

                match res {
                    Ok(t) => Some(t),
                    Err(e) => {
                        log::warn!("❌ [Rust] generate_tags failed: {}", e);
                        None
                    }
                }
            } else {
                None
            };

            let summary = if should_summarize {
                match service.generate_summary(&content).await {
                    Ok(s) => Some(s),
                    Err(e) => {
                        log::warn!("❌ [Rust] generate_summary failed: {}", e);
                        None
                    }
                }
            } else {
                None
            };

            // ── OPT-06 Phase 6: 多媒体语义织网（统一走缓存管道）──
            // 调用缓存版 enrich_with_media，命中缓存=0 Sidecar 调用
            let enriched_content: String = {
                use crate::core::embedding::enrich_with_media;
                
                let vault_path = std::path::Path::new(&vault_path_str);
                // skills 路径不传 conn，避免 Mutex 借用冲突；缓存由 MediaScheduler 统一管理
                // 由于解耦了 Vision LLM 配置，Skill 运行期间遇到未解析媒体时一律走 Cache-Only 模式
                enrich_with_media(
                    &content,
                    Some(vault_path),
                    None,
                    None::<&rusqlite::Connection>,
                ).await
            };

            let embedding = if should_embed {
                match service.generate_embedding(&enriched_content).await {
                    Ok(e) => Some(e),
                    Err(e) => {
                        log::warn!("❌ [Rust] generate_embedding failed: {}", e);
                        None
                    }
                }
            } else {
                None
            };

            log::debug!(
                "🤖 [Rust] AI generation complete: tags={:?}, summary_len={:?}, embed_dims={:?}",
                tags.as_ref().map(|t| t.len()),
                summary.as_ref().map(|s| s.len()),
                embedding.as_ref().map(|e| e.len())
            );

            // Update DB in a separate connection
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Some(ref t) = tags {
                    let tags_json = serde_json::to_string(t).unwrap_or_default();
                    let affected = conn.execute(
                        "UPDATE ai_metadata SET tags = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
                        rusqlite::params![tags_json, relative_path],
                    ).unwrap_or(0);
                    if affected == 0 {
                        let _ = conn.execute(
                            "INSERT INTO ai_metadata (note_id, tags) SELECT id, ?1 FROM notes WHERE path = ?2",
                            rusqlite::params![tags_json, relative_path],
                        );
                    }
                }

                if let Some(ref s) = summary {
                    let affected = conn.execute(
                        "UPDATE ai_metadata SET summary = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
                        rusqlite::params![s, relative_path],
                    ).unwrap_or(0);
                    if affected == 0 {
                        let _ = conn.execute(
                            "INSERT INTO ai_metadata (note_id, summary) SELECT id, ?1 FROM notes WHERE path = ?2",
                            rusqlite::params![s, relative_path],
                        );
                    }
                }

                if let Some(ref e) = embedding {
                    let model = service.config().embedding_model.clone();
                    if crate::core::db::repository::upsert_embedding(
                        &conn,
                        &relative_path,
                        e,
                        &model,
                    )
                    .is_ok()
                    {
                        let _ = conn.execute(
                            "UPDATE notes SET is_embedded = 1 WHERE path = ?1",
                            rusqlite::params![relative_path],
                        );
                    }
                }

                log::debug!("✅ [Rust] AI data saved for: {}", relative_path);

                // Emit event to notify frontend to refresh
                let _ = app_handle_clone.emit(
                    "ai:note-updated",
                    serde_json::json!({
                        "path": relative_path,
                        "status": "done"
                    }),
                );
            }
        });
    });

    // Return immediately - AI runs in background
    Ok("AI processing started in background".to_string())
}

// ============================================================================
// AI Skill Configuration
// ============================================================================

/// Get all AI skill configurations
#[tauri::command]
pub fn get_ai_skill_configs(
    db_state: State<DbStateWrapper>,
) -> Result<Vec<crate::core::db::repository::SkillConfigRow>, String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::load_skill_configs(conn))
}

/// Update AI skill configuration
#[tauri::command]
pub fn update_ai_skill_config(
    config: crate::core::db::repository::SkillConfigRow,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    db_state
        .0
        .with_connection(|conn| crate::core::db::repository::upsert_skill_config(conn, &config))
}
