//! # Repository Module
//!
//! 数据访问层 — 按领域拆分为独立子模块，通过此 mod.rs 统一重导出，
//! 保持外部 `repository::*` 调用路径零变更。
//!
//! ## 子模块
//! - `notes`     — Note CRUD + WikiLink rename
//! - `links`     — Link CRUD + backlinks
//! - `graph`     — 知识图谱（Local/Global Graph）
//! - `scanner`   — Markdown 扫描、frontmatter 解析、链接提取
//! - `embedding` — Embedding V1 (legacy)
//! - `ai_state`  — AI Skill 配置/状态、分类缓存、建议缓存、Ghost Link 黑名单、Tag RAG
//! - `feedback`  — AI 反馈日志
//! - `tasks`     — Task CRUD + 过滤器
//! - `folders`   — 文件夹 embedding + 统计
//! - `frontmatter` — YAML frontmatter 统一写入

pub mod ai_state;
pub mod embedding;
pub mod feedback;
pub mod folders;
#[allow(dead_code)]
pub mod frontmatter;
pub mod graph;
pub mod links;
pub mod notes;
pub mod scanner;
pub mod tasks;
pub mod usage;

// ============================================================================
// Shared utility: normalize_path
// ============================================================================

/// Normalize path to use forward slashes consistently
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

// ============================================================================
// Re-exports — 保持 `repository::function_name` 调用路径不变
// ============================================================================

// --- notes ---
#[allow(unused_imports)]
pub use notes::{
    check_note_exists_by_name, delete_note, get_all_notes, get_dirty_notes,
    get_note_preview_by_name, rename_note_in_db, update_wikilinks_on_rename, upsert_note,
    NotePreview,
};

// --- links ---
#[allow(unused_imports)]
pub use links::{
    delete_links_for_source, get_all_links, get_links_from, get_links_to,
    get_note_backlinks_by_section, insert_link, insert_links, BacklinkInfo,
};

// --- graph ---
#[allow(unused_imports)]
pub use graph::{get_global_graph, get_note_graph, GraphEdge, GraphNode, NoteGraph};

// --- scanner ---
#[allow(unused_imports)]
pub use scanner::{extract_links, parse_frontmatter, scan_and_upsert, scan_file};

// --- embedding ---
#[allow(unused_imports)]
pub use embedding::{get_embedding, upsert_embedding};

// --- ai_state ---
#[allow(unused_imports)]
pub use ai_state::{
    accept_ai_summary, accept_ai_tag, add_ghost_link_blacklist, delete_classification_cache,
    delete_skill_states_for_note, get_blacklisted_targets, get_cached_suggestion,
    get_classification_cache, get_existing_tags_with_frequency, get_last_char_count,
    get_skill_state, get_skill_state_for_delta, get_skill_states_for_note,
    invalidate_suggestion_cache, is_ghost_link_blacklisted, load_skill_config, load_skill_configs,
    reject_ai_tag, save_classification_cache, should_skill_run, update_tag_dictionary,
    upsert_skill_config, upsert_skill_state, upsert_suggestion_cache, SkillConfigRow, SkillState,
};

// --- feedback ---
#[allow(unused_imports)]
pub use feedback::{get_recent_tag_corrections, insert_ai_feedback, log_tag_correction};

// --- tasks ---
#[allow(unused_imports)]
pub use tasks::{
    delete_tasks_for_note, get_all_tasks, get_task_by_id, get_tasks_by_filter, get_tasks_for_note,
    insert_tasks, note_has_pending_tasks, update_task_completion, TaskFilter,
};

// --- folders ---
#[allow(unused_imports)]
pub use folders::{
    get_all_folder_embeddings, get_all_folders, get_dirty_folders, get_folder_stats,
    mark_folder_dirty, upsert_folder_embedding, FolderEmbedding,
};

// --- usage ---
#[allow(unused_imports)]
pub use usage::{generate_session_id, get_ai_usage_logs, log_ai_usage, UsageLogEntry};
