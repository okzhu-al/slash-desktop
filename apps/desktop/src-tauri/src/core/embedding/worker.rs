//! Embedding Background Worker
//!
//! Provides background processing for the embedding pipeline.
//! Runs as a dedicated thread, processing pending jobs from embeddings_v2.

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::runtime::Runtime;

use crate::core::ai::service::AIService;
use crate::core::embedding::EmbeddingPipeline;

/// Background worker configuration
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Processing interval in seconds
    pub interval_secs: u64,
    /// Batch size per cycle
    pub batch_size: usize,
    /// Whether to emit status events
    pub emit_events: bool,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            interval_secs: 30, // Process every 30 seconds
            batch_size: 10,    // 10 jobs per batch
            emit_events: true,
        }
    }
}

/// Embedding worker status for frontend notifications
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkerStatus {
    pub is_running: bool,
    pub pending_count: usize,
    pub processed_count: usize,
    pub failed_count: usize,
    pub last_run_at: Option<i64>,
}

/// Start the background embedding processor
///
/// This function spawns a dedicated thread that periodically:
/// 1. Checks for pending jobs in embeddings_v2
/// 2. Processes them in batches using EmbeddingPipeline
/// 3. Emits status events to the frontend
pub fn start_background_processor(
    app_handle: AppHandle,
    ai_service: Arc<AIService>,
    runtime: Arc<Runtime>,
    db_path: std::path::PathBuf,
    vault_path: std::path::PathBuf,
    config: WorkerConfig,
) {
    std::thread::spawn(move || {
        log::info!("🚀 [EmbeddingWorker] Started");

        // 不再在启动时创建静态 pipeline，而是每个周期从 AIStateWrapper 获取最新配置
        let mut pipeline = EmbeddingPipeline::new(ai_service);
        pipeline.set_vault_path(vault_path.clone());

        loop {
            // Wait for interval
            std::thread::sleep(Duration::from_secs(config.interval_secs));

            // P3-1: 获取并发锁，防止与前台手动媒体索引同时写库/抢占侧车资源
            let lock = app_handle.try_state::<crate::MediaEmbeddingLock>();
            let _lock_guard = lock.as_ref().map(|l| l.0.blocking_lock());

            // 每个周期从 AIStateWrapper 获取最新模型配置
            {
                use tauri::Manager;
                if let Some(ai_state) = app_handle.try_state::<crate::AIStateWrapper>() {
                    let fresh_service = Arc::new(ai_state.service().clone());
                    pipeline = EmbeddingPipeline::new(fresh_service);
                    pipeline.set_vault_path(vault_path.clone());
                }
            }

            // Open DB connection
            let conn = match rusqlite::Connection::open(&db_path) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("❌ [EmbeddingWorker] Failed to open DB: {}", e);
                    continue;
                }
            };

            // Get pending count for status
            let pending_count = get_pending_count(&conn);

            // Discover unindexed notes (notes without any embeddings)
            // This ensures rebuild_all works correctly by queueing notes for processing
            let unindexed_notes = discover_unindexed_notes(&conn, config.batch_size);
            if !unindexed_notes.is_empty() {
                // unindexed_notes discovered, schedule silently

                // Read each note and schedule proper chunks
                for note_path in &unindexed_notes {
                    if let Err(e) = schedule_note_for_embedding(&conn, &vault_path, note_path, &runtime, &pipeline) {
                        log::error!(
                            "⚠️ [EmbeddingWorker] Failed to schedule {}: {}",
                            note_path, e
                        );
                    }
                }
            }

            // Re-check pending count after discovery
            let pending_count = if unindexed_notes.is_empty() {
                pending_count
            } else {
                get_pending_count(&conn)
            };

            if pending_count == 0 {
                // No work to do
                continue;
            }

            // Processing pending_count jobs (silent)

            // Track total results
            let mut total_processed = 0;
            let mut total_failed = 0;
            let mut total_skipped = 0;

            // Process pending paragraph jobs (P0)
            let paragraph_result = runtime.block_on(async {
                pipeline
                    .process_pending_paragraphs_with_vault(&conn, &vault_path, config.batch_size)
                    .await
            });

            match paragraph_result {
                Ok((p, f, s)) => {
                    total_processed += p;
                    total_failed += f;
                    total_skipped += s;
                }
                Err(e) => {
                    log::error!("❌ [EmbeddingWorker] Paragraph processing failed: {}", e);
                }
            }

            // Process pending NoteProfile jobs (P1)
            let profile_result = runtime.block_on(async {
                pipeline
                    .process_pending_note_profiles_with_vault(&conn, &vault_path, config.batch_size)
                    .await
            });

            match profile_result {
                Ok((p, f, s)) => {
                    total_processed += p;
                    total_failed += f;
                    total_skipped += s;
                }
                Err(e) => {
                    log::error!("❌ [EmbeddingWorker] NoteProfile processing failed: {}", e);
                }
            }

            // Process pending Summary jobs (P2)
            let summary_result = runtime.block_on(async {
                pipeline
                    .process_pending_summaries(&conn, config.batch_size)
                    .await
            });

            match summary_result {
                Ok((p, f, s)) => {
                    total_processed += p;
                    total_failed += f;
                    total_skipped += s;
                }
                Err(e) => {
                    log::error!("❌ [EmbeddingWorker] Summary processing failed: {}", e);
                }
            }

            log::debug!(
                "✅ [EmbeddingWorker] Cycle complete: {} processed, {} failed, {} skipped",
                total_processed, total_failed, total_skipped
            );

            // NOTE: GhostLink reasoning is manual-only — triggered by user via frontend button.
            // No automatic ghostlink processing after embedding.

            // Auto-retry failed items (reset failed status to pending after 5 minutes)
            let retry_result = conn.execute(
                r#"
                UPDATE embeddings_v2 
                SET status = 'pending', retry_count = COALESCE(retry_count, 0) + 1
                WHERE status = 'failed' 
                AND (retry_count IS NULL OR retry_count < 3)
                AND updated_at < strftime('%s', 'now') - 300
                "#,
                [],
            );
            if let Ok(retried) = retry_result {
                if retried > 0 {
                    log::debug!(
                        "🔄 [EmbeddingWorker] Auto-retrying {} failed items",
                        retried
                    );
                }
            }

            // Cleanup abandoned records (older than 10 minutes)
            let cleanup_result = conn.execute(
                r#"
                DELETE FROM embeddings_v2 
                WHERE status = 'abandoned' 
                AND updated_at < strftime('%s', 'now') - 600
                "#,
                [],
            );
            if let Ok(deleted) = cleanup_result {
                if deleted > 0 {
                    log::debug!(
                        "🧹 [EmbeddingWorker] Cleaned up {} abandoned records",
                        deleted
                    );
                }
            }

            // Delete permanently failed items (retry_count >= 3)
            let perm_fail_result = conn.execute(
                r#"
                DELETE FROM embeddings_v2 
                WHERE status = 'failed' AND retry_count >= 3
                "#,
                [],
            );
            if let Ok(deleted) = perm_fail_result {
                if deleted > 0 {
                    log::debug!(
                        "🗑️ [EmbeddingWorker] Removed {} permanently failed items",
                        deleted
                    );
                }
            }

            // Cleanup orphan embeddings (files that no longer exist in notes table)
            let orphan_result = conn.execute(
                r#"
                DELETE FROM embeddings_v2 
                WHERE note_path NOT IN (SELECT path FROM notes)
                "#,
                [],
            );
            if let Ok(deleted) = orphan_result {
                if deleted > 0 {
                    log::debug!(
                        "🧹 [EmbeddingWorker] Cleaned up {} orphan embeddings (deleted files)",
                        deleted
                    );
                }
            }

            // Emit status event
            if config.emit_events {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                let status = WorkerStatus {
                    is_running: true,
                    pending_count: pending_count
                        .saturating_sub(total_processed + total_failed + total_skipped),
                    processed_count: total_processed,
                    failed_count: total_failed,
                    last_run_at: Some(now),
                };

                let _ = app_handle.emit("embedding:worker-status", &status);
            }
        }
    });
}

/// Get the count of pending and retryable failed embedding jobs
fn get_pending_count(conn: &rusqlite::Connection) -> usize {
    conn.query_row(
        r#"SELECT COUNT(*) FROM embeddings_v2 
           WHERE status = 'pending' 
              OR (status = 'failed' AND retry_count < 10)"#,
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
}

/// Find notes that have no embeddings at all (unindexed)
fn discover_unindexed_notes(conn: &rusqlite::Connection, limit: usize) -> Vec<String> {
    let result = conn.prepare(
        r#"
        SELECT n.path 
        FROM notes n 
        WHERE n.path NOT IN (SELECT DISTINCT note_path FROM embeddings_v2)
        LIMIT ?1
        "#,
    );

    match result {
        Ok(mut stmt) => stmt
            .query_map([limit as i64], |row| row.get(0))
            .map(|iter| iter.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Schedule a note for embedding by reading it and creating proper chunks
///
/// Phase 6 改造：
/// - 检测媒体引用 → 查 media_enrich_cache
/// - 全部命中 → 用缓存文本 enrich 后正常分块 → status='pending'
/// - 有未命中 → 不调 Sidecar，标记 status='media_pending'，等用户手动触发
fn schedule_note_for_embedding(
    conn: &rusqlite::Connection,
    vault_path: &std::path::Path,
    note_path: &str,
    runtime: &Arc<Runtime>,
    _pipeline: &EmbeddingPipeline,
) -> Result<(), String> {
    use crate::core::embedding::chunker::{chunk_document, ChunkingConfig};
    use crate::core::embedding::denoise::content_hash;
    use crate::core::embedding::pipeline::{has_media_references, all_media_cached, enrich_with_media};
    use crate::core::embedding::types::PipelineConfig;
    use rusqlite::params;

    // Read the note file
    let full_path = vault_path.join(note_path);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                log::info!("🧹 [EmbeddingWorker] File not found, removing stale DB record: {}", note_path);
                let _ = crate::core::db::repository::delete_note(conn, note_path);
                return Ok(());
            }
            return Err(format!("Failed to read {}: {}", note_path, e));
        }
    };

    let chunking_config = ChunkingConfig::default();
    let pipeline_config = PipelineConfig::default();

    // Phase 6: 检测媒体引用
    let has_media = has_media_references(&content);
    
    if has_media {
        // 检查所有媒体是否已缓存
        if all_media_cached(&content, vault_path, conn) {
            // 全部命中缓存 → 用缓存文本 enrich（同步读取，0 Sidecar 调用）
            log::info!("⚡ [EmbeddingWorker] All media cached for {}, enriching from cache", note_path);
            
            // Use the passed-in runtime instead of creating a new one
            let vault_owned = vault_path.to_path_buf();
            let content_owned = content.clone();
            let enriched = runtime.block_on(async {
                enrich_with_media(
                    &content_owned,
                    Some(vault_owned.as_path()),
                    None,  // 不需要 LLM config，因为全走缓存
                    Some(conn),
                ).await
            });
            
            let chunk_result = chunk_document(&enriched, &chunking_config);
            if chunk_result.chunks.is_empty() {
                // 即使 enriched 后仍无有效 chunk
                insert_skipped_marker(conn, note_path, &pipeline_config)?;
                return Ok(());
            }
            
            for chunk in &chunk_result.chunks {
                let hash = content_hash(&chunk.content);
                conn.execute(
                    r#"INSERT OR REPLACE INTO embeddings_v2 
                        (note_path, product_type, chunk_id, content_hash, embedding,
                         model_version, pipeline_version, status, priority, heartbeat_at)
                    VALUES (?1, 'paragraph', ?2, ?3, X'', ?4, ?5, 'pending', 5, unixepoch())"#,
                    params![
                        note_path, &chunk.chunk_id, &hash,
                        &pipeline_config.model_name, pipeline_config.pipeline_version,
                    ],
                ).map_err(|e| e.to_string())?;
            }
            
            log::info!("📝 [EmbeddingWorker] Scheduled {} enriched chunks for: {}", chunk_result.chunks.len(), note_path);
            return Ok(());
        } else {
            // 有未缓存的媒体 → 标记 media_pending，不调 Sidecar
            log::debug!("📎 [EmbeddingWorker] Media cache MISS for {}, marking media_pending", note_path);
            
            conn.execute(
                r#"INSERT OR REPLACE INTO embeddings_v2 
                    (note_path, product_type, chunk_id, content_hash, embedding,
                     model_version, pipeline_version, status, priority, heartbeat_at)
                VALUES (?1, 'paragraph', '_media_pending', 'media', X'', ?2, ?3, 'media_pending', 1, unixepoch())"#,
                params![
                    note_path,
                    &pipeline_config.model_name,
                    pipeline_config.pipeline_version,
                ],
            ).map_err(|e| e.to_string())?;
            
            return Ok(());
        }
    }

    // 无媒体引用的普通笔记 → 正常分块
    let chunk_result = chunk_document(&content, &chunking_config);

    if chunk_result.chunks.is_empty() {
        insert_skipped_marker(conn, note_path, &pipeline_config)?;
        return Ok(());
    }

    for chunk in &chunk_result.chunks {
        let hash = content_hash(&chunk.content);
        conn.execute(
            r#"INSERT OR REPLACE INTO embeddings_v2 
                (note_path, product_type, chunk_id, content_hash, embedding,
                 model_version, pipeline_version, status, priority, heartbeat_at)
            VALUES (?1, 'paragraph', ?2, ?3, X'', ?4, ?5, 'pending', 5, unixepoch())"#,
            params![
                note_path, &chunk.chunk_id, &hash,
                &pipeline_config.model_name, pipeline_config.pipeline_version,
            ],
        ).map_err(|e| e.to_string())?;
    }

    log::debug!(
        "📝 [EmbeddingWorker] Scheduled {} chunks for: {}",
        chunk_result.chunks.len(), note_path
    );

    Ok(())
}

/// P-005 Fix: Insert 'skipped' marker to prevent infinite discovery loop
fn insert_skipped_marker(
    conn: &rusqlite::Connection,
    note_path: &str,
    pipeline_config: &crate::core::embedding::types::PipelineConfig,
) -> Result<(), String> {
    use rusqlite::params;
    conn.execute(
        r#"INSERT OR IGNORE INTO embeddings_v2 
            (note_path, product_type, chunk_id, content_hash, embedding,
             model_version, pipeline_version, status, priority, heartbeat_at)
        VALUES (?1, 'paragraph', '_empty', 'empty', X'', ?2, ?3, 'skipped', 0, unixepoch())"#,
        params![
            note_path,
            &pipeline_config.model_name,
            pipeline_config.pipeline_version,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Emit embedding status event to frontend
#[allow(dead_code)]
pub fn emit_embedding_status(app_handle: &AppHandle, note_path: &str, status: &str, details: &str) {
    let _ = app_handle.emit(
        "embedding:status",
        serde_json::json!({
            "path": note_path,
            "status": status,
            "details": details,
        }),
    );
}

/// Public wrapper for schedule_note_for_embedding (used by Tauri commands)
pub fn schedule_note_for_embedding_public(
    conn: &rusqlite::Connection,
    vault_path: &std::path::Path,
    note_path: &str,
    runtime: &Arc<Runtime>,
    pipeline: &EmbeddingPipeline,
) -> Result<(), String> {
    schedule_note_for_embedding(conn, vault_path, note_path, runtime, pipeline)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_config_defaults() {
        let config = WorkerConfig::default();
        assert_eq!(config.interval_secs, 30);
        assert_eq!(config.batch_size, 10);
        assert!(config.emit_events);
    }
}
