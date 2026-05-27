//! Dynamic Skill — 用户自定义 AI Skill（从 YAML 加载）
//!
//! 用户在 `vault/.slash/skills/*.yml` 中定义 system prompt 和参数，
//! 运行时加载为 DynamicSkill 实例，通过 `execute_skill()` 执行。

use super::{Skill, TriggerType};
use anyhow::Result;
use serde::Deserialize;
use std::path::Path;

// ============================================================================
// 应用语法上下文 — 自动注入到每个 DynamicSkill 的 system prompt 末尾
// ============================================================================

const APP_SYNTAX_CONTEXT: &str = r#"

## Output Formatting Rules (Application Syntax)
You are an AI assistant integrated into the "Slash" note-taking application. Your output will be directly inserted into a Markdown editor. You MUST strictly follow these syntax rules to ensure the editor renders your output correctly:
- **Internal Links (WikiLinks)**: Use [[Note Name]] or [[Note Name|Display Text]].
- **Basic Formatting**: Use `**bold**`, `*italic*`, `~~strikethrough~~`, `==highlight==`. 
- **Inline Code & Math**: Use `` `code` `` for inline code, and `$latex$` for inline math formulas (do not use \( \) or \[ \]).
- **Code Blocks**: Use triple backticks with the language name (e.g., ```rust ... ```).
- **Mermaid Diagrams**: Use ```mermaid ... ``` for any flowcharts, sequence diagrams, or graphs.
- **Lists & Tasks**: Use `- `, `1. ` for lists. Use `- [ ] ` for todo items and `- [x] ` for completed items.
- **Blockquotes**: Use `> ` for quotes.
- **Tables**: Use standard Markdown tables with header separators `|---|---|`. Do not omit the header or the separator row.
- **Tags**: Use `[tag1, tag2]` in YAML frontmatter or as `#tag` in text if necessary.
- **CRITICAL**: Do NOT use raw HTML tags (like <b>, <i>, <ul>, etc.) under any circumstances. Always use pure Markdown according to the rules above.
"#;

// ============================================================================
// YAML Configuration
// ============================================================================

/// YAML 文件反序列化结构
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct DynamicSkillConfig {
    /// 技能唯一标识（同时也是文件名，如 "translate_en"）
    pub id: String,
    /// 显示名称（如 "翻译为英文"）
    pub name: String,
    /// 描述（可选）
    pub description: Option<String>,
    /// 系统提示词 — 定义 AI 行为
    pub system_prompt: String,
    /// 最大输出 token 数（默认 512）
    pub max_output_tokens: Option<u32>,
    /// 采样温度（默认 0.0）
    pub temperature: Option<f32>,
    /// 输入模式："selection"（默认）| "full_note"
    pub input_mode: Option<String>,
}

impl DynamicSkillConfig {
    /// 从 YAML 文件加载
    pub fn from_file(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Failed to read skill file {:?}: {}", path, e))?;
        let config: DynamicSkillConfig = serde_yaml::from_str(&content)
            .map_err(|e| anyhow::anyhow!("Failed to parse skill YAML {:?}: {}", path, e))?;
        Ok(config)
    }

    /// 是否为全文模式
    #[allow(dead_code)]
    pub fn is_full_note(&self) -> bool {
        self.input_mode
            .as_deref()
            .map(|m| m == "full_note")
            .unwrap_or(false)
    }
}

// ============================================================================
// DynamicSkill — implements Skill trait
// ============================================================================

/// 运行时 Skill — 从 YAML 配置动态构建
pub struct DynamicSkill {
    config: DynamicSkillConfig,
}

impl DynamicSkill {
    pub fn new(config: DynamicSkillConfig) -> Self {
        Self { config }
    }

    #[allow(dead_code)]
    pub fn config(&self) -> &DynamicSkillConfig {
        &self.config
    }
}

impl Skill for DynamicSkill {
    type Output = String;

    fn id(&self) -> &'static str {
        // Leak the string to get a 'static lifetime — acceptable since
        // DynamicSkills are short-lived (created per-execution)
        Box::leak(self.config.id.clone().into_boxed_str())
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        vec![TriggerType::OnButton]
    }

    fn system_prompt(&self) -> String {
        format!("{}\n{}", self.config.system_prompt, APP_SYNTAX_CONTEXT)
    }

    fn user_prompt(&self, content: &str) -> String {
        content.to_string()
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        Ok(raw_response.trim().to_string())
    }

    fn max_output_tokens(&self) -> u32 {
        self.config.max_output_tokens.unwrap_or(512)
    }

    fn temperature(&self) -> f32 {
        self.config.temperature.unwrap_or(0.0)
    }
}

// ============================================================================
// Skill Directory Scanner
// ============================================================================

/// 扫描 vault/.slash/skills/ 目录，返回所有有效的 Skill 配置
pub fn scan_skills_dir(vault_path: &Path) -> Vec<DynamicSkillConfig> {
    let skills_dir = vault_path.join(".slash").join("skills");
    if !skills_dir.exists() {
        return Vec::new();
    }

    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("yml") {
                match DynamicSkillConfig::from_file(&path) {
                    Ok(config) => {
                        log::debug!("📦 [DynamicSkill] Loaded: {} ({})", config.name, config.id);
                        skills.push(config);
                    }
                    Err(e) => {
                        log::warn!("⚠️ [DynamicSkill] Failed to load {:?}: {}", path, e);
                    }
                }
            }
        }
    }

    // 按 id 排序，保证顺序稳定
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    skills
}
