//! AI Orchestrator Commands
//!
//! Commands for the new 3-layer AI orchestration architecture.
//! Replaces the old trigger_ai_skill with scheduler-based decision making.

use std::sync::{OnceLock, RwLock};
use std::collections::HashSet;

use tauri::{Emitter, State};

use std::path::Path;
use crate::core::ai::orchestrator::EditorState;
use slash_core::{extract_meaningful_content, sanitize_filename};
use crate::core::ai::skills::TaggingSkill;
use crate::core::ai::skills::note_profile::build_note_profile;
use crate::core::ai::skills::input_strategy::{self, InputMode};
use crate::core::ai::skills::key_chunks::EditHint;
use crate::core::db::repository;
use crate::core::embedding::{EmbeddingPipeline, EmbeddingScheduler};
use crate::{AIStateWrapper, DbStateWrapper};

// 全局在途 AI 请求取消集合（切换笔记时由前端通知 abort），防范请求逃逸与算力浪费
static ABORTED_NOTE_PATHS: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();

fn get_aborted_set() -> &'static RwLock<HashSet<String>> {
    ABORTED_NOTE_PATHS.get_or_init(|| RwLock::new(HashSet::new()))
}

#[tauri::command]
pub fn abort_note_ai_jobs(note_path: String) -> Result<(), String> {
    if let Ok(mut set) = get_aborted_set().write() {
        set.insert(note_path.clone());
        log::debug!("🚫 [Orchestrator] AI jobs aborted and registered for note: {}", note_path);
    }
    Ok(())
}

#[tauri::command]
pub fn register_active_note_ai(note_path: String) -> Result<(), String> {
    if let Ok(mut set) = get_aborted_set().write() {
        set.remove(&note_path);
        log::debug!("🎯 [Orchestrator] Active note registered, cleared abort marker for: {}", note_path);
    }
    Ok(())
}

/// 持久化去重：查询 ai_skill_state 表判断同 hash 是否已成功执行
/// 替代旧的 in-memory HashMap，重启不丢失
#[allow(dead_code)]
fn should_skip_persistent(
    conn: &rusqlite::Connection,
    note_path: &str,
    content_hash: &str,
    skill_id: &str,
) -> bool {
    let result: Result<(String, String), _> = conn.query_row(
        "SELECT last_content_hash, last_result FROM ai_skill_state WHERE note_path = ?1 AND skill_id = ?2",
        rusqlite::params![note_path, skill_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((hash, last_result)) => hash == content_hash && last_result == "success",
        Err(_) => false, // No record → don't skip
    }
}



// ============================================================================
// AI Skill Logging Helpers
// ============================================================================

/// Format the header for AI skill execution log
fn log_skill_header(note_path: &str, trigger_type: &str, hash_changed: bool, delta: f64) {
    let now = chrono::Local::now().format("%H:%M:%S").to_string();
    log::debug!("┌─────────────────────────────────────────────────────────────┐");
    log::debug!("│ 🤖 AI SKILL EXECUTION                                       │");
    log::debug!("├─────────────────────────────────────────────────────────────┤");
    log::debug!("│ Note: {:<54}│", truncate_path(note_path, 54));
    log::debug!("│ Time: {:<54}│", now);
    log::debug!("│ Trigger: {:<51}│", trigger_type);
    log::debug!("│ Condition: hash_changed={}, delta={:.1}%{:<26}│", 
        hash_changed, delta * 100.0, "");
    log::debug!("├─────────────────────────────────────────────────────────────┤");
}

/// Format skill result for logging
#[allow(dead_code)]
fn log_skill_result(skill_id: &str, status: &str, detail: &str) {
    let icon = match status {
        "success" => "✅",
        "skipped" => "⏭️",
        "failed" => "❌",
        _ => "•",
    };
    let detail_str = if detail.is_empty() { 
        String::new() 
    } else { 
        format!(" ({})", detail) 
    };
    log::debug!("│   {} {:<12} → {:<7}{:<32}│", icon, skill_id, status, detail_str);
}

/// Log the footer for AI skill execution
fn log_skill_footer() {
    log::debug!("└─────────────────────────────────────────────────────────────┘");
}

/// Log when skills are skipped entirely
fn log_skip_reason(reason: &str) {
    log::debug!("│   ⏭️ Skipped: {:<46}│", reason);
    log_skill_footer();
}

/// Truncate path for display
fn truncate_path(path: &str, max_len: usize) -> String {
    if path.len() <= max_len {
        path.to_string()
    } else {
        format!("...{}", &path[path.len() - max_len + 3..])
    }
}


// ============================================================================
// Helper Functions
// ============================================================================

/// Update the YAML frontmatter title (delegates to unified frontmatter module)
#[allow(dead_code)]
fn update_yaml_title(content: &str, new_title: &str) -> String {
    crate::core::db::repository::frontmatter::update_frontmatter_field(content, "title", new_title)
}

/// Update YAML frontmatter summary field (delegates to unified frontmatter module)
#[allow(dead_code)]
fn update_yaml_summary(content: &str, new_summary: &str) -> String {
    crate::core::db::repository::frontmatter::update_frontmatter_field(content, "summary", new_summary)
}

/// Remove the summary field from YAML frontmatter
/// Used when content becomes too short and AI data needs to be cleared
#[allow(dead_code)]
fn remove_yaml_summary(content: &str) -> String {
    // Check if file has frontmatter
    if content.starts_with("---") {
        if let Some(end_pos) = content[3..].find("\n---") {
            let frontmatter = &content[3..3 + end_pos];
            let body = &content[3 + end_pos + 4..];

            let mut new_lines: Vec<String> = Vec::new();
            let mut skip_until_next_key = false;

            for line in frontmatter.lines() {
                let trimmed = line.trim_start();
                if skip_until_next_key {
                    if !trimmed.is_empty() && !trimmed.starts_with(' ') && trimmed.contains(':') {
                        skip_until_next_key = false;
                        new_lines.push(line.to_string());
                    }
                } else if trimmed.starts_with("summary:") {
                    let value_part = trimmed.strip_prefix("summary:").unwrap_or("").trim();
                    if value_part == "|" || value_part == ">" {
                        skip_until_next_key = true;
                    }
                } else {
                    new_lines.push(line.to_string());
                }
            }

            return format!("---\n{}\n---{}", new_lines.join("\n"), body);
        }
    }
    content.to_string()
}


// ============================================================================
// Orchestrated AI Trigger Command
// ============================================================================

/// Trigger AI skill processing for embedding pipeline.
///
/// Flow: Check (hash) -> Run (embedding) -> Save (state) -> Emit (event)
/// LLM skills are triggered independently via per-skill commands.
#[tauri::command]
pub async fn trigger_ai_orchestrated(
    trigger_type: String,
    note_path: String,
    content: String,
    db_state: tauri::State<'_, DbStateWrapper>,
    ai_state: tauri::State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let content_chars = content.chars().count();
    if content_chars == 0 {
        return Ok("skipped:empty".to_string());
    }

    let vault_path = db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
    let relative_path = std::path::Path::new(&note_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());
    let content_hash = slash_core::calculate_content_hash(&content);

    // Queue for execution
    if let Some(queue) = ai_state.queue.get() {
        let job = crate::core::ai::queue::FastJob {
            note_path: relative_path,
            content,
            hash: content_hash,
            trigger_type,
        };
        let _ = queue.submit_fast(job).await;
        Ok("AI orchestrated processing queued".to_string())
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_fast_job(
    app_handle: tauri::AppHandle,
    trigger_type: String,
    relative_path_clone: String,
    content_clone: String,
    content_hash_clone: String,
) {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    let editor_state = match trigger_type.as_str() {
        "on_open" => EditorState::Open,
        "on_button" | "on_blur" | "on_save" => EditorState::Blur,
        "on_idle" | "on_idle_embedding" => EditorState::Idle,
        "on_change" | "on_active" => EditorState::Active,
        _ => { log::warn!("Unknown trigger type: {}", trigger_type); return; }
    };

    let vault_path_clone = match db_state.0.vault_path.lock().unwrap().clone() {
        Some(p) => p,
        None => return,
    };
    let db_path = std::path::Path::new(&vault_path_clone).join(".slash").join("slash.db");

    let mut service = ai_state.service().clone();
    let _runtime = ai_state.runtime.clone();
    let app_handle_clone = app_handle.clone();

// Open DB connection
let conn = match rusqlite::Connection::open(&db_path) {
    Ok(c) => c,
    Err(e) => {
        log::error!("❌ [Orchestrator] Failed to open DB: {}", e);
        return;
    }
};

// 🧹 软删除清理：在后台异步线程中默默清理超过 10 分钟 (600,000ms) 的软删除 AI 脏数据，零阻塞，KISS 极简
{
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let ten_minutes_ago = now_ms.saturating_sub(600_000);
    if let Ok(mut stmt) = conn.prepare(
        "SELECT note_path FROM ai_skill_state WHERE skill_id = '_tracking' AND last_result = 'soft_deleted' AND timestamp < ?1"
    ) {
        if let Ok(mut rows) = stmt.query(rusqlite::params![ten_minutes_ago]) {
            while let Ok(Some(row)) = rows.next() {
                if let Ok(path) = row.get::<_, String>(0) {
                    log::debug!("🧹 [Orchestrator] 10 min soft-delete grace period expired. Purging AI data for: {}", path);
                    let _ = conn.execute(
                        "DELETE FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
                        rusqlite::params![path],
                    );
                    let _ = conn.execute(
                        "DELETE FROM embeddings_v2 WHERE note_path = ?1",
                        rusqlite::params![path],
                    );
                    let _ = conn.execute(
                        "DELETE FROM ai_suggestion_cache WHERE source_path = ?1 OR target_path = ?1",
                        rusqlite::params![path],
                    );
                    let _ = conn.execute(
                        "DELETE FROM ai_skill_state WHERE note_path = ?1",
                        rusqlite::params![path],
                    );
                }
            }
        }
    }
}


// Folder-level AI config override (MUST happen BEFORE check_connection)
// 查找 .slash-folder.yml 实现目录级 provider/model 覆盖
// 先 resolve 最终 provider，再做连接检测，避免 generation_model 被错误 provider 的模型名污染
{
    use crate::core::ai::folder_config;
    let effective_config = folder_config::resolve_config_for_path(
        Path::new(&vault_path_clone),
        &relative_path_clone,
        service.config(),
    );
    // 仅当有实际差异时才 rebuild
    if effective_config.provider_type != service.config().provider_type
        || effective_config.online_model != service.config().online_model
        || effective_config.generation_model != service.config().generation_model
    {
        log::debug!(
            "📂 [Orchestrator] Applying folder override for {}: provider={}, model={}",
            relative_path_clone,
            effective_config.provider_type,
            if effective_config.provider_type == "online" {
                &effective_config.online_model
            } else {
                &effective_config.generation_model
            }
        );
        service.rebuild(effective_config);
    }
}

// Auto-detect models (after folder override, so we check the correct provider)
if let Ok(status) = service.check_connection().await {
    service.update_config(&status);
}

// UX v2: No LLM skills. Only delta tracking + embedding.

let current_char_count = content_clone.chars().count();

// Get last state for delta calculation
let (last_hash, _last_char_count) =
    repository::get_skill_state_for_delta(&conn, &relative_path_clone)
        .ok()
        .flatten()
        .unwrap_or_else(|| (String::new(), 0));

// Hash changed?
let hash_changed = last_hash != content_hash_clone;

// Output unified header log
let trigger_display = format!("{:?}", editor_state);
log_skill_header(&relative_path_clone, &trigger_display, hash_changed, 0.0);

// Mutable path for current note
let current_path = relative_path_clone.clone();

// Skip ALL processing for very short content
let meaningful_content = extract_meaningful_content(&content_clone);
let meaningful_char_count = meaningful_content.chars().count();
const MIN_CONTENT_FOR_AI: usize = 50;

if meaningful_char_count < MIN_CONTENT_FOR_AI {
    // OPT-06: 检测是否包含媒体引用——图片/音视频笔记文本很短，但有语义价值
    let has_media = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)")
        .map(|r| r.is_match(&content_clone))
        .unwrap_or(false);
    
    if has_media {
        log::debug!("📎 [Orchestrator] Short content but has media references, preserving embeddings for: {}", relative_path_clone);
        // 不删除 embeddings_v2，让 EmbeddingWorker 的 media enrichment 处理
    } else {
        log_skip_reason(&format!("content too short ({}chars)", meaningful_char_count));
        
        // 🚀 10分钟软删除防算力颠簸：不直接物理硬删除 AI 元数据与向量，而是写入 soft_deleted 状态并记录时间戳。
        // 给临时剪切、清空重写等高频用户动作提供 10 分钟宽限缓存，防范 Token 与算力重算！
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let _ = repository::upsert_skill_state(
            &conn,
            &relative_path_clone,
            "_tracking",
            &content_hash_clone,
            current_char_count,
            now_ms,
            "soft_deleted",
        );
        log::debug!("⏳ [Orchestrator] Transient short content ({} chars) < 50, soft-deleted tracking state for: {}", meaningful_char_count, relative_path_clone);
        
        let _ = app_handle_clone.emit(
            "ai:cleared",
            serde_json::json!({
                "path": relative_path_clone,
                "reason": "content_too_short",
            }),
        );
        return; // Skip embedding for short content
    }
}

// ----------------------------------------------------------------
// Embedding Pipeline Integration
// Only runs when hash changed — no LLM skills here
// ----------------------------------------------------------------
if hash_changed {
    log::debug!("📦 [Embedding] hash_changed={}, entering scheduling block, state={:?}",
        hash_changed, editor_state
    );

    // Guard: clean up stale embeddings if content is too short for chunking
    let content_len = content_clone.trim().len();
    
    // Check for media BEFORE purging short notes
    let has_media_check = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)")
        .map(|r| r.is_match(&content_clone))
        .unwrap_or(false);

    if content_len < 100 && !has_media_check {
        let cleaned = conn.execute(
            "DELETE FROM embeddings_v2 WHERE note_path = ?1 AND status != 'skipped'",
            rusqlite::params![&current_path],
        ).unwrap_or(0);
        if cleaned > 0 {
            log::debug!("🧹 [Embedding] Purged {} stale embeddings for short note ({} chars): {}",
                cleaned, content_len, current_path
            );
            let _ = conn.execute(
                "DELETE FROM ai_skill_state WHERE note_path = ?1",
                rusqlite::params![&current_path],
            );
            let _ = conn.execute(
                "DELETE FROM ai_suggestion_cache WHERE source_path = ?1",
                rusqlite::params![&current_path],
            );
        }
    }
    
    // Explicitly delete media_pending marker if the note no longer has media
    if !has_media_check {
        let _ = conn.execute(
            "DELETE FROM embeddings_v2 WHERE note_path = ?1 AND chunk_id = '_media_pending'",
            rusqlite::params![&current_path],
        );
    } else {
        // Defer to background worker for proper media scheduling (detects cache, inserts _media_pending)
        let vault_path_for_task = vault_path_clone.clone();
        let note_path_for_task = current_path.clone();
        let service_for_task = service.clone();
        let app_handle_for_task = app_handle_clone.clone();
        tokio::task::spawn_blocking(move || {
            let db_path = std::path::Path::new(&vault_path_for_task).join(".slash").join("slash.db");
            if let Ok(conn_bg) = rusqlite::Connection::open(&db_path) {
                let rt = std::sync::Arc::new(tokio::runtime::Runtime::new().unwrap_or_else(|_| tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()));
                let mut pipeline_bg = EmbeddingPipeline::new(std::sync::Arc::new(service_for_task));
                pipeline_bg.set_vault_path(vault_path_for_task.clone());
                let _ = crate::core::embedding::worker::schedule_note_for_embedding_public(
                    &conn_bg, &vault_path_for_task, &note_path_for_task, &rt, &pipeline_bg,
                );
                let _ = app_handle_for_task.emit("slash:media-pending-changed", ());
            }
        });
    }

    let embedding_scheduler = EmbeddingScheduler::new();
    match editor_state {
        EditorState::Blur | EditorState::Open => {
            match embedding_scheduler.schedule_blur(
                &current_path,
                &content_clone,
                &conn,
            ) {
                Ok(result) => {
                    log::debug!("📦 [Embedding] Blur scheduled: {} pending, {} skipped",
                        result.processed, result.skipped
                    );
                }
                Err(e) => {
                    log::error!("❌ [Embedding] schedule_blur failed: {}", e);
                }
            }
        }
        EditorState::Idle => {
            let _ = embedding_scheduler.schedule_blur(
                &current_path,
                &content_clone,
                &conn,
            );
            match embedding_scheduler.schedule_idle(&conn) {
                Ok(result) => {
                    log::debug!("📦 [Embedding] Idle scheduled: {} jobs, degraded={}",
                        result.processed, result.degraded
                    );
                }
                Err(e) => {
                    log::error!("❌ [Embedding] schedule_idle failed: {}", e);
                }
            }
        }
        EditorState::Active => {
            // Active: no embedding scheduling
        }
    }

    // Immediately process pending embedding jobs
    let ai_service_for_embed = std::sync::Arc::new(service.clone());
    let mut pipeline = EmbeddingPipeline::new(ai_service_for_embed);
    pipeline.set_vault_path(std::path::PathBuf::from(&vault_path_clone));
    let vault_pb = vault_path_clone.clone();
    let batch_size = 10;

    // P0: Paragraphs
    if let Ok((p, f, s)) = pipeline
        .process_pending_paragraphs_with_vault(&conn, &vault_pb, batch_size)
        .await
    {
        if p > 0 {
            log::debug!("✅ [Embedding/inline] Paragraphs: {} processed, {} failed, {} skipped", p, f, s);
        }
    }

    // P1: NoteProfiles
    if let Ok((p, f, _s)) = pipeline
        .process_pending_note_profiles_with_vault(&conn, &vault_pb, batch_size)
        .await
    {
        if p > 0 {
            log::debug!("✅ [Embedding/inline] NoteProfiles: {} processed, {} failed", p, f);
        }
    }

    // P2: Summaries
    if let Ok((p, f, _s)) = pipeline
        .process_pending_summaries(&conn, batch_size)
        .await
    {
        if p > 0 {
            log::debug!("✅ [Embedding/inline] Summaries: {} processed, {} failed", p, f);
        }
    }
}

// Always save hash and char_count for delta tracking (idempotent upsert)
{
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let _ = repository::upsert_skill_state(
        &conn,
        &current_path,
        "_tracking",
        &content_hash_clone,
        current_char_count,
        now,
        "tracked",
    );
    log::debug!("📝 [Orchestrator] Hash/char_count tracked for delta calculation");
}

// Emit completion event for frontend UI state
let _ = app_handle_clone.emit(
    "ai:note-updated",
    serde_json::json!({
        "path": current_path,
        "status": "done",
        "skills": [],
        "state": format!("{:?}", editor_state),
        "hash_changed": hash_changed,
    }),
);

}

// ============================================================================
// UX v2: Independent Skill Commands (Magic Wand Per-Skill Triggers)
// ============================================================================

/// Shared helper: ensure a fresh summary exists for the note.
/// Returns the summary text (from DB if fresh, or by running summarization LLM).
#[allow(dead_code)]
pub(crate) async fn ensure_fresh_summary(
    conn: &rusqlite::Connection,
    service: &crate::core::ai::service::AIService,
    note_path: &str,
    content: &str,
    content_hash: &str,
) -> Result<String, String> {
    // Check if existing summary hash matches current content
    let last_hash: Option<String> = conn.query_row(
        "SELECT last_content_hash FROM ai_skill_state WHERE note_path = ?1 AND skill_id = 'summarization' AND last_result = 'success'",
        rusqlite::params![note_path],
        |row| row.get(0),
    ).ok();

    // Fast path: skill_state hash matches AND ai_summary exists → reuse
    if let Some(ref hash) = last_hash {
        if hash == content_hash {
            if let Ok(summary) = conn.query_row(
                "SELECT COALESCE(summary, '') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
                rusqlite::params![note_path],
                |row| row.get::<_, String>(0),
            ) {
                if !summary.is_empty() {
                    log::debug!("📋 [ensure_fresh_summary] Reusing fresh summary for {}", note_path);
                    return Ok(summary);
                }
            }
        }
    }

    // Fallback: skill_state missing/stale but ai_summary already exists → reuse & backfill state
    if last_hash.is_none() || last_hash.as_deref() != Some(content_hash) {
        if let Ok(summary) = conn.query_row(
            "SELECT COALESCE(summary, '') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![note_path],
            |row| row.get::<_, String>(0),
        ) {
            if !summary.is_empty() {
                log::debug!("📋 [ensure_fresh_summary] Reusing existing summary (backfilling skill_state) for {}", note_path);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let _ = repository::upsert_skill_state(
                    conn, note_path, "summarization", content_hash,
                    content.chars().count(), now, "success",
                );
                return Ok(summary);
            }
        }
    }

    // Summary is stale or missing — run summarization
    log::debug!("📋 [ensure_fresh_summary] Summary stale/missing, running summarization for {}", note_path);
    let filename = std::path::Path::new(note_path)
        .file_stem().and_then(|n| n.to_str()).unwrap_or("note");
    let note_profile = build_note_profile(content, filename);
    let edit_hint = EditHint::default();

    let mut summary_input = input_strategy::build_skill_input(
        content, &note_profile,
        &InputMode::ProfileWithChunks { top_k: 5 },
        &edit_hint, None,
    );

    let max_chars = input_strategy::estimate_max_input_chars(service.completion_model(), 256);
    if summary_input.chars().count() > max_chars {
        summary_input = summary_input.chars().take(max_chars).collect();
    }

    let summary = service.generate_summary(&summary_input).await
        .map_err(|e| format!("Summarization failed: {}", e))?;

    // Save to DB (Avoid UPSERT to prevent FTS5 double-trigger corruption)
    let affected = conn.execute(
        "UPDATE ai_metadata SET summary = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
        rusqlite::params![&summary, note_path],
    );
    let res = match affected {
        Ok(0) => conn.execute(
            "INSERT INTO ai_metadata (note_id, summary) SELECT id, ?1 FROM notes WHERE path = ?2",
            rusqlite::params![&summary, note_path],
        ),
        other => other,
    };
    match res {
        Ok(0) => log::warn!("⚠️ [DB WARN] Summarization insert affected 0 rows (Note not found?) for {}", note_path),
        Ok(_) => {},
        Err(e) => log::error!("🔴 [DB ERROR] Summarization insert failed for {}: {}", note_path, e),
    }

    // Schedule summary embedding (P2)
    use sha2::{Sha256, Digest};
    let hash = format!("{:x}", Sha256::digest(summary.as_bytes()));
    let _ = conn.execute(
        r#"
        INSERT INTO embeddings_v2 (
            note_path, product_type, chunk_id, content_hash,
            status, retry_count, created_at, updated_at
        )
        VALUES (?1, 'summary', '_summary', ?2, 'pending', 0, strftime('%s', 'now'), strftime('%s', 'now'))
        ON CONFLICT(note_path, product_type, chunk_id) DO UPDATE SET
            content_hash = excluded.content_hash,
            status = CASE WHEN content_hash != excluded.content_hash THEN 'pending' ELSE status END,
            retry_count = CASE WHEN content_hash != excluded.content_hash THEN 0 ELSE retry_count END,
            updated_at = strftime('%s', 'now')
        "#,
        rusqlite::params![note_path, hash],
    );

    // Record skill state
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = repository::upsert_skill_state(
        conn, note_path, "summarization", content_hash,
        content.chars().count(), now, "success",
    );

    Ok(summary)
}




// ============================================================================
// ATOMIC COMMANDS (AI Upgrade Patch)
// ============================================================================

#[derive(serde::Serialize)]
pub struct SkillResult {
    pub status: String, // "success", "skipped", "failed"
    pub data: Option<String>,
    pub timestamp: u64,
}

#[derive(serde::Serialize)]
pub struct RenameResult {
    pub status: String,
    pub old_path: String,
    pub new_path: String,
    pub new_title: String,
}

/// Atomic Summary Command
#[tauri::command]
pub async fn run_summary(
    note_path: String,
    content: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<SkillResult, String> {
    if let Some(queue) = ai_state.queue.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let hash = slash_core::calculate_content_hash(&content);
        let _ = queue.submit_heavy(crate::core::ai::queue::HeavyJob::Summarize {
            note_path: note_path.clone(),
            content: content.clone(),
            hash,
            responder: tx,
        }).await;
        rx.await.unwrap_or_else(|_| Err("Queue communication failed".to_string()))
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_heavy_summary(
    app_handle: tauri::AppHandle,
    note_path: String,
    content: String,
    content_hash: String,
) -> Result<SkillResult, String> {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    log::debug!("✨ [Atomic] process_heavy_summary for {}", note_path);
    let vault_path = db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path).strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string()).unwrap_or(note_path.clone());
    if content.chars().count() < 50 { return Ok(SkillResult { status: "skipped".into(), data: None, timestamp: 0 }); }

    // 检查是否已被用户切换笔记而 abort 熔断
    {
        if let Ok(set) = get_aborted_set().read() {
            if set.contains(&relative_path) {
                log::warn!("🚫 [Orchestrator] Summary request aborted on note switch for: {}", relative_path);
                return Ok(SkillResult { status: "aborted".into(), data: None, timestamp: 0 });
            }
        }
    }

    // Apply folder-level provider/model override (e.g., .slash-folder.yml)
    let service = ai_state.resolve_for_path(Path::new(&vault_path), &relative_path);
    
    // Check DB for cache
    let (cached_summary, summary_hash): (String, Option<String>) = db_state.0.with_connection(|conn| {
        let s: String = conn.query_row(
            "SELECT COALESCE(summary, '') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).unwrap_or_default();
        let h: Option<String> = conn.query_row(
            "SELECT last_content_hash FROM ai_skill_state WHERE note_path = ?1 AND skill_id = 'summarization' AND last_result = 'success'",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).ok();
        Ok((s, h))
    })?;

    if summary_hash.as_deref() == Some(&content_hash) && !cached_summary.is_empty() {
        log::debug!("⏭️ [Atomic] cached summary for {}", relative_path);
        return Ok(SkillResult { status: "skipped".into(), data: Some(cached_summary), timestamp: 0 });
    }

    // Run LLM
    // Use ensure_fresh_summary logic adapted
    let note_filename = Path::new(&relative_path).file_stem().and_then(|n| n.to_str()).unwrap_or("note");
    let note_profile = build_note_profile(&content, note_filename);
    let edit_hint = EditHint::default();
    
    let mut summary_input = input_strategy::build_skill_input(
        &content, &note_profile, &InputMode::ProfileWithChunks { top_k: 5 }, &edit_hint, None
    );
    let max_chars = input_strategy::estimate_max_input_chars(service.completion_model(), 256);
    if summary_input.chars().count() > max_chars {
        summary_input = summary_input.chars().take(max_chars).collect();
    }

    match service.generate_summary(&summary_input).await {
        Ok(s) => {
            let s_clone = s.clone();
            let rp = relative_path.clone();
            let ch = content_hash.clone();
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            
            db_state.0.with_connection(move |conn| {
                let affected = conn.execute(
                    "UPDATE ai_metadata SET summary = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
                    rusqlite::params![&s_clone, &rp]
                )?;
                let res = if affected == 0 {
                    conn.execute(
                        "INSERT INTO ai_metadata (note_id, summary) SELECT id, ?1 FROM notes WHERE path = ?2", 
                        rusqlite::params![&s_clone, &rp]
                    )?
                } else { affected };
                if res == 0 { log::warn!("⚠️ [DB WARN] Atomic summarization affected 0 rows for {}", rp); }
                repository::upsert_skill_state(conn, &rp, "summarization", &ch, content.chars().count(), now, "success")?;
                Ok(())
            })?;

            // 🚀 静默落盘 Frontmatter：利用底层的 update_frontmatter_field 直接在 Rust 异步后台线程更新本地物理 Markdown 文件的 Frontmatter summary 字段，完全解放前端 Tiptap 主线程的反序列化写盘负荷！
            let full_file_path = std::path::Path::new(&vault_path).join(&relative_path);
            if full_file_path.exists() {
                if let Ok(file_content) = std::fs::read_to_string(&full_file_path) {
                    let updated_content = crate::core::db::repository::frontmatter::update_frontmatter_field(
                        &file_content,
                        "summary",
                        &s,
                    );
                    if updated_content != file_content {
                        if let Err(write_err) = std::fs::write(&full_file_path, updated_content) {
                            log::error!("❌ [Orchestrator] Silent Frontmatter summary write failed: {}", write_err);
                        } else {
                            log::debug!("💾 [Orchestrator] Silently wrote summary to Frontmatter for: {}", relative_path);
                        }
                    }
                }
            }

            Ok(SkillResult { status: "success".into(), data: Some(s), timestamp: now })
        },
        Err(e) => Err(format!("Summarization failed: {}", e))
    }
}

/// Atomic Tagging Command
#[tauri::command]
pub async fn run_tagging(
    note_path: String,
    content: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<SkillResult, String> {
    if let Some(queue) = ai_state.queue.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let hash = slash_core::calculate_content_hash(&content);
        let _ = queue.submit_heavy(crate::core::ai::queue::HeavyJob::Tagging {
            note_path: note_path.clone(),
            content: content.clone(),
            hash,
            responder: tx,
        }).await;
        rx.await.unwrap_or_else(|_| Err("Queue communication failed".to_string()))
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_heavy_tagging(
    app_handle: tauri::AppHandle,
    note_path: String,
    content: String,
    content_hash: String,
) -> Result<SkillResult, String> {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    log::debug!("✨ [Atomic] process_heavy_tagging for {}", note_path);
    let vault_path = db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path).strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string()).unwrap_or(note_path.clone());
    if content.chars().count() < 50 { return Ok(SkillResult { status: "skipped".into(), data: None, timestamp: 0 }); }

    // 检查是否已被用户切换笔记而 abort 熔断
    {
        if let Ok(set) = get_aborted_set().read() {
            if set.contains(&relative_path) {
                log::warn!("🚫 [Orchestrator] Tagging request aborted on note switch for: {}", relative_path);
                return Ok(SkillResult { status: "aborted".into(), data: None, timestamp: 0 });
            }
        }
    }
    // Apply folder-level provider/model override (e.g., .slash-folder.yml)
    let service = ai_state.resolve_for_path(Path::new(&vault_path), &relative_path);

    // Check DB for cache
    let (cached_tags, tagging_hash, summary) = db_state.0.with_connection(|conn| {
        let t: String = conn.query_row(
            "SELECT COALESCE(tags, '[]') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).unwrap_or_default();
        let h: Option<String> = conn.query_row(
            "SELECT last_content_hash FROM ai_skill_state WHERE note_path = ?1 AND skill_id = 'tagging' AND last_result = 'success'",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).ok();
        let s: String = conn.query_row(
            "SELECT COALESCE(summary, '') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).unwrap_or_default();
        Ok((t, h, s))
    })?;

    if tagging_hash.as_deref() == Some(&content_hash) && cached_tags != "[]" {
        return Ok(SkillResult { status: "skipped".into(), data: Some(cached_tags), timestamp: 0 });
    }

    // Run LLM
    let note_filename = Path::new(&relative_path).file_stem().and_then(|n| n.to_str()).unwrap_or("note");
    let note_profile = build_note_profile(&content, note_filename);
    let edit_hint = EditHint::default();
    let extra_ctx = format!("Note summary: {}", summary);
    
    let mut tagging_input = input_strategy::build_skill_input(
        &content, &note_profile, &InputMode::ProfileWithChunks { top_k: 5 }, &edit_hint, Some(&extra_ctx)
    );
    let max_chars = input_strategy::estimate_max_input_chars(service.completion_model(), 128);
    if tagging_input.chars().count() > max_chars {
        tagging_input = tagging_input.chars().take(max_chars).collect();
    }

    let (existing_tags, fewshot) = db_state.0.with_connection(|conn| {
        let tags: Vec<String> = repository::get_existing_tags_with_frequency(conn, 100)
            .ok().map(|v| v.into_iter().map(|(tag, _)| tag).collect()).unwrap_or_default();
        let fs = repository::get_recent_tag_corrections(conn, 3).unwrap_or_default();
        Ok((tags, fs))
    })?;



    let skill = if existing_tags.is_empty() {
        TaggingSkill::new().with_fewshot(fewshot)
    } else {
        TaggingSkill::with_existing_tags(existing_tags).with_fewshot(fewshot)
    };

    match service.execute_skill(&skill, &tagging_input).await {
        Ok(tags) => {
            let tags_json = serde_json::to_string(&tags).unwrap_or_default();
            let rp = relative_path.clone();
            let ch = content_hash.clone();
            let tj = tags_json.clone();
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

            db_state.0.with_connection(move |conn| {
                let affected = conn.execute(
                    "UPDATE ai_metadata SET tags = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
                    rusqlite::params![&tj, &rp]
                )?;
                let res = if affected == 0 {
                    conn.execute(
                        "INSERT INTO ai_metadata (note_id, tags) SELECT id, ?1 FROM notes WHERE path = ?2", 
                        rusqlite::params![&tj, &rp]
                    )?
                } else { affected };
                if res == 0 { log::warn!("⚠️ [DB WARN] Atomic tagging affected 0 rows for {}", rp); }
                repository::upsert_skill_state(conn, &rp, "tagging", &ch, content.chars().count(), now, "success")?;
                Ok(())
            })?;
            Ok(SkillResult { status: "success".into(), data: Some(tags_json), timestamp: now })
        },
        Err(e) => Err(format!("Tagging failed: {}", e))
    }
}

/// Atomic Smart Rename Command
#[tauri::command]
pub async fn run_smart_rename(
    note_path: String,
    content: String,
    _db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    _app_handle: tauri::AppHandle,
) -> Result<RenameResult, String> {
    if let Some(queue) = ai_state.queue.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let hash = slash_core::calculate_content_hash(&content);
        let _ = queue.submit_heavy(crate::core::ai::queue::HeavyJob::SmartRename {
            note_path: note_path.clone(),
            content: content.clone(),
            hash,
            responder: tx,
        }).await;
        rx.await.unwrap_or_else(|_| Err("Queue communication failed".to_string()))
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_heavy_rename(
    app_handle: tauri::AppHandle,
    note_path: String,
    content: String,
    content_hash: String,
) -> Result<RenameResult, String> {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    log::debug!("✨ [Atomic] process_heavy_rename for {}", note_path);
    let vault_path = db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
    let relative_path = Path::new(&note_path).strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string()).unwrap_or(note_path.clone());

    // 检查是否已被用户切换笔记而 abort 熔断
    {
        if let Ok(set) = get_aborted_set().read() {
            if set.contains(&relative_path) {
                log::warn!("🚫 [Orchestrator] Smart Rename request aborted on note switch for: {}", relative_path);
                return Ok(RenameResult { status: "aborted".into(), old_path: relative_path, new_path: "".into(), new_title: "".into() });
            }
        }
    }

    if content.chars().count() < 50 { 
        return Ok(RenameResult { status: "skipped".into(), old_path: relative_path, new_path: "".into(), new_title: "".into() }); 
    }
    // Apply folder-level provider/model override (e.g., .slash-folder.yml)
    let service = ai_state.resolve_for_path(Path::new(&vault_path), &relative_path);

    // Check Cache — also fetch user_title and ai_title for skip decision
    let (rename_hash, summary, user_title, ai_title) = db_state.0.with_connection(|conn| {
         let h: Option<String> = conn.query_row(
            "SELECT last_content_hash FROM ai_skill_state WHERE note_path = ?1 AND skill_id = 'smart_rename' AND last_result = 'success'",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).ok();
        let s: String = conn.query_row(
            "SELECT COALESCE(summary, '') FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).unwrap_or_default();
        let ut: Option<String> = conn.query_row(
            "SELECT user_title FROM notes WHERE path = ?1",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).ok().flatten();
        let at: Option<String> = conn.query_row(
            "SELECT title FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
            rusqlite::params![&relative_path], |row| row.get(0)
        ).ok().flatten();
        Ok((h, s, ut, at))
    })?;

    if rename_hash.as_deref() == Some(&content_hash) {
        return Ok(RenameResult { status: "skipped".into(), old_path: relative_path, new_path: "".into(), new_title: "".into() });
    }

    // BUG-06 fix: Skip if user already has a manual title or AI has already generated one
    if let Some(ref ut) = user_title {
        if !ut.is_empty() {
            log::debug!("⏭️ [SmartRename] Skipped - user_title already set: {}", ut);
            return Ok(RenameResult { status: "skipped".into(), old_path: relative_path, new_path: "".into(), new_title: "".into() });
        }
    }
    if let Some(ref at) = ai_title {
        if !at.is_empty() {
            log::debug!("⏭️ [SmartRename] Skipped - ai_title already exists: {}", at);
            return Ok(RenameResult { status: "skipped".into(), old_path: relative_path, new_path: "".into(), new_title: "".into() });
        }
    }

    // Run LLM
    let note_filename = Path::new(&relative_path).file_stem().and_then(|n| n.to_str()).unwrap_or("note");
    let note_profile = build_note_profile(&content, note_filename);
    let edit_hint = EditHint::default();
    let rename_input = input_strategy::build_skill_input(
        &content, &note_profile, &InputMode::ProfileOnly, &edit_hint, Some(&summary)
    );

    let new_title = match service.generate_title(&rename_input).await {
        Ok(t) => t.trim().to_string(),
        Err(e) => return Err(format!("Smart rename failed: {}", e))
    };

    if new_title.is_empty() { return Err("Generated title is empty".into()); }

    // Rename Logic
    // Sanitize LLM-generated title to prevent path traversal
    let safe_title = sanitize_filename(&new_title);
    if safe_title.is_empty() {
        return Err("Sanitized title is empty".into());
    }
    let parent_dir = Path::new(&relative_path).parent().and_then(|p| p.to_str()).unwrap_or("");
    let new_filename = format!("{}.md", safe_title);
    let new_relative_path = if parent_dir.is_empty() { new_filename.clone() } else { format!("{}/{}", parent_dir, new_filename) };
    
    let old_absolute = vault_path.join(&relative_path);
    let new_absolute = vault_path.join(&new_relative_path);

    let rp = relative_path.clone();
    let nrp = new_relative_path.clone();
    let nt = new_title.clone();
    let ch = content_hash.clone();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

    let old_absolute_clone = old_absolute.clone();
    let new_absolute_clone = new_absolute.clone();

    let db_res: Result<(), String> = db_state.0.with_connection(move |conn| {
        // 1. Rename in DB FIRST to prevent File Watcher from dropping `ai_metadata` before we sync
        repository::rename_note_in_db(conn, &rp, &nrp)?;

        // 2. Rename on FS while holding the DB connection lock 
        // This ensures the File Watcher thread blocks on this connection until we finish writing title and metadata
        if let Err(e) = std::fs::rename(&old_absolute_clone, &new_absolute_clone) {
            let _ = repository::rename_note_in_db(conn, &nrp, &rp); // best-effort rollback
            return Ok(Err(format!("File rename failed: {}", e)));
        }

        conn.execute("UPDATE notes SET title = ?1, user_title = ?2 WHERE path = ?3", 
             rusqlite::params![&nt, &nt, &nrp])?;
             
        let affected = conn.execute(
            "UPDATE ai_metadata SET title = ?1 WHERE note_id = (SELECT id FROM notes WHERE path = ?2)",
            rusqlite::params![&nt, &nrp]
        )?;
        let res = if affected == 0 {
            conn.execute(
                "INSERT INTO ai_metadata (note_id, title) SELECT id, ?1 FROM notes WHERE path = ?2",
                rusqlite::params![&nt, &nrp]
            )?
        } else { affected };
        
        if res == 0 { log::warn!("⚠️ [DB WARN] Atomic Smart Rename affected 0 rows for {}", nrp); }
        repository::upsert_skill_state(conn, &nrp, "smart_rename", &ch, content.chars().count(), now, "success")?;
        
        let vault_path_clone = vault_path.clone();
        let old_stem = Path::new(&rp).file_stem().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if !old_stem.is_empty() {
            let _ = repository::update_wikilinks_on_rename(conn, &vault_path_clone, &old_stem, &nt);
        }
        Ok(Ok(()))
    }).map_err(|e| format!("DB Operation failed: {}", e))?;

    db_res?;

    // Frontmatter Update
    if let Ok(file_content) = std::fs::read_to_string(&new_absolute) {
        use crate::core::db::repository::frontmatter;
        let updated_content = frontmatter::update_frontmatter_field(&file_content, "title", &new_title);
        if updated_content != file_content {
            let _ = std::fs::write(&new_absolute, &updated_content);
        }
    }

    // Event Emission
    let _ = app_handle.emit("smart-rename:completed", serde_json::json!({
        "old_path": relative_path,
        "new_path": new_relative_path,
        "ai_title": new_title,
    }));

    Ok(RenameResult {
        status: "success".into(),
        old_path: relative_path,
        new_path: new_relative_path,
        new_title: new_title,
    })
}

