//! 团队同步
//!
//! sync_team_full — 完整双向团队同步 + check_sync_connection
//!
//! 与个人同步模型完全一致：negotiate → push + pull
//! 区别仅在于 scope（由服务端权限表驱动）和路径映射（个人→团队）

use std::path::PathBuf;

use slash_core::scan_directory_manifests;
use slash_sync_proto::{
    SpaceType, SyncNegotiateRequest, SyncPullRequest, SyncPushRequest, SyncResult, SyncStatus,
};

use super::client::SyncClient;
use super::helpers::collect_mapped_files_for_push;
use super::helpers::filter_oversized_assets;
use super::path_mapping::{
    normalize_prefix, resolve_team_pull_path, TeamDirectoryMappingsFile, TeamFileMappingsFile,
    TeamPathMappingsFile, PARA_TEAM_TO_PERSONAL,
};
use super::state::{
    expire_edit_session_if_idle, load_unified_state, make_edit_session_id, save_unified_state,
    UnifiedSyncState,
};

struct TeamSyncingGuard(tauri::AppHandle);

struct PendingServerDeletedFile {
    local_rel: String,
    team_path: String,
    file_id: String,
}

fn push_frontend_server_deleted(
    frontend_server_deleted: &mut Vec<slash_sync_proto::DeletedFile>,
    frontend_server_deleted_keys: &mut std::collections::HashSet<String>,
    path: String,
    file_id: Option<String>,
) {
    let key = format!("{}:{}", path, file_id.as_deref().unwrap_or(""));
    if frontend_server_deleted_keys.insert(key) {
        frontend_server_deleted.push(slash_sync_proto::DeletedFile { path, file_id });
    }
}

impl TeamSyncingGuard {
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

impl Drop for TeamSyncingGuard {
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

/// 检查 server 连接状态
#[tauri::command]
pub async fn check_sync_connection(server_url: String) -> Result<bool, String> {
    let sync_client = SyncClient::with_timeout(&server_url, "", 5)?;
    sync_client.check_health().await
}

/// 触发一次纯团队同步。
///
/// 用于 30s team remote poll，避免空闲轮询同时跑个人空间 negotiate。
#[tauri::command]
pub async fn sync_team_vault(
    app: tauri::AppHandle,
    server_url: String,
    access_token: String,
    vault_path: String,
    editing_paths: Option<Vec<String>>,
    #[allow(unused_variables)] editor_name: Option<String>,
) -> Result<SyncResult, String> {
    let _guard = TeamSyncingGuard::new(app.clone());
    let editing_set: std::collections::HashSet<String> =
        editing_paths.unwrap_or_default().into_iter().collect();
    let root = PathBuf::from(&vault_path);
    if !root.exists() {
        return Err("Vault path does not exist".into());
    }

    let sync_client = SyncClient::new(&server_url, &access_token);

    {
        use tauri::Manager;
        let session = app.state::<crate::state::SessionStateWrapper>();
        let mut s = session.0.lock().unwrap();
        s.active_server_url = Some(server_url.clone());
        s.cached_access_token = Some(access_token.clone());
    }

    let (
        files_pushed,
        files_pulled,
        pulled_paths,
        actually_pulled_paths,
        server_deleted,
        is_maintenance,
        maintenance_started_at,
        _caps,
    ) = match sync_team_full(app.clone(), &sync_client, &root, &editing_set).await {
        Ok(res) => res,
        Err(e) => {
            log::error!("[TeamSync] Failed: {e}");
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

    let should_refresh_vault = files_pushed > 0
        || files_pulled > 0
        || !server_deleted.is_empty()
        || !actually_pulled_paths.is_empty();
    std::mem::drop(_guard);
    if should_refresh_vault {
        use tauri::Emitter;
        let _ = app.emit("vault:refresh", ());
    }

    Ok(SyncResult {
        status: SyncStatus::Idle,
        files_pushed,
        files_pulled,
        conflicts: vec![],
        server_deleted,
        skipped_pulls: vec![],
        pulled_paths,
        actually_pulled_paths,
        is_maintenance,
        maintenance_started_at,
    })
}

/// 获取当前缓存在客户端的同步能力限制
#[tauri::command]
pub async fn get_sync_capabilities(
    state: tauri::State<'_, crate::state::SyncCapabilitiesState>,
) -> Result<crate::state::SyncCapabilities, String> {
    let caps = state.0.lock().unwrap().clone();
    Ok(caps)
}

/// Admin 手动修改配置后，前端主动立即覆盖本地能力缓存（防止后台 pull 未结束时读取到旧版数值）
#[tauri::command]
pub async fn update_local_sync_capabilities(
    state: tauri::State<'_, crate::state::SyncCapabilitiesState>,
    max_sync_file_size: u64,
) -> Result<(), String> {
    if let Ok(mut caps) = state.0.lock() {
        caps.max_sync_file_size = max_sync_file_size;
    }
    Ok(())
}

/// 完整双向团队同步（单团队模式）
pub(super) async fn sync_team_full(
    app: tauri::AppHandle,
    sync_client: &SyncClient,
    root: &PathBuf,
    editing_set: &std::collections::HashSet<String>,
) -> Result<
    (
        u32,
        u32,
        Vec<String>,
        Vec<String>,
        Vec<slash_sync_proto::DeletedFile>,
        bool,
        Option<i64>,
        Option<slash_sync_proto::ServerCapabilities>,
    ),
    String,
> {
    // 降维为单团队模式：我们仅认当前本地所挂载的那个合法团队空间
    let known_vault_id = read_known_team_vault_id(root);

    // 本地状态缺失时也尝试从服务端发现一次，覆盖“启动后被加入团队”的场景。
    match known_vault_id {
        Some(vid) => sync_team_single(app, sync_client, root, editing_set, Some(&vid)).await,
        None => sync_team_single(app, sync_client, root, editing_set, None).await,
    }
}

/// 单团队双向同步逻辑
async fn sync_team_single(
    app: tauri::AppHandle,
    sync_client: &SyncClient,
    root: &PathBuf,
    editing_set: &std::collections::HashSet<String>,
    known_vault_id: Option<&str>,
) -> Result<
    (
        u32,
        u32,
        Vec<String>,
        Vec<String>,
        Vec<slash_sync_proto::DeletedFile>,
        bool,
        Option<i64>,
        Option<slash_sync_proto::ServerCapabilities>,
    ),
    String,
> {
    let scope = match sync_client.get_team_scope(known_vault_id).await {
        Ok(s) => s,
        Err(e) => {
            // 🚨 鉴权与权限熔断错误 (401 / 403) 必须向上抛出，拒绝静默吞没！
            if e.contains("HTTP 401") || e.contains("HTTP 403") {
                return Err(e);
            }
            return Ok((0, 0, vec![], vec![], vec![], false, None, None)); // 其它网络瞬态等非致命错误可以跳过
        }
    };

    if scope.vault_id.is_empty() {
        return Ok((0, 0, vec![], vec![], vec![], false, None, None)); // 无团队 vault
    }

    let team_vault_id = &scope.vault_id;
    if known_vault_id.is_none() {
        ensure_team_sync_state_file(root, team_vault_id)?;
    }

    let active_user_id = {
        use tauri::Manager;
        let session = app.state::<crate::state::SessionStateWrapper>();
        let store = session.0.lock().unwrap();
        store.active_user_id.clone()
    };

    // Step 2: 读取并更新路径映射
    let (path_mappings, reverse_mappings_owned, directory_id_mappings) =
        resolve_path_mappings(root, team_vault_id, &scope);
    let file_mappings_path = root.join(".slash").join("team_file_mappings.json");
    let mut file_mappings_file = TeamFileMappingsFile::load(&file_mappings_path);
    let mut file_mappings = file_mappings_file.active_for_team(team_vault_id);
    let mut file_mappings_changed = false;

    // 构建 target→source 反向映射（用于 Pull）
    let reverse_mappings: std::collections::HashMap<&str, &str> = reverse_mappings_owned
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    // Step 3: 确定需要同步的 source 目录列表
    let source_dirs = resolve_source_dirs(&path_mappings, &directory_id_mappings, &scope);

    if source_dirs.is_empty() && !scope.is_full_scope {
        // 🛡️ BUG-E07 Fix 7: T-4 清除了所有 mapping 导致 source_dirs 为空 → 早期返回
        // 但 unified_state 中可能残留已删文件的 team_hash（因为 Step 10 不被执行）
        // 在返回前清理：team_hash 非空 + 本地文件不存在 → 清除该条目
        let mut unified_state = load_unified_state(root);
        let mut cleaned = false;
        let keys: Vec<String> = unified_state
            .keys()
            .filter(|k| *k != "vault_id")
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = unified_state.get(&key) {
                if !entry.team_hash.is_empty() && !root.join(&key).exists() {
                    log::debug!(
                        "[TeamSync] Fix7: early-return cleanup — removing dead entry '{}' (team_hash set but file gone)",
                        key
                    );
                    unified_state.remove(&key);
                    cleaned = true;
                }
            }
        }
        if cleaned {
            save_unified_state(root, &unified_state);
        }
        return Ok((0, 0, vec![], vec![], vec![], false, None, None)); // 无可同步的目录
    }

    // Step 3.5: 为所有映射的 scope 目录在本地创建空目录（确保空目录也可见）
    // 🛡️ 冲突防御：若本地已有同名个人目录（非团队映射），先改名避让
    for src_dir in &source_dirs {
        let local_dir = root.join(src_dir);
        if local_dir.exists() {
            // 检查该目录是否已在 path_mappings 中（说明已是团队映射目录），
            // 若不在，则说明是用户原有的个人目录，需要避让
            let is_already_mapped = path_mappings.contains_key(*src_dir);
            if !is_already_mapped {
                // 构建避让名称：dirname（个人）
                let dir_name = local_dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let personal_name = format!("{}（个人）", dir_name);
                let personal_dir = local_dir.with_file_name(&personal_name);
                if !personal_dir.exists() {
                    match std::fs::rename(&local_dir, &personal_dir) {
                        Ok(_) => {
                            log::debug!(
                                "[TeamSync] 🛡️ Renamed existing personal dir '{}' → '{}' to avoid team collision",
                                src_dir, personal_name
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "[TeamSync] Failed to rename personal dir '{}': {e}",
                                local_dir.display()
                            );
                        }
                    }
                } else {
                    log::warn!(
                        "[TeamSync] Both '{}' and '{}' exist, skipping rename",
                        local_dir.display(),
                        personal_dir.display()
                    );
                }
            }
        }
        if !local_dir.exists() {
            if let Err(e) = std::fs::create_dir_all(&local_dir) {
                log::error!(
                    "[TeamSync] Failed to create local dir {}: {e}",
                    local_dir.display()
                );
            } else {
                log::debug!("[TeamSync] Created local empty dir: {}", src_dir);
            }
        }
    }

    // Step 4: 加载统一同步状态
    let mut unified_state = load_unified_state(root);
    let now_secs_for_session = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let max_sync_file_size = {
        use tauri::Manager;
        app.try_state::<crate::state::SyncCapabilitiesState>()
            .map(|s| s.0.lock().unwrap().max_sync_file_size)
            .unwrap_or(slash_core::TEAM_ASSET_MAX_SIZE_DEFAULT)
    };

    // Step 5: 扫描本地文件，按 source_dir 过滤并构建映射文件列表
    let manifests = scan_directory_manifests(root, Some(max_sync_file_size));

    // 🛡️ 目录级隔离：收集 managed_dirs 中的目录前缀（用于排除独立子目录的文件）
    let managed_prefixes: Vec<String> = scope
        .managed_dirs
        .iter()
        .map(|d| normalize_prefix(d.trim_end_matches('/')))
        .collect();

    // mapped_files: (target_path, source_manifest)
    let mut mapped_files = build_team_mapped_files(
        &manifests,
        &path_mappings,
        &file_mappings,
        &directory_id_mappings,
        &source_dirs,
        &scope,
        &managed_prefixes,
    );

    // [OPT-04.5] 资产目录闭包提纯：绝不能抓取本地所有资产！
    // 必须从 mapped_files (团队管辖内的有效笔记) 物理读取其 AST 闭包来约束资产
    let mut team_required_assets: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (_, m) in &mapped_files {
        if m.relative_path.ends_with(".md") {
            let full_path = root.join(&m.relative_path);
            if let Ok(content) = std::fs::read(&full_path) {
                if let Some(assets) = crate::commands::sync::helpers::extract_asset_refs(&content) {
                    for a in assets {
                        team_required_assets.insert(a.relative_path);
                    }
                }
            }
        }
    }

    // 使用原路径（无需重映射），且只允许真实属于团队圈的资产放行
    for m in &manifests {
        if m.relative_path.starts_with("assets/") || m.relative_path.starts_with(".slash/assets/") {
            if team_required_assets.contains(&m.relative_path) {
                mapped_files.push((m.relative_path.clone(), m));
            }
        }
    }

    for (target_path, manifest) in &mapped_files {
        if !manifest.relative_path.ends_with(".md") {
            continue;
        }
        let Some(file_id) = manifest.file_id.as_deref() else {
            continue;
        };
        let directory_id =
            resolve_directory_id_for_team_path(target_path, &path_mappings, &directory_id_mappings);
        let should_upsert = file_mappings
            .get(file_id)
            .map(|existing| {
                existing.local_path != manifest.relative_path
                    || existing.remote_path != *target_path
                    || existing.directory_id != directory_id
            })
            .unwrap_or(true);
        if should_upsert {
            file_mappings_file.upsert(
                team_vault_id,
                file_id.to_string(),
                manifest.relative_path.clone(),
                target_path.clone(),
                directory_id.clone(),
            );
            file_mappings.insert(
                file_id.to_string(),
                super::path_mapping::TeamFileMapping {
                    file_id: file_id.to_string(),
                    local_path: manifest.relative_path.clone(),
                    remote_path: target_path.clone(),
                    directory_id,
                    status: "active".to_string(),
                },
            );
            file_mappings_changed = true;
        }
    }

    for (_, manifest) in &mapped_files {
        if let Some(entry) = unified_state.get_mut(&manifest.relative_path) {
            expire_edit_session_if_idle(entry, now_secs_for_session);
        }
    }

    // Step 6: 检测已删除文件
    let current_target_paths: std::collections::HashSet<&str> =
        mapped_files.iter().map(|(tp, _)| tp.as_str()).collect();
    let deleted_paths = detect_team_deleted(
        &mut unified_state,
        &current_target_paths,
        &reverse_mappings,
        root,
        &mapped_files,
    );
    let deleted_files = deleted_paths
        .iter()
        .map(|path| slash_sync_proto::DeletedFile {
            path: path.clone(),
            file_id: resolve_deleted_file_id(path, &unified_state, &reverse_mappings),
        })
        .collect::<Vec<_>>();

    // 🔍 诊断日志
    log::trace!(
        "[TeamSync] source_dirs={:?}, is_full_scope={}, scope_dirs_count={}",
        source_dirs,
        scope.is_full_scope,
        scope.scope_dirs.len()
    );
    log::trace!(
        "[TeamSync] mapped_files count={}, paths:",
        mapped_files.len()
    );
    for (i, (tp, sm)) in mapped_files.iter().enumerate() {
        log::trace!(
            "[TeamSync]   mapped[{}]: target='{}' source='{}' hash='{}'",
            i,
            tp,
            sm.relative_path,
            sm.content_hash
        );
    }
    if !deleted_paths.is_empty() {
        log::debug!("[TeamSync] deleted_paths={:?}", deleted_paths);
    } else {
        log::trace!("[TeamSync] deleted_paths=[]");
    }

    // Step 5.5: 存量脏 snapshot 自愈（disk == team_hash 安全重置）
    //
    // 问题：历史 contributor 写入导致 local_snapshot != disk_hash（存量脏状态），
    //       即使 contributor-guard 修复后，历史脏状态仍会误触发 push。
    //
    // 自愈条件（同时满足，缺一不可）：
    //   1. disk_hash == team_hash     → 磁盘恰好等于服务端版本 → B 未超出服务端
    //   2. disk_hash != local_snapshot → snapshot 是旧的脏值
    //   3. 文件不在 editing_set        → 不是正在活跃编辑的文件
    //
    // 与旧 Step 5.5 的关键区别：
    //   旧：disk == local_snapshot（无法区分漂移与真实编辑，存在丢失用户编辑风险）
    //   新：disk == team_hash（磁盘已是服务端版本，重置 snapshot 安全，不影响任何数据）
    let mut unified_state = unified_state;
    for (_, m) in &mapped_files {
        let state_opt = unified_state.get(&m.relative_path);
        let team_hash = state_opt.map(|s| s.team_hash.as_str()).unwrap_or("");
        let snapshot = state_opt.map(|s| s.local_snapshot.as_str()).unwrap_or("");
        let disk_eq_team = !team_hash.is_empty() && m.content_hash == team_hash;
        let snapshot_stale = snapshot != m.content_hash;
        let not_editing = !editing_set.contains(&m.relative_path);
        if disk_eq_team && snapshot_stale && not_editing {
            log::debug!(
                "[TeamSync] Step5.5 drift-heal '{}' disk==team_hash={} → reset local_snapshot",
                m.relative_path,
                &team_hash[..8.min(team_hash.len())]
            );
            if let Some(entry) = unified_state.get_mut(&m.relative_path) {
                entry.local_snapshot = m.content_hash.clone();
            }
        }
    }

    // Step 7: 构建 negotiate 请求
    // 🛡️ 关键守卫：local_hash == local_snapshot → 用户没编辑过 → 不 push
    let client_files: Vec<slash_sync_proto::NegotiateFileEntry> = mapped_files
        .iter()
        .map(|(target_path, m)| {
            // base_hash 取自 unified_state，key 是本地路径
            let base_hash = unified_state
                .get(&m.relative_path)
                .map(|s| s.team_hash.clone())
                .unwrap_or_default();

            // 🛡️ 关键守卫：disk == local_snapshot → 用户没编辑 → 不 push
            // 返回 (effective_hash, effective_base, reason)
            // effective_base 通常 == base_hash，但特殊情况下需要覆盖
            let (effective_hash, effective_base, guard_reason) = if let Some(state) = unified_state.get(&m.relative_path) {
                if !state.local_snapshot.is_empty() && m.content_hash == state.local_snapshot {
                    if base_hash.is_empty() {
                        (m.content_hash.clone(), m.content_hash.clone(), "snapshot_match_base_empty→disk_as_base(no_push)")
                    } else if m.content_hash == base_hash {
                        // ✅ disk == snapshot == team_hash → 三者一致，真正无变化
                        (base_hash.clone(), base_hash.clone(), "snapshot_match→use_base_hash(no_push)")
                    } else {
                        // 🛡️ BUG-E10: disk == snapshot 但 ≠ team_hash → Personal Sync 漂移
                        // Personal Sync pull 更新了 local_snapshot 但未更新 team_hash，
                        // 守卫掩盖了 disk 与 Team vault 的差异 → 永久死锁。
                        // 发送真实磁盘 hash，让服务端裁决
                        (m.content_hash.clone(), base_hash.clone(), "snapshot_match_but_team_drift→send_real_hash")
                    }
                } else {
                    // 用户真实编辑发生：disk != local_snapshot
                    // 若 edit_started_at 尚未记录，立即记录（first-edit-wins）
                    // 用户编辑发生（disk != local_snapshot）
                    // edit_started_at 由 Step 10 new_state 更新时负责记录（first-edit-wins）
                    (m.content_hash.clone(), base_hash.clone(), "snapshot_mismatch→user_edited")
                }
            } else {
                (m.content_hash.clone(), base_hash.clone(), "no_state→first_time")
            };

            let state_info = unified_state.get(&m.relative_path);
            log::trace!(
                "[TeamSync] 📊 file='{}' disk_hash={} team_hash={} local_snapshot={} effective={} base={} eff_base={} guard={}",
                m.relative_path,
                &m.content_hash[..8],
                state_info.map(|s| &s.team_hash[..std::cmp::min(8, s.team_hash.len())]).unwrap_or("EMPTY"),
                state_info.map(|s| &s.local_snapshot[..std::cmp::min(8, s.local_snapshot.len())]).unwrap_or("EMPTY"),
                &effective_hash[..8],
                if base_hash.is_empty() { "EMPTY" } else { &base_hash[..8] },
                if effective_base.is_empty() { "EMPTY" } else { &effective_base[..8] },
                guard_reason
            );

            slash_sync_proto::NegotiateFileEntry {
                path: target_path.clone(),
                hash: effective_hash,
                base_hash: effective_base,
                file_id: m.file_id.clone(),
            }
        })
        .collect();

    // directory_hashes 必须基于 effective_hash（和 client_files 一致），
    // 否则 server 的 Merkle 快速路径判断会与文件级比较不一致。
    let directory_hashes = {
        let mut dir_files: std::collections::HashMap<String, Vec<&str>> =
            std::collections::HashMap::new();
        for entry in &client_files {
            let dir = if let Some(pos) = entry.path.rfind('/') {
                entry.path[..=pos].to_string()
            } else {
                "/".to_string()
            };
            dir_files.entry(dir).or_default().push(&entry.hash);
        }
        dir_files
            .into_iter()
            .map(|(path, mut hashes)| {
                let file_count = hashes.len() as u32;
                let merkle_hash = slash_core::calculate_directory_hash(&mut hashes);
                slash_sync_proto::DirectoryHash {
                    path,
                    merkle_hash,
                    file_count,
                }
            })
            .collect::<Vec<_>>()
    };

    let negotiate_req = SyncNegotiateRequest {
        vault_id: team_vault_id.clone(),
        space_type: SpaceType::Team(team_vault_id.clone()),
        directory_hashes,
        client_clock: 0,
        client_files,
        deleted_paths: deleted_paths.clone(),
        deleted_files: deleted_files.clone(),
    };

    log::trace!(
        "[TeamSync] Negotiate: vault={}, files={}, scope={}",
        team_vault_id,
        negotiate_req.client_files.len(),
        if scope.is_full_scope {
            "full"
        } else {
            "scoped"
        }
    );

    let negotiate_resp = sync_client.negotiate(&negotiate_req).await?;

    if negotiate_resp.server_needs.is_empty()
        && negotiate_resp.client_needs.is_empty()
        && negotiate_resp.server_deleted.is_empty()
    {
        log::trace!(
            "[TeamSync] Negotiate result: server_needs=0, client_needs=0, server_deleted=0"
        );
    } else {
        log::info!(
            "[TeamSync] Negotiate result: server_needs={}, client_needs={}, server_deleted={}",
            negotiate_resp.server_needs.len(),
            negotiate_resp.client_needs.len(),
            negotiate_resp.server_deleted.len()
        );
    }

    // Step 8: Push — server 需要的文件
    let mut files_pushed = 0u32;
    let mut push_accepted_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut push_rejected_pull: Vec<String> = Vec::new();

    // Step 7.5: 处理服务器发回的被删文件 (server_deleted)
    // 🛡️ BUG-E07 Fix 1: 收集被 server_deleted 删除的本地路径，防止 Step 10 复活状态
    let mut server_deleted_local_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut pending_server_deleted_files: Vec<PendingServerDeletedFile> = Vec::new();
    let mut frontend_server_deleted: Vec<slash_sync_proto::DeletedFile> = Vec::new();
    let mut frontend_server_deleted_keys: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    if !negotiate_resp.server_deleted.is_empty() {
        log::debug!(
            "[TeamSync] Server marked {} files as deleted, removing locally...",
            negotiate_resp.server_deleted.len()
        );
        for deleted_file in &negotiate_resp.server_deleted {
            let deleted_team_path = &deleted_file.path;
            // 反向查找本地路径：优先 file_id 文件映射，再使用目录 reverse_mappings。
            let local_rel = deleted_file
                .file_id
                .as_deref()
                .and_then(|file_id| file_mappings.get(file_id).map(|m| m.local_path.clone()))
                .or_else(|| {
                    reverse_mappings.iter().find_map(|(tgt_dir, src_dir)| {
                        let tgt_prefix = normalize_prefix(tgt_dir);
                        let src_prefix = normalize_prefix(src_dir);
                        if deleted_team_path.starts_with(&tgt_prefix) {
                            let rel = deleted_team_path
                                .strip_prefix(&tgt_prefix)
                                .unwrap_or(deleted_team_path);
                            Some(format!("{src_prefix}{rel}"))
                        } else {
                            None
                        }
                    })
                })
                .or_else(|| {
                    // 回退到 PARA 根级映射（01_PROJECTS→01_Projects 等）
                    // Admin rename/delete 后，原目录可能已不在 scope 中，reverse_mappings 无映射
                    PARA_TEAM_TO_PERSONAL
                        .iter()
                        .find_map(|(team_root, personal_root)| {
                            let team_prefix = normalize_prefix(team_root);
                            if deleted_team_path.starts_with(&team_prefix) {
                                let rel = deleted_team_path
                                    .strip_prefix(&team_prefix)
                                    .unwrap_or(deleted_team_path);
                                let personal_prefix = normalize_prefix(personal_root);
                                Some(format!("{personal_prefix}{rel}"))
                            } else {
                                None
                            }
                        })
                });

            if let Some(local_rel) = local_rel {
                // Safety invariant: Ensure local_rel is not actively mapped to a different, valid team_path.
                // If it is, the server deletion was for an OLD path (due to Admin rename/move), and we MUST NOT delete the expressly mapped local file that is safely synced in the new remote path.
                let mut current_team_path = deleted_file
                    .file_id
                    .as_deref()
                    .and_then(|file_id| file_mappings.get(file_id))
                    .map(|mapping| mapping.remote_path.clone());
                if current_team_path.is_none() {
                    for (src_dir, tgt_dir) in &path_mappings {
                        let src_prefix = normalize_prefix(src_dir);
                        if local_rel.starts_with(&src_prefix) || local_rel == src_dir.as_str() {
                            let rel = local_rel.strip_prefix(&src_prefix).unwrap_or(&local_rel);
                            let tgt_prefix = normalize_prefix(tgt_dir);
                            current_team_path = Some(format!("{tgt_prefix}{rel}"));
                            break;
                        }
                    }
                }

                if let Some(active_path) = current_team_path {
                    let is_in_server_deleted = negotiate_resp
                        .server_deleted
                        .iter()
                        .any(|d| d.path == active_path);
                    if active_path != *deleted_team_path && !is_in_server_deleted {
                        log::debug!("[TeamSync] Skipping local delete for mapped file: local {} is now active at {}", local_rel, active_path);
                        continue;
                    }
                }

                let local_full_path = root.join(&local_rel);

                // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
                if let Err(e) =
                    crate::commands::sync::helpers::validate_path_in_vault(&local_full_path, &root)
                {
                    log::error!(
                        "[TeamSync] 🚫 Path traversal blocked on delete: path={}, err={}",
                        local_rel,
                        e
                    );
                    continue;
                }

                if local_full_path.exists() {
                    // 🛡️ BUG-SYNC-01: Verify UUID matches before deletion
                    if local_rel.ends_with(".md") {
                        if let Some(ref expected_uuid) = deleted_file.file_id {
                            if let Ok(content) = std::fs::read(&local_full_path) {
                                if let Some(local_uuid) =
                                    crate::commands::sync::helpers::extract_slash_id_str(&content)
                                {
                                    if local_uuid != *expected_uuid {
                                        log::warn!("[TeamSync] Skipping deletion of {} because local UUID {} does not match server UUID {}. This file was likely recreated.", local_rel, local_uuid, expected_uuid);
                                        continue;
                                    }
                                }
                            }
                        }
                    }

                    if let Err(e) = std::fs::remove_file(&local_full_path) {
                        log::error!(
                            "[TeamSync] Failed to delete locally {}, err: {}",
                            local_full_path.display(),
                            e
                        );
                    } else {
                        log::debug!("[TeamSync] Deleted local file: {}", local_rel);
                        // 清理空目录
                        if let Some(parent) = local_full_path.parent() {
                            let _ = std::fs::remove_dir(parent); // 仅删除空目录，非空会自动失败
                        }
                        server_deleted_local_paths.insert(local_rel.clone());
                        if let Some(file_id) = deleted_file.file_id.clone() {
                            pending_server_deleted_files.push(PendingServerDeletedFile {
                                local_rel: local_rel.clone(),
                                team_path: deleted_team_path.clone(),
                                file_id,
                            });
                        } else {
                            push_frontend_server_deleted(
                                &mut frontend_server_deleted,
                                &mut frontend_server_deleted_keys,
                                local_rel.clone(),
                                None,
                            );
                        }
                        if let Some(entry) = unified_state.get_mut(&local_rel) {
                            entry.team_hash.clear();
                            entry.local_snapshot.clear();
                        }
                    }
                } else {
                    server_deleted_local_paths.insert(local_rel.clone());
                    if let Some(file_id) = deleted_file.file_id.clone() {
                        pending_server_deleted_files.push(PendingServerDeletedFile {
                            local_rel: local_rel.clone(),
                            team_path: deleted_team_path.clone(),
                            file_id,
                        });
                    } else {
                        push_frontend_server_deleted(
                            &mut frontend_server_deleted,
                            &mut frontend_server_deleted_keys,
                            local_rel.clone(),
                            None,
                        );
                    }
                    if let Some(entry) = unified_state.get_mut(&local_rel) {
                        entry.team_hash.clear();
                        entry.local_snapshot.clear();
                    }
                }
            } else {
                log::warn!(
                    "[TeamSync] Cannot resolve local path for deleted team file: {}",
                    deleted_team_path
                );
                if let Some(file_id) = deleted_file.file_id.clone() {
                    pending_server_deleted_files.push(PendingServerDeletedFile {
                        local_rel: deleted_team_path.clone(),
                        team_path: deleted_team_path.clone(),
                        file_id,
                    });
                } else {
                    push_frontend_server_deleted(
                        &mut frontend_server_deleted,
                        &mut frontend_server_deleted_keys,
                        deleted_team_path.clone(),
                        None,
                    );
                }
            }
        }
    }

    // 🛡️ BUG-E07 Fix 4: 清理因 server_deleted 产生的空壳目录
    for local_rel in &server_deleted_local_paths {
        let local_full = root.join(local_rel);
        if let Some(parent) = local_full.parent() {
            // 递归向上清理空目录，直到遇到非空目录或 vault root
            let mut dir = parent.to_path_buf();
            while dir > *root {
                match std::fs::read_dir(&dir) {
                    Ok(mut entries) => {
                        if entries.next().is_none() {
                            let _ = std::fs::remove_dir(&dir);
                            log::debug!("[TeamSync] Removed empty dir: {}", dir.display());
                        } else {
                            break; // 非空，停止
                        }
                    }
                    Err(_) => break,
                }
                dir = match dir.parent() {
                    Some(p) => p.to_path_buf(),
                    None => break,
                };
            }
        }
    }

    // Step 7.6: 处理身份冲突 (identity_conflicts)
    // 🛡️ 服务端检测到路径相同但 file_id 不一致，拒绝接收但不要求删除
    // 客户端保留本地文件，仅记录日志
    if !negotiate_resp.identity_conflicts.is_empty() {
        log::warn!(
            "[TeamSync] ⚠️ {} identity conflict(s) detected — local files preserved",
            negotiate_resp.identity_conflicts.len()
        );
        for conflict in &negotiate_resp.identity_conflicts {
            log::warn!(
                "[TeamSync] ⚠️ Identity conflict: path='{}' client_fid={:?} server_fid={:?} reason='{}'",
                conflict.path, conflict.client_file_id, conflict.server_file_id, conflict.reason
            );
        }
    }

    if !negotiate_resp.server_needs.is_empty() {
        let mut files_to_push =
            collect_mapped_files_for_push(root, &mapped_files, &negotiate_resp.server_needs);

        for payload in &mut files_to_push {
            payload.manifest.directory_id = resolve_directory_id_for_team_path(
                &payload.manifest.relative_path,
                &path_mappings,
                &directory_id_mappings,
            );
        }

        // OPT-04 第二道保险：剥离超出 Team 大小限制的资产引用
        for payload in &mut files_to_push {
            payload.manifest.assets =
                filter_oversized_assets(root, payload.manifest.assets.take(), max_sync_file_size);
        }

        // 注入 edit session：服务端用它把同一段编辑合并成一个历史版本。
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        for payload in &mut files_to_push {
            // payload.manifest.relative_path 是 team 路径，需反向找 local 路径
            let local_path = reverse_mappings.iter().find_map(|(tgt_dir, src_dir)| {
                let tgt_prefix = normalize_prefix(tgt_dir);
                let src_prefix = normalize_prefix(src_dir);
                if payload.manifest.relative_path.starts_with(&tgt_prefix) {
                    let rel = payload
                        .manifest
                        .relative_path
                        .strip_prefix(&tgt_prefix)
                        .unwrap_or(&payload.manifest.relative_path);
                    Some(format!("{src_prefix}{rel}"))
                } else {
                    None
                }
            });
            let local_state_key = local_path
                .as_deref()
                .unwrap_or(&payload.manifest.relative_path);
            let entry = unified_state
                .entry(local_state_key.to_string())
                .or_default();
            let edit_started = entry.edit_started_at.unwrap_or(now_secs);
            let edit_session_id = entry.edit_session_id.clone().unwrap_or_else(|| {
                make_edit_session_id(
                    local_state_key,
                    edit_started,
                    payload.manifest.file_id.as_deref(),
                )
            });
            entry.edit_started_at = Some(edit_started);
            entry.edit_session_id = Some(edit_session_id.clone());
            entry.edit_session_touched_at = Some(now_secs);
            // 取 edit_started_at（已记录）或 now（首次 push，编辑刚发生）
            payload.manifest.edit_started_at = Some(edit_started);
            payload.manifest.edit_session_id = Some(edit_session_id);
        }

        if !files_to_push.is_empty() {
            // 🛡️ [Phase 6] 断言：asset 路径的 content 必须为空，不允许 blob 进入 JSON payload
            for payload in &files_to_push {
                let is_asset_path = payload.manifest.relative_path.starts_with("assets/")
                    || payload.manifest.relative_path.starts_with(".slash/assets/");
                if is_asset_path && !payload.content.is_empty() {
                    log::error!(
                        "[Phase6 TeamSync] 🚫 FATAL: asset blob leaked into push payload! path={} content_bytes={}",
                        payload.manifest.relative_path, payload.content.len()
                    );
                    return Err(format!(
                        "Phase6 safety violation: asset blob in push payload (path={}, {} bytes)",
                        payload.manifest.relative_path,
                        payload.content.len()
                    ));
                }
            }

            let push_req = SyncPushRequest {
                vault_id: team_vault_id.clone(),
                files: files_to_push,
            };

            let push_resp = sync_client.push(&push_req).await?;
            files_pushed = push_resp.accepted.len() as u32;
            push_accepted_paths = push_resp.accepted.into_iter().collect();
            for rf in &push_resp.rejected {
                log::debug!(
                    "[TeamSync] Push rejected (reason={}) → will pull server version: {}",
                    rf.reason,
                    rf.path
                );
                push_rejected_pull.push(rf.path.clone());
            }
            log::debug!(
                "[TeamSync] Pushed {} files, {} rejected",
                files_pushed,
                push_resp.rejected.len()
            );
        }
    }

    // ── [Phase 6] Step 8.5: 资产 Blob 传输方向判定 ──────────────────────────
    // 核心原则：
    //   - client_needs 中的 asset / 本地缺失或 0 字节 → download（从 CAS 拉取 blob）
    //   - 本地有完整 blob 且 server 需要（push_accepted / server_needs） → upload
    //   - download 不受 max_sync_file_size 限制
    //   - upload 受 max_sync_file_size 限制
    {
        use tauri::Manager;
        if let Some(db_state) = app.try_state::<crate::state::DbStateWrapper>() {
            if let Ok(conn_guard) = db_state.0.connection.lock() {
                if let Some(conn) = conn_guard.as_ref() {
                    let mut uploads_enqueued = 0u32;
                    let mut dl_created = 0u32;
                    let mut dl_revived = 0u32;
                    let mut dl_skipped_valid = 0u32;
                    let mut dl_skipped_inflight = 0u32;
                    let mut skipped = 0u32;

                    // 构建 client_needs 的 asset 集合（这些是 server 告诉 bb 缺少的资产）
                    let client_needs_assets: std::collections::HashSet<&str> = negotiate_resp
                        .client_needs
                        .iter()
                        .filter(|p| p.starts_with("assets/") || p.starts_with(".slash/assets/"))
                        .map(|p| p.as_str())
                        .collect();

                    // 构建本轮 push 成功的 asset 集合（这些是当前用户主动上传的 declaration）
                    let pushed_assets: std::collections::HashSet<&str> = push_accepted_paths
                        .iter()
                        .filter(|p| p.starts_with("assets/") || p.starts_with(".slash/assets/"))
                        .map(|p| p.as_str())
                        .collect();

                    // 从 negotiate 的 asset_manifest 构建 hash→size 索引（服务端权威 size）
                    let server_asset_sizes: std::collections::HashMap<&str, u64> = negotiate_resp
                        .asset_manifest
                        .as_ref()
                        .map(|entries| entries.iter().map(|e| (e.hash.as_str(), e.size)).collect())
                        .unwrap_or_default();

                    for m in &manifests {
                        let is_asset = m.relative_path.starts_with("assets/")
                            || m.relative_path.starts_with(".slash/assets/");
                        if !is_asset {
                            continue;
                        }
                        if !team_required_assets.contains(&m.relative_path) {
                            continue;
                        }

                        let local_path = root.join(&m.relative_path);

                        // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
                        if let Err(e) = crate::commands::sync::helpers::validate_path_in_vault(
                            &local_path,
                            root,
                        ) {
                            log::error!("[Phase6 TeamSync] 🚫 Path traversal blocked on asset check: path={}, err={}", m.relative_path, e);
                            continue;
                        }

                        let local_exists = local_path.exists();
                        let local_size = if local_exists {
                            std::fs::metadata(&local_path)
                                .map(|meta| meta.len())
                                .unwrap_or(0)
                        } else {
                            0
                        };

                        // ── 方向判定 ──────────────────────────────────────
                        // 情况 A: 资产在 client_needs 中 → server 有 blob，本地缺
                        // 情况 B: 本地不存在或 0 字节 → 一定是接收端，需下载
                        let is_download_candidate = client_needs_assets
                            .contains(m.relative_path.as_str())
                            || !local_exists
                            || local_size == 0;

                        if is_download_candidate {
                            // ── DOWNLOAD 路径：从 CAS 下载 blob ──────────────
                            // 🛡️ 绝对不检查 max_sync_file_size — download 不受上传限制
                            log::debug!(
                                "[Phase6 TeamSync] asset direction=download source={} path={} local_size={} manifest_size={}",
                                if client_needs_assets.contains(m.relative_path.as_str()) { "server_manifest" } else { "local_missing" },
                                m.relative_path, local_size, m.size
                            );

                            // download size 优先级：
                            // 1. 服务端 asset_manifest（权威 size）
                            // 2. 本地 manifest size（如果非 0）
                            // 3. 0（execute_download 的 HEAD 会获取真实 content-length 并回写）
                            let download_size = server_asset_sizes
                                .get(m.content_hash.as_str())
                                .copied()
                                .filter(|s| *s > 0)
                                .unwrap_or_else(|| if m.size > 0 { m.size } else { 0 });

                            match crate::core::transfer_manager::TransferManager::enqueue_download(
                                conn,
                                team_vault_id,
                                &m.content_hash,
                                &m.relative_path,
                                download_size,
                                root,
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
                                    "[Phase6 TeamSync] ❌ enqueue download failed: path={} err={}",
                                    m.relative_path,
                                    e
                                ),
                            }
                            continue;
                        }

                        // ── UPLOAD 路径：本地有完整 blob，推送到 CAS ──────────
                        // 前提：本地文件存在、size > 0、且是当前用户产生的资产
                        let is_upload_candidate = local_exists
                            && local_size > 0
                            && (pushed_assets.contains(m.relative_path.as_str())
                                || !client_needs_assets.contains(m.relative_path.as_str()));

                        if !is_upload_candidate {
                            continue;
                        }

                        // 前置检查：pending/active/completed 均跳过
                        if crate::core::transfer_manager::TransferManager::should_skip_upload_enqueue(
                            conn, team_vault_id, &m.content_hash,
                        ) {
                            log::debug!("[Phase6 TeamSync] asset already uploaded, skip enqueue: path={} hash={}", m.relative_path, &m.content_hash[..8.min(m.content_hash.len())]);
                            skipped += 1;
                            continue;
                        }

                        log::debug!(
                            "[Phase6 TeamSync] asset direction=upload source=local_edit path={} size={}",
                            m.relative_path, local_size
                        );

                        match crate::core::transfer_manager::TransferManager::enqueue_upload(
                            conn,
                            team_vault_id,
                            &m.content_hash,
                            &m.relative_path,
                            m.size,
                        ) {
                            Ok(true) => uploads_enqueued += 1,
                            Ok(false) => skipped += 1,
                            Err(e) => log::error!(
                                "[Phase6 TeamSync] ❌ enqueue upload failed: path={} err={}",
                                m.relative_path,
                                e
                            ),
                        }
                    }

                    let total_dl = dl_created + dl_revived + dl_skipped_valid + dl_skipped_inflight;
                    if uploads_enqueued > 0 || total_dl > 0 || skipped > 0 {
                        log::debug!(
                            "[Phase6 TeamSync] asset transfer summary: uploads={} dl_created={} dl_revived={} dl_skipped_valid={} dl_skipped_inflight={} upload_skipped={}",
                            uploads_enqueued, dl_created, dl_revived, dl_skipped_valid, dl_skipped_inflight, skipped
                        );
                    }
                    let needs_notify = uploads_enqueued > 0 || dl_created > 0 || dl_revived > 0;
                    if needs_notify {
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

    // Step 9: Pull — client 需要的文件（双向同步关键）
    let mut pullable_paths = filter_pullable_paths(
        &negotiate_resp.client_needs,
        &reverse_mappings,
        &managed_prefixes,
        &path_mappings,
        &scope,
    );

    // 🛡️ PR 拒绝回退：将 push 被拒绝的文件加入 pull 列表，回退到 server 版本
    for rejected_path in &push_rejected_pull {
        if !pullable_paths.contains(rejected_path) {
            pullable_paths.push(rejected_path.clone());
        }
    }

    let mut files_pulled = 0u32;
    let mut pulled_local_paths: Vec<String> = Vec::new();
    let mut pulled_hashes: Vec<(String, String, String, Option<String>)> = Vec::new();
    let mut pull_dl_created = 0u32;
    let mut pull_dl_revived = 0u32;
    let mut pull_dl_skipped_valid = 0u32;
    let mut pull_dl_skipped_inflight = 0u32;
    let mut moved_team_file_paths: Vec<(String, String)> = Vec::new();
    if !pullable_paths.is_empty() {
        let pull_req = SyncPullRequest {
            vault_id: team_vault_id.clone(),
            paths: pullable_paths.clone(),
        };

        let pull_resp = sync_client.pull(&pull_req).await?;

        for file in &pull_resp.files {
            let (local_path, local_rel) = resolve_team_pull_local_path(
                root,
                team_vault_id,
                &file.manifest,
                &reverse_mappings,
                &scope,
                &mut file_mappings_file,
                &mut file_mappings,
                &mut file_mappings_changed,
                &mut moved_team_file_paths,
            );

            // 🛡️ Guard: Check if the path is located inside the vault to prevent Path Traversal
            if let Err(e) =
                crate::commands::sync::helpers::validate_path_in_vault(&local_path, &root)
            {
                log::error!(
                    "[TeamSync] 🚫 Path traversal blocked on write: path={}, err={}",
                    file.manifest.relative_path,
                    e
                );
                continue;
            }

            if let Some(parent) = local_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            // 🛡️ 安全兜底：跳过正在编辑中的文件
            if editing_set.contains(&local_rel) {
                log::info!(
                    "[TeamSync] ⚠️ Skip pull (editing): {} → {}",
                    file.manifest.relative_path,
                    local_rel
                );
                continue;
            }

            // 🛡️ [Phase 6] 资产文件且 content 为空 → 只是 manifest-only 声明，
            // 不写 0 字节文件到磁盘（否则会创建幽灵文件干扰 Step 8.5 方向判定）
            // 立即 enqueue_download 让 TransferManager 异步下载 blob
            let is_asset_path = file.manifest.relative_path.starts_with("assets/")
                || file.manifest.relative_path.starts_with(".slash/assets/");
            if is_asset_path && file.content.is_empty() {
                log::debug!(
                    "[Phase6 TeamSync] asset direction=download source=pull_manifest path={} hash={} manifest_size={}",
                    file.manifest.relative_path, file.manifest.content_hash, file.manifest.size
                );

                // enqueue download — size 可能为 0（server 返回的 manifest-only），
                // execute_download 的 HEAD 会获取真实 Content-Length 并回写
                {
                    use tauri::Manager;
                    if let Some(db_state) = app.try_state::<crate::state::DbStateWrapper>() {
                        if let Ok(conn_guard) = db_state.0.connection.lock() {
                            if let Some(conn) = conn_guard.as_ref() {
                                match crate::core::transfer_manager::TransferManager::enqueue_download(
                                    conn,
                                    team_vault_id,
                                    &file.manifest.content_hash,
                                    &file.manifest.relative_path,
                                    file.manifest.size,
                                    root,
                                ) {
                                    Ok(result) => {
                                        use crate::core::transfer_manager::DownloadAction;
                                        log::debug!(
                                            "[Phase6 TeamSync] pull download {}: id={} path={}",
                                            result.action.as_str(), result.task_id, file.manifest.relative_path
                                        );
                                        match result.action {
                                            DownloadAction::Created => pull_dl_created += 1,
                                            DownloadAction::Revived => pull_dl_revived += 1,
                                            DownloadAction::SkippedLocalValid => pull_dl_skipped_valid += 1,
                                            DownloadAction::SkippedInflight => pull_dl_skipped_inflight += 1,
                                        }
                                    }
                                    Err(e) => log::error!(
                                        "[Phase6 TeamSync] ❌ enqueue download from pull failed: path={} err={}",
                                        file.manifest.relative_path, e
                                    ),
                                }
                            }
                        }
                    }
                }

                // 仍然记录 hash 以更新 unified_state
                pulled_hashes.push((
                    file.manifest.relative_path.clone(),
                    file.manifest.content_hash.clone(),
                    local_rel.clone(),
                    file.manifest.pushed_by_user_id.clone(),
                ));
                continue;
            }

            match std::fs::write(&local_path, &file.content) {
                Ok(_) => {
                    files_pulled += 1;
                    pulled_local_paths.push(local_rel.clone());
                    pulled_hashes.push((
                        file.manifest.relative_path.clone(),
                        file.manifest.content_hash.clone(),
                        local_rel.clone(),
                        file.manifest.pushed_by_user_id.clone(),
                    ));
                    log::info!(
                        "[TeamSync] ✅ Pulled: {} → {}",
                        file.manifest.relative_path,
                        local_path.display()
                    );
                }
                Err(e) => {
                    log::error!(
                        "[TeamSync] Failed to write pulled file {}: {e}",
                        local_path.display()
                    );
                }
            }
        }
    }

    for pending in &pending_server_deleted_files {
        let revived_mapping = file_mappings.get(&pending.file_id).filter(|mapping| {
            mapping.status == "active"
                && mapping.remote_path != pending.team_path
                && root.join(&mapping.local_path).exists()
        });

        if let Some(mapping) = revived_mapping {
            log::debug!(
                "[TeamSync] server_deleted for old path '{}' resolved as move to '{}' (file_id={})",
                pending.team_path,
                mapping.remote_path,
                pending.file_id
            );
            continue;
        }

        push_frontend_server_deleted(
            &mut frontend_server_deleted,
            &mut frontend_server_deleted_keys,
            pending.local_rel.clone(),
            Some(pending.file_id.clone()),
        );
        file_mappings_file.mark_deleted(team_vault_id, &pending.file_id);
        file_mappings.remove(&pending.file_id);
        file_mappings_changed = true;
    }

    // 🔔 Pull 阶段 download 汇总
    {
        let total =
            pull_dl_created + pull_dl_revived + pull_dl_skipped_valid + pull_dl_skipped_inflight;
        if total > 0 {
            log::debug!(
                "[Phase6 TeamSync] pull asset download summary: created={} revived={} skipped_valid={} skipped_inflight={}",
                pull_dl_created, pull_dl_revived, pull_dl_skipped_valid, pull_dl_skipped_inflight
            );
        }
        let pull_needs_notify = pull_dl_created > 0 || pull_dl_revived > 0;
        if pull_needs_notify {
            use tauri::Manager;
            if let Some(notify_state) = app.try_state::<crate::state::TransferNotifyState>() {
                notify_state.0.notify_one();
            }
        }
    }

    // Step 10: 更新统一同步状态
    let mut new_state = unified_state;

    for (old_local, new_local) in &moved_team_file_paths {
        if old_local == new_local {
            continue;
        }
        if let Some(mut old_entry) = new_state.remove(old_local) {
            old_entry.team_hash.clear();
            old_entry.local_snapshot.clear();
            old_entry.file_id = None;
            if !old_entry.personal_hash.is_empty() {
                new_state.insert(old_local.clone(), old_entry);
            }
        }
    }

    // 已删除文件 → 清空 team_hash + local_snapshot，防止下轮重复发送 delete
    for deleted_target in &deleted_paths {
        // 反向查找本地路径
        let mut found = false;
        for (tgt_dir, src_dir) in &reverse_mappings {
            let tgt_prefix = normalize_prefix(tgt_dir);
            if deleted_target.starts_with(&tgt_prefix) {
                let relative = deleted_target
                    .strip_prefix(&tgt_prefix)
                    .unwrap_or(deleted_target);
                let src_prefix = normalize_prefix(src_dir);
                let local_path = format!("{src_prefix}{relative}");
                if let Some(entry) = new_state.get_mut(&local_path) {
                    entry.team_hash.clear();
                    entry.local_snapshot.clear();
                }
                found = true;
                break;
            }
        }
        // 🛡️ BUG-E07 Fix 5b: PARA 根级回退（T-4 purge 后 reverse_mappings 无映射时）
        if !found {
            for (team_root, personal_root) in PARA_TEAM_TO_PERSONAL {
                let team_prefix = normalize_prefix(team_root);
                if deleted_target.starts_with(&team_prefix) {
                    let relative = deleted_target
                        .strip_prefix(&team_prefix)
                        .unwrap_or(deleted_target);
                    let personal_prefix = normalize_prefix(personal_root);
                    let local_path = format!("{personal_prefix}{relative}");
                    if let Some(entry) = new_state.get_mut(&local_path) {
                        log::debug!(
                            "[TeamSync] Fix5b: PARA fallback cleared team_hash for '{}' (target='{}')",
                            local_path, deleted_target
                        );
                        entry.team_hash.clear();
                        entry.local_snapshot.clear();
                    }
                    break;
                }
            }
        }
        // 历史状态兼容：如果 unified_state 的 key 本身就是团队路径，
        // 上面的本地 PARA 回退清不到对应条目，这里按 target 直接清理。
        if let Some(entry) = new_state.get_mut(deleted_target.as_str()) {
            entry.team_hash.clear();
            entry.local_snapshot.clear();
        }
    }

    // Push 成功的文件 → 更新 team_hash + local_snapshot，清零 edit_started_at
    for (target_path, m) in &mapped_files {
        if push_accepted_paths.contains(target_path) {
            let entry = new_state.entry(m.relative_path.clone()).or_default();
            entry.team_hash = m.content_hash.clone();
            entry.local_snapshot = m.content_hash.clone();
            entry.edit_session_touched_at = Some(now_secs_for_session);
        }
    }

    // 用户编辑了但未 push（被 guard 屏蔽或周期未到）的文件 → 记录 edit_started_at
    // first-edit-wins: 若已有就保留，若没有则用当前时间
    let now_for_edit = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    for (_, m) in &mapped_files {
        let entry = new_state.entry(m.relative_path.clone()).or_default();
        // 判断是否是 user_edited 状态：disk != local_snapshot
        let is_user_edited = !entry.local_snapshot.is_empty()
            && m.content_hash != entry.local_snapshot
            && !push_accepted_paths.iter().any(|ap| {
                // 排除尚未分配 local 路径的和已 push 成功的文件
                // (push 成功的已在上方清零)
                ap == m.relative_path.as_str()
            });
        if is_user_edited {
            if entry.edit_started_at.is_none() || entry.edit_session_id.is_none() {
                // 首次检测到用户编辑，记录开始时间
                entry.edit_started_at = Some(now_for_edit);
                entry.edit_session_id = Some(make_edit_session_id(
                    &m.relative_path,
                    now_for_edit,
                    m.file_id.as_deref(),
                ));
            }
            entry.edit_session_touched_at = Some(now_for_edit);
        }
    }

    // Pull 的文件 → 更新 team_hash + local_snapshot（用 pull 后的磁盘 hash）
    for (_, server_hash, local_rel, pushed_by_user_id) in &pulled_hashes {
        let entry = new_state.entry(local_rel.clone()).or_default();
        let pulled_from_other_user = pushed_by_user_id
            .as_ref()
            .zip(active_user_id.as_ref())
            .map(|(remote, local)| remote != local)
            .unwrap_or(false);
        if pulled_from_other_user
            && (entry.edit_started_at.is_some()
                || entry.edit_session_id.is_some()
                || entry.edit_session_touched_at.is_some())
        {
            // A teammate has produced a new remote version for this file. Reset the local
            // edit session so the next edit starts a fresh history session instead of merging
            // into the previous user's snapshot window.
            entry.edit_started_at = None;
            entry.edit_session_id = None;
            entry.edit_session_touched_at = None;
        }
        entry.team_hash = server_hash.clone();
        // 重新读取磁盘 hash 作为快照
        let local_path = root.join(local_rel);
        if let Ok(content) = std::fs::read(&local_path) {
            let disk_hash = slash_core::calculate_content_hash_bytes(&content);
            entry.local_snapshot = disk_hash;
        } else {
            entry.local_snapshot = server_hash.clone();
        }
    }

    // 所有映射文件 → 确保 team_hash + local_snapshot 已初始化 + file_id 持久化
    // 关键：negotiate 返回 0/0（文件已同步）时也需要记录 team_hash，
    // 否则下次 negotiate 的 base_hash 为空 → server 误以为需要 push
    for (_, m) in &mapped_files {
        // 🛡️ BUG-E07 Fix 2: 跳过已被 server_deleted 删除的文件，防止状态复活
        if server_deleted_local_paths.contains(&m.relative_path) {
            continue;
        }
        let entry = new_state.entry(m.relative_path.clone()).or_default();
        if entry.team_hash.is_empty() {
            entry.team_hash = m.content_hash.clone();
        }
        if entry.local_snapshot.is_empty() {
            entry.local_snapshot = m.content_hash.clone();
        }
        // UUID-First: 持久化 file_id（从 frontmatter 提取），用于后续 rename 碰缘检测
        if m.file_id.is_some() {
            entry.file_id = m.file_id.clone();
        }
    }

    // 🛡️ BUG-E07 Fix 7b: 最终死条目收割 — 在保存前清理所有废弃 team_hash
    // 场景：Step 7.5 的 server_deleted 删除了文件，但 team_hash 清理因路径解析失败而遗漏
    {
        let mapped_set: std::collections::HashSet<&str> = mapped_files
            .iter()
            .map(|(_, m)| m.relative_path.as_str())
            .collect();
        let dead_keys: Vec<String> = new_state
            .keys()
            .filter(|k| *k != "vault_id")
            .filter(|k| {
                if let Some(entry) = new_state.get(*k) {
                    !entry.team_hash.is_empty()
                        && !root.join(k).exists()
                        && !mapped_set.contains(k.as_str())
                } else {
                    false
                }
            })
            .cloned()
            .collect();
        for key in &dead_keys {
            log::debug!(
                "[TeamSync] Fix7b: reaping dead unified_state entry '{}' (file gone, not in mapped_files)",
                key
            );
            // 🐛 FIX: 不能直接 remove 整个条目！
            // 如果 personal_hash 非空，personal sync 还需要检测到该文件被删除
            // 并将其发送到 personal vault 的 deleted_paths 中，触发 file_assets 解绑。
            // 直接 remove 会导致 personal sync 看不到这个条目 → deleted=0 → 僵尸资产循环。
            if let Some(entry) = new_state.get_mut(key.as_str()) {
                entry.team_hash.clear();
            }
        }
        // 移除 team_hash 和 personal_hash 都为空的死条目
        for key in &dead_keys {
            if let Some(entry) = new_state.get(key.as_str()) {
                if entry.personal_hash.is_empty() && entry.team_hash.is_empty() {
                    new_state.remove(key);
                }
            }
        }
    }

    if file_mappings_changed {
        file_mappings_file.save(&file_mappings_path);
    }
    save_unified_state(root, &new_state);

    // 记录真正写盘的文件路径（task scan 扩充之前的快照）
    let actually_pulled_local_paths = pulled_local_paths.clone();

    // 收集所有团队目录中的本地 .md 文件路径（用于前端扫描待办任务）
    for (_, source_manifest) in &mapped_files {
        if source_manifest.relative_path.ends_with(".md") {
            if !pulled_local_paths.contains(&source_manifest.relative_path) {
                pulled_local_paths.push(source_manifest.relative_path.clone());
            }
        }
    }

    log::trace!(
        "[TeamSync] Returning {} team .md paths for task scanning ({} actually pulled), is_maintenance={}",
        pulled_local_paths.len(),
        actually_pulled_local_paths.len(),
        negotiate_resp.is_maintenance
    );

    Ok((
        files_pushed,
        files_pulled,
        pulled_local_paths,
        actually_pulled_local_paths,
        frontend_server_deleted,
        negotiate_resp.is_maintenance,
        negotiate_resp.maintenance_started_at,
        negotiate_resp.server_capabilities,
    ))
}

// ============================================================
// 子函数（Step 6 内部拆分）
// ============================================================

/// 从 team_sync_state.json 中读取已知的团队 vault_id
fn read_known_team_vault_id(root: &std::path::Path) -> Option<String> {
    // 主路径：从 team_sync_state.json 读取
    let state_path = root.join(".slash/team_sync_state.json");
    if let Ok(raw) = std::fs::read_to_string(&state_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(vid) = json.get("vault_id").and_then(|v| v.as_str()) {
                if !vid.is_empty() {
                    return Some(vid.to_string());
                }
            }
        }
    }
    // Fallback：从 team_path_mappings.json 推断（取第一个团队的 vault_id）
    let mappings_path = root.join(".slash/team_path_mappings.json");
    let mappings = super::path_mapping::TeamPathMappingsFile::load(&mappings_path);
    mappings.teams.keys().next().cloned()
}

/// 解析路径映射（含自动发现和持久化）
fn resolve_path_mappings(
    root: &std::path::Path,
    team_vault_id: &str,
    scope: &slash_sync_proto::TeamScopeResponse,
) -> (
    std::collections::HashMap<String, String>,
    Vec<(String, String)>,
    std::collections::HashMap<String, String>,
) {
    let mappings_path = root.join(".slash").join("team_path_mappings.json");
    let mut legacy_mappings_file = TeamPathMappingsFile::load(&mappings_path);
    let directory_mappings_path = root.join(".slash").join("team_directory_mappings.json");
    let mut directory_mappings_file = TeamDirectoryMappingsFile::load(&directory_mappings_path);

    let mut legacy_path_mappings = legacy_mappings_file
        .teams
        .get(team_vault_id)
        .cloned()
        .unwrap_or_default();
    let mut path_mappings = directory_mappings_file.to_path_mappings(team_vault_id);
    let mut directory_id_mappings = directory_mappings_file.to_directory_id_mappings(team_vault_id);

    let scope_by_path: std::collections::HashMap<String, &slash_sync_proto::TeamScopeDir> = scope
        .scope_dirs
        .iter()
        .chain(scope.managed_scope_dirs.iter())
        .map(|sd| (sd.directory_path.trim_end_matches('/').to_string(), sd))
        .collect();
    let scope_by_id: std::collections::HashMap<String, &slash_sync_proto::TeamScopeDir> = scope
        .scope_dirs
        .iter()
        .chain(scope.managed_scope_dirs.iter())
        .filter_map(|sd| sd.directory_id.as_deref().map(|id| (id.to_string(), sd)))
        .collect();

    let mut directory_mappings_changed = false;

    // UUID-First: directory_id is the identity; remote_path is only the current
    // location. After a team directory rename, refresh persisted mappings before
    // any scan/push so stale paths cannot resurrect the old directory.
    if let Some(team) = directory_mappings_file.teams.get_mut(team_vault_id) {
        for mapping in team.directories.values_mut() {
            if mapping.status != "active" {
                continue;
            }
            let Some(scope_dir) = scope_by_id.get(&mapping.directory_id) else {
                continue;
            };
            let current_remote = scope_dir.directory_path.trim_end_matches('/').to_string();
            if mapping.remote_path.trim_end_matches('/') != current_remote {
                let previous_local = mapping.local_path.clone();
                let next_local = team_path_to_personal_path(&current_remote)
                    .unwrap_or_else(|| previous_local.clone());
                let next_local = if next_local == previous_local {
                    next_local
                } else {
                    choose_team_local_path(
                        root,
                        &next_local,
                        &path_mappings,
                        scope_dir.owner_display_name.as_deref(),
                    )
                };
                if next_local != previous_local {
                    let previous_local_dir = root.join(&previous_local);
                    let next_local_dir = root.join(&next_local);
                    if previous_local_dir.exists() && !next_local_dir.exists() {
                        if let Some(parent) = next_local_dir.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::rename(&previous_local_dir, &next_local_dir) {
                            log::warn!(
                                "[TeamSync] Failed to move local mapping dir '{}' → '{}': {}",
                                previous_local,
                                next_local,
                                e
                            );
                        }
                    }
                    mapping.local_path = next_local;
                }
                log::debug!(
                    "[TeamSync] Refreshed directory mapping path by id: {} {} → {}",
                    mapping.directory_id,
                    mapping.remote_path,
                    current_remote
                );
                mapping.remote_path = current_remote;
                mapping.role = scope_dir.role.clone();
                directory_mappings_changed = true;
            }
        }
    }
    if directory_mappings_changed {
        path_mappings = directory_mappings_file.to_path_mappings(team_vault_id);
        directory_id_mappings = directory_mappings_file.to_directory_id_mappings(team_vault_id);
    }

    // 迁移旧 path mapping：只迁移能从 scope 里唯一拿到 directory_id 的条目。
    for (local_path, remote_path) in &legacy_path_mappings {
        let remote_trimmed = remote_path.trim_end_matches('/');
        if path_mappings
            .values()
            .any(|target| target == remote_trimmed)
        {
            continue;
        }
        let Some(scope_dir) = scope_by_path.get(remote_trimmed) else {
            path_mappings.insert(local_path.clone(), remote_trimmed.to_string());
            continue;
        };
        let Some(directory_id) = scope_dir.directory_id.as_deref() else {
            path_mappings.insert(local_path.clone(), remote_trimmed.to_string());
            continue;
        };

        directory_mappings_file.upsert(
            team_vault_id,
            directory_id.to_string(),
            local_path.clone(),
            remote_trimmed.to_string(),
            scope_dir.role.clone(),
        );
        path_mappings.insert(local_path.clone(), remote_trimmed.to_string());
        directory_id_mappings.insert(local_path.clone(), directory_id.to_string());
        directory_mappings_changed = true;
    }

    // T-3: 自动发现 scope_dirs 中的新目录，建立 PARA 反向映射。
    // 父级团队目录 mapping 已经覆盖其子树；嵌套 scope 不能再按本地同名冲突
    // 生成 ` - owner` 落点，否则 promote 会把自己的子目录误判成别人共享的同名目录。
    let mut ordered_scope_dirs: Vec<&slash_sync_proto::TeamScopeDir> =
        scope.scope_dirs.iter().collect();
    ordered_scope_dirs.sort_by_key(|sd| {
        let path = sd.directory_path.trim_end_matches('/');
        (path.matches('/').count(), path.len())
    });

    for sd in ordered_scope_dirs {
        let team_dir = sd.directory_path.trim_end_matches('/');
        let Some(directory_id) = sd.directory_id.as_deref() else {
            continue;
        };

        // 跳过根级 PARA 目录（T-2: 不自动映射根目录）
        if !team_dir.contains('/') {
            continue;
        }

        let already_mapped = path_mappings.values().any(|t| t.as_str() == team_dir);
        if already_mapped {
            continue;
        }

        if is_team_dir_covered_by_parent_mapping(team_dir, None, &path_mappings) {
            log::debug!(
                "[TeamSync] T-3 skip nested scope covered by parent mapping: {} (directory_id={})",
                team_dir,
                directory_id
            );
            continue;
        }

        for (team_prefix, personal_prefix) in PARA_TEAM_TO_PERSONAL {
            if let Some(rest) = team_dir.strip_prefix(team_prefix) {
                let base_personal_dir = format!("{personal_prefix}{rest}");
                let personal_dir = choose_team_local_path(
                    root,
                    &base_personal_dir,
                    &path_mappings,
                    sd.owner_display_name.as_deref(),
                );
                if !path_mappings.contains_key(&personal_dir) {
                    log::debug!(
                        "[TeamSync] T-3 auto-mapping v3: {} → {} (directory_id={}, role={})",
                        personal_dir,
                        team_dir,
                        directory_id,
                        sd.role
                    );
                    directory_mappings_file.upsert(
                        team_vault_id,
                        directory_id.to_string(),
                        personal_dir.clone(),
                        team_dir.to_string(),
                        sd.role.clone(),
                    );
                    path_mappings.insert(personal_dir.clone(), team_dir.to_string());
                    directory_id_mappings.insert(personal_dir, directory_id.to_string());
                    directory_mappings_changed = true;
                }
                break;
            }
        }
    }

    let mut mappings_changed = directory_mappings_changed;
    let mut legacy_mappings_changed = false;

    {
        let nested_mappings_to_remove: Vec<String> = path_mappings
            .iter()
            .filter_map(|(source, target)| {
                if is_team_dir_covered_by_parent_mapping(target, Some(source), &path_mappings) {
                    Some(source.clone())
                } else {
                    None
                }
            })
            .collect();

        for src in nested_mappings_to_remove {
            log::debug!(
                "[TeamSync] Removing nested directory mapping covered by parent scope: {}",
                src
            );
            let local_dir = root.join(&src);
            if local_dir.is_dir() {
                match std::fs::remove_dir(&local_dir) {
                    Ok(_) => {
                        log::debug!("[TeamSync] Removed empty nested mapping directory: {}", src);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                        log::debug!(
                            "[TeamSync] Keeping non-empty nested mapping directory after unmapping: {}",
                            src
                        );
                    }
                    Err(e) => {
                        log::debug!(
                            "[TeamSync] Failed to remove nested mapping directory '{}': {}",
                            src,
                            e
                        );
                    }
                }
            }
            path_mappings.remove(&src);
            legacy_path_mappings.remove(&src);
            directory_id_mappings.remove(&src);
            remove_directory_mapping_by_local_path(
                &mut directory_mappings_file,
                team_vault_id,
                &src,
            );
            mappings_changed = true;
            legacy_mappings_changed = true;
        }
    }

    // T-4: 🧹 幽灵清剿（如果 Owner 删除了目录或收回权限，将本地映射抹除并物理超度）
    // 🛡️ BUG-E07 Fix 3: Admin 也需要清理过期映射。Admin 使用 managed_dirs 作为参照：
    // 如果映射的 target 不在 managed_dirs 也不在 scope_dirs 中，说明该目录已被删除。
    {
        let mut to_remove = Vec::new();
        for (src, target) in &path_mappings {
            let tgt = target.trim_end_matches('/');
            // 🛡️ BUG-E07 Fix 5: 子目录级 mapping（如 01_PROJECTS/C1）必须精确匹配 scope_dirs，
            // 不能因父级 PARA 根（01_PROJECTS）在 scope 中就视为有效。
            // Admin 删除子目录时只删 directory_permissions，PARA 根仍在 scope 中，
            // 前缀匹配会让 T-4 保留已失效的子目录 mapping → Step 3.5 重建空壳子。
            let is_sub_dir = tgt.contains('/');
            let is_in_scope =
                is_mapping_in_scope(src, tgt, is_sub_dir, &directory_id_mappings, scope);
            if !is_in_scope {
                // Admin 追加检查：是否仍在 managed_dirs 中（说明目录依然存在，只是 Admin 自己没绑定权限）
                let is_in_managed =
                    is_mapping_in_managed(src, tgt, is_sub_dir, &directory_id_mappings, scope);
                if scope.is_full_scope && is_in_managed {
                    // Admin 且目录仍然存在（只是 Admin 自己没权限），保留映射
                    continue;
                }
                to_remove.push(src.clone());
            }
        }

        for src in to_remove {
            log::debug!(
                "[TeamSync] T-4 Directory no longer in scope, purging local mapping & files: {}",
                src
            );
            let local_dir = root.join(&src);
            if local_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&local_dir) {
                    log::error!("[TeamSync] Failed to purge out-of-scope dir {}: {}", src, e);
                }
            }
            path_mappings.remove(&src);
            legacy_path_mappings.remove(&src);
            directory_id_mappings.remove(&src);
            remove_directory_mapping_by_local_path(
                &mut directory_mappings_file,
                team_vault_id,
                &src,
            );
            mappings_changed = true;
            legacy_mappings_changed = true;
        }
    }

    if mappings_changed {
        directory_mappings_file.save(&directory_mappings_path);
        log::debug!(
            "[TeamSync] Saved {} updated UUID-first mappings for active team {}",
            path_mappings.len(),
            team_vault_id
        );
    }
    if legacy_mappings_changed {
        legacy_mappings_file
            .teams
            .insert(team_vault_id.to_string(), legacy_path_mappings);
        legacy_mappings_file.save(&mappings_path);
    }

    // 构建反向映射 (target→source) 的 owned 版本
    let reverse_owned: Vec<(String, String)> = path_mappings
        .iter()
        .map(|(src, tgt)| (tgt.clone(), src.clone()))
        .collect();

    (path_mappings, reverse_owned, directory_id_mappings)
}

fn is_mapping_in_scope(
    source_path: &str,
    target_path: &str,
    is_sub_dir: bool,
    directory_id_mappings: &std::collections::HashMap<String, String>,
    scope: &slash_sync_proto::TeamScopeResponse,
) -> bool {
    if let Some(directory_id) = directory_id_mappings.get(source_path) {
        return scope
            .scope_dirs
            .iter()
            .any(|sd| sd.directory_id.as_deref() == Some(directory_id.as_str()));
    }

    scope.scope_dirs.iter().any(|sd| {
        let sd_path = sd.directory_path.trim_end_matches('/');
        if is_sub_dir {
            target_path == sd_path
        } else {
            target_path == sd_path || target_path.starts_with(&format!("{sd_path}/"))
        }
    })
}

fn is_mapping_in_managed(
    source_path: &str,
    target_path: &str,
    is_sub_dir: bool,
    directory_id_mappings: &std::collections::HashMap<String, String>,
    scope: &slash_sync_proto::TeamScopeResponse,
) -> bool {
    if let Some(directory_id) = directory_id_mappings.get(source_path) {
        return scope
            .managed_scope_dirs
            .iter()
            .any(|sd| sd.directory_id.as_deref() == Some(directory_id.as_str()));
    }

    scope.managed_dirs.iter().any(|md| {
        let md_trimmed = md.trim_end_matches('/');
        if is_sub_dir {
            target_path == md_trimmed
        } else {
            target_path == md_trimmed || target_path.starts_with(&format!("{md_trimmed}/"))
        }
    })
}

fn choose_team_local_path(
    root: &std::path::Path,
    base_personal_dir: &str,
    path_mappings: &std::collections::HashMap<String, String>,
    owner_display_name: Option<&str>,
) -> String {
    if !root.join(base_personal_dir).exists() || path_mappings.contains_key(base_personal_dir) {
        return base_personal_dir.to_string();
    }

    let owner_label = owner_display_name
        .map(sanitize_owner_label)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "Team".to_string());
    let base_candidate = format!("{base_personal_dir} - {owner_label}");
    let mut candidate = base_candidate.clone();
    let mut index = 2;
    while root.join(&candidate).exists() || path_mappings.contains_key(&candidate) {
        candidate = format!("{base_candidate} {index}");
        index += 1;
    }
    candidate
}

fn is_team_dir_covered_by_parent_mapping(
    team_dir: &str,
    source_to_ignore: Option<&str>,
    path_mappings: &std::collections::HashMap<String, String>,
) -> bool {
    let team_dir = team_dir.trim_end_matches('/').to_ascii_lowercase();
    if team_dir.is_empty() {
        return false;
    }

    path_mappings.iter().any(|(source, mapped_target)| {
        if source_to_ignore
            .map(|ignored| ignored == source.as_str())
            .unwrap_or(false)
        {
            return false;
        }

        let parent = mapped_target.trim_end_matches('/');
        if parent.is_empty() || !parent.contains('/') {
            return false;
        }

        let parent = parent.to_ascii_lowercase();
        team_dir != parent && team_dir.starts_with(&format!("{parent}/"))
    })
}

fn resolve_team_pull_local_path(
    root: &std::path::Path,
    team_vault_id: &str,
    manifest: &slash_sync_proto::FileManifest,
    reverse_mappings: &std::collections::HashMap<&str, &str>,
    scope: &slash_sync_proto::TeamScopeResponse,
    file_mappings_file: &mut TeamFileMappingsFile,
    file_mappings: &mut std::collections::HashMap<String, super::path_mapping::TeamFileMapping>,
    file_mappings_changed: &mut bool,
    moved_team_file_paths: &mut Vec<(String, String)>,
) -> (std::path::PathBuf, String) {
    let default_local_path =
        resolve_team_pull_path(root, &manifest.relative_path, reverse_mappings);
    let default_local_rel = default_local_path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| manifest.relative_path.clone());

    let is_asset = manifest.relative_path.starts_with("assets/")
        || manifest.relative_path.starts_with(".slash/assets/");
    let Some(file_id) = manifest.file_id.as_deref() else {
        return (default_local_path, default_local_rel);
    };
    if is_asset {
        return (default_local_path, default_local_rel);
    }

    let fallback_owner_display_name =
        owner_display_name_for_team_path(scope, &manifest.relative_path);
    let file_display_name = manifest
        .editor_display_name
        .as_deref()
        .or(manifest.pushed_by_display_name.as_deref())
        .or(fallback_owner_display_name);
    let desired_local_rel =
        choose_team_file_local_path(root, &default_local_rel, file_id, file_display_name);

    let local_rel = if let Some(existing) = file_mappings.get(file_id) {
        let previous_local = existing.local_path.clone();
        if previous_local != desired_local_rel {
            if move_team_file_local_path(root, &previous_local, &desired_local_rel, file_id) {
                moved_team_file_paths.push((previous_local, desired_local_rel.clone()));
                desired_local_rel
            } else {
                previous_local
            }
        } else {
            desired_local_rel
        }
    } else {
        desired_local_rel
    };

    let directory_id = manifest.directory_id.clone();
    let should_upsert = file_mappings
        .get(file_id)
        .map(|existing| {
            existing.local_path != local_rel
                || existing.remote_path != manifest.relative_path
                || existing.directory_id != directory_id
        })
        .unwrap_or(true);

    if should_upsert {
        file_mappings_file.upsert(
            team_vault_id,
            file_id.to_string(),
            local_rel.clone(),
            manifest.relative_path.clone(),
            directory_id,
        );
        file_mappings.insert(
            file_id.to_string(),
            super::path_mapping::TeamFileMapping {
                file_id: file_id.to_string(),
                local_path: local_rel.clone(),
                remote_path: manifest.relative_path.clone(),
                directory_id: manifest.directory_id.clone(),
                status: "active".to_string(),
            },
        );
        *file_mappings_changed = true;
    }

    (root.join(&local_rel), local_rel)
}

fn move_team_file_local_path(
    root: &std::path::Path,
    previous_local: &str,
    next_local: &str,
    file_id: &str,
) -> bool {
    let previous_path = root.join(previous_local);
    let next_path = root.join(next_local);
    if !previous_path.exists() || previous_local == next_local {
        return true;
    }
    if next_path.exists() {
        if file_has_id(&next_path, file_id) {
            let _ = std::fs::remove_file(&previous_path);
            return true;
        }
        return false;
    }
    if let Some(parent) = next_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::rename(&previous_path, &next_path) {
        log::warn!(
            "[TeamSync] Failed to move team file local landing '{}' → '{}': {}",
            previous_local,
            next_local,
            e
        );
        return false;
    }
    true
}

fn choose_team_file_local_path(
    root: &std::path::Path,
    base_local_rel: &str,
    file_id: &str,
    owner_display_name: Option<&str>,
) -> String {
    if !basename_conflicts(root, base_local_rel, file_id) {
        return base_local_rel.to_string();
    }

    let owner_label = owner_display_name
        .map(sanitize_owner_label)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "Team".to_string());
    let base_candidate = add_file_owner_suffix(base_local_rel, &owner_label, None);
    if !basename_conflicts(root, &base_candidate, file_id)
        && path_available_for_file_id(root, &base_candidate, file_id)
    {
        return base_candidate;
    }

    let mut index = 2;
    loop {
        let candidate = add_file_owner_suffix(base_local_rel, &owner_label, Some(index));
        if !basename_conflicts(root, &candidate, file_id)
            && path_available_for_file_id(root, &candidate, file_id)
        {
            return candidate;
        }
        index += 1;
    }
}

fn path_available_for_file_id(root: &std::path::Path, relative_path: &str, file_id: &str) -> bool {
    let path = root.join(relative_path);
    !path.exists() || file_has_id(&path, file_id)
}

fn add_file_owner_suffix(path: &str, owner_label: &str, index: Option<usize>) -> String {
    let path_obj = std::path::Path::new(path);
    let parent = path_obj
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .filter(|p| !p.is_empty());
    let stem = path_obj
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let ext = path_obj
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let suffix = match index {
        Some(index) => format!(" - {owner_label} {index}"),
        None => format!(" - {owner_label}"),
    };
    let file_name = format!("{stem}{suffix}{ext}");
    match parent {
        Some(parent) => format!("{parent}/{file_name}"),
        None => file_name,
    }
}

fn basename_conflicts(root: &std::path::Path, candidate_rel: &str, file_id: &str) -> bool {
    let candidate_name = std::path::Path::new(candidate_rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if candidate_name.is_empty() {
        return false;
    }
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let rel = relative.to_string_lossy().replace('\\', "/");
        if rel.starts_with(".slash/") || rel.split('/').any(|seg| seg.starts_with('.')) {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
            continue;
        };
        if name != candidate_name {
            continue;
        }
        if rel == candidate_rel || file_has_id(path, file_id) {
            continue;
        }
        return true;
    }
    false
}

fn file_has_id(path: &std::path::Path, file_id: &str) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|content| crate::commands::sync::helpers::extract_slash_id_str(&content))
        .map(|local_file_id| local_file_id == file_id)
        .unwrap_or(false)
}

fn owner_display_name_for_team_path<'a>(
    scope: &'a slash_sync_proto::TeamScopeResponse,
    team_path: &str,
) -> Option<&'a str> {
    scope
        .scope_dirs
        .iter()
        .chain(scope.managed_scope_dirs.iter())
        .filter(|dir| {
            let prefix = normalize_prefix(dir.directory_path.trim_end_matches('/'));
            team_path.starts_with(&prefix)
        })
        .max_by_key(|dir| dir.directory_path.len())
        .and_then(|dir| dir.owner_display_name.as_deref())
}

fn sanitize_owner_label(label: &str) -> String {
    label
        .chars()
        .filter(|ch| !matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn team_path_to_personal_path(team_path: &str) -> Option<String> {
    for (team_prefix, personal_prefix) in PARA_TEAM_TO_PERSONAL {
        if team_path == *team_prefix {
            return Some(personal_prefix.to_string());
        }
        if let Some(rest) = team_path.strip_prefix(&format!("{team_prefix}/")) {
            return Some(format!("{personal_prefix}/{rest}"));
        }
    }
    None
}

fn resolve_directory_id_for_team_path(
    team_path: &str,
    path_mappings: &std::collections::HashMap<String, String>,
    directory_id_mappings: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let mut best: Option<(&str, &str)> = None;
    for (local_path, remote_path) in path_mappings {
        let remote_trimmed = remote_path.trim_end_matches('/');
        let is_match =
            team_path == remote_trimmed || team_path.starts_with(&format!("{remote_trimmed}/"));
        if !is_match {
            continue;
        }
        if best
            .map(|(best_remote, _)| remote_trimmed.len() > best_remote.len())
            .unwrap_or(true)
        {
            best = Some((remote_trimmed, local_path.as_str()));
        }
    }

    best.and_then(|(_, local_path)| directory_id_mappings.get(local_path).cloned())
}

fn remove_directory_mapping_by_local_path(
    mappings_file: &mut TeamDirectoryMappingsFile,
    team_vault_id: &str,
    local_path: &str,
) {
    if let Some(team) = mappings_file.teams.get_mut(team_vault_id) {
        team.directories
            .retain(|_, mapping| mapping.local_path != local_path);
    }
}

/// 确定需要同步的 source 目录列表
fn resolve_source_dirs<'a>(
    path_mappings: &'a std::collections::HashMap<String, String>,
    directory_id_mappings: &std::collections::HashMap<String, String>,
    scope: &slash_sync_proto::TeamScopeResponse,
) -> Vec<&'a str> {
    if scope.is_full_scope {
        path_mappings.keys().map(|s| s.as_str()).collect()
    } else {
        path_mappings
            .iter()
            .filter(|(source, target)| {
                if let Some(directory_id) = directory_id_mappings.get(source.as_str()) {
                    return scope
                        .scope_dirs
                        .iter()
                        .any(|sd| sd.directory_id.as_deref() == Some(directory_id.as_str()));
                }
                scope.scope_dirs.iter().any(|sd| {
                    let sd_path = sd.directory_path.trim_end_matches('/');
                    let tgt = target.trim_end_matches('/');
                    tgt == sd_path || tgt.starts_with(&format!("{sd_path}/"))
                })
            })
            .map(|(src, _)| src.as_str())
            .collect()
    }
}

/// 扫描本地文件，按 source_dir 过滤并构建映射文件列表
fn build_team_mapped_files<'a>(
    manifests: &'a [slash_core::FileManifestBasic],
    path_mappings: &std::collections::HashMap<String, String>,
    file_mappings: &std::collections::HashMap<String, super::path_mapping::TeamFileMapping>,
    directory_id_mappings: &std::collections::HashMap<String, String>,
    source_dirs: &[&str],
    scope: &slash_sync_proto::TeamScopeResponse,
    managed_prefixes: &[String],
) -> Vec<(String, &'a slash_core::FileManifestBasic)> {
    let mut mapped_files: Vec<(String, &slash_core::FileManifestBasic)> = Vec::new();
    for m in manifests {
        if let Some(file_id) = m.file_id.as_deref() {
            if let Some(mapping) = file_mappings.get(file_id) {
                if mapping.local_path == m.relative_path {
                    mapped_files.push((mapping.remote_path.clone(), m));
                    continue;
                }
            }
        }
        for (src_dir, tgt_dir) in path_mappings {
            let src_prefix = normalize_prefix(src_dir);
            let tgt_prefix = normalize_prefix(tgt_dir);

            if m.relative_path.starts_with(&src_prefix) || m.relative_path == *src_dir {
                if is_source_dir_allowed(src_dir, directory_id_mappings, source_dirs, scope) {
                    let target_path = format!(
                        "{}{}",
                        tgt_prefix,
                        m.relative_path
                            .strip_prefix(&src_prefix)
                            .unwrap_or(&m.relative_path)
                    );

                    // 🛡️ 目录级隔离：排除属于独立管理子目录的文件
                    let tgt_dir_trimmed = tgt_dir.trim_end_matches('/');
                    let in_independent_subdir = managed_prefixes.iter().any(|mp| {
                        let mp_trimmed = mp.trim_end_matches('/');
                        mp_trimmed != tgt_dir_trimmed
                            && mp_trimmed.starts_with(&format!("{tgt_dir_trimmed}/"))
                            && target_path.starts_with(mp)
                            && !path_mappings
                                .values()
                                .any(|t| t.trim_end_matches('/') == mp_trimmed)
                            && !scope
                                .scope_dirs
                                .iter()
                                .any(|sd| sd.directory_path.trim_end_matches('/') == mp_trimmed)
                    });

                    if in_independent_subdir {
                        break;
                    }

                    mapped_files.push((target_path, m));
                }
                break;
            }
        }
    }
    mapped_files
}

fn is_source_dir_allowed(
    src_dir: &str,
    directory_id_mappings: &std::collections::HashMap<String, String>,
    source_dirs: &[&str],
    scope: &slash_sync_proto::TeamScopeResponse,
) -> bool {
    if scope.is_full_scope {
        return true;
    }
    if let Some(directory_id) = directory_id_mappings.get(src_dir) {
        return scope
            .scope_dirs
            .iter()
            .any(|sd| sd.directory_id.as_deref() == Some(directory_id.as_str()));
    }
    source_dirs.contains(&src_dir)
}

/// 检测已删除的团队文件
/// 从 unified_state 中查找有 team_hash 但本地已不存在的文件
fn detect_team_deleted(
    unified_state: &mut UnifiedSyncState,
    current_target_paths: &std::collections::HashSet<&str>,
    reverse_mappings: &std::collections::HashMap<&str, &str>,
    root: &std::path::Path,
    mapped_files: &[(String, &slash_core::FileManifestBasic)],
) -> Vec<String> {
    // Asset GC 保护期常量：60 秒内不 GC，防止 Ctrl+Z 撤销竞争
    const ASSET_GC_GRACE_SECS: i64 = 60;
    let now_ts = chrono::Utc::now().timestamp();

    // UUID-First: 预构建当前磁盘上仍存活的 file_id 集合
    let alive_file_ids: std::collections::HashSet<&str> = mapped_files
        .iter()
        .filter_map(|(_, m)| m.file_id.as_deref())
        .collect();

    // 清除已恢复文件的 missing_since（Ctrl+Z 后文件重新出现）
    let disk_paths: std::collections::HashSet<String> = unified_state
        .keys()
        .filter(|p| root.join(p).exists())
        .cloned()
        .collect();
    for path in &disk_paths {
        if let Some(state) = unified_state.get_mut(path) {
            if state.missing_since.is_some() {
                log::debug!(
                    "[TeamSync] 🔄 Asset re-appeared, clearing missing_since: '{}'",
                    path
                );
                state.missing_since = None;
            }
        }
    }

    // 收集候选删除列表（先不 mutate unified_state）
    let candidates: Vec<(String, String, bool)> = unified_state
        .iter()
        .filter(|(local_path, state)| {
            // Team note deletion must be explicit (UI/API). A missing local markdown
            // with a stable file_id can also mean "needs pull" after restore or after
            // local mapping drift; reporting it here would immediately re-delete the
            // restored server record during negotiate.
            if local_path.ends_with(".md") && state.file_id.is_some() {
                log::debug!(
                    "[TeamSync] missing team note '{}' has file_id={:?}; skip local-missing delete and let server pull repair",
                    local_path,
                    state.file_id
                );
                return false;
            }
            if !state.team_hash.is_empty() {
                return true;
            }
            if state.file_id.is_none() {
                return false;
            }
            maps_to_team_path(local_path, reverse_mappings).is_some()
        })
        .filter(|(local_path, _)| !root.join(local_path).exists())
        .filter(|(_, state)| {
            // UUID 碰缘检测
            match &state.file_id {
                Some(fid) => !alive_file_ids.contains(fid.as_str()),
                None => true,
            }
        })
        .map(|(local_path, state)| {
            (
                local_path.clone(),
                state.file_id.clone().unwrap_or_default(),
                false,
            )
        })
        .collect();

    let mut deleted = Vec::new();
    for (local_path, _fid, _) in &candidates {
        // 本地不存在 → 反向映射为 team 路径，加入删除列表
        let mut found = false;
        for (src_dir, tgt_dir) in reverse_mappings.iter().map(|(t, s)| (*s, *t)) {
            let src_prefix = normalize_prefix(src_dir);
            if local_path.starts_with(&src_prefix) {
                let relative = local_path.strip_prefix(&src_prefix).unwrap_or(local_path);
                let tgt_prefix = normalize_prefix(tgt_dir);
                let target_path = format!("{tgt_prefix}{relative}");
                if !current_target_paths.contains(target_path.as_str()) {
                    deleted.push(target_path);
                }
                found = true;
                break;
            }
        }

        // [OPT-04] 资产目录直通：assets/ 不属于 PARA 映射，必须直接汇报删除状态
        // 🛡️ Asset GC 保护期：60 秒内不删除，防止 Ctrl+Z 竞争
        if !found {
            let is_asset =
                local_path.starts_with("assets/") || local_path.starts_with(".slash/assets/");
            if is_asset {
                if !current_target_paths.contains(local_path.as_str()) {
                    let entry = unified_state.entry(local_path.clone()).or_default();
                    match entry.missing_since {
                        Some(since) => {
                            let elapsed = now_ts - since;
                            if elapsed >= ASSET_GC_GRACE_SECS {
                                log::debug!(
                                    "[TeamSync] ⏰ Asset GC grace period expired ({}s): '{}'",
                                    elapsed,
                                    local_path
                                );
                                deleted.push(local_path.to_string());
                            } else {
                                log::debug!(
                                    "[TeamSync] 🛡️ Asset GC deferred ({}/{}s): '{}'",
                                    elapsed,
                                    ASSET_GC_GRACE_SECS,
                                    local_path
                                );
                            }
                        }
                        None => {
                            log::debug!(
                                "[TeamSync] 🛡️ Asset GC grace period started: '{}'",
                                local_path
                            );
                            entry.missing_since = Some(now_ts);
                        }
                    }
                }
                found = true;
            }
        }

        // 🛡️ BUG-E07 Fix 2: PARA 根级回退（reverse_mappings 中无映射时）
        if !found {
            for (team_root, personal_root) in PARA_TEAM_TO_PERSONAL {
                let personal_prefix = normalize_prefix(personal_root);
                if local_path.starts_with(&personal_prefix) {
                    let relative = local_path
                        .strip_prefix(&personal_prefix)
                        .unwrap_or(local_path);
                    let team_prefix = normalize_prefix(team_root);
                    let target_path = format!("{team_prefix}{relative}");
                    if !current_target_paths.contains(target_path.as_str()) {
                        log::debug!(
                            "[TeamSync] BUG-E07 fallback delete: '{}' → '{}'",
                            local_path,
                            target_path
                        );
                        deleted.push(target_path);
                    }
                    break;
                }
            }
        }

        // 历史状态兼容：旧版 unified_sync_state 里可能直接保存团队路径
        // （如 01_PROJECTS/...）而不是本地 PARA 路径。此时本地文件消失后
        // 无法通过 reverse_mappings/PARA personal fallback 反推出 target，
        // 必须把它当作服务端目标路径直接上报，否则删除会被漏掉。
        if !found {
            for (team_root, _) in PARA_TEAM_TO_PERSONAL {
                let team_prefix = normalize_prefix(team_root);
                if local_path.starts_with(&team_prefix) {
                    if !current_target_paths.contains(local_path.as_str()) {
                        log::debug!(
                            "[TeamSync] team-path state delete: '{}' reported directly",
                            local_path
                        );
                        deleted.push(local_path.to_string());
                    }
                    break;
                }
            }
        }
    }
    deleted
}

fn resolve_deleted_file_id(
    target_path: &str,
    unified_state: &UnifiedSyncState,
    reverse_mappings: &std::collections::HashMap<&str, &str>,
) -> Option<String> {
    if let Some(file_id) = unified_state
        .get(target_path)
        .and_then(|state| state.file_id.clone())
    {
        return Some(file_id);
    }

    for (tgt_dir, src_dir) in reverse_mappings {
        let tgt_prefix = normalize_prefix(tgt_dir);
        if target_path.starts_with(&tgt_prefix) {
            let relative = target_path.strip_prefix(&tgt_prefix).unwrap_or(target_path);
            let src_prefix = normalize_prefix(src_dir);
            let local_path = format!("{src_prefix}{relative}");
            if let Some(file_id) = unified_state
                .get(&local_path)
                .and_then(|state| state.file_id.clone())
            {
                return Some(file_id);
            }
        }
    }

    for (team_root, personal_root) in PARA_TEAM_TO_PERSONAL {
        let team_prefix = normalize_prefix(team_root);
        if target_path.starts_with(&team_prefix) {
            let relative = target_path
                .strip_prefix(&team_prefix)
                .unwrap_or(target_path);
            let personal_prefix = normalize_prefix(personal_root);
            let local_path = format!("{personal_prefix}{relative}");
            if let Some(file_id) = unified_state
                .get(&local_path)
                .and_then(|state| state.file_id.clone())
            {
                return Some(file_id);
            }
        }
    }

    None
}

fn maps_to_team_path(
    local_path: &str,
    reverse_mappings: &std::collections::HashMap<&str, &str>,
) -> Option<String> {
    for (tgt_dir, src_dir) in reverse_mappings {
        let src_prefix = normalize_prefix(src_dir);
        if local_path.starts_with(&src_prefix) {
            let relative = local_path.strip_prefix(&src_prefix).unwrap_or(local_path);
            let tgt_prefix = normalize_prefix(tgt_dir);
            return Some(format!("{tgt_prefix}{relative}"));
        }
    }

    for (team_root, personal_root) in PARA_TEAM_TO_PERSONAL {
        let personal_prefix = normalize_prefix(personal_root);
        if local_path.starts_with(&personal_prefix) {
            let relative = local_path
                .strip_prefix(&personal_prefix)
                .unwrap_or(local_path);
            let team_prefix = normalize_prefix(team_root);
            return Some(format!("{team_prefix}{relative}"));
        }

        let team_prefix = normalize_prefix(team_root);
        if local_path.starts_with(&team_prefix) {
            return Some(local_path.to_string());
        }
    }

    None
}

/// Pull 安全过滤：只 Pull 有 reverse_mappings 映射的文件
fn filter_pullable_paths(
    client_needs: &[String],
    reverse_mappings: &std::collections::HashMap<&str, &str>,
    managed_prefixes: &[String],
    path_mappings: &std::collections::HashMap<String, String>,
    scope: &slash_sync_proto::TeamScopeResponse,
) -> Vec<String> {
    client_needs
        .iter()
        .filter(|path| {
            // [OPT-04] 资产目录直通：assets/ 不属于 PARA 映射，但必须允许 pull
            if path.starts_with("assets/") || path.starts_with(".slash/assets/") {
                return true;
            }

            // 1. 必须有 reverse_mapping
            let has_mapping = reverse_mappings.keys().any(|tgt_dir| {
                let tgt_prefix = normalize_prefix(tgt_dir);
                path.starts_with(&tgt_prefix)
            });
            if !has_mapping {
                log::debug!("[TeamSync] Skip pull (no mapping): {path}");
                return false;
            }

            // 2. 🛡️ 目录级隔离：排除属于独立管理子目录的文件
            let in_independent_subdir = reverse_mappings.keys().any(|tgt_dir| {
                let tgt_prefix = normalize_prefix(tgt_dir);
                if !path.starts_with(&tgt_prefix) {
                    return false;
                }
                let tgt_dir_trimmed = tgt_dir.trim_end_matches('/');
                managed_prefixes.iter().any(|mp| {
                    let mp_trimmed = mp.trim_end_matches('/');
                    mp_trimmed != tgt_dir_trimmed
                        && mp_trimmed.starts_with(&format!("{tgt_dir_trimmed}/"))
                        && path.starts_with(mp)
                        && !path_mappings
                            .values()
                            .any(|t| t.trim_end_matches('/') == mp_trimmed)
                        && !scope
                            .scope_dirs
                            .iter()
                            .any(|sd| sd.directory_path.trim_end_matches('/') == mp_trimmed)
                })
            });

            if in_independent_subdir {
                log::debug!("[TeamSync] Skip pull (independent subdir): {path}");
                return false;
            }

            true
        })
        .cloned()
        .collect()
}

fn ensure_team_sync_state_file(root: &std::path::Path, team_vault_id: &str) -> Result<(), String> {
    let state_path = root.join(".slash/team_sync_state.json");

    // 如果已存在且内容一致，跳过
    if let Ok(raw) = std::fs::read_to_string(&state_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if json.get("vault_id").and_then(|v| v.as_str()) == Some(team_vault_id) {
                return Ok(()); // 已存在且一致，无需写入
            }
        }
    }

    // 写入
    let state = serde_json::json!({ "vault_id": team_vault_id });
    let json =
        serde_json::to_string_pretty(&state).map_err(|e| format!("serialize failed: {e}"))?;

    // 确保 .slash 目录存在
    if let Some(parent) = state_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    std::fs::write(&state_path, json).map_err(|e| format!("write failed: {e}"))?;

    log::debug!(
        "[TeamSync] Ensured team_sync_state.json: vault_id={}",
        team_vault_id
    );
    Ok(())
}

/// 确保 team_sync_state.json 存在（前端调用，保证被邀成员也能激活团队同步）
#[tauri::command]
pub fn ensure_team_sync_state(vault_path: String, team_vault_id: String) -> Result<(), String> {
    ensure_team_sync_state_file(std::path::Path::new(&vault_path), &team_vault_id)
}
