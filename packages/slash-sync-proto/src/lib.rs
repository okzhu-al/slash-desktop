use serde::{Deserialize, Serialize};

// ============================================================
// Slash Sync Protocol — 端云共享数据合约
// 此 crate 由 Desktop (Tauri) 和 Server (Axum) 共同依赖，
// 定义了同步协商、文件传输和状态追踪的所有数据结构。
// ============================================================

/// 文件级元信息 — 同步传输的最小单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileManifest {
    /// 相对于 vault 根目录的路径，如 "02_Areas/Logic/Aristotle.md"
    pub relative_path: String,
    /// 内容 SHA-256 前 16 位 (复用 slash_core::calculate_content_hash)
    pub content_hash: String,
    /// 文件大小 (bytes)
    pub size: u64,
    /// 文件修改时间 (Unix timestamp)
    pub mtime: i64,
    /// Lamport 逻辑时钟，每次本地修改递增
    pub logical_clock: u64,
    /// 文件稳定身份 UUID（来自 YAML frontmatter 的 slash_id）
    /// 如果文件无 slash_id（外部编辑器创建）则为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    /// 文件当前所属团队目录身份。Personal 同步或旧服务端可为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_id: Option<String>,
    /// 文件 Editor 的展示名。仅 Server -> Desktop pull 需要；用于本地同名文件避让。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_display_name: Option<String>,
    /// 最近推送者展示名。用于 editor_display_name 缺失时的本地避让 fallback。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pushed_by_display_name: Option<String>,
    /// 用户开始编辑此文件的时间（Unix timestamp, seconds）
    /// 客户端记录编辑生命周期开始时间，服务端保存为历史版本的 session_started_at
    /// None = 未知，服务端使用 push 到达时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_started_at: Option<i64>,
    /// 本次编辑生命周期的稳定标识。
    /// 服务端按 edit_session_id 合并历史版本；缺失时视为新历史版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_session_id: Option<String>,
    /// 是否为用户的真实编辑（True = 编辑器键盘输入，False = 后台脚本/自动化修改）
    /// 用于远端合并防线：禁止空内容且为 false 的请求覆盖掉合法的用户内容
    #[serde(default)]
    pub is_user_edit: bool,
    /// 内容闭包 — 此笔记显式声明的全部附件资源引用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<AssetRef>>,
}

/// 多媒体资源引用 — 内容闭包的最小资产单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetRef {
    /// 服务端核心信任根（现阶段等于 content_hash）
    pub asset_id: String,
    /// 仅用作定位/兼容字段
    pub relative_path: String,
    /// 仅 Metadata，非安全基准 (e.g. "image/png", "video/mp4")
    pub kind: String,
    /// 分组标识（如 Tldraw sidecar 的两个文件归属同一 group）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

/// 目录级 Merkle Hash — 用于快速差异检测
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectoryHash {
    /// 目录的相对路径，如 "02_Areas/Logic/"
    pub path: String,
    /// 子文件 content_hash 排序后的聚合 hash
    pub merkle_hash: String,
    /// 该目录下的文件数量
    pub file_count: u32,
}

/// 空间类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SpaceType {
    /// 个人空间 — 绝对私有，离线自治
    Personal,
    /// 团队空间 — 云端受控 (携带 team_id)
    Team(String),
}

// ============================================================
// 同步协商 (Sync Negotiation)
// ============================================================

/// 同步协商请求 (Client → Server)
///
/// 客户端发送本地各目录的 Merkle Hash，服务器对比后返回差异。
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncNegotiateRequest {
    /// 远程 vault 标识
    pub vault_id: String,
    /// 空间类型
    pub space_type: SpaceType,
    /// 各目录的 Merkle Hash 列表
    pub directory_hashes: Vec<DirectoryHash>,
    /// 客户端当前逻辑时钟
    pub client_clock: u64,
    /// 客户端各文件的 path → hash 映射（用于文件级对比）
    #[serde(default)]
    pub client_files: Vec<NegotiateFileEntry>,
    /// 客户端已删除的文件路径列表（存在于 sync_state 但本地已不存在）
    #[serde(default)]
    pub deleted_paths: Vec<String>,
    /// UUID-First 删除声明。兼容 deleted_paths，但服务端应优先使用 file_id 定位权威路径。
    #[serde(default)]
    pub deleted_files: Vec<DeletedFile>,
}

/// 协商用文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NegotiateFileEntry {
    /// 相对路径（可变位置属性）
    pub path: String,
    /// 当前 content_hash
    pub hash: String,
    /// 上次同步时的 hash（本次编辑的起点版本）
    #[serde(default)]
    pub base_hash: String,
    /// UUID-First: 文件身份（优先于 path 做匹配）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

/// 被服务端标记为删除的文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

/// 身份冲突 — 路径相同但 file_id 不一致
///
/// 服务端拒绝接收但 **不要求客户端删除本地文件**。
/// 客户端应保留本地文件，记录冲突日志，等待下次同步或用户手动处理。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityConflict {
    pub path: String,
    /// 客户端发送的 file_id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_file_id: Option<String>,
    /// 服务端记录的 file_id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_file_id: Option<String>,
    /// 冲突原因描述
    pub reason: String,
}

/// 服务端能力声明（随 Negotiate 响应下发）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    /// 单文件同步体积上限（字节）
    pub max_sync_file_size: u64,
}

/// 同步协商响应 (Server → Client)
///
/// 告知客户端需要推送和拉取的文件列表。
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncNegotiateResponse {
    /// 服务器当前逻辑时钟
    pub server_clock: u64,
    /// 客户端需要从服务器拉取的文件路径
    pub client_needs: Vec<String>,
    /// 服务器需要客户端推送的文件路径
    pub server_needs: Vec<String>,
    /// 服务器已经删除（软删），要求客户端在本地物理抹去的文件路径与 UUID
    #[serde(default)]
    pub server_deleted: Vec<DeletedFile>,
    /// 双方均有修改的冲突文件
    pub conflicts: Vec<ConflictInfo>,
    /// 团队空间是否正在维护（Admin 整理目录中），仅 Team 空间有效
    #[serde(default)]
    pub is_maintenance: bool,
    /// 维护模式开启时间（Unix 秒）。非 Admin 客户端用此计算剩余倒计时
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance_started_at: Option<i64>,
    /// 服务端下发的能力声明
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_capabilities: Option<ServerCapabilities>,
    /// [Phase 6] 资产清单 — 服务端已知的全部资产及其 Blob 状态
    /// 客户端据此决定哪些资产需要上传/下载
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_manifest: Option<Vec<AssetManifestEntry>>,
    /// 身份冲突 — 路径相同但 file_id 不一致
    /// 客户端应保留本地文件，不执行删除
    #[serde(default)]
    pub identity_conflicts: Vec<IdentityConflict>,
}

/// 冲突信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictInfo {
    /// 冲突文件的相对路径
    pub path: String,
    /// 客户端内容 hash
    pub client_hash: String,
    /// 服务器内容 hash
    pub server_hash: String,
    /// 客户端逻辑时钟
    pub client_clock: u64,
    /// 服务器逻辑时钟
    pub server_clock: u64,
}

// ============================================================
// 文件传输 (File Transfer)
// ============================================================

/// 文件推送载荷 (单文件，Client → Server)
#[derive(Debug, Serialize, Deserialize)]
pub struct FilePushPayload {
    /// 文件元信息
    pub manifest: FileManifest,
    /// 文件二进制内容
    pub content: Vec<u8>,
}

/// 批量推送请求
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPushRequest {
    pub vault_id: String,
    pub files: Vec<FilePushPayload>,
}

/// 推送响应
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPushResponse {
    /// 成功接收的文件路径
    pub accepted: Vec<String>,
    /// 被拒绝的文件路径及原因
    pub rejected: Vec<RejectedFile>,
    /// 服务器更新后的逻辑时钟
    pub server_clock: u64,
    /// Server 端修改内容后（如 contributor 注入）的最终 hash 映射
    /// Key: file path, Value: server 存储的 final hash
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub accepted_hashes: std::collections::HashMap<String, String>,
}

/// 被拒绝的文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectedFile {
    pub path: String,
    pub reason: String,
}

/// 批量拉取请求 (Client → Server)
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPullRequest {
    pub vault_id: String,
    /// 需要拉取的文件路径列表
    pub paths: Vec<String>,
}

/// 批量拉取响应 (Server → Client)
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPullResponse {
    pub files: Vec<FilePushPayload>,
    pub server_clock: u64,
}

// ============================================================
// 同步状态 (Sync Status)
// ============================================================

/// 同步状态 — 用于前端 UI 展示
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SyncStatus {
    /// 空闲，无同步活动
    Idle,
    /// 正在与服务器协商差异
    Negotiating,
    /// 正在同步中
    Syncing { progress: f32 },
    /// 存在冲突需要用户处理
    Conflict { paths: Vec<String> },
    /// 同步出错
    Error(String),
    /// 未连接服务器 / 离线
    Offline,
}

/// 同步结果 — IPC 命令返回值
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncResult {
    pub status: SyncStatus,
    pub files_pushed: u32,
    pub files_pulled: u32,
    pub conflicts: Vec<ConflictInfo>,
    /// 服务端已删除、客户端已在本地移除的文件路径与 UUID
    #[serde(default)]
    pub server_deleted: Vec<DeletedFile>,
    /// Pull 时因编辑中而跳过的文件路径
    #[serde(default)]
    pub skipped_pulls: Vec<String>,
    /// 团队同步 Pull 下来的本地相对路径列表（含 task scan 路径，不可用于冷却判断）
    #[serde(default)]
    pub pulled_paths: Vec<String>,
    /// 真正从服务端写盘到本地的文件路径（仅实际 pull，用于 watcher 冷却过滤）
    #[serde(default)]
    pub actually_pulled_paths: Vec<String>,
    /// 团队空间是否正在维护
    #[serde(default)]
    pub is_maintenance: bool,
    /// 维护模式开启时间（Unix 秒）。非 Admin 客户端用此计算剩余倒计时
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance_started_at: Option<i64>,
}

// ============================================================
// 离线队列 (Offline Queue)
// ============================================================

/// 离线操作类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum QueuedOperation {
    Create,
    Update,
    Delete,
}

/// 离线操作记录 — 断网时本地缓存，恢复后批量推送
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedChange {
    pub operation: QueuedOperation,
    pub relative_path: String,
    pub content_hash: Option<String>,
    pub timestamp: i64,
}

// ============================================================
// 鉴权 (Auth)
// ============================================================

/// 连接请求（登录或注册）
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthRequest {
    pub username: String,
    pub password: String,
    /// 首次注册时必填，登录时可省略
    pub invite_code: Option<String>,
}

/// 鉴权响应
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_at: i64,
    pub user: UserProfile,
}

/// 用户信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
}

// ============================================================
// Team RBAC (Phase 3 Step 1)
// ============================================================

/// 团队全局角色
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TeamRole {
    /// 团队管理员 — 全局管理权限
    Admin,
    /// 观察者 — 默认入团身份，零残留只读
    Observer,
}

/// 目录级角色
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DirectoryRole {
    /// 目录所有者 — 管理 Team-members、控制可见性
    Owner,
    /// 团队成员 — 接收文件变更、可创建子目录
    TeamMember,
}

/// 综合判定后的生效角色
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EffectiveRole {
    Admin,
    Owner,
    TeamMember,
    Observer,
}

/// 操作类型 — 权限校验的目标动作
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TeamAction {
    /// 推送文件到 Team Vault
    Push,
    /// 拉取 Team Vault 文件
    Pull,
    /// 管理团队成员（增删、角色变更）
    ManageMembers,
    /// 管理目录权限（绑定 Owner / Team-members）
    ManageDirectory,
    /// 移动团队空间内的目录/文件
    MoveContent,
}

/// 创建 Team Vault 请求
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamCreateRequest {
    /// 团队名称
    pub name: String,
    /// Lemon Squeezy License Key（待后期集成，当前可省略）
    #[serde(default)]
    pub license_key: Option<String>,
    /// 管理员用户名
    pub username: String,
    /// 管理员密码
    pub password: String,
    /// 管理员昵称
    pub display_name: String,
    /// 服务器配对码（直接验证，无需先 pair 获取 JWT）
    #[serde(default)]
    pub access_code: Option<String>,
}

/// 创建 Team Vault 响应
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamCreateResponse {
    pub vault_id: String,
    pub name: String,
    /// 管理员用户的 JWT
    pub access_token: String,
    /// 用于自动续期的 refresh token
    pub refresh_token: String,
    /// 管理员 user_id
    pub user_id: String,
}

/// 生成邀请码请求
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamInviteRequest {
    pub vault_id: String,
    /// 邀请码过期时间（小时），默认 72h
    #[serde(default = "default_invite_hours")]
    pub expires_in_hours: u32,
}

fn default_invite_hours() -> u32 {
    72
}

/// 生成邀请码响应
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamInviteResponse {
    pub code: String,
    pub expires_at: Option<i64>,
}

/// 团队成员信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMemberInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub global_role: TeamRole,
    pub joined_at: i64,
}

/// 成员列表响应
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamMembersResponse {
    pub vault_id: String,
    pub members: Vec<TeamMemberInfo>,
}

/// 变更全局角色请求
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateMemberRoleRequest {
    pub vault_id: String,
    pub target_user_id: String,
    pub new_role: TeamRole,
}

/// 目录权限信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryPermissionInfo {
    #[serde(default)]
    pub directory_id: Option<String>,
    pub directory_path: String,
    #[serde(default)]
    pub inherited: bool,
    #[serde(default)]
    pub source_directory_path: Option<String>,
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub dir_role: DirectoryRole,
    pub observer_visible: bool,
}

/// 查询目录权限请求
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryPermissionsQuery {
    pub vault_id: String,
    #[serde(default)]
    pub directory_id: Option<String>,
    #[serde(default)]
    pub directory_path: String,
}

/// 设置目录权限请求
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateDirectoryPermissionsRequest {
    pub vault_id: String,
    #[serde(default)]
    pub directory_id: Option<String>,
    #[serde(default)]
    pub directory_path: String,
    pub user_id: String,
    pub dir_role: DirectoryRole,
    pub observer_visible: Option<bool>,
}

/// 宪法目录名（禁止 Promote 为团队目录）
pub const CONSTITUTIONAL_DIRS: &[&str] = &[
    "00_Inbox",
    "01_Projects",
    "02_Areas",
    "03_Resource",
    "04_Archive",
];

/// Team 空间合法 PARA 目录名（必须全大写）
pub const TEAM_PARA_DIRS: &[&str] = &["01_PROJECTS", "02_AREAS", "03_RESOURCE", "04_ARCHIVE"];

/// 目录文件/子目录信息（含元数据）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryFileInfo {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: i64,
    pub editor_username: Option<String>,
    pub editor_display_name: Option<String>,
    pub pushed_by_username: Option<String>,
    pub pushed_at: Option<i64>, // Unix timestamp millis
}

/// 查询目录文件列表请求
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryFilesQuery {
    pub vault_id: String,
    #[serde(default)]
    pub directory_id: Option<String>,
    #[serde(default)]
    pub directory_path: String,
}

/// 删除目录权限请求
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveDirectoryPermissionRequest {
    pub vault_id: String,
    #[serde(default)]
    pub directory_id: Option<String>,
    #[serde(default)]
    pub directory_path: String,
    pub user_id: String,
}

/// 团队目录重命名请求
#[derive(Debug, Serialize, Deserialize)]
pub struct RenameDirectoryRequest {
    pub vault_id: String,
    #[serde(default)]
    pub directory_id: Option<String>,
    #[serde(default)]
    pub destination_directory_id: Option<String>,
    /// 旧目录前缀，如 "01_PROJECTS/P-3"
    #[serde(default)]
    pub old_prefix: String,
    /// 新目录前缀，如 "01_PROJECTS/P-3改"
    pub new_prefix: String,
}

// ============================================================
// Diff 协议 (Phase 3 Step 2)
// ============================================================

/// Diff 操作标签
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DiffTag {
    Insert,
    Delete,
    Equal,
}

/// 行范围（0-indexed）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

/// 单个 Diff 操作
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffOpProto {
    pub tag: DiffTag,
    pub old_range: Option<LineRange>,
    pub new_range: Option<LineRange>,
    pub content: String,
}

/// Diff 请求
#[derive(Debug, Serialize, Deserialize)]
pub struct DiffRequest {
    pub vault_id: String,
    pub path: String,
    /// 客户端的文件内容
    pub client_content: String,
}

/// Diff 响应
#[derive(Debug, Serialize, Deserialize)]
pub struct DiffResponse {
    pub ops: Vec<DiffOpProto>,
    pub server_hash: String,
}

// ============================================================
// Phase 6: Background Asset Transfer Protocol
// ============================================================

/// 服务端资产 Blob 状态
///
/// 描述服务端 CAS 存储中某个资产 hash 的当前生命周期阶段。
/// 与客户端本地传输队列状态 (`LocalTransferState`) 严格分离。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ServerAssetState {
    /// Fast Sync 已声明，但服务端还没有 blob
    Declared,
    /// 有 active upload session 正在进行
    Uploading,
    /// CAS blob 已存在，可下载
    Available,
    /// 最近一次上传失败或校验失败
    Failed,
    /// 声明存在，但源端报告本地源文件不存在
    Missing,
}

/// 客户端本地传输队列状态
///
/// 管理 SQLite `transfer_queue` 表中每个任务的生命周期。
/// 与服务端 `ServerAssetState` 无耦合。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LocalTransferState {
    /// 已入队，等待处理
    Pending,
    /// 正在传输中
    Active,
    /// 用户手动暂停
    Paused,
    /// 传输完成
    Completed,
    /// 传输失败
    Failed,
}

/// 资产清单条目 — Negotiate 响应中下发的单个资产状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetManifestEntry {
    /// 业务逻辑 ID (Markdown 中引用的 ID)
    pub asset_id: String,
    /// 物理 CAS Blob Hash
    pub hash: String,
    /// 声明该资产归属的笔记 UUID
    pub owner_file_id: String,
    /// 声明该资产的笔记相对路径
    pub owner_path: String,
    /// MIME 或资产大类 (例如: "image", "video")
    pub kind: String,
    /// 原始文件名（可选，用于 UI 展示）
    pub original_name: Option<String>,
    /// 文件大小（字节）
    pub size: u64,
    /// 服务端 Blob 状态
    pub state: ServerAssetState,
}

/// 初始化分块上传请求
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadInitRequest {
    pub vault_id: String,
    /// 业务逻辑资产 ID
    pub asset_id: String,
    /// CAS 内容哈希
    pub hash: String,
    /// 声明该资产的笔记 UUID
    pub owner_file_id: String,
    /// 文件总大小（字节）
    pub size: u64,
    /// MIME 类型或资产大类
    pub kind: String,
    /// 原始文件名
    pub original_name: Option<String>,
}

/// 初始化分块上传响应
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadInitResponse {
    /// 上传会话 ID
    pub upload_id: String,
    /// 如果 Blob 已存在（去重命中），为 true
    pub already_exists: bool,
}

/// 查询上传会话状态响应
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadStatusResponse {
    pub upload_id: String,
    /// 已接收字节数
    pub received_bytes: u64,
    /// 预期总字节数
    pub expected_bytes: u64,
    /// 会话是否已过期
    pub expired: bool,
    /// 已接收的 chunk 索引列表
    pub received_chunks: Vec<u32>,
}

/// 上传提交响应
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadCommitResponse {
    pub success: bool,
    /// 校验通过的 hash
    pub hash: String,
    /// 失败原因（success=false 时有值）
    pub error: Option<String>,
}

/// 资产下载信息（HEAD 响应）
#[derive(Debug, Serialize, Deserialize)]
pub struct AssetDownloadInfo {
    pub hash: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 是否可下载（Blob 是否存在）
    pub ready: bool,
}

// ============================================================
// Task 属性级旁路同步 (Phase 3 Step 5)
// ============================================================

/// Task 旁路同步事件 — checkbox 状态变更绕过 PR 流程
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBypassEvent {
    pub vault_id: String,
    pub file_path: String,
    #[serde(default)]
    pub file_id: Option<String>,
    #[serde(default)]
    pub directory_id: Option<String>,
    /// 目标 checkbox 所在行号（0-indexed）
    pub line_number: usize,
    /// 该行内容的 hash（防行号偏移）
    pub line_content_hash: String,
    /// 目标状态
    pub checked: bool,
    /// 触发者 user_id
    pub toggled_by: String,
}

/// Task 旁路同步响应
#[derive(Debug, Serialize, Deserialize)]
pub struct TaskBypassResponse {
    pub success: bool,
    pub message: String,
    /// 更新后的文件 content_hash
    pub new_content_hash: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_manifest_serialization() {
        let manifest = FileManifest {
            relative_path: "02_Areas/Logic/Aristotle.md".to_string(),
            content_hash: "a1b2c3d4e5f67890".to_string(),
            size: 1024,
            mtime: 1709280000,
            logical_clock: 42,
            file_id: None,
            directory_id: None,
            editor_display_name: None,
            pushed_by_display_name: None,
            edit_started_at: None,
            edit_session_id: None,
            is_user_edit: false,
            assets: None,
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: FileManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, parsed);
    }

    #[test]
    fn sync_negotiate_roundtrip() {
        let req = SyncNegotiateRequest {
            vault_id: "vault-001".to_string(),
            space_type: SpaceType::Personal,
            directory_hashes: vec![DirectoryHash {
                path: "02_Areas/".to_string(),
                merkle_hash: "abcdef1234567890".to_string(),
                file_count: 5,
            }],
            client_clock: 100,
            client_files: vec![],
            deleted_paths: vec![],
            deleted_files: vec![],
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncNegotiateRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.vault_id, "vault-001");
        assert_eq!(parsed.client_clock, 100);
    }

    #[test]
    fn sync_status_variants() {
        let idle = SyncStatus::Idle;
        let syncing = SyncStatus::Syncing { progress: 0.75 };
        let conflict = SyncStatus::Conflict {
            paths: vec!["note.md".to_string()],
        };
        let offline = SyncStatus::Offline;

        // 确保所有变体均可序列化
        for status in &[idle, syncing, conflict, offline] {
            let json = serde_json::to_string(status).unwrap();
            assert!(!json.is_empty());
        }
    }

    #[test]
    fn auth_request_serialization() {
        let req = AuthRequest {
            username: "admin".to_string(),
            password: "secret".to_string(),
            invite_code: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("admin"));
    }

    #[test]
    fn server_asset_state_serialization() {
        let states = vec![
            ServerAssetState::Declared,
            ServerAssetState::Uploading,
            ServerAssetState::Available,
            ServerAssetState::Failed,
            ServerAssetState::Missing,
        ];
        for state in &states {
            let json = serde_json::to_string(state).unwrap();
            let parsed: ServerAssetState = serde_json::from_str(&json).unwrap();
            assert_eq!(*state, parsed);
        }
    }

    #[test]
    fn local_transfer_state_serialization() {
        let states = vec![
            LocalTransferState::Pending,
            LocalTransferState::Active,
            LocalTransferState::Paused,
            LocalTransferState::Completed,
            LocalTransferState::Failed,
        ];
        for state in &states {
            let json = serde_json::to_string(state).unwrap();
            let parsed: LocalTransferState = serde_json::from_str(&json).unwrap();
            assert_eq!(*state, parsed);
        }
    }

    #[test]
    fn asset_manifest_entry_roundtrip() {
        let entry = AssetManifestEntry {
            asset_id: "abc123".to_string(),
            hash: "deadbeef01234567".to_string(),
            owner_file_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            owner_path: "02_Areas/Note.md".to_string(),
            kind: "image".to_string(),
            original_name: Some("photo.png".to_string()),
            size: 1024000,
            state: ServerAssetState::Available,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let parsed: AssetManifestEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn upload_init_request_roundtrip() {
        let req = UploadInitRequest {
            vault_id: "vault-001".to_string(),
            asset_id: "abc123".to_string(),
            hash: "deadbeef01234567".to_string(),
            owner_file_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            size: 4194304,
            kind: "image/png".to_string(),
            original_name: Some("photo.png".to_string()),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: UploadInitRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.vault_id, "vault-001");
        assert_eq!(parsed.asset_id, "abc123");
        assert_eq!(parsed.owner_file_id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn negotiate_response_with_asset_manifest() {
        let resp = SyncNegotiateResponse {
            server_clock: 42,
            client_needs: vec![],
            server_needs: vec![],
            server_deleted: vec![],
            identity_conflicts: vec![],
            conflicts: vec![],
            is_maintenance: false,
            maintenance_started_at: None,
            server_capabilities: None,
            asset_manifest: Some(vec![AssetManifestEntry {
                asset_id: "hash123".to_string(),
                hash: "deadbeef".to_string(),
                owner_file_id: "file-uuid".to_string(),
                owner_path: "note.md".to_string(),
                kind: "image".to_string(),
                original_name: None,
                size: 1024,
                state: ServerAssetState::Declared,
            }]),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("asset_manifest"));
        assert!(json.contains("Declared"));
    }
}

// ============================================================
// Team Scope — 用于客户端查询自己在团队中有权限的目录
// ============================================================

/// 团队 Scope 中的一个目录条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamScopeDir {
    #[serde(default)]
    pub directory_id: Option<String>,
    pub directory_path: String, // 团队 vault 中的路径 e.g. "01_PROJECTS/NAS项目/"
    pub role: String,           // "owner" / "team_member"
    #[serde(default)]
    pub owner_display_name: Option<String>,
}

/// GET /api/team/my-scope 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamScopeResponse {
    pub vault_id: String,
    pub scope_dirs: Vec<TeamScopeDir>,
    pub is_full_scope: bool, // Admin = true, 拥有全量访问
    /// 团队 vault 中所有有独立 directory_permissions 的目录路径
    /// 用于客户端同步时实现目录级隔离（父映射不递归进独立子目录）
    #[serde(default)]
    pub managed_dirs: Vec<String>,
    /// `managed_dirs` 的 UUID-first 版本。旧客户端继续读取 `managed_dirs`。
    #[serde(default)]
    pub managed_scope_dirs: Vec<TeamScopeDir>,
}
