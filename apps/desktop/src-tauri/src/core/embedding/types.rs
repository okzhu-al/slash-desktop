//! Embedding Pipeline Type Definitions

use serde::{Deserialize, Serialize};

/// Vector product types (priority order)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProductType {
    /// P0: Paragraph-level vectors for precise retrieval
    Paragraph,
    /// P1: Note profile vector (AI summary based, for global similarity)
    NoteProfile,
    /// P2: Lightweight summary vector
    Summary,
}

impl ProductType {
    /// Convert to database string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            ProductType::Paragraph => "paragraph",
            ProductType::NoteProfile => "note_profile",
            ProductType::Summary => "summary",
        }
    }

    /// Parse from database string
    pub fn from_str(s: &str) -> Self {
        match s {
            "paragraph" => ProductType::Paragraph,
            "note_profile" => ProductType::NoteProfile,
            "summary" => ProductType::Summary,
            _ => ProductType::Paragraph,
        }
    }

    /// Get fixed chunk_id for non-paragraph products
    pub fn fixed_chunk_id(&self) -> Option<&'static str> {
        match self {
            ProductType::Paragraph => None,
            ProductType::NoteProfile => Some("_profile"),
            ProductType::Summary => Some("_summary"),
        }
    }
}

/// Job status in the pipeline
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobStatus {
    /// Waiting to be processed
    Pending,
    /// Currently being processed (with heartbeat)
    Processing,
    /// Successfully completed
    Completed,
    /// Failed (can be retried)
    Failed,
    /// Abandoned (exceeded retry limit)
    Abandoned,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Processing => "processing",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Abandoned => "abandoned",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "pending" => JobStatus::Pending,
            "processing" => JobStatus::Processing,
            "completed" => JobStatus::Completed,
            "failed" => JobStatus::Failed,
            "abandoned" => JobStatus::Abandoned,
            _ => JobStatus::Pending,
        }
    }
}

/// Chunk metadata for paragraph-level indexing
#[derive(Debug, Clone)]
pub struct ChunkMeta {
    /// Stable hash-based ID (16 chars of SHA256)
    pub chunk_id: String,
    /// Heading path context (e.g., "Title > Section > Sub")
    pub heading_path: String,
    /// Content kind for filtering/weighting
    pub kind: ChunkKind,
    /// Character offset in original document
    pub offset: usize,
    /// Normalized content for this chunk
    pub content: String,
}

/// Content kind for chunks
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChunkKind {
    /// Normal text content
    Text,
    /// Code block content
    Code,
    /// List items
    List,
    /// Table content
    Table,
}

impl ChunkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChunkKind::Text => "text",
            ChunkKind::Code => "code",
            ChunkKind::List => "list",
            ChunkKind::Table => "table",
        }
    }
}

/// Embedding job to be processed
#[derive(Debug, Clone)]
pub struct EmbeddingJob {
    pub note_path: String,
    pub product_type: ProductType,
    pub chunk_id: String,
    pub cleaned_content: String,
    pub content_hash: String,
    pub meta: Option<ChunkMeta>,
}

/// Pipeline configuration
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    /// Embedding model name (e.g., "bge-m3:latest")
    pub model_name: String,
    /// Pipeline version for invalidation
    pub pipeline_version: u32,
    /// Maximum retry attempts
    pub max_retries: u8,
    /// Minimum content length after normalize
    pub min_content_length: usize,
    /// Max chunks per execution batch (Blur budget)
    pub blur_chunk_budget: usize,
    /// Heartbeat timeout in seconds (15-30 min recommended)
    pub heartbeat_timeout_secs: i64,
    /// Heartbeat batch size for updates
    pub heartbeat_batch_size: usize,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            model_name: "bge-m3".to_string(),
            pipeline_version: 2,
            max_retries: 10,
            min_content_length: 50,
            blur_chunk_budget: 200,       // Blur executes up to 200 chunks
            heartbeat_timeout_secs: 1200, // 20 minutes
            heartbeat_batch_size: 50,     // Update heartbeat every 50 chunks
        }
    }
}

/// Code block budget configuration
#[derive(Debug, Clone)]
pub struct CodeBlockBudget {
    /// Maximum lines per code block
    pub max_lines: usize,
    /// Maximum characters per code block
    pub max_chars: usize,
    /// Truncate log-like blocks more aggressively
    pub aggressive_log_truncate: bool,
}

impl Default for CodeBlockBudget {
    fn default() -> Self {
        Self {
            max_lines: 100,
            max_chars: 6000,
            aggressive_log_truncate: true,
        }
    }
}

/// Compute stable chunk ID from heading_path and normalized content
/// Returns first 16 characters of SHA256(heading_path + "\n" + content)
pub fn compute_chunk_id(heading_path: &str, content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(heading_path.as_bytes());
    hasher.update(b"\n");
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_chunk_id_stability() {
        let id1 = compute_chunk_id("Title > Section", "Some content here");
        let id2 = compute_chunk_id("Title > Section", "Some content here");
        let id3 = compute_chunk_id("Title > Section", "Different content");
        let id4 = compute_chunk_id("Different > Path", "Some content here");

        assert_eq!(id1, id2); // Same input = same ID
        assert_ne!(id1, id3); // Different content = different ID
        assert_ne!(id1, id4); // Different heading = different ID
        assert_eq!(id1.len(), 16); // Always 16 chars
    }

    #[test]
    fn test_fixed_chunk_ids() {
        assert_eq!(ProductType::NoteProfile.fixed_chunk_id(), Some("_profile"));
        assert_eq!(ProductType::Summary.fixed_chunk_id(), Some("_summary"));
        assert_eq!(ProductType::Paragraph.fixed_chunk_id(), None);
    }
}
