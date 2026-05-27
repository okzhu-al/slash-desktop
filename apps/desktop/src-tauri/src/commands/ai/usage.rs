//! AI Usage Log Commands
//!
//! Tauri 命令：查询 AI 用量日志。

use crate::core::db::repository;
use crate::DbStateWrapper;
use tauri::State;

/// 获取最近 N 条 AI 用量日志
#[tauri::command]
pub fn get_ai_usage_logs(
    db_state: State<'_, DbStateWrapper>,
    limit: Option<usize>,
) -> Result<Vec<repository::UsageLogEntry>, String> {
    db_state
        .0
        .with_connection(|conn| repository::get_ai_usage_logs(conn, limit.unwrap_or(200)))
}
