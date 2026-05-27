//! Custom Skills Commands
//!
//! Tauri 命令：管理和执行用户自定义 AI Skill（YAML 定义）。

use crate::core::ai::skills::dynamic_skill::{scan_skills_dir, DynamicSkill, DynamicSkillConfig};
use crate::state::{AIStateWrapper, DbStateWrapper};
use std::path::Path;
use tauri::State;

// ============================================================================
// List / Load / Save / Delete
// ============================================================================

/// 列出所有自定义 Skill 的元信息
#[tauri::command]
pub fn list_custom_skills(
    db_state: State<DbStateWrapper>,
) -> Result<Vec<DynamicSkillConfig>, String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault connected")?;
    let skills = scan_skills_dir(Path::new(&vault_path));
    Ok(skills)
}

/// 读取单个 Skill 的 YAML 原始内容（用于编辑器）
#[tauri::command]
pub fn load_custom_skill_yaml(
    skill_id: String,
    db_state: State<DbStateWrapper>,
) -> Result<String, String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault connected")?;
    let skill_path = Path::new(&vault_path)
        .join(".slash")
        .join("skills")
        .join(format!("{}.yml", skill_id));

    std::fs::read_to_string(&skill_path).map_err(|e| format!("Failed to read skill file: {}", e))
}

/// 保存/创建 Skill YAML 文件
#[tauri::command]
pub fn save_custom_skill(
    skill_id: String,
    yaml_content: String,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    // 先验证 YAML 格式
    serde_yaml::from_str::<DynamicSkillConfig>(&yaml_content)
        .map_err(|e| format!("Invalid YAML format: {}", e))?;

    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault connected")?;

    let skills_dir = Path::new(&vault_path).join(".slash").join("skills");
    // 确保目录存在
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Failed to create skills directory: {}", e))?;

    let skill_path = skills_dir.join(format!("{}.yml", skill_id));
    std::fs::write(&skill_path, &yaml_content)
        .map_err(|e| format!("Failed to write skill file: {}", e))?;

    log::debug!("💾 [CustomSkill] Saved: {}", skill_id);
    Ok(())
}

/// 删除 Skill YAML 文件
#[tauri::command]
pub fn delete_custom_skill(
    skill_id: String,
    db_state: State<DbStateWrapper>,
) -> Result<(), String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault connected")?;

    let skill_path = Path::new(&vault_path)
        .join(".slash")
        .join("skills")
        .join(format!("{}.yml", skill_id));

    if skill_path.exists() {
        std::fs::remove_file(&skill_path)
            .map_err(|e| format!("Failed to delete skill file: {}", e))?;
        log::debug!("🗑️ [CustomSkill] Deleted: {}", skill_id);
    }
    Ok(())
}

// ============================================================================
// Execute
// ============================================================================

/// 执行自定义 Skill（流式 — 逐 chunk 通过事件推送到前端）
#[tauri::command]
pub fn execute_custom_skill(
    skill_id: String,
    content: String,
    note_path: String,
    db_state: State<DbStateWrapper>,
    ai_state: State<AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("No vault connected")?;

    // 加载 Skill 配置
    let skill_path = Path::new(&vault_path)
        .join(".slash")
        .join("skills")
        .join(format!("{}.yml", skill_id));
    let config = DynamicSkillConfig::from_file(&skill_path)
        .map_err(|e| format!("Failed to load skill: {}", e))?;

    let skill_name = config.name.clone();
    let skill = DynamicSkill::new(config);

    // 异步流式执行
    let vault_path_str = vault_path.clone();
    
    log::debug!(
        "🔧 [CustomSkill] Resolving config for note: '{}' in vault: '{}'",
        note_path, vault_path_str.display()
    );

    let service = ai_state.resolve_for_path(Path::new(&vault_path_str), &note_path);
    
    log::debug!(
        "🔧 [CustomSkill] Resolved provider: {}, model: {}",
        service.config().provider_type,
        service.completion_model()
    );

    let runtime = ai_state.runtime.clone();
    let app = app_handle.clone();

    std::thread::spawn(move || {
        runtime.block_on(async move {
            use tauri::Emitter;

            // 1. 检查大模型服务可用性，防止服务不可达或模型未下载时无限卡死
            match service.check_connection().await {
                Ok(status) => {
                    if !status.generation_model_available {
                        let err_msg = format!(
                            "本地 AI 模型 '{}' 未下载或不可用，请先前往设置下载。",
                            service.completion_model()
                        );
                        log::warn!("⚠️ [CustomSkill] {}", err_msg);
                        let _ = app.emit(
                            "custom-skill:completed",
                            serde_json::json!({
                                "skill_id": skill_id,
                                "error": err_msg,
                                "status": "error"
                            }),
                        );
                        return;
                    }
                }
                Err(e) => {
                    let err_msg = format!("AI 服务连接失败: {}。请确认 Ollama 是否已启动并配置正确。", e);
                    log::warn!("⚠️ [CustomSkill] {}", err_msg);
                    let _ = app.emit(
                        "custom-skill:completed",
                        serde_json::json!({
                            "skill_id": skill_id,
                            "error": err_msg,
                            "status": "error"
                        }),
                    );
                    return;
                }
            }

            log::debug!(
                "⚡ [CustomSkill] Executing (stream): {} ({} chars input)",
                skill_name,
                content.len()
            );

            let mut rx = service.execute_skill_stream(&skill, &content);
            let mut full_text = String::new();

            while let Some(chunk_result) = rx.recv().await {
                match chunk_result {
                    Ok(chunk) => {
                        full_text.push_str(&chunk);
                        // 逐 chunk 推送到前端
                        let _ = app.emit(
                            "custom-skill:chunk",
                            serde_json::json!({
                                "skill_id": skill_id,
                                "chunk": chunk,
                            }),
                        );
                    }
                    Err(e) => {
                        log::warn!("❌ [CustomSkill] {} stream error: {}", skill_name, e);
                        let _ = app.emit(
                            "custom-skill:completed",
                            serde_json::json!({
                                "skill_id": skill_id,
                                "error": e.to_string(),
                                "status": "error"
                            }),
                        );
                        return;
                    }
                }
            }

            // 流结束 → 发送完成事件（带完整文本）
            log::debug!(
                "✅ [CustomSkill] {} completed: {} chars output",
                skill_name,
                full_text.len()
            );
            let _ = app.emit(
                "custom-skill:completed",
                serde_json::json!({
                    "skill_id": skill_id,
                    "result": full_text,
                    "status": "success"
                }),
            );
        });
    });

    Ok("executing".to_string())
}
