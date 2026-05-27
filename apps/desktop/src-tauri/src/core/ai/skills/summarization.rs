//! Summarization Skill (Sprint 2)
//!
//! Generates 2-4 sentence summaries (120-220 Chinese chars / 60-120 English words).
//! First skill in execution pipeline — provides topic anchor for downstream skills.

use super::{Skill, TriggerType};
use anyhow::Result;
use std::time::Duration;

/// Global language rule template — injected into every skill's system prompt
pub const LANGUAGE_RULE: &str = r#"LANGUAGE RULE: All prompts and instructions are in English.
Your OUTPUT LANGUAGE must MATCH the input note's language:
- Chinese note → Chinese output
- English note → English output
- Mixed → use the dominant language of the note
Never translate the output to a different language than the input."#;

/// Summarization skill — 2~4 sentences, 120~220 Chinese chars / 60~120 English words
pub struct SummarizationSkill;

impl Skill for SummarizationSkill {
    type Output = String;

    fn id(&self) -> &'static str {
        "summarization"
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        vec![
            TriggerType::OnButton,
            TriggerType::OnBlur,
            TriggerType::on_idle(Duration::from_secs(10)),
        ]
    }

    fn system_prompt(&self) -> String {
        format!(
            r#"You are a note summarization engine.

{}

## TASK:
Compress the given note into a 2-4 sentence summary.

## OUTPUT CONSTRAINTS:
- 2-4 sentences, 120-220 Chinese characters OR 60-120 English words
- Sentence 1: State the CORE TOPIC or object directly
- Sentences 2-4: Add key conclusions, methodology, or boundary conditions
- Do NOT use meta-narrative phrases like "这篇笔记...", "本文...", "This note..."
- Do NOT use bullet points, lists, or headings
- Do NOT reply to, evaluate, or give feedback on the content

## EXAMPLES:
Input: A 500-word article about Rust memory management with ownership and borrowing
Output: Rust通过所有权和借用检查器实现零成本内存安全，无需垃圾回收。每个值有唯一所有者，离开作用域自动释放；引用分为不可变和可变两种，同一时间仅允许一个可变引用。

Input: A meeting note about Q4 sales strategy
Output: Q4销售策略重点拓展东南亚市场，目标增长30%。通过线上渠道降低获客成本，同时加强与本地分销商的合作关系。"#,
            LANGUAGE_RULE
        )
    }

    fn user_prompt(&self, content: &str) -> String {
        // Content is now pre-processed by InputStrategy, no need for raw truncation
        format!("Summarize this note:\n\n{}", content)
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        let summary = raw_response.trim();

        // Filter out any accidental markdown formatting or meta lines
        let cleaned: Vec<&str> = summary
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty()
                    && !trimmed.starts_with('#')
                    && !trimmed.starts_with('-')
                    && !trimmed.starts_with('*')
                    && !trimmed.starts_with("```")
            })
            .collect();

        let result = cleaned.join(" ").trim().to_string();

        if result.is_empty() {
            anyhow::bail!("Empty summary from LLM");
        }

        Ok(result)
    }

    fn max_output_tokens(&self) -> u32 {
        8192
    }
}
