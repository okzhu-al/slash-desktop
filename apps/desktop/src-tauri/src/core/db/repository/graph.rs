use rusqlite::{params, Connection, Result as SqliteResult};

use super::notes::get_all_notes;

// ============================================================================
// LOCAL GRAPH DATA
// ============================================================================

/// Node in the local graph (Galaxy Model)
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub is_center: bool,
    pub exists: bool,
    pub category: String,  // PARA category: inbox/project/area/resource/archive
    pub in_degree: i32,    // Number of incoming links (for node size)
    pub node_type: String, // "folder" | "note"
    pub depth: i32,        // Directory depth (1=PARA root, 2=sub-folder, etc.)
    pub note_count: i32,   // Number of notes in folder (0 for note nodes)
    pub last_active: i64,  // Most recent mtime (folder inherits from newest child)
    pub summary: Option<String>, // AI or user summary for tooltip display
    pub tags: Option<String>,    // Comma-separated tags (user_tags priority, fallback ai_tags)
}

/// Edge in the local graph
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub label: Option<String>,
    pub link_type: String, // explicit/yaml/ghost/structural
}

/// Complete graph data for a note
#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Helper to determine PARA category from path
/// Used by both get_note_graph and get_global_graph
fn get_category_from_path(path: &str) -> String {
    if path.starts_with("00_Inbox") {
        "inbox".to_string()
    } else if path.starts_with("01_Projects") {
        "project".to_string()
    } else if path.starts_with("02_Areas") {
        "area".to_string()
    } else if path.starts_with("03_Resources") {
        "resource".to_string()
    } else if path.starts_with("04_Archives") {
        "archive".to_string()
    } else {
        "resource".to_string() // default
    }
}

/// PARA root directory names (constitutional directories — excluded from graph)
const PARA_ROOTS: &[&str] = &[
    "00_Inbox",
    "01_Projects",
    "02_Areas",
    "03_Resources",
    "04_Archives",
];

/// Check if a path segment is a PARA root directory
fn is_para_root(segment: &str) -> bool {
    PARA_ROOTS.iter().any(|r| segment == *r)
}

/// Helper to get directory depth RELATIVE to the PARA root.
/// "01_Projects" -> 0 (PARA root, will be hidden)
/// "01_Projects/AI" -> 1 (first visible level)
/// "01_Projects/AI/Models" -> 2
fn get_depth_from_path(path: &str) -> i32 {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.is_empty() {
        return 0;
    }
    // If the first segment is a PARA root, depth = total_segments - 1
    if is_para_root(parts[0]) {
        return (parts.len() as i32) - 1;
    }
    // Otherwise, raw segment count
    parts.len() as i32
}

/// Generate folder nodes and structural edges from note paths.
/// PARA root directories (00_Inbox, 01_Projects, etc.) are EXCLUDED.
/// Returns (folder_nodes, structural_edges)
fn generate_folder_nodes(
    conn: &Connection,
    note_paths: &[String],
    existing_node_ids: &std::collections::HashSet<String>,
) -> (Vec<GraphNode>, Vec<GraphEdge>) {
    let mut folder_nodes: Vec<GraphNode> = Vec::new();
    let mut structural_edges: Vec<GraphEdge> = Vec::new();
    let mut folder_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut folder_note_count: std::collections::HashMap<String, i32> =
        std::collections::HashMap::new();
    let mut folder_last_active: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();

    // Collect all unique folder paths from notes (excluding PARA roots)
    for note_path in note_paths {
        let mtime: i64 = conn
            .query_row(
                "SELECT COALESCE(mtime, 0) FROM notes WHERE path = ?1",
                params![note_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let parts: Vec<&str> = note_path.split('/').collect();
        for i in 1..parts.len() {
            let folder_path = parts[..i].join("/");

            *folder_note_count.entry(folder_path.clone()).or_insert(0) += 1;
            let current_max = folder_last_active.entry(folder_path.clone()).or_insert(0);
            if mtime > *current_max {
                *current_max = mtime;
            }
            folder_ids.insert(folder_path);
        }
    }

    // Create folder nodes
    for folder_path in &folder_ids {
        if existing_node_ids.contains(folder_path) {
            continue;
        }
        let label = folder_path
            .split('/')
            .last()
            .unwrap_or(folder_path)
            .to_string();
        let depth = get_depth_from_path(folder_path);
        let category = get_category_from_path(folder_path);
        let note_count = *folder_note_count.get(folder_path).unwrap_or(&0);
        let last_active = *folder_last_active.get(folder_path).unwrap_or(&0);

        folder_nodes.push(GraphNode {
            id: folder_path.clone(),
            label,
            is_center: false,
            exists: true,
            category,
            in_degree: 0,
            node_type: "folder".to_string(),
            depth,
            note_count,
            last_active,
            summary: None,
            tags: None,
        });
    }

    // --- Structural edges ---
    // Folder → folder (skip edges whose parent is a hidden PARA root)
    for folder_path in &folder_ids {
        let parts: Vec<&str> = folder_path.split('/').collect();
        if parts.len() > 1 {
            let parent_path = parts[..parts.len() - 1].join("/");
            // Only add edge if parent is also a visible folder node
            if folder_ids.contains(&parent_path) {
                structural_edges.push(GraphEdge {
                    source: parent_path,
                    target: folder_path.clone(),
                    label: None,
                    link_type: "structural".to_string(),
                });
            }
        }
    }

    // Folder → note (direct parent only, skip if parent is hidden PARA root)
    for note_path in note_paths {
        let parts: Vec<&str> = note_path.split('/').collect();
        if parts.len() > 1 {
            let parent_path = parts[..parts.len() - 1].join("/");
            if folder_ids.contains(&parent_path) {
                structural_edges.push(GraphEdge {
                    source: parent_path,
                    target: note_path.clone(),
                    label: None,
                    link_type: "structural".to_string(),
                });
            }
        }
    }

    (folder_nodes, structural_edges)
}

/// Get graph data for a note (outgoing links + incoming backlinks)
/// Enhanced for Galaxy Model: includes category (PARA), in_degree (node size), link_type
pub fn get_note_graph(conn: &Connection, note_path: &str) -> SqliteResult<NoteGraph> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Helper to get in_degree for a note (count of incoming links)
    fn get_in_degree(conn: &Connection, note_title: &str) -> i32 {
        let pattern = format!("%[[{}%", note_title);
        conn.query_row(
            "SELECT COUNT(*) FROM links WHERE target_anchor LIKE ?1",
            params![&pattern],
            |row| row.get(0),
        )
        .unwrap_or(0)
    }

    // Get the center note's info
    let center_info: Result<(String, String, Option<String>, Option<String>, Option<String>), _> = conn.query_row(
        "SELECT n.title, n.path, COALESCE(n.user_summary, a.summary), n.user_tags, a.tags FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
        params![note_path],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    );

    let (center_title, center_category, center_summary, center_tags) = match center_info {
        Ok((title, path, summary, user_tags, ai_tags)) => {
            let tags = user_tags.or(ai_tags);
            (title, get_category_from_path(&path), summary, tags)
        },
        Err(_) => {
            let title = note_path
                .split('/')
                .last()
                .unwrap_or(note_path)
                .trim_end_matches(".md")
                .to_string();
            (title.clone(), get_category_from_path(note_path), None, None)
        }
    };

    let center_in_degree = get_in_degree(conn, &center_title);

    // Add center node
    nodes.push(GraphNode {
        id: note_path.to_string(),
        label: center_title.clone(),
        is_center: true,
        exists: true,
        category: center_category,
        in_degree: center_in_degree,
        node_type: "note".to_string(),
        depth: 0,
        note_count: 0,
        last_active: 0,
        summary: center_summary,
        tags: center_tags,
    });
    node_ids.insert(note_path.to_string());

    // Get outgoing links with link_type
    let mut stmt =
        conn.prepare("SELECT target_anchor, label, link_type FROM links WHERE source_path = ?1")?;

    let outgoing: Vec<(String, Option<String>, String)> = stmt
        .query_map(params![note_path], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, String>(2)
                    .unwrap_or_else(|_| "explicit".to_string()),
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    log::debug!(
        "[get_note_graph] source_path: {}, found {} outgoing links",
        note_path,
        outgoing.len()
    );

    for (target_anchor, label, link_type) in outgoing {
        // Extract target name from anchor like [[NoteName]] or [[NoteName|Alias]]
        let target_name = target_anchor
            .trim_start_matches("[[")
            .trim_end_matches("]]")
            .split('|')
            .next()
            .unwrap_or(&target_anchor)
            .split('#') // Handle section links
            .next()
            .unwrap_or(&target_anchor)
            .to_string();

        // Try to find the actual note
        let target_info: Option<(String, String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT n.path, n.title, COALESCE(n.user_summary, a.summary), COALESCE(n.user_tags, a.tags) FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE LOWER(n.title) = LOWER(?1)",
                params![&target_name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok()
            // Fallback: try matching by file_stem (filename without .md)
            .or_else(|| {
                let pattern = format!("%/{}.md", target_name);
                conn.query_row(
                    "SELECT n.path, n.title, COALESCE(n.user_summary, a.summary), COALESCE(n.user_tags, a.tags) FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE LOWER(n.path) LIKE LOWER(?1) OR LOWER(n.path) = LOWER(?2)",
                    params![&pattern, &format!("{}.md", target_name)],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                ).ok()
            });

        let (node_id, target_exists, target_category, target_in_degree, target_summary, target_tags) =
            if let Some((path, title, summary, tags)) = target_info {
                let cat = get_category_from_path(&path);
                let in_deg = get_in_degree(conn, &title);
                (path, true, cat, in_deg, summary, tags)
            } else {
                // Ghost node - doesn't exist yet
                (target_name.clone(), false, "resource".to_string(), 0, None, None)
            };

        if !node_ids.contains(&node_id) {
            nodes.push(GraphNode {
                id: node_id.clone(),
                label: target_name.clone(),
                is_center: false,
                exists: target_exists,
                category: target_category,
                in_degree: target_in_degree,
                node_type: "note".to_string(),
                depth: 0,
                note_count: 0,
                last_active: 0,
                summary: target_summary.clone(),
                tags: target_tags.clone(),
            });
            node_ids.insert(node_id.clone());
        }

        // links.label is the sole authority for relation
        let display_label = label;

        edges.push(GraphEdge {
            source: note_path.to_string(),
            target: node_id,
            label: display_label,
            link_type,
        });
    }

    // Get incoming links (backlinks TO this note)
    let note_name = note_path
        .split('/')
        .last()
        .unwrap_or(note_path)
        .trim_end_matches(".md");
    let pattern1 = format!("%[[{}%", note_name);
    let pattern2 = format!("%[[{}%", &center_title);

    let mut stmt = conn.prepare(
        "SELECT DISTINCT source_path, link_type FROM links WHERE target_anchor LIKE ?1 OR target_anchor LIKE ?2"
    )?;
    let backlinks: Vec<(String, String)> = stmt
        .query_map(params![&pattern1, &pattern2], |row| {
            Ok((
                row.get(0)?,
                row.get::<_, String>(1)
                    .unwrap_or_else(|_| "explicit".to_string()),
            ))
        })?
        .filter_map(|r| r.ok())
        .filter(|(p, _)| p != note_path)
        .collect();

    for (source_path, link_type) in backlinks {
        // Get source note info
        let source_info: Option<(String, String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT n.title, n.path, COALESCE(n.user_summary, a.summary), COALESCE(n.user_tags, a.tags) FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.path = ?1",
                params![&source_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok();

        let (source_title, source_category, source_summary, source_tags) = match source_info {
            Some((title, path, summary, tags)) => (title, get_category_from_path(&path), summary, tags),
            None => {
                let title = source_path
                    .split('/')
                    .last()
                    .unwrap_or(&source_path)
                    .trim_end_matches(".md")
                    .to_string();
                (title, get_category_from_path(&source_path), None, None)
            }
        };

        let source_in_degree = get_in_degree(conn, &source_title);

        if !node_ids.contains(&source_path) {
            nodes.push(GraphNode {
                id: source_path.clone(),
                label: source_title,
                is_center: false,
                exists: true,
                category: source_category,
                in_degree: source_in_degree,
                node_type: "note".to_string(),
                depth: 0,
                note_count: 0,
                last_active: 0,
                summary: source_summary,
                tags: source_tags,
            });
            node_ids.insert(source_path.clone());
        }

        edges.push(GraphEdge {
            source: source_path,
            target: note_path.to_string(),
            label: None,
            link_type,
        });
    }

    // Generate folder nodes and structural edges
    let note_paths: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let (folder_nodes, structural_edges) = generate_folder_nodes(conn, &note_paths, &node_ids);
    nodes.extend(folder_nodes);
    edges.extend(structural_edges);

    Ok(NoteGraph { nodes, edges })
}

/// Get global graph data showing all notes and their links
pub fn get_global_graph(conn: &Connection) -> SqliteResult<NoteGraph> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let node_ids: std::collections::HashSet<String>;

    // Get all notes
    let all_notes = get_all_notes(conn)?;
    node_ids = all_notes.iter().map(|n| n.path.clone()).collect();

    // Add all notes as nodes
    for note in &all_notes {
        // Calculate in_degree for this note
        let pattern = format!("%[[{}%", &note.title);
        let in_degree: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE target_anchor LIKE ?1",
                params![&pattern],
                |row| row.get(0),
            )
            .unwrap_or(0);

        nodes.push(GraphNode {
            id: note.path.clone(),
            label: note.title.clone(),
            is_center: false,
            exists: true,
            category: get_category_from_path(&note.path),
            in_degree,
            node_type: "note".to_string(),
            depth: 0,
            note_count: 0,
            last_active: 0,
            summary: note
                .user_summary
                .clone()
                .or_else(|| note.ai_summary.clone()),
            tags: note
                .user_tags
                .clone()
                .or_else(|| note.ai_tags.clone()),
        });
    }

    // Get all links
    let mut stmt =
        conn.prepare("SELECT source_path, target_anchor, label, link_type FROM links")?;
    let links: Vec<(String, String, Option<String>, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, String>(3)
                    .unwrap_or_else(|_| "explicit".to_string()),
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Track already-added edges for deduplication: (source, target, label)
    let mut edge_set: std::collections::HashSet<(String, String, Option<String>)> =
        std::collections::HashSet::new();

    for (source_path, target_anchor, label, link_type) in links {
        // Extract target name
        let target_name = target_anchor
            .trim_start_matches("[[")
            .trim_end_matches("]]")
            .split('|')
            .next()
            .unwrap_or(&target_anchor)
            .split('#')
            .next()
            .unwrap_or(&target_anchor)
            .to_string();

        // Try to find target note by title first
        let target_path: Option<String> = conn
            .query_row(
                "SELECT path FROM notes WHERE LOWER(title) = LOWER(?1)",
                params![&target_name],
                |row| row.get(0),
            )
            .ok()
            // Fallback: try matching by file_stem (filename without .md)
            .or_else(|| {
                let pattern = format!("%/{}.md", target_name);
                conn.query_row(
                    "SELECT path FROM notes WHERE LOWER(path) LIKE LOWER(?1) OR LOWER(path) = LOWER(?2)",
                    params![&pattern, &format!("{}.md", target_name)],
                    |row| row.get(0),
                ).ok()
            });

        let target_id = match &target_path {
            Some(path) => path.clone(),
            None => {
                log::debug!(
                    "[global_graph] unresolved: src={}, anchor={}, name={}",
                    source_path, target_anchor, target_name
                );
                target_name.clone()
            }
        };

        // links.label is the sole authority for relation
        let display_label = label;

        // Only add edge if both nodes exist in our set
        if node_ids.contains(&source_path) && node_ids.contains(&target_id) {
            // Deduplicate: skip if same (source, target, label) already exists
            let edge_key = (
                source_path.clone(),
                target_id.clone(),
                display_label.clone(),
            );
            if edge_set.insert(edge_key) {
                edges.push(GraphEdge {
                    source: source_path,
                    target: target_id,
                    label: display_label,
                    link_type,
                });
            }
        }
    }

    // Generate folder nodes and structural edges
    let note_paths: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let (folder_nodes, structural_edges) = generate_folder_nodes(conn, &note_paths, &node_ids);
    nodes.extend(folder_nodes);
    edges.extend(structural_edges);

    Ok(NoteGraph { nodes, edges })
}
