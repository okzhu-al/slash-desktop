//! OpenAI Compatible Provider
//!
//! 实现 CompletionProvider trait，支持所有 OpenAI 兼容 API：
//! DeepSeek、Moonshot、SiliconFlow、Groq、OpenAI、Gemini 等。

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use super::{
    AIError, CompletionProvider, CompletionRequest, CompletionResponse, ProviderInfo,
    ProviderStatus, ProviderType, TokenUsage,
};

// ============================================================================
// OpenAI Compatible Provider
// ============================================================================

/// OpenAI 兼容 Provider — 通过标准 Chat Completions API 调用在线模型
#[derive(Clone)]
pub struct OpenAICompatibleProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAICompatibleProvider {
    /// 创建 Provider
    /// - `base_url`: API 基础地址，例如 "https://api.deepseek.com"
    /// - `api_key`: API 密钥
    /// - `model`: 模型名称，例如 "deepseek-chat"
    pub fn new(base_url: String, api_key: String, model: String) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        // 规范化 base_url：去除尾部 /
        let base_url = base_url.trim_end_matches('/').to_string();

        Self {
            client,
            base_url,
            api_key,
            model,
        }
    }

    /// 获取当前模型名
    #[allow(dead_code)]
    pub fn model(&self) -> &str {
        &self.model
    }

    /// 判断是否为 Gemini API（使用不同的认证 header 和 URL 结构）
    fn is_gemini(&self) -> bool {
        self.base_url.contains("googleapis.com")
    }

    /// Chat Completions 端点 URL
    /// - 标准 OpenAI: {base}/v1/chat/completions
    /// - Gemini:      {base}/chat/completions （无 /v1 前缀）
    fn chat_url(&self) -> String {
        if self.is_gemini() {
            format!("{}/chat/completions", self.base_url)
        } else {
            format!("{}/v1/chat/completions", self.base_url)
        }
    }

    /// Models 列表端点 URL
    fn models_url(&self) -> String {
        if self.is_gemini() {
            format!("{}/models", self.base_url)
        } else {
            format!("{}/v1/models", self.base_url)
        }
    }

    /// 构建带认证的请求 builder
    fn auth_request(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        // 所有 OpenAI 兼容端点（包括 Gemini）都使用标准 Bearer 认证
        builder.header("Authorization", format!("Bearer {}", self.api_key))
    }
}

// ============================================================================
// Response types (deserialization only — no request struct needed)
// ============================================================================

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

/// API 错误响应
#[derive(Deserialize)]
struct ApiErrorResponse {
    error: Option<ApiErrorDetail>,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: Option<String>,
}

// ── SSE Streaming response types ──

#[derive(Deserialize)]
struct StreamChunkResponse {
    choices: Vec<StreamChunkChoice>,
}

#[derive(Deserialize)]
struct StreamChunkChoice {
    delta: StreamChunkDelta,
}

#[derive(Deserialize)]
struct StreamChunkDelta {
    content: Option<String>,
}

// ============================================================================
// CompletionProvider impl
// ============================================================================

#[async_trait]
impl CompletionProvider for OpenAICompatibleProvider {
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionResponse, AIError> {
        let url = self.chat_url();

        // ── Build messages array ──
        let messages: Vec<serde_json::Value> = if let Some(ref sys) = request.system_prompt {
            vec![
                serde_json::json!({ "role": "system", "content": sys }),
                serde_json::json!({ "role": "user",   "content": &request.prompt }),
            ]
        } else {
            vec![serde_json::json!({ "role": "user", "content": &request.prompt })]
        };

        // ── Build request body ──
        // NOTE: We intentionally OMIT the `max_tokens` (or `max_completion_tokens`) field.
        // Reason: Different providers treat this field differently. Some strictly cap output tokens,
        // which interrupts JSON output for tasks like Tagging, causing parse failures.
        // Thinking models (like Gemini 3, o1, r1) often consume this budget for invisible reasoning.
        // By omitting it, we let the provider determine the maximum output context naturally,
        // relying on the System Prompt to guide the model to stop concisely when the JSON is complete.
        let body = serde_json::json!({
            "model": &request.model,
            "messages": messages,
            "temperature": request.temperature,
            "top_p": request.top_p,
        });

        let roles_str = messages
            .iter()
            .filter_map(|m| m["role"].as_str())
            .collect::<Vec<_>>()
            .join("+");

        log::debug!(
            "🌐 [OpenAI] POST {} | model={}, temp={}, roles={}, stream=false",
            url,
            request.model,
            request.temperature,
            roles_str,
        );

        // Print actual serialized body to confirm correct field and value
        {
            let body_str = serde_json::to_string(&body).unwrap_or_default();
            let preview: String = body_str.chars().take(500).collect();
            log::debug!("🔍 [OpenAI] REQUEST BODY: {}", preview);
        }

        let response = self
            .auth_request(
                self.client
                    .post(&url)
                    .header("Content-Type", "application/json"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AIError::ConnectionFailed(format!("Request timed out: {}", e))
                } else if e.is_connect() {
                    AIError::ConnectionFailed(format!("Connection failed: {}", e))
                } else {
                    AIError::Other(format!("HTTP error: {}", e))
                }
            })?;

        let status = response.status();

        // 处理 HTTP 错误
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            let error_msg = serde_json::from_str::<ApiErrorResponse>(&error_body)
                .ok()
                .and_then(|r| r.error)
                .and_then(|e| e.message)
                .unwrap_or(error_body);

            return match status.as_u16() {
                429 => Err(AIError::RateLimited {
                    retry_after_ms: Some(5000),
                }),
                401 | 403 => Err(AIError::ProviderError(format!(
                    "Authentication failed: {}",
                    error_msg
                ))),
                404 => Err(AIError::ModelNotFound(format!(
                    "Model or endpoint not found: {}",
                    error_msg
                ))),
                _ => Err(AIError::ProviderError(format!(
                    "HTTP {}: {}",
                    status, error_msg
                ))),
            };
        }

        // 解析成功响应
        let chat_response: ChatCompletionResponse = response
            .json()
            .await
            .map_err(|e| AIError::ParseError(format!("Failed to parse API response: {}", e)))?;

        let text = chat_response
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();

        let usage = chat_response.usage.map(|u| TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
        });

        // Truncation diagnostic: log finish_reason
        let finish_reason = chat_response
            .choices
            .first()
            .and_then(|c| c.finish_reason.as_deref())
            .unwrap_or("unknown");
        if finish_reason != "stop" {
            log::warn!(
                "⚠️ [OpenAI] finish_reason='{}' (expected 'stop') — output may be truncated!",
                finish_reason
            );
        }

        log::debug!(
            "✅ [OpenAI] Response: {} chars / {} bytes, finish_reason={}, usage={}",
            text.chars().count(),
            text.len(),
            finish_reason,
            usage.as_ref().map_or("N/A".to_string(), |u| format!(
                "prompt={}, completion={}, total={}",
                u.prompt_tokens, u.completion_tokens, u.total_tokens
            ))
        );

        Ok(CompletionResponse {
            text,
            model: request.model,
            usage,
        })
    }

    async fn complete_stream(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<Result<String, AIError>>,
    ) -> Result<(), AIError> {
        use tokio_stream::StreamExt;

        let url = self.chat_url();

        // ── Build messages array (same as complete()) ──
        let messages: Vec<serde_json::Value> = if let Some(ref sys) = request.system_prompt {
            vec![
                serde_json::json!({ "role": "system", "content": sys }),
                serde_json::json!({ "role": "user",   "content": &request.prompt }),
            ]
        } else {
            vec![serde_json::json!({ "role": "user", "content": &request.prompt })]
        };

        // ── Build request body (Omitting max_tokens to prevent arbitrary cutoffs) ──
        let body = serde_json::json!({
            "model": &request.model,
            "messages": messages,
            "temperature": request.temperature,
            "top_p": request.top_p,
            "stream": true,
        });

        log::debug!(
            "🌐 [OpenAI] POST {} | model={}, temp={}, stream=true",
            url, request.model, request.temperature,
        );

        let response = self
            .auth_request(
                self.client
                    .post(&url)
                    .header("Content-Type", "application/json"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| AIError::ConnectionFailed(format!("Stream request failed: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            let error_msg = serde_json::from_str::<ApiErrorResponse>(&error_body)
                .ok()
                .and_then(|r| r.error)
                .and_then(|e| e.message)
                .unwrap_or(error_body);
            let err = AIError::ProviderError(format!("HTTP {}: {}", status, error_msg));
            let _ = tx.send(Err(err.clone())).await;
            return Err(err);
        }

        // ── SSE 逐行解析 ──
        let mut byte_stream = response.bytes_stream();
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

            // 按行处理 SSE 事件
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue; // 空行或 SSE 注释
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    let data = data.trim();

                    if data == "[DONE]" {
                        log::debug!("✅ [OpenAI] Stream completed");
                        return Ok(());
                    }

                    // 解析 JSON chunk
                    if let Ok(chunk) = serde_json::from_str::<StreamChunkResponse>(data) {
                        if let Some(choice) = chunk.choices.first() {
                            if let Some(ref content) = choice.delta.content {
                                if !content.is_empty() {
                                    if tx.send(Ok(content.clone())).await.is_err() {
                                        return Ok(()); // Receiver dropped
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        log::debug!("✅ [OpenAI] Stream ended (no [DONE])");
        Ok(())
    }

    async fn check_availability(&self) -> Result<ProviderStatus, AIError> {
        // 通过 models 端点验证 API 连通性 + 模型是否存在（不消耗配额）
        let models = self.fetch_models_inner().await?;

        // 验证指定模型是否在列表中
        let model_exists = models
            .iter()
            .any(|m| m == &self.model || m.contains(&self.model));

        if !model_exists && !models.is_empty() {
            return Err(AIError::ModelNotFound(format!(
                "模型 '{}' 不在可用列表中。可用: {}",
                self.model,
                models[..models.len().min(10)].join(", ")
            )));
        }

        Ok(ProviderStatus {
            available: true,
            models,
        })
    }

    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            provider_type: ProviderType::Online,
            model_id: self.model.clone(),
            context_window: None,
        }
    }
}

// ============================================================================
// Public helper (not part of trait)
// ============================================================================

impl OpenAICompatibleProvider {
    /// 拉取可用模型列表（供前端下拉选择）
    pub async fn fetch_models(&self) -> Result<Vec<String>, AIError> {
        self.fetch_models_inner().await
    }

    /// 内部：请求 models 端点并解析
    async fn fetch_models_inner(&self) -> Result<Vec<String>, AIError> {
        let url = self.models_url();

        let response = self
            .auth_request(self.client.get(&url))
            .send()
            .await
            .map_err(|e| AIError::ConnectionFailed(format!("连接失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let error_msg = serde_json::from_str::<ApiErrorResponse>(&body)
                .ok()
                .and_then(|r| r.error)
                .and_then(|e| e.message)
                .unwrap_or(body);

            return match status.as_u16() {
                401 | 403 => Err(AIError::ProviderError(format!("认证失败: {}", error_msg))),
                _ => Err(AIError::ProviderError(format!(
                    "HTTP {}: {}",
                    status, error_msg
                ))),
            };
        }

        // 标准 OpenAI 格式: { data: [{ id: "model-name" }] }
        #[derive(Deserialize)]
        struct ModelsResponse {
            data: Option<Vec<ModelEntry>>,
        }

        // Gemini 格式: { models: [{ id: "models/gemini-2.0-flash" }] }
        #[derive(Deserialize)]
        struct GeminiModelsResponse {
            models: Option<Vec<GeminiModelEntry>>,
        }

        #[derive(Deserialize)]
        struct ModelEntry {
            id: String,
        }

        #[derive(Deserialize)]
        struct GeminiModelEntry {
            #[serde(alias = "id")]
            name: Option<String>,
        }

        let body_text = response.text().await.unwrap_or_default();

        // 先尝试标准 OpenAI 格式
        if let Ok(resp) = serde_json::from_str::<ModelsResponse>(&body_text) {
            if let Some(data) = resp.data {
                let models: Vec<String> = data.into_iter().map(|m| m.id).collect();
                if !models.is_empty() {
                    return Ok(models);
                }
            }
        }

        // 再尝试 Gemini 格式
        if let Ok(resp) = serde_json::from_str::<GeminiModelsResponse>(&body_text) {
            if let Some(data) = resp.models {
                let models: Vec<String> = data
                    .into_iter()
                    .filter_map(|m| m.name)
                    .map(|n| n.trim_start_matches("models/").to_string())
                    .collect();
                if !models.is_empty() {
                    return Ok(models);
                }
            }
        }

        // 无法解析时返回空列表
        Ok(vec![])
    }
}
