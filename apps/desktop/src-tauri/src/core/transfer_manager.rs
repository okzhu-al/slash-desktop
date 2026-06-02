// ============================================================
// Phase 6: Transfer Manager — 后台资产传输引擎
// ============================================================
//
// 职责：
//   1. 管理 SQLite transfer_queue 中的上传/下载任务
//   2. 与服务端 /sync/assets/* API 交互（分块上传/Range 下载）
//   3. 崩溃恢复：重启后将 active 任务重置为 pending
//   4. 后台 scheduler：notify + 定时 tick 双触发
//   5. 并发控制：max_concurrent=2

use rusqlite::Connection;
use std::path::Path;
use tauri::Emitter;

/// 默认 chunk 大小：4MB
const DEFAULT_CHUNK_SIZE: u64 = 4 * 1024 * 1024;
/// 最大并发传输数
const MAX_CONCURRENT: usize = 2;
/// 最大重试次数
const MAX_RETRIES: i32 = 5;
/// Scheduler tick 间隔（秒）
const TICK_INTERVAL_SECS: u64 = 30;

/// 传输任务
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransferTask {
    pub id: i64,
    pub vault_id: String,
    pub hash: String,
    pub asset_path: String,
    pub direction: String,   // "upload" | "download"
    pub status: String,      // pending, active, paused, completed, failed
    pub upload_id: Option<String>,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub chunk_size: u64,
    pub retry_count: i32,
    pub max_retries: i32,
    pub error_message: Option<String>,
}

/// Download 入队操作的结果类型
#[derive(Debug, Clone, PartialEq)]
pub enum DownloadAction {
    /// 全新入队
    Created,
    /// completed/failed → pending（本地文件缺失或无效）
    Revived,
    /// completed + 本地文件有效 → 跳过
    SkippedLocalValid,
    /// pending/active → 跳过（任务进行中）
    SkippedInflight,
}

impl DownloadAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Revived => "revived",
            Self::SkippedLocalValid => "skipped_local_valid",
            Self::SkippedInflight => "skipped_inflight",
        }
    }
    /// 是否需要 notify scheduler
    pub fn needs_notify(&self) -> bool {
        matches!(self, Self::Created | Self::Revived)
    }
}

/// Download 入队操作的完整返回值
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DownloadEnqueueResult {
    pub task_id: i64,
    pub action: DownloadAction,
    pub expected_size: u64,
    pub local_size: u64,
}

/// 传输管理器（静态方法集合 + scheduler 启动）
pub struct TransferManager;

impl TransferManager {
    // ============================================================
    // SQLite 队列操作
    // ============================================================

    /// 崩溃恢复：将所有 active 任务重置为 pending
    pub fn recover_active_tasks(conn: &Connection) -> Result<usize, String> {
        let count = conn.execute(
            "UPDATE transfer_queue SET status = 'pending', upload_id = NULL, updated_at = unixepoch() WHERE status = 'active'",
            [],
        ).map_err(|e| format!("Failed to recover active tasks: {e}"))?;
        if count > 0 {
            log::info!("🔄 [TransferManager] recovered {} active tasks → pending", count);
        }

        // 🧹 脏数据清理：删除 total_bytes=0 的 completed upload 记录
        // 这些是 Phase 6 方向判定 bug 遗留的无效记录（0 字节占位文件误入 upload 队列）
        let dirty = conn.execute(
            "DELETE FROM transfer_queue WHERE direction = 'upload' AND status = 'completed' AND total_bytes = 0 AND asset_path LIKE 'assets/%'",
            [],
        ).map_err(|e| format!("Failed to clean dirty records: {e}"))?;
        if dirty > 0 {
            log::info!("🧹 [TransferManager] cleaned {} dirty upload records (completed with 0 bytes)", dirty);
        }

        Ok(count)
    }

    /// 检查是否应跳过 upload enqueue（任何非 failed 状态的记录都不需要重新入队）
    /// 🛡️ total_bytes=0 的 completed upload 被视为脏数据，不阻止重新入队
    pub fn should_skip_upload_enqueue(conn: &Connection, vault_id: &str, hash: &str) -> bool {
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM transfer_queue WHERE vault_id = ?1 AND hash = ?2 AND direction = 'upload' AND (\
                (status IN ('pending', 'active')) OR \
                (status = 'completed' AND total_bytes > 0)\
            )",
            rusqlite::params![vault_id, hash],
            |row| row.get(0),
        ).unwrap_or(0);
        count > 0
    }

    /// 入队上传任务（仅当不存在 pending/active/completed 记录时才会真正插入）
    /// 返回 Ok(true) 表示真正新入队，Ok(false) 表示兜底跳过
    pub fn enqueue_upload(
        conn: &Connection,
        vault_id: &str,
        hash: &str,
        asset_path: &str,
        total_bytes: u64,
    ) -> Result<bool, String> {
        // 🛡️ 硬保护：0 字节 asset 绝不允许 upload（说明本地无 blob，应走 download）
        if total_bytes == 0 {
            log::error!(
                "[TransferManager] 🚫 rejected upload with total_bytes=0: path={} hash={}",
                asset_path, hash
            );
            return Err("Cannot upload 0-byte asset (local blob missing, should be download)".into());
        }

        log::info!(
            "[TransferManager] enqueue upload requested: vault={} hash={} path={} size={}",
            &vault_id[..8.min(vault_id.len())], hash, asset_path, total_bytes
        );

        // 兜底幂等检查：任何非 failed 状态的记录都不需要重新入队
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM transfer_queue WHERE vault_id = ?1 AND hash = ?2 AND direction = 'upload' AND status IN ('pending', 'active', 'completed')",
            rusqlite::params![vault_id, hash],
            |row| row.get(0),
        ).ok();

        if let Some(id) = existing {
            log::debug!("[TransferManager] Upload task already exists (idempotent skip): id={} hash={}", id, hash);
            return Ok(false);
        }

        // INSERT — ON CONFLICT 仅对 failed 状态重置（不会把 completed 打回 pending）
        conn.execute(
            "INSERT INTO transfer_queue (vault_id, hash, asset_path, direction, status, total_bytes, chunk_size, max_retries) \
             VALUES (?1, ?2, ?3, 'upload', 'pending', ?4, ?5, ?6) \
             ON CONFLICT(vault_id, hash, direction) DO UPDATE SET status = 'pending', error_message = NULL, retry_count = 0, updated_at = unixepoch() WHERE status = 'failed'",
            rusqlite::params![vault_id, hash, asset_path, total_bytes as i64, DEFAULT_CHUNK_SIZE as i64, MAX_RETRIES],
        ).map_err(|e| format!("Failed to enqueue upload: {e}"))?;

        let id = conn.last_insert_rowid();
        log::info!("📤 [TransferManager] upload enqueued: id={} path={} size={} status=pending", id, asset_path, total_bytes);
        Ok(true)
    }

    /// 入队下载任务
    /// 幂等规则：
    ///   - pending/active: SkippedInflight
    ///   - completed + local valid: SkippedLocalValid
    ///   - completed + local missing/invalid: Revived
    ///   - failed: Revived
    ///   - 无记录: Created
    pub fn enqueue_download(
        conn: &Connection,
        vault_id: &str,
        hash: &str,
        asset_path: &str,
        total_bytes: u64,
        vault_path: &Path,
    ) -> Result<DownloadEnqueueResult, String> {
        log::info!(
            "[TransferManager] enqueue download requested: vault={} hash={} path={} size={}",
            &vault_id[..8.min(vault_id.len())], hash, asset_path, total_bytes
        );

        // 查询已有记录
        let existing: Option<(i64, String, i64)> = conn.query_row(
            "SELECT id, status, total_bytes FROM transfer_queue WHERE vault_id = ?1 AND hash = ?2 AND direction = 'download'",
            rusqlite::params![vault_id, hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok();

        // 本地文件状态（所有分支共用）
        let local_path = vault_path.join(asset_path);
        let local_exists = local_path.exists();
        let local_size = if local_exists {
            std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };

        if let Some((id, status, existing_bytes)) = existing {
            let expected = if total_bytes > 0 { total_bytes } else { existing_bytes as u64 };
            match status.as_str() {
                "pending" | "active" => {
                    log::info!(
                        "[TransferManager] download skip ({}): id={} hash={}",
                        status, id, hash
                    );
                    return Ok(DownloadEnqueueResult {
                        task_id: id,
                        action: DownloadAction::SkippedInflight,
                        expected_size: expected,
                        local_size,
                    });
                }
                "completed" => {
                    // 🛡️ completed 不是永久去重依据 — 必须检查本地文件实际存在性
                    let is_valid = local_exists
                        && local_size > 0
                        && (expected == 0 || local_size == expected);

                    if is_valid {
                        log::info!(
                            "[TransferManager] download skip (completed, local valid): id={} path={} local_size={}",
                            id, asset_path, local_size
                        );
                        return Ok(DownloadEnqueueResult {
                            task_id: id,
                            action: DownloadAction::SkippedLocalValid,
                            expected_size: expected,
                            local_size,
                        });
                    }

                    // 本地文件缺失/无效 → revive
                    Self::revive_download_task(conn, id, expected, vault_path, asset_path)?;
                    log::info!(
                        "🔄 [TransferManager] download revived (completed but local missing): id={} path={} local_exists={} local_size={} expected={}",
                        id, asset_path, local_exists, local_size, expected
                    );
                    return Ok(DownloadEnqueueResult {
                        task_id: id,
                        action: DownloadAction::Revived,
                        expected_size: expected,
                        local_size,
                    });
                }
                "failed" => {
                    // failed → revive
                    Self::revive_download_task(conn, id, expected, vault_path, asset_path)?;
                    log::info!(
                        "🔄 [TransferManager] download revived (failed): id={} path={}",
                        id, asset_path
                    );
                    return Ok(DownloadEnqueueResult {
                        task_id: id,
                        action: DownloadAction::Revived,
                        expected_size: expected,
                        local_size,
                    });
                }
                _ => {
                    log::warn!("[TransferManager] unknown status '{}' for download id={}, will insert new", status, id);
                }
            }
        }

        // 无记录 → 新建
        conn.execute(
            "INSERT INTO transfer_queue (vault_id, hash, asset_path, direction, status, total_bytes, chunk_size, max_retries) \
             VALUES (?1, ?2, ?3, 'download', 'pending', ?4, ?5, ?6) \
             ON CONFLICT(vault_id, hash, direction) DO UPDATE SET \
             status = 'pending', transferred_bytes = 0, error_message = NULL, \
             retry_count = 0, total_bytes = ?4, updated_at = unixepoch()",
            rusqlite::params![vault_id, hash, asset_path, total_bytes as i64, DEFAULT_CHUNK_SIZE as i64, MAX_RETRIES],
        ).map_err(|e| format!("Failed to enqueue download: {e}"))?;

        let id = conn.last_insert_rowid();
        log::info!("📥 [TransferManager] Download enqueued: id={} path={} size={}", id, asset_path, total_bytes);
        Ok(DownloadEnqueueResult {
            task_id: id,
            action: DownloadAction::Created,
            expected_size: total_bytes,
            local_size,
        })
    }

    /// 复活下载任务：重置状态 + 清理 .part 临时文件
    fn revive_download_task(
        conn: &Connection,
        id: i64,
        total_bytes: u64,
        vault_path: &Path,
        asset_path: &str,
    ) -> Result<(), String> {
        conn.execute(
            "UPDATE transfer_queue SET status = 'pending', transferred_bytes = 0, \
             total_bytes = ?1, error_message = NULL, retry_count = 0, \
             updated_at = unixepoch() WHERE id = ?2",
            rusqlite::params![total_bytes as i64, id],
        ).map_err(|e| format!("Failed to revive download: {e}"))?;

        // 清理 .part 临时文件（如果存在）
        let part_path = vault_path.join(format!("{}.part", asset_path));
        if part_path.exists() {
            if let Err(e) = std::fs::remove_file(&part_path) {
                log::warn!("[TransferManager] failed to clean .part file: {} err={}", part_path.display(), e);
            } else {
                log::info!("[TransferManager] cleaned .part file: {}", part_path.display());
            }
        }
        Ok(())
    }

    /// 恢复缺失的本地 asset：查找合法记录并 revive/enqueue download
    ///
    /// 查找优先级：
    ///   1. unified_sync_state (team_hash)
    ///   2. unified_sync_state (personal_hash)
    ///   3. transfer_queue 已有记录 (fallback)
    ///
    /// 找到合法 vault_id + hash 后 enqueue_download。
    /// 找不到返回 Err("NotRecoverable")。
    pub fn recover_missing_asset(
        conn: &Connection,
        vault_path: &Path,
        asset_path: &str,
    ) -> Result<DownloadEnqueueResult, String> {
        // 验证路径合法性
        if !asset_path.starts_with("assets/") && !asset_path.starts_with(".slash/assets/") {
            log::warn!("[TransferManager] recover_missing_asset: invalid path '{}', must start with assets/", asset_path);
            return Err("NotRecoverable: invalid asset path".into());
        }

        // 检查本地文件 — 如果已存在且有效，无需恢复
        let local_path = vault_path.join(asset_path);
        if local_path.exists() {
            let size = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            if size > 0 {
                log::info!("[TransferManager] recover_missing_asset: local file already valid, skip: path={} size={}", asset_path, size);
                return Err("NotRecoverable: local file already exists and valid".into());
            }
        }

        // 优先级 1: unified_sync_state — team_hash
        let state = crate::commands::sync::state::load_unified_state(vault_path);
        if let Some(file_state) = state.get(asset_path) {
            if !file_state.team_hash.is_empty() {
                // 从 transfer_queue 查找 vault_id
                let vault_id = Self::find_vault_id_for_hash(conn, &file_state.team_hash, "download")
                    .or_else(|| Self::find_vault_id_for_hash(conn, &file_state.team_hash, "upload"))
                    .or_else(|| Self::find_any_vault_id(conn));

                if let Some(vid) = vault_id {
                    log::info!(
                        "[TransferManager] recover via unified_state team_hash: path={} hash={} vault={}",
                        asset_path, &file_state.team_hash[..8.min(file_state.team_hash.len())], &vid[..8.min(vid.len())]
                    );
                    return Self::enqueue_download(conn, &vid, &file_state.team_hash, asset_path, 0, vault_path);
                }
            }
            // 优先级 2: personal_hash
            if !file_state.personal_hash.is_empty() {
                let vault_id = Self::find_vault_id_for_hash(conn, &file_state.personal_hash, "download")
                    .or_else(|| Self::find_vault_id_for_hash(conn, &file_state.personal_hash, "upload"))
                    .or_else(|| Self::find_any_vault_id(conn));

                if let Some(vid) = vault_id {
                    log::info!(
                        "[TransferManager] recover via unified_state personal_hash: path={} hash={} vault={}",
                        asset_path, &file_state.personal_hash[..8.min(file_state.personal_hash.len())], &vid[..8.min(vid.len())]
                    );
                    return Self::enqueue_download(conn, &vid, &file_state.personal_hash, asset_path, 0, vault_path);
                }
            }
        }

        // 优先级 3: transfer_queue fallback — 查找该 asset_path 的最近一条记录
        let fallback: Option<(String, String, i64)> = conn.query_row(
            "SELECT vault_id, hash, total_bytes FROM transfer_queue WHERE asset_path = ?1 AND direction = 'download' ORDER BY updated_at DESC LIMIT 1",
            rusqlite::params![asset_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok();

        if let Some((vid, hash, size)) = fallback {
            log::info!(
                "[TransferManager] recover via transfer_queue fallback: path={} hash={} vault={}",
                asset_path, &hash[..8.min(hash.len())], &vid[..8.min(vid.len())]
            );
            return Self::enqueue_download(conn, &vid, &hash, asset_path, size as u64, vault_path);
        }

        log::warn!(
            "[TransferManager] ⚠️ recover_missing_asset: no recoverable record found for '{}'",
            asset_path
        );
        Err("NotRecoverable: no sync state or transfer record found".into())
    }

    /// 辅助：从 transfer_queue 查找给定 hash 的 vault_id
    fn find_vault_id_for_hash(conn: &Connection, hash: &str, direction: &str) -> Option<String> {
        conn.query_row(
            "SELECT vault_id FROM transfer_queue WHERE hash = ?1 AND direction = ?2 ORDER BY updated_at DESC LIMIT 1",
            rusqlite::params![hash, direction],
            |row| row.get(0),
        ).ok()
    }

    /// 辅助：从 transfer_queue 获取任意 vault_id（最后手段）
    fn find_any_vault_id(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT DISTINCT vault_id FROM transfer_queue ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        ).ok()
    }

    /// 原子 claim：将 pending → active，返回被 claim 的任务（短事务）
    fn claim_pending_tasks(conn: &Connection, limit: usize) -> Result<Vec<TransferTask>, String> {
        // 先标记
        conn.execute(
            "UPDATE transfer_queue SET status = 'active', updated_at = unixepoch() \
             WHERE id IN (SELECT id FROM transfer_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?1)",
            rusqlite::params![limit as i64],
        ).map_err(|e| format!("claim failed: {e}"))?;

        // 再读取刚 claimed 的
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, hash, asset_path, direction, status, upload_id, \
             total_bytes, transferred_bytes, chunk_size, retry_count, max_retries, error_message \
             FROM transfer_queue WHERE status = 'active' ORDER BY created_at ASC LIMIT ?1"
        ).map_err(|e| format!("prepare failed: {e}"))?;

        let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok(TransferTask {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                hash: row.get(2)?,
                asset_path: row.get(3)?,
                direction: row.get(4)?,
                status: row.get(5)?,
                upload_id: row.get(6)?,
                total_bytes: row.get::<_, i64>(7)? as u64,
                transferred_bytes: row.get::<_, i64>(8)? as u64,
                chunk_size: row.get::<_, i64>(9)? as u64,
                retry_count: row.get(10)?,
                max_retries: row.get(11)?,
                error_message: row.get(12)?,
            })
        }).map_err(|e| format!("query failed: {e}"))?;

        let mut result = Vec::new();
        for r in rows { if let Ok(t) = r { result.push(t); } }
        Ok(result)
    }

    /// 获取所有非终态任务（用于 UI 展示）
    pub fn get_active_queue(conn: &Connection) -> Result<Vec<TransferTask>, String> {
        let mut stmt = conn.prepare(
            "SELECT id, vault_id, hash, asset_path, direction, status, upload_id, \
             total_bytes, transferred_bytes, chunk_size, retry_count, max_retries, error_message \
             FROM transfer_queue WHERE status NOT IN ('completed') ORDER BY created_at ASC"
        ).map_err(|e| format!("Failed to prepare query: {e}"))?;

        let tasks = stmt.query_map([], |row| {
            Ok(TransferTask {
                id: row.get(0)?, vault_id: row.get(1)?, hash: row.get(2)?,
                asset_path: row.get(3)?, direction: row.get(4)?, status: row.get(5)?,
                upload_id: row.get(6)?,
                total_bytes: row.get::<_, i64>(7)? as u64,
                transferred_bytes: row.get::<_, i64>(8)? as u64,
                chunk_size: row.get::<_, i64>(9)? as u64,
                retry_count: row.get(10)?, max_retries: row.get(11)?,
                error_message: row.get(12)?,
            })
        }).map_err(|e| format!("Failed to query queue: {e}"))?;

        let mut result = Vec::new();
        for task in tasks { if let Ok(t) = task { result.push(t); } }
        Ok(result)
    }

    /// 标记任务状态
    pub fn update_task_status(conn: &Connection, id: i64, status: &str, error: Option<&str>) -> Result<(), String> {
        conn.execute(
            "UPDATE transfer_queue SET status = ?1, error_message = ?2, updated_at = unixepoch() WHERE id = ?3",
            rusqlite::params![status, error, id],
        ).map_err(|e| format!("Failed to update task status: {e}"))?;
        Ok(())
    }

    /// 更新传输进度
    pub fn update_progress(conn: &Connection, id: i64, transferred_bytes: u64) -> Result<(), String> {
        conn.execute(
            "UPDATE transfer_queue SET transferred_bytes = ?1, updated_at = unixepoch() WHERE id = ?2",
            rusqlite::params![transferred_bytes as i64, id],
        ).map_err(|e| format!("Failed to update progress: {e}"))?;
        Ok(())
    }

    /// 保存 upload_id（init 后回填）
    pub fn save_upload_id(conn: &Connection, id: i64, upload_id: &str) -> Result<(), String> {
        conn.execute(
            "UPDATE transfer_queue SET upload_id = ?1, updated_at = unixepoch() WHERE id = ?2",
            rusqlite::params![upload_id, id],
        ).map_err(|e| format!("Failed to save upload_id: {e}"))?;
        Ok(())
    }

    /// 重试失败任务
    pub fn retry_failed(conn: &Connection, id: i64) -> Result<bool, String> {
        let affected = conn.execute(
            "UPDATE transfer_queue SET status = 'pending', retry_count = retry_count + 1, error_message = NULL, updated_at = unixepoch() \
             WHERE id = ?1 AND status = 'failed' AND retry_count < max_retries",
            rusqlite::params![id],
        ).map_err(|e| format!("Failed to retry task: {e}"))?;
        Ok(affected > 0)
    }

    /// 清除已完成的任务
    pub fn clear_completed(conn: &Connection) -> Result<usize, String> {
        let count = conn.execute("DELETE FROM transfer_queue WHERE status = 'completed'", [])
            .map_err(|e| format!("Failed to clear completed: {e}"))?;
        Ok(count)
    }

    // ============================================================
    // Scheduler
    // ============================================================

    /// 启动后台 scheduler loop（在 app setup 中调用一次）
    pub fn start_scheduler(app: tauri::AppHandle) {
        let notify = {
            use tauri::Manager;
            app.state::<crate::state::TransferNotifyState>().0.clone()
        };

        tauri::async_runtime::spawn(async move {
            log::info!("🚀 [TransferScheduler] scheduler started (tick={}s, max_concurrent={})", TICK_INTERVAL_SECS, MAX_CONCURRENT);
            let tick_duration = tokio::time::Duration::from_secs(TICK_INTERVAL_SECS);

            loop {
                // 双触发：notify 或 30s tick
                tokio::select! {
                    _ = notify.notified() => {
                        log::debug!("[TransferScheduler] ⚡ woken by notify");
                    }
                    _ = tokio::time::sleep(tick_duration) => {
                        log::trace!("[TransferScheduler] periodic tick");
                    }
                }

                Self::process_tick(&app).await;
            }
        });
    }

    /// 单次 tick：claim pending 任务并执行
    async fn process_tick(app: &tauri::AppHandle) {
        use tauri::Manager;

        // 1. 读取凭据
        let (server_url, access_token) = {
            let session = app.state::<crate::state::SessionStateWrapper>();
            let s = session.0.lock().unwrap();
            match (&s.active_server_url, &s.cached_access_token) {
                (Some(u), Some(t)) => (u.clone(), t.clone()),
                _ => {
                    log::debug!("[TransferScheduler] tick skipped: no active session (server_url={}, token={})",
                        s.active_server_url.is_some(), s.cached_access_token.is_some());
                    return;
                }
            }
        };

        // 2. 读取 vault_path
        let vault_path = {
            let db = app.state::<crate::state::DbStateWrapper>();
            let guard = db.0.vault_path.lock().unwrap();
            guard.clone()
        };
        let vault_path = match vault_path {
            Some(p) => p,
            None => {
                log::debug!("[TransferScheduler] tick skipped: vault_path not set");
                return;
            }
        };

        // 3. 查询当前队列状态，计算可用容量
        let (pending_count, active_count) = {
            let db = app.state::<crate::state::DbStateWrapper>();
            let conn_guard = db.0.connection.lock().unwrap();
            match conn_guard.as_ref() {
                Some(conn) => {
                    let pending: i32 = conn.query_row(
                        "SELECT COUNT(*) FROM transfer_queue WHERE status = 'pending'", [],
                        |row| row.get(0),
                    ).unwrap_or(0);
                    let active: i32 = conn.query_row(
                        "SELECT COUNT(*) FROM transfer_queue WHERE status = 'active'", [],
                        |row| row.get(0),
                    ).unwrap_or(0);
                    (pending, active)
                }
                None => {
                    log::debug!("[TransferScheduler] tick skipped: DB connection not available");
                    return;
                }
            }
        };

        let capacity = (MAX_CONCURRENT as i32 - active_count).max(0) as usize;
        // 空队列 tick 是健康轮询，不进入日常 debug 日志。
        if pending_count == 0 && active_count == 0 {
            log::trace!("[TransferScheduler] tick: pending=0 active=0 capacity={}", capacity);
        } else {
            log::info!("[TransferScheduler] tick: pending={} active={} capacity={}", pending_count, active_count, capacity);
        }

        if pending_count == 0 {
            return;
        }
        if capacity == 0 {
            log::info!("[TransferScheduler] no capacity (active={}/{}), skipped", active_count, MAX_CONCURRENT);
            return;
        }

        // 4. Claim pending tasks（短事务，立即释放 DB lock）
        let tasks = {
            let db = app.state::<crate::state::DbStateWrapper>();
            let conn_guard = db.0.connection.lock().unwrap();
            match conn_guard.as_ref() {
                Some(conn) => match Self::claim_pending_tasks(conn, capacity) {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("[TransferScheduler] claim error: {e}");
                        return;
                    }
                },
                None => return,
            }
        }; // DB lock released here

        if tasks.is_empty() {
            log::warn!("[TransferScheduler] no task claimed despite pending={}, capacity={}", pending_count, capacity);
            return;
        }

        log::info!("[TransferScheduler] 🎯 claimed {} task(s)", tasks.len());

        // 5. 逐个执行（串行，不持有 DB lock）
        for task in &tasks {
            log::info!(
                "[TransferScheduler] ▶️ executing task id={} dir={} hash={} path={}",
                task.id, task.direction, task.hash, task.asset_path
            );

            let result = if task.direction == "upload" {
                Self::execute_upload_full(task, &vault_path, &server_url, &access_token, app).await
            } else {
                Self::execute_download(task, &vault_path, &server_url, &access_token, app).await
            };

            // 6. 回写结果（重新获取 DB lock）
            let mut download_completed = false;
            {
                let db = app.state::<crate::state::DbStateWrapper>();
                let conn_guard = db.0.connection.lock().unwrap();
                if let Some(conn) = conn_guard.as_ref() {
                    match result {
                        Ok(()) => {
                            let _ = Self::update_progress(conn, task.id, task.total_bytes);
                            let _ = Self::update_task_status(conn, task.id, "completed", None);
                            log::info!("✅ [TransferScheduler] task {} completed: {} ({} bytes)", task.id, task.asset_path, task.total_bytes);
                            if task.direction == "download" {
                                download_completed = true;
                            }
                        }
                        Err(ref e) => {
                            if task.retry_count + 1 < task.max_retries {
                                let _ = Self::update_task_status(conn, task.id, "pending", Some(e));
                                log::warn!("⚠️ [TransferScheduler] task {} failed (will retry {}/{}): {}", task.id, task.retry_count + 1, task.max_retries, e);
                                // increment retry_count
                                let _ = conn.execute(
                                    "UPDATE transfer_queue SET retry_count = retry_count + 1, updated_at = unixepoch() WHERE id = ?1",
                                    rusqlite::params![task.id],
                                );
                            } else {
                                let _ = Self::update_task_status(conn, task.id, "failed", Some(e));
                                log::error!("❌ [TransferScheduler] task {} permanently failed: {}", task.id, e);
                            }
                        }
                    }
                }
            } // DB lock released

            // 🔔 [Phase 6] Download 完成后通知前端触发 PersonalSync
            // 确保 Team 下载的 asset 被同步到 Personal vault（内容闭包完整性）
            if download_completed {
                log::info!(
                    "[TransferScheduler] 📤 download completed, emitting transfer:download-completed for asset closure sync: {}",
                    task.asset_path
                );
                let _ = app.emit("transfer:download-completed", serde_json::json!({
                    "vault_id": task.vault_id,
                    "hash": task.hash,
                    "asset_path": task.asset_path,
                }));

                // 🛡️ 更新 unified sync state：标记为 pulled asset 而非 local edit
                // 避免下轮 TeamSync 将该 asset 误判为 no_state/local_edit → upload
                {
                    let vault_root = std::path::Path::new(&vault_path);
                    let mut state = crate::commands::sync::state::load_unified_state(vault_root);
                    let entry = state.entry(task.asset_path.clone()).or_default();
                    entry.team_hash = task.hash.clone();
                    entry.local_snapshot = task.hash.clone();
                    crate::commands::sync::state::save_unified_state(vault_root, &state);
                    log::info!(
                        "[TransferScheduler] 📝 unified state updated: path={} team_hash={} local_snapshot={}",
                        task.asset_path, &task.hash[..8.min(task.hash.len())], &task.hash[..8.min(task.hash.len())]
                    );
                }
            }
        }
    }

    // ============================================================
    // 上传执行逻辑（完整流程）
    // ============================================================

    async fn execute_upload_full(
        task: &TransferTask,
        vault_path: &Path,
        server_url: &str,
        access_token: &str,
        app: &tauri::AppHandle,
    ) -> Result<(), String> {
        let client = reqwest::Client::new();
        let base = server_url.trim_end_matches('/');

        // 读取本地文件
        let file_path = vault_path.join(&task.asset_path);
        if !file_path.exists() {
            return Err(format!("Local file not found: {}", file_path.display()));
        }
        let file_data = tokio::fs::read(&file_path).await
            .map_err(|e| format!("Failed to read file: {e}"))?;
        let file_size = file_data.len() as u64;

        // 如果已有 upload_id，先检查 session 状态
        let upload_id = if let Some(ref existing_uid) = task.upload_id {
            log::debug!("[TransferManager] checking existing upload session: {}", existing_uid);
            let status_resp = client.get(format!("{base}/api/sync/assets/uploads/{existing_uid}/status"))
                .header("Authorization", format!("Bearer {access_token}"))
                .send().await;

            match status_resp {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(st) = resp.json::<slash_sync_proto::UploadStatusResponse>().await {
                        if st.expired {
                            log::debug!("[TransferManager] session expired, re-init");
                            Self::init_upload(&client, base, access_token, task, file_size).await?
                        } else {
                            log::debug!("[TransferManager] resuming session {} (received={})", existing_uid, st.received_bytes);
                            existing_uid.clone()
                        }
                    } else {
                        Self::init_upload(&client, base, access_token, task, file_size).await?
                    }
                }
                _ => Self::init_upload(&client, base, access_token, task, file_size).await?,
            }
        } else {
            Self::init_upload(&client, base, access_token, task, file_size).await?
        };

        // 检查 init 返回 "CAS_DEDUP" 标记
        if upload_id == "CAS_DEDUP" {
            return Ok(());
        }

        // 保存 upload_id 到 DB
        {
            use tauri::Manager;
            let db = app.state::<crate::state::DbStateWrapper>();
            let conn_guard = db.0.connection.lock().unwrap();
            if let Some(conn) = conn_guard.as_ref() {
                let _ = Self::save_upload_id(conn, task.id, &upload_id);
            }
        }

        // 分块上传
        let chunk_size = task.chunk_size as usize;
        let total_chunks = (file_size as usize + chunk_size - 1) / chunk_size;
        log::debug!("[TransferManager] uploading {} chunks (chunk_size={}) for {}", total_chunks, chunk_size, task.asset_path);

        for i in 0..total_chunks {
            let start = i * chunk_size;
            let end = ((i + 1) * chunk_size).min(file_data.len());
            let chunk = &file_data[start..end];

            let resp = client.put(format!("{base}/api/sync/assets/chunk/{upload_id}?index={i}"))
                .header("Authorization", format!("Bearer {access_token}"))
                .body(chunk.to_vec())
                .send().await
                .map_err(|e| format!("Chunk {i} upload failed: {e}"))?;

            if !resp.status().is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Chunk {i} HTTP error: {body}"));
            }

            let transferred = end as u64;
            log::debug!("[TransferManager] chunk {}/{} uploaded for {} ({} bytes)", i + 1, total_chunks, task.asset_path, transferred);

            // 更新进度（重新获取 DB lock）
            {
                use tauri::Manager;
                let db = app.state::<crate::state::DbStateWrapper>();
                let conn_guard = db.0.connection.lock().unwrap();
                if let Some(conn) = conn_guard.as_ref() {
                    let _ = Self::update_progress(conn, task.id, transferred);
                }
            }
        }

        // Commit
        log::debug!("[TransferManager] committing upload session {}", upload_id);
        let resp = client.post(format!("{base}/api/sync/assets/commit/{upload_id}"))
            .header("Authorization", format!("Bearer {access_token}"))
            .send().await
            .map_err(|e| format!("Upload commit failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Commit HTTP error: {body}"));
        }

        let commit_resp: slash_sync_proto::UploadCommitResponse = resp.json().await
            .map_err(|e| format!("Commit parse failed: {e}"))?;

        if !commit_resp.success {
            return Err(format!("Commit rejected: {}", commit_resp.error.unwrap_or_default()));
        }

        log::info!("✅ [TransferManager] upload complete: {} ({} bytes, hash={})", task.asset_path, file_size, task.hash);
        Ok(())
    }

    /// Init upload session, returns upload_id or "CAS_DEDUP" if already_exists
    async fn init_upload(
        client: &reqwest::Client,
        base: &str,
        access_token: &str,
        task: &TransferTask,
        file_size: u64,
    ) -> Result<String, String> {
        // asset_id 必须与 Fast Sync push 声明的一致（extract_asset_refs 生成的 filename）
        // 例如：asset_path = "assets/abc123.MP4" → asset_id = "abc123.MP4"
        let asset_id = std::path::Path::new(&task.asset_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| task.hash.clone());

        log::debug!("[TransferManager] init upload: asset_id={} hash={} size={}", asset_id, task.hash, file_size);

        let init_req = slash_sync_proto::UploadInitRequest {
            vault_id: task.vault_id.clone(),
            asset_id,
            hash: task.hash.clone(),
            owner_file_id: String::new(), // 服务端从 file_assets 反查
            size: file_size,
            kind: String::new(),
            original_name: std::path::Path::new(&task.asset_path)
                .file_name().map(|n| n.to_string_lossy().to_string()),
        };

        let resp = client.post(format!("{base}/api/sync/assets/init"))
            .header("Authorization", format!("Bearer {access_token}"))
            .json(&init_req)
            .send().await
            .map_err(|e| format!("Upload init failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Upload init HTTP error: {body}"));
        }

        let init_resp: slash_sync_proto::UploadInitResponse = resp.json().await
            .map_err(|e| format!("Upload init parse failed: {e}"))?;

        if init_resp.already_exists {
            log::info!("[TransferManager] CAS dedup hit for hash={}", task.hash);
            return Ok("CAS_DEDUP".to_string());
        }

        log::debug!("[TransferManager] init success: upload_id={}", init_resp.upload_id);
        Ok(init_resp.upload_id)
    }

    // ============================================================
    // 下载执行逻辑
    // ============================================================

    async fn execute_download(
        task: &TransferTask,
        vault_path: &Path,
        server_url: &str,
        access_token: &str,
        app: &tauri::AppHandle,
    ) -> Result<(), String> {
        let client = reqwest::Client::new();
        let base = server_url.trim_end_matches('/');

        let head_resp = client.head(format!("{base}/api/sync/assets/blob/{}/{}", task.vault_id, task.hash))
            .header("Authorization", format!("Bearer {access_token}"))
            .send().await
            .map_err(|e| format!("Blob HEAD failed: {e}"))?;

        let ready = head_resp.headers()
            .get("x-blob-ready")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("false");

        if ready != "true" {
            return Err("Blob not yet available on server".into());
        }

        let total_size: u64 = head_resp.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        log::info!(
            "[TransferManager] download HEAD ok: size={} path={} hash={}",
            total_size, task.asset_path, task.hash
        );

        // 🛡️ HEAD 成功后立即回写真实 total_bytes 到 transfer_queue
        if total_size > 0 {
            use tauri::Manager;
            let db = app.state::<crate::state::DbStateWrapper>();
            let conn_guard = db.0.connection.lock().unwrap();
            if let Some(conn) = conn_guard.as_ref() {
                let _ = conn.execute(
                    "UPDATE transfer_queue SET total_bytes = ?1, updated_at = unixepoch() WHERE id = ?2",
                    rusqlite::params![total_size as i64, task.id],
                );
            }
            drop(conn_guard);
        }

        let dest_path = crate::commands::sync::helpers::validate_path_in_vault(
            &vault_path.join(&task.asset_path),
            vault_path,
        ).map_err(|e| format!("Path traversal validation failed: {}", e))?;

        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await
                .map_err(|e| format!("Failed to create dir: {e}"))?;
        }

        let mut file = tokio::fs::File::create(&dest_path).await
            .map_err(|e| format!("Failed to create file: {e}"))?;

        let chunk_size = task.chunk_size;
        let total_chunks = if total_size > 0 { (total_size + chunk_size - 1) / chunk_size } else { 1 };
        let mut downloaded: u64 = 0;
        let mut chunk_idx: u64 = 0;

        log::debug!("[TransferManager] downloading {} chunks (chunk_size={}) for {} ({} bytes)", total_chunks, chunk_size, task.asset_path, total_size);

        while downloaded < total_size {
            let end = (downloaded + chunk_size - 1).min(total_size - 1);
            let resp = client.get(format!("{base}/api/sync/assets/blob/{}/{}", task.vault_id, task.hash))
                .header("Authorization", format!("Bearer {access_token}"))
                .header("Range", format!("bytes={}-{}", downloaded, end))
                .send().await
                .map_err(|e| format!("Download chunk failed: {e}"))?;

            let chunk = resp.bytes().await
                .map_err(|e| format!("Failed to read chunk bytes: {e}"))?;

            use tokio::io::AsyncWriteExt;
            file.write_all(&chunk).await
                .map_err(|e| format!("Failed to write chunk: {e}"))?;

            downloaded += chunk.len() as u64;
            chunk_idx += 1;
            log::debug!("[TransferManager] download chunk {}/{} for {} ({} bytes transferred)",
                chunk_idx, total_chunks, task.asset_path, downloaded);

            // 更新 transferred_bytes 进度
            {
                use tauri::Manager;
                let db = app.state::<crate::state::DbStateWrapper>();
                let conn_guard = db.0.connection.lock().unwrap();
                if let Some(conn) = conn_guard.as_ref() {
                    let _ = Self::update_progress(conn, task.id, downloaded);
                }
                drop(conn_guard);
            }
        }

        use tokio::io::AsyncWriteExt;
        file.flush().await.map_err(|e| format!("Failed to flush: {e}"))?;

        // 最终确保 transferred_bytes == total_bytes
        {
            use tauri::Manager;
            let db = app.state::<crate::state::DbStateWrapper>();
            let conn_guard = db.0.connection.lock().unwrap();
            if let Some(conn) = conn_guard.as_ref() {
                let _ = conn.execute(
                    "UPDATE transfer_queue SET total_bytes = ?1, transferred_bytes = ?1, updated_at = unixepoch() WHERE id = ?2",
                    rusqlite::params![downloaded as i64, task.id],
                );
            }
            drop(conn_guard);
        }

        log::info!("✅ [TransferManager] download complete: {} ({} bytes)", task.asset_path, downloaded);
        Ok(())
    }
}
