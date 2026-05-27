//! Version Management Module
//!
//! Handles version detection and lazy rebuild:
//! - Model version tracking (e.g., bge-m3 vs nomic-embed)
//! - Pipeline version tracking (schema/logic changes)
//! - Prioritized rebuild queue

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::types::PipelineConfig;

/// Embedding statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingStats {
    /// Total embeddings in database
    pub total_embeddings: usize,
    /// Completed embeddings
    pub completed: usize,
    /// Pending embeddings
    pub pending: usize,
    /// Processing embeddings
    pub processing: usize,
    /// Failed embeddings
    pub failed: usize,
    /// Abandoned embeddings (exceeded retry limit or file deleted)
    pub abandoned: usize,
    /// Embeddings needing rebuild (version mismatch)
    pub needs_rebuild: usize,
    /// Current model version in config
    pub current_model: String,
    /// Current pipeline version in config
    pub current_pipeline_version: u32,
    /// Unique model versions in database
    pub model_versions: Vec<String>,
    /// Current model display version
    #[serde(rename = "current_model_version")]
    pub current_model_version: String,
}

/// Version mismatch info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionMismatch {
    /// Note path
    pub note_path: String,
    /// Current model in DB
    pub db_model: String,
    /// Current pipeline version in DB
    pub db_pipeline_version: u32,
    /// Expected model
    pub expected_model: String,
    /// Expected pipeline version
    pub expected_pipeline_version: u32,
}

/// Version manager for embeddings
pub struct VersionManager {
    config: PipelineConfig,
}

impl VersionManager {
    /// Create a new version manager
    pub fn new(config: PipelineConfig) -> Self {
        Self { config }
    }

    /// Create with default config
    pub fn default_config() -> Self {
        Self {
            config: PipelineConfig::default(),
        }
    }

    /// Get embedding statistics
    pub fn get_stats(&self, conn: &Connection) -> Result<EmbeddingStats, String> {
        // Count by status
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM embeddings_v2", [], |row| row.get(0))
            .unwrap_or(0);

        let completed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'completed'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let processing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'processing'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let failed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'failed'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let abandoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'abandoned'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Count needing rebuild
        let needs_rebuild: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*) FROM embeddings_v2 
                WHERE model_version != ?1 OR pipeline_version != ?2
                "#,
                params![&self.config.model_name, self.config.pipeline_version],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Get unique model versions
        let mut stmt = conn
            .prepare("SELECT DISTINCT model_version FROM embeddings_v2")
            .map_err(|e| e.to_string())?;
        let model_versions: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(EmbeddingStats {
            total_embeddings: total as usize,
            completed: completed as usize,
            pending: pending as usize,
            processing: processing as usize,
            failed: failed as usize,
            abandoned: abandoned as usize,
            needs_rebuild: needs_rebuild as usize,
            current_model: self.config.model_name.clone(),
            current_pipeline_version: self.config.pipeline_version,
            model_versions,
            current_model_version: self.config.model_name.clone(),
        })
    }

    /// Check if any embeddings need rebuild
    pub fn has_version_mismatch(&self, conn: &Connection) -> Result<bool, String> {
        let count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*) FROM embeddings_v2 
                WHERE (model_version != ?1 OR pipeline_version != ?2)
                  AND status = 'completed'
                LIMIT 1
                "#,
                params![&self.config.model_name, self.config.pipeline_version],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    /// Get notes needing rebuild (paginated)
    pub fn get_notes_needing_rebuild(
        &self,
        conn: &Connection,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT DISTINCT note_path FROM embeddings_v2
                WHERE model_version != ?1 OR pipeline_version != ?2
                ORDER BY priority DESC, updated_at ASC
                LIMIT ?3 OFFSET ?4
                "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map(
                params![
                    &self.config.model_name,
                    self.config.pipeline_version,
                    limit as i64,
                    offset as i64
                ],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Mark embeddings for rebuild (set status to pending)
    pub fn mark_for_rebuild(&self, conn: &Connection, limit: usize) -> Result<usize, String> {
        let updated = conn
            .execute(
                r#"
                UPDATE embeddings_v2
                SET status = 'pending', 
                    priority = priority + 1,
                    updated_at = unixepoch()
                WHERE rowid IN (
                    SELECT rowid FROM embeddings_v2
                    WHERE (model_version != ?1 OR pipeline_version != ?2)
                      AND status = 'completed'
                    ORDER BY priority DESC, updated_at ASC
                    LIMIT ?3
                )
                "#,
                params![
                    &self.config.model_name,
                    self.config.pipeline_version,
                    limit as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// Mark all embeddings for a specific note for rebuild
    pub fn mark_note_for_rebuild(
        &self,
        note_path: &str,
        conn: &Connection,
    ) -> Result<usize, String> {
        let updated = conn
            .execute(
                r#"
                UPDATE embeddings_v2
                SET status = 'pending',
                    priority = 10,
                    updated_at = unixepoch()
                WHERE note_path = ?1 AND status = 'completed'
                "#,
                params![note_path],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// Clear all embeddings (for manual cache clear)
    pub fn clear_all(&self, conn: &Connection) -> Result<usize, String> {
        let deleted = conn
            .execute("DELETE FROM embeddings_v2", [])
            .map_err(|e| e.to_string())?;
        Ok(deleted)
    }

    /// Clear embeddings for a specific note
    pub fn clear_note(&self, note_path: &str, conn: &Connection) -> Result<usize, String> {
        let deleted = conn
            .execute(
                "DELETE FROM embeddings_v2 WHERE note_path = ?1",
                params![note_path],
            )
            .map_err(|e| e.to_string())?;
        Ok(deleted)
    }

    /// Pause processing (mark all processing as pending)
    pub fn pause_processing(&self, conn: &Connection) -> Result<usize, String> {
        let updated = conn
            .execute(
                r#"
                UPDATE embeddings_v2
                SET status = 'pending', updated_at = unixepoch()
                WHERE status = 'processing'
                "#,
                [],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// Reset failed embeddings to pending for retry
    pub fn retry_failed(&self, conn: &Connection) -> Result<usize, String> {
        let updated = conn
            .execute(
                r#"
                UPDATE embeddings_v2
                SET status = 'pending', 
                    retry_count = 0, 
                    error_message = NULL,
                    updated_at = unixepoch()
                WHERE status = 'failed'
                "#,
                [],
            )
            .map_err(|e| e.to_string())?;
        log::error!(
            "🔄 [VersionManager] Reset {} failed embeddings to pending",
            updated
        );
        Ok(updated)
    }

    /// Clean abandoned embeddings
    pub fn clean_abandoned(&self, conn: &Connection) -> Result<usize, String> {
        let deleted = conn
            .execute("DELETE FROM embeddings_v2 WHERE status = 'abandoned'", [])
            .map_err(|e| e.to_string())?;
        log::error!(
            "🧹 [VersionManager] Cleaned {} abandoned embeddings",
            deleted
        );
        Ok(deleted)
    }

    /// Rebuild all embeddings for all notes in the database
    /// This clears all existing embeddings, and the Worker's schedule_idle
    /// will automatically discover and properly chunk each note.
    /// Returns the number of notes that will be processed.
    pub fn rebuild_all(&self, conn: &Connection) -> Result<usize, String> {
        log::info!("🔄 [VersionManager] Starting rebuild_all for all notes");

        // Step 1: Count notes to be processed
        let total_notes: usize = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .map(|c| c as usize)
            .map_err(|e| e.to_string())?;

        log::info!("📝 [VersionManager] Found {} notes to rebuild", total_notes);

        if total_notes == 0 {
            return Ok(0);
        }

        // Step 2: Clear ALL existing embeddings_v2 records
        // The Worker's schedule_idle will automatically discover notes without embeddings
        // and create proper chunks with valid chunk_ids
        let deleted = conn
            .execute("DELETE FROM embeddings_v2", [])
            .map_err(|e| e.to_string())?;

        log::error!(
            "🗑️ [VersionManager] Cleared {} existing embedding records",
            deleted
        );

        log::error!(
            "✅ [VersionManager] rebuild_all complete: {} notes will be re-indexed by Worker",
            total_notes
        );
        Ok(total_notes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_manager_creation() {
        let vm = VersionManager::default_config();
        assert_eq!(vm.config.model_name, "bge-m3");
        assert_eq!(vm.config.pipeline_version, 2);
    }

    #[test]
    fn test_embedding_stats_serialize() {
        let stats = EmbeddingStats {
            total_embeddings: 100,
            completed: 90,
            pending: 5,
            processing: 3,
            failed: 2,
            abandoned: 0,
            needs_rebuild: 10,
            current_model: "bge-m3".to_string(),
            current_pipeline_version: 2,
            model_versions: vec!["bge-m3".to_string()],
            current_model_version: "bge-m3".to_string(),
        };

        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("total_embeddings"));
        assert!(json.contains("100"));
    }
}
