//! AI Provider Config Commands
//!
//! Tauri 命令：获取/设置 AI provider 配置 + 拉取可用模型列表。

use crate::core::ai::keychain;
use crate::core::ai::provider::openai_compatible::OpenAICompatibleProvider;

use crate::{AIStateWrapper, DbStateWrapper};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 前端传输用的 Provider 配置（local + online 字段）
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub provider_type: String,
    // Local (Ollama) fields
    #[serde(default = "default_ollama_host")]
    pub ollama_host: String,
    #[serde(default = "default_ollama_port")]
    pub ollama_port: u16,
    #[serde(default = "default_generation_model")]
    pub generation_model: String,
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
    // Online fields
    pub online_api_key: String,
    pub online_base_url: String,
    pub online_model: String,
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("provider_type", &self.provider_type)
            .field("ollama_host", &self.ollama_host)
            .field("ollama_port", &self.ollama_port)
            .field("generation_model", &self.generation_model)
            .field("embedding_model", &self.embedding_model)
            .field(
                "online_api_key",
                if self.online_api_key.is_empty() {
                    &""
                } else {
                    &"••••••••"
                },
            )
            .field("online_base_url", &self.online_base_url)
            .field("online_model", &self.online_model)
            .finish()
    }
}

fn default_ollama_host() -> String {
    "http://localhost".to_string()
}
fn default_ollama_port() -> u16 {
    11434
}
fn default_generation_model() -> String {
    "".to_string()
}
fn default_embedding_model() -> String {
    "bge-m3".to_string()
}

/// 获取当前 AI provider 配置
#[tauri::command]
pub fn get_ai_provider_config(ai: State<AIStateWrapper>) -> ProviderConfig {
    let service = ai.service();
    let cfg = service.config();
    ProviderConfig {
        provider_type: cfg.provider_type.clone(),
        ollama_host: cfg.ollama_host.clone(),
        ollama_port: cfg.ollama_port,
        generation_model: cfg.generation_model.clone(),
        embedding_model: cfg.embedding_model.clone(),
        online_api_key: cfg.online_api_key.clone(),
        online_base_url: cfg.online_base_url.clone(),
        online_model: cfg.online_model.clone(),
    }
}

/// 设置 AI provider 配置并重建 AIService
#[tauri::command]
pub fn set_ai_provider_config(
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
    config: ProviderConfig,
) -> Result<(), String> {
    // 读取当前完整配置并合并
    let mut full_config = ai.service().config().clone();
    full_config.provider_type = config.provider_type;
    full_config.ollama_host = config.ollama_host;
    full_config.ollama_port = config.ollama_port;
    full_config.generation_model = config.generation_model;
    full_config.embedding_model = config.embedding_model;

    // 仅在明确传来非空参数或类型确实是在线时才更新 Online 字段
    if full_config.provider_type == "online" && !config.online_base_url.is_empty() {
        full_config.online_base_url = config.online_base_url;
        full_config.online_model = config.online_model;
        if !config.online_api_key.is_empty() {
            keychain::store_api_key(&config.online_api_key)?;
            full_config.online_api_key = config.online_api_key;
        }
    }

    // 持久化到数据库（online_api_key 被 skip_serializing 自动排除）
    let json = serde_json::to_string(&full_config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    db.0.with_connection(|conn| {
        conn.execute(
            "INSERT INTO ai_settings (key, value) VALUES ('provider_config', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![json],
        )?;
        Ok(())
    })?;

    // 重建 AIService（运行时切换 Provider）
    let mut service = ai.service_mut();
    service.rebuild(full_config);

    Ok(())
}

/// 从数据库 + Keychain 恢复已保存的 AI Provider 配置（应用重启后调用）
#[tauri::command]
pub fn restore_ai_config(
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
) -> Result<(), String> {
    let json_opt: Option<String> = db.0.with_connection(|conn| {
        let mut stmt = conn
            .prepare("SELECT value FROM ai_settings WHERE key = 'provider_config'")
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let result = stmt.query_row([], |row| row.get::<_, String>(0)).ok(); // None if no row
        Ok(result)
    })?;

    if let Some(json) = json_opt {
        let mut config: crate::core::ai::service::AIConfig = serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse saved config: {}", e))?;

        // 迁移兼容：检测旧 JSON 中是否有明文 API Key
        let legacy_key = serde_json::from_str::<serde_json::Value>(&json)
            .ok()
            .and_then(|v| v.get("online_api_key")?.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty());

        if let Some(ref key) = legacy_key {
            log::debug!("🔐 [AI] Migrating API key from plaintext JSON to Keychain");
            keychain::store_api_key(key)?;
            config.online_api_key = key.clone();

            let clean_json = serde_json::to_string(&config)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;
            db.0.with_connection(|conn| {
                conn.execute(
                    "UPDATE ai_settings SET value = ?1 WHERE key = 'provider_config'",
                    rusqlite::params![clean_json],
                )?;
                Ok(())
            })?;
            log::debug!("✅ [AI] API key migrated to Keychain, cleared from database");
        } else {
            match keychain::load_api_key() {
                Ok(Some(key)) => {
                    config.online_api_key = key;
                }
                Ok(None) => {
                    log::debug!("⚠️ [AI] No global API key found in Keychain (Legacy fallback)");
                }
                Err(e) => {
                    log::warn!("⚠️ [AI] Failed to load global API key from Keychain: {}", e);
                }
            }
        }

        // ── 迁移到 online_providers ──
        let providers = load_online_providers_raw(&db)?;
        if providers.is_empty() && !config.online_base_url.is_empty() {
            // 旧的单配置迁移为 online_providers 的第一条记录
            let provider_id = infer_provider_id(&config.online_base_url);
            let entry = OnlineProviderEntry {
                id: provider_id.clone(),
                label: provider_id.clone(),
                base_url: config.online_base_url.clone(),
                model: config.online_model.clone(),
                active: true,
            };
            // 将旧的全局 API Key 迁移到 per-provider 存储
            if !config.online_api_key.is_empty() {
                let _ = keychain::store_api_key_for(&provider_id, &config.online_api_key);
            }
            save_online_providers_raw(&db, &[entry])?;
            log::debug!(
                "✅ [AI] Migrated legacy online config to online_providers: id={}",
                provider_id
            );
        }

        // ── 从 active provider 加载 online 配置 ──
        let providers = load_online_providers_raw(&db)?;
        if let Some(active) = providers.iter().find(|p| p.active) {
            config.online_base_url = active.base_url.clone();
            config.online_model = active.model.clone();
            if let Ok(Some(key)) = keychain::load_api_key_for(&active.id) {
                config.online_api_key = key;
            }
            log::debug!(
                "✅ [AI] Loaded active online provider: id={}, model={}",
                active.id, active.model
            );
        }

        let mut service = ai.service_mut();
        service.rebuild(config);
        log::debug!("✅ [AI] Restored provider config from database + Keychain");
    }

    Ok(())
}

/// 根据 base_url 推断 Provider ID
pub fn infer_provider_id(base_url: &str) -> String {
    if base_url.contains("dashscope.aliyuncs.com") {
        "qwen".to_string()
    } else if base_url.contains("generativelanguage.googleapis.com") {
        "gemini".to_string()
    } else if base_url.contains("api.deepseek.com") {
        "deepseek".to_string()
    } else if base_url.contains("api.openai.com") {
        "openai".to_string()
    } else if base_url.contains("api.moonshot.cn") {
        "moonshot".to_string()
    } else if base_url.contains("api.groq.com") {
        "groq".to_string()
    } else {
        // 自定义 Provider：用 base_url hash 作为 ID
        format!("custom_{:x}", base_url.len())
    }
}

/// 获取指定文件夹路径的有效 AI 配置（含 .slash-folder.yml 覆盖）
#[tauri::command]
pub fn get_folder_ai_config(
    folder_path: String,
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
) -> Result<ProviderConfig, String> {
    use crate::core::ai::folder_config;

    let vault_path =
        db.0.vault_path
            .lock()
            .unwrap()
            .clone()
            .ok_or("Vault path not set")?;

    let relative = std::path::Path::new(&folder_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(folder_path);

    // 用 "dir/placeholder.md" 触发从该目录开始的查找
    let fake_note = format!("{}/placeholder.md", relative);

    let global = ai.service().config().clone();
    let resolved = folder_config::resolve_config_for_path(
        std::path::Path::new(&vault_path),
        &fake_note,
        &global,
    );

    Ok(ProviderConfig {
        provider_type: resolved.provider_type,
        ollama_host: resolved.ollama_host,
        ollama_port: resolved.ollama_port,
        generation_model: resolved.generation_model,
        embedding_model: resolved.embedding_model,
        online_api_key: resolved.online_api_key, // 将其传递给前端，用于 Sidecar
        online_base_url: resolved.online_base_url,
        online_model: resolved.online_model,
    })
}

/// 拉取在线 Provider 的可用模型列表（不需要先保存配置）
#[tauri::command]
pub async fn fetch_online_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let provider = OpenAICompatibleProvider::new(base_url, api_key, String::new());
    provider.fetch_models().await.map_err(|e| e.to_string())
}

/// 拉取已保存 Provider 的可用模型列表（使用 Keychain 中的 API Key）
#[tauri::command]
pub async fn fetch_saved_provider_models(
    db: State<'_, DbStateWrapper>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    // 1. 从 DB 读取 provider 配置获取 base_url
    let providers = load_online_providers_raw(&db)?;
    let entry = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;
    let base_url = entry.base_url.clone();

    // 2. 从 Keychain 读取 API Key
    let api_key = keychain::load_api_key_for(&provider_id)?
        .ok_or_else(|| format!("No API key found for provider '{}'", provider_id))?;

    // 3. 拉取模型列表
    let provider = OpenAICompatibleProvider::new(base_url, api_key, String::new());
    provider.fetch_models().await.map_err(|e| e.to_string())
}

/// 保存文件夹级 AI 配置到 .slash-folder.yml
/// provider / model 均为 None 时删除配置文件（恢复全局）
#[tauri::command]
pub fn save_folder_ai_config(
    folder_path: String,
    provider: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let yml_path = std::path::Path::new(&folder_path).join(".slash-folder.yml");

    // 全部为 None → 删除配置文件
    if provider.is_none() && model.is_none() {
        if yml_path.exists() {
            std::fs::remove_file(&yml_path).map_err(|e| format!("删除配置文件失败: {}", e))?;
            log::debug!("📂 [FolderConfig] Removed {:?}", yml_path);
        }
        return Ok(());
    }

    // 构建 YAML 内容
    let mut ai_section = String::from("ai:\n");
    if let Some(ref p) = provider {
        ai_section.push_str(&format!("  provider: {}\n", p));
    }
    if let Some(ref m) = model {
        ai_section.push_str(&format!("  model: {}\n", m));
    }

    std::fs::write(&yml_path, &ai_section).map_err(|e| format!("写入配置文件失败: {}", e))?;

    log::debug!(
        "📂 [FolderConfig] Saved {:?}: provider={:?}, model={:?}",
        yml_path, provider, model
    );

    Ok(())
}

// ============================================================================
// Multi-Provider Online Config (CRUD)
// ============================================================================

/// 持久化的 Online Provider 条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineProviderEntry {
    /// Provider preset ID (e.g., "qwen", "gemini", "deepseek", "custom_xxx")
    pub id: String,
    /// Display label (e.g., "通义千问 (Qwen)")
    pub label: String,
    /// API Base URL
    pub base_url: String,
    /// Model name
    pub model: String,
    /// Whether this provider is the active one for online mode
    pub active: bool,
}

/// 前端视图：不含 API Key，但增加 has_key 标识
#[derive(Debug, Clone, Serialize)]
pub struct OnlineProviderView {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
    pub active: bool,
    pub has_key: bool,
}

/// 读取 online_providers JSON 列表（内部）
fn load_online_providers_raw(db: &DbStateWrapper) -> Result<Vec<OnlineProviderEntry>, String> {
    let json_opt: Option<String> = db.0.with_connection(|conn| {
        let result = conn
            .query_row(
                "SELECT value FROM ai_settings WHERE key = 'online_providers'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(result)
    })?;

    match json_opt {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse online_providers: {}", e)),
        None => Ok(vec![]),
    }
}

/// 保存 online_providers JSON 列表（内部）
fn save_online_providers_raw(
    db: &DbStateWrapper,
    providers: &[OnlineProviderEntry],
) -> Result<(), String> {
    let json = serde_json::to_string(providers)
        .map_err(|e| format!("Failed to serialize online_providers: {}", e))?;

    db.0.with_connection(|conn| {
        conn.execute(
            "INSERT INTO ai_settings (key, value) VALUES ('online_providers', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![json],
        )?;
        Ok(())
    })
}

/// 获取已保存的 Online Provider 列表（不含 API Key）
#[tauri::command]
pub fn get_online_providers(db: State<DbStateWrapper>) -> Result<Vec<OnlineProviderView>, String> {
    let providers = load_online_providers_raw(&db)?;
    let views = providers
        .into_iter()
        .map(|p| {
            let has_key = keychain::load_api_key_for(&p.id)
                .ok()
                .flatten()
                .map(|k| !k.is_empty())
                .unwrap_or(false);
            OnlineProviderView {
                id: p.id,
                label: p.label,
                base_url: p.base_url,
                model: p.model,
                active: p.active,
                has_key,
            }
        })
        .collect();
    Ok(views)
}

/// 保存一个 Online Provider 配置（upsert by id）
/// 设置页的“保存并测试”语义是启用当前服务商，因此保存后总是设为 active。
#[tauri::command]
pub fn save_online_provider(
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
    id: String,
    label: String,
    base_url: String,
    model: String,
    api_key: String,
) -> Result<(), String> {
    // Store API Key in Keychain — only if non-empty (don't overwrite existing key with empty)
    if !api_key.is_empty() {
        keychain::store_api_key_for(&id, &api_key)?;
    }

    let mut providers = load_online_providers_raw(&db)?;

    if let Some(existing) = providers.iter_mut().find(|p| p.id == id) {
        existing.label = label;
        existing.base_url = base_url;
        existing.model = model;
    } else {
        providers.push(OnlineProviderEntry {
            id: id.clone(),
            label,
            base_url,
            model,
            active: false,
        });
    }

    // Saving from Settings is an explicit selection of the current provider.
    for p in providers.iter_mut() {
        p.active = p.id == id;
    }

    save_online_providers_raw(&db, &providers)?;
    apply_active_provider_to_service(&db, &ai, &providers, &id)?;

    log::debug!("✅ [OnlineProviders] Saved and activated provider '{}'", id);
    Ok(())
}

/// 将指定 Provider 设为 active，其他全部 deactivate，并 rebuild AIService
#[tauri::command]
pub fn activate_online_provider(
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
    id: String,
) -> Result<(), String> {
    let mut providers = load_online_providers_raw(&db)?;

    if !providers.iter().any(|p| p.id == id) {
        return Err(format!("Provider '{}' not found", id));
    }

    for p in providers.iter_mut() {
        p.active = p.id == id;
    }

    save_online_providers_raw(&db, &providers)?;
    apply_active_provider_to_service(&db, &ai, &providers, &id)?;

    log::debug!("✅ [OnlineProviders] Activated provider '{}'", id);
    Ok(())
}

/// 删除一个 Online Provider 配置
#[tauri::command]
pub fn delete_online_provider(
    db: State<DbStateWrapper>,
    ai: State<AIStateWrapper>,
    id: String,
) -> Result<(), String> {
    let mut providers = load_online_providers_raw(&db)?;
    let was_active = providers.iter().any(|p| p.id == id && p.active);

    providers.retain(|p| p.id != id);

    // If deleted was active, activate the first remaining
    if was_active {
        if let Some(first) = providers.first_mut() {
            first.active = true;
        }
    }

    // Delete API Key from Keychain
    let _ = keychain::delete_api_key_for(&id);

    save_online_providers_raw(&db, &providers)?;

    // If we changed active, rebuild with new active or fall back to local
    if was_active {
        if let Some(new_active) = providers.iter().find(|p| p.active) {
            apply_active_provider_to_service(&db, &ai, &providers, &new_active.id.clone())?;
        } else {
            // Last provider deleted → reset to local mode and clear stale online fields
            let mut service = ai.service_mut();
            let mut config = service.config().clone();
            config.provider_type = "local".to_string();
            config.online_base_url = String::new();
            config.online_model = String::new();
            config.online_api_key = String::new();
            service.rebuild(config.clone());

            // Persist so restore_ai_config won't re-create the deleted provider
            if let Ok(json) = serde_json::to_string(&config) {
                let _ = db.0.with_connection(|conn| {
                    conn.execute(
                        "INSERT INTO ai_settings (key, value) VALUES ('provider_config', ?1) \
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![json],
                    )?;
                    Ok(())
                });
            }
            log::debug!("🔄 [OnlineProviders] Last provider deleted, reset to local mode");
        }
    }

    log::debug!("✅ [OnlineProviders] Deleted provider '{}'", id);
    Ok(())
}

/// 内部：将 active provider 的配置加载到 AIService
fn apply_active_provider_to_service(
    db: &DbStateWrapper,
    ai: &AIStateWrapper,
    providers: &[OnlineProviderEntry],
    active_id: &str,
) -> Result<(), String> {
    let entry = providers
        .iter()
        .find(|p| p.id == active_id)
        .ok_or_else(|| format!("Active provider '{}' not found", active_id))?;

    let api_key = keychain::load_api_key_for(active_id)?.unwrap_or_default();

    // Update the online fields in AIConfig and auto-switch to online mode
    let mut service = ai.service_mut();
    let mut config = service.config().clone();
    config.online_base_url = entry.base_url.clone();
    config.online_model = entry.model.clone();
    config.online_api_key = api_key;
    config.provider_type = "online".to_string();
    service.rebuild(config.clone());

    // Persist provider_type change to DB so it survives restart
    if let Ok(json) = serde_json::to_string(&config) {
        let _ = db.0.with_connection(|conn| {
            conn.execute(
                "INSERT INTO ai_settings (key, value) VALUES ('provider_config', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![json],
            )?;
            Ok(())
        });
    }

    log::debug!(
        "🔄 [OnlineProviders] AIService online config updated: base_url={}, model={}, provider_type=online",
        entry.base_url, entry.model
    );
    Ok(())
}

/// 检测指定 Ollama 模型是否已拉取（独立于全局配置）
#[derive(Debug, Serialize)]
pub struct OllamaModelCheck {
    pub available: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_ollama_model(
    host: String,
    port: u16,
    model_name: String,
) -> Result<OllamaModelCheck, String> {
    let client = ollama_rs::Ollama::new(host, port);

    let models = match tokio::time::timeout(
        std::time::Duration::from_millis(5000),
        client.list_local_models()
    ).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => {
            return Ok(OllamaModelCheck {
                available: false,
                error: Some(format!("无法连接 Ollama: {}", e)),
            });
        }
        Err(_) => {
            return Ok(OllamaModelCheck {
                available: false,
                error: Some("连接 Ollama 超时，请检查服务是否已启动".to_string()),
            });
        }
    };

    let available = models
        .iter()
        .any(|m| m.name == model_name || m.name == format!("{}:latest", model_name) || m.name.contains(&model_name));

    Ok(OllamaModelCheck {
        available,
        error: if available {
            None
        } else {
            Some(format!("模型 {} 未找到", model_name))
        },
    })
}

/// 列出 Ollama 本地已下载的模型
#[tauri::command]
pub async fn list_ollama_models(host: String, port: u16) -> Result<Vec<String>, String> {
    let client = ollama_rs::Ollama::new(host, port);

    let models = match tokio::time::timeout(
        std::time::Duration::from_millis(5000),
        client.list_local_models()
    ).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err(format!("无法连接 Ollama: {}", e)),
        Err(_) => return Err("连接 Ollama 超时，请检查服务是否已启动".to_string()),
    };

    Ok(models.into_iter().map(|m| m.name).collect())
}

/// 拉取（下载）Ollama 模型，通过事件推送进度
#[derive(Debug, Clone, Serialize)]
pub struct PullProgress {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn pull_ollama_model(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    model_name: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio_stream::StreamExt;

    let client = ollama_rs::Ollama::new(host.clone(), port);

    log::info!("📥 [Ollama] Starting model pull for '{}' from {}:{}", model_name, host, port);

    let mut stream = client
        .pull_model_stream(model_name.clone(), false)
        .await
        .map_err(|e| {
            let err_msg = format!("Pull 请求失败: {}", e);
            log::error!("❌ [Ollama] Failed to start pull stream for '{}': {}", model_name, err_msg);
            err_msg
        })?;

    while let Some(result) = stream.next().await {
        match result {
            Ok(status) => {
                let message = status.message.clone();
                let completed = status.completed.unwrap_or(0);
                let total = status.total.unwrap_or(0);

                let _ = app.emit(
                    "ollama:pull-progress",
                    PullProgress {
                        model: model_name.clone(),
                        status: message,
                        completed,
                        total,
                        done: false,
                        error: None,
                    },
                );
            }
            Err(e) => {
                log::error!("❌ [Ollama] Error during pull for '{}': {}", model_name, e);
                let _ = app.emit(
                    "ollama:pull-progress",
                    PullProgress {
                        model: model_name.clone(),
                        status: "error".to_string(),
                        completed: 0,
                        total: 0,
                        done: true,
                        error: Some(format!("{}", e)),
                    },
                );
                return Err(format!("Pull 失败: {}", e));
            }
        }
    }

    log::info!("✅ [Ollama] Model '{}' pulled successfully", model_name);

    // 发送完成事件
    let _ = app.emit(
        "ollama:pull-progress",
        PullProgress {
            model: model_name,
            status: "success".to_string(),
            completed: 0,
            total: 0,
            done: true,
            error: None,
        },
    );

    Ok(())
}
