//! InputStrategy Layer
//!
//! Determines the optimal input strategy for each AI skill.
//! Replaces raw content feeding with NoteProfile + KeyChunks based approaches.

use super::key_chunks::{extract_key_chunks_text, EditHint, KeyChunksConfig};
use super::note_profile::NoteProfile;

// ============================================================================
// Input Mode
// ============================================================================

/// Input mode for AI skills
#[derive(Debug, Clone)]
pub enum InputMode {
    /// Full content (short + low-noise notes)
    FullContent,
    /// NoteProfile only (Rename/Classification)
    ProfileOnly,
    /// Profile + KeyChunks (Summary/Tagging)
    ProfileWithChunks { top_k: usize },
    /// Profile + Targeted Chunks (GhostLink/Relations)
    ProfileWithTargeted { targets: Vec<String> },
}

// ============================================================================
// Strategy Resolution
// ============================================================================

/// Determine whether to use FullContent mode.
///
/// Criteria: "short + low noise" (not "short + no structure")
/// - Short notes with H2 headings are safe to feed whole
/// - Short notes with high noise (code/logs/tables) should NOT be fed whole
pub fn should_use_full_content(profile: &NoteProfile, content: &str) -> bool {
    let char_count = content.chars().count();
    char_count < 3000             // Short note
        && profile.noise_ratio < 0.3 // Low noise (< 30% code/tables/logs)
}

/// Build the final input text for a skill, given its input mode.
///
/// * `content` — raw note content
/// * `profile` — pre-computed NoteProfile
/// * `mode` — the skill's declared input mode
/// * `edit_hint` — optional edit region for KeyChunks scoring
/// * `extra_context` — additional context (e.g., Summary result, Tags)
pub fn build_skill_input(
    content: &str,
    profile: &NoteProfile,
    mode: &InputMode,
    edit_hint: &EditHint,
    extra_context: Option<&str>,
) -> String {
    // Check if FullContent override applies
    let effective_mode = if should_use_full_content(profile, content) {
        &InputMode::FullContent
    } else {
        mode
    };

    let mut parts = Vec::new();

    match effective_mode {
        InputMode::FullContent => {
            parts.push(content.to_string());
        }
        InputMode::ProfileOnly => {
            parts.push(profile.to_prompt_text());
        }
        InputMode::ProfileWithChunks { top_k } => {
            parts.push(profile.to_prompt_text());
            parts.push(String::new()); // separator

            let config = KeyChunksConfig {
                top_k: *top_k,
                ..Default::default()
            };
            let chunks = extract_key_chunks_text(content, profile, &config, edit_hint);
            if !chunks.is_empty() {
                parts.push("Key excerpts:".to_string());
                for (i, chunk) in chunks.iter().enumerate() {
                    parts.push(format!("[{}] {}", i + 1, chunk));
                }
            }
        }
        InputMode::ProfileWithTargeted { targets } => {
            parts.push(profile.to_prompt_text());
            if !targets.is_empty() {
                parts.push(String::new());
                parts.push("Related notes:".to_string());
                for (i, t) in targets.iter().enumerate() {
                    parts.push(format!("[{}] {}", i + 1, t));
                }
            }
        }
    }

    // Append extra context (e.g., Summary, Tags from previous steps)
    if let Some(ctx) = extra_context {
        if !ctx.is_empty() {
            parts.push(String::new());
            parts.push(ctx.to_string());
        }
    }

    parts.join("\n")
}

// ============================================================================
// Token Budget Estimation
// ============================================================================

/// 已知模型的 context window 查找表（tokens）
///
/// 按模型名前缀匹配（忽略 `:tag` 后缀）。
/// 未匹配到的模型降级到 8192 tokens（保守默认值）。
fn lookup_context_window(model: &str) -> Option<u32> {
    // 去掉 :tag 后缀, e.g. "qwen2.5:7b" -> "qwen2.5"
    let base = model.split(':').next().unwrap_or(model);

    // 按从长到短前缀匹配，确保更精确的匹配优先
    if base.starts_with("qwen2.5") || base.starts_with("qwen2") || base.starts_with("qwen3") {
        Some(32768) // Qwen 系列
    } else if base.starts_with("qwen") {
        Some(32768)
    } else if base.starts_with("llama3.2") || base.starts_with("llama3.1") {
        Some(131072) // Llama 3.1/3.2: 128k context
    } else if base.starts_with("llama3") || base.starts_with("llama2") {
        Some(8192)
    } else if base.starts_with("gemma2") || base.starts_with("gemma") {
        Some(8192)
    } else if base.starts_with("phi4") {
        Some(16384)
    } else if base.starts_with("phi3") {
        Some(4096)
    } else if base.starts_with("mistral") || base.starts_with("mixtral") {
        Some(32768)
    } else if base.starts_with("deepseek") {
        Some(16384)
    } else if base.starts_with("command-r") {
        Some(131072) // Cohere Command-R
    } else if base.starts_with("gpt-4") {
        Some(131072) // OpenAI GPT-4 Turbo / GPT-4o
    } else if base.starts_with("gpt-3.5") {
        Some(16385)
    } else if base.starts_with("claude") {
        Some(200000) // Anthropic Claude
    } else {
        None
    }
}

/// 基于模型名估算可用输入字符数
///
/// 通过 `lookup_context_window` 查找已知模型的 context window，
/// 未知模型降级到 8192 tokens。
/// 保守估算: 1 token ≈ 3 chars (中英文混合平均值)
/// 预留 `max_output_tokens + 200` tokens 给输出和 system prompt
pub fn estimate_max_input_chars(model: &str, max_output_tokens: u32) -> usize {
    let ctx = lookup_context_window(model).unwrap_or(8192);
    let available = ctx.saturating_sub(max_output_tokens + 200);
    (available as usize) * 3
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::note_profile::build_note_profile;
    use super::*;

    #[test]
    fn test_full_content_for_short_clean_note() {
        let content = "A short note about Rust.\n\n## Section\n\nSome details.";
        let profile = build_note_profile(content, "test");
        assert!(should_use_full_content(&profile, content));
    }

    #[test]
    fn test_no_full_content_for_noisy_note() {
        let code = "x = 1\n".repeat(200);
        let content = format!("Short.\n\n```python\n{}```\n", code);
        let profile = build_note_profile(&content, "test");
        assert!(!should_use_full_content(&profile, &content));
    }

    #[test]
    fn test_no_full_content_for_long_note() {
        let content = "A ".repeat(3000);
        let profile = build_note_profile(&content, "test");
        assert!(!should_use_full_content(&profile, &content));
    }

    #[test]
    fn test_build_skill_input_profile_only() {
        let content = "# Title\n\n## A\n\nParagraph about topic A is here.\n\n## B\n\nParagraph about topic B is here.";
        let _profile = build_note_profile(content, "test");
        // Force long content so FullContent override doesn't kick in
        let long_content = content.to_string() + &"x".repeat(3000);
        let long_profile = build_note_profile(&long_content, "test");

        let result = build_skill_input(
            &long_content,
            &long_profile,
            &InputMode::ProfileOnly,
            &EditHint::empty(),
            None,
        );
        assert!(result.contains("Title:"));
        assert!(!result.contains(&"x".repeat(100)));
    }

    #[test]
    fn test_build_skill_input_with_extra_context() {
        let content = "Some content here.";
        let profile = build_note_profile(content, "test");
        let result = build_skill_input(
            content,
            &profile,
            &InputMode::FullContent,
            &EditHint::empty(),
            Some("Summary: This is about testing."),
        );
        assert!(result.contains("Summary: This is about testing."));
    }
}
