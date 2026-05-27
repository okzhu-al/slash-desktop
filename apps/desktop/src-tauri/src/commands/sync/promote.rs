//! Promote to Team — 将个人空间目录推送到团队 vault
//!
//! push_directory_to_vault — 扫描源目录 → 路径重映射 → negotiate → push → 持久化映射

use std::path::PathBuf;

use slash_core::scan_directory_manifests;
use slash_sync_proto::{
    FileManifest, FilePushPayload, SpaceType, SyncNegotiateRequest, SyncPushRequest,
};

use super::client::SyncClient;
use super::helpers::{
    build_directory_hashes_from_mapped, extract_asset_refs, filter_oversized_assets,
};
use super::path_mapping::{normalize_prefix, TeamPathMappingsFile};

/// 将指定子目录推送到目标 vault（Promote to Team）
///
/// - `source_dir`: 本地 vault 中的源目录相对路径 (e.g. "01_Projects/新建文件夹")
/// - `target_dir`: 团队 vault 中的目标目录路径 (e.g. "01_PROJECTS/新建文件夹")
/// - 文件路径重映射：source_dir/ 前缀替换为 target_dir/ 前缀
#[tauri::command]
pub async fn push_directory_to_vault(
    app: tauri::AppHandle,
    server_url: String,
    access_token: String,
    vault_path: String,
    source_dir: String,
    target_dir: String,
    target_vault_id: String,
    #[allow(unused_variables)] editor_name: Option<String>,
) -> Result<u32, String> {
    let root = PathBuf::from(&vault_path);
    let dir_path = root.join(&source_dir);
    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {source_dir}"));
    }

    let sync_client = SyncClient::with_timeout(&server_url, &access_token, 30)?;

    let max_sync_file_size = {
        use tauri::Manager;
        app.try_state::<crate::state::SyncCapabilitiesState>()
            .map(|s| s.0.lock().unwrap().max_sync_file_size)
            .unwrap_or(slash_core::TEAM_ASSET_MAX_SIZE_DEFAULT)
    };

    log::debug!("[Promote v2] === START push_directory_to_vault ===");
    log::debug!(
        "[Promote v2] source='{}', target='{}', vault={}",
        source_dir,
        target_dir,
        target_vault_id
    );

    // Step 1: 扫描所有本地文件（附带文件大小过滤）
    let all_manifests = scan_directory_manifests(&root, Some(max_sync_file_size));
    let source_prefix = normalize_prefix(&source_dir);
    let target_prefix = normalize_prefix(&target_dir);

    let source_files: Vec<_> = all_manifests
        .iter()
        .filter(|m| m.relative_path.starts_with(&source_prefix))
        .collect();

    log::debug!(
        "[Promote] source_dir='{}', source_prefix='{}', target_prefix='{}', total_manifests={}, matched_files={}",
        source_dir, source_prefix, target_prefix, all_manifests.len(), source_files.len()
    );
    // 临时诊断：打印所有 manifests 路径（仅在匹配为空时）
    if source_files.is_empty() {
        log::debug!("[Promote] No files matched. Listing all manifests for diagnosis:");
        for m in &all_manifests {
            log::debug!("[Promote]   manifest: '{}'", m.relative_path);
        }
        log::debug!("[Promote] No files found under source directory");
        return Err(format!("EMPTY_DIR:{source_dir}"));
    }

    // Step 2: 构建路径映射（源路径 → 目标路径）
    let mapped_files: Vec<(String, &slash_core::FileManifestBasic)> = source_files
        .iter()
        .map(|m| {
            let target_path = format!(
                "{}{}",
                target_prefix,
                m.relative_path
                    .strip_prefix(&source_prefix)
                    .unwrap_or(&m.relative_path)
            );
            (target_path, *m)
        })
        .collect();

    for (target, source) in &mapped_files {
        log::debug!("[Promote]   {} → {}", source.relative_path, target);
    }

    // Step 3: Negotiate — 用目标路径告诉 server
    let directory_hashes = build_directory_hashes_from_mapped(&mapped_files);

    let client_files: Vec<slash_sync_proto::NegotiateFileEntry> = mapped_files
        .iter()
        .map(|(target_path, m)| slash_sync_proto::NegotiateFileEntry {
            path: target_path.clone(),
            hash: m.content_hash.clone(),
            base_hash: String::new(),
            file_id: m.file_id.clone(),
        })
        .collect();

    let negotiate_req = SyncNegotiateRequest {
        vault_id: target_vault_id.clone(),
        space_type: SpaceType::Team(target_vault_id.clone()),
        directory_hashes,
        client_clock: 0,
        client_files,
        deleted_paths: vec![],
    };

    let (negotiate_resp, raw_body) = sync_client.negotiate_with_raw(&negotiate_req).await?;

    // 诊断日志（截断）
    let truncated = if raw_body.len() > 500 {
        let end = raw_body
            .char_indices()
            .take_while(|(i, _)| *i < 500)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        &raw_body[..end]
    } else {
        &raw_body
    };
    log::debug!("[Promote v2] negotiate raw response: {}", truncated);

    log::debug!(
        "[Promote v2] negotiate: server_needs={:?}, client_needs={}",
        negotiate_resp.server_needs,
        negotiate_resp.client_needs.len()
    );

    if negotiate_resp.server_needs.is_empty() {
        log::debug!("[Promote v2] Server already has all files, nothing to push");
        return Ok(0);
    }

    // Step 4: Push — 用目标路径构建 payload，但读取源文件内容
    // 注意：editor 字段注入已移至 commands/editor.rs 的 batch_update_editor（Join team 时执行）
    let mut files_to_push: Vec<FilePushPayload> = Vec::new();

    // 诊断：打印 mapped_files 前5个样本
    log::debug!(
        "[Promote] mapped_files count={}, sample keys:",
        mapped_files.len()
    );
    for (i, (tp, sm)) in mapped_files.iter().enumerate() {
        if i < 5 {
            log::debug!(
                "[Promote]   mapped[{}]: target='{}' source='{}'",
                i,
                tp,
                sm.relative_path
            );
        }
    }
    log::debug!(
        "[Promote] server_needs count={}",
        negotiate_resp.server_needs.len()
    );

    for need in &negotiate_resp.server_needs {
        // need 是目标路径（团队 vault 的路径），需要找到对应的源文件
        if let Some((team_relative, local_manifest)) =
            mapped_files.iter().find(|(tp, _)| tp == need)
        {
            let file_path = root.join(&local_manifest.relative_path);
            match std::fs::read(&file_path) {
                Ok(content) => {
                    let raw_assets = extract_asset_refs(&content);
                    let assets = filter_oversized_assets(&root, raw_assets, max_sync_file_size);
                    files_to_push.push(FilePushPayload {
                        manifest: FileManifest {
                            relative_path: team_relative.clone(),
                            content_hash: local_manifest.content_hash.clone(),
                            size: local_manifest.size,
                            mtime: local_manifest.mtime,
                            logical_clock: 1,
                            file_id: local_manifest.file_id.clone(),
                            edit_started_at: None,
                            edit_session_id: None,
                            is_user_edit: true,
                            assets,
                        },
                        content: content.clone(),
                    });
                }
                Err(e) => {
                    log::debug!("[Promote] ⚠️ Failed to read '{}': {e}", file_path.display());
                }
            }
        } else if need.ends_with('*') {
            // 通配符：server 需要整个目录
            let dir_need = need.trim_end_matches('*');
            let mut wildcard_count = 0;
            for (target_path, local_manifest) in &mapped_files {
                let target_dir_part = if let Some(pos) = target_path.rfind('/') {
                    &target_path[..=pos]
                } else {
                    "/"
                };
                if target_dir_part == dir_need {
                    let file_path = root.join(&local_manifest.relative_path);
                    if let Ok(content) = std::fs::read(&file_path) {
                        let raw_assets = extract_asset_refs(&content);
                        let assets = filter_oversized_assets(&root, raw_assets, max_sync_file_size);
                        files_to_push.push(FilePushPayload {
                            manifest: FileManifest {
                                relative_path: target_path.clone(),
                                content_hash: local_manifest.content_hash.clone(),
                                size: local_manifest.size,
                                mtime: local_manifest.mtime,
                                logical_clock: 1,
                                file_id: local_manifest.file_id.clone(),
                                edit_started_at: None,
                                edit_session_id: None,
                                is_user_edit: true,
                                assets,
                            },
                            content,
                        });
                        wildcard_count += 1;
                    }
                }
            }
            log::debug!(
                "[Promote] wildcard '{}' matched {} files",
                need,
                wildcard_count
            );
        } else {
            log::debug!(
                "[Promote] ⚠️ server_needs '{}' NOT found in mapped_files!",
                need
            );
        }
    }

    log::debug!(
        "[Promote] pushing {} files (total payload)",
        files_to_push.len()
    );

    if files_to_push.is_empty() {
        return Err("No files matched server needs".into());
    }

    let push_req = SyncPushRequest {
        vault_id: target_vault_id.clone(),
        files: files_to_push,
    };

    log::debug!("[Promote] Sending push request...");
    let push_resp = sync_client.push(&push_req).await?;

    log::debug!(
        "[Promote] Done! '{}' → '{}', {} files accepted by server",
        source_dir,
        target_dir,
        push_resp.accepted.len()
    );

    // 持久化路径映射到 .slash/team_path_mappings.json
    // sync_team_full 会读取此文件来确定 source→target 路径映射
    let mappings_path = root.join(".slash").join("team_path_mappings.json");
    let mut mappings_file = TeamPathMappingsFile::load(&mappings_path);

    // 不再根据 vault_id 抛弃其他团队的映射，支持单库多团队离线留存
    let team_mappings = mappings_file
        .teams
        .entry(target_vault_id.clone())
        .or_insert_with(std::collections::HashMap::new);
    team_mappings.insert(source_dir.clone(), target_dir.clone());
    mappings_file.save(&mappings_path);
    log::debug!(
        "[Promote] Saved path mapping for team {}: {} → {}",
        target_vault_id,
        source_dir,
        target_dir
    );

    // promote.rs — Promote 完成后激活后台团队同步
    let team_state_path = root.join(".slash/team_sync_state.json");
    let team_state = serde_json::json!({ "vault_id": target_vault_id });
    if let Ok(json) = serde_json::to_string_pretty(&team_state) {
        let _ = std::fs::write(&team_state_path, json);
        log::debug!(
            "[Promote] Activated team sync: wrote vault_id={} to team_sync_state.json",
            target_vault_id
        );
    }

    Ok(push_resp.accepted.len() as u32)
}
