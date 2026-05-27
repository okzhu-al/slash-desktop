// GhostLink - Embedding-based similar note discovery
// Finds semantically related notes that are not yet linked

use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, HashMap};

/// A note that is semantically similar to the current note
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimilarNote {
    pub note_path: String,
    pub title: String,
    pub similarity: f64,
    pub mtime: i64, // For cache validation
}

/// Result of ghost link search
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhostLinkResult {
    pub notes: Vec<SimilarNote>,
}

/// Compute cosine similarity between two vectors
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot_product: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot_product / (norm_a * norm_b)
}

/// Parse embedding bytes to f32 vector  
fn bytes_to_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Parse tags JSON string to lowercase HashSet
fn parse_tags(user_tags: Option<&str>, ai_tags: Option<&str>) -> HashSet<String> {
    let mut tags = HashSet::new();
    if let Some(ut) = user_tags {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(ut) {
            for t in parsed {
                tags.insert(t.to_lowercase());
            }
        }
    }
    if let Some(at) = ai_tags {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(at) {
            for t in parsed {
                tags.insert(t.to_lowercase());
            }
        }
    }
    tags
}

/// Compute Jaccard similarity between two HashSets
fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    intersection as f64 / union as f64
}

/// Calculate dynamic similarity threshold based on note sizes
fn calculate_dynamic_threshold(base_threshold: f64, source_size: i64, target_size: i64) -> f64 {
    let mut threshold = base_threshold;
    // Source size penalty
    if source_size < 200 {
        threshold += 0.10;
    } else if source_size > 10000 {
        threshold -= 0.05;
    }
    // Target size penalty
    if target_size < 200 {
        threshold += 0.05;
    }
    threshold.clamp(0.30, 0.95)
}

/// Check if target should be excluded due to same-directory rules
///
/// Rules:
/// - R2.1: Same directory siblings → EXCLUDE (unless in 00_Inbox)
/// - R2.2: Cross-subdirectory cousins → KEEP
/// - R2.3: Parent-child relationship → EXCLUDE (always, even in 00_Inbox)
/// - R2.4: 00_Inbox privilege → Only exempts sibling rule, NOT parent-child
fn is_same_directory_excluded(source_path: &str, target_path: &str) -> bool {
    use std::path::Path;

    let source = Path::new(source_path);
    let target = Path::new(target_path);

    // Get parent directories
    let source_parent = source.parent();
    let target_parent = target.parent();

    // R2.3: Parent-child relationship - ALWAYS CHECK, even for 00_Inbox
    // Check if source is parent of target or vice versa
    if let (Some(sp), Some(tp)) = (source_parent, target_parent) {
        let sp_str = sp.to_string_lossy();
        let tp_str = tp.to_string_lossy();

        // Source parent contains target, or target parent contains source
        if tp_str.starts_with(&*sp_str) || sp_str.starts_with(&*tp_str) {
            // Check if it's direct parent-child (1 level difference)
            let sp_depth = sp_str.matches('/').count();
            let tp_depth = tp_str.matches('/').count();

            if (sp_depth as i32 - tp_depth as i32).abs() == 1 {
                // Parent-child excluded (silently)
                return true; // Exclude parent-child
            }
        }
    }

    // R2.4: 00_Inbox privilege - only applies to sibling rule below
    let is_inbox = |path: &Path| -> bool {
        path.components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with("00_Inbox"))
    };

    // R2.1: Same directory siblings - exempted for 00_Inbox
    if source_parent == target_parent {
        if is_inbox(source) || is_inbox(target) {
            // 00_Inbox privilege: same-directory notes NOT excluded
            return false;
        }
        // Siblings in same directory excluded (silently)
        return true; // Exclude same directory
    }

    // R2.2: Cross-subdirectory cousins - KEEP
    false
}

/// Find notes similar to the given note based on embeddings
/// Returns up to `limit` notes with similarity > threshold, excluding already linked notes
pub fn find_similar_notes(
    conn: &Connection,
    note_path: &str,
    limit: usize,
    threshold: f64,
) -> SqliteResult<GhostLinkResult> {
    // Check if embeddings_v2 has data
    let v2_count = conn
        .query_row(
            "SELECT COUNT(*) FROM embeddings_v2 WHERE status = 'completed' AND embedding IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    let use_v2 = v2_count > 0;

    log::debug!(
        "🔮 [GhostLink] find_similar_notes: path='{}', use_v2={}, v2_completed_count={}",
        note_path, use_v2, v2_count
    );

    // Force V2 usage (legacy table deprecated)
    if use_v2 {
        find_similar_notes_v2(conn, note_path, limit, threshold)
    } else {
        // If no V2 embeddings, return empty instead of crashing on legacy table
        log::debug!("ℹ️ [GhostLink] No V2 embeddings found, skipping legacy fallback");
        Ok(GhostLinkResult { notes: vec![] })
    }
}

/// Find similar notes using embeddings_v2 (multi-product)
fn find_similar_notes_v2(
    conn: &Connection,
    note_path: &str,
    limit: usize,
    threshold: f64,
) -> SqliteResult<GhostLinkResult> {
    // Get the current note's metadata (size, tags)
    let (current_size, current_user_tags, current_ai_tags): (i64, Option<String>, Option<String>) = conn
        .query_row(
            r#"SELECT n.size, n.user_tags, a.tags 
               FROM notes n 
               LEFT JOIN ai_metadata a ON n.id = a.note_id 
               WHERE n.path = ?1"#,
            params![note_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap_or((0, None, None));
    let current_tags = parse_tags(current_user_tags.as_deref(), current_ai_tags.as_deref());

    // Get the current note's embedding (prefer note_profile, fallback to paragraph)
    let current_embedding: Option<Vec<u8>> = conn
        .query_row(
            r#"SELECT embedding FROM embeddings_v2 
               WHERE note_path = ?1 
                 AND status = 'completed' 
                 AND embedding IS NOT NULL
                 AND product_type IN ('note_profile', 'paragraph', 'text')
               ORDER BY CASE product_type 
                   WHEN 'note_profile' THEN 1 
                   WHEN 'paragraph' THEN 2 
                   ELSE 3 
               END
               LIMIT 1"#,
            params![note_path],
            |row| row.get(0),
        )
        .ok();

    let current_embedding = match current_embedding {
        Some(bytes) => {
            let emb = bytes_to_embedding(&bytes);
            log::debug!(
                "✅ [GhostLink/v2] Found embedding for current note, dim={}",
                emb.len()
            );
            emb
        }
        None => {
            // Normal: embedding is computed asynchronously AFTER skills run.
            // ghostlink:refresh will trigger a re-call once embedding is ready.
            log::debug!(
                "ℹ️ [GhostLink/v2] No embedding yet for: {} (will retry after embedding completes)",
                note_path
            );
            return Ok(GhostLinkResult { notes: vec![] });
        }
    };

    // Get notes already linked from this note (to exclude them)
    let mut linked_stmt = conn.prepare("SELECT target_path FROM links WHERE source_path = ?1")?;
    let linked_notes: Vec<String> = linked_stmt
        .query_map(params![note_path], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Get blacklisted pairs (user-ignored recommendations)
    let mut blacklist_stmt =
        conn.prepare("SELECT target_path FROM ghost_link_blacklist WHERE source_path = ?1")?;
    let blacklisted_notes: Vec<String> = blacklist_stmt
        .query_map(params![note_path], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Get all links in vault to build the neighbors map once (O(N) in memory, avoiding N+1 queries)
    let mut links_stmt = conn.prepare("SELECT source_path, target_path FROM links WHERE target_path IS NOT NULL")?;
    let mut neighbors_map: HashMap<String, HashSet<String>> = HashMap::new();
    let mut rows = links_stmt.query([])?;
    while let Some(row) = rows.next()? {
        let src: String = row.get(0)?;
        let tgt: String = row.get(1)?;
        neighbors_map.entry(src.clone()).or_default().insert(tgt.clone());
        neighbors_map.entry(tgt).or_default().insert(src);
    }

    // Get all other embeddings (one per note, preferring note_profile > paragraph > summary)
    // Uses a subquery to reliably pick the best product_type per note
    let mut stmt = conn.prepare(
        r#"SELECT e.note_path, e.embedding, n.title, n.mtime, n.size, n.user_tags, a.tags
         FROM embeddings_v2 e 
         JOIN notes n ON e.note_path = n.path 
         LEFT JOIN ai_metadata a ON n.id = a.note_id
         JOIN (
             SELECT note_path, MIN(
                 CASE product_type 
                     WHEN 'note_profile' THEN 1 
                     WHEN 'paragraph' THEN 2 
                     ELSE 3 
                 END
             ) AS best_rank
             FROM embeddings_v2 
             WHERE status = 'completed' 
               AND embedding IS NOT NULL
             GROUP BY note_path
         ) best ON e.note_path = best.note_path
             AND CASE e.product_type 
                     WHEN 'note_profile' THEN 1 
                     WHEN 'paragraph' THEN 2 
                     ELSE 3 
                 END = best.best_rank
         WHERE e.note_path != ?1
           AND e.status = 'completed'
           AND e.embedding IS NOT NULL"#,
    )?;

    let all_candidates: Vec<(String, Vec<u8>, String, i64, i64, Option<String>, Option<String>)> = stmt
        .query_map(params![note_path], |row| {
            let path: String = row.get(0)?;
            let bytes: Vec<u8> = row.get(1)?;
            let title: String = row.get(2)?;
            let mtime: i64 = row.get(3)?;
            let size: i64 = row.get(4)?;
            let user_tags: Option<String> = row.get(5)?;
            let ai_tags: Option<String> = row.get(6)?;
            Ok((path, bytes, title, mtime, size, user_tags, ai_tags))
        })?
        .filter_map(|r| match r {
            Ok(v) => Some(v),
            Err(e) => {
                log::debug!("❌ [GhostLink] Failed to read candidate row: {:?}", e);
                None
            }
        })
        .collect();

    log::debug!(
        "📊 [GhostLink/v2] Found {} candidate notes with embeddings",
        all_candidates.len()
    );

    compute_similarities(
        note_path,
        &current_embedding,
        all_candidates,
        &linked_notes,
        &blacklisted_notes,
        limit,
        threshold,
        &current_tags,
        current_size,
        &neighbors_map,
    )
}

/// Shared similarity computation logic
fn compute_similarities(
    note_path: &str,
    current_embedding: &[f32],
    all_candidates: Vec<(String, Vec<u8>, String, i64, i64, Option<String>, Option<String>)>,
    linked_notes: &[String],
    blacklisted_notes: &[String],
    limit: usize,
    threshold: f64,
    current_tags: &HashSet<String>,
    current_size: i64,
    neighbors_map: &HashMap<String, HashSet<String>>,
) -> SqliteResult<GhostLinkResult> {
    let empty_set = HashSet::new();
    let mut similar_notes: Vec<SimilarNote> = all_candidates
        .into_iter()
        // R1: Exclude already linked notes + blacklisted
        .filter(|(path, _, _, _, _, _, _)| !linked_notes.contains(path) && !blacklisted_notes.contains(path))
        // R2: Exclude same-directory notes (except 00_Inbox)
        .filter(|(path, _, _, _, _, _, _)| !is_same_directory_excluded(note_path, path))
        .filter_map(|(path, bytes, title, mtime, size, user_tags, ai_tags)| {
            let embedding = bytes_to_embedding(&bytes);
            let sim_vector = cosine_similarity(current_embedding, &embedding);
            
            // 1. Tag Similarity
            let candidate_tags = parse_tags(user_tags.as_deref(), ai_tags.as_deref());
            let sim_tag = jaccard_similarity(current_tags, &candidate_tags);
            
            // 2. Graph Topology Similarity
            let current_neighbors = neighbors_map.get(note_path).unwrap_or(&empty_set);
            let candidate_neighbors = neighbors_map.get(&path).unwrap_or(&empty_set);
            let sim_graph = jaccard_similarity(current_neighbors, candidate_neighbors);
            
            // 3. Combined hybrid score
            let hybrid_score = 0.5 * sim_vector + 0.3 * sim_tag + 0.2 * sim_graph;
            
            // 4. Dynamic threshold check
            let dynamic_threshold = calculate_dynamic_threshold(threshold, current_size, size);
            
            if hybrid_score > dynamic_threshold {
                Some(SimilarNote {
                    note_path: path,
                    title,
                    similarity: hybrid_score,
                    mtime,
                })
            } else {
                None
            }
        })
        .collect();

    // One-line summary only
    log::debug!(
        "👻 [GhostLink] {} → {} similar (threshold={:.2})",
        note_path,
        similar_notes.len(),
        threshold
    );

    // Sort by similarity descending
    similar_notes.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // R0: Top-K truncation
    similar_notes.truncate(limit);

    Ok(GhostLinkResult {
        notes: similar_notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 0.001);

        let c = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&a, &c) - 0.0).abs() < 0.001);

        let d = vec![1.0, 1.0, 0.0];
        let expected = 1.0 / 2.0_f64.sqrt();
        assert!((cosine_similarity(&a, &d) - expected).abs() < 0.001);
    }

    #[test]
    fn test_parse_tags() {
        let user_tags = Some(r#"["Rust", "wasm"]"#);
        let ai_tags = Some(r#"["Wasm", "Database"]"#);
        let tags = parse_tags(user_tags, ai_tags);
        assert_eq!(tags.len(), 3);
        assert!(tags.contains("rust"));
        assert!(tags.contains("wasm"));
        assert!(tags.contains("database"));
    }

    #[test]
    fn test_jaccard_similarity() {
        let mut a = HashSet::new();
        a.insert("rust".to_string());
        a.insert("wasm".to_string());

        let mut b = HashSet::new();
        b.insert("wasm".to_string());
        b.insert("database".to_string());

        let sim = jaccard_similarity(&a, &b);
        assert!((sim - 1.0 / 3.0).abs() < 0.001);

        let sim_empty = jaccard_similarity(&HashSet::new(), &b);
        assert_eq!(sim_empty, 0.0);
    }

    #[test]
    fn test_calculate_dynamic_threshold() {
        // Base threshold 0.60
        // Source < 200: +0.10 => 0.70
        // Target < 200: +0.05 => 0.75
        let t1 = calculate_dynamic_threshold(0.60, 150, 150);
        assert!((t1 - 0.75).abs() < 0.001);

        // Source > 10000: -0.05 => 0.55
        // Target >= 200: +0.00 => 0.55
        let t2 = calculate_dynamic_threshold(0.60, 15000, 500);
        assert!((t2 - 0.55).abs() < 0.001);

        // Clamp test
        let t3 = calculate_dynamic_threshold(0.90, 500, 100);
        // 0.90 + 0.05 = 0.95 (clamp to 0.95)
        assert!((t3 - 0.95).abs() < 0.001);
    }
}
