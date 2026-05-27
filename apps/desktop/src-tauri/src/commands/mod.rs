//! Tauri Commands (Interface Layer)
//!
//! This module contains all #[tauri::command] functions.
//! These are "glue code" that:
//! - Receive parameters from frontend
//! - Call Core layer functions
//! - Return results
//!
//! Business logic should NOT be in this layer.

pub mod ai;
pub mod assets;
pub mod auth;
pub mod db;
pub mod drawing;
pub mod editor;
pub mod embedding;
pub mod fs;
pub mod graph;
pub mod screenshot;
pub mod search;
pub mod sync;
pub mod tasks;
pub mod maintenance;
pub mod transfer;
