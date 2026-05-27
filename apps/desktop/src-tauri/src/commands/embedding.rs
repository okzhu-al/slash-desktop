//! Embedding Tauri Commands
//!
//! Exposes embedding pipeline operations to the frontend:
//! - Statistics and status
//! - Manual rebuild triggers
//! - Pause/resume
//! - Cache management
//! - Actual embedding generation

use crate::core::ai::service::AIService;
use crate::core::embedding::{EmbeddingPipeline, EmbeddingStats, PipelineConfig, VersionManager};
use crate::state::DbStateWrapper;
use rusqlite::Error as SqlError;
use std::sync::Arc;
use tauri::State;

/// Get embedding pipeline statistics
#[tauri::command]
pub fn get_embedding_stats(db_state: State<DbStateWrapper>) -> Result<EmbeddingStats, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.get_stats(conn).map_err(|_e| SqlError::InvalidQuery)
    })
}

/// Check if embeddings need rebuild (version mismatch)
#[tauri::command]
pub fn check_embedding_version_mismatch(db_state: State<DbStateWrapper>) -> Result<bool, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.has_version_mismatch(conn)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Trigger rebuild for outdated embeddings
#[tauri::command]
pub fn trigger_embedding_rebuild(
    db_state: State<DbStateWrapper>,
    batch_size: Option<usize>,
) -> Result<usize, String> {
    let batch = batch_size.unwrap_or(100);
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.mark_for_rebuild(conn, batch)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Trigger rebuild for a specific note
#[tauri::command]
pub fn trigger_note_embedding_rebuild(
    db_state: State<DbStateWrapper>,
    note_path: String,
) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.mark_note_for_rebuild(&note_path, conn)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Pause embedding pipeline (convert processing to pending)
#[tauri::command]
pub fn pause_embedding_pipeline(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.pause_processing(conn)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Clear all embedding cache
#[tauri::command]
pub fn clear_embedding_cache(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.clear_all(conn).map_err(|_| SqlError::InvalidQuery)
    })
}

/// Clear embeddings for a specific note
#[tauri::command]
pub fn clear_note_embeddings(
    db_state: State<DbStateWrapper>,
    note_path: String,
) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.clear_note(&note_path, conn)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Retry failed embeddings (reset to pending)
#[tauri::command]
pub fn retry_failed_embeddings(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.retry_failed(conn).map_err(|_| SqlError::InvalidQuery)
    })
}

/// Clean abandoned embeddings
#[tauri::command]
pub fn clean_abandoned_embeddings(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.clean_abandoned(conn).map_err(|_| SqlError::InvalidQuery)
    })
}

/// Rebuild all embeddings for all notes in the vault
/// This resets existing embeddings and creates pending records for unindexed notes
#[tauri::command]
pub fn rebuild_all_embeddings(db_state: State<DbStateWrapper>) -> Result<usize, String> {
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.rebuild_all(conn).map_err(|_| SqlError::InvalidQuery)
    })
}

/// Get notes that need embedding rebuild (paginated)
#[tauri::command]
pub fn get_notes_needing_rebuild(
    db_state: State<DbStateWrapper>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<String>, String> {
    let limit_val = limit.unwrap_or(50);
    let offset_val = offset.unwrap_or(0);
    db_state.0.with_connection(|conn| {
        let vm = VersionManager::new(PipelineConfig::default());
        vm.get_notes_needing_rebuild(conn, limit_val, offset_val)
            .map_err(|_| SqlError::InvalidQuery)
    })
}

/// Process embedding for a specific note (generates actual vector)
///
/// This is the main entry point for embedding generation.
/// It reads the note content, creates chunks, and generates embeddings via Ollama.
#[tauri::command]
pub async fn process_note_embedding(
    db_state: State<'_, DbStateWrapper>,
    note_path: String,
    content: String,
) -> Result<bool, String> {
    // Create AIService and Pipeline outside the closure (they are Send)
    let ai_service = Arc::new(AIService::new());
    let pipeline = EmbeddingPipeline::new(ai_service);

    // Process embedding - use spawn_blocking for the DB + async work
    let result = db_state.0.with_connection(|conn| {
        // We're in a sync context but need to call async code
        // Use futures::executor::block_on for simple cases
        let rt =
            tokio::runtime::Handle::try_current().map_err(|_| rusqlite::Error::InvalidQuery)?;

        rt.block_on(async {
            pipeline
                .process_note_profile(&note_path, &content, conn)
                .await
                .map_err(|_| rusqlite::Error::InvalidQuery)
        })
    });

    result
}

/// Start the background embedding worker
/// Should be called after DB and vault are initialized
#[tauri::command]
pub fn start_embedding_worker(
    vault_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use crate::core::db::DbState;
    use crate::core::embedding::worker::{start_background_processor, WorkerConfig};
    use crate::AIStateWrapper;
    use std::path::Path;
    use tauri::Manager;

    let vault = std::path::PathBuf::from(&vault_path);
    let db_path = DbState::db_path(Path::new(&vault_path));

    // 从共享 AIStateWrapper 获取用户实际配置的服务实例
    let ai_state = app_handle.state::<AIStateWrapper>();
    let ai_service = Arc::new(ai_state.service().clone());

    // Create tokio runtime for async operations
    let runtime = Arc::new(
        tokio::runtime::Runtime::new().map_err(|e| format!("Failed to create runtime: {}", e))?,
    );

    // Start the worker
    start_background_processor(
        app_handle,
        ai_service,
        runtime,
        db_path,
        vault,
        WorkerConfig::default(),
    );

    Ok("Embedding worker started".to_string())
}

/// Progress event payload for embedding rebuild
#[derive(Clone, serde::Serialize)]
pub struct RebuildProgress {
    pub current: usize,
    pub total: usize,
    pub current_note: String,
    pub status: String, // "processing" | "completed" | "error"
}

/// Process all embeddings immediately (sync mode for manual rebuild)
/// This bypasses the 30-second worker interval for immediate processing
#[tauri::command]
pub fn process_all_embeddings(
    app_handle: tauri::AppHandle,
    vault_path: String,
) -> Result<String, String> {
    use crate::core::db::DbState;
    use crate::core::embedding::chunker::{chunk_document, ChunkingConfig};
    use crate::core::embedding::denoise::content_hash;
    use crate::core::embedding::PipelineConfig;
    use rusqlite::params;
    use std::path::Path;
    use tauri::Emitter;

    // Spawn a dedicated thread for processing (to avoid Send issues)
    std::thread::spawn(move || {
        log::error!("🚀 [Rebuild] Starting immediate full rebuild...");

        let vault = std::path::PathBuf::from(&vault_path);
        let db_path = DbState::db_path(Path::new(&vault_path));

        // Open connection
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("❌ [Rebuild] Failed to open DB: {}", e);
                return;
            }
        };

        // Clear existing embeddings
        let _ = conn.execute("DELETE FROM embeddings_v2", []);

        // Get all note paths
        let note_paths: Vec<String> = match conn.prepare("SELECT path FROM notes") {
            Ok(mut stmt) => stmt
                .query_map([], |row| row.get(0))
                .map(|iter| iter.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        let total = note_paths.len();
        log::info!("📝 [Rebuild] Found {} notes to process", total);

        if total == 0 {
            let _ = app_handle.emit(
                "embedding:rebuild-progress",
                RebuildProgress {
                    current: 0,
                    total: 0,
                    current_note: "".to_string(),
                    status: "completed".to_string(),
                },
            );
            return;
        }

        // Emit initial progress
        let _ = app_handle.emit(
            "embedding:rebuild-progress",
            RebuildProgress {
                current: 0,
                total,
                current_note: "Starting...".to_string(),
                status: "processing".to_string(),
            },
        );

        // Create AI service and pipeline
        let ai_service = Arc::new(AIService::new());
        let pipeline = EmbeddingPipeline::new(ai_service);
        let chunking_config = ChunkingConfig::default();
        let pipeline_config = PipelineConfig::default();

        // Create runtime for async operations
        let rt = match tokio::runtime::Runtime::new() {
            Ok(r) => r,
            Err(e) => {
                log::error!("❌ [Rebuild] Failed to create runtime: {}", e);
                return;
            }
        };

        let mut processed = 0;

        // Process each note
        for (index, note_path) in note_paths.iter().enumerate() {
            // Emit progress
            let _ = app_handle.emit(
                "embedding:rebuild-progress",
                RebuildProgress {
                    current: index,
                    total,
                    current_note: note_path.clone(),
                    status: "processing".to_string(),
                },
            );

            // Read note file
            let full_path = vault.join(note_path);
            let content = match std::fs::read_to_string(&full_path) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("⚠️ [Rebuild] Failed to read {}: {}", note_path, e);
                    continue;
                }
            };

            // Chunk the content
            let chunk_result = chunk_document(&content, &chunking_config);
            if chunk_result.chunks.is_empty() {
                continue;
            }

            // Create pending records
            for chunk in &chunk_result.chunks {
                let hash = content_hash(&chunk.content);
                let _ = conn.execute(
                    r#"
                    INSERT OR REPLACE INTO embeddings_v2 
                        (note_path, product_type, chunk_id, content_hash, embedding,
                         model_version, pipeline_version, status, priority, heartbeat_at)
                    VALUES (?1, 'paragraph', ?2, ?3, X'', ?4, ?5, 'pending', 10, unixepoch())
                    "#,
                    params![
                        note_path,
                        &chunk.chunk_id,
                        &hash,
                        &pipeline_config.model_name,
                        pipeline_config.pipeline_version,
                    ],
                );
            }

            // Process embeddings for this note immediately
            let result = rt.block_on(async {
                pipeline
                    .process_pending_paragraphs_with_vault(&conn, &vault, chunk_result.chunks.len())
                    .await
            });

            match result {
                Ok((p, _f, _s)) => {
                    processed += p;
                    log::error!(
                        "✅ [Rebuild] {}/{} - {} ({} chunks)",
                        index + 1,
                        total,
                        note_path,
                        p
                    );
                }
                Err(e) => {
                    log::error!("❌ [Rebuild] Failed to process {}: {}", note_path, e);
                }
            }
        }

        // Emit completion
        let _ = app_handle.emit(
            "embedding:rebuild-progress",
            RebuildProgress {
                current: total,
                total,
                current_note: "".to_string(),
                status: "completed".to_string(),
            },
        );

        log::info!("✅ [Rebuild] Complete: {} embeddings processed", processed);
    });

    Ok("Rebuild started".to_string())
}

// ── Phase 6: Media Embedding Commands ──

/// 获取等待媒体处理的笔记数量（用于底部状态栏显示）
#[tauri::command]
pub fn get_media_pending_count(
    vault_path: String,
    note_path: Option<String>,
    db_state: State<DbStateWrapper>
) -> Result<usize, String> {
    let rel_path = if let Some(np) = note_path {
        let vault = std::path::Path::new(&vault_path);
        let np_path = std::path::Path::new(&np);
        if let Ok(rel) = np_path.strip_prefix(vault) {
            Some(rel.to_string_lossy().replace("\\", "/"))
        } else {
            Some(np)
        }
    } else {
        None
    };

    db_state.0.with_connection(|conn| {
        Ok(crate::core::embedding::media_scheduler::get_media_pending_count(conn, rel_path.as_deref()))
    })
}

/// 获取指定笔记的详细媒体状态（总计、待处理、完成、失败）
#[tauri::command]
pub fn get_note_media_status(
    vault_path: String,
    note_path: String,
    db_state: State<DbStateWrapper>
) -> Result<Option<crate::core::embedding::media_scheduler::MediaStatusResult>, String> {
    let vault = std::path::Path::new(&vault_path);
    let np_path = std::path::Path::new(&note_path);
    let rel_path = if let Ok(rel) = np_path.strip_prefix(vault) {
        rel.to_string_lossy().replace("\\", "/")
    } else {
        note_path
    };

    db_state.0.with_connection(|conn| {
        Ok(crate::core::embedding::media_scheduler::get_note_media_status(conn, vault, &rel_path))
    })
}

/// 手动触发媒体 Embedding 处理
///
/// 前端点击「开始索引」时调用。
/// 在独立线程中顺序处理所有 media_pending 笔记。
#[tauri::command]
pub async fn trigger_media_embedding(
    vault_path: String,
    note_path: Option<String>,
    vision_base_url: Option<String>,
    vision_api_key: Option<String>,
    vision_model: Option<String>,
    force_reindex: Option<bool>,
    app_handle: tauri::AppHandle,
    lock: tauri::State<'_, crate::MediaEmbeddingLock>,
) -> Result<String, String> {
    let _guard = lock.0.lock().await;
    use crate::core::db::DbState;
    use crate::AIStateWrapper;
    use std::path::Path;
    use std::sync::Arc;
    use tauri::Manager;
    use crate::core::embedding::EmbeddingPipeline;

    let vault = std::path::PathBuf::from(&vault_path);
    let db_path = DbState::db_path(Path::new(&vault_path));

    let ai_state = app_handle.state::<AIStateWrapper>();
    let ai_service = Arc::new(ai_state.service().clone());
    let pipeline = EmbeddingPipeline::new(ai_service.clone());
    
    let rel_path = if let Some(np) = note_path {
        let np_path = std::path::Path::new(&np);
        if let Ok(rel) = np_path.strip_prefix(&vault) {
            Some(rel.to_string_lossy().replace("\\", "/"))
        } else {
            Some(np)
        }
    } else {
        None
    };
    let note_path_clone = rel_path.clone();

    let vision_config = if let (Some(base_url), Some(model)) = (vision_base_url, vision_model) {
        Some(crate::core::embedding::SidecarLlmConfig {
            base_url,
            api_key: vision_api_key.unwrap_or_default(),
            llm_model: model,
        })
    } else {
        None
    };

    // Use std::thread::spawn instead of spawn_blocking to avoid
    // "Cannot drop a runtime in a context where blocking is not allowed" panic.
    // A plain thread can safely create and drop tokio Runtimes.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();

    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<String, String> {
            let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("DB open failed: {}", e))?;
            let rt = tokio::runtime::Runtime::new().map_err(|e| format!("Runtime create failed: {}", e))?;

            // Handle force_reindex logic: Clear cache and reset status
            if force_reindex.unwrap_or(false) {
                if let Some(path) = &note_path_clone {
                    let file_path = vault.join(path);
                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                        if let Ok(media_regex) = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
                            let mut hashes_to_delete = Vec::new();
                            for cap in media_regex.captures_iter(&content) {
                                let asset_rel = &cap[1];
                                let asset_abs = vault.join(asset_rel);
                                let filename = asset_abs.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
                                let asset_hash = std::path::Path::new(filename).file_stem().and_then(|s| s.to_str()).unwrap_or(filename).to_string();
                                hashes_to_delete.push(asset_hash);
                            }
                            
                            if !hashes_to_delete.is_empty() {
                                for hash in hashes_to_delete {
                                    let _ = conn.execute("DELETE FROM media_enrich_cache WHERE asset_hash = ?1", rusqlite::params![hash]);
                                }
                            }
                        }
                    }
                    // Reset status so process_media_pending will pick it up
                    let _ = conn.execute("UPDATE embeddings_v2 SET status = 'media_pending' WHERE note_path = ?1", rusqlite::params![path]);
                }
            }

            let app_handle_clone = app_handle.clone();
            let sched_result = rt.block_on(async {
                crate::core::embedding::media_scheduler::process_media_pending(
                    &conn,
                    &vault,
                    &pipeline,
                    note_path_clone.as_deref(),
                    vision_config.as_ref(),
                    Some(app_handle_clone),
                )
                .await
            });

            log::error!(
                "📎 [MediaScheduler] Result: {}/{} processed, {} failed",
                sched_result.processed, sched_result.total, sched_result.failed
            );

            // Always try to vectorize pending records, regardless of whether
            // process_media_pending found new work. There may be leftover pending
            // records from a previous run that didn't complete vectorization.
            let _ = rt.block_on(async {
                pipeline.process_pending_paragraphs_with_vault(&conn, &vault, 50).await
            });
            log::error!("📎 [MediaScheduler] Vectorization complete.");

            Ok("Media embedding complete".to_string())
        }));
        
        let send_result = match result {
            Ok(inner) => inner,
            Err(panic_info) => {
                let msg = if let Some(s) = panic_info.downcast_ref::<String>() {
                    format!("Media embedding panicked: {}", s)
                } else if let Some(s) = panic_info.downcast_ref::<&str>() {
                    format!("Media embedding panicked: {}", s)
                } else {
                    "Media embedding panicked with unknown error".to_string()
                };
                log::error!("❌ [MediaScheduler] {}", msg);
                Err(msg)
            }
        };
        let _ = tx.send(send_result);
        // Runtime drops safely here on a plain thread
    });

    let result = rx.await.map_err(|_| "Media embedding thread panicked".to_string())??;
    Ok(result)
}

/// 立即对单篇笔记进行 embedding 调度（检测图片并挂起 media_pending）
#[tauri::command]
pub fn trigger_schedule_note(
    vault_path: String,
    note_path: String,
    db_state: tauri::State<'_, crate::DbStateWrapper>,
    ai_state: tauri::State<'_, crate::AIStateWrapper>,
) -> Result<(), String> {
    use std::sync::Arc;
    let vault = std::path::PathBuf::from(&vault_path);
    let ai_service = Arc::new(ai_state.service().clone());
    let pipeline = crate::core::embedding::EmbeddingPipeline::new(ai_service);
    let rt = Arc::new(tokio::runtime::Runtime::new().map_err(|e| e.to_string())?);

    db_state.0.with_connection(|conn| {
        let _ = crate::core::embedding::worker::schedule_note_for_embedding_public(
            conn, &vault, &note_path, &rt, &pipeline,
        );
        Ok(())
    })
}

/// 获取指定资产的 AI 提取文本（用于悬浮预览）
#[tauri::command]
pub fn get_enriched_content(
    db_state: State<DbStateWrapper>,
    asset_hash: String,
) -> Result<Option<String>, String> {
    db_state.0.with_connection(|conn| {
        Ok(crate::core::embedding::media_scheduler::get_enriched_content(conn, &asset_hash))
    })
}

/// Save extracted media text to cache directly (e.g. from ImportHub)
#[tauri::command]
pub fn save_media_enrich_cache(
    asset_hash: String,
    text: String,
    model_name: Option<String>,
    db_state: tauri::State<'_, crate::DbStateWrapper>,
) -> Result<(), String> {
    db_state.0.with_connection(|conn| {
        let actual_model = model_name.unwrap_or_else(|| "local_import".to_string());
        let char_count = text.len() as i64;
        conn.execute(
            r#"INSERT OR REPLACE INTO media_enrich_cache 
               (asset_hash, enriched_text, model_name, char_count, updated_at) 
               VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))"#,
            rusqlite::params![&asset_hash, &text, &actual_model, char_count],
        )?;
        Ok(())
    }).map_err(|e| e.to_string())
}
