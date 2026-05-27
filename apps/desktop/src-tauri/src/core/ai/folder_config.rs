//! Folder-level AI configuration
//!
//! 支持通过 `.slash-folder.yml` 文件覆盖全局 AI Provider/Model 配置。
//! 笔记所在目录向上逐级查找，首个找到的文件的值 merge 到全局 AIConfig。

use crate::core::ai::keychain;
use crate::core::ai::service::AIConfig;
use serde::Deserialize;
use std::path::Path;

const CONFIG_FILENAME: &str = ".slash-folder.yml";

/// `.slash-folder.yml` 中 `ai:` 段的结构
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FolderAIConfig {
    /// "local" | "online" — 覆盖 completion provider
    pub provider: Option<String>,
    /// 覆盖 completion model name
    pub model: Option<String>,
    /// "local" | "online" — 覆盖 embedding provider（通常保持 local）
    pub embedding_provider: Option<String>,
}

/// `.slash-folder.yml` 顶层结构
#[derive(Debug, Clone, Default, Deserialize)]
struct SlashFolderYml {
    ai: Option<FolderAIConfig>,
}

/// 从 vault_path 开始，沿 note 的相对路径逐级向上查找 `.slash-folder.yml`，
/// 合并其 `ai` 段到全局 AIConfig。
///
/// 查找顺序（以 `Projects/rust/note.md` 为例）：
///   1. vault/Projects/rust/.slash-folder.yml
///   2. vault/Projects/.slash-folder.yml
///   3. vault/.slash-folder.yml
///   4. 全局 AIConfig（fallback）
pub fn resolve_config_for_path(
    vault_path: &Path,
    note_relative: &str,
    global: &AIConfig,
) -> AIConfig {
    let mut config = global.clone();

    // 从笔记所在目录逐级向上
    let note_path = Path::new(note_relative);
    let mut search_dir = note_path.parent(); // 去掉文件名

    while let Some(dir) = search_dir {
        let yml_path = vault_path.join(dir).join(CONFIG_FILENAME);

        if yml_path.exists() {
            match std::fs::read_to_string(&yml_path) {
                Ok(content) => {
                    match serde_yaml::from_str::<SlashFolderYml>(&content) {
                        Ok(parsed) => {
                            if let Some(ai) = parsed.ai {
                                apply_folder_override(&mut config, &ai);
                                log::debug!(
                                    "📂 [FolderConfig] Applied override from {:?}: provider={:?}, model={:?}",
                                    yml_path, ai.provider, ai.model
                                );
                                // 首个找到的文件生效，停止向上搜索
                                break;
                            }
                        }
                        Err(e) => {
                            log::warn!("⚠️ [FolderConfig] Failed to parse {:?}: {}", yml_path, e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("⚠️ [FolderConfig] Failed to read {:?}: {}", yml_path, e);
                }
            }
        }

        // 向上一级
        search_dir = dir.parent();
    }

    // 也检查 vault 根目录
    let root_yml = vault_path.join(CONFIG_FILENAME);
    if search_dir.is_none() && root_yml.exists() {
        if let Ok(content) = std::fs::read_to_string(&root_yml) {
            if let Ok(parsed) = serde_yaml::from_str::<SlashFolderYml>(&content) {
                if let Some(ai) = parsed.ai {
                    apply_folder_override(&mut config, &ai);
                    log::debug!(
                        "📂 [FolderConfig] Applied root override: provider={:?}, model={:?}",
                        ai.provider, ai.model
                    );
                }
            }
        }
    }

    // 如果 provider 改成 online，确保 api_key 从 Keychain 加载
    if config.provider_type == "online" && config.online_api_key.is_empty() {
        if !config.online_base_url.is_empty() {
            let provider_id =
                crate::commands::ai::provider_config::infer_provider_id(&config.online_base_url);
            if let Ok(Some(key)) = keychain::load_api_key_for(&provider_id) {
                config.online_api_key = key;
                log::debug!(
                    "🔐 [FolderConfig] Loaded API key for provider: {}",
                    provider_id
                );
            }
        } else {
            // Fallback for extreme legacy edge case
            if let Ok(Some(key)) = keychain::load_api_key() {
                config.online_api_key = key;
            }
        }
    }

    config
}

/// 将文件夹级配置的非 None 字段覆盖到 AIConfig
fn apply_folder_override(config: &mut AIConfig, folder: &FolderAIConfig) {
    if let Some(ref provider) = folder.provider {
        config.provider_type = provider.clone();
    }
    if let Some(ref model) = folder.model {
        // 根据 provider_type 设置对应的 model 字段
        if config.provider_type == "online" {
            config.online_model = model.clone();
        } else {
            config.generation_model = model.clone();
        }
    }
    // embedding_provider 暂不实现运行时切换（始终 local），仅记录
    if let Some(ref _ep) = folder.embedding_provider {
        // Future: switch embedding provider
    }
}
