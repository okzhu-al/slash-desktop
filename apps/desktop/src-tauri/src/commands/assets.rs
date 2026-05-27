use crate::state::{compute_file_hash_streaming, compute_hash, AssetIndex, AssetIndexState};

use serde::Serialize;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use tauri::State;



#[derive(Serialize)]
pub struct SaveAssetResult {
    pub relative_path: String,
    pub is_duplicate: bool,
}

#[derive(Serialize)]
pub struct RebuildIndexResult {
    pub files_indexed: usize,
}

#[tauri::command]
pub async fn save_asset(
    vault_path: String,
    file_data: Vec<u8>,
    original_name: Option<String>,
    extension: String,
    index_state: State<'_, AssetIndexState>,
) -> Result<SaveAssetResult, String> {
    let vault = PathBuf::from(&vault_path);
    let assets_dir = vault.join("assets");

    // Ensure assets directory exists
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }

    // Step 1: Compute hash of incoming file ONLY (O(1) relative to disk)
    let file_hash = compute_hash(&file_data);
    log::info!(
        "📎 [AssetDedup] save_asset called: hash={}, size={}, original_name={:?}, ext={}",
        &file_hash[..16], file_data.len(), original_name, extension
    );

    // Step 2: Check in-memory index (O(1) lookup)
    {
        let mut index = index_state.0.lock().map_err(|e| e.to_string())?;

        // Ensure index is for the right vault
        let vault_match = index.vault_path == vault_path;
        log::info!(
            "📎 [AssetDedup] Index state: entries={}, vault_match={}, index_vault={}, req_vault={}",
            index.entries.len(), vault_match,
            &index.vault_path, &vault_path
        );

        if vault_match {
            if let Some(existing_path) = index.lookup(&file_hash, &vault) {
                log::info!(
                    "📎 [AssetDedup] ✅ Duplicate found via lookup: {} → {}",
                    &file_hash[..16], existing_path
                );
                // Duplicate found, return existing path
                return Ok(SaveAssetResult {
                    relative_path: existing_path,
                    is_duplicate: true,
                });
            }
            log::info!("📎 [AssetDedup] ❌ No duplicate found for hash={}", &file_hash[..16]);
        } else {
            log::info!("📎 [AssetDedup] ⚠️ Vault mismatch, skipping index lookup");
        }
    }

    // Step 3: No duplicate - save the file
    let ext = extension.trim_start_matches('.');
    // CAS: 使用 content_hash 作为文件名，天然去重且无碰撞
    let filename = format!("{}.{}", &file_hash, ext);
    let target_path = assets_dir.join(&filename);
    let relative_path = format!("assets/{}", filename);

    // Write file
    fs::write(&target_path, &file_data).map_err(|e| e.to_string())?;

    // Step 4: Update index and persist
    {
        let mut index = index_state.0.lock().map_err(|e| e.to_string())?;

        // Update vault path if needed (first save or vault changed)
        if index.vault_path != vault_path {
            index.vault_path = vault_path.clone();
            index.entries.clear();
        }

        index.insert(file_hash, relative_path.clone());
        index.save(&vault)?;
    }

    Ok(SaveAssetResult {
        relative_path,
        is_duplicate: false,
    })
}

#[tauri::command]
pub async fn save_asset_from_path(
    vault_path: String,
    source_path: String,
    index_state: State<'_, AssetIndexState>,
) -> Result<SaveAssetResult, String> {
    let t0 = std::time::Instant::now();
    let vault = PathBuf::from(&vault_path);
    let source = PathBuf::from(&source_path);
    let assets_dir = vault.join("assets");

    // Validate source exists
    if !source.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let source_size = std::fs::metadata(&source).map(|m| m.len()).unwrap_or(0);
    log::info!(
        "⏱️ [AssetImport] start: path={} size={} ({:.1}MB)",
        source_path, source_size, source_size as f64 / 1024.0 / 1024.0
    );

    // Ensure assets directory exists
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }

    // 🛡️ 重 IO 操作（hash 计算 + 文件拷贝）移入 spawn_blocking
    // 防止 50MB+ 文件阻塞 tokio worker 线程导致 UI 卡死
    let source_clone = source.clone();
    let assets_dir_clone = assets_dir.clone();
    let source_size_for_log = source_size;

    let result = tokio::task::spawn_blocking(move || -> Result<SaveAssetResult, String> {
        // Step 1: Compute hash using streaming (handles large files)
        let t_hash = std::time::Instant::now();
        let file_hash = compute_file_hash_streaming(&source_clone).map_err(|e| e.to_string())?;
        let hash_ms = t_hash.elapsed().as_millis();
        log::info!(
            "⏱️ [AssetImport] hash done: elapsed_ms={} hash={} size={}",
            hash_ms, &file_hash[..8.min(file_hash.len())], source_size_for_log
        );

        // Step 2: Build target path
        let ext = source_clone
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_else(|| "bin".to_string());

        let filename = format!("{}.{}", &file_hash, ext);
        let target_path = assets_dir_clone.join(&filename);
        let relative_path = format!("assets/{}", filename);

        // CAS 幂等：如果文件已存在，内容必然相同
        if target_path.exists() {
            log::info!(
                "⏱️ [AssetImport] CAS dedup: file already exists, skip copy. hash_ms={}",
                hash_ms
            );
            return Ok(SaveAssetResult {
                relative_path,
                is_duplicate: true,
            });
        }

        // Step 3: Copy file using streaming (no memory bloat)
        let t_copy = std::time::Instant::now();
        {
            use std::io::{BufReader, BufWriter, Read, Write};

            let src_file = File::open(&source_clone).map_err(|e| e.to_string())?;
            let dst_file = File::create(&target_path).map_err(|e| e.to_string())?;

            let mut reader = BufReader::with_capacity(1024 * 1024, src_file);
            let mut writer = BufWriter::with_capacity(1024 * 1024, dst_file);

            let mut buffer = [0u8; 1024 * 64];
            loop {
                let bytes_read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if bytes_read == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[..bytes_read])
                    .map_err(|e| e.to_string())?;
            }
            writer.flush().map_err(|e| e.to_string())?;
        }
        let copy_ms = t_copy.elapsed().as_millis();
        log::info!(
            "⏱️ [AssetImport] copy done: elapsed_ms={} size={}",
            copy_ms, source_size_for_log
        );

        Ok(SaveAssetResult {
            relative_path,
            is_duplicate: false,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    // unwrap nested Result
    let result = result?;

    // Step 4: Update index (lightweight, in-memory)
    let t_index = std::time::Instant::now();
    {
        let mut index = index_state.0.lock().map_err(|e| e.to_string())?;
        if index.vault_path != vault_path {
            index.vault_path = vault_path.clone();
            index.entries.clear();
        }
        // Extract hash from relative_path for index
        let hash_part = result.relative_path
            .strip_prefix("assets/")
            .and_then(|s| s.rsplit_once('.'))
            .map(|(h, _)| h.to_string())
            .unwrap_or_default();
        index.insert(hash_part, result.relative_path.clone());
        index.save(&vault)?;
    }
    let index_ms = t_index.elapsed().as_millis();
    let total_ms = t0.elapsed().as_millis();
    log::info!(
        "⏱️ [AssetImport] complete: total_ms={} index_ms={} is_duplicate={} path={}",
        total_ms, index_ms, result.is_duplicate, result.relative_path
    );

    Ok(result)
}

use std::collections::HashSet;
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct CleanupResult {
    pub moved_count: u32,
    pub space_saved_bytes: u64,
}

/// Public wrapper for extract_asset_references, used by fs.rs for orphan diagnostics
pub fn extract_asset_refs_public(content: &str) -> Vec<String> {
    extract_asset_references(content)
}

/// Extract all asset references from markdown content
fn extract_asset_references(content: &str) -> Vec<String> {
    let mut refs = Vec::new();

    // Match markdown image syntax: ![...](path) or ![...](path "title")
    // Group 1: path (may include trailing space+title)
    // Group 2: optional title content (inside quotes)
    let md_regex = regex::Regex::new(r#"!\[[^\]]*\]\(([^)"]+?)(?:\s+"([^"]*)")?\)"#).unwrap();
    for cap in md_regex.captures_iter(content) {
        if let Some(path) = cap.get(1) {
            let decoded =
                urlencoding::decode(path.as_str().trim()).unwrap_or_else(|_| path.as_str().into());
            refs.push(decoded.to_string());
        }
        // Check title for tldraw reference (e.g., "tldraw:assets/drawing.tldr")
        if let Some(title) = cap.get(2) {
            let title_str = title.as_str();
            if let Some(tldr_path) = title_str.strip_prefix("tldraw:") {
                let decoded =
                    urlencoding::decode(tldr_path.trim()).unwrap_or_else(|_| tldr_path.into());
                refs.push(decoded.to_string());
            }
        }
    }

    // Match HTML img syntax: <img src="path" />
    let html_regex = regex::Regex::new(r#"<img[^>]+src=["']([^"']+)["']"#).unwrap();
    for cap in html_regex.captures_iter(content) {
        if let Some(path) = cap.get(1) {
            let decoded =
                urlencoding::decode(path.as_str()).unwrap_or_else(|_| path.as_str().into());
            refs.push(decoded.to_string());
        }
    }

    refs
}

/// 孤儿资产清理核心逻辑（纯函数，不依赖 Tauri State）
/// 扫描所有 .md 文件，将未被引用的 assets/ 文件移入 .trash/
/// 返回 (moved_count, space_saved_bytes, removed_hashes)
pub fn clean_orphan_assets(vault_path: &Path) -> Result<(u32, u64, Vec<String>), String> {
    let assets_dir = vault_path.join("assets");
    let trash_dir = vault_path.join(".trash");

    if !assets_dir.exists() {
        return Ok((0, 0, Vec::new()));
    }

    // Build allowlist: scan all .md files and extract references
    let mut allowlist = HashSet::new();

    for entry in WalkDir::new(vault_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(path) {
                for reference in extract_asset_references(&content) {
                    let normalized = reference
                        .trim_start_matches("./")
                        .trim_start_matches("../")
                        .to_string();
                    allowlist.insert(normalized);
                }
            }
        }
    }

    // Scan assets directory and identify orphans
    let mut orphans: Vec<PathBuf> = Vec::new();
    let system_files = ["DS_Store", "Thumbs.db", "desktop.ini"];

    for entry in WalkDir::new(&assets_dir)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() {
            if let Some(filename) = path.file_name() {
                let filename_str = filename.to_string_lossy();

                if system_files.iter().any(|sf| filename_str.contains(sf)) {
                    continue;
                }

                let relative_path = format!("assets/{}", filename_str);

                if !allowlist.contains(&relative_path) {
                    orphans.push(path.to_path_buf());
                }
            }
        }
    }

    // Move orphans to .trash
    if !orphans.is_empty() && !trash_dir.exists() {
        fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
    }

    let mut moved_count = 0u32;
    let mut space_saved = 0u64;
    let mut removed_relative_paths: Vec<String> = Vec::new();

    for orphan in &orphans {
        if let Ok(metadata) = fs::metadata(orphan) {
            space_saved += metadata.len();
        }

        if let Some(filename) = orphan.file_name() {
            let target = trash_dir.join(filename);
            if fs::rename(orphan, &target).is_ok() {
                moved_count += 1;
                removed_relative_paths.push(format!("assets/{}", filename.to_string_lossy()));
            }
        }
    }

    if moved_count > 0 {
        log::info!(
            "🧹 [AssetCleanup] Moved {} orphan asset(s) to .trash (saved {} bytes)",
            moved_count, space_saved
        );
    }

    Ok((moved_count, space_saved, removed_relative_paths))
}

#[tauri::command]
pub fn clean_unused_assets(
    vault_path: String,
    index_state: State<AssetIndexState>,
) -> Result<CleanupResult, String> {
    let vault = PathBuf::from(&vault_path);

    let (moved_count, space_saved_bytes, removed_paths) = clean_orphan_assets(&vault)?;

    // Update index: remove moved files
    if !removed_paths.is_empty() {
        if let Ok(mut index) = index_state.0.lock() {
            let mut removed_hashes = Vec::new();
            for rel_path in &removed_paths {
                for (hash, path) in index.entries.iter() {
                    if path == rel_path {
                        removed_hashes.push(hash.clone());
                        break;
                    }
                }
            }
            for hash in removed_hashes {
                index.remove(&hash);
            }
            let _ = index.save(&vault);
        }
    }

    Ok(CleanupResult {
        moved_count,
        space_saved_bytes,
    })
}

#[tauri::command]
pub async fn rebuild_asset_index(
    vault_path: String,
    index_state: State<'_, AssetIndexState>,
) -> Result<RebuildIndexResult, String> {
    let vault = PathBuf::from(&vault_path);

    // Rebuild index from disk
    let new_index = AssetIndex::rebuild(&vault);
    let count = new_index.entries.len();

    // Persist
    new_index.save(&vault)?;

    // Update state
    {
        let mut index = index_state.0.lock().map_err(|e| e.to_string())?;
        *index = new_index;
    }

    Ok(RebuildIndexResult {
        files_indexed: count,
    })
}

#[tauri::command]
pub async fn load_asset_index(
    vault_path: String,
    index_state: State<'_, AssetIndexState>,
) -> Result<usize, String> {
    let vault = PathBuf::from(&vault_path);
    let loaded_index = AssetIndex::load(&vault);
    let count = loaded_index.entries.len();

    {
        let mut index = index_state.0.lock().map_err(|e| e.to_string())?;
        *index = loaded_index;
    }

    Ok(count)
}

/// 读取 macOS 剪贴板中的文件路径列表
/// 前端粘贴大文件时可先调此命令获取路径，直接走 saveAssetFromPath 绕过 JS 内存
#[tauri::command]
pub fn get_clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        // AppleScript 读取剪贴板中所有文件的 POSIX 路径
        let script = r#"
            try
                set theFiles to the clipboard as «class furl»
                return POSIX path of theFiles
            on error
                try
                    set theList to {}
                    repeat with f in (the clipboard as list)
                        try
                            set end of theList to POSIX path of (f as alias)
                        end try
                    end repeat
                    set AppleScript's text item delimiters to linefeed
                    return theList as text
                on error
                    return ""
                end try
            end try
        "#;

        match std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
        {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if text.is_empty() {
                    return vec![];
                }
                text.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty() && std::path::Path::new(l).exists())
                    .collect()
            }
            Err(e) => {
                log::warn!("[Clipboard] osascript failed: {}", e);
                vec![]
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}
