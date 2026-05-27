// ============================================================
// Phase 6: Transfer Commands — Tauri 命令层
// ============================================================
//
// 前端 → Tauri 的接口：
//   transfer_get_queue      → 获取当前传输队列
//   transfer_enqueue_upload → 入队上传任务
//   transfer_enqueue_download → 入队下载任务
//   transfer_retry_task     → 重试失败任务
//   transfer_clear_completed → 清除已完成任务

use crate::core::transfer_manager::{TransferManager, TransferTask};
use crate::state::DbStateWrapper;

/// 获取当前传输队列（非终态任务）
#[tauri::command]
pub fn transfer_get_queue(
    db: tauri::State<'_, DbStateWrapper>,
) -> Result<Vec<TransferTask>, String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    TransferManager::get_active_queue(conn)
}

/// 入队上传任务
#[tauri::command]
pub fn transfer_enqueue_upload(
    db: tauri::State<'_, DbStateWrapper>,
    app: tauri::AppHandle,
    vault_id: String,
    hash: String,
    asset_path: String,
    total_bytes: u64,
) -> Result<bool, String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    let actually_new = TransferManager::enqueue_upload(conn, &vault_id, &hash, &asset_path, total_bytes)?;
    if actually_new {
        use tauri::Manager;
        if let Some(notify) = app.try_state::<crate::state::TransferNotifyState>() {
            notify.0.notify_one();
        }
    }
    Ok(actually_new)
}

/// 入队下载任务 — 返回 { task_id, action }
#[tauri::command]
pub fn transfer_enqueue_download(
    db: tauri::State<'_, DbStateWrapper>,
    vault_id: String,
    hash: String,
    asset_path: String,
    total_bytes: u64,
) -> Result<(i64, String), String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    let vault_path = db.0.vault_path.lock().unwrap().clone()
        .ok_or("Vault path not set")?;
    let result = TransferManager::enqueue_download(
        conn, &vault_id, &hash, &asset_path, total_bytes, std::path::Path::new(&vault_path)
    )?;
    Ok((result.task_id, result.action.as_str().to_string()))
}

/// 恢复缺失的本地 asset（前端 404 时调用）
#[tauri::command]
pub fn transfer_recover_missing_asset(
    db: tauri::State<'_, DbStateWrapper>,
    app: tauri::AppHandle,
    asset_path: String,
) -> Result<String, String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    let vault_path = db.0.vault_path.lock().unwrap().clone()
        .ok_or("Vault path not set")?;
    let result = TransferManager::recover_missing_asset(
        conn, std::path::Path::new(&vault_path), &asset_path
    )?;
    // 只在 created/revived 时 notify scheduler
    if result.action.needs_notify() {
        use tauri::Manager;
        if let Some(notify) = app.try_state::<crate::state::TransferNotifyState>() {
            notify.0.notify_one();
        }
    }
    Ok(result.action.as_str().to_string())
}

/// 重试失败任务
#[tauri::command]
pub fn transfer_retry_task(
    db: tauri::State<'_, DbStateWrapper>,
    id: i64,
) -> Result<bool, String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    TransferManager::retry_failed(conn, id)
}

/// 清除已完成任务
#[tauri::command]
pub fn transfer_clear_completed(
    db: tauri::State<'_, DbStateWrapper>,
) -> Result<usize, String> {
    let conn_guard = db.0.connection.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("Database not initialized")?;
    TransferManager::clear_completed(conn)
}
