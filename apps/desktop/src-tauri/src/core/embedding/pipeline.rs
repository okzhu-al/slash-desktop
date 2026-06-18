//! Embedding Pipeline Core Logic
//!
//! Orchestrates the embedding generation process:
//! 1. Normalize content (preserve structure)
//! 2. Check hash for dedup
//! 3. Generate embedding via AIService
//! 4. Persist to database with status tracking

use super::denoise::{content_hash, denoise, DenoiseConfig};
use super::types::{ChunkKind, JobStatus, PipelineConfig, ProductType};
use crate::core::ai::service::AIService;
use rusqlite::{params, Connection};
use std::sync::Arc;
use std::time::Duration;

const AUDIO_VIDEO_FULL_CACHE_MARKER: &str = "audio_video_full_v1";
const LEGACY_AUDIO_VIDEO_TRUNCATION_CUTOFF: i64 = 4096;

/// LLM 配置，用于传给 Sidecar 做图片 OCR
#[derive(Clone, Default)]
pub struct SidecarLlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub llm_model: String,
}

#[derive(Debug, Clone)]
pub(crate) struct MediaEnrichResult {
    pub enriched_content: String,
    pub had_failures: bool,
}

fn is_audio_video_asset(filename: &str) -> bool {
    matches!(
        std::path::Path::new(filename)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some(
            "mp3"
                | "wav"
                | "mp4"
                | "avi"
                | "m4a"
                | "mkv"
                | "mov"
                | "webm"
                | "flac"
                | "ogg"
                | "wmv"
                | "flv"
                | "aac"
                | "wma"
                | "m4v"
        )
    )
}

fn media_cache_text_for_embedding(filename: &str, md_text: &str) -> String {
    if is_audio_video_asset(filename) {
        md_text.to_string()
    } else {
        md_text.chars().take(2000).collect()
    }
}

fn media_cache_model_name(filename: &str, model_name: &str) -> String {
    if is_audio_video_asset(filename) && !model_name.contains(AUDIO_VIDEO_FULL_CACHE_MARKER) {
        format!("{model_name}:{AUDIO_VIDEO_FULL_CACHE_MARKER}")
    } else {
        model_name.to_string()
    }
}

/// 多媒体语义提取：检测 ![](assets/...) 引用，查缓存或调 Sidecar /parse 获取文本
///
/// Phase 6 改造：接入 media_enrich_cache 表
/// - 以 CAS 文件名（即内容 hash）为键查询缓存
/// - 命中 → 直接使用缓存文本（0 Sidecar 调用）
/// - 未命中 → 调 Sidecar，结果写入缓存（确保后续调用返回相同文本，消除 chunk ID 漂移）
pub(crate) async fn enrich_with_media_detailed(
    content: &str,
    vault_path: Option<&std::path::Path>,
    llm_config: Option<&SidecarLlmConfig>,
    conn: Option<&Connection>,
) -> MediaEnrichResult {
    let media_regex = match regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
        Ok(r) => r,
        Err(_) => {
            return MediaEnrichResult {
                enriched_content: content.to_string(),
                had_failures: false,
            };
        }
    };

    let vault = match vault_path {
        Some(v) => v,
        None => {
            return MediaEnrichResult {
                enriched_content: content.to_string(),
                had_failures: false,
            };
        }
    };

    let mut media_texts: Vec<String> = Vec::new();
    let mut had_failures = false;

    for cap in media_regex.captures_iter(content) {
        let asset_rel = &cap[1];
        let asset_abs = vault.join(asset_rel);

        if !asset_abs.exists() {
            log::warn!("⚠️ [MediaEnrich] Asset not found: {}", asset_abs.display());
            had_failures = true;
            continue;
        }

        let filename = asset_abs.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        // CAS 文件名就是 hash（如 abc123.png），提取 stem 作为 cache key
        let asset_hash = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename)
            .to_string();

        // 1. 查缓存
        if let Some(db) = conn {
            let cached: Option<(String, i64, String)> = db.query_row(
                "SELECT enriched_text, char_count, model_name FROM media_enrich_cache WHERE asset_hash = ?1",
                rusqlite::params![&asset_hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).ok();

            if let Some((text, char_count, model_name)) = cached {
                let is_legacy_truncated_audio = is_audio_video_asset(filename)
                    && char_count <= LEGACY_AUDIO_VIDEO_TRUNCATION_CUTOFF
                    && !model_name.contains(AUDIO_VIDEO_FULL_CACHE_MARKER);
                if is_legacy_truncated_audio {
                    log::info!(
                        "♻️ [MediaEnrich] Refreshing legacy truncated audio/video cache for {} ({} chars, model={})",
                        filename,
                        char_count,
                        model_name
                    );
                } else {
                    log::info!("⚡ [MediaEnrich] Cache HIT for {} ({} chars)", filename, char_count);
                    media_texts.push(format!("\n[Media: {}]\n{}", filename, text));
                    continue;
                }
            }
        }

        // 2. Cache MISS → 调 Sidecar
        let cfg = match llm_config {
            Some(c) => c,
            None => {
                // Cache Only mode: return raw markdown if not in cache
                media_texts.push(format!("\n[Media: {}]\n{}", filename, asset_rel));
                continue;
            }
        };

        log::info!("🎬 [MediaEnrich] Cache MISS, calling Sidecar for: {}", filename);

        let mut payload = serde_json::json!({
            "local_path": asset_abs.to_string_lossy(),
            "filename": filename
        });
        if !cfg.base_url.is_empty() {
            payload["base_url"] = serde_json::Value::String(cfg.base_url.clone());
            payload["api_key"] = serde_json::Value::String(cfg.api_key.clone());
            payload["llm_model"] = serde_json::Value::String(cfg.llm_model.clone());
        }

        let sidecar_url = crate::core::sidecar::get_sidecar_base_url();
        let sidecar_timeout = if is_audio_video_asset(filename) {
            Duration::from_secs(1800)
        } else {
            Duration::from_secs(120)
        };
        match reqwest::Client::new()
            .post(&format!("{}/parse", sidecar_url))
            .json(&payload)
            .timeout(sidecar_timeout)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(md_text) = body["markdown"].as_str() {
                        if !md_text.is_empty() {
                            let cached_text = media_cache_text_for_embedding(filename, md_text);
                            let cached_char_count = cached_text.chars().count();
                            
                            // 3. 写入缓存（冻结文本，消除 ID 漂移）
                            if let Some(db) = conn {
                                let model_name = llm_config
                                    .map(|c| c.llm_model.as_str())
                                    .unwrap_or("unknown");
                                let cache_model_name = media_cache_model_name(filename, model_name);
                                let _ = db.execute(
                                    r#"INSERT OR REPLACE INTO media_enrich_cache 
                                       (asset_hash, enriched_text, model_name, char_count, updated_at)
                                       VALUES (?1, ?2, ?3, ?4, unixepoch())"#,
                                    rusqlite::params![
                                        &asset_hash,
                                        &cached_text,
                                        &cache_model_name,
                                        cached_char_count as i64,
                                    ],
                                );
                                log::info!("💾 [MediaEnrich] Cached {} ({} chars)", filename, cached_char_count);
                            }
                            
                            media_texts.push(format!("\n[Media: {}]\n{}", filename, cached_text));
                            log::info!(
                                "✅ [MediaEnrich] Got {} chars from {}",
                                md_text.chars().count(),
                                filename
                            );
                        } else {
                            log::warn!("⚠️ [MediaEnrich] Sidecar returned empty markdown for {} (LLM config present: {})", filename, llm_config.is_some());
                            had_failures = true;
                        }
                    } else {
                        log::warn!("⚠️ [MediaEnrich] Sidecar response missing 'markdown' field for {}", filename);
                        had_failures = true;
                    }
                } else {
                    log::warn!("⚠️ [MediaEnrich] Failed to parse sidecar JSON response for {}", filename);
                    had_failures = true;
                }
            }
            Ok(resp) => {
                log::warn!("⚠️ [MediaEnrich] Sidecar returned {}: {}", resp.status(), filename);
                had_failures = true;
            }
            Err(e) => {
                log::warn!("⚠️ [MediaEnrich] Sidecar request failed for {}: {}", filename, e);
                had_failures = true;
            }
        }
    }

    let enriched_content = if media_texts.is_empty() {
        content.to_string()
    } else {
        log::info!("🧬 [MediaEnrich] Enriched with {} media extractions", media_texts.len());
        format!("{}{}", content, media_texts.join(""))
    };

    MediaEnrichResult {
        enriched_content,
        had_failures,
    }
}

pub async fn enrich_with_media(
    content: &str,
    vault_path: Option<&std::path::Path>,
    llm_config: Option<&SidecarLlmConfig>,
    conn: Option<&Connection>,
) -> String {
    enrich_with_media_detailed(content, vault_path, llm_config, conn)
        .await
        .enriched_content
}

/// 检测内容中是否包含媒体引用 ![](assets/...)
pub fn has_media_references(content: &str) -> bool {
    regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)")
        .map(|r| r.is_match(content))
        .unwrap_or(false)
}

/// 检查所有媒体引用是否都已缓存
pub fn all_media_cached(content: &str, vault_path: &std::path::Path, conn: &Connection) -> bool {
    let media_regex = match regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)") {
        Ok(r) => r,
        Err(_) => return true,
    };
    
    for cap in media_regex.captures_iter(content) {
        let asset_rel = &cap[1];
        let asset_abs = vault_path.join(asset_rel);
        let filename = asset_abs.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");
        let asset_hash = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);
        
        let cached: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM media_enrich_cache WHERE asset_hash = ?1",
            rusqlite::params![asset_hash],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !cached {
            return false;
        }
    }
    true
}

/// Embedding Pipeline - infrastructure for vector generation
pub struct EmbeddingPipeline {
    pub config: PipelineConfig,
    pub denoise_config: DenoiseConfig,
    pub ai_service: Arc<AIService>,
    /// Vault path for resolving asset references in media enrichment
    pub vault_path: Option<std::path::PathBuf>,
}

#[allow(dead_code)]
impl EmbeddingPipeline {
    /// Create a new embedding pipeline
    pub fn new(ai_service: Arc<AIService>) -> Self {
        Self {
            config: PipelineConfig::default(),
            denoise_config: DenoiseConfig::default(),
            ai_service,
            vault_path: None,
        }
    }

    /// Set the vault path for media enrichment
    pub fn set_vault_path(&mut self, path: std::path::PathBuf) {
        self.vault_path = Some(path);
    }

    /// 从 AIService 的**实时配置**构建 SidecarLlmConfig（每次调用都读取最新设置）
    pub fn get_llm_config(&self) -> Option<SidecarLlmConfig> {
        let config = self.ai_service.config();
        if config.provider_type == "online" {
            log::info!("🔧 [LLM Config] provider=online, model={}, endpoint={}", 
                config.online_model, config.online_base_url);
        } else {
            log::info!("🔧 [LLM Config] provider=local, model={}, ollama_host={}", 
                config.generation_model, config.ollama_host);
        }
        if config.provider_type == "online" && !config.online_base_url.is_empty() {
            Some(SidecarLlmConfig {
                base_url: config.online_base_url.clone(),
                api_key: config.online_api_key.clone(),
                llm_model: config.online_model.clone(),
            })
        } else if !config.ollama_host.is_empty() {
            // 确保 Ollama URL 包含端口号（默认 11434）
            let host = config.ollama_host.trim_end_matches('/');
            let host_with_port = if host.contains("://") {
                let after_scheme = host.split("://").nth(1).unwrap_or(host);
                if after_scheme.contains(':') {
                    host.to_string()
                } else {
                    format!("{}:11434", host)
                }
            } else {
                format!("{}:11434", host)
            };
            
            Some(SidecarLlmConfig {
                base_url: format!("{}/v1", host_with_port),
                api_key: String::new(),
                llm_model: config.generation_model.clone(),
            })
        } else {
            None
        }
    }

    pub fn with_config(
        ai_service: Arc<AIService>,
        config: PipelineConfig,
        denoise_config: DenoiseConfig,
    ) -> Self {
        Self {
            config,
            denoise_config,
            ai_service,
            vault_path: None,
        }
    }

    /// Process a single note for NoteProfile embedding
    ///
    /// Returns:
    /// - Ok(true) if embedding was generated/updated
    /// - Ok(false) if skipped (up-to-date or too short)
    /// - Err if generation failed
    pub async fn process_note_profile(
        &self,
        note_path: &str,
        content: &str,
        conn: &Connection,
    ) -> Result<bool, String> {
        // 1. Normalize content (preserve structure)
        let cleaned = denoise(content, &self.denoise_config);

        // 2. Check minimum length
        if cleaned.len() < self.config.min_content_length {
            log::debug!("⏭️ [Embedding] Skipping short content: {} ({} chars)",
                note_path,
                cleaned.len()
            );
            return Ok(false);
        }

        // 3. Compute content hash and get chunk_id (fixed for NoteProfile)
        let hash = content_hash(&cleaned);
        let chunk_id = ProductType::NoteProfile
            .fixed_chunk_id()
            .unwrap_or("_profile")
            .to_string();

        // 4. Check if up-to-date (idempotency)
        if self.is_up_to_date(note_path, &hash, ProductType::NoteProfile, &chunk_id, conn)? {
            log::debug!("⏭️ [Embedding] Already up-to-date: {}", note_path);
            return Ok(false);
        }

        // 5. Mark as processing with heartbeat
        self.update_status(
            note_path,
            ProductType::NoteProfile,
            &chunk_id,
            JobStatus::Processing,
            conn,
        )?;

        // 6. Generate embedding
        log::debug!("🔄 [Embedding] Generating NoteProfile for: {}", note_path);
        let embedding = match self.ai_service.generate_embedding(&cleaned).await {
            Ok(emb) => emb,
            Err(e) => {
                // Mark as failed
                self.mark_failed(note_path, ProductType::NoteProfile, &chunk_id, &e, conn)?;
                return Err(e);
            }
        };

        // 7. Persist embedding
        self.save_embedding(
            &note_path,
            ProductType::NoteProfile,
            &chunk_id,
            &hash,
            &embedding,
            ChunkKind::Text,
            None,
            None,
            conn,
        )?;

        log::debug!("✅ [Embedding] Saved NoteProfile for {} (dim={})",
            note_path,
            embedding.len()
        );
        Ok(true)
    }

    /// Process a Summary embedding
    ///
    /// This is called when the Orchestrator generates a summary for a note.
    /// Unlike NoteProfile (which uses full note content), Summary uses the
    /// AI-generated summary text directly.
    ///
    /// Returns:
    /// - Ok(true) if embedding was generated/updated
    /// - Ok(false) if skipped (up-to-date or too short)
    /// - Err if generation failed
    pub async fn process_summary(
        &self,
        note_path: &str,
        summary_text: &str,
        conn: &Connection,
    ) -> Result<bool, String> {
        // 1. Check minimum length
        if summary_text.len() < 20 {
            log::debug!("⏭️ [Embedding] Skipping short summary: {} ({} chars)",
                note_path,
                summary_text.len()
            );
            return Ok(false);
        }

        // 2. Compute content hash and get fixed chunk_id
        let hash = content_hash(summary_text);
        let chunk_id = ProductType::Summary
            .fixed_chunk_id()
            .unwrap_or("_summary")
            .to_string();

        // 3. Check if up-to-date (idempotency)
        if self.is_up_to_date(note_path, &hash, ProductType::Summary, &chunk_id, conn)? {
            log::debug!("⏭️ [Embedding] Summary already up-to-date: {}", note_path);
            return Ok(false);
        }

        // 4. Mark as processing
        self.update_status(
            note_path,
            ProductType::Summary,
            &chunk_id,
            JobStatus::Processing,
            conn,
        )?;

        // 5. Generate embedding
        log::debug!("🔄 [Embedding] Generating Summary embedding for: {}",
            note_path
        );
        let embedding = match self.ai_service.generate_embedding(summary_text).await {
            Ok(emb) => emb,
            Err(e) => {
                self.mark_failed(note_path, ProductType::Summary, &chunk_id, &e, conn)?;
                return Err(e);
            }
        };

        // 6. Persist embedding
        self.save_embedding(
            note_path,
            ProductType::Summary,
            &chunk_id,
            &hash,
            &embedding,
            ChunkKind::Text,
            None,
            None,
            conn,
        )?;

        log::debug!("✅ [Embedding] Saved Summary for {} (dim={})",
            note_path,
            embedding.len()
        );
        Ok(true)
    }

    /// Process a single paragraph chunk embedding
    ///
    /// This is called for individual chunks from schedule_blur/schedule_idle
    pub async fn process_paragraph_chunk(
        &self,
        note_path: &str,
        chunk_id: &str,
        content: &str,
        heading_path: &str,
        chunk_kind: ChunkKind,
        conn: &Connection,
    ) -> Result<bool, String> {
        // Phase 6: 不再在 chunk 级别调 enrich_with_media
        // 内容已由调度层（schedule_note_for_embedding / process_pending_paragraphs_with_vault）预处理
        let enriched = content;
        log::debug!("🔍 [Embedding] Paragraph chunk '{}' content={}chars",
            chunk_id, content.len()
        );

        // 1. Normalize content
        let cleaned = denoise(enriched, &self.denoise_config);

        if cleaned.len() < 50 {
            log::debug!("⏭️ [Embedding] Skipping short chunk: {} ({} chars after denoise)",
                chunk_id,
                cleaned.len()
            );
            return Ok(false);
        }

        // 2. Compute content hash
        let hash = content_hash(&cleaned);

        // 3. Check if up-to-date
        if self.is_up_to_date(note_path, &hash, ProductType::Paragraph, chunk_id, conn)? {
            return Ok(false);
        }

        // 4. Mark as processing
        self.update_status(
            note_path,
            ProductType::Paragraph,
            chunk_id,
            JobStatus::Processing,
            conn,
        )?;

        // 5. Generate embedding
        let embedding = match self.ai_service.generate_embedding(&cleaned).await {
            Ok(emb) => emb,
            Err(e) => {
                self.mark_failed(note_path, ProductType::Paragraph, chunk_id, &e, conn)?;
                return Err(e);
            }
        };

        // 6. Save embedding
        self.save_embedding(
            note_path,
            ProductType::Paragraph,
            chunk_id,
            &hash,
            &embedding,
            chunk_kind,
            Some(heading_path),
            Some(content),
            conn,
        )?;

        log::debug!("✅ [Embedding] Saved Paragraph {} for {} (dim={})",
            chunk_id,
            note_path,
            embedding.len()
        );
        Ok(true)
    }

    /// Batch process multiple chunks with provided content
    ///
    /// This is the main entry point for batch embedding generation.
    /// Takes a list of (chunk_id, content, heading_path, chunk_kind) and processes them.
    /// Returns: (processed_count, failed_count, skipped_count)
    pub async fn process_chunks_with_content(
        &self,
        note_path: &str,
        chunks: Vec<(String, String, String, ChunkKind)>, // (chunk_id, content, heading_path, kind)
        conn: &Connection,
    ) -> Result<(usize, usize, usize), String> {
        let mut processed = 0;
        let mut failed = 0;
        let mut skipped = 0;

        for (chunk_id, content, heading_path, chunk_kind) in chunks {
            match self
                .process_paragraph_chunk(
                    note_path,
                    &chunk_id,
                    &content,
                    &heading_path,
                    chunk_kind,
                    conn,
                )
                .await
            {
                Ok(true) => processed += 1,
                Ok(false) => skipped += 1,
                Err(e) => {
                    log::error!("❌ [Embedding] Batch chunk {} failed: {}", chunk_id, e);
                    failed += 1;
                }
            }
        }

        log::debug!("📦 [Embedding] Batch complete: {} processed, {} skipped, {} failed",
            processed, skipped, failed
        );

        Ok((processed, failed, skipped))
    }

    /// Process all pending jobs from embeddings_v2 queue
    ///
    /// Reads pending jobs from database and attempts to generate embeddings.
    /// Note: This requires the chunk content to be stored or retrievable.
    /// Returns: (processed_count, failed_count, skipped_count)
    pub async fn process_pending_jobs(
        &self,
        conn: &Connection,
        batch_size: usize,
    ) -> Result<(usize, usize, usize), String> {
        let pending = Self::get_pending_jobs(conn, self.config.max_retries)?;
        let processed = 0;
        let mut failed = 0;
        let skipped = 0;

        log::debug!("📋 [Embedding] Found {} pending jobs, processing up to {}",
            pending.len(),
            batch_size
        );

        for (note_path, product_type_str, chunk_id) in pending.into_iter().take(batch_size) {
            // Get chunk metadata from database
            let meta_result: Result<(String, Option<String>, Option<String>), _> = conn.query_row(
                r#"
                SELECT content_hash, heading_path, chunk_kind 
                FROM embeddings_v2 
                WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
                "#,
                params![note_path, product_type_str, chunk_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            );

            let (content_hash, _heading_path, _chunk_kind_str) = match meta_result {
                Ok(r) => r,
                Err(e) => {
                    log::error!("❌ [Embedding] Failed to get chunk meta: {}", e);
                    failed += 1;
                    continue;
                }
            };

            // Parse product type
            let product_type = ProductType::from_str(&product_type_str);

            // For NoteProfile type, we need full note content from notes table
            if matches!(product_type, ProductType::NoteProfile) {
                // NoteProfile embedding uses the entire note content
                // We need to fetch it from the notes table or file
                log::debug!("⚠️ [Embedding] NoteProfile pending: {} (requires content fetch)",
                    note_path
                );
                // Skip for now - handled by schedule_blur/idle when note is opened
                continue;
            }

            // For Paragraph type, we'd need cached content
            // Since we don't store raw chunk content, these need to be processed
            // via schedule_blur when the note is edited
            log::debug!("⚠️ [Embedding] Paragraph pending: {}:{} hash={} (processed on next blur)",
                note_path, chunk_id, content_hash
            );
        }

        Ok((processed, failed, skipped))
    }

    /// Process pending paragraph chunks by reading note files from vault
    ///
    /// This method:
    /// 1. Gets pending paragraph jobs grouped by note_path
    /// 2. Reads each note file from vault
    /// 3. Re-chunks the content
    /// 4. Generates embeddings for matching chunks
    ///
    /// Returns: (processed_count, failed_count, skipped_count)
    pub async fn process_pending_paragraphs_with_vault(
        &self,
        conn: &Connection,
        vault_path: &std::path::Path,
        batch_size: usize,
    ) -> Result<(usize, usize, usize), String> {
        use super::chunker::{chunk_document, ChunkingConfig};
        use std::collections::HashMap;

        let pending = Self::get_pending_jobs(conn, self.config.max_retries)?;
        let mut processed = 0;
        let mut failed = 0;
        let mut skipped = 0;

        // Group pending jobs by note_path for efficient file reading
        let mut jobs_by_note: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for (note_path, product_type_str, chunk_id) in pending.into_iter().take(batch_size) {
            if product_type_str == "paragraph" {
                jobs_by_note
                    .entry(note_path)
                    .or_default()
                    .push((chunk_id, product_type_str));
            }
        }

        log::debug!("📂 [Embedding] Processing {} notes with pending paragraphs",
            jobs_by_note.len()
        );

        let chunking_config = ChunkingConfig::default();

        for (note_path, pending_chunks) in jobs_by_note {
            // Read note file
            let file_path = vault_path.join(&note_path);
            let content = match std::fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("❌ [Embedding] Failed to read {}: {}", note_path, e);
                    // Mark all pending chunks as abandoned since file doesn't exist
                    for (chunk_id, _) in &pending_chunks {
                        let _ =
                            self.mark_abandoned(&note_path, ProductType::Paragraph, chunk_id, conn);
                    }
                    skipped += pending_chunks.len();
                    continue;
                }
            };

            // OPT-06 Phase 6: 对媒体引用做 enrichment（强制走 Cache Only），保证后台静默不卡顿
            let enriched_content = enrich_with_media(&content, Some(vault_path), None, Some(conn)).await;

            // Chunk the document (用 enriched 内容，与 schedule_note_for_embedding 一致)
            let chunk_result = chunk_document(&enriched_content, &chunking_config);

            // Build chunk lookup by ID
            let chunk_map: HashMap<_, _> = chunk_result
                .chunks
                .iter()
                .map(|c| (c.chunk_id.clone(), c))
                .collect();

            // Process pending chunks
            for (chunk_id, _product_type) in pending_chunks {
                if let Some(chunk) = chunk_map.get(&chunk_id) {
                    match self
                        .process_paragraph_chunk(
                            &note_path,
                            &chunk_id,
                            &chunk.content,
                            &chunk.heading_path,
                            chunk.kind.clone(),
                            conn,
                        )
                        .await
                    {
                        Ok(true) => processed += 1,
                        Ok(false) => skipped += 1,
                        Err(e) => {
                            log::error!("❌ [Embedding] Chunk {} failed: {}", chunk_id, e);
                            failed += 1;
                        }
                    }
                } else {
                    // Chunk no longer exists (content changed) - mark as abandoned silently
                    let _ =
                        self.mark_abandoned(&note_path, ProductType::Paragraph, &chunk_id, conn);
                    skipped += 1;
                }
            }
        }

        log::debug!("✅ [Embedding] Paragraph batch: {} processed, {} failed, {} skipped",
            processed, failed, skipped
        );

        Ok((processed, failed, skipped))
    }

    /// Mark a job as abandoned (content changed, chunk no longer exists)
    fn mark_abandoned(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<(), String> {
        // P-008: Removed verbose per-chunk logging, cleanup stats are logged in worker cycle
        conn.execute(
            r#"
            UPDATE embeddings_v2 
            SET status = 'abandoned', error_message = 'Content changed, chunk no longer exists'
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
            "#,
            params![note_path, product_type.as_str(), chunk_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Process pending NoteProfile jobs by reading note files from vault
    ///
    /// This method:
    /// 1. Gets pending NoteProfile jobs
    /// 2. Reads each note file from vault
    /// 3. Generates NoteProfile embedding using full note content
    ///
    /// Returns: (processed_count, failed_count, skipped_count)
    pub async fn process_pending_note_profiles_with_vault(
        &self,
        conn: &Connection,
        vault_path: &std::path::Path,
        batch_size: usize,
    ) -> Result<(usize, usize, usize), String> {
        let pending = Self::get_pending_jobs(conn, self.config.max_retries)?;
        let mut processed = 0;
        let mut failed = 0;
        let mut skipped = 0;

        // Filter for NoteProfile jobs only
        let note_profile_jobs: Vec<_> = pending
            .into_iter()
            .filter(|(_, product_type_str, _)| product_type_str == "note_profile")
            .take(batch_size)
            .collect();

        log::debug!("📝 [Embedding] Processing {} pending NoteProfile jobs",
            note_profile_jobs.len()
        );

        for (note_path, _product_type, chunk_id) in note_profile_jobs {
            // Read note file
            let file_path = vault_path.join(&note_path);
            let content = match std::fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("❌ [Embedding] Failed to read {}: {}", note_path, e);
                    // Mark as abandoned since file doesn't exist
                    let _ =
                        self.mark_abandoned(&note_path, ProductType::NoteProfile, &chunk_id, conn);
                    skipped += 1;
                    continue;
                }
            };

            // Process NoteProfile using existing method
            match self.process_note_profile(&note_path, &content, conn).await {
                Ok(true) => {
                    processed += 1;
                    log::debug!("✅ [Embedding] NoteProfile generated: {}", note_path);
                }
                Ok(false) => {
                    // Skipped (up-to-date or too short)
                }
                Err(e) => {
                    log::error!("❌ [Embedding] NoteProfile failed for {}: {}", note_path, e);
                    failed += 1;
                }
            }
        }

        log::debug!("✅ [Embedding] NoteProfile batch: {} processed, {} failed",
            processed, failed
        );

        Ok((processed, failed, skipped))
    }

    /// Process pending Summary jobs by reading summaries from database
    ///
    /// This method:
    /// 1. Gets pending Summary jobs
    /// 2. Reads the ai_summary from notes table
    /// 3. Generates Summary embedding
    ///
    /// Returns: (processed_count, failed_count, skipped_count)
    pub async fn process_pending_summaries(
        &self,
        conn: &Connection,
        batch_size: usize,
    ) -> Result<(usize, usize, usize), String> {
        let pending = Self::get_pending_jobs(conn, self.config.max_retries)?;
        let mut processed = 0;
        let mut failed = 0;
        let skipped = 0;

        // Filter for Summary jobs only
        let summary_jobs: Vec<_> = pending
            .into_iter()
            .filter(|(_, product_type_str, _)| product_type_str == "summary")
            .take(batch_size)
            .collect();

        log::debug!("📄 [Embedding] Processing {} pending Summary jobs",
            summary_jobs.len()
        );

        for (note_path, _product_type, _chunk_id) in summary_jobs {
            // Guard: check if this note still exists in DB (may have been deleted/renamed)
            let note_exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM notes WHERE path = ?1",
                    params![note_path],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if !note_exists {
                log::debug!("🧹 [Embedding] Note no longer exists, abandoning summary job: {}",
                    note_path
                );
                let _ = self.mark_abandoned(&note_path, ProductType::Summary, "_summary", conn);
                continue;
            }

            // Read summary from database
            let summary_result: Result<String, _> = conn.query_row(
                "SELECT summary FROM ai_metadata WHERE note_id = (SELECT id FROM notes WHERE path = ?1)",
                params![note_path],
                |row| row.get(0),
            );

            let summary_text = match summary_result {
                Ok(s) => s,
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    log::debug!("⚠️ [Embedding] No summary found for: {}", note_path);
                    // Mark as abandoned since no summary exists
                    let _ = self.mark_abandoned(&note_path, ProductType::Summary, "_summary", conn);
                    continue;
                }
                Err(e) => {
                    log::error!("❌ [Embedding] Failed to read summary for {}: {}",
                        note_path, e
                    );
                    failed += 1;
                    continue;
                }
            };

            // Process Summary embedding
            match self.process_summary(&note_path, &summary_text, conn).await {
                Ok(true) => {
                    processed += 1;
                    log::debug!("✅ [Embedding] Summary embedding generated: {}", note_path);
                }
                Ok(false) => {
                    // Skipped (up-to-date or too short)
                }
                Err(e) => {
                    log::error!("❌ [Embedding] Summary embedding failed for {}: {}",
                        note_path, e
                    );
                    failed += 1;
                }
            }
        }

        log::debug!("✅ [Embedding] Summary batch: {} processed, {} failed",
            processed, failed
        );

        Ok((processed, failed, skipped))
    }

    /// Check if embedding is up-to-date
    fn is_up_to_date(
        &self,
        note_path: &str,
        hash: &str,
        product_type: ProductType,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<bool, String> {
        let result: Result<(String, String, u32), _> = conn.query_row(
            r#"
            SELECT content_hash, model_version, pipeline_version
            FROM embeddings_v2
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
              AND status = 'completed'
            "#,
            params![note_path, product_type.as_str(), chunk_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );

        match result {
            Ok((existing_hash, model, version)) => {
                // Up-to-date if hash, model, and pipeline version all match
                Ok(existing_hash == hash
                    && model == self.config.model_name
                    && version == self.config.pipeline_version)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Update job status with heartbeat
    fn update_status(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        status: JobStatus,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            INSERT INTO embeddings_v2 (note_path, product_type, chunk_id, content_hash, embedding, model_version, pipeline_version, status, heartbeat_at)
            VALUES (?1, ?2, ?3, '', X'', ?4, ?5, ?6, unixepoch())
            ON CONFLICT(note_path, product_type, chunk_id) DO UPDATE SET
                status = excluded.status,
                heartbeat_at = unixepoch(),
                updated_at = unixepoch()
            "#,
            params![
                note_path,
                product_type.as_str(),
                chunk_id,
                &self.config.model_name,
                self.config.pipeline_version,
                status.as_str(),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Update heartbeat for long-running jobs
    #[allow(dead_code)]
    pub fn update_heartbeat(
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            UPDATE embeddings_v2
            SET heartbeat_at = unixepoch(), updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3 AND status = 'processing'
            "#,
            params![note_path, product_type.as_str(), chunk_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark job as failed
    fn mark_failed(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        error: &str,
        conn: &Connection,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            UPDATE embeddings_v2
            SET status = 'failed',
                retry_count = retry_count + 1,
                error_message = ?4,
                updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
            "#,
            params![note_path, product_type.as_str(), chunk_id, error],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Save completed embedding
    ///
    /// Uses UPDATE (not INSERT) so that if delete_note has already removed the record,
    /// no new record is created. This prevents the delete-then-insert race condition
    /// where a background worker completes processing after the note has been deleted.
    fn save_embedding(
        &self,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
        hash: &str,
        embedding: &[f32],
        chunk_kind: ChunkKind,
        heading_path: Option<&str>,
        enriched_content: Option<&str>,
        conn: &Connection,
    ) -> Result<(), String> {
        // Convert f32 vec to bytes
        let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();

        let updated = conn
            .execute(
                r#"
            UPDATE embeddings_v2 SET
                content_hash = ?4,
                embedding = ?5,
                model_version = ?6,
                pipeline_version = ?7,
                status = 'completed',
                chunk_kind = ?8,
                heading_path = ?9,
                enriched_content = COALESCE(?10, enriched_content),
                error_message = NULL,
                updated_at = unixepoch()
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
              AND status IN ('pending', 'processing')
            "#,
                params![
                    note_path,
                    product_type.as_str(),
                    chunk_id,
                    hash,
                    embedding_bytes,
                    &self.config.model_name,
                    self.config.pipeline_version,
                    chunk_kind.as_str(),
                    heading_path,
                    enriched_content,
                ],
            )
            .map_err(|e| e.to_string())?;

        if updated == 0 {
            // Record was already deleted (note was trashed) or not in pending/processing state.
            // This is expected in race conditions - silently skip.
            log::debug!("⏭️ [Embedding] save_embedding skipped (record gone or not pending): {} {} {}",
                note_path,
                product_type.as_str(),
                chunk_id
            );
        }

        Ok(())
    }

    /// Get embedding from v2 table
    #[allow(dead_code)]
    pub fn get_embedding(
        conn: &Connection,
        note_path: &str,
        product_type: ProductType,
        chunk_id: &str,
    ) -> Result<Option<Vec<f32>>, String> {
        let result: Result<Vec<u8>, _> = conn.query_row(
            r#"
            SELECT embedding FROM embeddings_v2
            WHERE note_path = ?1 AND product_type = ?2 AND chunk_id = ?3
              AND status = 'completed'
            "#,
            params![note_path, product_type.as_str(), chunk_id],
            |row| row.get(0),
        );

        match result {
            Ok(bytes) => {
                let floats: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();
                Ok(Some(floats))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Get all note profile embeddings for semantic search
    #[allow(dead_code)]
    pub fn get_all_note_profiles(conn: &Connection) -> Result<Vec<(String, Vec<f32>)>, String> {
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, embedding FROM embeddings_v2
            WHERE product_type = 'note_profile' AND status = 'completed'
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let bytes: Vec<u8> = row.get(1)?;
                let floats: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();
                Ok((path, floats))
            })
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Get stale processing jobs (heartbeat timeout exceeded)
    #[allow(dead_code)]
    pub fn get_stale_jobs(
        conn: &Connection,
        timeout_secs: i64,
    ) -> Result<Vec<(String, String, String)>, String> {
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, product_type, chunk_id FROM embeddings_v2
            WHERE status = 'processing'
              AND (heartbeat_at IS NULL OR heartbeat_at < unixepoch() - ?1)
            ORDER BY updated_at ASC
            LIMIT 100
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map(params![timeout_secs], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Get pending/failed jobs for processing
    #[allow(dead_code)]
    pub fn get_pending_jobs(
        conn: &Connection,
        max_retries: u8,
    ) -> Result<Vec<(String, String, String)>, String> {
        let mut stmt = conn
            .prepare(
                r#"
            SELECT note_path, product_type, chunk_id FROM embeddings_v2
            WHERE status = 'pending'
               OR (status = 'failed' AND retry_count < ?1)
            ORDER BY priority DESC, updated_at ASC
            LIMIT 100
            "#,
            )
            .map_err(|e| e.to_string())?;

        let results = stmt
            .query_map(params![max_retries], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;

        results
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}
