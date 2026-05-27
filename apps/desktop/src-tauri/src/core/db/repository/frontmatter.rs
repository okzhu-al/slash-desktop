use crate::core::db::models::AiFrontmatter;
use std::fs;
use std::path::Path;

// ============================================================================
// YAML FRONTMATTER WRITE UTILITIES
// ============================================================================

/// Update a single top-level YAML frontmatter field.
/// If the field already exists, its value is replaced.
/// If not, it is appended to the end of the frontmatter.
/// If no frontmatter exists, a new block is created.
pub fn update_frontmatter_field(content: &str, key: &str, value: &str) -> String {
    if content.starts_with("---") {
        if let Some(end_pos) = content[3..].find("\n---") {
            let frontmatter = &content[3..3 + end_pos];
            let body = &content[3 + end_pos + 4..];

            let mut new_lines: Vec<String> = Vec::new();
            let mut key_found = false;
            let mut skip_block = false;

            for line in frontmatter.lines() {
                if line.trim().is_empty() && !skip_block {
                    continue;
                }
                if skip_block {
                    // Check if this line starts a new top-level key
                    if !line.starts_with(' ') && !line.starts_with('\t') && line.contains(':') {
                        skip_block = false;
                    } else {
                        continue;
                    }
                }
                if line.trim_start().starts_with(&format!("{}:", key)) {
                    new_lines.push(format!("{}: {}", key, value));
                    key_found = true;
                    // Skip subsequent indented lines if:
                    // - block scalar (| or >)
                    // - empty value (block-style list/map follows)
                    let val_part = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
                    if val_part.is_empty() || val_part.starts_with('|') || val_part.starts_with('>')
                    {
                        skip_block = true;
                    }
                } else {
                    new_lines.push(line.to_string());
                }
            }

            if !key_found {
                new_lines.push(format!("{}: {}", key, value));
            }

            return format!("---\n{}\n---{}", new_lines.join("\n"), body);
        }
    }

    // No frontmatter — create new block
    format!("---\n{}: {}\n---\n{}", key, value, content)
}

/// Format a string value for safe YAML embedding.
/// Wraps in quotes if the value contains special YAML characters.
fn yaml_safe_string(s: &str) -> String {
    if s.contains(':')
        || s.contains('#')
        || s.contains('"')
        || s.contains('\'')
        || s.starts_with(' ')
        || s.ends_with(' ')
        || s.starts_with('{')
        || s.starts_with('[')
    {
        // Double-quote and escape internal quotes
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

// ============================================================================
// ADOPTED CONTENT WRITE (Two-Layer)
// ============================================================================

/// Content to write to YAML after user adoption.
///
/// - `tags`, `summary`, `title` → top-level YAML fields (user's final content)
/// - `ai_provider`, `ai_model`, `ai_processed_at` → `ai:` namespace (metadata only)
#[derive(Debug, Clone, Default)]
pub struct AdoptedContent {
    pub tags: Option<Vec<String>>,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
    pub ai_processed_at: Option<String>,
}

/// Write adopted content to a note's YAML frontmatter on disk.
///
/// Two-layer structure:
/// ```yaml
/// ---
/// tags: [tag1, tag2]       # top-level: user-adopted content
/// summary: "摘要"          # top-level: user-adopted content  
/// ai:                      # namespace: AI metadata only
///   provider: online
///   model: gemini-2.5-flash
///   processed_at: "2026-02-12T14:30:00+08:00"
/// ---
/// ```
///
/// Returns `Ok(false)` if no change was needed, `Ok(true)` if file was updated.
pub fn write_adopted_to_file(
    vault_path: &Path,
    note_path: &str,
    adopted: &AdoptedContent,
) -> Result<bool, String> {
    let file_path = vault_path.join(note_path);
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read {}: {}", note_path, e))?;

    let updated = apply_adopted_content(&content, adopted);

    // No-change detection: skip write if content is identical
    if updated == content {
        log::error!("📝 [YAML] No change needed for: {}", note_path);
        return Ok(false);
    }

    fs::write(&file_path, &updated).map_err(|e| format!("Failed to write {}: {}", note_path, e))?;

    log::error!("📝 [YAML] Wrote adopted content to: {}", note_path);
    Ok(true)
}

/// Apply adopted content to markdown string, returning the updated content.
///
/// Writes top-level fields (tags, summary, title) and ai: metadata block.
fn apply_adopted_content(content: &str, adopted: &AdoptedContent) -> String {
    let mut result = content.to_string();

    // 1. Write top-level tags
    if let Some(ref tags) = adopted.tags {
        if !tags.is_empty() {
            let formatted: Vec<String> = tags.iter().map(|t| yaml_safe_string(t)).collect();
            let value = format!("[{}]", formatted.join(", "));
            result = update_frontmatter_field(&result, "tags", &value);
        }
    }

    // 2. Write top-level summary
    if let Some(ref summary) = adopted.summary {
        if !summary.is_empty() {
            result = update_frontmatter_field(&result, "summary", &yaml_safe_string(summary));
        }
    }

    // 3. Write top-level title (only if explicitly set)
    if let Some(ref title) = adopted.title {
        if !title.is_empty() {
            result = update_frontmatter_field(&result, "title", &yaml_safe_string(title));
        }
    }

    // 4. Write ai: metadata block only if provider or model is actually set
    //    (processed_at alone is meaningless without provider/model context)
    let has_meaningful_ai_meta = adopted.ai_provider.is_some() || adopted.ai_model.is_some();

    if has_meaningful_ai_meta {
        let ai_meta = AiFrontmatter {
            tags: None,    // NOT written here — goes to top-level
            summary: None, // NOT written here — goes to top-level
            title: None,   // NOT written here — goes to top-level
            provider: adopted.ai_provider.clone(),
            model: adopted.ai_model.clone(),
            processed_at: adopted.ai_processed_at.clone(),
        };
        result = update_ai_meta_block(&result, &ai_meta);
    }

    result
}

/// Update only the `ai:` metadata block (provider/model/processed_at).
/// Does NOT write tags/summary/title into ai: — those go top-level.
fn update_ai_meta_block(content: &str, ai: &AiFrontmatter) -> String {
    let ai_block = build_ai_meta_block(ai);

    if content.starts_with("---") {
        if let Some(end_pos) = content[3..].find("\n---") {
            let frontmatter = &content[3..3 + end_pos];
            let body = &content[3 + end_pos + 4..];

            let mut new_lines: Vec<String> = Vec::new();
            let mut ai_found = false;
            let mut in_ai_block = false;

            for line in frontmatter.lines() {
                if line.trim().is_empty() && !in_ai_block {
                    continue;
                }
                if in_ai_block {
                    if line.starts_with(' ') || line.starts_with('\t') {
                        continue;
                    }
                    in_ai_block = false;
                }
                if line.trim_start() == "ai:" || line.trim_start().starts_with("ai:") {
                    for ai_line in ai_block.lines() {
                        new_lines.push(ai_line.to_string());
                    }
                    ai_found = true;
                    in_ai_block = true;
                } else {
                    new_lines.push(line.to_string());
                }
            }

            if !ai_found {
                for ai_line in ai_block.lines() {
                    new_lines.push(ai_line.to_string());
                }
            }

            return format!("---\n{}\n---{}", new_lines.join("\n"), body);
        }
    }

    // No frontmatter — create new block
    format!("---\n{}\n---\n{}", ai_block, content)
}

/// Build the YAML text for the ai: metadata block (provider/model/processed_at only).
fn build_ai_meta_block(ai: &AiFrontmatter) -> String {
    let mut lines = vec!["ai:".to_string()];

    if let Some(ref provider) = ai.provider {
        lines.push(format!("  provider: {}", provider));
    }
    if let Some(ref model) = ai.model {
        lines.push(format!("  model: {}", model));
    }
    if let Some(ref processed_at) = ai.processed_at {
        lines.push(format!("  processed_at: {}", processed_at));
    }

    lines.join("\n")
}

// ============================================================================
// DEPRECATED — Old AI-only write functions (semantic mismatch)
// ============================================================================

/// Update the `ai:` namespace in YAML frontmatter.
/// Replaces the entire `ai:` block with the new values.
#[deprecated(
    note = "Use write_adopted_to_file() instead — this writes user content under ai: which is semantically wrong"
)]
#[allow(dead_code)]
pub fn update_ai_frontmatter(content: &str, ai: &AiFrontmatter) -> String {
    #[allow(deprecated)]
    let ai_block = build_ai_yaml_block_legacy(ai);

    if content.starts_with("---") {
        if let Some(end_pos) = content[3..].find("\n---") {
            let frontmatter = &content[3..3 + end_pos];
            let body = &content[3 + end_pos + 4..];

            let mut new_lines: Vec<String> = Vec::new();
            let mut ai_found = false;
            let mut in_ai_block = false;

            for line in frontmatter.lines() {
                if line.trim().is_empty() && !in_ai_block {
                    continue;
                }
                if in_ai_block {
                    if line.starts_with(' ') || line.starts_with('\t') {
                        continue;
                    }
                    in_ai_block = false;
                }
                if line.trim_start() == "ai:" || line.trim_start().starts_with("ai:") {
                    for ai_line in ai_block.lines() {
                        new_lines.push(ai_line.to_string());
                    }
                    ai_found = true;
                    in_ai_block = true;
                } else {
                    new_lines.push(line.to_string());
                }
            }

            if !ai_found {
                for ai_line in ai_block.lines() {
                    new_lines.push(ai_line.to_string());
                }
            }

            return format!("---\n{}\n---{}", new_lines.join("\n"), body);
        }
    }

    format!("---\n{}\n---\n{}", ai_block, content)
}

#[deprecated(note = "Use write_adopted_to_file() instead")]
#[allow(dead_code)]
fn build_ai_yaml_block_legacy(ai: &AiFrontmatter) -> String {
    let mut lines = vec!["ai:".to_string()];

    if let Some(ref tags) = ai.tags {
        if !tags.is_empty() {
            let formatted: Vec<String> = tags.iter().map(|t| yaml_safe_string(t)).collect();
            lines.push(format!("  tags: [{}]", formatted.join(", ")));
        }
    }
    if let Some(ref summary) = ai.summary {
        lines.push(format!("  summary: {}", yaml_safe_string(summary)));
    }
    if let Some(ref title) = ai.title {
        lines.push(format!("  title: {}", yaml_safe_string(title)));
    }
    if let Some(ref provider) = ai.provider {
        lines.push(format!("  provider: {}", provider));
    }
    if let Some(ref model) = ai.model {
        lines.push(format!("  model: {}", model));
    }
    if let Some(ref processed_at) = ai.processed_at {
        lines.push(format!("  processed_at: {}", processed_at));
    }

    lines.join("\n")
}

/// Write AI results to a note's YAML frontmatter on disk.
#[deprecated(note = "Use write_adopted_to_file() instead")]
#[allow(dead_code)]
pub fn write_ai_to_file(
    vault_path: &Path,
    note_path: &str,
    ai: &AiFrontmatter,
) -> Result<(), String> {
    let file_path = vault_path.join(note_path);
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read {}: {}", note_path, e))?;

    #[allow(deprecated)]
    let updated = update_ai_frontmatter(&content, ai);
    fs::write(&file_path, updated).map_err(|e| format!("Failed to write {}: {}", note_path, e))
}
