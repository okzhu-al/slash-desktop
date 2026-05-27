//! 路径映射管理
//!
//! TeamPathMappingsFile 持久化 + 路径前缀标准化 + PARA 反向映射

/// 确保路径以 `/` 结尾
pub fn normalize_prefix(dir: &str) -> String {
    if dir.ends_with('/') {
        dir.to_string()
    } else {
        format!("{dir}/")
    }
}

/// 磁盘持久化格式：.slash/team_path_mappings.json
/// 绑定 vault_id 防止 Docker 重建（vault UUID 改变）后旧映射被误用
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TeamPathMappingsFile {
    /// team_vault_id -> { local_dir: target_dir }
    pub teams: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

impl TeamPathMappingsFile {
    pub fn load(path: &std::path::Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        let data = std::fs::read_to_string(path).unwrap_or_default();
        
        // Try parsing as V2
        if let Ok(v2) = serde_json::from_str::<Self>(&data) {
            return v2;
        }

        // Try parsing as V1 and migrate
        #[derive(serde::Deserialize)]
        struct OldFormat {
            vault_id: String,
            mappings: std::collections::HashMap<String, String>,
        }
        
        if let Ok(old) = serde_json::from_str::<OldFormat>(&data) {
            let mut teams = std::collections::HashMap::new();
            if !old.vault_id.is_empty() && !old.mappings.is_empty() {
                teams.insert(old.vault_id, old.mappings);
            }
            let migrated = Self { teams };
            migrated.save(path); // Update on disk immediately
            return migrated;
        }

        Self::default()
    }

    pub fn save(&self, path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let tmp_path = path.with_extension("json.tmp");
            if std::fs::write(&tmp_path, &json).is_ok() {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&tmp_path) {
                    let _ = f.sync_all(); // fsync to guarantee disk write
                }
                let _ = std::fs::rename(&tmp_path, path); // atomic rename
            }
        }
    }
}

/// PARA 团队→个人映射表
pub const PARA_TEAM_TO_PERSONAL: &[(&str, &str)] = &[
    ("01_PROJECTS", "01_Projects"),
    ("02_AREAS", "02_Areas"),
    ("03_RESOURCE", "03_Resources"),
    ("04_ARCHIVE", "04_Archives"),
];

/// 将团队 vault 的 target_path 解析为本地文件路径
/// 使用 reverse_mappings (target_dir → source_dir) 进行反向映射
pub fn resolve_team_pull_path(
    root: &std::path::Path,
    target_path: &str,
    reverse_mappings: &std::collections::HashMap<&str, &str>,
) -> std::path::PathBuf {
    // 尝试匹配最长的 target 前缀
    let mut best_match_len = 0;
    let mut local_relative_path = target_path.to_string();

    for (target_dir, source_dir) in reverse_mappings {
        let tgt_prefix = normalize_prefix(target_dir);

        if target_path.starts_with(&tgt_prefix) && tgt_prefix.len() > best_match_len {
            best_match_len = tgt_prefix.len();
            let src_prefix = normalize_prefix(source_dir);
            local_relative_path = format!(
                "{}{}",
                src_prefix,
                target_path.strip_prefix(&tgt_prefix).unwrap_or(target_path)
            );
        }
    }

    root.join(&local_relative_path)
}
