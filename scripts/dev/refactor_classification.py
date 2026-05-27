import re

with open("apps/desktop/src-tauri/src/commands/ai/classification.rs", "r") as f:
    content = f.read()

# I will replace the get_classification_suggestions function completely.
# Let's find its start and end.
start_idx = content.find("pub async fn get_classification_suggestions")
end_idx = content.find("pub async fn accept_classification")

old_func = content[start_idx:end_idx]

new_func = """pub async fn get_classification_suggestions(
    note_path: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<ClassificationResult, String> {
    eprintln!("🗂️ [Classification] Submitting to queue: {}", note_path);

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

    eprintln!("🗂️ [Classification] Worker processing: {}", relative_path);

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
                "SELECT title, COALESCE(ai_summary, ''), COALESCE(user_tags, ''), COALESCE(ai_tags, '') FROM notes WHERE path = ?1",
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
            eprintln!("✅ [Classification] Cache hit! Returning cached result.");
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
            eprintln!(
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
    eprintln!(
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
    eprintln!(
        "🗂️ [Classification] Query profile ({} chars):\n{}",
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
                eprintln!(
                    "🗑️ [Classification] Filtering out non-existent folder: {}",
                    fe.folder_path
                );
            }
            exists
        })
        .collect();

    eprintln!(
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
    eprintln!("🗂️ [Classification] Top folders: {:?}", top_folders);

    // Step 7: Call LLM for judgment (Rule 6)
    // Rule 6.2: candidates = 0 - call LLM to generate new folder
    // Rule 6.1/6.3: candidates > 0 - call LLM to judge
    let prompt = build_classification_prompt(&input, &top_folders);
    eprintln!(
        "🗂️ [Classification] LLM prompt ({} chars):\n{}",
        prompt.chars().count(),
        prompt
    );

    // Use RawPromptSkill - no system prompt, direct passthrough
    // This ensures our classification prompt is sent exactly as-is
    let llm_response = service
        .execute_skill(&crate::core::ai::skills::RawPromptSkill, &prompt)
        .await
        .map_err(|e| format!("LLM call failed: {}", e))?;

    eprintln!("🗂️ [Classification] LLM response: {}", llm_response);

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
            eprintln!("⚠️ [Classification] Failed to parse LLM response: {}", e);

            // Stage 2: LLM repair attempt before falling back to vector match
            let mut repaired_suggestions = None;
            if let Ok(repaired_json) = service.repair_with_llm(&llm_response).await {
                if let Ok(mut parsed) = parse_llm_response(&repaired_json) {
                    eprintln!(
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
            eprintln!("⚠️ [Classification] Failed to save cache: {}", e);
        }
        if has_create_proposals {
            eprintln!(
                "💾 [Classification] Result cached (includes Create proposals for user review)."
            );
        } else {
            eprintln!("💾 [Classification] Result cached (all Select).");
        }
    } else {
        eprintln!("⏭️ [Classification] Skipping cache — parse failed, using fallback result");
    }

    // In-flight lock is released automatically by _inflight_guard Drop

    Ok(result)
}

/// Accept"""

content = content[:start_idx] + new_func + content[end_idx + 35:]

with open("apps/desktop/src-tauri/src/commands/ai/classification.rs", "w") as f:
    f.write(content)

