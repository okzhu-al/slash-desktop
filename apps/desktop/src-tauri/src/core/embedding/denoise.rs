//! Content Normalize Module
//!
//! Normalizes markdown content for better embedding quality:
//! - Removes YAML frontmatter
//! - Preserves heading structure
//! - Preserves list structure
//! - Controls code block budget
//! - Converts wikilinks to plain text
//! - Normalizes whitespace

use regex::Regex;
use std::sync::LazyLock;

use super::types::CodeBlockBudget;

/// Denoise (Normalize) configuration
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DenoiseConfig {
    /// Remove YAML frontmatter (---...---)
    pub remove_yaml_frontmatter: bool,
    /// Preserve heading structure (# ## ###)
    pub preserve_headings: bool,
    /// Preserve list structure (- * 1.)
    pub preserve_lists: bool,
    /// Code block budget control
    pub code_budget: CodeBlockBudget,
    /// Convert wikilinks to plain text ([[link]] -> link)
    pub normalize_wikilinks: bool,
    /// Normalize consecutive whitespace
    pub normalize_whitespace: bool,
    /// Minimum content length after normalize
    pub min_length: usize,
    /// Remove LaTeX math formatting ($...$, $$...$$) and preserve content
    pub clean_latex_math: bool,
    /// Clean markdown styling characters (**, _, ~~, ` etc.) and preserve content
    pub clean_markdown_styling: bool,
}

impl Default for DenoiseConfig {
    fn default() -> Self {
        Self {
            remove_yaml_frontmatter: true,
            preserve_headings: true,
            preserve_lists: true,
            code_budget: CodeBlockBudget::default(),
            normalize_wikilinks: true,
            normalize_whitespace: true,
            min_length: 50,
            clean_latex_math: true,
            clean_markdown_styling: true,
        }
    }
}

// Pre-compiled regex patterns for performance
static YAML_FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\s*\n.*?\n---\s*\n?").unwrap());

static CODE_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```(\w*)\n(.*?)```").unwrap());

static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap());

static MULTIPLE_NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

static MULTIPLE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());

// Log-like content patterns (stacktraces, JSON arrays, etc.)
static LOG_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(stacktrace|exception|error\s+at|at\s+\w+\.\w+|^\s*\[\s*\{|\{\s*"|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})"#).unwrap()
});

// LaTeX and Markdown styling patterns
static MATH_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\$\$(.*?)\$\$").unwrap());
static MATH_INLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$([^\$\s\n](?:[^\$\n]*?[^\$\s\n])?)\$").unwrap());

static MARKDOWN_BOLD_AST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*([^\*\n]+)\*\*").unwrap());
static MARKDOWN_ITALIC_AST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*([^\*\n]+)\*").unwrap());
static MARKDOWN_BOLD_UND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"__([^\_\n]+)__").unwrap());
static MARKDOWN_ITALIC_UND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_([^\_\n]+)_").unwrap());
static MARKDOWN_STRIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~~([^~\n]+)~~").unwrap());
static MARKDOWN_INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`\n]+)`").unwrap());

/// Normalize content according to configuration
///
/// # Arguments
/// * `content` - Raw markdown content
/// * `config` - Normalize configuration
///
/// # Returns
/// Cleaned content ready for embedding
pub fn denoise(content: &str, config: &DenoiseConfig) -> String {
    let mut result = content.to_string();

    // 1. Remove YAML frontmatter
    if config.remove_yaml_frontmatter {
        result = YAML_FRONTMATTER.replace(&result, "").to_string();
    }

    // 2. Process code blocks with budget control
    result = process_code_blocks(&result, &config.code_budget);

    // 3. Clean LaTeX math formatting
    if config.clean_latex_math {
        result = MATH_BLOCK.replace_all(&result, "$1").to_string();
        result = MATH_INLINE.replace_all(&result, "$1").to_string();
    }

    // 4. Convert wikilinks to plain text (preserve the link text)
    if config.normalize_wikilinks {
        result = WIKILINK.replace_all(&result, "$1").to_string();
    }

    // 5. Clean markdown styling formatting
    if config.clean_markdown_styling {
        result = MARKDOWN_BOLD_AST.replace_all(&result, "$1").to_string();
        result = MARKDOWN_BOLD_UND.replace_all(&result, "$1").to_string();
        result = MARKDOWN_ITALIC_AST.replace_all(&result, "$1").to_string();
        result = MARKDOWN_ITALIC_UND.replace_all(&result, "$1").to_string();
        result = MARKDOWN_STRIKE.replace_all(&result, "$1").to_string();
        result = MARKDOWN_INLINE_CODE.replace_all(&result, "$1").to_string();
    }

    // 6. Normalize whitespace (preserves headings and lists as-is)
    if config.normalize_whitespace {
        result = MULTIPLE_NEWLINES.replace_all(&result, "\n\n").to_string();
        result = MULTIPLE_SPACES.replace_all(&result, " ").to_string();
        result = result.trim().to_string();
    }

    result
}

/// Process code blocks with budget control
fn process_code_blocks(content: &str, budget: &CodeBlockBudget) -> String {
    CODE_BLOCK
        .replace_all(content, |caps: &regex::Captures| {
            let lang = caps.get(1).map_or("", |m| m.as_str());
            let code = caps.get(2).map_or("", |m| m.as_str());

            // Check if this looks like log content
            let is_log_like = budget.aggressive_log_truncate && LOG_PATTERN.is_match(code);

            // Apply more aggressive limits for log-like content
            let max_lines = if is_log_like { 20 } else { budget.max_lines };
            let max_chars = if is_log_like { 1500 } else { budget.max_chars };

            let truncated = truncate_code(code, max_lines, max_chars);

            if truncated.len() < code.len() {
                format!("```{}\n{}...(truncated)\n```", lang, truncated)
            } else {
                format!("```{}\n{}```", lang, code)
            }
        })
        .to_string()
}

/// Truncate code to fit within budget
fn truncate_code(code: &str, max_lines: usize, max_chars: usize) -> String {
    let lines: Vec<&str> = code.lines().collect();

    // First limit by lines
    let line_limited: String = if lines.len() > max_lines {
        lines[..max_lines].join("\n")
    } else {
        code.to_string()
    };

    // Then limit by characters
    if line_limited.len() > max_chars {
        // Find a safe cut point (end of a line if possible)
        let mut cut_point = max_chars;
        if let Some(newline_pos) = line_limited[..max_chars].rfind('\n') {
            cut_point = newline_pos;
        }
        line_limited[..cut_point].to_string()
    } else {
        line_limited
    }
}

/// Compute SHA256 hash of content
pub fn content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_yaml_frontmatter() {
        let content = "---
title: Test
tags: [a, b]
---

Actual content here.";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(result, "Actual content here.");
    }

    #[test]
    fn test_preserve_headings() {
        let content = "# Main Title

Some text

## Section

More text";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert!(result.contains("# Main Title"));
        assert!(result.contains("## Section"));
    }

    #[test]
    fn test_preserve_lists() {
        let content = "Items:
- First
- Second

1. One
2. Two";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert!(result.contains("- First"));
        assert!(result.contains("1. One"));
    }

    #[test]
    fn test_convert_wikilinks() {
        let content = "Check out [[My Note]] and [[Other|Display Name]].";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(result, "Check out My Note and Other.");
    }

    #[test]
    fn test_code_block_preserved_under_budget() {
        let content = r#"Code:
```python
x = 1
```
More text"#;
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert!(result.contains("x = 1"));
        assert!(!result.contains("truncated"));
    }

    #[test]
    fn test_code_block_truncated_over_budget() {
        // Create a code block with many lines
        let many_lines = (0..150)
            .map(|i| format!("line {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!("Code:\n```python\n{}\n```\nMore text", many_lines);
        let config = DenoiseConfig::default();
        let result = denoise(&content, &config);
        assert!(result.contains("truncated"));
    }

    #[test]
    fn test_normalize_whitespace() {
        let content = "Line 1




Line 2   with   spaces";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(
            result,
            "Line 1\n\nLine 2 with spaces"
        );
    }

    #[test]
    fn test_content_hash() {
        let hash1 = content_hash("Hello");
        let hash2 = content_hash("Hello");
        let hash3 = content_hash("World");
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_clean_latex_math() {
        let content = "Here is an equation: $$E = mc^2$$ and another inline one $a^2 + b^2 = c^2$. Also, the product costs $5 and $10, which should not be matched.";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(
            result,
            "Here is an equation: E = mc^2 and another inline one a^2 + b^2 = c^2. Also, the product costs $5 and $10, which should not be matched."
        );
    }

    #[test]
    fn test_clean_markdown_styling() {
        let content = "This is **bold**, __also bold__, *italic*, _also italic_, ~~strikethrough~~, and `inline code`. But * list item should not be matched.";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(
            result,
            "This is bold, also bold, italic, also italic, strikethrough, and inline code. But * list item should not be matched."
        );
    }

    #[test]
    fn test_bullet_list_not_broken() {
        let content = "Items:\n* Item 1\n* Item 2\n* Item 3";
        let config = DenoiseConfig::default();
        let result = denoise(content, &config);
        assert_eq!(
            result,
            "Items:\n* Item 1\n* Item 2\n* Item 3"
        );
    }
}
