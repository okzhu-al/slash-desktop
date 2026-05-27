//! Classification Commands
//!
//! Tauri commands for Smart Classification feature.

use serde::{Deserialize, Serialize};
// Removed unused sha2::Digest
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;
use std::sync::Mutex;
use tauri::{State, Emitter};

use crate::core::ai::skills::classification::{
    build_classification_prompt, build_note_query_profile, find_top_folders,
    folder_name_similarity, get_allowed_categories, parse_llm_response, ClassificationInput,
    ClassificationSuggestion,
};
use crate::core::db::repository::{
    self as repository, get_all_folder_embeddings, get_classification_cache, mark_folder_dirty, save_classification_cache, upsert_folder_embedding, FolderEmbedding,
};
use crate::{AIStateWrapper, DbStateWrapper};

// ============================================================================
// IN-FLIGHT DEDUP LOCK
// ============================================================================

/// Tracks content_hashes currently being classified to prevent duplicate LLM calls.
static INFLIGHT_CLASSIFICATIONS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Tracks last folder embedding refresh time to avoid redundant scans (5-min cooldown).
static LAST_FOLDER_REFRESH: LazyLock<Mutex<Option<std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(None));

/// RAII guard that automatically removes content_hash from INFLIGHT_CLASSIFICATIONS on drop.
/// This guarantees the lock is released even if the function returns early via `?` or panic.
struct InflightGuard(String);
impl Drop for InflightGuard {
    fn drop(&mut self) {
        let mut inflight = INFLIGHT_CLASSIFICATIONS.lock().unwrap();
        inflight.remove(&self.0);
        log::debug!(
            "🔓 [Classification] In-flight lock released for hash {}",
            &self.0[..16.min(self.0.len())]
        );
    }
}

// ============================================================================
// DATA STRUCTURES
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub suggestions: Vec<ClassificationSuggestion>,
    pub has_pending_tasks: bool,
    pub query_profile: String,
}

// ============================================================================
// Shared Decision Logic
// ============================================================================

/// Resolve each suggestion's decision type based on filesystem existence.
/// - Path exists → Select
/// - Path NOT exists → Create (LLM proposal preserved, not overwritten)
fn resolve_decisions(
    suggestions: &mut [ClassificationSuggestion],
    vault_path: &std::path::Path,
    top_folders: &[(String, f32)],
) -> bool {
    let mut any_create = false;
    for suggestion in suggestions.iter_mut() {
        let full_folder_path = vault_path.join(&suggestion.folder_path);
        let exists_in_filesystem = full_folder_path.exists() && full_folder_path.is_dir();

        let candidate_match = top_folders
            .iter()
            .find(|(p, _)| *p == suggestion.folder_path);

        // log::debug!("🔍 [Classification] Checking path='{}', exists={}, is_candidate={}", suggestion.folder_path, exists_in_filesystem, candidate_match.is_some());

        if exists_in_filesystem {
            if let Some((_, sim)) = candidate_match {
                suggestion.similarity = *sim;
            }
            suggestion.decision =
                crate::core::ai::skills::classification::ClassificationDecision::Select;
        // log::debug!("✅ [Classification] Path '{}' exists → Select", suggestion.folder_path);
        } else {
            suggestion.decision =
                crate::core::ai::skills::classification::ClassificationDecision::Create;
            suggestion.reason = format!("{} [new_folder_proposal]", suggestion.reason);
            any_create = true;
            // log::debug!("📁 [Classification] Path '{}' does NOT exist → Create", suggestion.folder_path);
        }
    }
    any_create
}

/// Post-process LLM suggestions: resolve decisions + semantic dedup + 03_Resources fallback.
/// Used by both `get_classification_suggestions` and `trigger_classification`.
fn post_process_suggestions(
    suggestions: &mut Vec<ClassificationSuggestion>,
    vault_path: &std::path::Path,
    top_folders: &[(String, f32)],
    folder_embeddings: &[FolderEmbedding],
) -> bool {
    let mut has_create = resolve_decisions(suggestions, vault_path, top_folders);

    // Semantic deduplication: if a Create proposal is similar to an existing folder,
    // replace it with the existing folder (Select) to prevent structural divergence.
    if has_create {
        for suggestion in suggestions.iter_mut() {
            if !matches!(
                suggestion.decision,
                crate::core::ai::skills::classification::ClassificationDecision::Create
            ) {
                continue;
            }

            let proposal_prefix = suggestion.folder_path.split('/').next().unwrap_or("");
            let mut best_match: Option<(String, f32)> = None;
            for fe in folder_embeddings {
                let existing_prefix = fe.folder_path.split('/').next().unwrap_or("");
                if existing_prefix != proposal_prefix {
                    continue;
                }
                let sim = folder_name_similarity(&suggestion.folder_path, &fe.folder_path);
                if sim > 0.5 {
                    if best_match
                        .as_ref()
                        .map_or(true, |(_, best_sim)| sim > *best_sim)
                    {
                        best_match = Some((fe.folder_path.clone(), sim));
                    }
                }
            }

            if let Some((existing_path, sim)) = best_match {
                log::debug!(
                    "🔄 [Classification] Dedup: '{}' → '{}' (name similarity: {:.0}%)",
                    suggestion.folder_path,
                    existing_path,
                    sim * 100.0
                );
                let original_proposal = suggestion.folder_path.clone();
                suggestion.folder_path = existing_path;
                suggestion.decision =
                    crate::core::ai::skills::classification::ClassificationDecision::Select;
                suggestion.reason = format!(
                    "{} [已有近似目录，原提案: {}]",
                    suggestion.reason.replace(" [new_folder_proposal]", ""),
                    original_proposal
                );
                if let Some((_, top_sim)) = top_folders
                    .iter()
                    .find(|(p, _)| *p == suggestion.folder_path)
                {
                    suggestion.similarity = *top_sim;
                }
            }
        }

        // Recheck flag
        has_create = suggestions.iter().any(|s| {
            matches!(
                s.decision,
                crate::core::ai::skills::classification::ClassificationDecision::Create
            )
        });
    }

    // When Create proposals still exist, ensure 03_Resources is available as safe fallback
    if has_create {
        let already_has_resources = suggestions.iter().any(|s| s.folder_path == "03_Resources");
        if !already_has_resources {
            suggestions.push(ClassificationSuggestion {
                folder_path: "03_Resources".to_string(),
                similarity: 0.0,
                reason: "安全备选：通用参考资料目录".to_string(),
                decision: crate::core::ai::skills::classification::ClassificationDecision::Select,
            });
            log::debug!("📁 [Classification] Appended 03_Resources as safe fallback");
        }
    }

    has_create
}

// ============================================================================
// Backend-triggered Classification (no State<> dependency)
// ============================================================================

/// Trigger classification directly from backend orchestrator.
/// Called after orchestrator skills complete for Inbox notes.
/// Runs classification LLM and emits results via app_handle events.
// [trigger_classification removed - atomic skill architecture]

// ============================================================================
// COMMANDS
// ============================================================================

/// Get classification suggestions for a note
#[tauri::command]
pub async fn get_classification_suggestions(
    note_path: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<ClassificationResult, String> {
    log::debug!("🗂️ [Classification] Submitting to queue: {}", note_path);

    if let Some(queue) = ai_state.queue.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        
        // Calculate content hash for the note content (we need to read it first, or just pass empty if we re-read in worker)
        // Wait, the worker reads the actual DB for latest info. 
        // Note: the original code reads the file content to compute hash, or it uses the path?
        // Let's look at the original code. 
        // Ah, it reads the note content to build query profile and embeddings.
        // I will just read the file content here to get hash.
        let vault_path = _db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
        let relative_path = if note_path.starts_with(vault_path.to_string_lossy().as_ref()) {
            note_path.strip_prefix(vault_path.to_string_lossy().as_ref()).unwrap_or(&note_path).trim_start_matches('/').to_string()
        } else {
            note_path.clone()
        };
        let full_path = std::path::Path::new(&vault_path).join(&relative_path);
        let content_str = std::fs::read_to_string(&full_path).unwrap_or_default();
        let content_hash = slash_core::calculate_content_hash(&content_str);

        let _ = queue.submit_heavy(crate::core::ai::queue::HeavyJob::Classification {
            note_path: relative_path,
            content_hash,
            responder: tx,
        }).await;
        rx.await.unwrap_or_else(|_| Err("Queue communication failed".to_string()))
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_heavy_classification(
    app_handle: tauri::AppHandle,
    relative_path: String,
    content_hash: String,
) -> Result<ClassificationResult, String> {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    log::debug!("🗂️ [Classification] Worker processing: {}", relative_path);

    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    // Step 1: Get note metadata from database
    let (title, user_tags, ai_tags, summary, has_pending_tasks) = db_state.0.with_connection(|conn| {
        // Get note info
        let (title, ai_summary, user_tags_str, ai_tags_str): (String, String, String, String) = conn
            .query_row(
                "SELECT n.title, COALESCE(a.summary, ''), COALESCE(n.user_tags, ''), COALESCE(a.tags, '') FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                rusqlite::params![&relative_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;

        // Parse tags from JSON arrays
        let user_tags: Vec<String> = serde_json::from_str(&user_tags_str).unwrap_or_default();
        let ai_tags: Vec<String> = serde_json::from_str(&ai_tags_str).unwrap_or_default();

        // Check for pending tasks
        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE note_path = ?1 AND status = 'pending'",
                rusqlite::params![&relative_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Result::<_, rusqlite::Error>::Ok((title, user_tags, ai_tags, ai_summary, pending_count > 0))
    }).map_err(|e| format!("Database error: {}", e))?;

    // Step 1.6: Check cache
    {
        let cached_result = db_state.0.with_connection(|conn| {
            get_classification_cache(conn, &relative_path, &content_hash)
        }).map_err(|e| format!("DB Error: {}", e))?;

        if let Some(cached_json) = cached_result {
            log::debug!("✅ [Classification] Cache hit! Returning cached result.");
            let mut cached: ClassificationResult = serde_json::from_str(&cached_json)
                .map_err(|e| format!("Failed to parse cached result: {}", e))?;
            cached.query_profile = "[Cached]".to_string();
            return Ok(cached);
        }
    }

    // In-flight dedup: prevent duplicate LLM calls for same content
    {
        let mut inflight = INFLIGHT_CLASSIFICATIONS.lock().unwrap();
        if inflight.contains(&content_hash) {
            log::debug!(
                "⏭️ [Classification] Skipping — already in-flight for hash {}",
                &content_hash[..16]
            );
            return Ok(ClassificationResult {
                suggestions: vec![],
                has_pending_tasks,
                query_profile: format!("[Dedup] Already processing hash {}…", &content_hash[..16]),
            });
        }
        inflight.insert(content_hash.clone());
    }
    // RAII guard: ensures lock is released on any exit path (?, panic, early return)
    let _inflight_guard = InflightGuard(content_hash.clone());
    log::debug!(
        "📭 [Classification] Running AI classification... (hash {} locked)",
        &content_hash[..16]
    );

    // Step 3: Build note query profile
    let input = ClassificationInput {
        note_path: relative_path.clone(),
        title: title.clone(),
        user_tags: user_tags.clone(),
        ai_tags: ai_tags.clone(),
        summary: summary.clone(),
        has_pending_tasks,
        full_text: None,
    };
    let query_profile = build_note_query_profile(&input);
    log::debug!(
        "🗂️ [Classification] Query profile ({} chars):
{}",
        query_profile.chars().count(),
        query_profile
    );

    // Step 3: Get folder embeddings
    let folder_embeddings = db_state
        .0
        .with_connection(|conn| get_all_folder_embeddings(conn)).map_err(|e| format!("DB Error: {}", e))?;

    // Step 3.5: Filter out folders that no longer exist on filesystem
    let vault_str = vault_path.to_string_lossy();
    let folder_embeddings: Vec<_> = folder_embeddings
        .into_iter()
        .filter(|fe| {
            let full_path = format!("{}/{}", vault_str, fe.folder_path);
            let exists = std::path::Path::new(&full_path).is_dir();
            if !exists {
                log::debug!(
                    "🗑️ [Classification] Filtering out non-existent folder: {}",
                    fe.folder_path
                );
            }
            exists
        })
        .collect();

    log::debug!(
        "🗂️ [Classification] {} valid folders after filesystem check",
        folder_embeddings.len()
    );

    // Step 4: Calculate note embedding
    let effective = crate::core::ai::folder_config::resolve_config_for_path(std::path::Path::new(&vault_path), &relative_path, ai_state.service().config());
    let service = ai_state.resolve_for_path(&vault_path, &relative_path);
    
    // Check if degradation occurred
    if effective.provider_type == "online" && service.config().provider_type == "local" {
        let _ = app_handle.emit("ai:degraded", serde_json::json!({
            "message": "ai_provider_degraded",
            "skill": "classification"
        }));
    }

    let query_profile_clone = query_profile.clone();

    let note_embedding: Vec<f32> = service
        .generate_embedding(&query_profile_clone)
        .await
        .map_err(|e| format!("Failed to get note embedding: {}", e))?;

    // Step 5: Hard routing - get allowed categories
    let allowed = get_allowed_categories(has_pending_tasks);

    // Step 6: Vector search for top folders
    let top_folders = find_top_folders(&note_embedding, &folder_embeddings, &allowed, 5);
    log::debug!("🗂️ [Classification] Top folders: {:?}", top_folders);

    // Step 7: Call LLM for judgment (Rule 6)
    // Rule 6.2: candidates = 0 - call LLM to generate new folder
    // Rule 6.1/6.3: candidates > 0 - call LLM to judge
    let prompt = build_classification_prompt(&input, &top_folders);
    log::debug!(
        "🗂️ [Classification] LLM prompt ({} chars):
{}",
        prompt.chars().count(),
        prompt
    );

    // Use RawPromptSkill - no system prompt, direct passthrough
    // This ensures our classification prompt is sent exactly as-is
    let llm_response = service
        .execute_skill(&crate::core::ai::skills::RawPromptSkill, &prompt)
        .await
        .map_err(|e| format!("LLM call failed: {}", e))?;

    log::debug!("🗂️ [Classification] LLM response: {}", llm_response);

    // Track parse success and whether any Create proposals exist
    let mut parse_succeeded = true;
    let mut has_create_proposals = false;

    let suggestions = match parse_llm_response(&llm_response) {
        Ok(mut parsed_suggestions) => {
            has_create_proposals = post_process_suggestions(
                &mut parsed_suggestions,
                &vault_path,
                &top_folders,
                &folder_embeddings,
            );
            parsed_suggestions
        }
        Err(e) => {
            log::warn!("⚠️ [Classification] Failed to parse LLM response: {}", e);

            // Stage 2: LLM repair attempt before falling back to vector match
            let mut repaired_suggestions = None;
            if let Ok(repaired_json) = service.repair_with_llm(&llm_response).await {
                if let Ok(mut parsed) = parse_llm_response(&repaired_json) {
                    log::debug!(
                        "✅ [Classification] LLM repair succeeded, got {} suggestions",
                        parsed.len()
                    );
                    has_create_proposals =
                        resolve_decisions(&mut parsed, &vault_path, &top_folders);
                    repaired_suggestions = Some(parsed);
                }
            }

            if let Some(suggestions) = repaired_suggestions {
                suggestions
            } else {
                parse_succeeded = false;
                // Fall back to top vector match or 03_Resources
                if top_folders.is_empty() {
                    vec![ClassificationSuggestion {
                        folder_path: "03_Resources".to_string(),
                        similarity: 0.0,
                        reason: "无法解析AI响应，建议放入资源目录".to_string(),
                        decision:
                            crate::core::ai::skills::classification::ClassificationDecision::Select,
                    }]
                } else {
                    top_folders
                        .into_iter()
                        .take(3)
                        .map(|(path, sim)| ClassificationSuggestion {
                            folder_path: path,
                            similarity: sim,
                            reason: "基于向量相似度匹配".to_string(),
                            decision:
                                crate::core::ai::skills::classification::ClassificationDecision::Select,
                        })
                        .collect()
                }
            }
        }
    };

    // Cache all parse-successful results (including Create proposals).
    // The decision type (Select/Create) is preserved in the cached JSON,
    // so the frontend can distinguish and display them correctly.
    // Only skip cache for parse failures (fallback results).
    let result = ClassificationResult {
        suggestions,
        has_pending_tasks,
        query_profile,
    };

    if parse_succeeded {
        let cache_json = serde_json::to_string(&result)
            .map_err(|e| format!("Failed to serialize result for cache: {}", e))?;

        if let Err(e) = db_state.0.with_connection(|conn| {
            save_classification_cache(
                conn,
                &relative_path,
                &content_hash,
                &cache_json,
                has_pending_tasks,
            )
        }) {
            log::warn!("⚠️ [Classification] Failed to save cache: {}", e);
        }
        if has_create_proposals {
            log::debug!(
                "💾 [Classification] Result cached (includes Create proposals for user review)."
            );
        } else {
            log::debug!("💾 [Classification] Result cached (all Select).");
        }
    } else {
        log::debug!("⏭️ [Classification] Skipping cache — parse failed, using fallback result");
    }

    // In-flight lock is released automatically by _inflight_guard Drop

    Ok(result)
}

/// Accept a classification suggestion and move the file
#[tauri::command]
pub async fn accept_classification(
    note_path: String,
    target_folder: String,
    create_if_not_exists: bool,
    db_state: State<'_, DbStateWrapper>,
) -> Result<String, String> {
    log::debug!(
        "🗂️ [Classification] Moving {} to {}",
        note_path, target_folder
    );

    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let vault_str = vault_path.to_string_lossy();

    // Get absolute paths
    let abs_source = if note_path.starts_with(&*vault_str) {
        note_path.clone()
    } else {
        format!("{}/{}", vault_str, note_path)
    };

    // Handle target_folder - remove leading slashes if present
    let target_folder_clean = target_folder.trim_start_matches('/');
    let abs_target_folder = format!("{}/{}", vault_str, target_folder_clean);

    log::debug!(
        "🗂️ [Classification] abs_source: {}, abs_target_folder: {}",
        abs_source, abs_target_folder
    );

    // Check if source file exists
    if !Path::new(&abs_source).exists() {
        return Err(format!("Source file does not exist: {}", abs_source));
    }

    // Create target folder if needed
    if create_if_not_exists {
        std::fs::create_dir_all(&abs_target_folder)
            .map_err(|e| format!("Failed to create folder: {}", e))?;
    }

    // Check if target folder exists
    if !Path::new(&abs_target_folder).is_dir() {
        return Err(format!(
            "Target folder does not exist: {}",
            abs_target_folder
        ));
    }

    // Get filename
    let filename = Path::new(&abs_source)
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy();

    let abs_target = format!("{}/{}", abs_target_folder, filename);

    log::debug!("🗂️ [Classification] Moving file to: {}", abs_target);

    // Move the file
    std::fs::rename(&abs_source, &abs_target).map_err(|e| format!("Failed to move file: {}", e))?;

    // Calculate relative paths for DB migration
    let old_relative = note_path
        .strip_prefix(&*vault_str)
        .unwrap_or(&note_path)
        .trim_start_matches('/')
        .to_string();
    let relative_target = abs_target
        .strip_prefix(&*vault_str)
        .unwrap_or(&abs_target)
        .trim_start_matches('/')
        .to_string();

    // Migrate all associated DB data (notes, links, embeddings, tasks, etc.)
    // + mark folders dirty
    db_state.0.with_connection(|conn| {
        // Migrate all 11 associated tables to new path
        match repository::rename_note_in_db(conn, &old_relative, &relative_target) {
            Ok(updated) => {
                if updated > 0 {
                    log::debug!(
                        "✅ [Classification] DB migrated: {} → {}",
                        old_relative, relative_target
                    );
                } else {
                    log::debug!(
                        "⚠️ [Classification] Note not found in DB for migration: {}",
                        old_relative
                    );
                }
            }
            Err(e) => {
                // File already moved — don't fail, just warn
                log::debug!(
                    "⚠️ [Classification] DB migration failed (file already moved): {}",
                    e
                );
            }
        }

        // Mark source folder dirty
        let source_folder = Path::new(&old_relative)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if !source_folder.is_empty() {
            let _ = mark_folder_dirty(conn, &source_folder);
        }

        // Ensure target folder is registered and marked dirty
        let _ = upsert_folder_embedding(conn, &target_folder, None, None);
        let _ = mark_folder_dirty(conn, &target_folder);

        Ok(())
    })?;

    log::debug!("✅ [Classification] Moved to: {}", relative_target);
    Ok(relative_target)
}

/// Refresh folder embeddings - scan filesystem and update embeddings
#[tauri::command]
pub async fn refresh_folder_embeddings(
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
) -> Result<usize, String> {
    // Time guard: skip if refreshed within last 5 minutes
    {
        let last = LAST_FOLDER_REFRESH.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed().as_secs() < 300 {
                log::debug!(
                    "\u{23ed}\u{fe0f} [Classification] Folder refresh skipped \u{2014} last refresh {}s ago (cooldown 300s)",
                    t.elapsed().as_secs()
                );
                return Ok(0);
            }
        }
    }
    log::debug!("🗂️ [Classification] Refreshing folder embeddings...");

    // Get vault path
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let vault_str = vault_path.to_string_lossy().to_string();
    log::debug!("📂 [Classification] Vault path: {}", vault_str);

    // Scan filesystem for all valid folders
    let valid_folders = scan_valid_folders(&vault_str)?;
    log::debug!(
        "📂 [Classification] Found {} valid folders from filesystem scan",
        valid_folders.len()
    );

    if valid_folders.is_empty() {
        log::debug!("🗂️ [Classification] No valid folders found");
        return Ok(0);
    }

    // Get existing embeddings from database
    let existing = db_state
        .0
        .with_connection(|conn| get_all_folder_embeddings(conn))?;
    let existing_map: std::collections::HashMap<String, bool> = existing
        .iter()
        .map(|e| (e.folder_path.clone(), e.is_dirty))
        .collect();

    // Determine which folders need embedding calculation
    // New folders or folders marked as dirty
    let folders_to_update: Vec<&String> = valid_folders
        .iter()
        .filter(|f| {
            match existing_map.get(*f) {
                None => true,                // New folder
                Some(is_dirty) => *is_dirty, // Existing but dirty
            }
        })
        .collect();

    log::debug!(
        "🗂️ [Classification] {} folders need embedding update",
        folders_to_update.len()
    );

    let service = ai_state.service().clone();
    let mut updated_count = 0;

    for folder_path in folders_to_update {
        // Build folder profile
        let profile = {
            let conn_result = db_state.0.with_connection(|conn| {
                let (top_tags, recent_titles, note_count) =
                    crate::core::db::repository::get_folder_stats(conn, folder_path)?;
                Ok((top_tags, recent_titles, note_count))
            });

            let (top_tags, recent_titles, note_count): (Vec<String>, Vec<String>, i64) =
                conn_result?;

            log::debug!(
                "  📊 {} - {} notes, tags: {:?}",
                folder_path,
                note_count,
                &top_tags[..std::cmp::min(3, top_tags.len())]
            );

            let folder_name = folder_path.split('/').last().unwrap_or(folder_path);
            let tags_str = if top_tags.is_empty() {
                "N/A".to_string()
            } else {
                top_tags.into_iter().take(10).collect::<Vec<_>>().join(", ")
            };
            let titles_str = if recent_titles.is_empty() {
                "- (No notes yet)".to_string()
            } else {
                recent_titles
                    .iter()
                    .take(5)
                    .map(|t| format!("- {}", t))
                    .collect::<Vec<_>>()
                    .join("\n")
            };

            format!(
                "Folder Name: {}\n\nTop Related Topics: {}\n\nRecent Note Titles:\n{}",
                folder_name, tags_str, titles_str
            )
        };

        // Calculate embedding
        let profile_clone = profile.clone();
        let embedding: Vec<f32> = service
            .generate_embedding(&profile_clone)
            .await
            .map_err(|e| format!("Failed to calculate embedding: {}", e))?;

        log::debug!(
            "  🔢 Embedding dim: {}, first 3 values: {:?}",
            embedding.len(),
            &embedding[..std::cmp::min(3, embedding.len())]
        );

        // Store embedding
        db_state.0.with_connection(|conn| {
            upsert_folder_embedding(conn, folder_path, Some(&embedding), Some(&profile))
        })?;

        updated_count += 1;
        log::debug!("✅ [Classification] Updated embedding for: {}", folder_path);
    }

    // Update last refresh timestamp
    {
        let mut last = LAST_FOLDER_REFRESH.lock().unwrap();
        *last = Some(std::time::Instant::now());
    }

    log::debug!(
        "🗂️ [Classification] Refreshed {} folder embeddings",
        updated_count
    );
    Ok(updated_count)
}

/// Scan filesystem for valid folders
/// Rules:
/// - Only scan 01_Projects, 02_Areas, 03_Resources top-level directories
/// - Exclude folders named assets, images, attachments, .obsidian, .trash
/// - Include folders with notes or valid subfolders
fn scan_valid_folders(vault_path: &str) -> Result<Vec<String>, String> {
    let mut valid_folders = Vec::new();
    let vault = std::path::Path::new(vault_path);

    if !vault.is_dir() {
        return Err(format!("Vault path is not a directory: {}", vault_path));
    }

    // Only scan PARA directories (exclude 00_Inbox, 04_Archives)
    let para_prefixes = ["01_Projects", "02_Areas", "03_Resources"];

    for prefix in &para_prefixes {
        let dir_path = vault.join(prefix);
        if dir_path.is_dir() {
            log::debug!("  🔍 Scanning: {}", prefix);
            scan_folder_recursive(&dir_path, vault_path, &mut valid_folders)?;
        }
    }

    Ok(valid_folders)
}

fn scan_folder_recursive(
    path: &std::path::Path,
    vault_path: &str,
    folders: &mut Vec<String>,
) -> Result<(), String> {
    // Skip excluded folder names
    let folder_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let excluded_names = ["assets", "images", "attachments", ".obsidian", ".trash"];
    if excluded_names
        .iter()
        .any(|e| e.eq_ignore_ascii_case(folder_name))
    {
        log::debug!("    ⏭️ Skipping excluded: {}", folder_name);
        return Ok(());
    }

    // Get relative path
    let relative_path = path
        .strip_prefix(vault_path)
        .map_err(|_| "Failed to get relative path")?
        .to_string_lossy()
        .to_string();

    // Rule 2: Root directory blocking - never include PARA root directories as candidates
    let para_roots = ["01_Projects", "02_Areas", "03_Resources"];
    let is_para_root = para_roots.iter().any(|r| relative_path == *r);

    // Scan for subfolders (for recursive scanning)
    let mut subfolders = Vec::new();
    let mut has_notes = false;

    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let entry_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !excluded_names
                    .iter()
                    .any(|e| e.eq_ignore_ascii_case(entry_name))
                {
                    subfolders.push(entry_path);
                }
            } else if entry_path.extension().map_or(false, |ext| ext == "md") {
                has_notes = true;
            }
        }
    }

    // Add folder to candidates if NOT a PARA root (include ALL subfolders, even empty ones)
    if !is_para_root {
        // Calculate depth for logging
        let depth = relative_path.matches('/').count();
        folders.push(relative_path.clone());
        log::debug!(
            "    ✅ {} (depth: {}): {} notes, {} subfolders",
            relative_path,
            depth,
            if has_notes { "has" } else { "no" },
            subfolders.len()
        );
    } else {
        log::debug!("    🚫 Skipping PARA root: {}", relative_path);
    }

    // Recursively scan subfolders
    for subfolder in subfolders {
        scan_folder_recursive(&subfolder, vault_path, folders)?;
    }

    Ok(())
}

/// Initialize folder embeddings for all folders (cold start)
#[tauri::command]
pub async fn init_folder_embeddings(
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
) -> Result<usize, String> {
    log::debug!("🗂️ [Classification] Initializing folder embeddings (cold start)...");

    // Just call refresh - it will scan filesystem and update all
    refresh_folder_embeddings(db_state, ai_state).await
}

/// Get all available folders for manual selection (includes 00_Inbox and 04_Archives)
#[tauri::command]
pub async fn get_all_available_folders(
    db_state: State<'_, DbStateWrapper>,
) -> Result<Vec<String>, String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let vault_str = vault_path.to_string_lossy().to_string();
    let vault = std::path::Path::new(&vault_str);
    let mut folders = Vec::new();

    // Scan PARA directories excluding Inbox (user manually manages Inbox)
    let para_prefixes = ["01_Projects", "02_Areas", "03_Resources", "04_Archives"];

    for prefix in &para_prefixes {
        let dir_path = vault.join(prefix);
        if dir_path.is_dir() {
            // Add the root directory itself
            folders.push(prefix.to_string());
            // Recursively scan subdirectories
            scan_all_folders_recursive(&dir_path, &vault_path.to_string_lossy(), &mut folders)?;
        }
    }

    // Sort alphabetically
    folders.sort();

    log::debug!(
        "📂 [Classification] Found {} available folders",
        folders.len()
    );
    Ok(folders)
}

fn scan_all_folders_recursive(
    path: &std::path::Path,
    vault_path: &str,
    folders: &mut Vec<String>,
) -> Result<(), String> {
    let folder_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    // Skip hidden folders and system folders
    let excluded_names = [
        "assets",
        "images",
        "attachments",
        ".obsidian",
        ".trash",
        ".git",
    ];
    if excluded_names
        .iter()
        .any(|e| e.eq_ignore_ascii_case(folder_name))
    {
        return Ok(());
    }

    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let entry_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");

                if !excluded_names
                    .iter()
                    .any(|e| e.eq_ignore_ascii_case(entry_name))
                {
                    // Get relative path
                    let relative_path = entry_path
                        .strip_prefix(vault_path)
                        .map_err(|_| "Failed to get relative path")?
                        .to_string_lossy()
                        .to_string();

                    folders.push(relative_path);

                    // Recursively scan
                    scan_all_folders_recursive(&entry_path, vault_path, folders)?;
                }
            }
        }
    }

    Ok(())
}

// ============================================================================
// Read-only: Load cached classification result without triggering LLM
// ============================================================================

/// Load cached classification result from DB (read-only, no LLM).
/// Used on app restart / note open to restore previously generated results.
#[tauri::command]
pub fn get_cached_classification(
    note_path: String,
    db_state: State<DbStateWrapper>,
) -> Result<Option<ClassificationResult>, String> {
    use rusqlite::params;
    use rusqlite::OptionalExtension;

    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let relative_path = std::path::Path::new(&note_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    // Step 1: Read from DB (rusqlite errors only)
    let db_result: Option<String> = db_state.0.with_connection(|conn| {
        conn.query_row(
            "SELECT suggestions FROM classification_cache WHERE note_path = ?1",
            params![&relative_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
    })?;

    // Step 2: Parse JSON and resolve decisions (String errors)
    match db_result {
        Some(cached_json) => {
            // The cache stores the entire ClassificationResult as JSON
            let mut result: ClassificationResult =
                serde_json::from_str(&cached_json).map_err(|e| e.to_string())?;

            result.query_profile = "[Cached]".to_string();
            resolve_decisions(&mut result.suggestions, vault_path.as_path(), &[]);

            Ok(Some(result))
        }
        None => Ok(None),
    }
}

/// Save classification suggestions (read-write, update cache directly).
/// Used by front-end after user ignores specific folder recommendation.
#[tauri::command]
pub fn save_classification_suggestions(
    note_path: String,
    result: ClassificationResult,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    use rusqlite::params;
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    let relative_path = std::path::Path::new(&note_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());

    let suggestions_json = serde_json::to_string(&result).map_err(|e| e.to_string())?;

    db_state.0.with_connection(|conn| {
        conn.execute(
            "UPDATE classification_cache SET suggestions = ?1, has_pending_tasks = ?2 WHERE note_path = ?3",
            params![&suggestions_json, result.has_pending_tasks, &relative_path],
        )
    }).map_err(|e| e.to_string())?;

    Ok(())
}
