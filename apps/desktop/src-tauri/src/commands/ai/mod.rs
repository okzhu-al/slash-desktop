//! AI Commands - Interface Layer
//!
//! This module organizes AI-related Tauri commands by functional domain.

pub mod classification;
pub mod custom_skills;
pub mod data;
pub mod feedback;
pub mod ghostlink;
pub mod orchestrator;
pub mod provider_config;
pub mod relations;
pub mod service;
pub mod skills;
pub mod usage;
pub mod wikilink_relation;

// Re-export all commands for easy access
pub use classification::*;
pub use custom_skills::*;
pub use data::*;
pub use feedback::*;
pub use ghostlink::*;
pub use orchestrator::run_tagging; // Explicit export for debugging
pub use orchestrator::*;
pub use provider_config::*;
pub use relations::*;
pub use service::*;
pub use skills::*;
pub use usage::*;
pub use wikilink_relation::*;
