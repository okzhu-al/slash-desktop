pub mod diff;

use regex::Regex;
use serde_json;

pub fn calculate_content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result).chars().take(16).collect()
}

/// 基于原始字节计算内容 hash（用于二进制文件）
pub fn calculate_content_hash_bytes(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    format!("{:x}", result).chars().take(16).collect()
}

/// 流式计算大文件 hash（8KB 缓冲区，不全量加载到内存）
pub fn streaming_hash_file(path: &std::path::Path) -> Result<String, std::io::Error> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    let result = hasher.finalize();
    Ok(format!("{:x}", result).chars().take(16).collect())
}

pub fn extract_json_array(raw: &str) -> Option<Vec<String>> {
    let re = Regex::new(r"(?s)\[.*?\]").ok()?;
    for mat in re.find_iter(raw) {
        let candidate = mat.as_str();
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(candidate) {
            if !arr.is_empty() {
                return Some(arr);
            }
        }
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(candidate) {
            let strings: Vec<String> = arr
                .iter()
                .filter_map(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .collect();
            if !strings.is_empty() {
                return Some(strings);
            }
        }
    }
    None
}

pub fn strip_markdown_code_block(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("```") {
        let lines: Vec<&str> = trimmed.lines().collect();
        if lines.len() >= 2 {
            let content = &lines[1..lines.len().saturating_sub(1)];
            return content.join("\n");
        }
    }
    raw.to_string()
}

pub fn truncate_for_context(content: &str, max_chars: usize) -> String {
    let char_count = content.chars().count();
    if char_count <= max_chars {
        content.to_string()
    } else {
        let byte_index = content
            .char_indices()
            .nth(max_chars)
            .map(|(idx, _)| idx)
            .unwrap_or(content.len());
        format!("{}...[truncated]", &content[..byte_index])
    }
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| {
            !matches!(
                c,
                '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        })
        .collect::<String>()
        .replace("..", "")
        .trim()
        .to_string()
}

pub fn extract_meaningful_content(content: &str) -> String {
    use std::sync::OnceLock;

    static IMAGE_RE: OnceLock<Regex> = OnceLock::new();
    static LINK_RE: OnceLock<Regex> = OnceLock::new();

    let image_regex = IMAGE_RE.get_or_init(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
    let link_regex = LINK_RE.get_or_init(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());

    let mut result = String::new();
    let mut in_code_fence = false;
    let mut in_frontmatter = false;
    let mut frontmatter_count = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            frontmatter_count += 1;
            if frontmatter_count == 1 {
                in_frontmatter = true;
            } else if frontmatter_count == 2 {
                in_frontmatter = false;
            }
            continue;
        }

        if in_frontmatter {
            continue;
        }
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }
        if trimmed.contains("---") && trimmed.contains('|') {
            continue;
        }

        let mut processed = trimmed.to_string();
        processed = image_regex.replace_all(&processed, "").to_string();
        processed = link_regex.replace_all(&processed, "$1").to_string();
        processed = processed.replace('|', " ");
        processed = processed.trim_start_matches('#').to_string();
        processed = processed.trim_start_matches('-').to_string();
        processed = processed.trim_start_matches('*').to_string();
        processed = processed
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.')
            .to_string();
        processed = processed
            .replace("[ ]", "")
            .replace("[x]", "")
            .replace("[X]", "");

        let cleaned = processed.trim();
        if !cleaned.is_empty() {
            result.push_str(cleaned);
            result.push(' ');
        }
    }
    result.trim().to_string()
}

// ============================================================
// Sync: Merkle Tree & Directory Scanning
// ============================================================

/// 基础文件元信息 (不含 logical_clock，用于本地扫描)
#[derive(Debug, Clone)]
pub struct FileManifestBasic {
    pub relative_path: String,
    pub content_hash: String,
    pub size: u64,
    pub mtime: i64,
    pub file_id: Option<String>,  // UUID-First: 从 frontmatter slash_id 提取的文件身份
}

/// 构建目录的 Merkle Hash
///
/// 将给定目录下所有文件的 content_hash 排序后拼接，
/// 再对拼接结果计算 SHA-256，实现递归聚合。
pub fn calculate_directory_hash(file_hashes: &mut Vec<&str>) -> String {
    file_hashes.sort();
    let combined = file_hashes.join("|");
    calculate_content_hash(&combined)
}

/// Team 空间的单文件同步体积上限（离线降级默认值：200MB）
/// 在线模式下，实际限制由 server_capabilities.max_sync_file_size 决定
/// 个人空间不设限额（由客户端控制跳过 size 过滤）
pub const TEAM_ASSET_MAX_SIZE_DEFAULT: u64 = 200 * 1024 * 1024;

/// 扫描指定目录，为每个文件生成 FileManifestBasic
///
/// - `root`: vault 根目录的绝对路径
/// - `max_file_size`: 最大文件体积限制，超出不纳入扫描。传入 None 表示不限制
/// - 返回值中的 `relative_path` 是相对于 root 的路径 (使用 `/` 分隔符)
pub fn scan_directory_manifests(root: &std::path::Path, max_file_size: Option<u64>) -> Vec<FileManifestBasic> {
    use std::fs;
    use walkdir::WalkDir;

    let mut results = Vec::new();

    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();

        // 先计算相对路径，然后基于相对路径过滤隐藏文件
        let relative = match path.strip_prefix(root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        // 跳过 .slash 目录和隐藏文件（以 . 开头的路径段）
        if relative.contains("/.slash/")
            || relative.starts_with(".slash/")
            || relative.split('/').any(|seg| seg.starts_with('.'))
        {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let size = metadata.len();

        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // 🚀 OPTIMIZATION: 对于 assets 目录下的静态资源，文件名就是哈希。
        // 绝对不能去全量 read 文件内容（71MB 的视频会瞬间导致 OOM 或高频 IO，从而触发 false disappearance）
        // 🛡️ BUG-SYNC-ASSET-02 FIX: 此判断必须在 max_file_size 过滤之前！
        // 原因：assets 不读文件内容（零 IO），size 限制对它们毫无意义。
        // 如果放在 size 过滤之后，超大视频（>50MB）会被 continue 跳过，
        // 导致 negotiate 时服务端误以为客户端没有该文件 → 每次重启都重新下载。
        if relative.starts_with("assets/") || relative.starts_with(".slash/assets/") {
            let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            results.push(FileManifestBasic {
                relative_path: relative,
                content_hash: file_stem.to_string(),
                size,
                mtime,
                file_id: None,
            });
            continue;
        }

        // 🛡️ 防御 HTTP 413 Payload Too Large / OOM
        // 仅对非 assets 文件生效（需要读取内容计算 hash 的文件）
        if let Some(limit) = max_file_size {
            if size > limit {
                continue;
            }
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => {
                // 非 assets 目录的二进制文件
                // 大文件（>10MB）使用流式 hash，避免全量读入内存
                const STREAM_HASH_THRESHOLD: u64 = 10 * 1024 * 1024;
                if size > STREAM_HASH_THRESHOLD {
                    match streaming_hash_file(path) {
                        Ok(hash) => {
                            results.push(FileManifestBasic {
                                relative_path: relative,
                                content_hash: hash,
                                size,
                                mtime,
                                file_id: None,
                            });
                        }
                        Err(e) => {
                            eprintln!("[Scanner] Failed to stream-hash large file {}, skipping. Error: {}", path.display(), e);
                        }
                    }
                    continue;
                }
                // 小二进制文件保留原逻辑
                let data = match fs::read(path) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("[Scanner] Failed to read binary file {}, skipping. Error: {}", path.display(), e);
                        continue;
                    }
                };
                results.push(FileManifestBasic {
                    relative_path: relative,
                    content_hash: calculate_content_hash_bytes(&data),
                    size,
                    mtime,
                    file_id: None,
                });
                continue;
            }
        };

        let hash = calculate_content_hash(&content);
        let size = metadata.len();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // UUID-First: 从文本内容提取 frontmatter slash_id
        let file_id = extract_slash_id_from_content(&content);

        results.push(FileManifestBasic {
            relative_path: relative,
            content_hash: hash,
            size,
            mtime,
            file_id,
        });
    }

    results
}

/// 从文本内容的 YAML frontmatter 中提取 `slash_id` 字段值
///
/// 术语映射：frontmatter 中叫 `slash_id`，系统内部统一叫 `file_id`
pub fn extract_slash_id_from_content(content: &str) -> Option<String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let end = trimmed[3..].find("\n---")?;
    let fm = &trimmed[3..3 + end];
    for line in fm.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("slash_id:") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            // 🛡️ FIX BUG-003: 不仅检查长度，还验证 UUID 格式
            if val.len() == 36 && uuid::Uuid::parse_str(val).is_ok() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_hash_deterministic() {
        let h1 = calculate_content_hash("hello world");
        let h2 = calculate_content_hash("hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
    }

    #[test]
    fn test_content_hash_different_input() {
        let h1 = calculate_content_hash("foo");
        let h2 = calculate_content_hash("bar");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_directory_hash_order_independent() {
        let mut a = vec!["hash_a", "hash_b", "hash_c"];
        let mut b = vec!["hash_c", "hash_a", "hash_b"];
        let ha = calculate_directory_hash(&mut a);
        let hb = calculate_directory_hash(&mut b);
        assert_eq!(ha, hb, "排序后应产生相同的 Merkle hash");
    }

    #[test]
    fn test_directory_hash_content_sensitive() {
        let mut a = vec!["hash_a", "hash_b"];
        let mut b = vec!["hash_a", "hash_x"];
        let ha = calculate_directory_hash(&mut a);
        let hb = calculate_directory_hash(&mut b);
        assert_ne!(ha, hb, "不同文件组合应产生不同 hash");
    }

    #[test]
    fn test_scan_directory_manifests() {
        use std::fs;

        // 创建临时目录结构
        let tmp = std::env::temp_dir().join("slash_test_scan");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("note1.md"), "# Hello").unwrap();
        fs::write(tmp.join("sub/note2.md"), "# World").unwrap();
        fs::create_dir_all(tmp.join(".slash")).unwrap();
        fs::write(tmp.join(".slash/slash.db"), "hidden").unwrap();

        let manifests = scan_directory_manifests(&tmp, None);

        // .slash 目录应被跳过
        let paths: Vec<&str> = manifests.iter().map(|m| m.relative_path.as_str()).collect();
        assert!(paths.contains(&"note1.md"));
        assert!(paths.contains(&"sub/note2.md"));
        assert!(
            !paths.iter().any(|p| p.contains(".slash")),
            ".slash 目录应被过滤"
        );

        // 验证 hash 正确性
        let note1 = manifests
            .iter()
            .find(|m| m.relative_path == "note1.md")
            .unwrap();
        assert_eq!(note1.content_hash, calculate_content_hash("# Hello"));

        // 清理
        let _ = fs::remove_dir_all(&tmp);
    }
}
