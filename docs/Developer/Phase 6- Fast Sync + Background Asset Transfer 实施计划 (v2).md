# Phase 6: Fast Sync + Background Asset Transfer 实施计划 (v2)

## 项目概述

将 Slash 同步管线从「一体化 JSON Push/Pull」架构重构为「快慢双轨」架构：

- **Fast Sync（快车道）**：仅传输结构化业务事实（Markdown、目录状态、资产声明元数据），**严格拒绝二进制大对象**
- **Background Asset Transfer（慢车道）**：CAS 内容寻址的异步分块传输，支持断点续传、会话管理、权限校验

**核心目标**：1GB 视频上传不阻塞 1KB Markdown 的秒级同步。

---

## 设计决策（已确认）

| 决策点 | 结论 |
|:---|:---|
| **Chunk 大小** | 默认 **4MB** |
| **Session 过期** | **24 小时** |
| **小图标走慢车道？** | **是**，所有资产一律走慢车道，不开特例 |
| **旧版兼容** | 测试期间无需考虑旧版迁移 |
| **资产路由权威源** | `file_assets` 表为权威判据，`assets/` 路径仅作防御性兜底 |
| **状态枚举** | 服务端/客户端分离：`ServerAssetState` + `LocalTransferState` |
| **FileStorage trait** | 必须新增 `get_range()` + `size()` 方法，禁止全量读 |
| **Commit 流程** | 流式拼接直写磁盘/S3 Multipart，禁止全量加载到内存 |

---

## Proposed Changes

### Step 1: Protocol & Schema

#### [MODIFY] `packages/slash-sync-proto/src/lib.rs`

新增类型（约 +100 行）：

```rust
/// 服务端资产 Blob 状态（与客户端本地传输状态严格分离）
pub enum ServerAssetState {
    Declared,   // Fast Sync 已声明，但服务端还没有 blob
    Uploading,  // 有 active upload session
    Available,  // CAS blob 已存在，可下载
    Failed,     // 最近一次上传失败或校验失败
    Missing,    // 声明存在，但源端报告本地源文件不存在
}

/// 资产清单条目（Negotiate 响应中下发）
pub struct AssetManifestEntry {
    pub asset_id: String,
    pub hash: String,
    pub owner_file_id: String,
    pub owner_path: String,
    pub kind: String,
    pub original_name: Option<String>,
    pub size: u64,
    pub state: ServerAssetState,
}

/// 分块上传请求/响应
pub struct UploadInitRequest {
    pub vault_id: String,
    pub asset_id: String,
    pub hash: String,
    pub owner_file_id: String,
    pub size: u64,
    pub kind: String,
    pub original_name: Option<String>,
}
pub struct UploadInitResponse { pub upload_id: String, pub already_exists: bool }
pub struct UploadStatusResponse { ... }
pub struct UploadCommitResponse { ... }
pub struct AssetDownloadInfo { ... }
```

`SyncNegotiateResponse` 新增 `asset_manifest: Option<Vec<AssetManifestEntry>>`。

客户端本地传输状态（sync-proto 或 desktop crate）：

```rust
pub enum LocalTransferState {
    Pending,    // 已入队，等待处理
    Active,     // 正在传输中
    Paused,     // 用户手动暂停
    Completed,  // 传输完成
    Failed,     // 传输失败
}
```

---

#### [NEW] `apps/server/migrations/019_sync_uploads.sql`

```sql
CREATE TABLE IF NOT EXISTS sync_uploads (
    upload_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id       UUID NOT NULL,
    user_id        UUID NOT NULL,
    asset_id       TEXT NOT NULL,
    owner_file_id  UUID NOT NULL,
    hash           TEXT NOT NULL,
    expected_size  BIGINT NOT NULL,
    received_size  BIGINT NOT NULL DEFAULT 0,
    chunk_count    INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'active',
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    committed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_upload_chunks (
    upload_id   UUID NOT NULL REFERENCES sync_uploads(upload_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    start_byte  BIGINT NOT NULL,
    end_byte    BIGINT NOT NULL,
    size        BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_su_vault_hash ON sync_uploads(vault_id, hash);
CREATE INDEX IF NOT EXISTS idx_su_owner_file ON sync_uploads(vault_id, owner_file_id);
CREATE INDEX IF NOT EXISTS idx_su_status ON sync_uploads(status);
CREATE INDEX IF NOT EXISTS idx_su_expires ON sync_uploads(expires_at) WHERE status = 'active';
```

---

#### [MODIFY] `apps/desktop/src-tauri/src/core/db/migrations.rs`

V34: `transfer_queue` 表，使用 `LocalTransferState` 枚举值。

---

### Step 2: Fast Track Hardening

#### [MODIFY] `push.rs`

- 资产判定逻辑：**首先查 `file_assets` 表确认该路径是否为已声明的资产**，`assets/` 路径作为防御性兜底
- 对已声明资产：仅 upsert `file_states` 元数据，**不调用 `storage.put()`**，Blob 由慢车道填充
- 对非资产文件：保持现有全量逻辑不变

#### [MODIFY] `pull.rs`

- 对已声明资产：仅返回 manifest（不含 content），客户端通过慢车道下载

#### [MODIFY] `negotiate.rs`

- 新增 `asset_manifest` 字段，查询 `file_assets` + `storage.exists()` 构建清单

---

### Step 3: Slow Track Server API

#### [MODIFY] `storage.rs` — FileStorage trait 扩展

```rust
async fn get_range(&self, vault_id: &str, path: &str, start: u64, end: u64) -> Result<Vec<u8>, StorageError>;
async fn size(&self, vault_id: &str, path: &str) -> Result<u64, StorageError>;
async fn put_stream(&self, vault_id: &str, path: &str, chunks_dir: &Path) -> Result<(), StorageError>;
```

- `get_range`: LocalFileStorage 用 `seek + read`；S3 用 `Range` header
- `size`: LocalFileStorage 用 `fs::metadata`；S3 用 `head_object`
- `put_stream`: 从 chunk 临时目录流式拼接到最终路径，不加载到内存

#### [NEW] `assets_transfer.rs`

6 个 Endpoint（init/status/chunk/commit/head/download），commit 使用 `put_stream` 流式拼接。

---

### Step 4: Tauri Transfer Manager

#### [NEW] `transfer_manager.rs`

Rust 后台线程 + SQLite Queue，并发 2 文件，单文件串行 chunk，4MB/chunk。

---

### Step 5: Frontend UI

- `TransferManagerPanel.tsx` — Sidebar 进度面板
- `ImageComponent.tsx` / `VideoComponent.tsx` — 资产占位符

---

## Verification Plan

1. `cargo check` 全栈零错误
2. 虚假 SHA-256 commit → 400
3. 未声明 hash 上传 → 403
4. 断点续传恢复
5. 大文件传输期间 Markdown 秒级同步
