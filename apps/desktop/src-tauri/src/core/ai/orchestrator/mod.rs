//! AI Orchestrator Module
//!
//! Minimal wrapper — retains only `EditorState` for trigger classification.
//! The legacy 3-layer scheduler (Policy → Binding → Scheduler) has been removed;
//! AI skills are now triggered manually via per-skill commands.

pub mod state;

pub use state::EditorState;
