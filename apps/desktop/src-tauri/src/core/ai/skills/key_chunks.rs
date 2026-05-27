//! KeyChunks Extractor (Modular Scoring)
//!
//! Extracts the most informative Top-K text chunks from a note.
//! Each scoring factor is an independent function, easily adjustable.
//!
//! Flow: Candidate filtering → Scoring → Diversity constraint → Top-K

use super::note_profile::NoteProfile;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

// ============================================================================
// Configuration
// ============================================================================

/// Scoring weights — each factor is independently tunable.
#[derive(Debug, Clone)]
pub struct ScoringWeights {
    pub length: f32,
    pub position: f32,
    pub keyword_density: f32,
    pub title_relevance: f32,
    pub edit_heat: f32,
}

impl Default for ScoringWeights {
    fn default() -> Self {
        Self {
            length: 0.25,
            position: 0.15,
            keyword_density: 0.25,
            title_relevance: 0.15,
            edit_heat: 0.20,
        }
    }
}

/// Configuration for KeyChunks extraction.
#[derive(Debug, Clone)]
pub struct KeyChunksConfig {
    /// Number of chunks to extract
    pub top_k: usize,
    /// Scoring weights
    pub weights: ScoringWeights,
    /// Minimum paragraph length (chars) to be a candidate
    pub min_paragraph_chars: usize,
    /// Jaccard overlap threshold for diversity filtering
    pub diversity_threshold: f32,
}

impl Default for KeyChunksConfig {
    fn default() -> Self {
        Self {
            top_k: 5,
            weights: ScoringWeights::default(),
            min_paragraph_chars: 30,
            diversity_threshold: 0.6,
        }
    }
}

/// Presets for different skills
impl KeyChunksConfig {
    /// Summary needs broad coverage
    pub fn for_summary() -> Self {
        Self {
            top_k: 5,
            ..Default::default()
        }
    }

    /// Tagging/Rename/Classification need only core signal
    pub fn for_tagging() -> Self {
        Self {
            top_k: 3,
            ..Default::default()
        }
    }

    /// GhostLink needs minimal targeted chunks
    pub fn for_ghostlink() -> Self {
        Self {
            top_k: 2,
            ..Default::default()
        }
    }
}

// ============================================================================
// Data Types
// ============================================================================

/// A scored chunk candidate
#[derive(Debug, Clone)]
pub struct KeyChunk {
    /// The text content
    pub text: String,
    /// Paragraph index in original document
    pub paragraph_index: usize,
    /// Computed score
    pub score: f32,
    /// Individual factor scores (for debugging/tuning)
    pub factor_scores: FactorScores,
}

/// Breakdown of individual scoring factors
#[derive(Debug, Clone, Default)]
pub struct FactorScores {
    pub length: f32,
    pub position: f32,
    pub keyword_density: f32,
    pub title_relevance: f32,
    pub edit_heat: f32,
}

/// Edit region hint for edit-heat scoring
#[derive(Debug, Clone, Default)]
pub struct EditHint {
    /// Line ranges that were recently edited (0-indexed)
    pub edited_line_ranges: Vec<(usize, usize)>,
}

impl EditHint {
    pub fn empty() -> Self {
        Self {
            edited_line_ranges: vec![],
        }
    }
}

// ============================================================================
// Regex
// ============================================================================

static CODE_BLOCK_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```\w*\n.*?```").unwrap());

static YAML_FRONTMATTER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\s*\n.*?\n---\s*\n?").unwrap());

// ============================================================================
// Public API
// ============================================================================

/// Extract top-K key chunks from content.
///
/// * `content` — raw markdown content
/// * `profile` — pre-computed NoteProfile
/// * `config` — extraction configuration
/// * `edit_hint` — optional delta region info for edit-heat scoring
pub fn extract_key_chunks(
    content: &str,
    profile: &NoteProfile,
    config: &KeyChunksConfig,
    edit_hint: &EditHint,
) -> Vec<KeyChunk> {
    // 1. Prepare clean content (remove frontmatter + code blocks)
    let no_yaml = YAML_FRONTMATTER_REGEX.replace(content, "").to_string();
    let no_code = CODE_BLOCK_REGEX.replace_all(&no_yaml, "").to_string();

    // 2. Build candidate paragraphs
    let candidates = build_candidates(&no_code, config.min_paragraph_chars);
    if candidates.is_empty() {
        return vec![];
    }

    // 3. Build line→paragraph mapping for edit-heat
    let line_to_para = build_line_to_paragraph_map(&no_code, &candidates);

    // 4. Score each candidate
    let total = candidates.len();
    let title_words = tokenize_simple(&profile.title);
    let has_edit_hint = !edit_hint.edited_line_ranges.is_empty();

    let mut scored: Vec<KeyChunk> = candidates
        .into_iter()
        .enumerate()
        .map(|(i, text)| {
            let factors = FactorScores {
                length: score_length(&text),
                position: score_position(i, total),
                keyword_density: score_keyword_density(&text),
                title_relevance: score_title_relevance(&text, &title_words),
                edit_heat: score_edit_heat(i, &line_to_para, edit_hint, has_edit_hint),
            };

            let w = &config.weights;
            let score = factors.length * w.length
                + factors.position * w.position
                + factors.keyword_density * w.keyword_density
                + factors.title_relevance * w.title_relevance
                + factors.edit_heat * w.edit_heat;

            KeyChunk {
                text,
                paragraph_index: i,
                score,
                factor_scores: factors,
            }
        })
        .collect();

    // 5. Sort by score descending
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 6. Diversity filtering (Jaccard)
    apply_diversity_filter(scored, config.top_k, config.diversity_threshold)
}

/// Convenience: extract key chunks as plain text strings.
pub fn extract_key_chunks_text(
    content: &str,
    profile: &NoteProfile,
    config: &KeyChunksConfig,
    edit_hint: &EditHint,
) -> Vec<String> {
    extract_key_chunks(content, profile, config, edit_hint)
        .into_iter()
        .map(|c| c.text)
        .collect()
}

// ============================================================================
// Candidate Building
// ============================================================================

fn build_candidates(clean_content: &str, min_chars: usize) -> Vec<String> {
    clean_content
        .split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| {
            let len = p.chars().count();
            len >= min_chars
                && !p.starts_with('|')     // Skip table rows
                && !p.starts_with("```")   // Shouldn't remain, but safety
                && !p.starts_with("---") // Skip horizontal rules
        })
        .collect()
}

/// Build mapping: paragraph_index → set of line numbers (0-indexed)
fn build_line_to_paragraph_map(content: &str, candidates: &[String]) -> Vec<HashSet<usize>> {
    let mut mapping = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    for candidate in candidates {
        let mut line_set = HashSet::new();
        // Find which lines this candidate spans
        let candidate_first_line = candidate.lines().next().unwrap_or("");
        for (line_idx, &line) in lines.iter().enumerate() {
            if line.trim() == candidate_first_line.trim() {
                // Found start — add contiguous lines
                for j in line_idx..lines.len() {
                    line_set.insert(j);
                    if lines.get(j + 1).map_or(true, |l| l.trim().is_empty()) {
                        break;
                    }
                }
                break;
            }
        }
        mapping.push(line_set);
    }

    mapping
}

// ============================================================================
// Scoring Functions (each independently tunable)
// ============================================================================

/// Length score: 200~800 chars → 1.0, taper outside
pub fn score_length(text: &str) -> f32 {
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
pub fn score_position(index: usize, total: usize) -> f32 {
    if total <= 2 {
        return 1.0;
    }
    if index == 0 {
        return 1.0; // Introduction
    }
    if index == total - 1 {
        return 0.8; // Conclusion
    }
    let normalized = index as f32 / total as f32;
    0.3 + 0.4 * (1.0 - normalized)
}

/// Keyword density: proper nouns, numbers, quotes
pub fn score_keyword_density(text: &str) -> f32 {
    let char_count = text.chars().count().max(1) as f32;
    let mut signal_chars: usize = 0;

    for ch in text.chars() {
        if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
            signal_chars += 1;
        }
    }

    // Count semantic markers
    signal_chars += text.matches('"').count();
    signal_chars += text.matches('「').count();
    signal_chars += text.matches('」').count();
    signal_chars += text.matches('《').count();
    signal_chars += text.matches('》').count();

    let density = signal_chars as f32 / char_count;
    (density * 10.0).min(1.0)
}

/// Title relevance: word overlap between paragraph and title
pub fn score_title_relevance(text: &str, title_words: &[String]) -> f32 {
    if title_words.is_empty() {
        return 0.5;
    }
    let text_words = tokenize_simple(text);
    let overlap = title_words
        .iter()
        .filter(|w| text_words.contains(w))
        .count();
    (overlap as f32 / title_words.len() as f32).min(1.0)
}

/// Edit heat: paragraphs in recently-edited regions score higher
pub fn score_edit_heat(
    _para_index: usize,
    line_to_para: &[HashSet<usize>],
    edit_hint: &EditHint,
    has_hint: bool,
) -> f32 {
    if !has_hint {
        return 0.5; // Neutral when no delta info
    }

    let para_lines = match line_to_para.get(_para_index) {
        Some(lines) if !lines.is_empty() => lines,
        _ => return 0.3,
    };

    // Check overlap with edited ranges
    for &(start, end) in &edit_hint.edited_line_ranges {
        for line in start..=end {
            if para_lines.contains(&line) {
                return 1.0; // This paragraph was recently edited
            }
        }
    }

    0.3 // Not in edit zone
}

// ============================================================================
// Diversity Filter
// ============================================================================

fn apply_diversity_filter(scored: Vec<KeyChunk>, top_k: usize, threshold: f32) -> Vec<KeyChunk> {
    let mut result: Vec<KeyChunk> = Vec::new();

    for candidate in scored {
        if result.len() >= top_k {
            break;
        }
        let candidate_tokens = tokenize_simple(&candidate.text);
        let is_diverse = result.iter().all(|existing| {
            let existing_tokens = tokenize_simple(&existing.text);
            jaccard_similarity(&candidate_tokens, &existing_tokens) < threshold
        });
        if is_diverse {
            result.push(candidate);
        }
    }

    result
}

// ============================================================================
// Utility
// ============================================================================

fn tokenize_simple(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens = Vec::new();

    for word in lower.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let trimmed = word.trim();
        if trimmed.len() >= 2 {
            tokens.push(trimmed.to_string());
        }
    }

    // CJK bigrams
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
        '\u{4E00}'..='\u{9FFF}' |
        '\u{3400}'..='\u{4DBF}' |
        '\u{F900}'..='\u{FAFF}'
    )
}

fn jaccard_similarity(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let set_a: HashSet<&str> = a.iter().map(|s| s.as_str()).collect();
    let set_b: HashSet<&str> = b.iter().map(|s| s.as_str()).collect();
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
    use super::super::note_profile::build_note_profile;
    use super::*;

    fn sample_content() -> String {
        r#"# Rust 所有权机制

## 所有权规则

Rust 的核心特性是所有权系统。每个值都有一个被称为所有者的变量，值在任意时刻只能有一个所有者。当所有者离开作用域时值被丢弃。

## 借用与引用

引用允许你使用值但不获取其所有权。Rust 中有两种引用：不可变引用和可变引用。可变引用有一个重要限制：在同一时间只能有一个可变引用。

## 生命周期

生命周期是 Rust 最独特的特性之一。它确保引用始终有效。编译器通过借用检查器来验证所有引用的有效性。

## 智能指针

Box、Rc、Arc 是 Rust 中常用的智能指针。Box 用于在堆上分配值，Rc 用于单线程引用计数，Arc 用于多线程引用计数。

## 总结

所有权系统是 Rust 的核心创新，它在编译期就保证了内存安全，无需垃圾回收器。"#
            .to_string()
    }

    #[test]
    fn test_extract_key_chunks_basic() {
        let content = sample_content();
        let profile = build_note_profile(&content, "rust_ownership");
        let config = KeyChunksConfig::for_summary();
        let edit_hint = EditHint::empty();

        let chunks = extract_key_chunks(&content, &profile, &config, &edit_hint);

        assert!(chunks.len() <= 5);
        assert!(!chunks.is_empty());

        // Scores should be in descending order
        for i in 1..chunks.len() {
            assert!(chunks[i - 1].score >= chunks[i].score);
        }
    }

    #[test]
    fn test_for_tagging_returns_fewer() {
        let content = sample_content();
        let profile = build_note_profile(&content, "rust_ownership");
        let config = KeyChunksConfig::for_tagging();
        let edit_hint = EditHint::empty();

        let chunks = extract_key_chunks(&content, &profile, &config, &edit_hint);
        assert!(chunks.len() <= 3);
    }

    #[test]
    fn test_edit_heat_boosts_edited_paragraphs() {
        let content = sample_content();
        let profile = build_note_profile(&content, "rust_ownership");

        // With edit hint on later paragraphs
        let edit_hint = EditHint {
            edited_line_ranges: vec![(14, 16)], // "生命周期" section area
        };

        let config = KeyChunksConfig {
            top_k: 5,
            weights: ScoringWeights {
                edit_heat: 0.5, // Boost edit heat weight
                length: 0.15,
                position: 0.10,
                keyword_density: 0.15,
                title_relevance: 0.10,
            },
            ..Default::default()
        };

        let chunks = extract_key_chunks(&content, &profile, &config, &edit_hint);
        assert!(!chunks.is_empty());
        // The first chunk should have high edit_heat score
        let has_heated = chunks.iter().any(|c| c.factor_scores.edit_heat > 0.8);
        assert!(
            has_heated,
            "Expected at least one chunk with high edit heat"
        );
    }

    #[test]
    fn test_diversity_filtering() {
        let content = "Para A about Rust ownership and borrowing rules in detail.\n\n\
                       Para B about Rust ownership and borrowing mechanics explained.\n\n\
                       Para C about Python decorators and metaclass patterns.";

        let profile = build_note_profile(content, "test");
        let config = KeyChunksConfig {
            top_k: 2,
            diversity_threshold: 0.6,
            ..Default::default()
        };
        let edit_hint = EditHint::empty();

        let chunks = extract_key_chunks(content, &profile, &config, &edit_hint);

        // Should not select both Para A and Para B (too similar)
        if chunks.len() == 2 {
            let sim = jaccard_similarity(
                &tokenize_simple(&chunks[0].text),
                &tokenize_simple(&chunks[1].text),
            );
            assert!(
                sim < 0.6,
                "Diversity filter should prevent similar chunks (sim={})",
                sim
            );
        }
    }

    #[test]
    fn test_scoring_weights_custom() {
        let weights = ScoringWeights {
            length: 0.5,
            position: 0.0,
            keyword_density: 0.5,
            title_relevance: 0.0,
            edit_heat: 0.0,
        };
        let sum = weights.length
            + weights.position
            + weights.keyword_density
            + weights.title_relevance
            + weights.edit_heat;
        assert!((sum - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_empty_content() {
        let profile = build_note_profile("", "empty");
        let config = KeyChunksConfig::default();
        let edit_hint = EditHint::empty();
        let chunks = extract_key_chunks("", &profile, &config, &edit_hint);
        assert!(chunks.is_empty());
    }
}
