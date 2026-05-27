//! AI Service Commands
//!
//! Commands for AI service status, configuration, and batch processing.

use std::path::Path;
use tauri::{Emitter, State};
use serde::{Deserialize, Serialize};

use crate::{AIStateWrapper, DbStateWrapper};

// ============================================================================
// Types (migrated from deprecated core::ai::scheduler)
// ============================================================================

/// Progress event for AI processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProgressEvent {
    pub path: String,
    pub status: String, // "processing", "done", "error"
    pub message: Option<String>,
}

/// Result of processing a single note
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub path: String,
    pub success: bool,
    pub tags: Option<Vec<String>>,
    pub summary: Option<String>,
    pub error: Option<String>,
}

// ============================================================================
// Connection and Configuration
// ============================================================================

#[tauri::command]
pub async fn check_ai_connection(ai_state: State<'_, AIStateWrapper>) -> Result<crate::core::ai::ModelStatus, String> {
    let service = ai_state.service().clone();
    service.check_connection().await
}

#[tauri::command]
pub async fn check_effective_ai_connection(
    note_path: String,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
) -> Result<crate::core::ai::ModelStatus, String> {
    let global_config = ai_state.service().config().clone();
    
    if note_path.is_empty() {
        let service = ai_state.service().clone();
        return service.check_connection().await;
    }

    let vault_path_opt = db_state.0.vault_path.lock().unwrap().clone();
    let vault_path = match vault_path_opt {
        Some(vp) => vp,
        None => {
            let service = ai_state.service().clone();
            return service.check_connection().await;
        }
    };

    let effective = crate::core::ai::folder_config::resolve_config_for_path(
        &vault_path,
        &note_path,
        &global_config,
    );

    // Explicitly fail if it's meant to be online but credentials/baseUrl are missing
    if effective.provider_type == "online" && (effective.online_api_key.is_empty() || effective.online_base_url.is_empty()) {
        return Ok(crate::core::ai::ModelStatus {
            generation_model_available: false,
            embedding_model_available: false,
            generation_model_name: String::new(),
            embedding_model_name: String::new(),
        });
    }

    // Otherwise, create a temporary service instance to verify the specific configuration
    let transient_service = crate::core::ai::service::AIService::with_config(effective);
    transient_service.check_connection().await
}

#[tauri::command]
pub fn get_ai_config(ai_state: State<AIStateWrapper>) -> crate::core::ai::AIConfig {
    ai_state.service().config().clone()
}

/// 返回指定笔记路径的有效 provider_type（考虑目录级 .slash-folder.yml 覆盖）
#[tauri::command]
pub fn get_effective_provider_type(
    note_path: String,
    db_state: State<DbStateWrapper>,
    ai_state: State<AIStateWrapper>,
) -> String {
    let global_config = ai_state.service().config().clone();

    if note_path.is_empty() {
        return global_config.provider_type.clone();
    }

    let vault_path_opt = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone();

    let vault_path = match vault_path_opt {
        Some(vp) => vp,
        None => return global_config.provider_type.clone(),
    };

    let effective = crate::core::ai::folder_config::resolve_config_for_path(
        &vault_path,
        &note_path,
        &global_config,
    );
    effective.provider_type
}

// ============================================================================
// Single Note Processing
// ============================================================================

/// Process a single note with AI to generate tags and summary
#[tauri::command]
pub fn process_single_note(
    note_path: String,
    db_state: State<DbStateWrapper>,
    ai_state: State<AIStateWrapper>,
) -> Result<ProcessingResult, String> {
    log::debug!(
        "✨ [Rust] process_single_note called with note_path: {}",
        note_path
    );

    // Get vault path
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;
    log::debug!("✨ [Rust] vault_path: {:?}", vault_path_str);


    // Convert absolute path to relative path for DB operations
    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());
    log::debug!("✨ [Rust] relative_path: {}", relative_path);

    // Read file content - note_path is already absolute
    let file_path = Path::new(&note_path);
    log::debug!("✨ [Rust] Reading file: {}", file_path.display());
    let content =
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;
    log::debug!("✨ [Rust] Content length: {} chars", content.len());

    // Skip very short content
    if content.trim().len() < 50 {
        log::debug!("✨ [Rust] Content too short, skipping AI");
        return Ok(ProcessingResult {
            path: note_path.clone(),
            success: true,
            tags: Some(vec![]),
            summary: Some("Content too short for AI processing".to_string()),
            error: None,
        });
    }

    // Clone service for use in block_on
    let service = ai_state.service().clone();

    // Run AI processing synchronously (user is waiting for result)
    log::debug!("✨ [Rust] Starting AI generation...");
    let (tags, summary) = ai_state.runtime.block_on(async move {
        log::debug!("✨ [Rust] Generating tags...");
        let tags = service.generate_tags(&content).await.unwrap_or_default();
        log::debug!("✨ [Rust] Tags generated: {:?}", tags);
        log::debug!("✨ [Rust] Generating summary...");
        let summary = service.generate_summary(&content).await.unwrap_or_default();
        log::debug!("✨ [Rust] Summary generated: {}", summary);
        (tags, summary)
    });

    // Update database
    log::debug!("✨ [Rust] Updating database...");
    let ai_tags_json = serde_json::to_string(&tags).unwrap_or_default();
    db_state.0.with_connection(|conn| {
        // First update the notes metadata like timestamps
        conn.execute(
            "UPDATE notes SET last_processed_at = unixepoch(), updated_at = unixepoch() WHERE path = ?1",
            rusqlite::params![&relative_path],
        )?;
        
        // Then upsert tags and summary into ai_metadata side-table
        let affected = conn.execute(
            "UPDATE ai_metadata SET tags = ?1, summary = ?2 WHERE note_id = (SELECT id FROM notes WHERE path = ?3)",
            rusqlite::params![ai_tags_json, summary, &relative_path],
        )?;
        if affected == 0 {
            conn.execute(
                "INSERT INTO ai_metadata (note_id, tags, summary) SELECT id, ?1, ?2 FROM notes WHERE path = ?3",
                rusqlite::params![ai_tags_json, summary, &relative_path],
            )?;
        }
        Ok(())
    })?;

    log::debug!("✨ [Rust] process_single_note completed successfully!");
    Ok(ProcessingResult {
        path: note_path,
        success: true,
        tags: Some(tags),
        summary: Some(summary),
        error: None,
    })
}

// ============================================================================
// Batch Processing
// ============================================================================

/// Process dirty notes with AI in background (non-blocking)
/// Results are emitted via 'ai:progress' events instead of being returned synchronously
#[tauri::command]
pub async fn process_dirty_notes_batch(
    vault_path: String,
    batch_size: Option<usize>,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let limit = batch_size.unwrap_or(5);

    // Get dirty notes (quick synchronous operation)
    let notes = db_state
        .0
        .with_connection(|conn| crate::core::db::repository::get_dirty_notes(conn))?;

    // Take only batch_size notes
    let to_process: Vec<_> = notes.into_iter().take(limit).collect();

    if to_process.is_empty() {
        return Ok(());
    }

    // Clone what we need for the spawned task
    let service = ai_state.service().clone();
    let vault_path_owned = vault_path.clone();

    // Spawn background task - returns immediately without blocking
    tokio::spawn(async move {
        for note in to_process {
            let note_id = note.id.unwrap_or(0);
            let note_path = note.path.clone();

            // Emit progress event
            let _ = app_handle.emit(
                "ai:progress",
                AIProgressEvent {
                    path: note_path.clone(),
                    status: "processing".to_string(),
                    message: None,
                },
            );

            // Read file content
            let file_path = Path::new(&vault_path_owned).join(&note_path);
            let content = match std::fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(e) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "error".to_string(),
                            message: Some(format!("Failed to read file: {}", e)),
                        },
                    );
                    continue;
                }
            };

            // Skip very short content
            if content.trim().len() < 50 {
                let _ = app_handle.emit(
                    "ai:progress",
                    AIProgressEvent {
                        path: note_path,
                        status: "done".to_string(),
                        message: Some("Content too short".to_string()),
                    },
                );
                continue;
            }

            // Generate tags and summary using AI (truly async now)
            let tags_result = service.generate_tags(&content).await;
            let tags = match tags_result {
                Ok(t) => t,
                Err(e) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "error".to_string(),
                            message: Some(format!("Tag generation failed: {}", e)),
                        },
                    );
                    continue;
                }
            };

            let summary_result = service.generate_summary(&content).await;
            let summary = match summary_result {
                Ok(s) => s,
                Err(e) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "error".to_string(),
                            message: Some(format!("Summary generation failed: {}", e)),
                        },
                    );
                    continue;
                }
            };

            // Generate embedding for semantic search
            let embedding_result = service.generate_embedding(&content).await;
            let embedding = match embedding_result {
                Ok(e) => Some(e),
                Err(e) => {
                    log::warn!("⚠️ Embedding generation failed for {}: {}", note_path, e);
                    None // Continue without embedding, tags/summary are still valuable
                }
            };

            // Update database - open a dedicated connection for this background task
            let ai_tags_json = serde_json::to_string(&tags).unwrap_or_default();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            // Open a new DB connection for the background task
            let db_path = Path::new(&vault_path_owned).join(".slash").join("slash.db");
            let note_path_for_embedding = note_path.clone();
            let embedding_model = service.config().embedding_model.clone();
            let db_update_result = tokio::task::spawn_blocking(move || {
                let conn = rusqlite::Connection::open(&db_path)
                    .map_err(|e| format!("Failed to open DB: {}", e))?;
                
                // Store embedding if generated successfully
                let is_embedded = if let Some(ref emb) = embedding {
                    crate::core::db::repository::upsert_embedding(
                        &conn,
                        &note_path_for_embedding,
                        emb,
                        &embedding_model,
                    ).map_err(|e| format!("Embedding insert failed: {}", e))?;
                    1
                } else {
                    0
                };
                
                conn.execute(
                    "UPDATE notes SET is_embedded = ?1, last_processed_at = ?2 WHERE id = ?3",
                    rusqlite::params![is_embedded, now, note_id],
                ).map_err(|e| format!("DB root update failed: {}", e))?;
                
                let affected = conn.execute(
                    "UPDATE ai_metadata SET summary = ?1, tags = ?2 WHERE note_id = ?3",
                    rusqlite::params![summary, ai_tags_json, note_id],
                ).map_err(|e| format!("DB ai_metadata update failed: {}", e))?;
                if affected == 0 {
                    conn.execute(
                        "INSERT INTO ai_metadata (note_id, summary, tags) VALUES (?1, ?2, ?3)",
                        rusqlite::params![note_id, summary, ai_tags_json],
                    ).map_err(|e| format!("DB ai_metadata insert failed: {}", e))?;
                }
                
                Ok::<_, String>(())
            })
            .await;

            match db_update_result {
                Ok(Ok(_)) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "done".to_string(),
                            message: None,
                        },
                    );
                }
                Ok(Err(e)) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "error".to_string(),
                            message: Some(e),
                        },
                    );
                }
                Err(e) => {
                    let _ = app_handle.emit(
                        "ai:progress",
                        AIProgressEvent {
                            path: note_path,
                            status: "error".to_string(),
                            message: Some(format!("Task panicked: {:?}", e)),
                        },
                    );
                }
            }
        }

        // Emit completion event
        let _ = app_handle.emit("ai:batch-complete", serde_json::json!({ "status": "done" }));
    });

    // Return immediately - AI processing continues in background
    Ok(())
}

// ============================================================================
// Dirty Notes Count
// ============================================================================

#[tauri::command]
pub fn get_dirty_notes_count(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let notes = crate::core::db::repository::get_dirty_notes(conn)?;
        Ok(notes.len())
    })
}
