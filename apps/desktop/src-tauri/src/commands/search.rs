//! Hybrid Search Commands
//!
//! Provides FTS5 keyword search + semantic vector search with weighted merging.
//! Supports HyDE (Hypothetical Document Embedding) for enhanced semantic search.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::query_expander::hyde_expand;
use crate::{AIStateWrapper, DbStateWrapper};

/// Search result item
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
    pub match_type: String,   // "keyword", "semantic", "both"
    pub match_source: String, // "summary", "content", "title" - where match was found
}

/// Task search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSearchResult {
    pub id: i64,
    pub note_path: String,
    pub note_title: String,
    pub raw_text: String,
    pub is_completed: bool,
    pub due_date: Option<String>,
    pub line_number: i32,
}

/// Combined search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridSearchResult {
    pub results: Vec<SearchResultItem>,
    pub tasks: Vec<TaskSearchResult>,
    pub keyword_count: usize,
    pub semantic_count: usize,
    pub fallback_count: usize,
    pub task_count: usize,
    pub total_time_ms: u64,
}

/// Deserialize embedding from bytes (4 bytes per f32, little-endian)
fn deserialize_embedding(blob: &[u8]) -> Vec<f32> {
    blob.chunks(4)
        .filter_map(|chunk| {
            if chunk.len() == 4 {
                Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            } else {
                None
            }
        })
        .collect()
}

/// FTS5 keyword search
fn fts5_search(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResultItem>, String> {
    // Escape special FTS5 characters and wrap each term for prefix matching
    let safe_query = query
        .split_whitespace()
        .map(|term| {
            let escaped = term.replace('"', "\"\"");
            if term.chars().count() <= 2 {
                // Short terms: exact match only, no prefix wildcard
                // Prevents "no" matching "note", "node", etc.
                format!("\"{}\"", escaped)
            } else {
                format!("\"{}\"*", escaped)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    // Query with per-column snippets to correctly identify match source
    // Column indices: 0=path, 1=title, 2=ai_summary, 3=ai_tags, 4=user_tags
    let sql = r#"
        SELECT 
            n.path,
            n.title,
            snippet(notes_fts, 2, '【', '】', '...', 20) as summary_snippet,
            snippet(notes_fts, 1, '【', '】', '...', 20) as title_snippet,
            COALESCE(a.summary, '') as full_summary,
            bm25(notes_fts) as score
        FROM notes_fts
        JOIN notes n ON notes_fts.rowid = n.id
        LEFT JOIN ai_metadata a ON n.id = a.note_id
        WHERE notes_fts MATCH ?1
        ORDER BY score
        LIMIT ?2
    "#;

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let results = stmt
        .query_map(params![&safe_query, limit as i64], |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let summary_snippet: String = row.get(2)?;
            let title_snippet: String = row.get(3)?;
            let full_summary: String = row.get(4)?;
            let score: f64 = row.get(5)?;

            // Determine best snippet and match source
            // Priority: summary_snippet > title_snippet > full_summary
            let (snippet, match_source) = if !summary_snippet.is_empty() && summary_snippet != "..." {
                (summary_snippet, "summary".to_string())
            } else if !title_snippet.is_empty() && title_snippet != "..." {
                // Title matched - use summary as display text if available, otherwise title snippet
                let display = if !full_summary.is_empty() {
                    full_summary.chars().take(150).collect::<String>()
                } else {
                    title_snippet
                };
                (display, "title".to_string())
            } else if !full_summary.is_empty() {
                (full_summary.chars().take(150).collect::<String>(), "summary".to_string())
            } else {
                (title.clone(), "title".to_string())
            };

            Ok(SearchResultItem {
                path,
                title,
                snippet,
                score: score as f32,
                match_type: "keyword".to_string(),
                match_source,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Search tasks by content (multi-term AND matching)
fn search_tasks(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<TaskSearchResult>, String> {
    // Split query into terms for AND matching
    // e.g. "审计 junior" → raw_text LIKE '%审计%' AND raw_text LIKE '%junior%'
    let terms: Vec<&str> = query.split_whitespace().collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let term_conditions: Vec<String> = terms
        .iter()
        .enumerate()
        .map(|(i, _)| format!("t.raw_text LIKE ?{}", i + 1))
        .collect();
    let where_clause = term_conditions.join(" AND ");

    let sql = format!(
        r#"SELECT 
            t.id,
            t.note_path,
            COALESCE(n.title, t.note_path) as note_title,
            t.raw_text,
            t.is_completed,
            t.due_date,
            t.line_number
        FROM tasks t
        LEFT JOIN notes n ON t.note_path = n.path
        WHERE {}
        ORDER BY t.is_completed ASC, t.due_date ASC NULLS LAST
        LIMIT ?{}"#,
        where_clause,
        terms.len() + 1
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    // Build parameter vector: %term1%, %term2%, ..., limit
    let patterns: Vec<String> = terms.iter().map(|t| format!("%{}%", t)).collect();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = patterns
        .iter()
        .map(|p| Box::new(p.clone()) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    param_values.push(Box::new(limit as i64));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(TaskSearchResult {
                id: row.get(0)?,
                note_path: row.get(1)?,
                note_title: row.get(2)?,
                raw_text: row.get(3)?,
                is_completed: row.get(4)?,
                due_date: row.get(5)?,
                line_number: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Search file contents directly (fallback when FTS5 results are insufficient)
fn search_file_contents(
    vault_path: &std::path::Path,
    query: &str,
    limit: usize,
    exclude_paths: &std::collections::HashSet<String>,
) -> Vec<SearchResultItem> {
    use std::fs;
    use walkdir::WalkDir;

    // Split query into terms for AND matching
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();

    for entry in WalkDir::new(vault_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
    {
        if results.len() >= limit {
            break;
        }

        let path = entry.path();
        let relative_path = path
            .strip_prefix(vault_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // Skip paths already in FTS5/semantic results
        if exclude_paths.contains(&relative_path) {
            continue;
        }

        // Skip hidden files
        if relative_path.starts_with('.') || relative_path.contains("/.") {
            continue;
        }

        if let Ok(raw_content) = fs::read_to_string(path) {
            // Strip YAML frontmatter before searching
            let content = if raw_content.starts_with("---") {
                raw_content.find("\n---")
                    .and_then(|i| raw_content.get((i + 4)..))
                    .map(|s| s.trim())
                    .unwrap_or(raw_content.trim())
            } else {
                raw_content.trim()
            };
            let content_lower = content.to_lowercase();
            // Multi-term AND: all terms must be present
            // Short terms (≤2 chars) use word-boundary matching to avoid substring false positives
            let all_match = terms.iter().all(|t| {
                if t.chars().count() <= 2 {
                    // Word boundary match: check for standalone word
                    content_lower
                        .match_indices(t.as_str())
                        .any(|(pos, matched)| {
                            let before_ok = pos == 0
                                || content_lower.as_bytes().get(pos - 1)
                                    .map_or(true, |b| !b.is_ascii_alphanumeric());
                            let after_pos = pos + matched.len();
                            let after_ok = after_pos >= content_lower.len()
                                || content_lower.as_bytes().get(after_pos)
                                    .map_or(true, |b| !b.is_ascii_alphanumeric());
                            before_ok && after_ok
                        })
                } else {
                    content_lower.contains(t.as_str())
                }
            });
            if all_match {
                // Extract snippet around first matching term
                let first_term = &terms[0];
                let snippet = if let Some(pos) = content_lower.find(first_term.as_str()) {
                    // Find proper char boundaries for UTF-8 strings
                    let start = {
                        let target = pos.saturating_sub(50);
                        content[..pos]
                            .char_indices()
                            .rev()
                            .find(|(i, _)| *i <= target)
                            .map(|(i, _)| i)
                            .unwrap_or(0)
                    };
                    let end = {
                        let target = (pos + first_term.len() + 100).min(content.len());
                        content
                            .char_indices()
                            .find(|(i, _)| *i >= target)
                            .map(|(i, _)| i)
                            .unwrap_or(content.len())
                    };
                    let mut s = content[start..end].to_string();
                    if start > 0 {
                        s = format!("...{}", s);
                    }
                    if end < content.len() {
                        s = format!("{}...", s);
                    }
                    s.replace('\n', " ")
                } else {
                    String::new()
                };

                let title = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(SearchResultItem {
                    path: relative_path,
                    title,
                    snippet,
                    score: 0.5, // Fixed score for content scan results
                    match_type: "keyword".to_string(),
                    match_source: "content".to_string(),
                });
            }
        }
    }

    results
}

/// Calculate cosine similarity between two vectors
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a * norm_b)
}

/// Enhanced search result with chunk-level details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
    pub match_type: String,
    pub match_source: String,
    /// The chunk_id from embeddings_v2 (paragraph, profile, or summary)
    pub chunk_id: Option<String>,
    /// Heading path for intra-note navigation (e.g., "Introduction > Background")
    pub heading_path: Option<String>,
    /// Product type: "paragraph", "note_profile", or "summary"
    pub product_type: Option<String>,
}

impl From<ChunkSearchResult> for SearchResultItem {
    fn from(chunk: ChunkSearchResult) -> Self {
        SearchResultItem {
            path: chunk.path,
            title: chunk.title,
            snippet: chunk.snippet,
            score: chunk.score,
            match_type: chunk.match_type,
            match_source: chunk.match_source,
        }
    }
}

/// Semantic search using embeddings_v2 table
///
/// Supports multi-product search:
/// - paragraph: Fine-grained chunk-level matching
/// - note_profile: Whole-note semantic matching
/// - summary: AI-generated summary matching
fn semantic_search_v2(
    conn: &rusqlite::Connection,
    query_embedding: &[f32],
    limit: usize,
    min_similarity: f32,
    vault_path: &str,
) -> Result<Vec<ChunkSearchResult>, String> {
    use std::collections::HashMap;
    use std::path::Path;

    let vault = Path::new(vault_path);

    // Query embeddings_v2 for completed embeddings
    let mut stmt = conn
        .prepare(
            r#"
        SELECT 
            e.note_path,
            COALESCE(n.title, e.note_path) as title,
            COALESCE(a.summary, '') as summary,
            e.embedding,
            e.product_type,
            e.chunk_id,
            e.heading_path
        FROM embeddings_v2 e
        LEFT JOIN notes n ON e.note_path = n.path
        LEFT JOIN ai_metadata a ON n.id = a.note_id
        WHERE e.status = 'completed' 
          AND e.embedding IS NOT NULL
        "#,
        )
        .map_err(|e| e.to_string())?;

    let mut candidates: Vec<ChunkSearchResult> = Vec::new();

    let rows = stmt
        .query_map([], |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let summary: String = row.get(2)?;
            let embedding_blob: Vec<u8> = row.get(3)?;
            let product_type: String = row.get(4)?;
            let chunk_id: String = row.get(5)?;
            let heading_path: Option<String> = row.get(6)?;
            Ok((
                path,
                title,
                summary,
                embedding_blob,
                product_type,
                chunk_id,
                heading_path,
            ))
        })
        .map_err(|e| e.to_string())?;

    // Cache file contents to avoid re-reading
    let mut file_cache: HashMap<String, String> = HashMap::new();

    for row in rows.flatten() {
        let (path, title, summary, embedding_blob, product_type, chunk_id, heading_path) = row;
        let note_embedding = deserialize_embedding(&embedding_blob);

        if note_embedding.is_empty() {
            continue;
        }

        let similarity = cosine_similarity(query_embedding, &note_embedding);
        if similarity > min_similarity {
            // Build snippet based on product type
            let (snippet, match_source) = match product_type.as_str() {
                "paragraph" => {
                    // Try to extract actual content from the note file
                    let content_preview = extract_heading_content(
                        &path, heading_path.as_deref(), vault, &mut file_cache
                    );
                    let snippet = if let Some(preview) = content_preview {
                        preview
                    } else {
                        // Fallback: use summary or generic label
                        let s: String = summary.chars().take(100).collect();
                        if !s.is_empty() { s } else { "(paragraph match)".to_string() }
                    };
                    (snippet, "paragraph".to_string())
                }
                "note_profile" => {
                    let s: String = summary.chars().take(150).collect();
                    let snippet = if s.is_empty() { "(note profile match)".to_string() } else { s };
                    (snippet, "profile".to_string())
                }
                "summary" => {
                    let s: String = summary.chars().take(150).collect();
                    let snippet = if s.is_empty() { "(summary match)".to_string() } else { s };
                    (snippet, "summary".to_string())
                }
                _ => (summary, "embedding".to_string()),
            };

            candidates.push(ChunkSearchResult {
                path,
                title,
                snippet,
                score: similarity,
                match_type: "semantic".to_string(),
                match_source,
                chunk_id: Some(chunk_id),
                heading_path,
                product_type: Some(product_type),
            });
        }
    }

    // Sort by score descending
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Dynamic truncation: filter noise based on score distribution
    // 1. If best score is low, return fewer results
    // 2. If there's a big score gap between top results and the rest, drop the tail
    let effective_limit = if candidates.first().map_or(true, |c| c.score < 0.5) {
        limit.min(3)  // Low confidence: return fewer results
    } else {
        limit
    };
    candidates.truncate(effective_limit);

    // Score gap filter: if top result is significantly stronger, remove noise tail
    if candidates.len() > 1 {
        let top_score = candidates[0].score;
        // Keep only results within 60% of the top score, or with absolute gap < 0.15
        let cutoff = (top_score * 0.6).max(top_score - 0.15);
        candidates.retain(|c| c.score >= cutoff);
    }

    Ok(candidates)
}

/// Extract content under a heading from a note file for snippet display.
/// Strips "(part N)" from heading_path, finds the heading in the file,
/// and returns the first ~120 chars of content below it.
fn extract_heading_content(
    note_path: &str,
    heading_path: Option<&str>,
    vault: &std::path::Path,
    cache: &mut std::collections::HashMap<String, String>,
) -> Option<String> {
    // Read file (with caching)
    let content = if let Some(cached) = cache.get(note_path) {
        cached.clone()
    } else {
        let file_path = vault.join(note_path);
        let text = std::fs::read_to_string(&file_path).ok()?;
        cache.insert(note_path.to_string(), text.clone());
        text
    };

    // Strip YAML frontmatter
    let body = if content.starts_with("---") {
        content.find("\n---")
            .and_then(|i| content.get((i + 4)..))
            .unwrap_or(&content)
    } else {
        &content
    };

    // Clean heading_path: strip "(part N)" suffix
    let clean_heading = heading_path
        .map(|hp| {
            let re = regex::Regex::new(r"\s*\(part \d+\)$").unwrap();
            re.replace(hp, "").to_string()
        })
        .unwrap_or_default();

    if clean_heading.is_empty() {
        // No heading - return first 120 chars of body
        let preview: String = body.trim().chars().take(120).collect();
        if preview.is_empty() { return None; }
        return Some(preview);
    }

    // Find the last heading segment (e.g., "A > B > C" -> search for "C")
    let target_heading = clean_heading
        .rsplit(" > ")
        .next()
        .unwrap_or(&clean_heading)
        .trim();

    // Search for this heading in the file
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            // Extract heading text (strip # prefix)
            let heading_text = trimmed.trim_start_matches('#').trim();
            if heading_text == target_heading {
                // Found the heading - collect content after it
                let heading_pos = body.find(line)?;
                let after_heading = &body[(heading_pos + line.len())..];
                let preview: String = after_heading
                    .trim()
                    .lines()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(120)
                    .collect();
                if !preview.is_empty() {
                    return Some(preview);
                }
            }
        }
    }

    // Heading not found - return first 120 chars as fallback
    let preview: String = body.trim().chars().take(120).collect();
    if preview.is_empty() { None } else { Some(preview) }
}

/// Check if embeddings_v2 has any completed embeddings
fn has_v2_embeddings(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'completed' AND embedding IS NOT NULL",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

/// Search enriched media content (media_enrich_cache + embeddings_v2.enriched_content)
/// This makes text extracted from images/audio via Sidecar searchable via keywords
fn search_enriched_content(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResultItem>, rusqlite::Error> {
    let query_lower = query.to_lowercase();
    let terms: Vec<String> = query_lower
        .split_whitespace()
        .filter(|t| t.len() >= 2)
        .map(|s| s.to_string())
        .collect();

    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let mut results: Vec<SearchResultItem> = Vec::new();

    // Strategy 1: Search embeddings_v2.enriched_content
    // This contains the chunk text that was used for embedding (includes media descriptions)
    let mut stmt = conn.prepare(
        r#"
        SELECT DISTINCT
            e.note_path,
            COALESCE(n.title, e.note_path) as title,
            e.enriched_content
        FROM embeddings_v2 e
        LEFT JOIN notes n ON e.note_path = n.path
        WHERE e.enriched_content IS NOT NULL
          AND e.enriched_content != ''
          AND e.status = 'completed'
          AND LOWER(e.enriched_content) LIKE '%' || ?1 || '%'
        LIMIT ?2
        "#,
    )?;

    let rows = stmt.query_map(
        rusqlite::params![&terms[0], limit as i64],
        |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let content: String = row.get(2)?;
            Ok((path, title, content))
        },
    )?;

    for row in rows.flatten() {
        let (path, title, content) = row;
        let content_lower = content.to_lowercase();

        // Multi-term AND check
        if !terms.iter().all(|t| content_lower.contains(t.as_str())) {
            continue;
        }

        // Extract snippet around first match
        let snippet = if let Some(pos) = content_lower.find(terms[0].as_str()) {
            let start = pos.saturating_sub(40);
            let end = (pos + 120).min(content.len());
            // Find safe char boundaries
            let safe_start = content[..pos]
                .char_indices()
                .rev()
                .find(|(i, _)| *i <= start)
                .map(|(i, _)| i)
                .unwrap_or(0);
            let safe_end = content[pos..]
                .char_indices()
                .find(|(i, _)| pos + *i >= end)
                .map(|(i, _)| pos + i)
                .unwrap_or(content.len());
            let mut s = String::new();
            if safe_start > 0 { s.push_str("..."); }
            s.push_str(&content[safe_start..safe_end]);
            if safe_end < content.len() { s.push_str("..."); }
            s
        } else {
            content.chars().take(120).collect()
        };

        // Try to extract original asset path so frontend can render a thumbnail
        // Strategy A: look for [Media: filename] in the enriched_content
        // Strategy B: look for ![](assets/...) in the original note file
        let media_ref = {
            let mut found: Option<String> = None;

            // Strategy A: [Media: filename] in enriched_content
            if let Ok(re) = regex::Regex::new(r"\[Media:\s*([^\]]+)\]") {
                if let Some(cap) = re.captures(&content) {
                    let filename = cap[1].trim();
                    found = Some(format!("![](assets/{})", filename));
                }
            }

            // Strategy B: look for ![](assets/...) in other chunks of the same note
            if found.is_none() {
                let note_chunk: Option<String> = conn.query_row(
                    "SELECT enriched_content FROM embeddings_v2 WHERE note_path = ?1 AND enriched_content LIKE '%![](assets/%' LIMIT 1",
                    rusqlite::params![&path],
                    |row| row.get(0),
                ).ok();
                if let Some(ec) = note_chunk {
                    if let Ok(asset_re) = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
                        if let Some(cap) = asset_re.captures(&ec) {
                            found = Some(format!("![]({})", &cap[1]));
                        }
                    }
                }
            }

            found
        };

        let final_snippet = if let Some(ref media_md) = media_ref {
            format!("{}\n{}", media_md, snippet)
        } else {
            snippet
        };

        results.push(SearchResultItem {
            path,
            title,
            snippet: final_snippet,
            score: 0.5,  // Fixed relevance score for enriched content match
            match_type: "keyword".to_string(),
            match_source: "media".to_string(),
        });

        if results.len() >= limit {
            break;
        }
    }

    // Strategy 2: Search media_enrich_cache directly and map back to notes
    // This catches cases where enriched_content wasn't stored in embeddings_v2
    if results.len() < limit {
        let mut cache_stmt = conn.prepare(
            r#"
            SELECT asset_hash, enriched_text
            FROM media_enrich_cache
            WHERE LOWER(enriched_text) LIKE '%' || ?1 || '%'
            LIMIT ?2
            "#,
        )?;

        let cache_rows = cache_stmt.query_map(
            rusqlite::params![&terms[0], (limit - results.len()) as i64],
            |row| {
                let hash: String = row.get(0)?;
                let text: String = row.get(1)?;
                Ok((hash, text))
            },
        )?;

        for row in cache_rows.flatten() {
            let (asset_hash, text) = row;
            let text_lower = text.to_lowercase();

            if !terms.iter().all(|t| text_lower.contains(t.as_str())) {
                continue;
            }

            // Try to find which note references this asset
            let note_info: Option<(String, String)> = conn.query_row(
                r#"
                SELECT e.note_path, COALESCE(n.title, e.note_path)
                FROM embeddings_v2 e
                LEFT JOIN notes n ON e.note_path = n.path
                WHERE e.enriched_content LIKE '%' || ?1 || '%'
                LIMIT 1
                "#,
                rusqlite::params![&asset_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();

            if let Some((path, title)) = note_info {
                // Avoid duplicates
                if results.iter().any(|r| r.path == path && r.match_source == "media") {
                    continue;
                }

                let snippet: String = text.chars().take(120).collect();
                results.push(SearchResultItem {
                    path,
                    title,
                    snippet: format!("🖼️ {}", snippet),
                    score: 0.48,
                    match_type: "keyword".to_string(),
                    match_source: "media".to_string(),
                });
            }

            if results.len() >= limit {
                break;
            }
        }
    }

    Ok(results)
}

/// Merge and normalize results from keyword and semantic search
/// Preserves multiple match sources per note (no dedup by path alone)
fn merge_results(
    mut keyword_results: Vec<SearchResultItem>,
    semantic_results: Vec<SearchResultItem>,
    keyword_weight: f32,
    semantic_weight: f32,
) -> Vec<SearchResultItem> {
    // Normalize keyword scores (BM25 scores are negative, lower is better)
    let max_keyword_score = keyword_results
        .iter()
        .map(|r| r.score.abs())
        .fold(f32::MIN, f32::max);

    for item in keyword_results.iter_mut() {
        // Convert BM25 to 0-1 range (invert and normalize)
        item.score = (1.0 - (item.score.abs() / max_keyword_score.max(1.0))) * keyword_weight;
    }

    // Normalize semantic scores
    let mut normalized_semantic: Vec<SearchResultItem> = semantic_results
        .into_iter()
        .map(|mut item| {
            item.score *= semantic_weight;
            item
        })
        .collect();

    // Combine all results (preserve multiple sources per note)
    let mut all_results: Vec<SearchResultItem> = keyword_results;
    all_results.append(&mut normalized_semantic);

    // Sort by score descending
    all_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    all_results
}

/// Hybrid search command - combines FTS5 keyword search with semantic vector search
#[tauri::command]
pub async fn hybrid_search(
    query: String,
    vault_path: String,
    limit: Option<usize>,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
) -> Result<HybridSearchResult, String> {
    use std::collections::HashSet;
    use std::path::Path;
    let start = std::time::Instant::now();
    let limit = limit.unwrap_or(20);

    log::info!("🔍 [Search] Hybrid search for: {}", query);

    // Step 1: FTS5 keyword search
    let keyword_results = db_state.0.with_connection(|conn| {
        match fts5_search(conn, &query, limit) {
            Ok(results) => Ok(results),
            Err(e) => {
                log::error!("⚠️ [Search] FTS5 search failed: {}", e);
                Ok(Vec::new()) // Fallback to empty if FTS5 not available
            }
        }
    })?;

    log::info!("🔍 [Search] FTS5 found {} results", keyword_results.len());

    // Step 2: Semantic vector search
    // Generate query embedding
    let service = ai_state.service().clone();
    let query_embedding = service
        .generate_embedding(&query)
        .await
        .map_err(|e| format!("Failed to generate query embedding: {}", e))?;

    // Try embeddings_v2 first, fallback to old embeddings table
    let query_embedding_clone = query_embedding.clone();
    let semantic_results: Vec<SearchResultItem> = db_state.0.with_connection(|conn| {
        // Check if we have v2 embeddings
        if has_v2_embeddings(conn) {
            log::info!("🔍 [Search] Using embeddings_v2 for semantic search");
            match semantic_search_v2(conn, &query_embedding_clone, limit, 0.4, &vault_path) {
                Ok(chunk_results) => {
                    // Convert ChunkSearchResult to SearchResultItem
                    let results: Vec<SearchResultItem> =
                        chunk_results.into_iter().map(|c| c.into()).collect();
                    return Ok(results);
                }
                Err(e) => {
                    log::error!(
                        "⚠️ [Search] embeddings_v2 search failed, falling back: {}",
                        e
                    );
                }
            }
        }

        // Fallback to old embeddings table
        log::info!("🔍 [Search] Using legacy embeddings table");
        let mut stmt = conn.prepare(
            r#"
            SELECT n.path, n.title, COALESCE(a.summary, '') as snippet, e.embedding
            FROM embeddings e
            JOIN notes n ON e.note_path = n.path
            LEFT JOIN ai_metadata a ON n.id = a.note_id
            WHERE e.embedding IS NOT NULL
            "#,
        )?;

        let mut candidates: Vec<SearchResultItem> = Vec::new();

        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let snippet: String = row.get(2)?;
            let embedding_blob: Vec<u8> = row.get(3)?;
            Ok((path, title, snippet, embedding_blob))
        })?;

        for row in rows.flatten() {
            let (path, title, snippet, embedding_blob) = row;
            let note_embedding = deserialize_embedding(&embedding_blob);

            if !note_embedding.is_empty() {
                let similarity = cosine_similarity(&query_embedding_clone, &note_embedding);
                if similarity > 0.5 {
                    // Higher threshold to let keyword results stand out
                    candidates.push(SearchResultItem {
                        path,
                        title,
                        snippet,
                        score: similarity,
                        match_type: "semantic".to_string(),
                        match_source: "embedding".to_string(),
                    });
                }
            }
        }

        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(limit);

        Ok(candidates)
    })?;

    log::error!(
        "🔍 [Search] Semantic found {} results",
        semantic_results.len()
    );

    let keyword_count = keyword_results.len();
    let semantic_count = semantic_results.len();

    // Step 3: Search tasks
    let task_results: Vec<TaskSearchResult> =
        db_state
            .0
            .with_connection(|conn| match search_tasks(conn, &query, 10) {
                Ok(results) => Ok(results),
                Err(e) => {
                    log::error!("⚠️ [Search] Task search failed: {}", e);
                    Ok(Vec::new())
                }
            })?;
    let task_count = task_results.len();
    log::info!("🔍 [Search] Found {} matching tasks", task_count);

    // Step 4: Merge results with weighted scoring
    let merged = merge_results(keyword_results, semantic_results, 0.4, 0.6);

    // Step 5: File system content search (always runs as supplement)
    // This ensures real-time content matching even when FTS5 index is not up-to-date
    // Pass empty set to allow same note to appear from different match sources
    let vault = Path::new(&vault_path);
    let remaining_limit = limit.saturating_sub(merged.len()).max(5); // At least 5 slots for content search
    let fallback_results = search_file_contents(vault, &query, remaining_limit, &HashSet::new());
    let fallback_count = fallback_results.len();
    log::error!(
        "🔍 [Search] Content scan found {} additional results",
        fallback_count
    );
    let mut final_results = merged;
    final_results.extend(fallback_results);

    // Step 5b: Search enriched media content (media_enrich_cache + embeddings_v2.enriched_content)
    // This ensures text extracted from images/media via Sidecar is searchable via keywords
    let query_for_enriched = query.clone();
    let enriched_results: Vec<SearchResultItem> = db_state.0.with_connection(|conn| {
        search_enriched_content(conn, &query_for_enriched, 10)
    }).unwrap_or_default();
    if !enriched_results.is_empty() {
        log::info!("🔍 [Search] Enriched content found {} results", enriched_results.len());
        final_results.extend(enriched_results);
    }

    // Group same-path results together while maintaining score order
    // First sort by score, then stable sort by path to cluster same-note results
    final_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Stable sort by path to group same-note results together
    // Use custom logic: group by path, order groups by max score
    let mut path_groups: std::collections::HashMap<String, (f32, Vec<SearchResultItem>)> =
        std::collections::HashMap::new();
    for item in final_results {
        let entry = path_groups
            .entry(item.path.clone())
            .or_insert((0.0, Vec::new()));
        entry.0 = entry.0.max(item.score); // Track max score for group ordering
        entry.1.push(item);
    }
    let mut grouped: Vec<(f32, Vec<SearchResultItem>)> = path_groups.into_values().collect();
    grouped.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let final_results: Vec<SearchResultItem> =
        grouped.into_iter().flat_map(|(_, items)| items).collect();

    let elapsed = start.elapsed().as_millis() as u64;
    log::error!(
        "🔍 [Search] Completed in {}ms, {} notes + {} tasks",
        elapsed,
        final_results.len(),
        task_count
    );

    Ok(HybridSearchResult {
        results: final_results,
        tasks: task_results,
        keyword_count,
        semantic_count,
        fallback_count,
        task_count,
        total_time_ms: elapsed,
    })
}

/// Quick search - FTS5 only, for fast autocomplete
#[tauri::command]
pub fn quick_search(
    query: String,
    limit: Option<usize>,
    db_state: State<'_, DbStateWrapper>,
) -> Result<Vec<SearchResultItem>, String> {
    let limit = limit.unwrap_or(10);

    db_state.0.with_connection(|conn| {
        match fts5_search(conn, &query, limit) {
            Ok(results) => Ok(results),
            Err(e) => {
                log::error!("⚠️ [Search] Quick search failed: {}", e);
                // Fallback to simple LIKE search if FTS5 not available
                let sql = r#"
                    SELECT n.path, n.title, COALESCE(a.summary, '') as snippet
                    FROM notes n
                    LEFT JOIN ai_metadata a ON n.id = a.note_id
                    WHERE n.title LIKE '%' || ?1 || '%'
                       OR a.summary LIKE '%' || ?1 || '%'
                    LIMIT ?2
                "#;
                let mut stmt = conn.prepare(sql)?;
                let results = stmt
                    .query_map(params![&query, limit as i64], |row| {
                        Ok(SearchResultItem {
                            path: row.get(0)?,
                            title: row.get(1)?,
                            snippet: row.get(2)?,
                            score: 1.0,
                            match_type: "keyword".to_string(),
                            match_source: "summary".to_string(),
                        })
                    })?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(results)
            }
        }
    })
}

/// HyDE Search Result with expanded results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HyDeSearchResult {
    /// Results found using HyDE embedding
    pub results: Vec<SearchResultItem>,
    /// The hypothetical document generated by LLM
    pub hypothetical_document: String,
    /// Processing time in milliseconds
    pub total_time_ms: u64,
}

/// HyDE enhanced search - generates hypothetical document and uses its embedding
/// This command should be called AFTER hybrid_search for additional results
#[tauri::command]
pub async fn hyde_search(
    query: String,
    limit: Option<usize>,
    existing_paths: Vec<String>,
    vault_path: String,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    app_handle: AppHandle,
) -> Result<HyDeSearchResult, String> {
    let start = std::time::Instant::now();
    let limit = limit.unwrap_or(10);

    log::info!("🔮 [HyDE] Starting HyDE search for: {}", query);

    // Step 1: Generate hypothetical document and get its embedding using HyDE
    let service = ai_state.service().clone();
    let hyde_result = hyde_expand(&query, &service)
        .await
        .map_err(|e| format!("HyDE expansion failed: {}", e))?;

    let hyde_embedding = match hyde_result.embedding {
        Some(emb) => emb,
        None => {
            return Err("HyDE failed to generate embedding".to_string());
        }
    };

    log::error!(
        "🔮 [HyDE] Generated hypothetical doc ({} chars) and embedding ({} dims)",
        hyde_result.hypothetical_document.len(),
        hyde_embedding.len()
    );

    // Step 2: Search using HyDE embedding (similar to semantic search)
    let existing_paths_set: std::collections::HashSet<_> = existing_paths.into_iter().collect();

    let hyde_embedding_clone = hyde_embedding.clone();
    let hyde_results: Vec<SearchResultItem> = db_state.0.with_connection(|conn| {
        // Try embeddings_v2 first
        if has_v2_embeddings(conn) {
            log::info!("🔮 [HyDE] Using embeddings_v2 for semantic search");
            match semantic_search_v2(
                conn,
                &hyde_embedding_clone,
                limit + existing_paths_set.len(),
                0.35,
                &vault_path,
            ) {
                Ok(chunk_results) => {
                    // Convert and filter out already-found paths
                    let results: Vec<SearchResultItem> = chunk_results
                        .into_iter()
                        .filter(|c| !existing_paths_set.contains(&c.path))
                        .take(limit)
                        .map(|mut c| {
                            c.match_type = "hyde".to_string();
                            c.into()
                        })
                        .collect();
                    return Ok(results);
                }
                Err(e) => {
                    log::error!("⚠️ [HyDE] embeddings_v2 search failed, falling back: {}", e);
                }
            }
        }

        // Fallback to old embeddings table
        log::info!("🔮 [HyDE] Using legacy embeddings table");
        let mut stmt = conn.prepare(
            r#"
            SELECT n.path, n.title, COALESCE(a.summary, '') as snippet, e.embedding
            FROM embeddings e
            JOIN notes n ON e.note_path = n.path
            LEFT JOIN ai_metadata a ON n.id = a.note_id
            WHERE e.embedding IS NOT NULL
            "#,
        )?;

        let mut candidates: Vec<SearchResultItem> = Vec::new();

        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let snippet: String = row.get(2)?;
            let embedding_blob: Vec<u8> = row.get(3)?;
            Ok((path, title, snippet, embedding_blob))
        })?;

        for row in rows.flatten() {
            let (path, title, snippet, embedding_blob) = row;

            // Skip paths already found in hybrid_search
            if existing_paths_set.contains(&path) {
                continue;
            }

            let note_embedding = deserialize_embedding(&embedding_blob);

            if !note_embedding.is_empty() {
                let similarity = cosine_similarity(&hyde_embedding_clone, &note_embedding);
                if similarity > 0.35 {
                    // Slightly higher threshold for HyDE
                    candidates.push(SearchResultItem {
                        path,
                        title,
                        snippet,
                        score: similarity,
                        match_type: "hyde".to_string(),
                        match_source: "embedding".to_string(),
                    });
                }
            }
        }

        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(limit);

        Ok(candidates)
    })?;

    let elapsed = start.elapsed().as_millis() as u64;
    log::error!(
        "🔮 [HyDE] Completed in {}ms, {} new results",
        elapsed,
        hyde_results.len()
    );

    // Emit event for incremental loading on frontend
    let _ = app_handle.emit("search:hyde-results", &hyde_results);

    Ok(HyDeSearchResult {
        results: hyde_results,
        hypothetical_document: hyde_result.hypothetical_document,
        total_time_ms: elapsed,
    })
}

// ============================================================================
// Deep Search (RAG) - Phase 3
// ============================================================================

/// Reference to a note used in the answer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteReference {
    pub path: String,
    pub title: String,
    /// Which part of the note was used (optional context)
    pub excerpt: Option<String>,
}

/// Deep search result with RAG-generated answer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSearchResult {
    /// The generated answer based on note contents
    pub answer: String,
    /// Notes referenced in the answer
    pub references: Vec<NoteReference>,
    /// Processing time in milliseconds
    pub total_time_ms: u64,
    /// Number of notes used as context
    pub context_notes_count: usize,
}

/// RAG System Prompt for deep search
const RAG_SYSTEM_PROMPT: &str = r#"You are a knowledge base insight assistant. Your core task is to **synthesize**, not to repeat.

## Persona
Always address the user as "you". Never say "the user", "this user", or "the author".

## Response Structure (strictly follow)
1. **One-line summary**: Briefly state what dimensions of "{topic}" the user's knowledge base covers.
2. **Key points**: Extract 2-4 cross-note insights, each tagged with source [[Note Title]].
3. **Connections** (optional): If hidden links exist across notes, highlight them in one sentence.

## Language Rules
- Write your response in the **same language as the user's system locale** provided below.
- When quoting or referencing note content, **preserve the original language of the note** — do not translate it.

## Rules
- Synthesize first. Do NOT repeat note contents one by one.
- Each key point must be under 30 words.
- Total response under 150 words.
- Use [[Note Title]] for citations, placed **after** sentence-ending punctuation. Example: Knowledge management follows PARA.[[About Slash]]
- Never apologize or say "sorry".
- Do not output general knowledge unrelated to the notes.
- If no relevant content exists, simply say the knowledge base does not cover this topic yet."#;

/// Deep search command - RAG-based question answering over notes
#[tauri::command]
pub async fn deep_search(
    query: String,
    context_note_paths: Vec<String>,
    vault_path: String,
    locale: String,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
) -> Result<DeepSearchResult, String> {
    use std::fs;
    use std::path::Path;

    let start = std::time::Instant::now();
    log::error!("🧠 [DeepSearch] Starting RAG search for: {}", query);

    if context_note_paths.is_empty() {
        return Err("No context notes provided for deep search".to_string());
    }

    let vault = Path::new(&vault_path);

    // Step 1: Retrieve note metadata from DB + body from disk
    let notes_meta: Vec<(String, String, String)> = db_state.0.with_connection(|conn| {
        let mut results = Vec::new();
        for path in &context_note_paths {
            let sql = r#"
                SELECT n.path, n.title, COALESCE(n.user_summary, a.summary, '') as summary
                FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id
                WHERE n.path = ?1
            "#;
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(Some(row)) = stmt
                    .query_row(params![path], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map(Some)
                    .or_else(|_| Ok::<_, rusqlite::Error>(None))
                {
                    results.push(row);
                }
            }
        }
        Ok(results)
    })?;

    if notes_meta.is_empty() {
        return Err("Could not retrieve any note content".to_string());
    }

    log::error!(
        "🧠 [DeepSearch] Retrieved {} notes for context",
        notes_meta.len()
    );

    // Step 2: Build RAG context — read actual file content from disk
    let mut context_text = String::new();
    let mut references: Vec<NoteReference> = Vec::new();
    let max_chars_per_note: usize = 3000; // Cap per-note to avoid token overflow

    for (path, title, summary) in &notes_meta {
        context_text.push_str(&format!("\n## [[{}]]\n", title));

        // Read body from disk
        let file_path = vault.join(path);
        let body = fs::read_to_string(&file_path).unwrap_or_default();

        if !body.is_empty() {
            // Strip YAML frontmatter
            let content = if body.starts_with("---") {
                body.find("\n---")
                    .and_then(|i| body.get((i + 4)..))
                    .map(|s| s.trim())
                    .unwrap_or(&body)
            } else {
                body.trim()
            };

            // Enrich media references with cached AI descriptions
            let enriched = enrich_content_for_rag(content, &vault, &db_state);

            // Truncate to max chars
            let truncated: String = enriched.chars().take(max_chars_per_note).collect();
            context_text.push_str(&truncated);
            if enriched.len() > max_chars_per_note {
                context_text.push_str("\n...(truncated)");
            }
            context_text.push('\n');
        } else if !summary.is_empty() {
            context_text.push_str(&format!("{}\n", summary));
        } else {
            context_text.push_str("(empty note)\n");
        }

        references.push(NoteReference {
            path: path.clone(),
            title: title.clone(),
            excerpt: if !summary.is_empty() {
                Some(summary.chars().take(100).collect())
            } else {
                None
            },
        });
    }

    let user_prompt = format!(
        "## User's system locale\n{}\n\n## User's question\n{}\n\n## Related note contents\n{}",
        locale, query, context_text
    );

    let full_prompt = format!("{}\n\n{}", RAG_SYSTEM_PROMPT, user_prompt);

    log::error!(
        "🧠 [DeepSearch] RAG prompt length: {} chars",
        full_prompt.len()
    );

    // Step 3: Generate answer (temperature 0.3 for natural but faithful tone)
    let service_for_gen = {
        let svc = ai_state.service();
        svc.clone()
    };

    let answer = service_for_gen
        .complete_raw(&full_prompt, 0.3)
        .await
        .map_err(|e| format!("RAG generation failed: {}", e))?;

    let elapsed = start.elapsed().as_millis() as u64;
    log::error!(
        "🧠 [DeepSearch] Completed in {}ms, answer length: {} chars",
        elapsed,
        answer.len()
    );

    Ok(DeepSearchResult {
        answer,
        references,
        total_time_ms: elapsed,
        context_notes_count: notes_meta.len(),
    })
}

/// Replace `![](assets/hash.ext)` references in markdown with cached AI descriptions
/// from `media_enrich_cache`, so RAG context includes image content understanding.
fn enrich_content_for_rag(
    content: &str,
    _vault: &std::path::Path,
    db_state: &State<'_, DbStateWrapper>,
) -> String {
    let media_re = match regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
        Ok(r) => r,
        Err(_) => return content.to_string(),
    };

    // Collect all media references first to avoid borrow issues
    let captures: Vec<(String, String)> = media_re
        .captures_iter(content)
        .filter_map(|cap| {
            let full_match = cap.get(0)?.as_str().to_string();
            let asset_rel = cap.get(1)?.as_str().to_string();
            Some((full_match, asset_rel))
        })
        .collect();

    if captures.is_empty() {
        return content.to_string();
    }

    let mut result = content.to_string();

    for (full_match, asset_rel) in &captures {
        // Extract asset hash (filename stem) as cache key
        let filename = std::path::Path::new(asset_rel)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let asset_hash = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        // Look up cached AI description
        let cached_text: Option<String> = db_state.0.with_connection(|conn| {
            let text: Result<String, rusqlite::Error> = conn.query_row(
                "SELECT enriched_text FROM media_enrich_cache WHERE asset_hash = ?1",
                rusqlite::params![asset_hash],
                |row| row.get(0),
            );
            Ok(text.ok())
        }).ok().flatten();

        if let Some(description) = cached_text {
            // Replace image reference with description for RAG context
            let replacement = format!("[Image: {}]\n{}", filename, description);
            result = result.replacen(full_match, &replacement, 1);
            log::error!(
                "🧠 [DeepSearch] Enriched media {} → {} chars",
                filename, description.len()
            );
        }
    }

    result
}
