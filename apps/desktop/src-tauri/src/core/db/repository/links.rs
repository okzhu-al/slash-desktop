use crate::core::db::models::Link;
use rusqlite::{params, Connection, Result as SqliteResult};

// ============================================================================
// LINK CRUD FUNCTIONS
// ============================================================================

/// Delete all links for a source path
pub fn delete_links_for_source(conn: &Connection, source_path: &str) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM links WHERE source_path = ?1",
        params![source_path],
    )?;
    Ok(())
}

/// Insert a link
pub fn insert_link(conn: &Connection, link: &Link) -> SqliteResult<i64> {
    conn.execute(
        r#"
        INSERT INTO links (source_path, target_path, target_anchor, label, link_type)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![
            link.source_path,
            link.target_path,
            link.target_anchor,
            link.label,
            link.link_type,
        ],
    )?;

    Ok(conn.last_insert_rowid())
}

/// Batch insert links
pub fn insert_links(conn: &Connection, links: &[Link]) -> SqliteResult<()> {
    for link in links {
        insert_link(conn, link)?;
    }
    Ok(())
}

/// Get links from a source
#[allow(dead_code)]
pub fn get_links_from(conn: &Connection, source_path: &str) -> SqliteResult<Vec<Link>> {
    let mut stmt = conn.prepare("SELECT * FROM links WHERE source_path = ?1")?;

    let links = stmt
        .query_map(params![source_path], |row| {
            Ok(Link {
                id: Some(row.get(0)?),
                source_path: row.get(1)?,
                target_path: row.get(2)?,
                target_anchor: row.get(3)?,
                label: row.get(4)?,
                link_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(links)
}

/// Get links to a target
#[allow(dead_code)]
pub fn get_links_to(conn: &Connection, target_path: &str) -> SqliteResult<Vec<Link>> {
    let mut stmt = conn.prepare("SELECT * FROM links WHERE target_path = ?1")?;

    let links = stmt
        .query_map(params![target_path], |row| {
            Ok(Link {
                id: Some(row.get(0)?),
                source_path: row.get(1)?,
                target_path: row.get(2)?,
                target_anchor: row.get(3)?,
                label: row.get(4)?,
                link_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(links)
}

/// Get all links
pub fn get_all_links(conn: &Connection) -> SqliteResult<Vec<Link>> {
    let mut stmt = conn.prepare("SELECT * FROM links")?;

    let links = stmt
        .query_map([], |row| {
            Ok(Link {
                id: Some(row.get(0)?),
                source_path: row.get(1)?,
                target_path: row.get(2)?,
                target_anchor: row.get(3)?,
                label: row.get(4)?,
                link_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(links)
}

// ============================================================================
// SECTION BACKLINKS
// ============================================================================

/// Info about a single backlink
#[derive(Debug, Clone, serde::Serialize)]
pub struct BacklinkInfo {
    pub source_path: String,
    pub source_title: String,
    pub target_anchor: String, // Original link text like "[[Note#Section]]"
}

/// Get all backlinks to a note, grouped by target section
/// Returns HashMap where:
/// - Key "" (empty) = links to the whole note like [[NoteName]]
/// - Key "SectionName" = links to specific section like [[NoteName#SectionName]]
pub fn get_note_backlinks_by_section(
    conn: &Connection,
    note_name: &str, // Just the note name without path, e.g. "Test"
) -> SqliteResult<std::collections::HashMap<String, Vec<BacklinkInfo>>> {
    use std::collections::HashMap;

    let mut result: HashMap<String, Vec<BacklinkInfo>> = HashMap::new();

    // Use multiple precise patterns instead of a single broad one
    let pattern_exact = format!("[[{}]]", note_name); // [[Test]]
    let pattern_section = format!("[[{}#%", note_name); // [[Test#...
    let pattern_alias = format!("[[{}|%", note_name); // [[Test|...

    let mut stmt = conn.prepare(
        "SELECT source_path, target_anchor FROM links 
         WHERE target_anchor = ?1 
            OR target_anchor LIKE ?2 
            OR target_anchor LIKE ?3",
    )?;

    let rows = stmt.query_map(
        params![&pattern_exact, &pattern_section, &pattern_alias],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;

    for row_result in rows {
        if let Ok((source_path, target_anchor)) = row_result {
            // Get source title
            let source_title: String = conn
                .query_row(
                    "SELECT title FROM notes WHERE path = ?1",
                    params![&source_path],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| {
                    source_path
                        .split('/')
                        .last()
                        .unwrap_or(&source_path)
                        .trim_end_matches(".md")
                        .to_string()
                });

            // Skip self-links (where source note is same as target note)
            if source_title.to_lowercase() == note_name.to_lowercase() {
                continue;
            }

            // Extract section from target_anchor
            let section = extract_section_from_anchor(&target_anchor, note_name);

            let backlink = BacklinkInfo {
                source_path,
                source_title,
                target_anchor,
            };

            result.entry(section).or_default().push(backlink);
        }
    }

    Ok(result)
}

/// Extract section name from target_anchor
/// [[Note]] -> ""
/// [[Note#Section]] -> "Section"
/// [[Note#Section|Display]] -> "Section"
fn extract_section_from_anchor(anchor: &str, _note_name: &str) -> String {
    // Remove [[ and ]]
    let inner = anchor.trim_start_matches('[').trim_end_matches(']');

    // Check if has # for section
    if let Some(hash_pos) = inner.find('#') {
        let after_hash = &inner[(hash_pos + 1)..];
        // Remove |Display part if exists
        if let Some(pipe_pos) = after_hash.find('|') {
            after_hash[..pipe_pos].to_string()
        } else {
            after_hash.to_string()
        }
    } else {
        // No section, return empty string for whole-note link
        String::new()
    }
}
