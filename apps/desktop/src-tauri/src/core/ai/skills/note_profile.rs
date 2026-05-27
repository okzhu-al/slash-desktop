//! NoteProfile Generator (Program-based, no LLM)
//!
//! Extracts a structured summary of a note's content for AI skill input.
//! Reuses denoise + heading parsing from the embedding pipeline.

use regex::Regex;
use std::sync::LazyLock;

// ============================================================================
// Data Structures
// ============================================================================

/// Structured profile of a note — computed purely by program, no LLM involved.
#[derive(Debug, Clone)]
pub struct NoteProfile {
    /// Note title (filename stem or first H1)
    pub title: String,
    /// H2/H3 heading paths
    pub headings: Vec<String>,
    /// Explicit [[wikilinks]] found in the content
    pub explicit_links: Vec<String>,
    /// Top-K key paragraphs (scored by length, position, keyword density)
    pub key_paragraphs: Vec<String>,
    /// Code block summaries (language + first function signature)
    pub code_summaries: Vec<String>,
    /// Total character count of cleaned content
    pub char_count: usize,
    /// Whether the note has H2/H3 structure
    pub has_structure: bool,
    /// Noise ratio: (code_block_chars + table_chars + log_chars) / total_chars
    pub noise_ratio: f32,
}

impl NoteProfile {
    /// Serialize to prompt text (500~2000 chars).
    pub fn to_prompt_text(&self) -> String {
        let mut parts = Vec::new();

        parts.push(format!("Title: {}", self.title));

        if !self.headings.is_empty() {
            let h = self.headings.join(", ");
            parts.push(format!("Structure: {}", h));
        }

        if !self.explicit_links.is_empty() {
            let links: Vec<&str> = self
                .explicit_links
                .iter()
                .take(10)
                .map(|s| s.as_str())
                .collect();
            parts.push(format!("Links: {}", links.join(", ")));
        }

        if !self.code_summaries.is_empty() {
            let cs: Vec<&str> = self
                .code_summaries
                .iter()
                .take(5)
                .map(|s| s.as_str())
                .collect();
            parts.push(format!("Code: {}", cs.join("; ")));
        }

        if !self.key_paragraphs.is_empty() {
            parts.push("Key content:".to_string());
            for (i, p) in self.key_paragraphs.iter().enumerate() {
                // Truncate each paragraph to ~400 chars
                let truncated = if p.chars().count() > 400 {
                    format!("{}...", p.chars().take(397).collect::<String>())
                } else {
                    p.clone()
                };
                parts.push(format!("  [{}] {}", i + 1, truncated));
            }
        }

        let result = parts.join("\n");
        // Hard cap at 2000 chars
        if result.chars().count() > 2000 {
            format!("{}...", result.chars().take(1997).collect::<String>())
        } else {
            result
        }
    }
}

// ============================================================================
// Regex Patterns
// ============================================================================

static HEADING_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(#{1,6})\s+(.+)$").unwrap());

static WIKILINK_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap());

static CODE_BLOCK_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```(\w*)\n(.*?)```").unwrap());

static YAML_FRONTMATTER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\s*\n.*?\n---\s*\n?").unwrap());

static TABLE_ROW_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\|.*\|$").unwrap());

static FN_SIGNATURE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?(?:async\s+)?(?:fn|def|function|func|class|interface|struct|enum|const|let|var)\s+\w+")
        .unwrap()
});

// ============================================================================
// Profile Builder
// ============================================================================

/// Build a NoteProfile from raw markdown content.
///
/// `filename` is the note's filename stem (without extension), used as title fallback.
pub fn build_note_profile(content: &str, filename: &str) -> NoteProfile {
    // Remove YAML frontmatter for analysis
    let cleaned = YAML_FRONTMATTER_REGEX.replace(content, "").to_string();

    let char_count = cleaned.chars().count();

    // 1. Extract title: first H1, or filename
    let title = extract_title(&cleaned, filename);

    // 2. Extract headings (H2/H3)
    let headings = extract_headings(&cleaned);
    let has_structure = !headings.is_empty();

    // 3. Extract wikilinks
    let explicit_links = extract_wikilinks(&cleaned);

    // 4. Extract code summaries + measure noise
    let (code_summaries, code_chars) = extract_code_summaries(&cleaned);
    let table_chars = measure_table_chars(&cleaned);
    let noise_chars = code_chars + table_chars;
    let noise_ratio = if char_count > 0 {
        noise_chars as f32 / char_count as f32
    } else {
        0.0
    };

    // 5. Extract key paragraphs (top-K scored by length + position + keyword density + title relevance)
    // Default K=5 — caller can truncate for specific skills
    let key_paragraphs = extract_key_paragraphs(&cleaned, &title, 5);

    NoteProfile {
        title,
        headings,
        explicit_links,
        key_paragraphs,
        code_summaries,
        char_count,
        has_structure,
        noise_ratio,
    }
}

// ============================================================================
// Extraction Functions
// ============================================================================

fn extract_title(content: &str, filename: &str) -> String {
    // Find first H1
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") && !trimmed.starts_with("## ") {
            return trimmed[2..].trim().to_string();
        }
    }
    // Fallback to filename
    filename.to_string()
}

fn extract_headings(content: &str) -> Vec<String> {
    let mut headings = Vec::new();
    for caps in HEADING_REGEX.captures_iter(content) {
        let level = caps.get(1).unwrap().as_str().len();
        let text = caps.get(2).unwrap().as_str().trim();
        if level >= 2 && level <= 3 {
            let prefix = if level == 2 { "##" } else { "###" };
            headings.push(format!("{} {}", prefix, text));
        }
    }
    headings
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    for caps in WIKILINK_REGEX.captures_iter(content) {
        let link = caps.get(1).unwrap().as_str().trim().to_string();
        if !links.contains(&link) {
            links.push(link);
        }
    }
    links
}

/// Returns (summaries, total_code_chars)
fn extract_code_summaries(content: &str) -> (Vec<String>, usize) {
    let mut summaries = Vec::new();
    let mut total_chars = 0;

    for caps in CODE_BLOCK_REGEX.captures_iter(content) {
        let lang = caps.get(1).map_or("", |m| m.as_str());
        let code = caps.get(2).map_or("", |m| m.as_str());
        total_chars += code.len();

        // Extract first function/class signature from code
        let sig = FN_SIGNATURE_REGEX
            .find(code)
            .map(|m| m.as_str().to_string());

        let summary = if let Some(sig) = sig {
            if lang.is_empty() {
                sig
            } else {
                format!("[{}] {}", lang, sig)
            }
        } else if !lang.is_empty() {
            format!("[{}] ({} lines)", lang, code.lines().count())
        } else {
            continue; // Skip anonymous code blocks with no signatures
        };

        if !summaries.contains(&summary) {
            summaries.push(summary);
        }
    }

    (summaries, total_chars)
}

fn measure_table_chars(content: &str) -> usize {
    TABLE_ROW_REGEX
        .find_iter(content)
        .map(|m| m.as_str().len())
        .sum()
}

// ============================================================================
// Key Paragraph Extraction (scoring-based)
// ============================================================================

/// Candidate paragraph with its computed score
#[derive(Debug)]
struct ScoredParagraph {
    text: String,
    score: f32,
}

/// Extract top-K key paragraphs using multi-factor scoring.
///
/// Scoring factors (without edit-heat — that's added by KeyChunks layer):
/// - Length score (0.30): 200~800 chars is optimal
/// - Position score (0.20): first and last paragraphs get bonus
/// - Keyword density (0.30): proper nouns, numbers, quotes
/// - Title relevance (0.20): word overlap with note title
fn extract_key_paragraphs(content: &str, title: &str, top_k: usize) -> Vec<String> {
    // Remove code blocks for paragraph extraction
    let no_code = CODE_BLOCK_REGEX.replace_all(content, "").to_string();

    // Split into paragraphs by double newlines
    let paragraphs: Vec<&str> = no_code
        .split("\n\n")
        .map(|p| p.trim())
        .filter(|p| {
            let len = p.chars().count();
            len >= 30 // Skip very short fragments
                && !p.starts_with('|') // Skip table rows
                && !p.starts_with("```")
        })
        .collect();

    if paragraphs.is_empty() {
        return vec![];
    }

    let total = paragraphs.len();
    let title_words = tokenize_for_overlap(title);

    let mut scored: Vec<ScoredParagraph> = paragraphs
        .iter()
        .enumerate()
        .map(|(i, &text)| {
            let score = score_length(text) * 0.30
                + score_position(i, total) * 0.20
                + score_keyword_density(text) * 0.30
                + score_title_relevance(text, &title_words) * 0.20;
            ScoredParagraph {
                text: text.to_string(),
                score,
            }
        })
        .collect();

    // Sort by score descending
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Apply diversity constraint: remove candidates with >60% Jaccard overlap
    let mut result = Vec::new();
    for candidate in scored {
        if result.len() >= top_k {
            break;
        }
        let candidate_tokens = tokenize_for_overlap(&candidate.text);
        let is_diverse = result.iter().all(|existing: &String| {
            let existing_tokens = tokenize_for_overlap(existing);
            jaccard_similarity(&candidate_tokens, &existing_tokens) < 0.6
        });
        if is_diverse {
            result.push(candidate.text);
        }
    }

    result
}

// ============================================================================
// Scoring Functions (modular, independently adjustable)
// ============================================================================

/// Length score: 200~800 chars → 1.0, taper outside
fn score_length(text: &str) -> f32 {
    let len = text.chars().count();
    if len < 50 {
        0.1
    } else if len < 200 {
        0.3 + 0.7 * (len as f32 - 50.0) / 150.0
    } else if len <= 800 {
        1.0
    } else if len <= 1500 {
        1.0 - 0.3 * (len as f32 - 800.0) / 700.0
    } else {
        0.5
    }
}

/// Position score: first and last paragraphs get bonus
fn score_position(index: usize, total: usize) -> f32 {
    if total <= 2 {
        return 1.0;
    }
    if index == 0 {
        return 1.0; // Intro
    }
    if index == total - 1 {
        return 0.8; // Conclusion
    }
    // Middle paragraphs: slight decay from front
    let normalized = index as f32 / total as f32;
    0.3 + 0.4 * (1.0 - normalized)
}

/// Keyword density: proper nouns, numbers, quotes, technical terms
fn score_keyword_density(text: &str) -> f32 {
    let char_count = text.chars().count().max(1) as f32;
    let mut signal_chars = 0;

    for ch in text.chars() {
        if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
            signal_chars += 1;
        }
    }

    // Count quotes and brackets
    signal_chars += text.matches('"').count();
    signal_chars += text.matches('「').count();
    signal_chars += text.matches('」').count();
    signal_chars += text.matches('《').count();
    signal_chars += text.matches('》').count();

    let density = signal_chars as f32 / char_count;
    // Normalize to [0, 1] with diminishing returns
    (density * 10.0).min(1.0)
}

/// Title relevance: word overlap between paragraph and title
fn score_title_relevance(text: &str, title_words: &[String]) -> f32 {
    if title_words.is_empty() {
        return 0.5; // Neutral when no title
    }
    let text_words = tokenize_for_overlap(text);
    let overlap = title_words
        .iter()
        .filter(|w| text_words.contains(w))
        .count();
    let ratio = overlap as f32 / title_words.len() as f32;
    ratio.min(1.0)
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Simple tokenizer for overlap measurement.
/// Splits on whitespace and CJK character boundaries, lowercased.
fn tokenize_for_overlap(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens = Vec::new();

    // Split ASCII words
    for word in lower.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let trimmed = word.trim();
        if trimmed.len() >= 2 {
            tokens.push(trimmed.to_string());
        }
    }

    // Add CJK bigrams
    let chars: Vec<char> = lower.chars().collect();
    for window in chars.windows(2) {
        if is_cjk(window[0]) && is_cjk(window[1]) {
            tokens.push(format!("{}{}", window[0], window[1]));
        }
    }

    tokens
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}' |   // CJK Unified
        '\u{3400}'..='\u{4DBF}' |   // CJK Extension A
        '\u{F900}'..='\u{FAFF}'     // CJK Compatibility
    )
}

/// Jaccard similarity between two token sets
fn jaccard_similarity(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let set_a: std::collections::HashSet<&str> = a.iter().map(|s| s.as_str()).collect();
    let set_b: std::collections::HashSet<&str> = b.iter().map(|s| s.as_str()).collect();
    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    if union == 0 {
        0.0
    } else {
        intersection as f32 / union as f32
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_basic_profile() {
        let content = r#"---
title: Test
tags: [a]
---

# Rust 所有权机制

## 所有权规则

Rust 的核心特性是所有权系统。每个值都有一个被称为所有者的变量，值在任意时刻只能有一个所有者。

## 借用与引用

引用允许你使用值但不获取其所有权。可变引用有一个限制：在同一时间只能有一个可变引用。

## 生命周期

生命周期确保引用始终有效。编译器通过借用检查器来验证所有引用的有效性。

```rust
pub fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
```

参见 [[Rust 入门]] 和 [[内存安全]]。
"#;

        let profile = build_note_profile(content, "rust_ownership");
        assert_eq!(profile.title, "Rust 所有权机制");
        assert!(profile.has_structure);
        assert!(profile.headings.len() >= 2);
        assert!(profile.explicit_links.contains(&"Rust 入门".to_string()));
        assert!(profile.explicit_links.contains(&"内存安全".to_string()));
        assert!(!profile.code_summaries.is_empty());
        assert!(profile.noise_ratio < 0.5);
    }

    #[test]
    fn test_title_fallback_to_filename() {
        let content = "Some content without any headings.";
        let profile = build_note_profile(content, "my_note");
        assert_eq!(profile.title, "my_note");
        assert!(!profile.has_structure);
    }

    #[test]
    fn test_noise_ratio_high_for_code_heavy() {
        let code = "x = 1\n".repeat(100);
        let content = format!("Short intro.\n\n```python\n{}```\n", code);
        let profile = build_note_profile(&content, "code_note");
        assert!(
            profile.noise_ratio > 0.5,
            "noise_ratio={}",
            profile.noise_ratio
        );
    }

    #[test]
    fn test_to_prompt_text_length() {
        let long_content = "## Section\n\n".to_string() + &"A".repeat(5000);
        let profile = build_note_profile(&long_content, "test");
        let prompt = profile.to_prompt_text();
        assert!(prompt.chars().count() <= 2000);
    }

    #[test]
    fn test_scoring_functions() {
        // Length
        assert!(score_length("x".repeat(400).as_str()) > score_length("x".repeat(40).as_str()));
        // Position
        assert!(score_position(0, 10) > score_position(5, 10));
        // Keyword density
        assert!(score_keyword_density("NASA 2024 report") > score_keyword_density("a simple note"));
    }

    #[test]
    fn test_jaccard_diversity() {
        let a = tokenize_for_overlap("Rust ownership and borrowing");
        let b = tokenize_for_overlap("Rust ownership and memory safety");
        let c = tokenize_for_overlap("Python decorators and metaclasses");
        let sim_ab = jaccard_similarity(&a, &b);
        let sim_ac = jaccard_similarity(&a, &c);
        assert!(sim_ab > sim_ac, "ab={} ac={}", sim_ab, sim_ac);
    }
}
