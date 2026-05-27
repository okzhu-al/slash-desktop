//! Smart Rename Skill (Sprint 2)
//!
//! Auto-generates intelligent titles for notes with default names.
//! Now runs AFTER Summary — uses Summary result as topic anchor for stable naming.

use super::summarization::LANGUAGE_RULE;
use super::{Skill, TriggerType};
use anyhow::Result;
use std::time::Duration;

/// Patterns for detecting default note names that should be auto-renamed
#[allow(dead_code)]
const DEFAULT_NAME_PATTERNS: &[&str] = &["新建笔记", "new note", "untitled", "未命名", "无标题"];

/// Smart Rename Skill — generates titles anchored on Summary output
pub struct SmartRenameSkill;

impl SmartRenameSkill {
    /// Check if a filename matches default note name patterns
    #[allow(dead_code)]
    pub fn is_default_note_name(filename: &str) -> bool {
        let name = filename.trim_end_matches(".md").trim().to_lowercase();
        DEFAULT_NAME_PATTERNS
            .iter()
            .any(|pattern| name.starts_with(*pattern))
    }

    /// Sanitize a title for use as a filename
    pub fn sanitize_filename(title: &str) -> String {
        title
            .chars()
            .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            .collect::<String>()
            .trim()
            .to_string()
            .chars()
            .take(100)
            .collect()
    }
}

impl Skill for SmartRenameSkill {
    type Output = String;

    fn id(&self) -> &'static str {
        "smart_rename"
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        vec![
            TriggerType::OnBlur,
            TriggerType::on_idle(Duration::from_secs(5)),
        ]
    }

    fn system_prompt(&self) -> String {
        format!(
            r#"You are a title generator for personal notes.

{}

## TASK:
Generate a SHORT, DESCRIPTIVE title (6-40 characters) that captures the main topic.

## RULES:
1. The title MUST reflect the note's CORE THEME from the provided summary — not a random detail
2. Be concise: prefer 2-5 words
3. Do NOT use generic words like "笔记", "Notes", "Summary", "Untitled"
4. Do NOT include file extensions or special characters: / \ : * ? " < > |
5. Output ONLY the title text, nothing else

## EXAMPLES:
- Good: "Rust 所有权机制"
- Good: "React Hooks Best Practices"
- Good: "年度目标规划"
- Bad: "笔记" 
- Bad: "我的笔记 - Rust内存管理相关内容总结"
- Bad: "New Note About Something""#,
            LANGUAGE_RULE
        )
    }

    fn user_prompt(&self, content: &str) -> String {
        // Content is now Profile + Summary from InputStrategy, not raw content
        format!("Generate a title for this note:\n\n{}", content)
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        let title = raw_response
            .trim()
            .lines()
            .next()
            .unwrap_or(raw_response.trim())
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();

        if title.is_empty() || title.len() < 2 {
            anyhow::bail!("Generated title is too short");
        }

        Ok(Self::sanitize_filename(&title))
    }

    fn max_output_tokens(&self) -> u32 {
        8192
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_default_note_name() {
        assert!(SmartRenameSkill::is_default_note_name("新建笔记.md"));
        assert!(SmartRenameSkill::is_default_note_name("新建笔记 1.md"));
        assert!(SmartRenameSkill::is_default_note_name("New note.md"));
        assert!(SmartRenameSkill::is_default_note_name("New Note 2.md"));
        assert!(SmartRenameSkill::is_default_note_name("Untitled.md"));
        assert!(SmartRenameSkill::is_default_note_name("未命名.md"));

        assert!(!SmartRenameSkill::is_default_note_name("Rust 内存管理.md"));
        assert!(!SmartRenameSkill::is_default_note_name(
            "My Project Notes.md"
        ));
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(
            SmartRenameSkill::sanitize_filename("Hello World"),
            "Hello World"
        );
        assert_eq!(SmartRenameSkill::sanitize_filename("Test/Name"), "TestName");
        assert_eq!(
            SmartRenameSkill::sanitize_filename("What: is this?"),
            "What is this"
        );
    }
}
