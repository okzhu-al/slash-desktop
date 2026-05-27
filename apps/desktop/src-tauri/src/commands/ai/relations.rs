//! Note Relations Commands
//!
//! Commands for adding relations between notes via YAML frontmatter.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::State;

use crate::DbStateWrapper;

// ============================================================================
// YAML Frontmatter Relation Writer (public utility)
// ============================================================================

/// Update a single note's YAML frontmatter with a relation entry.
/// This is the canonical way to persist a relation into a markdown file.
pub fn update_note_with_relation(
    note_path_str: &str,
    relation_type: &str,
    target_title: &str,
    vault_path: &std::path::Path,
) -> Result<(), String> {
    // Construct absolute path
    let absolute_path = if note_path_str.starts_with(&vault_path.to_string_lossy().to_string()) {
        PathBuf::from(note_path_str)
    } else {
        vault_path.join(note_path_str)
    };

    log::debug!("🔗 [AddRelation] Adding relation to: {:?}", absolute_path);

    // Read file content
    let content =
        fs::read_to_string(&absolute_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Parse frontmatter
    let (frontmatter, body) = if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm = content[3..3 + end_idx].trim().to_string();
            let body = content[3 + end_idx + 3..].to_string();
            (fm, body)
        } else {
            (String::new(), content)
        }
    } else {
        (String::new(), content)
    };

    // Parse YAML
    let mut yaml_map: serde_yaml::Value = if frontmatter.is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(&frontmatter)
            .unwrap_or(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
    };

    // Add relation to YAML - store just the note title
    let target_value = target_title.to_string();

    if let serde_yaml::Value::Mapping(ref mut map) = yaml_map {
        let relations_key = serde_yaml::Value::String("relations".to_string());
        let relation_type_key = serde_yaml::Value::String(relation_type.to_string());

        if !map.contains_key(&relations_key) {
            map.insert(
                relations_key.clone(),
                serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
            );
        }

        if let Some(serde_yaml::Value::Mapping(ref mut relations)) = map.get_mut(&relations_key) {
            // Remove target_title from all existing relation keys to avoid duplicates
            let mut keys_to_remove = Vec::new();
            for (key, val) in relations.iter_mut() {
                match val {
                    serde_yaml::Value::Sequence(ref mut seq) => {
                        seq.retain(|v| {
                            if let serde_yaml::Value::String(s) = v {
                                s != &target_value
                            } else {
                                true
                            }
                        });
                        if seq.is_empty() {
                            keys_to_remove.push(key.clone());
                        }
                    }
                    serde_yaml::Value::String(ref s) => {
                        if s == &target_value {
                            keys_to_remove.push(key.clone());
                        }
                    }
                    _ => {}
                }
            }
            for k in keys_to_remove {
                relations.remove(&k);
            }

            if let Some(existing) = relations.get_mut(&relation_type_key) {
                match existing {
                    serde_yaml::Value::Sequence(ref mut seq) => {
                        let new_val = serde_yaml::Value::String(target_value.clone());
                        if !seq.contains(&new_val) {
                            seq.push(new_val);
                        }
                    }
                    serde_yaml::Value::String(ref s) => {
                        if s != &target_value {
                            let old = s.clone();
                            *existing = serde_yaml::Value::Sequence(vec![
                                serde_yaml::Value::String(old),
                                serde_yaml::Value::String(target_value.clone()),
                            ]);
                        }
                    }
                    _ => {
                        *existing = serde_yaml::Value::String(target_value.clone());
                    }
                }
            } else {
                relations.insert(
                    relation_type_key,
                    serde_yaml::Value::String(target_value.clone()),
                );
            }
        }
    }

    // Serialize YAML
    let new_frontmatter =
        serde_yaml::to_string(&yaml_map).map_err(|e| format!("Failed to serialize YAML: {}", e))?;

    // Add wiki link to body if it doesn't already exist
    let mut new_body = body.trim().to_string();
    let wiki_link = format!("[[{}]]", target_title);
    
    if !new_body.contains(&wiki_link) {
        if !new_body.is_empty() {
            new_body.push_str("\n\n");
        }
        new_body.push_str(&wiki_link);
    }

    // Reconstruct file content
    let new_content = format!("---\n{}---\n{}\n", new_frontmatter, new_body);

    // Write back to file
    let mut file =
        fs::File::create(&absolute_path).map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;

    log::debug!(
        "✅ [AddRelation] Added {}:: [[{}]] to {:?}",
        relation_type, target_title, absolute_path
    );
    Ok(())
}

// ============================================================================
// Tauri Command
// ============================================================================

/// Add a relation to a note's YAML frontmatter
#[tauri::command]
pub fn add_note_relation(
    note_path: String,
    relation_type: String,
    target_title: String,
    target_path: String,
    db_state: State<DbStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Get vault path
    let vault_path = db_state
        .0
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Vault path not set")?;

    // Get source note title from path
    let source_title = std::path::Path::new(&note_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| note_path.clone());

    // Update source note (A -> B)
    update_note_with_relation(&note_path, &relation_type, &target_title, &vault_path)?;

    // Add bidirectional blacklist entries
    let vault_str = vault_path.to_string_lossy();

    // Normalize paths to relative for blacklist
    let source_relative = note_path
        .strip_prefix(&format!("{}/", vault_str))
        .unwrap_or(&note_path)
        .to_string();
    let target_relative = target_path
        .strip_prefix(&format!("{}/", vault_str))
        .unwrap_or(&target_path)
        .to_string();

    // Add both directions to blacklist
    db_state.0.with_connection(|conn| {
        crate::core::db::repository::add_ghost_link_blacklist(
            conn,
            &source_relative,
            &target_relative,
        )?;
        crate::core::db::repository::add_ghost_link_blacklist(
            conn,
            &target_relative,
            &source_relative,
        )?;
        Ok(())
    })?;

    use tauri::Emitter;
    let _ = app_handle.emit(
        "wikilink-relation-result",
        serde_json::json!({
            "source_path": note_path,
            "target_path": target_path,
            "relation": relation_type,
            "reason": "manual update",
            "from_cache": true
        }),
    );

    log::debug!(
        "✅ [AddRelation] Directional relation complete: {} -> {}",
        source_title, target_title
    );
    Ok(())
}
