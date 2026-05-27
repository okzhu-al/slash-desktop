//! Embedding Pipeline Module
//!
//! 将 Embedding 从"技能"升级为"基础设施/管线"
//! 支持：降噪、分块、hash去重、版本化、状态追踪、调度

// Core modules
pub mod chunker;
pub mod denoise;
mod pipeline;
#[allow(dead_code)]
mod scheduler;
#[allow(dead_code)]
mod types;
#[allow(dead_code)]
mod versioning;
pub mod media_scheduler;
pub mod worker;

// Only re-export types that are actually used through this module
pub use pipeline::EmbeddingPipeline;
pub use pipeline::{enrich_with_media, SidecarLlmConfig};
pub use scheduler::EmbeddingScheduler;
pub use types::PipelineConfig;
pub use versioning::{EmbeddingStats, VersionManager};
