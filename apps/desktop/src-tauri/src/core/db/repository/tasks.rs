use crate::core::db::models::Task;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

// ============================================================================
// TASK FUNCTIONS
// ============================================================================

/// Delete all tasks for a note (before re-scanning)
pub fn delete_tasks_for_note(conn: &Connection, note_path: &str) -> SqliteResult<usize> {
    conn.execute("DELETE FROM tasks WHERE note_path = ?1", params![note_path])
}

/// Insert multiple tasks for a note (after scanning)
pub fn insert_tasks(conn: &Connection, tasks: &[Task]) -> SqliteResult<()> {
    let mut stmt = conn.prepare(
        r#"INSERT INTO tasks (note_path, line_number, raw_text, is_completed, due_date, assignee, priority)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
    )?;

    for task in tasks {
        stmt.execute(params![
            task.note_path,
            task.line_number,
            task.raw_text,
            task.is_completed,
            task.due_date,
            task.assignee,
            task.priority,
        ])?;
    }

    Ok(())
}

/// Get all tasks across all notes
pub fn get_all_tasks(conn: &Connection) -> SqliteResult<Vec<Task>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, note_path, line_number, raw_text, is_completed, 
                  due_date, assignee, priority, created_at, updated_at
           FROM tasks ORDER BY due_date ASC NULLS LAST, created_at DESC"#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Task {
            id: row.get(0)?,
            note_path: row.get(1)?,
            line_number: row.get(2)?,
            raw_text: row.get(3)?,
            is_completed: row.get(4)?,
            due_date: row.get(5)?,
            assignee: row.get(6)?,
            priority: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;

    rows.collect()
}

/// Get tasks for a specific note
/// Supports both absolute path and relative path matching
pub fn get_tasks_for_note(conn: &Connection, note_path: &str) -> SqliteResult<Vec<Task>> {
    // Try exact match first, then suffix match (for absolute vs relative path)
    let pattern = format!(
        "%{}",
        note_path
            .trim_start_matches('/')
            .split('/')
            .last()
            .unwrap_or(note_path)
    );

    let mut stmt = conn.prepare(
        r#"SELECT id, note_path, line_number, raw_text, is_completed, 
                  due_date, assignee, priority, created_at, updated_at
           FROM tasks 
           WHERE note_path = ?1 OR note_path LIKE ?2 OR ?1 LIKE '%' || note_path
           ORDER BY line_number ASC"#,
    )?;

    let rows = stmt.query_map(params![note_path, pattern], |row| {
        Ok(Task {
            id: row.get(0)?,
            note_path: row.get(1)?,
            line_number: row.get(2)?,
            raw_text: row.get(3)?,
            is_completed: row.get(4)?,
            due_date: row.get(5)?,
            assignee: row.get(6)?,
            priority: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;

    rows.collect()
}

/// Filter parameters for task queries
#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct TaskFilter {
    pub due_date: Option<String>,   // Exact date match
    pub assignee: Option<String>,   // Username filter
    pub priority: Option<String>,   // Priority filter
    pub is_completed: Option<bool>, // Completion status
    pub note_path: Option<String>,  // Specific note
}

/// Get tasks matching filter criteria
pub fn get_tasks_by_filter(conn: &Connection, filter: &TaskFilter) -> SqliteResult<Vec<Task>> {
    let mut sql = String::from(
        r#"SELECT id, note_path, line_number, raw_text, is_completed, 
                  due_date, assignee, priority, created_at, updated_at
           FROM tasks WHERE 1=1"#,
    );

    let mut conditions = Vec::new();

    if filter.due_date.is_some() {
        conditions.push(" AND due_date = ?");
    }
    if filter.assignee.is_some() {
        conditions.push(" AND assignee = ?");
    }
    if filter.priority.is_some() {
        conditions.push(" AND priority = ?");
    }
    if filter.is_completed.is_some() {
        conditions.push(" AND is_completed = ?");
    }
    if filter.note_path.is_some() {
        conditions.push(" AND note_path = ?");
    }

    for cond in &conditions {
        sql.push_str(cond);
    }
    sql.push_str(" ORDER BY due_date ASC NULLS LAST, priority DESC, created_at DESC");

    let mut stmt = conn.prepare(&sql)?;

    // Build params dynamically
    let mut param_idx = 1;
    let mut bind_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ref date) = filter.due_date {
        bind_params.push(Box::new(date.clone()));
        param_idx += 1;
    }
    if let Some(ref assignee) = filter.assignee {
        bind_params.push(Box::new(assignee.clone()));
        param_idx += 1;
    }
    if let Some(ref priority) = filter.priority {
        bind_params.push(Box::new(priority.clone()));
        param_idx += 1;
    }
    if let Some(completed) = filter.is_completed {
        bind_params.push(Box::new(completed));
        param_idx += 1;
    }
    if let Some(ref path) = filter.note_path {
        bind_params.push(Box::new(path.clone()));
        let _ = param_idx; // suppress unused warning
    }

    let params_refs: Vec<&dyn rusqlite::ToSql> = bind_params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(Task {
            id: row.get(0)?,
            note_path: row.get(1)?,
            line_number: row.get(2)?,
            raw_text: row.get(3)?,
            is_completed: row.get(4)?,
            due_date: row.get(5)?,
            assignee: row.get(6)?,
            priority: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;

    rows.collect()
}

/// Update task completion status
#[allow(dead_code)]
pub fn update_task_completion(
    conn: &Connection,
    task_id: i64,
    is_completed: bool,
) -> SqliteResult<usize> {
    conn.execute(
        "UPDATE tasks SET is_completed = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![is_completed, task_id],
    )
}

/// Get a single task by ID
#[allow(dead_code)]
pub fn get_task_by_id(conn: &Connection, task_id: i64) -> SqliteResult<Option<Task>> {
    conn.query_row(
        r#"SELECT id, note_path, line_number, raw_text, is_completed, 
                  due_date, assignee, priority, created_at, updated_at
           FROM tasks WHERE id = ?1"#,
        params![task_id],
        |row| {
            Ok(Task {
                id: row.get(0)?,
                note_path: row.get(1)?,
                line_number: row.get(2)?,
                raw_text: row.get(3)?,
                is_completed: row.get(4)?,
                due_date: row.get(5)?,
                assignee: row.get(6)?,
                priority: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .optional()
}

/// Check if note has pending tasks (for hard routing)
pub fn note_has_pending_tasks(conn: &Connection, note_path: &str) -> SqliteResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE note_path = ?1 AND is_completed = 0",
        params![note_path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
