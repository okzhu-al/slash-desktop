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

/// UUID-first 团队目录映射条目。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TeamDirectoryMapping {
    pub directory_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub role: String,
    pub status: String,
}

/// 单个 team vault 下的目录映射。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TeamDirectoryMappings {
    pub directories: std::collections::HashMap<String, TeamDirectoryMapping>,
}

/// 磁盘持久化格式：.slash/team_directory_mappings.json
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TeamDirectoryMappingsFile {
    pub version: u8,
    pub teams: std::collections::HashMap<String, TeamDirectoryMappings>,
}

impl Default for TeamDirectoryMappingsFile {
    fn default() -> Self {
        Self {
            version: 3,
            teams: std::collections::HashMap::new(),
        }
    }
}

/// UUID-first 团队文件本地落点映射。
///
/// `remote_path` 是团队空间事实路径；`local_path` 只是当前客户端的物理落点。
/// 当本地 Vault 已有同 basename 文件时，团队文件可以落到避让名，但同步仍按
/// `file_id -> remote_path` 推回团队空间。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TeamFileMapping {
    pub file_id: String,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_id: Option<String>,
    pub status: String,
}

/// 单个 team vault 下的文件映射。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TeamFileMappings {
    pub files: std::collections::HashMap<String, TeamFileMapping>,
}

/// 磁盘持久化格式：.slash/team_file_mappings.json
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TeamFileMappingsFile {
    pub version: u8,
    pub teams: std::collections::HashMap<String, TeamFileMappings>,
}

impl Default for TeamFileMappingsFile {
    fn default() -> Self {
        Self {
            version: 1,
            teams: std::collections::HashMap::new(),
        }
    }
}

impl TeamFileMappingsFile {
    pub fn load(path: &std::path::Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        let data = std::fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str::<Self>(&data).unwrap_or_default()
    }

    pub fn save(&self, path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let tmp_path = path.with_extension("json.tmp");
            if std::fs::write(&tmp_path, &json).is_ok() {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&tmp_path) {
                    let _ = f.sync_all();
                }
                let _ = std::fs::rename(&tmp_path, path);
            }
        }
    }

    pub fn upsert(
        &mut self,
        team_vault_id: &str,
        file_id: String,
        local_path: String,
        remote_path: String,
        directory_id: Option<String>,
    ) {
        let team = self.teams.entry(team_vault_id.to_string()).or_default();
        team.files.insert(
            file_id.clone(),
            TeamFileMapping {
                file_id,
                local_path,
                remote_path,
                directory_id,
                status: "active".to_string(),
            },
        );
    }

    pub fn active_for_team(
        &self,
        team_vault_id: &str,
    ) -> std::collections::HashMap<String, TeamFileMapping> {
        self.teams
            .get(team_vault_id)
            .map(|team| {
                team.files
                    .iter()
                    .filter(|(_, entry)| entry.status == "active")
                    .map(|(file_id, entry)| (file_id.clone(), entry.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn mark_deleted(&mut self, team_vault_id: &str, file_id: &str) {
        if let Some(team) = self.teams.get_mut(team_vault_id) {
            if let Some(entry) = team.files.get_mut(file_id) {
                entry.status = "deleted".to_string();
            }
        }
    }
}

impl TeamDirectoryMappingsFile {
    pub fn load(path: &std::path::Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        let data = std::fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str::<Self>(&data).unwrap_or_default()
    }

    pub fn save(&self, path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let tmp_path = path.with_extension("json.tmp");
            if std::fs::write(&tmp_path, &json).is_ok() {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&tmp_path) {
                    let _ = f.sync_all();
                }
                let _ = std::fs::rename(&tmp_path, path);
            }
        }
    }

    pub fn upsert(
        &mut self,
        team_vault_id: &str,
        directory_id: String,
        local_path: String,
        remote_path: String,
        role: String,
    ) {
        let team = self.teams.entry(team_vault_id.to_string()).or_default();
        team.directories.insert(
            directory_id.clone(),
            TeamDirectoryMapping {
                directory_id,
                local_path,
                remote_path,
                role,
                status: "active".to_string(),
            },
        );
    }

    pub fn to_path_mappings(
        &self,
        team_vault_id: &str,
    ) -> std::collections::HashMap<String, String> {
        self.teams
            .get(team_vault_id)
            .map(|team| {
                team.directories
                    .values()
                    .filter(|entry| entry.status == "active")
                    .map(|entry| (entry.local_path.clone(), entry.remote_path.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn to_directory_id_mappings(
        &self,
        team_vault_id: &str,
    ) -> std::collections::HashMap<String, String> {
        self.teams
            .get(team_vault_id)
            .map(|team| {
                team.directories
                    .values()
                    .filter(|entry| entry.status == "active")
                    .map(|entry| (entry.local_path.clone(), entry.directory_id.clone()))
                    .collect()
            })
            .unwrap_or_default()
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
