//! Tagging Skill (Sprint 2)
//!
//! Extracts 3-5 core topic tags from note content.
//! Supports RAG injection of existing vault tags for reuse.
//! Distinguishes "topic-level inference" (allowed) from "associative divergence" (prohibited).

use super::summarization::LANGUAGE_RULE;
use super::{Skill, TriggerType};
use anyhow::{anyhow, Result};
use slash_core::{extract_json_array, strip_markdown_code_block};
use std::time::Duration;

/// Tagging skill (supports RAG + few-shot injection)
pub struct TaggingSkill {
    existing_tags: Vec<String>,
    /// Few-shot correction examples (from FeedbackStore L2)
    fewshot_examples: Vec<(String, Vec<String>)>,
}

impl TaggingSkill {
    /// Create without RAG or few-shot
    pub fn new() -> Self {
        Self {
            existing_tags: vec![],
            fewshot_examples: vec![],
        }
    }

    /// Create with existing tags for RAG reuse
    pub fn with_existing_tags(tags: Vec<String>) -> Self {
        Self {
            existing_tags: tags,
            fewshot_examples: vec![],
        }
    }

    /// Set few-shot examples from feedback (called by orchestrator)
    pub fn with_fewshot(mut self, examples: Vec<(String, Vec<String>)>) -> Self {
        self.fewshot_examples = examples;
        self
    }
}

impl Default for TaggingSkill {
    fn default() -> Self {
        Self::new()
    }
}

impl Skill for TaggingSkill {
    type Output = Vec<String>;

    fn id(&self) -> &'static str {
        "tagging"
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        vec![
            TriggerType::OnButton,
            TriggerType::OnBlur,
            TriggerType::on_idle(Duration::from_secs(5)),
        ]
    }

    fn system_prompt(&self) -> String {
        let mut prompt = format!(
            r#"You are a precise tag extractor for note-taking.

{}

## TASK:
Extract 3-5 tags that capture the CORE TOPICS and KEY CONCEPTS of the note.

## EXTRACTION RULES:
1. **Prefer explicit terms**: Use concepts explicitly mentioned in the content first
2. **Allow topic-level inference**: If the note's entire content revolves around a concept but never names it explicitly, you MAY extract that concept as a tag
   - Example: A note discussing ownership, borrowing, lifetimes without saying "Rust" → tag "Rust" is allowed
   - Example: A note analyzing Heidegger's Being-in-the-world → tag "存在主义" is allowed
3. **PROHIBIT associative divergence**: Do NOT add tags for related/parent/sibling concepts that are not the note's actual topic
   - Example: A note about Rust → do NOT add "系统编程" or "C++" 
   - Example: A note about React hooks → do NOT add "前端开发" or "JavaScript框架"
4. **Preserve original language**: Chinese content → Chinese tags, English → English
5. **Keep proper nouns intact**: Names, brands, tools use their original form
6. **Prefer short tags**: 1-3 words per tag

## OUTPUT FORMAT:
Raw JSON array of strings, NO markdown code blocks.
Example: ["标签1", "标签2", "标签3"]"#,
            LANGUAGE_RULE
        );

        // Inject existing tags for RAG reuse
        if !self.existing_tags.is_empty() {
            let tags_list = self.existing_tags.join(", ");
            prompt.push_str(&format!(
                r#"

## Existing Tags (PREFER these when semantically matching):
{}

IMPORTANT: Prefer selecting from existing tags above. Only create a new tag if none semantically match."#,
                tags_list
            ));
        }

        prompt
    }

    fn user_prompt(&self, content: &str) -> String {
        let mut prompt = String::new();

        // Inject few-shot examples from feedback (L2)
        if !self.fewshot_examples.is_empty() {
            prompt.push_str("## Recent corrections (learn from these):\n");
            for (snippet, correct_tags) in &self.fewshot_examples {
                let tags_str = correct_tags
                    .iter()
                    .map(|t| format!("\"{}\"", t))
                    .collect::<Vec<_>>()
                    .join(", ");
                prompt.push_str(&format!(
                    "Input: \"{}\" → Correct tags: [{}]\n",
                    snippet, tags_str
                ));
            }
            prompt.push('\n');
        }

        prompt.push_str(&format!("Content:\n{}", content));
        prompt
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        let cleaned = strip_markdown_code_block(raw_response);
        let cleaned = cleaned.trim();
        extract_json_array(cleaned)
            .ok_or_else(|| anyhow!("Failed to parse tags from LLM output: {}", raw_response))
    }

    fn max_output_tokens(&self) -> u32 {
        8192
    }
}
