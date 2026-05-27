//! Ghost Link Commands
//!
//! Commands for ghost link (embedding-based similar notes) functionality.

use std::path::Path;
use tauri::{Emitter, State};

use crate::{AIStateWrapper, DbStateWrapper};

// ============================================================================
// Helper: Build rich context for LLM reasoning
// ============================================================================

/// Build rich context for a note to feed to LLM.
/// Strategy: Always use actual note content, not just summary.
/// - Short notes (≤1000 chars): use full content
/// - Long notes (>1000 chars): summary + content first 500 chars
fn build_rich_context(conn: &rusqlite::Connection, vault_path: &str, note_path: &str, ai_summary: &str) -> String {
    // Read actual content from filesystem (notes table doesn't store content)
    let abs_path = format!("{}/{}", vault_path, note_path);
    let mut content = std::fs::read_to_string(&abs_path).unwrap_or_default();

    // Inject media cache if present (replace ![]() with extracted text)
    if let Ok(media_regex) = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
        let mut replacements = Vec::new();
        for cap in media_regex.captures_iter(&content) {
            let full_match = cap.get(0).unwrap().as_str().to_string();
            let asset_rel = &cap[1];
            let filename = std::path::Path::new(asset_rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown");
            
            let asset_hash = std::path::Path::new(filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(filename)
                .to_string();
                
            let cached: Option<String> = conn.query_row(
                "SELECT enriched_text FROM media_enrich_cache WHERE asset_hash = ?1",
                rusqlite::params![&asset_hash],
                |row| row.get(0),
            ).ok();
            
            if let Some(text) = cached {
                replacements.push((full_match, format!("\n[Media: {}]\n{}\n", filename, text)));
            }
        }
        
        // Apply replacements
        for (old, new) in replacements {
            content = content.replace(&old, &new);
        }
    }

    // Strip YAML frontmatter if present
    let content = if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            content[3 + end + 3..].trim().to_string()
        } else {
            content
        }
    } else {
        content
    };

    let char_count = content.chars().count();

    if char_count == 0 {
        // No content at all, use whatever summary we have
        return ai_summary.to_string();
    }

    if char_count <= 1000 {
        // Short note: use full content
        content
    } else if !ai_summary.trim().is_empty() {
        // Long note with summary: combine summary + content excerpt
        let content_excerpt: String = content.chars().take(500).collect();
        format!("{}\n\n---\n内容节选：{}", ai_summary, content_excerpt)
    } else {
        // Long note without summary: just truncate content
        content.chars().take(800).collect()
    }
}

// ============================================================================

/// Get ghost links (similar notes based on embeddings)
#[tauri::command]
pub fn get_ghost_links(
    note_path: String,
    threshold: Option<f64>,
    db_state: State<DbStateWrapper>,
) -> Result<crate::core::ai::skills::ghostlink::GhostLinkResult, String> {
    // Debug: request counter for tracing duplicate calls
    use std::sync::atomic::{AtomicU64, Ordering};
    static REQUEST_ID: AtomicU64 = AtomicU64::new(0);
    let req_id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
    log::debug!(
        "🔮 [GhostLink] get_ghost_links called, req_id={}, path={}, threshold={:?}",
        req_id, note_path, threshold
    );

    // Convert absolute path to relative path (embeddings table uses relative paths)
    let vault_path_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let relative_path = Path::new(&note_path)
        .strip_prefix(&vault_path_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    db_state.0.with_connection(|conn| {
        // Check if ghostlink skill is enabled
        let skill_config = crate::core::db::repository::load_skill_config(conn, "ghostlink")
            .ok()
            .flatten();

        // If skill is disabled, return empty result immediately
        if let Some(ref cfg) = skill_config {
            if !cfg.enabled {
                log::debug!("🚫 [GhostLink] Skill is disabled by user configuration");
                return Ok(crate::core::ai::skills::ghostlink::GhostLinkResult { notes: vec![] });
            }
        }

        // Use frontend threshold first, fallback to skill config, then default 0.60
        let effective_threshold = threshold.unwrap_or_else(|| {
            skill_config
                .as_ref()
                .and_then(|cfg| {
                    serde_json::from_str::<serde_json::Value>(&cfg.config)
                        .ok()
                        .and_then(|v| v.get("similarity_threshold").and_then(|t| t.as_f64()))
                })
                .unwrap_or(0.60)
        });

        let mut result = crate::core::ai::skills::ghostlink::find_similar_notes(
            conn,
            &relative_path,
            5,
            effective_threshold,
        )?;

        log::debug!(
            "🔮 [GhostLink] get_ghost_links result: {} notes found for '{}'",
            result.notes.len(),
            relative_path
        );
        for note in &result.notes {
            log::debug!(
                "🔮 [GhostLink]   → {} (sim={:.3})",
                note.note_path, note.similarity
            );
        }

        // Convert relative paths back to absolute for frontend
        let vault_str = vault_path_str.to_string_lossy();
        for note in &mut result.notes {
            note.note_path = format!("{}/{}", vault_str, note.note_path);
        }

        Ok(result)
    })
}

// ============================================================================
// Ghost Link Management
// ============================================================================

/// Ignore a ghost link recommendation (add to blacklist)
#[tauri::command]
pub fn ignore_ghost_link(
    source_path: String,
    target_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    // Convert absolute paths to relative paths (matching how links are stored in DB)
    let vault_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?
        .to_string_lossy()
        .to_string();

    let relative_source = if source_path.starts_with(&vault_str) {
        source_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        source_path.clone()
    };

    let relative_target = if target_path.starts_with(&vault_str) {
        target_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        target_path.clone()
    };

    db_state.0.with_connection(|conn| {
        // BUG-D10: 双向写入黑名单 — 在 A 端拒绝后 B 端也不再推荐
        crate::core::db::repository::add_ghost_link_blacklist(
            conn,
            &relative_source,
            &relative_target,
        )?;
        crate::core::db::repository::add_ghost_link_blacklist(
            conn,
            &relative_target,
            &relative_source,
        )?;
        Ok(())
    })?;

    log::debug!(
        "🚫 [GhostLink] Blacklisted (bidirectional): {} <-> {}",
        relative_source, relative_target
    );
    Ok(())
}

// ============================================================================
// AI Reasoning for Ghost Links
// ============================================================================

// trigger_ghostlink_reasoning removed — GhostLink is now manual-only.
// Frontend triggers via onRefresh → invoke('get_ghost_links') + invoke('get_ghost_link_reasons').

/// Request AI reasoning for ghost link candidates (non-blocking)
/// Uses Read-Through Cache: returns cached results if mtime matches, otherwise calls LLM
/// Immediately returns, then emits 'ghost-link-reasons' event with results
#[tauri::command]
pub fn get_ghost_link_reasons(
    source_path: String,
    target_paths: Vec<String>,
    target_mtimes: Vec<i64>, // mtime for each target (for cache validation)
    target_similarities: Option<Vec<f64>>, // similarity scores for prompt context
    db_state: State<DbStateWrapper>,
    ai_state: State<AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use crate::core::ai::skills::reasoning::TargetCandidate;
    use crate::core::db::repository::get_cached_suggestion;

    log::debug!("🧠 [GhostLinkReasons] Called with {} targets, {} mtimes",
        target_paths.len(),
        target_mtimes.len()
    );

    // Get vault path for relative path conversion
    let vault_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?
        .to_string_lossy()
        .to_string();

    let relative_source = if source_path.starts_with(&vault_str) {
        source_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        source_path.clone()
    };

    // Provider-agnostic cache key: note relationships are factual, not model-dependent
    let provider_key = "unified".to_string();

    // Get source mtime and summaries from database
    // Strategy: Always use note content for maximum LLM context
    // - Short notes (≤1000 chars): use full content
    // - Long notes (>1000 chars): summary + content first 500 chars
    let (source_mtime, source_summary, source_title, targets): (
        i64,
        String,
        String,
        Vec<(String, TargetCandidate, i64)>,
    ) = db_state.0.with_connection(|conn| {
        // Get source note info
        let (source_title, source_ai_summary, source_mtime): (String, String, i64) = conn
            .query_row(
                "SELECT n.title, COALESCE(n.user_summary, a.summary, ''), n.mtime FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                rusqlite::params![&relative_source],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or(("".to_string(), "".to_string(), 0));

        // Build rich context: content-first strategy
        let source_summary = build_rich_context(conn, &vault_str, &relative_source, &source_ai_summary);

        // Get target summaries with their relative paths
        let mut targets: Vec<(String, TargetCandidate, i64)> = Vec::new();
        for (i, target_path) in target_paths.iter().enumerate() {
            let relative_target = if target_path.starts_with(&vault_str) {
                target_path[vault_str.len()..]
                    .trim_start_matches('/')
                    .to_string()
            } else {
                target_path.clone()
            };

            let target_mtime = target_mtimes.get(i).copied().unwrap_or(0);

            let (title, ai_summary): (String, String) = conn
                .query_row(
                    "SELECT n.title, COALESCE(n.user_summary, a.summary, '') FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                    rusqlite::params![&relative_target],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or((relative_target.clone(), "".to_string()));

            // Build rich context for target too
            let summary = build_rich_context(conn, &vault_str, &relative_target, &ai_summary);

            let sim = target_similarities
                .as_ref()
                .and_then(|sims| sims.get(i).copied())
                .unwrap_or(0.0);

            targets.push((
                relative_target,
                TargetCandidate {
                    title,
                    summary,
                    similarity: sim,
                },
                target_mtime,
            ));
        }

        Ok((source_mtime, source_summary, source_title, targets))
    })?;

    // If no targets, emit empty result immediately
    if targets.is_empty() {
        let _ = app_handle.emit(
            "ghost-link-reasons",
            serde_json::json!({
                "source_path": source_path,
                "results": []
            }),
        );
        return Ok(());
    }

    // If source summary is empty (content cleared/too short), use title as fallback
    // instead of skipping. This ensures new notes still get reasoning results.
    let source_summary = if source_summary.trim().is_empty() {
        if source_title.trim().is_empty() {
            // Both empty — truly nothing to reason about
            log::debug!("⏭️ [GhostLinkReasons] Skipping - no content or title for: {}",
                relative_source
            );
            let _ = app_handle.emit(
                "ghost-link-reasons",
                serde_json::json!({
                    "source_path": source_path,
                    "results": []
                }),
            );
            return Ok(());
        }
        log::debug!("📝 [GhostLinkReasons] Source summary empty, using title as fallback: {}",
            source_title
        );
        source_title.clone()
    } else {
        source_summary
    };

    // Fix 04: Minimum source content guard — skip LLM if too short to reason about
    if source_summary.chars().count() < 20 {
        log::debug!("⏭️ [GhostLinkReasons] Skipped - insufficient source content ({} chars < 20): '{}'",
            source_summary.chars().count(),
            source_summary
        );
        let _ = app_handle.emit(
            "ghost-link-reasons",
            serde_json::json!({
                "source_path": source_path,
                "results": []
            }),
        );
        return Ok(());
    }

    // Check cache for each target - collect hits and misses
    // Supports bidirectional cache: if A→B is cached, reuse for B→A (and vice versa)
    // This halves LLM calls since the relationship is symmetric
    let (cached_results, cache_misses): (
        Vec<(usize, String, String, String)>,
        Vec<(usize, String, TargetCandidate, i64)>,
    ) = db_state.0.with_connection(|conn| {
        let mut cached = Vec::new();
        let mut misses = Vec::new();

        for (i, (relative_target, candidate, target_mtime)) in targets.into_iter().enumerate() {
            // Try forward cache: source → target
            match get_cached_suggestion(
                conn,
                &relative_source,
                &relative_target,
                source_mtime,
                target_mtime,
                &provider_key,
            ) {
                Ok(Some((relation, reason))) => {
                    log::debug!(
                        "✅ [Cache HIT] {} -> {}: {}",
                        relative_source, relative_target, relation
                    );
                    cached.push((i, relative_target.clone(), relation, reason));
                }
                _ => {
                    // Try reverse cache: target → source (bidirectional)
                    match get_cached_suggestion(
                        conn,
                        &relative_target,
                        &relative_source,
                        target_mtime,
                        source_mtime,
                        &provider_key,
                    ) {
                        Ok(Some((relation, reason))) => {
                            log::debug!(
                                "✅ [Cache HIT reverse] {} <- {}: {}",
                                relative_source, relative_target, relation
                            );
                            cached.push((i, relative_target.clone(), relation, reason));
                        }
                        _ => {
                            log::debug!("❌ [Cache MISS] {} -> {}", relative_source, relative_target);
                            misses.push((i, relative_target, candidate, target_mtime));
                        }
                    }
                }
            }
        }

        Ok((cached, misses))
    })?;

    // If all cached, emit results immediately
    if cache_misses.is_empty() {
        log::debug!("🚀 [GhostLinkReasons] All {} results from cache!",
            cached_results.len()
        );
        let json_results: Vec<serde_json::Value> = cached_results
            .into_iter()
            .map(|(_, target_path, relation, reason)| {
                // Convert relative to absolute path (match get_ghost_links format)
                let abs_target = format!("{}/{}", vault_str, target_path);
                serde_json::json!({ "target_path": abs_target, "relation": relation, "reason": reason })
            })
            .collect();

        let _ = app_handle.emit(
            "ghost-link-reasons",
            serde_json::json!({
                "source_path": source_path,
                "results": json_results,
                "all_cached": true
            }),
        );
        return Ok(());
    }

    // Build per-target prompts for individual LLM calls
    // Processing targets one-by-one is more reliable for local LLMs:
    // - Shorter prompts = better quality
    // - One failure doesn't affect others
    // - Results appear incrementally in the UI

    let runtime = ai_state.runtime.clone();
    let source_path_clone = source_path.clone();
    let vault_path_clone = vault_str.clone();
    let provider_key_clone = provider_key.clone();
    let relative_source_clone = relative_source.clone();

    // CRITICAL: Emit cached results immediately so frontend shows them while waiting for LLM
    if !cached_results.is_empty() {
        log::debug!("🚀 [GhostLinkReasons] Emitting {} cached results first (before LLM)",
            cached_results.len()
        );
        let cached_json: Vec<serde_json::Value> = cached_results
            .iter()
            .map(|(_, target_path, relation, reason)| {
                let abs_target = format!("{}/{}", vault_str, target_path);
                serde_json::json!({ "target_path": abs_target, "relation": relation, "reason": reason })
            })
            .collect();
        let _ = app_handle.emit(
            "ghost-link-reasons",
            serde_json::json!({
                "source_path": source_path,
                "results": cached_json
            }),
        );
    }

    if let Some(queue) = ai_state.queue.get() {
        for (_idx, relative_target, candidate, target_mtime) in cache_misses {
            // P2 Guard: skip if target has no meaningful content
            if candidate.summary.trim().is_empty() {
                log::debug!("⏭️ [GhostLinkReasons] Skipping LLM for {}: target summary empty, emitting default 'related'", relative_target);
                let abs_target = format!("{}/{}", vault_path_clone, relative_target);
                let _ = app_handle.emit(
                    "ghost-link-reasons",
                    serde_json::json!({
                        "source_path": source_path_clone,
                        "results": [{ "target_path": abs_target, "relation": "related", "reason": "" }]
                    }),
                );
                continue;
            }

            let candidate_summary = serde_json::to_string(&candidate).unwrap_or_default();
            let job = crate::core::ai::queue::HeavyJob::GhostLinkReason {
                source_path: relative_source_clone.clone(),
                target_path: relative_target,
                candidate_summary,
                source_mtime,
                target_mtime,
                source_title: source_title.clone(),
                source_summary: source_summary.clone(),
                provider_key: provider_key_clone.clone(),
            };
            let queue_clone = queue.clone();
            runtime.spawn(async move {
                let _ = queue_clone.submit_heavy(job).await;
            });
        }
    } else {
        log::debug!("⚠️ [GhostLinkReasons] AI Queue not initialized!");
    }

    log::debug!("🧠 [GhostLinkReasons] Command returned immediately (LLM running in background)");
    Ok(())
}

// ============================================================================
// Read-only: Load cached reasoning results without triggering LLM
// ============================================================================

/// Load cached ghost link reasoning results from DB (read-only, no LLM).
/// Returns a map of target_path → { relation, reason } for all cached entries.
/// Used on app restart to instantly display previously generated reasoning.
#[tauri::command]
pub fn get_cached_ghost_link_reasons(
    source_path: String,
    target_paths: Vec<String>,
    target_mtimes: Vec<i64>,
    db_state: State<DbStateWrapper>,
) -> Result<Vec<serde_json::Value>, String> {
    use crate::core::db::repository::get_cached_suggestion;
    use rusqlite::params;

    let vault_str = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?
        .to_string_lossy()
        .to_string();

    let relative_source = if source_path.starts_with(&vault_str) {
        source_path[vault_str.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        source_path.clone()
    };

    let provider_key = "unified";

    let source_mtime: i64 = db_state
        .0
        .with_connection(|conn| {
            Ok(conn
                .query_row(
                    "SELECT mtime FROM notes WHERE path = ?1",
                    params![&relative_source],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0))
        })
        .unwrap_or(0);

    let mut results = Vec::new();

    db_state.0.with_connection(|conn| {
        for (i, target_path) in target_paths.iter().enumerate() {
            let relative_target = if target_path.starts_with(&vault_str) {
                target_path[vault_str.len()..]
                    .trim_start_matches('/')
                    .to_string()
            } else {
                target_path.clone()
            };

            let target_mtime = target_mtimes.get(i).copied().unwrap_or(0);

            // Try forward cache: source → target
            let cached = get_cached_suggestion(
                conn,
                &relative_source,
                &relative_target,
                source_mtime,
                target_mtime,
                provider_key,
            )
            .ok()
            .flatten()
            .or_else(|| {
                // Try reverse cache: target → source
                get_cached_suggestion(
                    conn,
                    &relative_target,
                    &relative_source,
                    target_mtime,
                    source_mtime,
                    provider_key,
                )
                .ok()
                .flatten()
            });

            if let Some((relation, reason)) = cached {
                results.push(serde_json::json!({
                    "target_path": target_path,
                    "relation": relation,
                    "reason": reason
                }));
            }
        }
        Ok(())
    })?;

    Ok(results)
}

pub async fn process_heavy_ghostlink_reason(
    app_handle: tauri::AppHandle,
    source_path: String,
    target_path: String,
    candidate_summary: String,
    source_mtime: i64,
    target_mtime: i64,
    source_title: String,
    source_summary: String,
    provider_key: String,
) {
    use crate::core::ai::skills::reasoning::{ReasoningInput, ReasoningSkill, TargetCandidate};
    use crate::core::db::repository::upsert_suggestion_cache;
    use tauri::Manager;
    
    let ai_state = app_handle.state::<AIStateWrapper>();
    let db_state = app_handle.state::<DbStateWrapper>();
    
    let vault_str = db_state.0.vault_path.lock().unwrap().clone().unwrap_or_default().to_string_lossy().to_string();
    
    let candidate: TargetCandidate = serde_json::from_str(&candidate_summary).unwrap_or(TargetCandidate {
        title: target_path.clone(),
        summary: "".to_string(),
        similarity: 0.0,
    });
    
    let single_input = ReasoningInput {
        source_title: source_title.clone(),
        source_summary: source_summary.clone(),
        targets: vec![candidate.clone()],
    };
    
    let prompt_content = crate::core::ai::skills::reasoning::build_reasoning_prompt(&single_input);
    let service = ai_state.resolve_for_path(std::path::Path::new(&vault_str), &source_path);
    let start_time = std::time::Instant::now();
    
    let llm_result = service.execute_skill(&ReasoningSkill, &prompt_content).await;
    let elapsed = start_time.elapsed();
    
    let db_path = std::path::Path::new(&vault_str).join(".slash").join("slash.db");
    let db_conn = rusqlite::Connection::open(&db_path).ok();
    
    let abs_source = format!("{}/{}", vault_str, source_path);
    let abs_target = format!("{}/{}", vault_str, target_path);

    match llm_result {
        Ok(results) => {
            if let Some(result) = results.first() {
                log::debug!("✅ [GhostLinkReason] Got result for {} ({:?})", target_path, elapsed);
                if let Some(ref conn) = db_conn {
                    let source_exists: bool = conn.query_row("SELECT 1 FROM notes WHERE path = ?1", rusqlite::params![&source_path], |_| Ok(true)).unwrap_or(false);
                    let target_exists: bool = conn.query_row("SELECT 1 FROM notes WHERE path = ?1", rusqlite::params![&target_path], |_| Ok(true)).unwrap_or(false);
                    
                    if source_exists && target_exists {
                        let _ = upsert_suggestion_cache(conn, &source_path, &target_path, source_mtime, target_mtime, &result.relation, &result.reason, &provider_key);
                        let _ = upsert_suggestion_cache(conn, &target_path, &source_path, target_mtime, source_mtime, &result.relation, &result.reason, &provider_key);
                    }
                }
                let _ = app_handle.emit("ghost-link-reasons", serde_json::json!({
                    "source_path": abs_source,
                    "results": [{ "target_path": abs_target, "relation": result.relation, "reason": result.reason }]
                }));
            } else {
                let _ = app_handle.emit("ghost-link-reasons", serde_json::json!({
                    "source_path": abs_source,
                    "results": [{ "target_path": abs_target, "relation": "related", "reason": "" }]
                }));
            }
        }
        Err(_) => {
            let _ = app_handle.emit("ghost-link-reasons", serde_json::json!({
                "source_path": abs_source,
                "results": [{ "target_path": abs_target, "relation": "related", "reason": "" }]
            }));
        }
    }
}
