//! 同步工具函数
//!
//! 目录级 Merkle hash 构建、文件收集、mapped_files 的 directory_hashes 构建

use slash_core::{calculate_directory_hash, FileManifestBasic};
use slash_sync_proto::{DirectoryHash, FileManifest, FilePushPayload};

/// 从文件字节内容中提取 slash_id（YAML frontmatter 字段）并解析为 UUID 字符串
pub fn extract_slash_id_str(content: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(content).ok()?;
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let end = trimmed[3..].find("\n---")?;
    let fm = &trimmed[3..3 + end];
    for line in fm.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("slash_id:") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            // 🛡️ FIX BUG-003: 不仅检查长度，还验证 UUID 格式 (8-4-4-4-12)
            if val.len() == 36 && is_valid_uuid(val) {
                return Some(val.to_string());
            }
        }
    }
    None
}

static ASSET_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

fn get_asset_re() -> &'static regex::Regex {
    // 宽松匹配：捕获 (可选的 .slash/)assets/ 之后的完整文件名
    // 兼容旧格式 .slash/assets/{sha256}.ext 和新格式 assets/{任意文件名}.ext
    ASSET_RE.get_or_init(|| {
        regex::Regex::new(r#"(?:\.slash[/\\])?assets[/\\]([^"'\)\]\s]+(?:\.[a-zA-Z0-9]+)?)"#)
            .unwrap()
    })
}

/// 从 markdown 字节内容中提取 AssetRef 列表 (OPT-04 Asset Closure)
pub fn extract_asset_refs(content: &[u8]) -> Option<Vec<slash_sync_proto::AssetRef>> {
    let text = std::str::from_utf8(content).ok()?;
    let mut assets = Vec::new();
    let mut seen_filenames = std::collections::HashSet::new();

    for caps in get_asset_re().captures_iter(text) {
        if let Some(filename_match) = caps.get(1) {
            let filename = filename_match.as_str().to_string();
            let ext = filename.rsplit('.').next().unwrap_or("bin");

            if !seen_filenames.contains(&filename) {
                seen_filenames.insert(filename.clone());
                let kind = match ext.to_lowercase().as_str() {
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
                    "mp4" | "webm" | "mov" | "mkv" => "video",
                    "mp3" | "wav" | "ogg" | "m4a" => "audio",
                    _ => "file",
                };
                assets.push(slash_sync_proto::AssetRef {
                    asset_id: filename.clone(),
                    // 【关键】统一使用 assets/{filename}，不硬编码 .slash 前缀
                    relative_path: format!("assets/{}", filename),
                    kind: kind.to_string(),
                    group_id: None,
                });
            }
        }
    }

    // [OPT-04] FIX: 空资产数组必须返回 Some(vec![]) 而不是 None，
    // 否则服务端 Push 阶段 `if let Some(ref assets)` 会判定为不处理资产更新，导致旧的 DB 映射无法解除！
    Some(assets)
}

/// 从本地 manifests 构建目录级 Merkle hash 列表
pub fn build_local_directory_hashes(manifests: &[FileManifestBasic]) -> Vec<DirectoryHash> {
    let mut dir_files: std::collections::HashMap<String, Vec<&str>> =
        std::collections::HashMap::new();

    for m in manifests {
        let dir = extract_directory(&m.relative_path);
        dir_files.entry(dir).or_default().push(&m.content_hash);
    }

    dir_files
        .into_iter()
        .map(|(path, mut hashes)| {
            let file_count = hashes.len() as u32;
            let merkle_hash = calculate_directory_hash(&mut hashes);
            DirectoryHash {
                path,
                merkle_hash,
                file_count,
            }
        })
        .collect()
}

/// 从 mapped_files (target_path, manifest) 构建目录级 Merkle hash（用于 Promote 和 Team Sync）
pub fn build_directory_hashes_from_mapped(
    mapped_files: &[(String, &FileManifestBasic)],
) -> Vec<DirectoryHash> {
    let mut dir_files: std::collections::HashMap<String, Vec<&str>> =
        std::collections::HashMap::new();
    for (target_path, m) in mapped_files {
        let dir = extract_directory(target_path);
        dir_files.entry(dir).or_default().push(&m.content_hash);
    }
    dir_files
        .into_iter()
        .map(|(path, mut hashes)| {
            let file_count = hashes.len() as u32;
            let merkle_hash = calculate_directory_hash(&mut hashes);
            DirectoryHash {
                path,
                merkle_hash,
                file_count,
            }
        })
        .collect()
}

/// 从路径中提取目录部分
fn extract_directory(path: &str) -> String {
    if let Some(pos) = path.rfind('/') {
        path[..=pos].to_string()
    } else {
        "/".to_string()
    }
}

/// 根据 server_needs 列表收集需要推送的文件（个人同步使用）
pub fn collect_files_for_push(
    root: &std::path::Path,
    manifests: &[FileManifestBasic],
    server_needs: &[String],
) -> Vec<FilePushPayload> {
    let mut files = Vec::new();

    for need in server_needs {
        if need.ends_with('*') {
            // 通配符：推送整个目录
            let dir_prefix = need.trim_end_matches('*');
            for m in manifests {
                let m_dir = extract_directory(&m.relative_path);
                if m_dir == dir_prefix {
                    if let Some(payload) = manifest_to_payload(root, m) {
                        files.push(payload);
                    }
                }
            }
        } else {
            // 精确路径
            if let Some(m) = manifests.iter().find(|m| m.relative_path == *need) {
                if let Some(payload) = manifest_to_payload(root, m) {
                    files.push(payload);
                }
            }
        }
    }

    files
}

/// 从 mapped_files 中根据 server_needs 收集需要推送的文件（Promote / Team Sync 使用）
///
/// [Phase 6] asset 文件一律只发 metadata/declaration (content = empty)，
/// blob 由 TransferManager 异步上传。
pub fn collect_mapped_files_for_push(
    root: &std::path::Path,
    mapped_files: &[(String, &FileManifestBasic)],
    server_needs: &[String],
) -> Vec<FilePushPayload> {
    let mut files_to_push: Vec<FilePushPayload> = Vec::new();

    for need in server_needs {
        if need.ends_with('*') {
            // 通配符：server 需要整个目录
            let dir_need = need.trim_end_matches('*');
            for (target_path, source_manifest) in mapped_files {
                let target_dir_part = extract_directory(target_path);
                if target_dir_part == dir_need {
                    if let Some(payload) =
                        mapped_file_to_payload(root, target_path, source_manifest)
                    {
                        files_to_push.push(payload);
                    }
                }
            }
        } else if let Some((_, source_manifest)) = mapped_files.iter().find(|(tp, _)| tp == need) {
            if let Some(payload) = mapped_file_to_payload(root, need, source_manifest) {
                files_to_push.push(payload);
            }
        }
    }

    files_to_push
}

/// mapped_file → FilePushPayload，对 asset 文件实施 Phase 6 blob 剥离
fn mapped_file_to_payload(
    root: &std::path::Path,
    target_path: &str,
    source_manifest: &FileManifestBasic,
) -> Option<FilePushPayload> {
    let file_path = root.join(&source_manifest.relative_path);

    // [Phase 6] 资产文件走慢车道：只发 manifest + declaration，不读 blob 内容
    let is_asset = target_path.starts_with("assets/") || target_path.starts_with(".slash/assets/");

    if is_asset {
        log::info!(
            "[Phase6 TeamSync] asset push payload stripped: path={} size={} content_bytes=0",
            target_path,
            source_manifest.size
        );
        return Some(FilePushPayload {
            manifest: FileManifest {
                relative_path: target_path.to_string(),
                content_hash: source_manifest.content_hash.clone(),
                size: source_manifest.size,
                mtime: source_manifest.mtime,
                logical_clock: 0,
                file_id: source_manifest.file_id.clone(),
                directory_id: None,
                editor_display_name: None,
                pushed_by_display_name: None,
                edit_started_at: None,
                edit_session_id: None,
                is_user_edit: false,
                assets: None,
            },
            content: Vec::new(), // blob 通过 TransferManager 异步上传
        });
    }

    // 🛡️ 大文件保护（>10MB 非 assets 文件）
    const LARGE_FILE_THRESHOLD: u64 = 10 * 1024 * 1024;
    if source_manifest.size > LARGE_FILE_THRESHOLD {
        log::warn!(
            "[FastSync] ⚠️ large non-asset file skipped from push payload ({}MB): {}",
            source_manifest.size / 1024 / 1024,
            target_path
        );
        return None;
    }

    // 普通文件：全量读取内容（快车道）
    let content = std::fs::read(&file_path).ok()?;
    let file_id = extract_slash_id_str(&content);

    Some(FilePushPayload {
        manifest: FileManifest {
            relative_path: target_path.to_string(),
            content_hash: source_manifest.content_hash.clone(),
            size: source_manifest.size,
            mtime: source_manifest.mtime,
            logical_clock: 0,
            file_id,
            directory_id: None,
            editor_display_name: None,
            pushed_by_display_name: None,
            edit_started_at: None,
            edit_session_id: None,
            is_user_edit: false,
            assets: extract_asset_refs(&content),
        },
        content,
    })
}

/// 将 FileManifestBasic 转换为含文件内容的 FilePushPayload
pub fn manifest_to_payload(
    root: &std::path::Path,
    m: &FileManifestBasic,
) -> Option<FilePushPayload> {
    let file_path = root.join(&m.relative_path);

    // [Phase 6] 资产文件走慢车道：只发 manifest + declaration，不读 blob 内容
    let is_asset =
        m.relative_path.starts_with("assets/") || m.relative_path.starts_with(".slash/assets/");

    if is_asset {
        log::debug!(
            "[Phase6 FastSync] asset manifest-only push (no blob): {}",
            m.relative_path
        );
        return Some(FilePushPayload {
            manifest: FileManifest {
                relative_path: m.relative_path.clone(),
                content_hash: m.content_hash.clone(),
                size: m.size,
                mtime: m.mtime,
                logical_clock: 1,
                file_id: m.file_id.clone(),
                directory_id: None,
                editor_display_name: None,
                pushed_by_display_name: None,
                edit_started_at: None,
                edit_session_id: None,
                is_user_edit: false,
                assets: None,
            },
            content: Vec::new(),
        });
    }

    // 🛡️ 大文件保护（>10MB 非 assets 文件）：不全量读入内存
    // 防止 Finder 拷入大视频/压缩包导致 OOM 和 UI 卡死
    const LARGE_FILE_THRESHOLD: u64 = 10 * 1024 * 1024;
    if m.size > LARGE_FILE_THRESHOLD {
        log::warn!(
            "[FastSync] ⚠️ large non-asset file skipped from push payload ({}MB): {}",
            m.size / 1024 / 1024,
            m.relative_path
        );
        return None;
    }

    // 普通文件：全量读取内容（快车道）
    let content = std::fs::read(&file_path).ok()?;

    Some(FilePushPayload {
        manifest: FileManifest {
            relative_path: m.relative_path.clone(),
            content_hash: m.content_hash.clone(),
            size: m.size,
            mtime: m.mtime,
            logical_clock: 1,
            file_id: m.file_id.clone(),
            directory_id: None,
            editor_display_name: None,
            pushed_by_display_name: None,
            edit_started_at: None,
            edit_session_id: None,
            is_user_edit: true,
            assets: extract_asset_refs(&content),
        },
        content,
    })
}

/// UUID 格式校验 (8-4-4-4-12)，不依赖 uuid crate
fn is_valid_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let expected_lens = [8, 4, 4, 4, 12];
    parts
        .iter()
        .zip(expected_lens.iter())
        .all(|(part, &len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// OPT-04 第二道保险：过滤超过指定大小的资产引用，防止超大文件随闭包推送到 Team 服务端
pub fn filter_oversized_assets(
    root: &std::path::Path,
    assets: Option<Vec<slash_sync_proto::AssetRef>>,
    max_size: u64,
) -> Option<Vec<slash_sync_proto::AssetRef>> {
    let assets = assets?;
    let filtered: Vec<_> =
        assets
            .into_iter()
            .filter(|asset| {
                let asset_path = root.join(&asset.relative_path);
                match std::fs::metadata(&asset_path) {
                    Ok(meta) => {
                        if meta.len() > max_size {
                            log::warn!(
                        "⚠️ [Asset Closure] Oversized asset stripped: {} ({} bytes > {} limit)",
                        asset.relative_path, meta.len(), max_size
                    );
                            false
                        } else {
                            true
                        }
                    }
                    Err(_) => true, // 无法读取元数据时放行，让服务端验资
                }
            })
            .collect();

    // [OPT-04] FIX: 即便过滤后成为空数组，也必须保留 Some(vec![])
    // 否则服务端会忽略更新，从而导致旧图片映射无法解除！
    Some(filtered)
}

/// Helper to validate if a path is located inside the vault to prevent Path Traversal during synchronization
fn normalize_path_to_string(path: &std::path::Path) -> String {
    let mut s = path.to_string_lossy().to_string();
    if s.starts_with(r#"\\?\"#) {
        s = s[4..].to_string();
    }
    let mut s = s.replace('\\', "/");
    if s.starts_with("//?/") {
        s = s[4..].to_string();
    }
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    s
}

/// Helper to validate if a path is located inside the vault to prevent Path Traversal during synchronization
pub fn validate_path_in_vault(path: &std::path::Path, vault: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let abs_vault = vault.canonicalize().map_err(|e| format!("Invalid vault path: {}", e))?;
    let abs_vault_norm = normalize_path_to_string(&abs_vault);

    if path.exists() {
        let abs_path = path.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
        if !normalize_path_to_string(&abs_path).starts_with(&abs_vault_norm) {
            return Err("Access denied: path is outside vault".to_string());
        }
        return Ok(abs_path);
    }

    let mut ancestor = path;
    while let Some(parent) = ancestor.parent() {
        if parent.exists() {
            let abs_parent = parent.canonicalize().map_err(|e| format!("Invalid parent path: {}", e))?;
            if !normalize_path_to_string(&abs_parent).starts_with(&abs_vault_norm) {
                return Err("Access denied: path traversal detected via parent".to_string());
            }
            break;
        }
        ancestor = parent;
    }

    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        abs_vault.join(path)
    };

    let mut components = Vec::new();
    for comp in abs_path.components() {
        match comp {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::Normal(_) |
            std::path::Component::RootDir |
            std::path::Component::Prefix(_) => {
                components.push(comp);
            }
            std::path::Component::CurDir => {}
        }
    }
    let cleaned_path: std::path::PathBuf = components.into_iter().collect();
    if !normalize_path_to_string(&cleaned_path).starts_with(&abs_vault_norm) {
        return Err("Access denied: path traversal detected".to_string());
    }

    Ok(cleaned_path)
}
