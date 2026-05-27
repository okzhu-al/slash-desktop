//! AI Usage Logging
//!
//! 记录每次 AI 调用的用量和状态，支持审计追踪和成本统计。

use rusqlite::{params, Connection};

/// 记录一次 AI skill 执行的用量
#[allow(dead_code)]
pub fn log_ai_usage(
    conn: &Connection,
    session_id: &str,
    skill_id: &str,
    provider: &str,
    model: &str,
    note_path: &str,
    status: &str,
    input_chars: Option<usize>,
    output_chars: Option<usize>,
    duration_ms: Option<u64>,
    retry_count: u32,
    error_type: Option<&str>,
    error_message: Option<&str>,
) -> Result<(), String> {
    // 截断 error_message 至 512 chars
    let truncated_error = error_message.map(|msg| if msg.len() > 512 { &msg[..512] } else { msg });

    conn.execute(
        r#"
        INSERT INTO ai_usage_log (
            session_id, skill_id, provider, model, note_path, status,
            input_chars, output_chars, duration_ms,
            retry_count, error_type, error_message
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        "#,
        params![
            session_id,
            skill_id,
            provider,
            model,
            note_path,
            status,
            input_chars.map(|v| v as i64),
            output_chars.map(|v| v as i64),
            duration_ms.map(|v| v as i64),
            retry_count,
            error_type,
            truncated_error,
        ],
    )
    .map_err(|e| format!("Failed to log AI usage: {}", e))?;

    Ok(())
}

/// 生成 session_id（timestamp_ms + 4位随机数）
#[allow(dead_code)]
pub fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand: u16 = (ts % 10000) as u16 ^ 0xBEEF; // Simple deterministic-ish suffix
    format!("{}-{:04x}", ts, rand)
}

/// 用量日志条目（可序列化到前端）
#[derive(Debug, serde::Serialize)]
pub struct UsageLogEntry {
    pub id: i64,
    pub session_id: String,
    pub skill_id: String,
    pub provider: String,
    pub model: String,
    pub note_path: Option<String>,
    pub status: String,
    pub input_chars: Option<i64>,
    pub output_chars: Option<i64>,
    pub duration_ms: Option<i64>,
    pub retry_count: i32,
    pub error_type: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
}

/// 查询最近 N 条用量日志
pub fn get_ai_usage_logs(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<UsageLogEntry>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, session_id, skill_id, provider, model, note_path, status,
               input_chars, output_chars, duration_ms, retry_count,
               error_type, error_message, created_at
        FROM ai_usage_log
        ORDER BY created_at DESC, id DESC
        LIMIT ?1
        "#,
    )?;

    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(UsageLogEntry {
            id: row.get(0)?,
            session_id: row.get(1)?,
            skill_id: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            note_path: row.get(5)?,
            status: row.get(6)?,
            input_chars: row.get(7)?,
            output_chars: row.get(8)?,
            duration_ms: row.get(9)?,
            retry_count: row.get(10)?,
            error_type: row.get(11)?,
            error_message: row.get(12)?,
            created_at: row.get(13)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}
