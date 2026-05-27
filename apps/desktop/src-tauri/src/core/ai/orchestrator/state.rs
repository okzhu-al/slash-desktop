//! Editor State Module
//!
//! Defines the editor state enum used by the AI orchestration trigger classifier.

use serde::{Deserialize, Serialize};

/// Editor state for AI skill scheduling
///
/// Four-state model:
/// - Open: Note just loaded (first view)
/// - Active: User is typing
/// - Idle: User paused for 30s
/// - Blur: User left or saved
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorState {
    /// Note just opened (loading state)
    Open,
    /// User is actively typing (content changing)
    Active,
    /// User has stopped typing (idle for 30s)
    Idle,
    /// Editor lost focus or user left the note
    Blur,
}

impl Default for EditorState {
    fn default() -> Self {
        EditorState::Open
    }
}

impl std::fmt::Display for EditorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditorState::Open => write!(f, "open"),
            EditorState::Active => write!(f, "active"),
            EditorState::Idle => write!(f, "idle"),
            EditorState::Blur => write!(f, "blur"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_editor_state_display() {
        assert_eq!(EditorState::Active.to_string(), "active");
        assert_eq!(EditorState::Idle.to_string(), "idle");
        assert_eq!(EditorState::Blur.to_string(), "blur");
    }
}
