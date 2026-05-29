use crate::core::db::models::{AiFrontmatter, Link, LinkType, Note, ParsedFrontmatter, ScanResult};
use gray_matter::engine::YAML;
use gray_matter::Matter;
use regex::Regex;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

use super::links::{delete_links_for_source, insert_links};
use super::normalize_path;
use super::notes::upsert_note;

// ============================================================================
// SCANNER LOGIC
// ============================================================================

/// Extract the link target from a wikilink, handling aliases
/// "柏拉图|Plato" -> "柏拉图"
/// "SomeNote" -> "SomeNote"
fn extract_link_target(raw: &str) -> &str {
    raw.split('|').next().unwrap_or(raw).trim()
}

/// Parse YAML frontmatter from markdown content
pub fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let matter = Matter::<YAML>::new();

    match matter.parse(content) {
        matter_result => {
            let mut result = ParsedFrontmatter::default();

            if let Some(data) = matter_result.data {
                if let Ok(pod) = data.deserialize::<serde_yaml::Value>() {
                    // Extract slash_id
                    if let Some(slash_id) = pod.get("slash_id").and_then(|v| v.as_str()) {
                        result.slash_id = Some(slash_id.to_string());
                    }

                    // Extract title
                    if let Some(title) = pod.get("title").and_then(|v| v.as_str()) {
                        result.title = Some(title.to_string());
                    }

                    // Extract tags
                    if let Some(tags) = pod.get("tags") {
                        if let Some(arr) = tags.as_sequence() {
                            result.tags = arr
                                .iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect();
                        }
                    }

                    // Extract summary
                    if let Some(summary) = pod.get("summary").and_then(|v| v.as_str()) {
                        result.summary = Some(summary.to_string());
                    }

                    // Extract relations
                    if let Some(relations) = pod.get("relations") {
                        if let Some(map) = relations.as_mapping() {
                            for (key, value) in map {
                                if let Some(key_str) = key.as_str() {
                                    let mut links = Vec::new();

                                    // Handle single value or array
                                    if let Some(s) = value.as_str() {
                                        links.push(s.to_string());
                                    } else if let Some(arr) = value.as_sequence() {
                                        for v in arr {
                                            if let Some(s) = v.as_str() {
                                                links.push(s.to_string());
                                            }
                                        }
                                    }

                                    if !links.is_empty() {
                                        result.relations.insert(key_str.to_string(), links);
                                    }
                                }
                            }
                        }
                    }

                    // Extract ai: namespace
                    if let Some(ai_val) = pod.get("ai") {
                        if ai_val.is_mapping() {
                            let mut ai = AiFrontmatter::default();

                            if let Some(t) = ai_val.get("title").and_then(|v| v.as_str()) {
                                ai.title = Some(t.to_string());
                            }
                            if let Some(s) = ai_val.get("summary").and_then(|v| v.as_str()) {
                                ai.summary = Some(s.to_string());
                            }
                            if let Some(tags) = ai_val.get("tags") {
                                if let Some(arr) = tags.as_sequence() {
                                    ai.tags = Some(
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                            .collect(),
                                    );
                                }
                            }
                            if let Some(p) = ai_val.get("provider").and_then(|v| v.as_str()) {
                                ai.provider = Some(p.to_string());
                            }
                            if let Some(m) = ai_val.get("model").and_then(|v| v.as_str()) {
                                ai.model = Some(m.to_string());
                            }
                            if let Some(t) = ai_val.get("processed_at").and_then(|v| v.as_str()) {
                                ai.processed_at = Some(t.to_string());
                            }

                            result.ai = Some(ai);
                        }
                    }
                }
            }

            result
        }
    }
}

/// Extract links from markdown content
/// Skips links inside fenced code blocks, inline code, and inline math
pub fn extract_links(content: &str, source_path: &str) -> Vec<Link> {
    let mut links = Vec::new();

    // Pre-process: Remove fenced code blocks (```...``` or unclosed ```)
    // First handle closed blocks, then handle unclosed trailing blocks
    let fenced_code_re = Regex::new(r"(?s)```[^`]*```").unwrap();
    let content_no_closed = fenced_code_re.replace_all(content, "");
    // Handle unclosed code blocks (``` to end of file)
    let unclosed_code_re = Regex::new(r"(?s)```.*$").unwrap();
    let content_no_fenced = unclosed_code_re.replace_all(&content_no_closed, "");

    // Pre-process: Remove inline code (`...`)
    let inline_code_re = Regex::new(r"`[^`]+`").unwrap();
    let content_no_inline = inline_code_re.replace_all(&content_no_fenced, "");

    // Pre-process: Remove block math ($$...$$) first, then inline math ($...$)
    let block_math_re = Regex::new(r"(?s)\$\$.*?\$\$").unwrap();
    let content_no_block_math = block_math_re.replace_all(&content_no_inline, "");

    // Now safely remove single $ inline math
    let inline_math_re = Regex::new(r"\$[^$]+\$").unwrap();
    let content_clean = inline_math_re.replace_all(&content_no_block_math, "");

    // Regex for explicit links: [[Target]] or [[Target|Display]]
    let explicit_re = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();

    // Extract explicit WikiLinks
    for cap in explicit_re.captures_iter(&content_clean) {
        let raw_target = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let target = extract_link_target(raw_target);
        if !target.is_empty() {
            links.push(Link::explicit(source_path, &format!("[[{}]]", target)));
        }
    }

    links
}

/// Scan a single markdown file and extract note + links
pub fn scan_file(conn: &Connection, vault_path: &Path, relative_path: &str) -> Result<ScanResult, String> {
    // Normalize path for cross-platform consistency
    let normalized_path = normalize_path(relative_path);
    let file_path = vault_path.join(&normalized_path);

    // Read file metadata
    let metadata = fs::metadata(&file_path).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64)
        .unwrap_or(0);
    let size = metadata.len() as i64;

    // Read file content
    let mut content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;

    // Parse frontmatter
    let mut frontmatter = parse_frontmatter(&content);

    // Ensure slash_id exists and is valid (UUID-First)
    let slash_id = match frontmatter.slash_id {
        Some(ref id) if uuid::Uuid::parse_str(id).is_ok() => {
            // Check for UUID collision in SQLite database (Bug 3 Fix)
            let mut is_collision = false;
            let mut stmt = conn
                .prepare("SELECT path FROM notes WHERE slash_id = ?1")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([id]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let another_path: String = row.get(0).map_err(|e| e.to_string())?;
                if another_path != normalized_path {
                    let another_full_path = vault_path.join(&another_path);
                    if another_full_path.exists() {
                        is_collision = true;
                        log::warn!(
                            "⚠️ [Scanner] UUID collision detected! UUID {} is already owned by alive note: {}. Regenerating new UUID for copy: {}",
                            id,
                            another_path,
                            normalized_path
                        );
                    }
                }
            }

            if is_collision {
                let new_id = uuid::Uuid::new_v4().to_string();
                log::info!(
                    "⚡ [Scanner] Regenerating and writing new slash_id ({}) for colliding note: {}",
                    new_id,
                    normalized_path
                );
                content = insert_slash_id_into_frontmatter(&content, &new_id);
                fs::write(&file_path, &content)
                    .map_err(|e| format!("Failed to write back new slash_id after collision: {}", e))?;

                // Re-parse frontmatter to ensure state consistency
                frontmatter = parse_frontmatter(&content);
                new_id
            } else {
                id.clone()
            }
        }
        _ => {
            // Generate a new UUID and write it back to the physical file
            let new_id = uuid::Uuid::new_v4().to_string();
            log::info!(
                "⚡ [Scanner] Generating and writing new slash_id ({}) for note: {}",
                new_id,
                normalized_path
            );
            content = insert_slash_id_into_frontmatter(&content, &new_id);
            fs::write(&file_path, &content)
                .map_err(|e| format!("Failed to write back slash_id to file: {}", e))?;
            
            // Re-parse frontmatter to ensure state consistency
            frontmatter = parse_frontmatter(&content);
            new_id
        }
    };

    // Determine title (from frontmatter or filename)
    let title = frontmatter.title.clone().unwrap_or_else(|| {
        Path::new(&normalized_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });

    // Create note with normalized path
    let mut note = Note::from_file(&normalized_path, &title, mtime, size);
    note.slash_id = Some(slash_id);

    // Add user metadata from frontmatter
    if !frontmatter.tags.is_empty() {
        note.user_tags = Some(serde_json::to_string(&frontmatter.tags).unwrap_or_default());
    }
    note.user_summary = frontmatter.summary.clone();

    // Sync AI metadata from YAML ai: namespace → SQLite (derived index)
    if let Some(ref ai) = frontmatter.ai {
        if let Some(ref tags) = ai.tags {
            if !tags.is_empty() {
                note.ai_tags = Some(serde_json::to_string(tags).unwrap_or_default());
            }
        }
        if ai.summary.is_some() {
            note.ai_summary = ai.summary.clone();
        }
        if ai.title.is_some() {
            note.ai_title = ai.title.clone();
        }
    }

    // Extract links (using normalized path as source)
    let mut links = extract_links(&content, &normalized_path);

    // Collect explicit link target names (lowercase, section-stripped for comparison)
    let explicit_targets: std::collections::HashSet<String> = links
        .iter()
        .filter(|l| l.link_type == "explicit")
        .map(|l| {
            let full = l
                .target_anchor
                .trim_start_matches("[[")
                .trim_end_matches("]]")
                .split('|')
                .next()
                .unwrap_or("");
            // Strip #section anchor (e.g. "第二大脑#第一部分" → "第二大脑")
            full.split('#').next().unwrap_or(full).to_lowercase()
        })
        .collect();

    // Clean up orphaned YAML relations (targets without a corresponding [[WikiLink]] in body)
    let mut cleaned_relations = frontmatter.relations.clone();
    let mut yaml_dirty = false;
    for (_label, targets) in cleaned_relations.iter_mut() {
        let before_len = targets.len();
        targets.retain(|target| {
            let clean = extract_link_target(target).to_lowercase();
            explicit_targets.contains(&clean)
        });
        if targets.len() != before_len {
            yaml_dirty = true;
        }
    }
    // Remove empty relation groups
    cleaned_relations.retain(|_, targets| !targets.is_empty());
    if cleaned_relations.len() != frontmatter.relations.len() {
        yaml_dirty = true;
    }

    // Write back cleaned YAML if any orphans were removed
    if yaml_dirty {
        log::error!(
            "🧹 [ScanFile] Cleaning orphaned YAML relations in: {}",
            normalized_path
        );
        // Re-read and modify the file's frontmatter
        if let Ok(raw_content) = fs::read_to_string(&file_path) {
            if raw_content.starts_with("---") {
                if let Some(end_idx) = raw_content[3..].find("---") {
                    let fm_str = raw_content[3..3 + end_idx].trim().to_string();
                    let body = &raw_content[3 + end_idx + 3..];

                    if let Ok(mut yaml_map) = serde_yaml::from_str::<serde_yaml::Value>(&fm_str) {
                        if let serde_yaml::Value::Mapping(ref mut map) = yaml_map {
                            let relations_key = serde_yaml::Value::String("relations".to_string());
                            if cleaned_relations.is_empty() {
                                map.remove(&relations_key);
                            } else {
                                let mut new_relations = serde_yaml::Mapping::new();
                                for (label, targets) in &cleaned_relations {
                                    let val = if targets.len() == 1 {
                                        serde_yaml::Value::String(targets[0].clone())
                                    } else {
                                        serde_yaml::Value::Sequence(
                                            targets
                                                .iter()
                                                .map(|t| serde_yaml::Value::String(t.clone()))
                                                .collect(),
                                        )
                                    };
                                    new_relations
                                        .insert(serde_yaml::Value::String(label.clone()), val);
                                }
                                map.insert(
                                    relations_key,
                                    serde_yaml::Value::Mapping(new_relations),
                                );
                            }
                        }

                        if let Ok(new_fm) = serde_yaml::to_string(&yaml_map) {
                            let new_content =
                                format!("---\n{}---\n{}", new_fm, body.trim_start_matches('\n'));
                            let _ = fs::write(&file_path, new_content);
                        }
                    }
                }
            }
        }
    }

    // Merge YAML relation labels into existing explicit links (avoid duplicates)
    for (label, targets) in &cleaned_relations {
        for target in targets {
            let clean_target = extract_link_target(target);
            let target_lower = clean_target.to_lowercase();

            // Check if an explicit link to this target already exists
            let existing = links.iter_mut().find(|l| {
                l.link_type == "explicit" && {
                    let full_anchor = l
                        .target_anchor
                        .trim_start_matches("[[")
                        .trim_end_matches("]]")
                        .split('|')
                        .next()
                        .unwrap_or("");
                    // Strip #section for comparison
                    let anchor_target = full_anchor
                        .split('#')
                        .next()
                        .unwrap_or(full_anchor)
                        .to_lowercase();
                    anchor_target == target_lower
                }
            });

            if let Some(link) = existing {
                // Merge: set label on existing explicit link
                if link.label.is_none() || link.label.as_deref() == Some("") {
                    link.label = Some(label.clone());
                }
            } else {
                // No explicit link — create standalone yaml link
                links.push(Link::labeled(
                    &normalized_path,
                    &format!("[[{}]]", clean_target),
                    label,
                    LinkType::Yaml,
                ));
            }
        }
    }

    Ok(ScanResult { note, links })
}

/// Scan and upsert a file with proper transaction safety
pub fn scan_and_upsert(
    conn: &Connection,
    vault_path: &Path,
    relative_path: &str,
) -> Result<ScanResult, String> {
    let result = scan_file(conn, vault_path, relative_path)?;
    let normalized_path = normalize_path(relative_path);

    // Use rusqlite's Transaction API for proper RAII-based safety
    // If the closure panics or returns an error, the transaction is automatically rolled back
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;

    let tx_result = (|| -> Result<(), String> {
        // Upsert note
        upsert_note(conn, &result.note).map_err(|e| e.to_string())?;

        // Delete old links
        delete_links_for_source(conn, &normalized_path).map_err(|e| e.to_string())?;

        // Insert new links
        insert_links(conn, &result.links).map_err(|e| e.to_string())?;

        Ok(())
    })();

    match tx_result {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(e) => {
            conn.execute("ROLLBACK", []).ok(); // Best effort rollback
            Err(e)
        }
    }
}

/// Helper function to insert a slash_id into markdown YAML frontmatter.
fn insert_slash_id_into_frontmatter(content: &str, slash_id: &str) -> String {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        if let Some(end_idx) = trimmed[3..].find("\n---") {
            let fm_end = 3 + end_idx;
            let fm_str = &trimmed[3..fm_end];
            let body = &trimmed[fm_end + 4..]; // Skip "\n---"
            
            let mut new_fm_lines = Vec::new();
            let mut replaced = false;
            for line in fm_str.lines() {
                if line.trim().starts_with("slash_id:") {
                    new_fm_lines.push(format!("slash_id: {}", slash_id));
                    replaced = true;
                } else {
                    new_fm_lines.push(line.to_string());
                }
            }
            if !replaced {
                new_fm_lines.push(format!("slash_id: {}", slash_id));
            }
            let mut new_fm = new_fm_lines.join("\n");
            if !new_fm.ends_with('\n') {
                new_fm.push('\n');
            }
            return format!("---\n{}---\n{}", new_fm, body);
        }
    }
    // If no frontmatter or invalid structure, prepend standard frontmatter
    format!("---\nslash_id: {}\n---\n{}", slash_id, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;
    use std::fs;

    #[test]
    fn test_wikilink_db_persistence() {
        // 1. 初始化内存数据库并导入 schema.sql
        let conn = Connection::open_in_memory().unwrap();
        let schema_sql = include_str!("../../db/schema.sql");
        conn.execute_batch(schema_sql).unwrap();

        // 2. 创建临时测试目录和测试文件
        let dir = tempdir().unwrap();
        let vault_path = dir.path();
        
        let relative_path = "测试文档.md";
        let file_path = vault_path.join(relative_path);

        let content = r#"---
slash_id: 12345678-1234-1234-1234-1234567890ab
title: 测试源文件
relations:
  核心指标: 性能测试
---
这是测试文件。
包含一个普通的WikiLink：[[性能优化进阶2]]。
还有一个带别名和标题锚点的WikiLink：[[性能测试#核心指标|测试展示]]。
"#;
        fs::write(&file_path, content).unwrap();

        // 3. 执行 scan_and_upsert 扫描并入库
        let scan_result = scan_and_upsert(&conn, vault_path, relative_path).unwrap();

        // 4. 验证返回的扫描结果
        assert_eq!(scan_result.note.path, "测试文档.md");
        assert_eq!(scan_result.links.len(), 2);

        // 5. 查询 SQLite 数据库中的 links 表记录进行校验
        let mut stmt = conn
            .prepare("SELECT source_path, target_path, target_anchor, label, link_type FROM links ORDER BY id")
            .unwrap();

        struct LinkRow {
            source_path: String,
            target_path: Option<String>,
            target_anchor: String,
            label: Option<String>,
            link_type: String,
        }

        let link_rows: Vec<LinkRow> = stmt
            .query_map([], |row| {
                Ok(LinkRow {
                    source_path: row.get(0)?,
                    target_path: row.get(1)?,
                    target_anchor: row.get(2)?,
                    label: row.get(3)?,
                    link_type: row.get(4)?,
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(link_rows.len(), 2);

        // 校验第一条 WikiLink [[性能优化进阶2]] 的数据落盘
        let row1 = &link_rows[0];
        assert_eq!(row1.source_path, "测试文档.md");
        assert_eq!(row1.target_path, None);
        assert_eq!(row1.target_anchor, "[[性能优化进阶2]]");
        assert_eq!(row1.label, None);
        assert_eq!(row1.link_type, "explicit");

        // 校验第二条 WikiLink [[性能测试#核心指标|测试展示]] 的数据落盘以及 label 合并
        let row2 = &link_rows[1];
        assert_eq!(row2.source_path, "测试文档.md");
        assert_eq!(row2.target_path, None);
        assert_eq!(row2.target_anchor, "[[性能测试#核心指标]]");
        assert_eq!(row2.label, Some("核心指标".to_string()));
        assert_eq!(row2.link_type, "explicit");

        // 6. 验证 get_note_backlinks_by_section 是否能正确查询到带有 #section 的 WikiLink
        let backlinks = crate::core::db::repository::links::get_note_backlinks_by_section(&conn, "性能测试").unwrap();
        assert!(backlinks.contains_key("核心指标"), "Backlinks should contain key '核心指标'");
        let list = backlinks.get("核心指标").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source_path, "测试文档.md");
        assert_eq!(list[0].target_anchor, "[[性能测试#核心指标]]");
    }
}

