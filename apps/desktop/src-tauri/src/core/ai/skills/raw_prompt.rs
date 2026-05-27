//! Raw Prompt Skill
//!
//! A passthrough skill that sends the prompt directly to LLM without additional system prompts.
//! Used for classification and other cases where the prompt already contains all instructions.

use super::{Skill, TriggerType};
use anyhow::Result;

/// Raw prompt skill - no system prompt, direct passthrough
pub struct RawPromptSkill;

impl Skill for RawPromptSkill {
    type Output = String;

    fn id(&self) -> &'static str {
        "raw_prompt"
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        vec![TriggerType::OnButton]
    }

    fn system_prompt(&self) -> String {
        // No system prompt - the user prompt contains everything
        String::new()
    }

    fn user_prompt(&self, content: &str) -> String {
        // Direct passthrough - content IS the complete prompt
        content.to_string()
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        // Return raw response for caller to parse
        Ok(raw_response.trim().to_string())
    }

    fn max_output_tokens(&self) -> u32 {
        32768
    }
}
