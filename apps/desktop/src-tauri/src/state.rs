//! Tauri Managed State Wrappers
//!
//! This module contains all Tauri-managed state types that are shared across commands.
//! These are injected into command handlers via `State<T>`.

use std::sync::{Arc, Mutex, RwLock};
use tokio::runtime::Runtime;

use crate::core::ai::AIService;
use crate::core::db::DbState;
use crate::core::watcher::FileWatcher;

// ============================================================================
// Database State
// ============================================================================

/// Database state managed by Tauri
pub struct DbStateWrapper(pub DbState);

impl Default for DbStateWrapper {
    fn default() -> Self {
        DbStateWrapper(DbState::default())
    }
}

// ============================================================================
// Session State
// ============================================================================

pub struct SessionStore {
    pub active_user_id: Option<String>,
    pub active_server_url: Option<String>,
    pub cached_access_token: Option<String>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            active_user_id: None,
            active_server_url: None,
            cached_access_token: None,
        }
    }
}

pub struct SessionStateWrapper(pub Mutex<SessionStore>);

impl Default for SessionStateWrapper {
    fn default() -> Self {
        Self(Mutex::new(SessionStore::default()))
    }
}

// ============================================================================
// File Watcher State
// ============================================================================

/// File watcher state managed by Tauri
pub struct WatcherState(pub Mutex<Option<FileWatcher>>);

impl Default for WatcherState {
    fn default() -> Self {
        WatcherState(Mutex::new(None))
    }
}

// ============================================================================
// Sync Capabilities State
// ============================================================================

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SyncCapabilities {
    pub max_sync_file_size: u64,
}

impl Default for SyncCapabilities {
    fn default() -> Self {
        Self {
            // 默认无限制：纯本地模式和个人云端模式不应有附件大小限制。
            // 仅当团队同步完成后，由 negotiate response 中的 server_capabilities
            // 下发实际限额值覆盖此默认值。
            max_sync_file_size: u64::MAX,
        }
    }
}

/// 服务端下发的同步能力（缓存于客户端内存）
pub struct SyncCapabilitiesState(pub Mutex<SyncCapabilities>);

impl Default for SyncCapabilitiesState {
    fn default() -> Self {
        SyncCapabilitiesState(Mutex::new(SyncCapabilities::default()))
    }
}

// ============================================================================
// Transfer Scheduler State (Phase 6)
// ============================================================================

/// 后台传输调度器的 Notify 句柄，用于 enqueue 后主动唤醒 scheduler
pub struct TransferNotifyState(pub Arc<tokio::sync::Notify>);

impl Default for TransferNotifyState {
    fn default() -> Self {
        TransferNotifyState(Arc::new(tokio::sync::Notify::new()))
    }
}

// ============================================================================
// AI Service State
// ============================================================================

/// AI Service state managed by Tauri
pub struct AIStateWrapper {
    service: RwLock<AIService>,
    pub runtime: Arc<Runtime>,
    pub queue: std::sync::OnceLock<crate::core::ai::queue::AIQueueManager>,
}

use crate::core::ai::folder_config;

impl AIStateWrapper {
    /// Get read-only reference to AIService
    pub fn service(&self) -> std::sync::RwLockReadGuard<'_, AIService> {
        self.service.read().unwrap()
    }

    /// Get mutable reference to AIService (for rebuild)
    pub fn service_mut(&self) -> std::sync::RwLockWriteGuard<'_, AIService> {
        self.service.write().unwrap()
    }

    /// Build an AIService clone that respects folder-level provider/model overrides.
    ///
    /// Resolves `.slash-folder.yml` for the given note path and returns a service
    /// configured with the effective provider/model. If no override applies,
    /// returns a clone of the global service unchanged.
    pub fn resolve_for_path(&self, vault_path: &Path, note_relative: &str) -> AIService {
        let global = self.service();
        let effective =
            folder_config::resolve_config_for_path(vault_path, note_relative, global.config());
        // Only rebuild if there's an actual difference
        if effective.provider_type != global.config().provider_type
            || effective.online_model != global.config().online_model
            || effective.generation_model != global.config().generation_model
        {
            log::debug!(
                "📂 [FolderOverride] {} → provider={}, model={}",
                note_relative,
                effective.provider_type,
                if effective.provider_type == "online" {
                    &effective.online_model
                } else {
                    &effective.generation_model
                }
            );
            let mut svc = global.clone();
            svc.rebuild(effective);
            svc
        } else {
            global.clone()
        }
    }
}

impl Default for AIStateWrapper {
    fn default() -> Self {
        let runtime = Runtime::new().expect("Failed to create Tokio runtime");
        AIStateWrapper {
            service: RwLock::new(AIService::new()),
            runtime: Arc::new(runtime),
            queue: std::sync::OnceLock::new(),
        }
    }
}
// ============================================================================
// Asset Index State
// ============================================================================

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

/// In-memory asset index: Hash -> RelativePath
#[derive(Default, Serialize, Deserialize)]
pub struct AssetIndex {
    /// Map of SHA-256 hash to relative asset path (e.g., "assets/image.png")
    pub entries: HashMap<String, String>,
    /// The vault path this index belongs to (for validation)
    #[serde(default)]
    pub vault_path: String,
}

/// Tauri managed state wrapper
pub struct AssetIndexState(pub Mutex<AssetIndex>);

impl AssetIndex {
    /// Get the index file path for a vault
    pub fn index_path(vault: &Path) -> PathBuf {
        vault.join(".slash").join("asset_index.json")
    }

    /// Load index from disk, or create empty if not exists
    pub fn load(vault_path: &Path) -> Self {
        let path = Self::index_path(vault_path);

        if path.exists() {
            match File::open(&path) {
                Ok(file) => {
                    let reader = BufReader::new(file);
                    match serde_json::from_reader(reader) {
                        Ok(mut index) => {
                            // Update vault path in case it changed
                            let index: &mut AssetIndex = &mut index;
                            index.vault_path = vault_path.to_string_lossy().to_string();
                            return std::mem::take(index);
                        }
                        Err(e) => {
                            log::error!("Failed to parse asset index, creating new: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::error!("Failed to open asset index, creating new: {}", e);
                }
            }
        }

        AssetIndex {
            entries: HashMap::new(),
            vault_path: vault_path.to_string_lossy().to_string(),
        }
    }

    /// Save index to disk
    pub fn save(&self, vault_path: &Path) -> Result<(), String> {
        let path = Self::index_path(vault_path);

        // Ensure .slash directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .slash dir: {}", e))?;
        }

        let file =
            File::create(&path).map_err(|e| format!("Failed to create index file: {}", e))?;
        serde_json::to_writer_pretty(file, self)
            .map_err(|e| format!("Failed to write index: {}", e))?;

        Ok(())
    }

    /// Check if a hash exists and the file is still on disk
    /// If the indexed path is stale (file deleted/moved), scans assets/ for the same content
    pub fn lookup(&mut self, hash: &str, vault_path: &Path) -> Option<String> {
        let hash_short = if hash.len() >= 16 { &hash[..16] } else { hash };

        if let Some(relative_path) = self.entries.get(hash) {
            let full_path = vault_path.join(relative_path);
            if full_path.exists() {
                log::info!(
                    "🔍 [AssetIndex::lookup] HIT: hash={} → {} (file exists ✅)",
                    hash_short, relative_path
                );
                return Some(relative_path.clone());
            }
            log::info!(
                "🔍 [AssetIndex::lookup] STALE: hash={} → {} (file NOT on disk, will scan)",
                hash_short, relative_path
            );
        } else {
            log::info!(
                "🔍 [AssetIndex::lookup] MISS: hash={} not in index ({} entries), will scan",
                hash_short, self.entries.len()
            );
        }

        // 扫描 assets/ 目录，寻找 hash 匹配的已有文件
        let assets_dir = vault_path.join("assets");
        if assets_dir.exists() {
            let mut scanned = 0u32;
            if let Ok(entries) = fs::read_dir(&assets_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        scanned += 1;
                        if let Ok(file_hash) = compute_file_hash_streaming(&path) {
                            if file_hash == hash {
                                let relative = format!(
                                    "assets/{}",
                                    path.file_name().unwrap().to_string_lossy()
                                );
                                // 自动修复索引
                                self.entries.insert(hash.to_string(), relative.clone());
                                log::info!(
                                    "🔧 [AssetIndex::lookup] SELF-HEALED: hash={} → {} (scanned {} files)",
                                    hash_short, relative, scanned
                                );
                                return Some(relative);
                            }
                        }
                    }
                }
            }
            log::info!(
                "🔍 [AssetIndex::lookup] SCAN COMPLETE: no match for hash={} (scanned {} files in assets/)",
                hash_short, scanned
            );
        } else {
            log::info!("🔍 [AssetIndex::lookup] assets/ dir does not exist");
        }

        // 确实没有相同内容的文件，清除过期条目
        self.entries.remove(hash);
        None
    }

    /// Add a new entry to the index
    pub fn insert(&mut self, hash: String, relative_path: String) {
        self.entries.insert(hash, relative_path);
    }

    /// Remove an entry by hash
    pub fn remove(&mut self, hash: &str) {
        self.entries.remove(hash);
    }

    /// Rebuild index from disk by scanning all files in assets/
    pub fn rebuild(vault_path: &Path) -> Self {
        let assets_dir = vault_path.join("assets");
        let mut index = AssetIndex {
            entries: HashMap::new(),
            vault_path: vault_path.to_string_lossy().to_string(),
        };

        if !assets_dir.exists() {
            return index;
        }

        // Walk the assets directory
        if let Ok(entries) = fs::read_dir(&assets_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    // Compute hash
                    if let Ok(hash) = compute_file_hash_streaming(&path) {
                        let relative =
                            format!("assets/{}", path.file_name().unwrap().to_string_lossy());
                        index.entries.insert(hash, relative);
                    }
                }
            }
        }

        log::debug!(
            "📊 [AssetIndex] Rebuilt index with {} entries",
            index.entries.len()
        );
        index
    }
}

// ============================================================================
// Hash Computation - Streaming for Large Files
// ============================================================================

/// Compute SHA-256 hash of in-memory data (for incoming files)
pub fn compute_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// Compute SHA-256 hash of a file using streaming (for large files on disk)
pub fn compute_file_hash_streaming(path: &Path) -> Result<String, std::io::Error> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file); // 1MB buffer
    let mut hasher = Sha256::new();

    let mut buffer = [0u8; 1024 * 64]; // 64KB chunks
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

// ============================================================================
// Syncing State (preventing Watcher cascade deletion during sync)
// ============================================================================

/// Whether the system is currently syncing notes.
/// Used to prevent the FileWatcher from processing file events (like deleting notes or AI cache)
/// during syncing operations, which could trigger a race condition (deleting notes which are being renamed/pulled).
pub struct SyncingState(pub std::sync::atomic::AtomicBool);

impl Default for SyncingState {
    fn default() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }
}

// ============================================================================
// Refactoring State (preventing Watcher cascade deletion during manual rename/move)
// ============================================================================

/// Tracks paths currently undergoing refactoring (rename, move) to ignore Watcher events.
pub struct RefactoringState(pub std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>);

impl Default for RefactoringState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(std::collections::HashSet::new()))
    }
}

