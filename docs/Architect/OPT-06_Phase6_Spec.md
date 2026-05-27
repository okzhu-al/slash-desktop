# Phase 6: Fast Sync + Background Asset Transfer 史诗级重构规约

## 1. 核心理念：数据声明与 Blob 填坑的分离 (Declaration vs. Blob Filling)
将同步管线彻底划分为“业务事实”与“二进制本体”两层，放弃“按文件大小分流”的思维，转为“按业务对象性质分流”。

- **Fast Sync（快同步）**：仅负责同步结构化事实（Markdown 笔记、目录状态、文件快照、资产依赖图与权限）。**严格拒绝任何二进制大对象传输**。在快同步中，客户端仅进行“资产声明”（即：Note X 引用了逻辑资产 ID Y，其物理实体为 Hash Z）。
- **Background Asset Transfer（后台资产传输）**：作为异步的 CAS（内容寻址存储）本体填坑机制。负责将 Hash 对应的二进制字节流通过分块断点续传的方式搬运。**Blob 传输严格依赖 Fast Sync 的事前声明**，任何未被声明的 Hash 将被服务端拒绝上传或下载。

**核心目标**：确保即便上传 1GB 的视频，也绝不能阻塞 1KB 的 Markdown 文本、OCR 结果或团队结构变更的“秒级同步”。

---

## 2. 协议层重构 (`packages/slash-sync-proto`)

> [!WARNING]
> **硬版本更新 (Hard Version Bump)**：本次重构对内测期 API 进行强破坏性变更，无须为旧版客户端提供向后兼容。

增强 `SyncNegotiateResponse` 结构，提供精准的资产传输状态与逻辑解耦。

```rust
pub struct AssetManifestEntry {
    pub asset_id: String,      // 业务逻辑 ID (Markdown 中引用的 ID)
    pub hash: String,          // 物理 CAS Blob Hash
    pub owner_file_id: String, // 声明该资产归属的笔记 UUID
    pub owner_path: String,    // 声明该资产的笔记相对路径
    pub kind: String,          // MIME 或资产大类 (例如: 'image', 'video')
    pub original_name: Option<String>,
    pub size: u64,
    pub state: TransferState,  // 状态枚举：Ready (已就绪), Uploading (上传中), Missing (缺失)
}
```

---

## 3. 服务端增强 (`apps/server`)

### 3.1 快车道保护边界 (`push.rs` / `pull.rs`)
- 严格校验 payload，拦截并拒绝一切体积过大或带有二进制特征的媒体载荷。
- 仅允许接收和同步 `AssetManifestEntry` 的元数据声明。

### 3.2 会话制分块上传 (`assets_transfer.rs`)
放弃直接使用 hash 作为上传句柄，采用 Ephemeral Session 机制：
- **`POST /sync/assets/init`**：初始化上传会话，返回 `upload_id`。
  - **安全守卫**：校验该 `hash` 是否已被用户通过 Fast Sync 声明，并且该用户对对应的 `owner_file_id` 和 `vault` 具有写权限。
- **`GET /sync/assets/uploads/:upload_id/status`**：获取分块上传会话的当前状态。
  - 若 `upload_id` 过期，客户端需重新执行 `init`，服务端依据 `hash` 自动合并（Reconcile）历史上传进度。
- **`PUT /sync/assets/chunk/:upload_id`**：按块上传字节流。
- **`POST /sync/assets/commit/:upload_id`**：完成并封卷。服务端**必须**执行五重校验：
  1. 所有字节块范围连贯无缺失。
  2. 累加总体积精确匹配声明的 `size`。
  3. payload 的整体 SHA-256 必须严格匹配声明的 `hash`。
  4. 该 Hash 的业务实体声明依然存在。
  5. 用户当前仍具有该 vault 的写权限。

### 3.3 安全的断点下载 (`assets_transfer.rs`)
- **`HEAD /sync/assets/download/:vault_id/:hash`**：获取大小与就绪状态。
- **`GET /sync/assets/download/:vault_id/:hash`**：使用 HTTP `Range` 进行下载。
  - **鉴权守卫**：下载鉴权绝惊能仅看 Hash。服务端必须通过 `vault_id` 和 `hash` 反查，**证明该用户当前至少拥有一篇包含此 Hash 声明笔记的读权限**，方可放行。

---

## 4. 客户端与 UI 整合 (`apps/desktop`)

### 4.1 持久化传输队列 (Persistent Transfer Manager)
- 必须使用 **SQLite 本地数据表** (`transfer_queue`) 作为后台队列，绝不能使用 JSON 文件，以确保原子性和防奔溃状态恢复。
- **并发控制**：默认并发数限制为 2 个文件。单个文件强制使用**串行 Chunk 分块**传输以简化重试逻辑。
- 队列需保障在应用程序退出或崩溃后，重新打开时能够自动凭借 `upload_id` 恢复（或凭借 Hash 重新协商）。

### 4.2 UI 占位符闭环 (Graceful Asset Placeholders)
当 Markdown 笔记已通过 Fast Sync 秒传到达，但其关联的资产 Blob 尚未下载完成（或另一端的发送者仍在上传中）时：
- 编辑器必须在原位置渲染**感知当前传输状态**的占位组件。
- 支持状态展示，例如：
  - *"等待发送者完成上传 (Waiting for sender...)"*
  - *"正在下载资源 (45%)..."*
  - *"网络错误，点击重试 (Network Error - Click to retry)"*
- 禁止渲染破裂的默认 <img> 占位图。

---

## 5. 测试与验收标准 (Verification Plan)

接手的 Agent 必须在实现后编写或通过以下测试基准：

1. **强校验边界测试**：
   - 构造虚假的 `SHA-256` Hash 或错误的 `size` 执行 commit，必须遭遇服务端 400 拦截。
   - 尝试通过 `/init` 上传未经 Fast Sync 声明的 Hash，必须遭遇 403 拦截。
2. **去重与合并 (Deduplication)**：
   - 同时上传同一个 `hash` 的多条声明，或者多个用户引用了相同的网图，服务端必须触发去重合并逻辑。
3. **断点续传容错机制**：
   - 测试合法的和越界的 HTTP `Range` 请求。
   - 模拟 `upload_id` 过期失效后，依靠 `hash` 重新拉取进度的健壮性。
4. **饥饿防御集成测试 (Starvation Protection)**：
   - 在一个耗时极长的 500MB 大文件上传/下载进行期间，并行发起若干次 Fast Sync 文本编辑。
   - 必须能断言证明：文本编辑即刻得到同步，不受后台 Transfer 阻塞影响。

---

## 6. 上下文与开发执行指引 (Context for the Next Agent)

> [!TIP]
> **To the Next Agent**: 请严格按照本规范作为唯一事实来源。以下是代码库中的核心锚点与迁移上下文：

### 核心关联代码与数据表
1. **现有资产声明来源 (Asset Closure)**：
   - 服务端此前已实现 `file_assets` 表（位于 `apps/server/migrations`）。它绑定了 `vault_id`, `file_id`, `asset_id`, `asset_path`。
   - 你需要查阅服务端 `apps/server/src/routes/sync/push.rs` 中的 `extract_asset_refs` 和 `file_assets` 逻辑，**让 Fast Sync 将资产的逻辑 ID 声明写入此处**，以供 Blob 填坑时作为唯一权限校验源。
2. **服务端新数据库诉求**：
   - 为了管理会话制上传，你大概率需要通过 `sqlx migrate add create_sync_uploads` 增加一张 `sync_uploads` 表记录 `upload_id, hash, expected_size, received_size, expires_at` 等信息。
3. **Tauri 客户端 SQLite 诉求**：
   - 客户端 `TransferManager` 不能放在内存，你需要在 `apps/desktop/src-tauri/src/db` 目录下新增 `transfer_queue` 表，利用 Tauri 中现有的 `rusqlite` 连接池持久化任务状态。
4. **前端 React 组件入口**：
   - Sidebar UI 面板建议在 `apps/desktop/src/features/sidebar/components/` 下新建 `TransferManagerPanel.tsx`。
   - 编辑器内资产的占位图逻辑，需修改 `packages/js-editor-core/src/extensions/Media/` 下的 `ImageComponent` 和 `VideoComponent`，使其能够监听 Tauri 的 `transfer_progress` 事件。

### 建议的分步执行路径 (Staggered PR Strategy)
由于改动巨大，**绝对禁止一个 MR/PR 全部写完**。请遵从以下开发步骤递进：
- **Step 1: Protocol & Schema** (定义 `AssetManifestEntry`，增加 SQLx/Rusqlite Migration，跑通 `cargo check`)。
- **Step 2: Fast Track Hardening** (重构现有的 `push.rs` 和 `team.rs`，砍掉旧版二进制同步，建立新的声明传递通道)。
- **Step 3: Slow Track Server API** (在 `apps/server` 编写 4 个 Chunked 上传/下载的 `axum` Endpoint，并包含所有测试用例)。
- **Step 4: Tauri Transfer Manager** (用 Rust 编写串行下载/上传的后台线程，对接本地 SQLite Queue)。
- **Step 5: Frontend UI & Editor Bindings** (渲染 Transfer Sidebar 进度条和 Editor Placeholder 状态切换)。
