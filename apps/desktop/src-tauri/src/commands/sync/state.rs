//! 统一同步状态持久化
//!
//! 方案 C：将 personal sync_state.json 和 team_sync_{id}.json 合并为
//! unified_sync_state.json，每个文件维护三元组 (personal_hash, team_hash, local_snapshot)

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ============================================================
// 统一数据结构
// ============================================================

/// 每个文件的统一同步状态
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UnifiedFileState {
    /// 上次 personal sync push/pull 成功后的 server hash
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub personal_hash: String,

    /// 上次 team sync push/pull 成功后的 server hash
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub team_hash: String,

    /// 最近一次 sync（personal 或 team）结束时的本地磁盘文件 hash 快照
    /// 用于判断 "用户是否真正编辑过"：local_hash != local_snapshot → 用户编辑了
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub local_snapshot: String,

    /// 用户首次开始编辑此文件的时间（Unix timestamp, seconds）
    /// 在 local_snapshot 首次与 disk_hash 不一致时（= 用户真实编辑发生）记录
    /// 服务端保存为历史版本的 session_started_at
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_started_at: Option<i64>,

    /// 当前编辑生命周期标识。
    /// 与 edit_started_at 一起发送给 server，用于把同一段编辑合并成一个历史版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_session_id: Option<String>,

    /// 最近一次观察到该 session 活跃的时间（Unix timestamp, seconds）。
    /// 超过本地 idle 窗口后，下一轮 sync 会结束 session，后续编辑生成新的历史版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_session_touched_at: Option<i64>,

    /// UUID-First: 文件身份标识（从 frontmatter slash_id 提取）
    /// 用于 rename 检测：文件改名后 file_id 不变，可在新旧路径间关联同一文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,

    /// Asset GC 保护期：首次检测到 asset 文件从磁盘消失的 Unix 时间戳（秒）
    /// 只有超过保护期（60秒）后才允许推送删除，防止 Ctrl+Z 撤销竞争
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_since: Option<i64>,
}

/// 统一同步状态表：本地相对路径 → 三元组
pub type UnifiedSyncState = HashMap<String, UnifiedFileState>;

/// 旧版同步状态（兼容迁移）：路径 → hash
pub type LegacySyncState = HashMap<String, String>;

/// Keep one edit session alive for 10 minutes of inactivity so version history
/// reflects a continuous editing burst instead of fragmenting into short snapshots.
pub const EDIT_SESSION_IDLE_SECS: i64 = 600;

/// 为一次本地编辑生命周期生成稳定 ID。
/// 不依赖随机数，避免同一轮 sync 内重复构造 payload 时得到不同 session。
pub fn make_edit_session_id(
    relative_path: &str,
    edit_started_at: i64,
    file_id: Option<&str>,
) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    relative_path.hash(&mut hasher);
    edit_started_at.hash(&mut hasher);
    file_id.hash(&mut hasher);
    format!("edit-{edit_started_at}-{:016x}", hasher.finish())
}

pub fn expire_edit_session_if_idle(state: &mut UnifiedFileState, now: i64) {
    if state.edit_session_touched_at.map_or(false, |touched_at| {
        now - touched_at > EDIT_SESSION_IDLE_SECS
    }) {
        state.edit_started_at = None;
        state.edit_session_id = None;
        state.edit_session_touched_at = None;
    }
}

// ============================================================
// 读写
// ============================================================

/// 获取统一 sync state 文件路径
pub fn unified_state_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".slash").join("unified_sync_state.json")
}

/// 加载统一同步状态（自动迁移旧格式）
pub fn load_unified_state(vault_root: &Path) -> UnifiedSyncState {
    let path = unified_state_path(vault_root);
    let tmp_path = path.with_extension("json.tmp");

    // 1. 优先读新格式主文件
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<UnifiedSyncState>(&data) {
                return state;
            }
            // 主文件存在但解析失败（半写崩溃）→ 降级到 .tmp
            log::error!("[SyncState] Main file corrupt, falling back to .tmp");
        }
    }

    // 2. 降级：尝试读上次写入留下的 .tmp（崩溃恢复）
    if tmp_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&tmp_path) {
            if let Ok(state) = serde_json::from_str::<UnifiedSyncState>(&data) {
                log::info!("[SyncState] Recovered from .tmp file");
                return state;
            }
        }
    }

    // 3. 新格式不存在 → 尝试迁移旧格式
    let migrated = migrate_legacy_states(vault_root);
    if !migrated.is_empty() {
        save_unified_state(vault_root, &migrated);
        log::info!(
            "[SyncState] Migrated {} files from legacy format",
            migrated.len()
        );
    }

    migrated
}

/// 保存统一同步状态（原子写入：tmp → fsync → rename）
pub fn save_unified_state(vault_root: &Path, state: &UnifiedSyncState) {
    let path = unified_state_path(vault_root);
    let tmp_path = path.with_extension("json.tmp");

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let json = match serde_json::to_string_pretty(state) {
        Ok(j) => j,
        Err(e) => {
            log::error!("[SyncState] Serialize error: {e}");
            return;
        }
    };

    // Step 1: 写临时文件
    if let Err(e) = std::fs::write(&tmp_path, &json) {
        log::error!("[SyncState] Write tmp error: {e}");
        return;
    }

    // Step 2: fsync — 确保数据真正落盘，防止 OS 写缓冲导致崩溃丢失
    match std::fs::OpenOptions::new().write(true).open(&tmp_path) {
        Ok(f) => {
            let _ = f.sync_all();
        }
        Err(e) => log::error!("[SyncState] fsync error: {e}"),
    }

    // Step 3: 原子 rename（同目录 rename 在所有平台上是原子的）
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        log::error!("[SyncState] Atomic rename error: {e}");
    }
}

// ============================================================
// 旧格式迁移
// ============================================================

/// 读取旧版 sync_state.json（personal）和 team_sync_*.json → 合并为统一格式
fn migrate_legacy_states(vault_root: &Path) -> UnifiedSyncState {
    let mut unified = UnifiedSyncState::new();

    // 1. 迁移 personal sync_state.json
    let personal_path = vault_root.join(".slash").join("sync_state.json");
    if personal_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&personal_path) {
            if let Ok(legacy) = serde_json::from_str::<LegacySyncState>(&data) {
                for (path, hash) in legacy {
                    let entry = unified.entry(path).or_default();
                    entry.personal_hash = hash.clone();
                    entry.local_snapshot = hash; // 用 personal hash 作为初始快照
                }
            }
        }
    }

    // 2. 迁移 team_sync_*.json
    let slash_dir = vault_root.join(".slash");
    if let Ok(entries) = std::fs::read_dir(&slash_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("team_sync_") && name.ends_with(".json") {
                if let Ok(data) = std::fs::read_to_string(entry.path()) {
                    if let Ok(legacy) = serde_json::from_str::<LegacySyncState>(&data) {
                        // team_sync 的 key 是团队路径（01_PROJECTS/...）
                        // 需要反向映射回本地路径
                        for (team_path, hash) in legacy {
                            let local_path = team_path_to_local(&team_path);
                            let entry = unified.entry(local_path).or_default();
                            entry.team_hash = hash;
                        }
                    }
                }
            }
        }
    }

    unified
}

/// 将团队路径（01_PROJECTS/X）反向映射为本地路径（01_Projects/X）
/// 仅在迁移时使用，正常运行时通过 path_mapping 模块处理
fn team_path_to_local(team_path: &str) -> String {
    use super::path_mapping::PARA_TEAM_TO_PERSONAL;

    for (team_prefix, local_prefix) in PARA_TEAM_TO_PERSONAL {
        if team_path.starts_with(team_prefix) {
            return format!("{}{}", local_prefix, &team_path[team_prefix.len()..]);
        }
    }
    // 无匹配 → 原样返回
    team_path.to_string()
}
