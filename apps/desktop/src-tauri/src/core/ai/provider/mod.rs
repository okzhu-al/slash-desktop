//! AI Provider Abstraction Layer
//!
//! Defines the `CompletionProvider` and `EmbeddingProvider` traits for
//! decoupling AI service logic from specific backends (Ollama, OpenAI, etc).

pub mod ollama;
pub mod openai_compatible;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;

// ============================================================================
// Error Types
// ============================================================================

/// Unified AI error type
#[derive(Debug, Clone)]
pub enum AIError {
    /// Cannot connect to the provider backend
    ConnectionFailed(String),
    /// Requested model is not available
    ModelNotFound(String),
    /// Rate limit exceeded (online providers)
    RateLimited { retry_after_ms: Option<u64> },
    /// Provider returned an error response
    ProviderError(String),
    /// Response could not be parsed
    ParseError(String),
    /// Any other error
    Other(String),
}

impl fmt::Display for AIError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AIError::ConnectionFailed(msg) => write!(f, "Connection failed: {}", msg),
            AIError::ModelNotFound(model) => write!(f, "Model not found: {}", model),
            AIError::RateLimited { retry_after_ms } => {
                if let Some(ms) = retry_after_ms {
                    write!(f, "Rate limited, retry after {}ms", ms)
                } else {
                    write!(f, "Rate limited")
                }
            }
            AIError::ProviderError(msg) => write!(f, "Provider error: {}", msg),
            AIError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            AIError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AIError {}

impl AIError {
    /// 分类错误类型，用于 ai_usage_log.error_type
    pub fn error_type(&self) -> &'static str {
        match self {
            AIError::ConnectionFailed(_) => "timeout",
            AIError::ModelNotFound(_) => "model_not_found",
            AIError::RateLimited { .. } => "rate_limit",
            AIError::ProviderError(_) => "provider_error",
            AIError::ParseError(_) => "parse_error",
            AIError::Other(_) => "unknown",
        }
    }

    /// 是否可以重试
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            AIError::ConnectionFailed(_) | AIError::RateLimited { .. }
        )
    }
}

impl From<AIError> for String {
    fn from(e: AIError) -> Self {
        e.to_string()
    }
}

// ============================================================================
// Request / Response Types
// ============================================================================

/// Provider-agnostic completion request
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub prompt: String,
    /// Optional system prompt — used by OpenAI-compatible providers to send
    /// as a separate `system` role message. If None, OpenAI provider will
    /// send everything as a single `user` message (backward compatible).
    pub system_prompt: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub top_p: f32,
}

impl CompletionRequest {
    pub fn new(prompt: String, model: String) -> Self {
        Self {
            prompt,
            system_prompt: None,
            model,
            temperature: 0.0,
            max_tokens: 32768,
            top_p: 1.0,
        }
    }
}

/// Provider-agnostic completion response
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct CompletionResponse {
    pub text: String,
    pub model: String,
    pub usage: Option<TokenUsage>,
}

/// Token usage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Provider metadata
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub provider_type: ProviderType,
    pub model_id: String,
    pub context_window: Option<u32>,
}

/// Provider type enum
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ProviderType {
    Local,  // Ollama
    Online, // OpenAI-Compatible
}

/// Provider availability status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub available: bool,
    pub models: Vec<String>,
}

// ============================================================================
// Provider Traits
// ============================================================================

/// Completion provider — generates text from prompts
#[async_trait]
pub trait CompletionProvider: Send + Sync {
    /// Execute a completion request
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionResponse, AIError>;

    /// Execute a streaming completion request.
    /// Sends text chunks as they arrive via the provided `tx` sender.
    /// Default implementation falls back to `complete()` and sends the full text at once.
    async fn complete_stream(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<Result<String, AIError>>,
    ) -> Result<(), AIError> {
        // Fallback: call non-streaming and send the full result
        match self.complete(request).await {
            Ok(response) => {
                let _ = tx.send(Ok(response.text)).await;
                Ok(())
            }
            Err(e) => {
                let _ = tx.send(Err(AIError::Other(e.to_string()))).await;
                Err(e)
            }
        }
    }

    /// Check if the provider is available and list models
    async fn check_availability(&self) -> Result<ProviderStatus, AIError>;

    /// Get provider metadata
    #[allow(dead_code)]
    fn info(&self) -> ProviderInfo;
}

/// Embedding provider — generates vector representations of text
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    /// Generate embeddings for one or more texts
    async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, AIError>;

    /// Vector dimensions for this model
    #[allow(dead_code)]
    fn dimensions(&self) -> usize;

    /// Model identifier
    #[allow(dead_code)]
    fn model_id(&self) -> &str;
}
