//! 同步入口
//!
//! sync_vault — 先团队同步（pull 最新版），再个人同步（push 更新后的内容）

use std::path::PathBuf;

use slash_core::scan_directory_manifests;
use slash_sync_proto::{
    SpaceType, SyncNegotiateRequest, SyncPullRequest, SyncPushRequest, SyncResult, SyncStatus,
};

use super::client::SyncClient;
use super::helpers::{build_local_directory_hashes, collect_files_for_push, extract_asset_refs};
use super::path_mapping::{
    normalize_prefix, TeamDirectoryMappingsFile, TeamFileMappingsFile, TeamPathMappingsFile,
};
use super::state::{
    expire_edit_session_if_idle, load_unified_state, make_edit_session_id, save_unified_state,
};
use super::team::sync_team_full;

#[derive(Default)]
struct TeamLocalScope {
    dirs: std::collections::HashSet<String>,
    files: std::collections::HashSet<String>,
}

impl TeamLocalScope {
    fn contains(&self, relative_path: &str) -> bool {
        self.files.contains(relative_path)
            || self.dirs.iter().any(|dir| {
                let dir = dir.trim_end_matches('/');
                relative_path == dir || relative_path.starts_with(&format!("{dir}/"))
            })
    }
}

struct SyncingGuard(tauri::AppHandle);

impl SyncingGuard {
    fn new(app: tauri::AppHandle) -> Self {
        use tauri::Manager;
        if let Some(syncing_state) = app.try_state::<crate::state::SyncingState>() {
            syncing_state
                .0
                .store(true, std::sync::atomic::Ordering::Relaxed);
            log::debug!("🔒 [Sync] Set is_syncing = true");
        }
        Self(app)
    }
}

impl Drop for SyncingGuard {
    fn drop(&mut self) {
        use tauri::Manager;
        if let Some(syncing_state) = self.0.try_state::<crate::state::SyncingState>() {
            syncing_state
                .0
                .store(false, std::sync::atomic::Ordering::Relaxed);
            log::debug!("🔓 [Sync] Set is_syncing = false");
        }
    }
}

/// 触发一次完整同步
#[tauri::command]
pub async fn sync_vault(
    app: tauri::AppHandle,
    server_url: String,
    access_token: String,
    vault_id: String,
    vault_path: String,
    editing_paths: Option<Vec<String>>,
    #[allow(unused_variables)] editor_name: Option<String>,
) -> Result<SyncResult, String> {
    let _guard = SyncingGuard::new(app.clone());
    let editing_set: std::collections::HashSet<String> =
        editing_paths.unwrap_or_default().into_iter().collect();
    let root = PathBuf::from(&vault_path);
    if !root.exists() {
        return Err("Vault path does not exist".into());
    }

    let sync_client = SyncClient::new(&server_url, &access_token);

    // 🛡️ 同步凭据到 SessionStateWrapper
    // TransferScheduler 依赖此 state 读取凭据执行后台上传/下载
    {
        use tauri::Manager;
        let session = app.state::<crate::state::SessionStateWrapper>();
        let mut s = session.0.lock().unwrap();
        s.active_server_url = Some(server_url.clone());
        s.cached_access_token = Some(access_token.clone());
    }

    // ============================================================
    // Phase 1: 团队同步（先拉取最新版本到本地）
    // ============================================================
    let (
        team_files_pushed,
        team_files_pulled,
        team_pulled_paths,
        team_actually_pulled_paths,
        team_server_deleted,
        team_is_maintenance,
        team_maintenance_started_at,
        team_caps,
    ) = match sync_team_full(app.clone(), &sync_client, &root, &editing_set).await {
        Ok(res) => res,
        Err(e) => {
            log::error!("[TeamSync] Failed: {e}");
            // 🚨 鉴权与权限熔断错误 (401 / 403) 必须向上抛出给前端，阻断整个同步流程以触发强退
            if e.contains("401")
                || e.contains("Unauthorized")
                || e.contains("403")
                || e.contains("Forbidden")
            {
                return Err(e);
            }
            (0, 0, vec![], vec![], vec![], false, None, None)
        }
    };

    // 🛡️ 智能拦截团队 Vault 的个人空间同步：
    // 若当前请求的 vault_id 匹配该仓库绑定的已知团队 Vault ID，
    // 则说明这是一次纯粹的团队同步，不需要（且不能）继续跑个人同步（Phase 2），以彻底根除 400 协商错误。
    let is_team_vault = {
        let state_path = root.join(".slash/team_sync_state.json");
        if let Ok(raw) = std::fs::read_to_string(&state_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                json.get("vault_id")
                    .and_then(|v| v.as_str())
                    .map(|vid| vid == vault_id)
                    .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        }
    };

    if is_team_vault {
        log::info!(
            "[Sync] Detected team vault sync for vault='{}'. Skipping personal sync (Phase 2) to prevent 400 Bad Request error.",
            vault_id
        );
        let should_refresh_vault = team_files_pushed > 0
            || team_files_pulled > 0
            || !team_server_deleted.is_empty()
            || !team_actually_pulled_paths.is_empty();
        std::mem::drop(_guard);
        if should_refresh_vault {
            use tauri::Emitter;
            let _ = app.emit("vault:refresh", ());
        }
        return Ok(SyncResult {
            status: SyncStatus::Idle,
            files_pushed: team_files_pushed,
            files_pulled: team_files_pulled,
            conflicts: vec![],
            server_deleted: team_server_deleted,
            skipped_pulls: vec![],
            pulled_paths: team_pulled_paths,
            actually_pulled_paths: team_actually_pulled_paths,
            is_maintenance: team_is_maintenance,
            maintenance_started_at: team_maintenance_started_at,
        });
    }

    // ============================================================
    // Phase 2: 个人同步（团队 pull 后本地已是最新，直接推到个人云端）
    // ============================================================

    let max_sync_file_size = {
        use tauri::Manager;
        app.try_state::<crate::state::SyncCapabilitiesState>()
            .map(|s| s.0.lock().unwrap().max_sync_file_size)
            .unwrap_or(slash_core::TEAM_ASSET_MAX_SIZE_DEFAULT)
    };

    // Step 1: Scan local personal path
    // 🛡️ 个人空间不设文件大小限制（传 None），仅团队空间受 max_sync_file_size 约束
    // assets/ 文件用文件名当 hash（零 IO），已在 scan_directory_manifests 中保证跳过内容读取
    let team_local_scope = load_team_local_scope(&root);
    let manifests = filter_personal_manifests(&root, scan_directory_manifests(&root, None));

    // Step 2: 构建目录级 Merkle hash
    let directory_hashes = build_local_directory_hashes(&manifests);

    // Step 2.5: 加载统一同步状态（团队同步已保存过最新状态）
    let mut unified_state = load_unified_state(&root);
    let now_secs_for_session = chrono::Utc::now().timestamp();
    for manifest in &manifests {
        if let Some(entry) = unified_state.get_mut(&manifest.relative_path) {
            expire_edit_session_if_idle(entry, now_secs_for_session);
        }
    }

    // Step 3: 与 Server 协商差异
    // base_hash 取自 unified_state[path].personal_hash
    let client_files: Vec<slash_sync_proto::NegotiateFileEntry> = manifests
        .iter()
        .map(|m| {
            let base_hash = unified_state
                .get(&m.relative_path)
                .map(|s| s.personal_hash.clone())
                .unwrap_or_default();
            slash_sync_proto::NegotiateFileEntry {
                path: m.relative_path.clone(),
                hash: m.content_hash.clone(),
                base_hash,
                file_id: m.file_id.clone(),
            }
        })
        .collect();

    // 检测已删除的文件：统一 state 中有 personal_hash 记录但本地已不存在
    let local_paths: std::collections::HashSet<&str> =
        manifests.iter().map(|m| m.relative_path.as_str()).collect();

    // Asset GC 保护期常量：60 秒内不 GC，防止 Ctrl+Z 撤销竞争
    const ASSET_GC_GRACE_SECS: i64 = 60;
    let now_ts = chrono::Utc::now().timestamp();

    // 清除已恢复文件的 missing_since（Ctrl+Z 后文件重新出现）
    for (path, state) in unified_state.iter_mut() {
        if local_paths.contains(path.as_str()) && state.missing_since.is_some() {
            log::debug!(
                "[PersonalSync] 🔄 Asset re-appeared, clearing missing_since: '{}'",
                path
            );
            state.missing_since = None;
        }
    }

    // 🔍 BUG-E07 诊断：列出所有有 personal_hash 但不在磁盘上的条目
    let candidates_for_delete: Vec<(String, String)> = unified_state
        .iter()
        .filter(|(_, state)| !state.personal_hash.is_empty())
        .filter(|(path, _)| !local_paths.contains(path.as_str()))
        .map(|(path, state)| (path.clone(), state.personal_hash.clone()))
        .collect();
    if !candidates_for_delete.is_empty() {
        for (path, ph) in &candidates_for_delete {
            if path.starts_with("assets/") || path.starts_with(".slash/assets/") {
                log::debug!(
                    "🔥🔥🔥 [PersonalSync] GC'd Asset correctly detected for deleted_paths: path='{}'",
                    path
                );
            } else {
                log::debug!(
                    "[PersonalSync] 🔍 delete candidate: path='{}' personal_hash='{}'",
                    path,
                    ph
                );
            }
        }
    }

    // Asset 保护期过滤：非 asset 文件立即 GC，asset 文件需等待 60 秒
    let mut deleted_paths: Vec<String> = Vec::new();
    for (path, _) in &candidates_for_delete {
        let is_asset = path.starts_with("assets/") || path.starts_with(".slash/assets/");
        if is_asset {
            // 获取或设置 missing_since
            let entry = unified_state.entry(path.clone()).or_default();
            match entry.missing_since {
                Some(since) => {
                    let elapsed = now_ts - since;
                    if elapsed >= ASSET_GC_GRACE_SECS {
                        log::debug!(
                            "[PersonalSync] ⏰ Asset GC grace period expired ({}s): '{}'",
                            elapsed,
                            path
                        );
                        deleted_paths.push(path.clone());
                    } else {
                        log::debug!(
                            "[PersonalSync] 🛡️ Asset GC deferred ({}/{}s): '{}'",
                            elapsed,
                            ASSET_GC_GRACE_SECS,
                            path
                        );
                    }
                }
                None => {
                    log::debug!(
                        "[PersonalSync] 🛡️ Asset GC grace period started: '{}'",
                        path
                    );
                    entry.missing_since = Some(now_ts);
                }
            }
        } else {
            // 非 asset 文件：立即 GC
            deleted_paths.push(path.clone());
        }
    }
    if !deleted_paths.is_empty() {
        log::debug!(
            "[PersonalSync] detected {} deleted files to propagate: {:?}",
            deleted_paths.len(),
            deleted_paths
        );
    } else {
        // 🔍 BUG-E07 诊断：如果没有检测到删除，列出 unified_state 中所有条目的 personal_hash 状态
        let non_local_entries: Vec<(&String, bool)> = unified_state
            .iter()
            .filter(|(path, _)| !local_paths.contains(path.as_str()) && path.as_str() != "vault_id")
            .map(|(path, state)| (path, state.personal_hash.is_empty()))
            .collect();
        if !non_local_entries.is_empty() {
            log::debug!(
                "[PersonalSync] 🔍 {} state entries not on disk (personal_hash empty?):",
                non_local_entries.len()
            );
            for (path, ph_empty) in &non_local_entries {
                log::debug!(
                    "[PersonalSync] 🔍   '{}' personal_hash_empty={}",
                    path,
                    ph_empty
                );
            }
        }
    }
    let deleted_files = deleted_paths
        .iter()
        .map(|path| slash_sync_proto::DeletedFile {
            path: path.clone(),
            file_id: unified_state
                .get(path)
                .and_then(|state| state.file_id.clone()),
        })
        .collect::<Vec<_>>();

    let negotiate_req = SyncNegotiateRequest {
        vault_id: vault_id.clone(),
        space_type: SpaceType::Personal,
        directory_hashes,
        client_clock: 0,
        client_files,
        deleted_paths: deleted_paths.clone(),
        deleted_files,
    };

    log::debug!(
        "[PersonalSync] Negotiate: vault={}, client_files={}, deleted_paths={}",
        vault_id,
        negotiate_req.client_files.len(),
        negotiate_req.deleted_paths.len()
    );

    let negotiate_resp = sync_client.negotiate(&negotiate_req).await?;

    let personal_caps = negotiate_resp.server_capabilities.clone();
    use tauri::Manager;
    if let Some(caps) = team_caps.or(personal_caps) {
        if let Some(state) = app.try_state::<crate::state::SyncCapabilitiesState>() {
            if let Ok(mut c) = state.0.lock() {
                c.max_sync_file_size = caps.max_sync_file_size;
            }
        }
    }

    let mut files_pushed = 0u32;
    let mut files_pulled = 0u32;
    let mut skipped_pull_list: Vec<String> = Vec::new();
    let mut synced_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Step 3.5: 处理服务器发回的被删文件 (server_deleted)
    if !negotiate_resp.server_deleted.is_empty() {
        log::debug!(
            "[PersonalSync] Server marked {} files as deleted, removing locally...",
            negotiate_resp.server_deleted.len()
        );
        for deleted_file in &negotiate_resp.server_deleted {
            let deleted_path = &deleted_file.path;
            let local_full_path = root.join(deleted_path);

            // Personal tombstones must not physically delete Team landing paths.
            // Team-owned files are deleted by Team sync/API; Personal sync only backs them up.
            if team_local_scope.contains(deleted_path)
                || unified_state
                    .get(deleted_path)
                    .map(|state| !state.team_hash.is_empty())
                    .unwrap_or(false)
            {
                log::warn!(
                    "[PersonalSync] Skipping personal server_deleted for team-mapped path '{}'",
                    deleted_path
                );
                if let Some(entry) = unified_state.get_mut(deleted_path) {
                    entry.personal_hash.clear();
                }
                continue;
            }

            // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
            if let Err(e) =
                crate::commands::sync::helpers::validate_path_in_vault(&local_full_path, &root)
            {
                log::error!(
                    "[PersonalSync] 🚫 Path traversal blocked on delete: path={}, err={}",
                    deleted_path,
                    e
                );
                continue;
            }

            if local_full_path.exists() {
                // 🛡️ BUG-SYNC-01: Verify UUID matches before deletion
                if deleted_path.ends_with(".md") {
                    if let Some(ref expected_uuid) = deleted_file.file_id {
                        if let Ok(content) = std::fs::read(&local_full_path) {
                            if let Some(local_uuid) =
                                crate::commands::sync::helpers::extract_slash_id_str(&content)
                            {
                                if local_uuid != *expected_uuid {
                                    log::warn!(
                                        "[PersonalSync] Skipping deletion of {} because local UUID {} does not match server UUID {}. This file was likely recreated.",
                                        deleted_path,
                                        local_uuid,
                                        expected_uuid
                                    );
                                    continue;
                                }
                            }
                        }
                    }
                }

                if let Err(e) = std::fs::remove_file(&local_full_path) {
                    log::error!(
                        "[PersonalSync] Failed to delete locally {}, err: {}",
                        local_full_path.display(),
                        e
                    );
                } else {
                    log::debug!("[PersonalSync] Deleted local file: {}", deleted_path);
                    // 清理空目录
                    if let Some(parent) = local_full_path.parent() {
                        let _ = std::fs::remove_dir(parent); // 仅删除空目录，非空会自动失败
                    }
                    if let Some(entry) = unified_state.get_mut(deleted_path) {
                        entry.personal_hash.clear();
                    }
                }
            } else {
                if let Some(entry) = unified_state.get_mut(deleted_path) {
                    entry.personal_hash.clear();
                }
            }
        }
    }

    // Step 3.6: 处理身份冲突 (identity_conflicts)
    // 🛡️ 服务端检测到路径相同但 file_id 不一致，拒绝接收但不要求删除
    // 客户端保留本地文件，仅记录日志
    if !negotiate_resp.identity_conflicts.is_empty() {
        log::warn!(
            "[PersonalSync] ⚠️ {} identity conflict(s) detected — local files preserved",
            negotiate_resp.identity_conflicts.len()
        );
        for conflict in &negotiate_resp.identity_conflicts {
            log::warn!(
                "[PersonalSync] ⚠️ Identity conflict: path='{}' client_fid={:?} server_fid={:?} reason='{}'",
                conflict.path,
                conflict.client_file_id,
                conflict.server_file_id,
                conflict.reason
            );
        }
    }

    // Step 4: Push
    if !negotiate_resp.server_needs.is_empty() {
        let mut files_to_push =
            collect_files_for_push(&root, &manifests, &negotiate_resp.server_needs);

        for payload in &mut files_to_push {
            payload.manifest.assets = crate::commands::sync::helpers::filter_oversized_assets(
                &root,
                payload.manifest.assets.take(),
                max_sync_file_size,
            );
            if payload.manifest.relative_path.ends_with(".md") {
                let entry = unified_state
                    .entry(payload.manifest.relative_path.clone())
                    .or_default();
                let edit_started = entry.edit_started_at.unwrap_or(now_secs_for_session);
                let edit_session_id = entry.edit_session_id.clone().unwrap_or_else(|| {
                    make_edit_session_id(
                        &payload.manifest.relative_path,
                        edit_started,
                        payload.manifest.file_id.as_deref(),
                    )
                });
                entry.edit_started_at = Some(edit_started);
                entry.edit_session_id = Some(edit_session_id.clone());
                entry.edit_session_touched_at = Some(now_secs_for_session);
                payload.manifest.edit_started_at = Some(edit_started);
                payload.manifest.edit_session_id = Some(edit_session_id);
            }
        }

        if !files_to_push.is_empty() {
            // 🛡️ [Phase 6] 断言：asset 路径的 content 必须为空，不允许 blob 进入 JSON payload
            for payload in &files_to_push {
                let is_asset_path = payload.manifest.relative_path.starts_with("assets/")
                    || payload.manifest.relative_path.starts_with(".slash/assets/");
                if is_asset_path && !payload.content.is_empty() {
                    log::error!(
                        "[Phase6 PersonalSync] 🚫 FATAL: asset blob leaked into push payload! path={} content_bytes={}",
                        payload.manifest.relative_path,
                        payload.content.len()
                    );
                    return Err(format!(
                        "Phase6 safety violation: asset blob in push payload (path={}, {} bytes)",
                        payload.manifest.relative_path,
                        payload.content.len()
                    ));
                }
            }

            let push_req = SyncPushRequest {
                vault_id: vault_id.clone(),
                files: files_to_push,
            };

            let push_resp = sync_client.push(&push_req).await?;

            files_pushed = push_resp.accepted.len() as u32;
            for path in &push_resp.accepted {
                synced_paths.insert(path.clone());
            }
        }
    }

    // ── [Phase 6] Step 4.5: 资产 Blob 入队上传 ──────────────────
    // Fast Sync 只发送了 asset declaration（metadata），blob 本体必须通过
    // TransferManager → /sync/assets/* API 异步上传。
    //
    // 入队来源：本轮 manifests 中所有 assets/ 路径文件（本地真实存在）
    // 跳过条件：transfer_queue 已有同 hash+direction 的 pending/active/completed 记录
    {
        use tauri::Manager;
        if let Some(db_state) = app.try_state::<crate::state::DbStateWrapper>() {
            if let Ok(conn_guard) = db_state.0.connection.lock() {
                if let Some(conn) = conn_guard.as_ref() {
                    let mut actually_enqueued = 0u32;
                    let mut skipped_completed = 0u32;
                    for m in &manifests {
                        let is_asset = m.relative_path.starts_with("assets/")
                            || m.relative_path.starts_with(".slash/assets/");
                        if !is_asset {
                            continue;
                        }

                        let local_path = root.join(&m.relative_path);
                        if !local_path.exists() {
                            continue;
                        }

                        // 前置检查：pending/active/completed 均跳过
                        if crate::core::transfer_manager::TransferManager::should_skip_upload_enqueue(
                            conn, &vault_id, &m.content_hash,
                        ) {
                            log::debug!("[Phase6 PersonalSync] asset already uploaded, skip enqueue: path={} hash={}", m.relative_path, &m.content_hash[..8.min(m.content_hash.len())]);
                            skipped_completed += 1;
                            continue;
                        }

                        log::debug!(
                            "[Phase6 PersonalSync] 🔍 asset detected for slow transfer: path={} hash={} size={}",
                            m.relative_path,
                            m.content_hash,
                            m.size
                        );

                        match crate::core::transfer_manager::TransferManager::enqueue_upload(
                            conn,
                            &vault_id,
                            &m.content_hash,
                            &m.relative_path,
                            m.size,
                        ) {
                            Ok(true) => actually_enqueued += 1,
                            Ok(false) => skipped_completed += 1, // 兜底 idempotent skip
                            Err(e) => log::error!(
                                "[Phase6 PersonalSync] ❌ enqueue upload failed: path={} err={}",
                                m.relative_path,
                                e
                            ),
                        }
                    }
                    if actually_enqueued > 0 || skipped_completed > 0 {
                        log::debug!(
                            "[Phase6 PersonalSync] upload enqueue summary: enqueued={} skipped_completed={}",
                            actually_enqueued,
                            skipped_completed
                        );
                    }
                    if actually_enqueued > 0 {
                        if let Some(notify_state) =
                            app.try_state::<crate::state::TransferNotifyState>()
                        {
                            notify_state.0.notify_one();
                        }
                    }
                }
            }
        }
    }

    // Step 5: Pull
    if !negotiate_resp.client_needs.is_empty() {
        let pull_req = SyncPullRequest {
            vault_id: vault_id.clone(),
            paths: negotiate_resp.client_needs,
        };

        let pull_resp = sync_client.pull(&pull_req).await?;

        // 构建 asset_manifest 的 size 索引（用于 enqueue download 的 total_bytes）
        let asset_size_map: std::collections::HashMap<String, u64> = negotiate_resp
            .asset_manifest
            .as_ref()
            .map(|m| {
                m.iter()
                    .map(|e| (format!("assets/{}", e.asset_id), e.size))
                    .collect()
            })
            .unwrap_or_default();

        let mut dl_created = 0u32;
        let mut dl_revived = 0u32;
        let mut dl_skipped_valid = 0u32;
        let mut dl_skipped_inflight = 0u32;

        for file in &pull_resp.files {
            let rel_path = &file.manifest.relative_path;

            // ── [Phase 6] Asset manifest-only 检测 ────────────────────
            // 服务端对 assets/* 路径返回 content=[] + size=0（慢车道标记）
            let is_asset_manifest_only = file.content.is_empty()
                && (rel_path.starts_with("assets/") || rel_path.starts_with(".slash/assets/"));

            if is_asset_manifest_only {
                // 检查本地是否已有该文件
                let local_path = root.join(rel_path);

                // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
                if let Err(e) =
                    crate::commands::sync::helpers::validate_path_in_vault(&local_path, &root)
                {
                    log::error!(
                        "[Phase6 PersonalSync] 🚫 Path traversal blocked on enqueue download: path={}, err={}",
                        rel_path,
                        e
                    );
                    continue;
                }

                if local_path.exists() {
                    log::debug!(
                        "[Phase6 PersonalSync] asset already exists locally: {}",
                        rel_path
                    );
                    continue;
                }

                // 本地缺失 → enqueue download
                let total_bytes = asset_size_map.get(rel_path).copied().unwrap_or(0);
                log::debug!(
                    "[Phase6 PersonalSync] asset missing locally, enqueue download: path={} hash={} size={}",
                    rel_path,
                    file.manifest.content_hash,
                    total_bytes
                );

                if let Some(db_state) = app.try_state::<crate::state::DbStateWrapper>() {
                    let conn_guard = db_state.0.connection.lock().unwrap();
                    if let Some(conn) = conn_guard.as_ref() {
                        match crate::core::transfer_manager::TransferManager::enqueue_download(
                            conn,
                            &vault_id,
                            &file.manifest.content_hash,
                            rel_path,
                            total_bytes,
                            &root,
                        ) {
                            Ok(result) => {
                                use crate::core::transfer_manager::DownloadAction;
                                match result.action {
                                    DownloadAction::Created => dl_created += 1,
                                    DownloadAction::Revived => dl_revived += 1,
                                    DownloadAction::SkippedLocalValid => dl_skipped_valid += 1,
                                    DownloadAction::SkippedInflight => dl_skipped_inflight += 1,
                                }
                            }
                            Err(e) => log::error!(
                                "[Phase6 PersonalSync] enqueue download failed for {}: {}",
                                rel_path,
                                e
                            ),
                        }
                    }
                }
                continue; // 不要把空 content 写成空文件
            }

            // ── 普通文件 pull（快车道）────────────────────────────────
            if !file.content.is_empty() {
                if editing_set.contains(rel_path) {
                    skipped_pull_list.push(rel_path.clone());
                    continue;
                }

                // 🛡️ BUG-E10: 团队文件 Team vault 优先 — 不允许 Personal pull 覆盖
                if let Some(state) = unified_state.get(rel_path) {
                    if !state.team_hash.is_empty() {
                        log::debug!(
                            "[PersonalSync] 🛡️ Skip pull for team file '{}' (team_hash={}, personal vault would overwrite team content)",
                            rel_path,
                            &state.team_hash[..8.min(state.team_hash.len())]
                        );
                        skipped_pull_list.push(rel_path.clone());
                        continue;
                    }
                }

                let file_path = root.join(rel_path);

                // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
                if let Err(e) =
                    crate::commands::sync::helpers::validate_path_in_vault(&file_path, &root)
                {
                    log::error!(
                        "[PersonalSync] 🚫 Path traversal blocked on write: path={}, err={}",
                        rel_path,
                        e
                    );
                    continue;
                }

                if let Some(parent) = file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match std::fs::write(&file_path, &file.content) {
                    Ok(()) => {
                        synced_paths.insert(rel_path.clone());
                    }
                    Err(e) => log::error!("[Sync] write error {}: {e}", rel_path),
                }
            }
        }

        // 分类日志 + 按需 notify
        {
            let total = dl_created + dl_revived + dl_skipped_valid + dl_skipped_inflight;
            if total > 0 {
                log::debug!(
                    "[Phase6 PersonalSync] asset download summary: created={} revived={} skipped_valid={} skipped_inflight={} vault={}",
                    dl_created,
                    dl_revived,
                    dl_skipped_valid,
                    dl_skipped_inflight,
                    vault_id
                );
            }
            let needs_notify = dl_created > 0 || dl_revived > 0;
            if needs_notify {
                if let Some(notify_state) = app.try_state::<crate::state::TransferNotifyState>() {
                    notify_state.0.notify_one();
                }
            }
        }

        files_pulled = pull_resp.files.len() as u32;
    }

    // Step 6: 更新统一同步状态
    //
    // 关键：pushed 文件用 PRE-SCAN hash，pulled 文件用 POST-SCAN hash
    let pre_scan_hashes: std::collections::HashMap<String, String> = manifests
        .iter()
        .map(|m| (m.relative_path.clone(), m.content_hash.clone()))
        .collect();

    let post_manifests = filter_personal_manifests(&root, scan_directory_manifests(&root, None));
    let post_hashes: std::collections::HashMap<String, String> = post_manifests
        .iter()
        .map(|m| (m.relative_path.clone(), m.content_hash.clone()))
        .collect();

    let mut new_state = unified_state;

    for path in &synced_paths {
        let entry = new_state.entry(path.clone()).or_default();
        if let Some(hash) = pre_scan_hashes.get(path) {
            // Pushed file: 更新 personal_hash
            entry.personal_hash = hash.clone();
            entry.edit_session_touched_at = Some(now_secs_for_session);
        } else if let Some(hash) = post_hashes.get(path) {
            // Pulled file: 更新 personal_hash + local_snapshot
            // ⚠️ local_snapshot 必须同步更新：team sync 用它判断 dirty，
            //    不更新会导致 team sync 看到 disk ≠ local_snapshot → 误判为用户编辑。
            entry.personal_hash = hash.clone();
            entry.local_snapshot = hash.clone();

            // ⚠️ 跨路径大小写修复（macOS case-insensitive 文件系统）：
            //    personal 路径 (01_Projects) 与 team 路径 (01_PROJECTS) 大小写不同，
            //    但指向同一物理文件。personal pull 写磁盘后，team state key 的
            //    local_snapshot 也必须同步更新，否则 team sync 误判 dirty → 触发 push。
            let path_lower = path.to_lowercase();
            for (other_path, other_entry) in new_state.iter_mut() {
                if other_path != path && other_path.to_lowercase() == path_lower {
                    other_entry.local_snapshot = hash.clone();
                    log::debug!(
                        "[PersonalSync] 🔧 cross-path local_snapshot sync: '{}' → '{}' = {}",
                        path,
                        other_path,
                        &hash[..8.min(hash.len())]
                    );
                }
            }
        }
    }

    // 清理已删除的文件：仅清除 personal_hash，保留 team_hash
    for path in &deleted_paths {
        if let Some(entry) = new_state.get_mut(path) {
            entry.personal_hash.clear();
        }
    }
    // 本地不存在的文件：如果 personal_hash 和 team_hash 都为空，才移除
    // ⚠️ 极其关键的反向复活保护验证：
    // 如果一个文件在 sync_vault 开始时（pre_scan）存在，但在完成时（post_scan）
    // 突然从本地消失了（比如用户在前端高频连删多个文件，同步正在异步进行）。
    // 我们绝对不能在这里直接丢弃它的 unified_state！必须保留它的 personal_hash，
    // 这样在下一次完整的 sync 生命周期中，它才会安全地进入 deleted_paths 队列通知服务端。
    new_state.retain(|path, state| {
        post_hashes.contains_key(path)
            || !state.team_hash.is_empty()
            || !state.personal_hash.is_empty()
    });

    save_unified_state(&root, &new_state);

    let should_refresh_vault = files_pushed > 0
        || files_pulled > 0
        || !deleted_paths.is_empty()
        || team_files_pushed > 0
        || team_files_pulled > 0
        || !team_server_deleted.is_empty()
        || !team_actually_pulled_paths.is_empty();

    std::mem::drop(_guard);
    if should_refresh_vault {
        if let Some(db_state) = app.try_state::<crate::state::DbStateWrapper>() {
            if let Err(e) = crate::commands::db::scan_vault(vault_path.clone(), db_state) {
                log::error!(
                    "[PersonalSync] Failed to scan vault for sync compensation: {}",
                    e
                );
            } else {
                log::debug!("[PersonalSync] Vault scan compensation completed successfully");
            }
        }
        {
            use tauri::Emitter;
            let _ = app.emit("vault:refresh", ());
        }
    } else {
        log::trace!("[PersonalSync] Skip vault scan compensation for no-op sync");
    }

    Ok(SyncResult {
        status: SyncStatus::Idle,
        files_pushed: files_pushed + team_files_pushed,
        files_pulled: files_pulled + team_files_pulled,
        conflicts: negotiate_resp.conflicts,
        server_deleted: team_server_deleted,
        skipped_pulls: skipped_pull_list,
        pulled_paths: team_pulled_paths,
        actually_pulled_paths: team_actually_pulled_paths,
        is_maintenance: team_is_maintenance,
        maintenance_started_at: team_maintenance_started_at,
    })
}

fn filter_personal_manifests(
    root: &std::path::Path,
    manifests: Vec<slash_core::FileManifestBasic>,
) -> Vec<slash_core::FileManifestBasic> {
    let mut personal_manifests = Vec::new();
    let mut asset_manifests = Vec::new();

    for manifest in manifests {
        if is_asset_path(&manifest.relative_path) {
            asset_manifests.push(manifest);
            continue;
        }
        personal_manifests.push(manifest);
    }

    let mut required_assets = std::collections::HashSet::new();
    for manifest in &personal_manifests {
        if !manifest.relative_path.ends_with(".md") {
            continue;
        }
        let file_path = root.join(&manifest.relative_path);
        let Ok(content) = std::fs::read(&file_path) else {
            continue;
        };
        if let Some(assets) = extract_asset_refs(&content) {
            for asset in assets {
                required_assets.insert(asset.relative_path.replace('\\', "/"));
            }
        }
    }

    let retained_asset_count = asset_manifests
        .iter()
        .filter(|manifest| required_assets.contains(&manifest.relative_path))
        .count();
    let excluded_asset_count = asset_manifests.len().saturating_sub(retained_asset_count);

    personal_manifests.extend(
        asset_manifests
            .into_iter()
            .filter(|manifest| required_assets.contains(&manifest.relative_path)),
    );

    if excluded_asset_count > 0 {
        log::debug!(
            "[PersonalSync] excluded {} unreferenced asset manifest(s) from personal backup scope",
            excluded_asset_count
        );
    }

    personal_manifests
}

fn is_asset_path(relative_path: &str) -> bool {
    relative_path.starts_with("assets/") || relative_path.starts_with(".slash/assets/")
}

fn load_team_local_scope(root: &std::path::Path) -> TeamLocalScope {
    let mut scope = TeamLocalScope::default();

    let file_mappings =
        TeamFileMappingsFile::load(&root.join(".slash").join("team_file_mappings.json"));
    for team in file_mappings.teams.values() {
        for mapping in team.files.values() {
            if mapping.status == "active" {
                scope.files.insert(mapping.local_path.clone());
            }
        }
    }

    let directory_mappings =
        TeamDirectoryMappingsFile::load(&root.join(".slash").join("team_directory_mappings.json"));
    for team in directory_mappings.teams.values() {
        for mapping in team.directories.values() {
            if mapping.status == "active" {
                scope
                    .dirs
                    .insert(mapping.local_path.trim_end_matches('/').to_string());
            }
        }
    }

    let legacy_mappings =
        TeamPathMappingsFile::load(&root.join(".slash").join("team_path_mappings.json"));
    for team in legacy_mappings.teams.values() {
        for local_dir in team.keys() {
            scope
                .dirs
                .insert(local_dir.trim_end_matches('/').to_string());
        }
    }

    scope.dirs = scope
        .dirs
        .into_iter()
        .map(|dir| normalize_prefix(&dir).trim_end_matches('/').to_string())
        .collect();
    scope
}
