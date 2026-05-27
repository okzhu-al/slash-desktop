//! Ollama Provider Implementation
//!
//! Wraps `ollama-rs` into the `CompletionProvider` and `EmbeddingProvider` traits.
//!
//! NOTE: For chat completions we bypass `ollama-rs`'s `send_chat_messages()` and
//! send raw HTTP requests instead. This is necessary because `ollama-rs 0.2.x`
//! does not support the `think` parameter that Ollama uses to control whether
//! thinking-capable models (qwen3.5, gemma4, deepseek-r1, etc.) should perform
//! extended reasoning. Without `"think": false`, these models default to thinking
//! mode: they consume the entire `num_predict` budget on internal `<think>` blocks
//! and return empty `content`, causing silent inference failures across all skills.

use async_trait::async_trait;
use ollama_rs::generation::embeddings::request::GenerateEmbeddingsRequest;
use ollama_rs::Ollama;

use super::{
    AIError, CompletionProvider, CompletionRequest, CompletionResponse, EmbeddingProvider,
    ProviderInfo, ProviderStatus, ProviderType,
};

// ============================================================================
// OllamaProvider
// ============================================================================

/// Ollama provider — local LLM inference via ollama-rs
#[derive(Clone)]
pub struct OllamaProvider {
    client: Ollama,
    /// Standalone reqwest client for direct HTTP calls that bypass ollama-rs
    http_client: reqwest::Client,
    /// Base URL for raw HTTP requests (e.g. "http://localhost:11434")
    base_url: String,
    #[allow(dead_code)]
    generation_model: String,
    embedding_model: String,
}

#[allow(dead_code)]
impl OllamaProvider {
    /// Create with default localhost config
    pub fn new(generation_model: String, embedding_model: String) -> Self {
        let client = Ollama::new("http://localhost", 11434);
        Self {
            client,
            http_client: reqwest::Client::new(),
            base_url: "http://localhost:11434".to_string(),
            generation_model,
            embedding_model,
        }
    }

    /// Create with custom host/port
    pub fn with_host(
        host: String,
        port: u16,
        generation_model: String,
        embedding_model: String,
    ) -> Self {
        let client = Ollama::new(host.clone(), port);
        let base_url = format!("{}:{}", host, port);
        Self {
            client,
            http_client: reqwest::Client::new(),
            base_url,
            generation_model,
            embedding_model,
        }
    }

    /// Get a reference to the underlying Ollama client
    /// (needed for HyDE search which uses ollama-rs directly)
    pub fn client(&self) -> &Ollama {
        &self.client
    }

    /// Update generation model name (after discovery)
    pub fn set_generation_model(&mut self, model: String) {
        self.generation_model = model;
    }

    /// Update embedding model name (after discovery)
    pub fn set_embedding_model(&mut self, model: String) {
        self.embedding_model = model;
    }

    /// Get current generation model name
    pub fn generation_model(&self) -> &str {
        &self.generation_model
    }

    /// Get current embedding model name
    pub fn embedding_model(&self) -> &str {
        &self.embedding_model
    }
}

// ============================================================================
// CompletionProvider impl
// ============================================================================

#[async_trait]
impl CompletionProvider for OllamaProvider {
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionResponse, AIError> {
        // Build messages array for the Ollama /api/chat payload
        let mut messages = Vec::<serde_json::Value>::new();
        if let Some(ref sys) = request.system_prompt {
            messages.push(serde_json::json!({
                "role": "system",
                "content": sys
            }));
        }
        messages.push(serde_json::json!({
            "role": "user",
            "content": request.prompt
        }));

        // Construct the raw JSON body with `think: false` to disable reasoning
        // mode. ollama-rs 0.2.x does not support this parameter, so we bypass
        // the library entirely for chat completions.
        let body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": false,
            "think": false,
            "options": {
                "temperature": request.temperature,
                "top_p": request.top_p,
                "num_predict": request.max_tokens
            }
        });

        let url = format!("{}/api/chat", self.base_url);

        log::debug!(
            "🌐 [Ollama] Chat | model={}, num_predict={}, temp={}, think=false, stream=false",
            request.model, request.max_tokens, request.temperature
        );

        let res = self
            .http_client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AIError::ConnectionFailed(format!("Ollama chat failed: {}", e)))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(AIError::ConnectionFailed(format!(
                "Ollama returned HTTP {}: {}",
                err_text.len(),
                err_text
            )));
        }

        let resp_json: serde_json::Value = res
            .json()
            .await
            .map_err(|e| AIError::ParseError(format!("Failed to parse Ollama response: {}", e)))?;

        let content = resp_json["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        log::debug!(
            "✅ [Ollama] Response: {} chars / {} bytes, done={}",
            content.chars().count(),
            content.len(),
            resp_json["done"].as_bool().unwrap_or(false)
        );

        Ok(CompletionResponse {
            text: content,
            model: request.model,
            usage: None,
        })
    }

    async fn complete_stream(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<Result<String, AIError>>,
    ) -> Result<(), AIError> {
        use tokio_stream::StreamExt;

        // Build messages array for the Ollama /api/chat payload
        let mut messages = Vec::<serde_json::Value>::new();
        if let Some(ref sys) = request.system_prompt {
            messages.push(serde_json::json!({
                "role": "system",
                "content": sys
            }));
        }
        messages.push(serde_json::json!({
            "role": "user",
            "content": request.prompt
        }));

        // Construct the raw JSON body with `think: false` to disable reasoning
        // mode. ollama-rs 0.2.x does not support this parameter, so we bypass
        // the library entirely for chat completions stream.
        let body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": true,
            "think": false,
            "options": {
                "temperature": request.temperature,
                "top_p": request.top_p,
                "num_predict": request.max_tokens
            }
        });

        let url = format!("{}/api/chat", self.base_url);

        log::debug!(
            "🌐 [Ollama] Chat STREAM | model={}, num_predict={}, temp={}, think=false, stream=true",
            request.model, request.max_tokens, request.temperature
        );

        let res = self
            .http_client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AIError::ConnectionFailed(format!("Ollama stream failed: {}", e)))?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            let err = AIError::ConnectionFailed(format!(
                "Ollama returned HTTP {}: {}",
                err_text.len(),
                err_text
            ));
            let _ = tx.send(Err(err.clone())).await;
            return Err(err);
        }

        // ── NDJSON 逐行解析 ──
        let mut byte_stream = res.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk_result) = byte_stream.next().await {
            let bytes = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    let err = AIError::ProviderError(format!("Stream read error: {}", e));
                    let _ = tx.send(Err(err.clone())).await;
                    return Err(err);
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // 按换行符切分 NDJSON 行
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                // 反序列化每一行 JSON
                if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(content) = chunk["message"]["content"].as_str() {
                        if !content.is_empty() {
                            if tx.send(Ok(content.to_string())).await.is_err() {
                                return Ok(()); // Receiver dropped — abort
                            }
                        }
                    }

                    if chunk["done"].as_bool().unwrap_or(false) {
                        log::debug!("✅ [Ollama] Stream completed");
                        return Ok(());
                    }
                }
            }
        }

        log::debug!("✅ [Ollama] Stream ended without done=true");
        Ok(())
    }

    async fn check_availability(&self) -> Result<ProviderStatus, AIError> {
        let models = self.client.list_local_models().await.map_err(|e| {
            AIError::ConnectionFailed(format!("Failed to connect to Ollama: {}", e))
        })?;

        let model_names: Vec<String> = models.iter().map(|m| m.name.clone()).collect();

        Ok(ProviderStatus {
            available: !model_names.is_empty(),
            models: model_names,
        })
    }

    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            provider_type: ProviderType::Local,
            model_id: self.generation_model.clone(),
            context_window: None, // Ollama doesn't expose this easily
        }
    }
}

// ============================================================================
// EmbeddingProvider impl
// ============================================================================

#[async_trait]
impl EmbeddingProvider for OllamaProvider {
    async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, AIError> {
        let mut results = Vec::with_capacity(texts.len());

        for text in texts {
            let request = GenerateEmbeddingsRequest::new(self.embedding_model.clone(), text.into());

            let response = self
                .client
                .generate_embeddings(request)
                .await
                .map_err(|e| {
                    AIError::ConnectionFailed(format!("Embedding generation failed: {}", e))
                })?;

            // Convert f64 to f32 for storage efficiency
            let embedding: Vec<f32> = response
                .embeddings
                .into_iter()
                .flatten()
                .map(|v| v as f32)
                .collect();

            if embedding.is_empty() {
                return Err(AIError::ProviderError(
                    "Empty embedding returned".to_string(),
                ));
            }

            results.push(embedding);
        }

        Ok(results)
    }

    fn dimensions(&self) -> usize {
        // bge-m3 default: 1024 dimensions
        1024
    }

    fn model_id(&self) -> &str {
        &self.embedding_model
    }
}
