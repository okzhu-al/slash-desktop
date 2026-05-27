//! Embedding Scheduler Module
//!
//! Orchestrates embedding generation based on trigger context:
//! - Blur: Incremental paragraphs for current note (P0, budget-limited)
//! - Idle: Catch-up for NoteProfile/Summary, retries, stale recovery

use super::chunker::{chunk_document, ChunkingConfig};
use super::denoise::{content_hash, denoise, DenoiseConfig};
use super::types::{ChunkKind, PipelineConfig, ProductType};
use rusqlite::{params, Connection};

/// Trigger context for embedding scheduling
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerContext {
    /// Editor blur - process current note's paragraphs
    Blur,
    /// Idle timeout - catch-up work
    Idle,
    /// Manual rebuild request
    Manual,
    /// Startup recovery
    Startup,
}

/// Scheduling result
#[derive(Debug, Default)]
pub struct ScheduleResult {
    /// Chunks processed
    pub processed: usize,
    /// Chunks skipped (up-to-date)
    pub skipped: usize,
    /// Chunks failed
    pub failed: usize,
    /// Whether budget was exhausted
    pub budget_exhausted: bool,
    /// Whether degradation was active
    pub degraded: bool,
}

/// Scheduler configuration
#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    /// Max chunks per Blur execution
    pub blur_budget: usize,
    /// Max chunks per Idle execution
    pub idle_budget: usize,
    /// Heartbeat update interval (every N chunks)
    pub heartbeat_interval: usize,
    /// Enable degradation under pressure
    pub enable_degradation: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            blur_budget: 200,
            idle_budget: 100,
            heartbeat_interval: 50,
            enable_degradation: true,
        }
    }
}

/// Embedding Scheduler
pub struct EmbeddingScheduler {
    config: SchedulerConfig,
    pipeline_config: PipelineConfig,
    chunking_config: ChunkingConfig,
    denoise_config: DenoiseConfig,
}

impl EmbeddingScheduler {
    /// Create a new scheduler with default config
    pub fn new() -> Self {
        Self {
            config: SchedulerConfig::default(),
            pipeline_config: PipelineConfig::default(),
            chunking_config: ChunkingConfig::default(),
            denoise_config: DenoiseConfig::default(),
        }
    }

    /// Create with custom configuration
    pub fn with_config(
        config: SchedulerConfig,
        pipeline_config: PipelineConfig,
        chunking_config: ChunkingConfig,
        denoise_config: DenoiseConfig,
    ) -> Self {
        Self {
            config,
            pipeline_config,
            chunking_config,
            denoise_config,
        }
    }

    /// Schedule embedding work for a note on Blur
    ///
    /// P0: Process paragraph chunks for the current note, budget-limited
    pub fn schedule_blur(
        &self,
        note_path: &str,
        content: &str,
        conn: &Connection,
    ) -> Result<ScheduleResult, String> {
        let mut result = ScheduleResult::default();

        // 1. Chunk the document
        let chunk_result = chunk_document(content, &self.chunking_config);
        
        // P-015 Fix: Clean up orphaned embeddings for paragraph chunks that no longer exist
        let valid_ids: Vec<String> = chunk_result.chunks.iter().map(|c| c.chunk_id.clone()).collect();
        if let Ok(deleted) = self.cleanup_orphaned_chunks(note_path, &valid_ids, conn) {
            if deleted > 0 {
                log::debug!("🧹 [Embedding] Cleaned up {} orphaned chunks for: {}", deleted, note_path);
            }
        }

        if chunk_result.chunks.is_empty() {
            return Ok(result);
        }

        // 2. Process chunks up to budget
        let budget = self.config.blur_budget;
        let mut processed_count = 0;

        for chunk in chunk_result.chunks.iter().take(budget) {
            // Check if up-to-date
            let content_hash_val = content_hash(&chunk.content);
            if self.is_chunk_up_to_date(
                note_path,
                ProductType::Paragraph,
                &chunk.chunk_id,
                &content_hash_val,
                conn,
            )? {
                result.skipped += 1;
                continue;
            }

            // Mark as pending for processing
            self.upsert_pending_chunk(
                note_path,
                ProductType::Paragraph,
                &chunk.chunk_id,
                &content_hash_val,
                &chunk.heading_path,
                chunk.kind.clone(),
                conn,
            )?;

            processed_count += 1;

            // Batch heartbeat update
            if processed_count % self.config.heartbeat_interval == 0 {
                self.batch_heartbeat_update(note_path, ProductType::Paragraph, conn)?;
            }
        }

        result.processed = processed_count;
        result.budget_exhausted = chunk_result.chunks.len() > budget;

        // 3. Schedule NoteProfile (P1) - using whole note content
        let cleaned_content = denoise(content, &self.denoise_config);
        if cleaned_content.len() >= self.pipeline_config.min_content_length {
            let profile_hash = content_hash(&cleaned_content);
            let profile_chunk_id = ProductType::NoteProfile
                .fixed_chunk_id()
                .unwrap_or("_profile")
                .to_string();

            // Check if NoteProfile is up-to-date
            if !self.is_chunk_up_to_date(
                note_path,
                ProductType::NoteProfile,
                &profile_chunk_id,
                &profile_hash,
                conn,
            )? {
                // Upsert NoteProfile as pending
                // Check if already exists before deciding to log
                let is_new = !self.chunk_exists(
                    note_path,
                    ProductType::NoteProfile,
                    &profile_chunk_id,
                    conn,
                )?;

                self.upsert_pending_chunk(
                    note_path,
                    ProductType::NoteProfile,
                    &profile_chunk_id,
                    &profile_hash,
                    "", // No heading_path for NoteProfile
                    ChunkKind::Text,
                    conn,
                )?;

                // Only log on new insert, not update
                if is_new {
                    log::debug!("📝 [Embedding] Scheduled NoteProfile for: {}", note_path);
                }
            }
        }

        Ok(result)
    }

    /// Schedule catch-up work on Idle
    ///
    /// P1: Process NoteProfile, Summary, retries, and stale recovery
    pub fn schedule_idle(&self, conn: &Connection) -> Result<ScheduleResult, String> {
        let mut result = ScheduleResult::default();
        let mut remaining_budget = self.config.idle_budget;

        // 1. Recover stale processing jobs (heartbeat timeout)
        let stale_jobs = self.get_stale_jobs(conn)?;
        for (path, product_type, chunk_id) in stale_jobs.iter().take(remaining_budget) {
            self.mark_for_retry(path, product_type, chunk_id, conn)?;
            result.processed += 1;
            remaining_budget = remaining_budget.saturating_sub(1);
        }

        if remaining_budget == 0 {
            result.budget_exhausted = true;
            return Ok(result);
        }

        // 2. Retry failed jobs
        let failed_jobs = self.get_failed_jobs(conn, self.pipeline_config.max_retries)?;
        for (path, product_type, chunk_id) in failed_jobs.iter().take(remaining_budget) {
            self.mark_for_retry(path, product_type, chunk_id, conn)?;
            result.processed += 1;
            remaining_budget = remaining_budget.saturating_sub(1);
        }

        if remaining_budget == 0 {
            result.budget_exhausted = true;
            return Ok(result);
        }

        // 3. Check degradation - skip profile/summary if enabled
        if self.config.enable_degradation {
            // Check if there are many pending paragraphs (resource pressure)
            let pending_paragraphs = self.count_pending_paragraphs(conn)?;
            if pending_paragraphs > 100 {
                result.degraded = true;
                // Skip profile/summary work, focus on paragraphs
                return Ok(result);
            }
        }

        // 4. Process pending jobs (including profile/summary)
        let pending_jobs = self.get_pending_jobs(conn)?;
        for (path, product_type, chunk_id) in pending_jobs.iter().take(remaining_budget) {
            // Just mark them as ready - actual embedding happens in pipeline
            self.touch_job(path, product_type, chunk_id, conn)?;
            result.processed += 1;
        }

        Ok(result)
    }

    /// Check if a chunk record exists (regardless of status)
    fn chunk_exists(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<bool, String> {
        let count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*) FROM embeddings_v2
                WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
                "#,
                params![note_path, product_type.as_str(), chunk_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    /// Check if a chunk is up-to-date
    fn is_chunk_up_to_date(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        content_hash: &str,
        conn: &Connection,
    ) -> Result<bool, String> {
        let result: Result<(String, String, u32), _> = conn.query_row(
            r#"
            SELECT content_hash, model_version, pipeline_version
            FROM embeddings_v2
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
              AND status = 'completed'
            "#,
            params![note_path, product_type.as_str(), chunk_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );

        match result {
            Ok((existing_hash, model, version)) => Ok(existing_hash == content_hash
                && model == self.pipeline_config.model_name
                && version == self.pipeline_config.pipeline_version),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Upsert a pending chunk for processing
    fn upsert_pending_chunk(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        content_hash: &str,
        heading_path: &str,
        chunk_kind: ChunkKind,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            INSERT INTO embeddings_v2 
                (note_path, product_type, chunk_id, content_hash, embedding, 
                 model_version, pipeline_version, status, chunk_kind, heading_path, heartbeat_at)
            VALUES (?1, ?2, ?3, ?4, X'', ?5, ?6, 'pending', ?7, ?8, unixepoch())
            ON CONFLICT(note_path, product_type, chunk_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                status = CASE 
                    WHEN embeddings_v2.content_hash != excluded.content_hash THEN 'pending'
                    ELSE embeddings_v2.status
                END,
                heading_path = excluded.heading_path,
                chunk_kind = excluded.chunk_kind,
                heartbeat_at = unixepoch(),
                updated_at = unixepoch()
            "#,
            params![
                note_path,
                product_type.as_str(),
                chunk_id,
                content_hash,
                &self.pipeline_config.model_name,
                self.pipeline_config.pipeline_version,
                chunk_kind.as_str(),
                heading_path,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Batch update heartbeat for a note's chunks
    fn batch_heartbeat_update(
        &self,
        note_path: &str,
        product_type: ProductType,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            UPDATE embeddings_v2
            SET heartbeat_at = unixepoch(), updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND status = 'processing'
            "#,
            params![note_path, product_type.as_str()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get stale processing jobs (heartbeat timeout exceeded)
    fn get_stale_jobs(&self, conn: &Connection) -> Result<Vec<(String, String, String)>, String> {
        let timeout = self.pipeline_config.heartbeat_timeout_secs;
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, product_type, chunk_id FROM embeddings_v2
            WHERE status = 'processing'
              AND (heartbeat_at IS NULL OR heartbeat_at < unixepoch() - ?1)
            ORDER BY updated_at ASC
            LIMIT 100
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map(params![timeout], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Get failed jobs that can be retried
    fn get_failed_jobs(
        &self,
        conn: &Connection,
        max_retries: u8,
    ) -> Result<Vec<(String, String, String)>, String> {
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, product_type, chunk_id FROM embeddings_v2
            WHERE status = 'failed' AND retry_count < ?1
            ORDER BY priority DESC, updated_at ASC
            LIMIT 100
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map(params![max_retries], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Get pending jobs
    fn get_pending_jobs(&self, conn: &Connection) -> Result<Vec<(String, String, String)>, String> {
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, product_type, chunk_id FROM embeddings_v2
            WHERE status = 'pending'
            ORDER BY priority DESC, updated_at ASC
            LIMIT 100
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Count pending paragraph chunks (for degradation check)
    fn count_pending_paragraphs(&self, conn: &Connection) -> Result<usize, String> {
        let count: i64 = conn
            .query_row(
                r#"
            SELECT COUNT(*) FROM embeddings_v2
            WHERE product_type = 'paragraph' AND status = 'pending'
            "#,
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count as usize)
    }

    /// Mark a job for retry
    fn mark_for_retry(
        &self,
        note_path: &str,
        product_type: &str,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            UPDATE embeddings_v2
            SET status = 'pending', heartbeat_at = unixepoch(), updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
            "#,
            params![note_path, product_type, chunk_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Touch a job (update timestamp)
    fn touch_job(
        &self,
        note_path: &str,
        product_type: &str,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            UPDATE embeddings_v2
            SET heartbeat_at = unixepoch(), updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
            "#,
            params![note_path, product_type, chunk_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete orphaned embeddings for a note (chunks that no longer exist)
    pub fn cleanup_orphaned_chunks(
        &self,
        note_path: &str,
        valid_chunk_ids: &[String],
        conn: &Connection,
    ) -> Result<usize, String> {
        if valid_chunk_ids.is_empty() {
            // Delete all paragraph chunks for this note except _media_pending
            let deleted = conn
                .execute(
                    r#"
                DELETE FROM embeddings_v2
                WHERE note_path = ?1 AND product_type = 'paragraph' AND chunk_id != '_media_pending'
                  AND updated_at < unixepoch() - 60
                "#,
                    params![note_path],
                )
                .map_err(|e| e.to_string())?;
            return Ok(deleted);
        }

        // Build placeholders for IN clause
        let placeholders: Vec<String> = (0..valid_chunk_ids.len())
            .map(|i| format!("?{}", i + 2))
            .collect();
        let sql = format!(
            r#"
            DELETE FROM embeddings_v2
            WHERE note_path = ?1 AND product_type = 'paragraph'
              AND chunk_id NOT IN ({})
              AND chunk_id != '_media_pending'
              AND updated_at < unixepoch() - 60
            "#,
            placeholders.join(", ")
        );

        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&note_path];
        for id in valid_chunk_ids {
            params_vec.push(id);
        }

        let deleted = conn
            .execute(&sql, params_vec.as_slice())
            .map_err(|e| e.to_string())?;
        Ok(deleted)
    }
}

impl Default for EmbeddingScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scheduler_config_defaults() {
        let config = SchedulerConfig::default();
        assert_eq!(config.blur_budget, 200);
        assert_eq!(config.idle_budget, 100);
        assert_eq!(config.heartbeat_interval, 50);
        assert!(config.enable_degradation);
    }

    #[test]
    fn test_trigger_context_variants() {
        assert_eq!(TriggerContext::Blur, TriggerContext::Blur);
        assert_ne!(TriggerContext::Blur, TriggerContext::Idle);
    }

    #[test]
    fn test_schedule_result_default() {
        let result = ScheduleResult::default();
        assert_eq!(result.processed, 0);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.failed, 0);
        assert!(!result.budget_exhausted);
        assert!(!result.degraded);
    }
}
