//! Media Scheduler — Phase 6: 用户手动触发的媒体 Enrichment 处理器
//!
//! 设计要点：
//! - 仅处理 `status = 'media_pending'` 的记录
//! - 顺序处理（单线程），避免 GPU/CPU 资源争抢
//! - 由前端按钮触发，不自动后台运行
//! - 处理完成后删除 media_pending 标记，重新走 schedule_note_for_embedding

use crate::core::embedding::pipeline::enrich_with_media;
use rusqlite::{params, Connection};

/// 媒体调度结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaScheduleResult {
    pub total: usize,
    pub processed: usize,
    pub failed: usize,
}

/// 获取 media_pending 的笔记数量
pub fn get_media_pending_count(conn: &Connection, note_path: Option<&str>) -> usize {
    if let Some(path) = note_path {
        conn.query_row(
            "SELECT COUNT(DISTINCT note_path) FROM embeddings_v2 WHERE status = 'media_pending' AND note_path = ?1",
            params![path],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0) as usize
    } else {
        conn.query_row(
            "SELECT COUNT(DISTINCT note_path) FROM embeddings_v2 WHERE status = 'media_pending'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0) as usize
    }
}

/// 获取指定 asset 的 enriched 文本（用于悬浮预览）
pub fn get_enriched_content(conn: &Connection, asset_hash: &str) -> Option<String> {
    conn.query_row(
        "SELECT enriched_text FROM media_enrich_cache WHERE asset_hash = ?1",
        params![asset_hash],
        |row| row.get(0),
    )
    .ok()
}

/// 单个笔记的媒体提取状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaStatusResult {
    pub total: usize,
    pub pending: usize,
    pub done: usize,
    pub failed: usize,
}

/// 媒体处理细粒度进度事件 Payload
#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaProgressPayload {
    pub current: usize,
    pub total: usize,
    pub path: String,
}

/// 计算单篇笔记的精确媒体状态
pub fn get_note_media_status(
    conn: &Connection,
    vault_path: &std::path::Path,
    note_path: &str,
) -> Option<MediaStatusResult> {
    let file_path = vault_path.join(note_path);
    let content = match std::fs::read_to_string(&file_path) {
        Ok(c) => c,
        Err(_) => return None,
    };

    let media_regex = match regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
        Ok(r) => r,
        Err(_) => return None,
    };

    let mut total: usize = 0;
    let mut done: usize = 0;

    for cap in media_regex.captures_iter(&content) {
        total += 1;
        let asset_rel = &cap[1];
        let asset_abs = vault_path.join(asset_rel);
        
        let filename = asset_abs.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        let asset_hash = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename)
            .to_string();

        let is_cached: bool = conn.query_row(
            "SELECT 1 FROM media_enrich_cache WHERE asset_hash = ?1",
            params![&asset_hash],
            |_| Ok(true),
        ).unwrap_or(false);

        if is_cached {
            done += 1;
        }
    }

    if total == 0 {
        return None;
    }

    let has_pending: bool = conn.query_row(
        "SELECT 1 FROM embeddings_v2 WHERE note_path = ?1 AND status = 'media_pending' LIMIT 1",
        params![note_path],
        |_| Ok(true),
    ).unwrap_or(false);

    let pending;
    let failed;

    if has_pending {
        pending = total.saturating_sub(done);
        failed = 0;
    } else {
        pending = 0;
        failed = total.saturating_sub(done);
    }

    Some(MediaStatusResult {
        total,
        pending,
        done,
        failed,
    })
}

/// 处理所有 media_pending 笔记
///
/// 流程：
/// 1. 查出所有 media_pending 的 note_path
/// 2. 逐个读取笔记文件
/// 3. 调用 enrich_with_media（未缓存的会调 Sidecar，结果自动写入缓存）
/// 4. 删除 media_pending 记录
/// 5. 重新调用 schedule_note_for_embedding（此时缓存全命中，直接变 pending）
pub async fn process_media_pending(
    conn: &Connection,
    vault_path: &std::path::Path,
    _pipeline: &crate::core::embedding::EmbeddingPipeline,
    target_note_path: Option<&str>,
    vision_config: Option<&crate::core::embedding::SidecarLlmConfig>,
    app_handle: Option<tauri::AppHandle>,
) -> MediaScheduleResult {
    use tauri::Emitter;

    let mut result = MediaScheduleResult {
        total: 0,
        processed: 0,
        failed: 0,
    };

    // 1. 查出需要处理的 note_path
    let note_paths: Vec<String> = {
        if let Some(path) = target_note_path {
            vec![path.to_string()]
        } else {
            let query = "SELECT DISTINCT note_path FROM embeddings_v2 WHERE status = 'media_pending'";
            let mut stmt = match conn.prepare(query) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("❌ [MediaScheduler] Failed to query media_pending: {}", e);
                    return result;
                }
            };
            
            let paths: Vec<String> = match stmt.query_map([], |row| row.get(0)) {
                Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
                Err(_) => Vec::new(),
            };
            paths
        }
    };

    result.total = note_paths.len();
    log::info!("📎 [MediaScheduler] Processing {} media_pending notes", result.total);

    // 2. 逐个处理（顺序，避免 GPU 争抢）
    for (index, note_path) in note_paths.iter().enumerate() {
        // 向前端发送当前进度事件
        if let Some(ref app) = app_handle {
            let _ = app.emit(
                "media:progress",
                MediaProgressPayload {
                    current: index + 1,
                    total: result.total,
                    path: note_path.clone(),
                },
            );
        }

        let file_path = vault_path.join(note_path);
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("❌ [MediaScheduler] Failed to read {}: {}", note_path, e);
                result.failed += 1;
                continue;
            }
        };

        // 3. 调用 enrich_with_media（缓存未命中的会调 Sidecar 并写入缓存）
        let enriched = enrich_with_media(
            &content,
            Some(vault_path),
            vision_config,
            Some(conn),
        ).await;

        if enriched.len() > content.len() {
            log::info!("✅ [MediaScheduler] Enriched {} (+{} chars)", note_path, enriched.len() - content.len());
        }

        // 4. 删除 media_pending 记录
        let _ = conn.execute(
            "DELETE FROM embeddings_v2 WHERE note_path = ?1 AND status = 'media_pending'",
            params![note_path],
        );

        // 5. 直接 chunk enriched 内容并插入 pending 记录
        // 不调用 schedule_note_for_embedding_public 避免嵌套 block_on
        schedule_enriched_chunks(conn, note_path, &enriched);

        result.processed += 1;
    }

    log::info!(
        "📎 [MediaScheduler] Complete: {}/{} processed, {} failed",
        result.processed, result.total, result.failed
    );

    result
}

/// Internal: directly chunk enriched content and insert pending records
/// This avoids the nested block_on issue that occurs when calling
/// schedule_note_for_embedding_public from within an async context
fn schedule_enriched_chunks(
    conn: &Connection,
    note_path: &str,
    enriched_content: &str,
) {
    use crate::core::embedding::chunker::{chunk_document, ChunkingConfig};
    use crate::core::embedding::denoise::content_hash;
    use crate::core::embedding::types::PipelineConfig;

    let chunking_config = ChunkingConfig::default();
    let pipeline_config = PipelineConfig::default();

    let chunk_result = chunk_document(enriched_content, &chunking_config);

    if chunk_result.chunks.is_empty() {
        // Insert skipped marker to prevent infinite discovery loop
        let _ = conn.execute(
            r#"INSERT OR IGNORE INTO embeddings_v2 
                (note_path, product_type, chunk_id, content_hash, embedding,
                 model_version, pipeline_version, status, priority, heartbeat_at)
            VALUES (?1, 'paragraph', '_empty', 'empty', X'', ?2, ?3, 'skipped', 0, unixepoch())"#,
            params![
                note_path,
                &pipeline_config.model_name,
                pipeline_config.pipeline_version,
            ],
        );
        return;
    }

    for chunk in &chunk_result.chunks {
        let hash = content_hash(&chunk.content);
        let _ = conn.execute(
            r#"INSERT OR REPLACE INTO embeddings_v2 
                (note_path, product_type, chunk_id, content_hash, embedding,
                 model_version, pipeline_version, status, priority, heartbeat_at, enriched_content)
            VALUES (?1, 'paragraph', ?2, ?3, X'', ?4, ?5, 'pending', 5, unixepoch(), ?6)"#,
            params![
                note_path, &chunk.chunk_id, &hash,
                &pipeline_config.model_name, pipeline_config.pipeline_version,
                &chunk.content,
            ],
        );
    }

    log::info!(
        "📝 [MediaScheduler] Scheduled {} enriched chunks for: {}",
        chunk_result.chunks.len(), note_path
    );
}
