//! Editor 元数据批量管理
//!
//! 在 Join team 或 display_name 变更时，批量更新 vault 内所有 .md 文件的
//! frontmatter `editor:` 字段。

use std::path::PathBuf;
use tauri::Emitter;
use walkdir::WalkDir;

/// 批量更新 vault 内所有 .md 文件的 editor 字段
///
/// - 新增或替换 frontmatter 中的 `editor:` 行
/// - 对 `editing_path`（当前 TipTap 打开的文件）跳过磁盘写入，
///   改为发送 Tauri event 通知前端注入
///
/// 触发时机：Join team / display_name 变更
#[tauri::command]
pub async fn batch_update_editor(
    app: tauri::AppHandle,
    vault_path: String,
    new_name: String,
    old_name: Option<String>,
    editing_path: Option<String>,
) -> Result<u32, String> {
    log::debug!("[Editor] batch_update_editor: vault={}, new_name={}, old_name={:?}", vault_path, new_name, old_name);
    let root = PathBuf::from(&vault_path);
    if !root.exists() {
        return Err(format!("Vault path does not exist: {vault_path}"));
    }

    let mut updated = 0u32;
    let mut skipped_editing = false;

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();

        // 只处理 .md 文件
        if !path.extension().map(|e| e == "md").unwrap_or(false) {
            continue;
        }

        // 跳过 .slash 目录和隐藏文件
        let relative = match path.strip_prefix(&root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if relative.contains("/.slash/")
            || relative.starts_with(".slash/")
            || relative.split('/').any(|seg| seg.starts_with('.'))
        {
            continue;
        }

        // 当前编辑文件 → 跳过磁盘写入，后续发 event
        if let Some(ref ep) = editing_path {
            if relative == *ep {
                skipped_editing = true;
                continue;
            }
        }

        // 读取文件
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // 构建新内容
        let new_text = inject_or_replace_editor(&text, &new_name, old_name.as_deref());

        if new_text != text {
            if let Err(e) = std::fs::write(path, &new_text) {
                log::error!("[Editor] Failed to write {}: {e}", path.display());
            } else {
                updated += 1;
            }
        }
    }

    // 对跳过的当前编辑文件发送 Tauri event
    if skipped_editing {
        if let Some(ref ep) = editing_path {
            let _ = app.emit(
                "editor-inject",
                serde_json::json!({
                    "path": ep,
                    "editorName": new_name,
                }),
            );
            log::debug!("[Editor] Emitted editor-inject event for editing file: {ep}");
        }
    }

    log::debug!(
        "[Editor] Batch update done: {} files updated, editing_file_skipped={}",
        updated, skipped_editing
    );

    Ok(updated)
}

/// 在 frontmatter 中注入或替换 editor 字段
fn inject_or_replace_editor(text: &str, new_name: &str, old_name: Option<&str>) -> String {
    let editor_line = format!("editor: {}", new_name);

    if text.starts_with("---\n") {
        if let Some(end) = text[4..].find("\n---") {
            let fm_content = &text[4..4 + end];

            let has_editor = fm_content
                .lines()
                .any(|l| l.trim_start().starts_with("editor:"));

            if has_editor {
                // 已有 editor → 替换（如果是 old_name 或任意值）
                let should_replace = if let Some(old) = old_name {
                    fm_content.lines().any(|l| {
                        l.trim_start().starts_with("editor:")
                            && l.trim_start()
                                .strip_prefix("editor:")
                                .map(|v| v.trim() == old)
                                .unwrap_or(false)
                    })
                } else {
                    false // 🛡️ 团队安全补丁：无 old_name 提供时，绝对不允许越权覆盖已存在的 editor
                };

                if !should_replace {
                    return text.to_string(); // editor 值不匹配 old_name → 不替换（可能是其他用户的文件）
                }

                let updated_fm = fm_content
                    .lines()
                    .map(|l| {
                        if l.trim_start().starts_with("editor:") {
                            editor_line.as_str()
                        } else {
                            l
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("---\n{}{}", updated_fm, &text[4 + end..])
            } else {
                // 无 editor → 追加
                format!("---\n{}\n{}{}", fm_content, editor_line, &text[4 + end..])
            }
        } else {
            text.to_string() // frontmatter 格式异常
        }
    } else {
        // 无 frontmatter → 创建
        format!("---\n{}\n---\n{}", editor_line, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_frontmatter() {
        let result = inject_or_replace_editor("Hello world", "Alice", None);
        assert_eq!(result, "---\neditor: Alice\n---\nHello world");
    }

    #[test]
    fn test_existing_frontmatter_no_editor() {
        let input = "---\ntitle: My Note\n---\nContent";
        let result = inject_or_replace_editor(input, "Alice", None);
        assert_eq!(result, "---\ntitle: My Note\neditor: Alice\n---\nContent");
    }

    #[test]
    fn test_no_replace_without_old_name() {
        let input = "---\ntitle: My Note\neditor: Bob\n---\nContent";
        let result = inject_or_replace_editor(input, "Alice", None);
        // 根据团队安全补丁，如果没有给出 old_name，不能随便强暴别人的 editor 归属！
        assert_eq!(result, "---\ntitle: My Note\neditor: Bob\n---\nContent");
    }

    #[test]
    fn test_replace_editor() {
        let input = "---\ntitle: My Note\neditor: Bob\n---\nContent";
        let result = inject_or_replace_editor(input, "Alice", Some("Bob"));
        assert_eq!(
            result,
            "---\ntitle: My Note\neditor: Alice\n---\nContent"
        );
    }

    #[test]
    fn test_no_replace_different_old_name() {
        let input = "---\neditor: Charlie\n---\nContent";
        let result = inject_or_replace_editor(input, "Alice", Some("Bob"));
        // Charlie != Bob → 不替换
        assert_eq!(result, "---\neditor: Charlie\n---\nContent");
    }
}
