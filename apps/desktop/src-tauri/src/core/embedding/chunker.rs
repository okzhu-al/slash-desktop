//! Content Chunking Module
//!
//! Splits content into chunks for paragraph-level embedding:
//! - Primary: Heading aggregation (H1/H2/H3)
//! - Fallback: Paragraph + length boundaries
//! - Stable heading_path construction

use super::denoise::{denoise, DenoiseConfig};
use super::types::{compute_chunk_id, ChunkKind, ChunkMeta};
use regex::Regex;
use std::sync::LazyLock;

/// Chunking configuration
#[derive(Debug, Clone)]
pub struct ChunkingConfig {
    /// Maximum tokens/chars per chunk (soft limit for splitting)
    pub max_chunk_chars: usize,
    /// Minimum chars for a chunk to be meaningful
    pub min_chunk_chars: usize,
    /// Heading levels to use as primary boundaries (1, 2, 3)
    pub heading_levels: Vec<u8>,
}

impl Default for ChunkingConfig {
    fn default() -> Self {
        Self {
            max_chunk_chars: 1500, // ~400 tokens
            min_chunk_chars: 100,
            heading_levels: vec![1, 2, 3],
        }
    }
}

// Regex to match headings with their level
static HEADING_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(#{1,6})\s+(.+)$").unwrap());

// Regex to split by double newlines (paragraphs)
static PARAGRAPH_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\n+").unwrap());

/// Result of chunking a document
#[derive(Debug)]
pub struct ChunkingResult {
    pub chunks: Vec<ChunkMeta>,
}

/// Chunk a normalized document into embedding-ready pieces
pub fn chunk_document(content: &str, config: &ChunkingConfig) -> ChunkingResult {
    // First normalize the content
    let denoise_config = DenoiseConfig::default();
    let normalized = denoise(content, &denoise_config);

    if normalized.len() < config.min_chunk_chars {
        return ChunkingResult { chunks: vec![] };
    }

    // Try heading-based chunking first
    let chunks = chunk_by_headings(&normalized, config);

    if chunks.is_empty() {
        // Fallback to paragraph chunking
        let chunks = chunk_by_paragraphs(&normalized, config);
        ChunkingResult { chunks }
    } else {
        ChunkingResult { chunks }
    }
}

/// Parse headings and build heading path stack
fn parse_heading(line: &str) -> Option<(u8, String)> {
    HEADING_REGEX.captures(line).map(|caps| {
        let level = caps.get(1).unwrap().as_str().len() as u8;
        let text = caps.get(2).unwrap().as_str().trim().to_string();
        (level, text)
    })
}

/// Build stable heading path from heading stack
fn build_heading_path(stack: &[(u8, String)]) -> String {
    stack
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join(" > ")
}

/// Chunk by heading boundaries
fn chunk_by_headings(content: &str, config: &ChunkingConfig) -> Vec<ChunkMeta> {
    let mut chunks = Vec::new();
    let mut heading_stack: Vec<(u8, String)> = Vec::new();
    let mut current_content = String::new();
    let mut current_offset = 0usize;
    let mut chunk_start_offset = 0usize;

    for line in content.lines() {
        let line_len = line.len() + 1; // +1 for newline

        if let Some((level, text)) = parse_heading(line) {
            // Check if this is a tracked heading level
            if config.heading_levels.contains(&level) {
                // Flush current chunk if any content
                if !current_content.trim().is_empty()
                    && current_content.trim().len() >= config.min_chunk_chars
                {
                    let heading_path = build_heading_path(&heading_stack);
                    let trimmed = current_content.trim().to_string();
                    let chunk_id = compute_chunk_id(&heading_path, &trimmed);

                    chunks.push(ChunkMeta {
                        chunk_id,
                        heading_path,
                        kind: detect_chunk_kind(&trimmed),
                        offset: chunk_start_offset,
                        content: trimmed,
                    });
                }

                // Update heading stack
                // Pop headings at same or higher level
                while let Some((stack_level, _)) = heading_stack.last() {
                    if *stack_level >= level {
                        heading_stack.pop();
                    } else {
                        break;
                    }
                }
                heading_stack.push((level, text));

                // Reset for new chunk
                current_content.clear();
                chunk_start_offset = current_offset + line_len;
            } else {
                // Lower-level heading (H4-H6), include in content
                current_content.push_str(line);
                current_content.push('\n');
            }
        } else {
            current_content.push_str(line);
            current_content.push('\n');
        }

        current_offset += line_len;
    }

    // Flush final chunk
    if !current_content.trim().is_empty() && current_content.trim().len() >= config.min_chunk_chars
    {
        let heading_path = build_heading_path(&heading_stack);
        let trimmed = current_content.trim().to_string();
        let chunk_id = compute_chunk_id(&heading_path, &trimmed);

        chunks.push(ChunkMeta {
            chunk_id,
            heading_path,
            kind: detect_chunk_kind(&trimmed),
            offset: chunk_start_offset,
            content: trimmed,
        });
    }

    // If chunks are too long, apply secondary splitting
    let mut final_chunks = Vec::new();
    for chunk in chunks {
        if chunk.content.len() > config.max_chunk_chars {
            final_chunks.extend(split_long_chunk(chunk, config));
        } else {
            final_chunks.push(chunk);
        }
    }

    final_chunks
}

/// Fallback: chunk by paragraphs
fn chunk_by_paragraphs(content: &str, config: &ChunkingConfig) -> Vec<ChunkMeta> {
    let mut chunks = Vec::new();
    let paragraphs: Vec<&str> = PARAGRAPH_SPLIT.split(content).collect();
    let mut current_chunk = String::new();
    let mut current_offset = 0usize;
    let mut chunk_start = 0usize;

    for para in paragraphs {
        let para_trimmed = para.trim();
        if para_trimmed.is_empty() {
            current_offset += para.len() + 2; // +2 for \n\n
            continue;
        }

        // Check if adding this paragraph would exceed limit
        if !current_chunk.is_empty()
            && current_chunk.len() + para_trimmed.len() > config.max_chunk_chars
        {
            // Flush current chunk
            if current_chunk.len() >= config.min_chunk_chars {
                let chunk_id = compute_chunk_id("", &current_chunk);
                chunks.push(ChunkMeta {
                    chunk_id,
                    heading_path: String::new(),
                    kind: detect_chunk_kind(&current_chunk),
                    offset: chunk_start,
                    content: current_chunk.clone(),
                });
            }
            current_chunk.clear();
            chunk_start = current_offset;
        }

        if !current_chunk.is_empty() {
            current_chunk.push_str("\n\n");
        }
        current_chunk.push_str(para_trimmed);
        current_offset += para.len() + 2;
    }

    // Flush final chunk
    if current_chunk.len() >= config.min_chunk_chars {
        let chunk_id = compute_chunk_id("", &current_chunk);
        chunks.push(ChunkMeta {
            chunk_id,
            heading_path: String::new(),
            kind: detect_chunk_kind(&current_chunk),
            offset: chunk_start,
            content: current_chunk,
        });
    }

    chunks
}

/// Split a long chunk at sentence boundaries
fn split_long_chunk(chunk: ChunkMeta, config: &ChunkingConfig) -> Vec<ChunkMeta> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut part_num = 0;

    for line in chunk.content.lines() {
        if !current.is_empty() && current.len() + line.len() > config.max_chunk_chars {
            // Create sub-chunk
            let sub_path = if chunk.heading_path.is_empty() {
                format!("(part {})", part_num)
            } else {
                format!("{} (part {})", chunk.heading_path, part_num)
            };
            let chunk_id = compute_chunk_id(&sub_path, &current);

            result.push(ChunkMeta {
                chunk_id,
                heading_path: sub_path,
                kind: chunk.kind.clone(),
                offset: chunk.offset,
                content: current.clone(),
            });

            current.clear();
            part_num += 1;
        }

        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }

    // Final sub-chunk
    if current.len() >= config.min_chunk_chars {
        let sub_path = if part_num == 0 {
            chunk.heading_path.clone()
        } else if chunk.heading_path.is_empty() {
            format!("(part {})", part_num)
        } else {
            format!("{} (part {})", chunk.heading_path, part_num)
        };
        let chunk_id = compute_chunk_id(&sub_path, &current);

        result.push(ChunkMeta {
            chunk_id,
            heading_path: sub_path,
            kind: chunk.kind,
            offset: chunk.offset,
            content: current,
        });
    }

    result
}

/// Detect the kind of content in a chunk
fn detect_chunk_kind(content: &str) -> ChunkKind {
    let trimmed = content.trim();

    // Check for code blocks
    if trimmed.contains("```") {
        return ChunkKind::Code;
    }

    // Check for list dominance
    let lines: Vec<&str> = trimmed.lines().collect();
    let list_lines = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("- ")
                || t.starts_with("* ")
                || (t.len() > 2 && t.chars().next().unwrap().is_ascii_digit() && t.contains(". "))
        })
        .count();

    if list_lines > lines.len() / 2 {
        return ChunkKind::List;
    }

    // Check for table
    if trimmed.contains("|") && trimmed.contains("---") {
        return ChunkKind::Table;
    }

    ChunkKind::Text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_heading_chunking() {
        let content = r#"# Title

Introduction paragraph.

## Section One

Content for section one. This is enough text to meet minimum requirements.

## Section Two

Content for section two. Another paragraph with sufficient content.
"#;
        let config = ChunkingConfig {
            min_chunk_chars: 20,
            ..Default::default()
        };
        let result = chunk_document(content, &config);

        assert!(result.chunks.len() >= 2);
        assert!(result.chunks[0].heading_path.contains("Title"));
    }

    #[test]
    fn test_heading_path_stability() {
        let content = "# A\n\n## B\n\nContent under B.\n\n## C\n\nContent under C.";
        let config = ChunkingConfig {
            min_chunk_chars: 10,
            ..Default::default()
        };
        let result = chunk_document(content, &config);

        // Run again - should get same chunk IDs
        let result2 = chunk_document(content, &config);

        for (c1, c2) in result.chunks.iter().zip(result2.chunks.iter()) {
            assert_eq!(c1.chunk_id, c2.chunk_id);
        }
    }

    #[test]
    fn test_paragraph_fallback() {
        let content = "First paragraph with enough content to pass minimum.

Second paragraph also with sufficient content.

Third paragraph here.";
        let config = ChunkingConfig {
            min_chunk_chars: 20,
            max_chunk_chars: 100,
            heading_levels: vec![1, 2, 3],
        };
        let result = chunk_document(content, &config);

        // Should use paragraph chunking since no headings
        assert!(result.chunks.len() >= 1);
    }

    #[test]
    fn test_chunk_kind_detection() {
        assert_eq!(detect_chunk_kind("Normal text here"), ChunkKind::Text);
        assert_eq!(detect_chunk_kind("```python\ncode\n```"), ChunkKind::Code);
        assert_eq!(
            detect_chunk_kind("- item 1\n- item 2\n- item 3"),
            ChunkKind::List
        );
    }
}
