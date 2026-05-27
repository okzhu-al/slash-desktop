//! Sync Commands — Desktop ↔ Server 同步
//!
//! 实现 Slash Sync Protocol 的客户端侧逻辑：
//! 1. 扫描本地 vault 生成 Merkle hash
//! 2. 与 Server 协商差异
//! 3. 推送/拉取变更文件
//!
//! 模块结构：
//! - client: HTTP 客户端封装（negotiate/push/pull/health/scope）
//! - state: 同步状态持久化（sync_state.json / team_sync_*.json）
//! - path_mapping: 路径映射管理（TeamPathMappingsFile / PARA 反向映射）
//! - helpers: 工具函数（Merkle hash / 文件收集）
//! - personal: 个人空间同步（sync_vault）
//! - promote: Promote to Team（push_directory_to_vault）
//! - team: 团队空间同步（sync_team_full / check_sync_connection）

pub mod client;
pub mod helpers;
pub mod path_mapping;
pub mod personal;
pub mod promote;
pub mod state;
pub mod team;

// Tauri 的 #[tauri::command] 宏会在命令函数旁生成 __cmd__* 隐藏符号，
// 因此 lib.rs 必须使用完全限定路径（如 sync::personal::sync_vault）
// 而非 pub use re-export。
