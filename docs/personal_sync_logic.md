# Slash 个人版同步逻辑

> 本文档记录 Slash Community Edition 的端云同步完整逻辑，供后续 Phase 3 (Team / Mobile) 开发参考。

---

## 一、同步协议三步握手

```
Desktop                           Server
  │                                  │
  │  1. POST /api/sync/negotiate     │
  │  ───────────────────────────►    │
  │  (client_files + deleted_paths)  │
  │                                  │
  │  ◄───────────────────────────    │
  │  (server_needs + client_needs)   │
  │                                  │
  │  2. POST /api/sync/push          │
  │  ───────────────────────────►    │
  │  (server_needs 对应的文件内容)     │
  │                                  │
  │  3. POST /api/sync/pull          │
  │  ───────────────────────────►    │
  │  (请求 client_needs 的文件路径)    │
  │  ◄───────────────────────────    │
  │  (文件内容返回)                    │
```

## 二、Negotiate 差异决策

### 输入

| 字段 | 来源 | 说明 |
|------|------|------|
| `directory_hashes` | Desktop | 各目录的 Merkle hash，用于快速排除一致目录 |
| `client_files` | Desktop | 每个文件的 `{ path, hash, base_hash }` |
| `deleted_paths` | Desktop | sync_state 中有但本地已删除的文件路径 |
| `space_type` | Desktop | `Personal` 或 `Team(vault_id)`，Server 端做隔离校验 |

### 决策逻辑

#### Step 0: 删除传播
- `deleted_paths` 中的文件 → Server 从 DB (`file_states`) 和文件存储中删除
- 后续 Step 2 遍历时跳过这些路径

#### Step 1: 目录级快速排除
- Client 目录 Merkle hash == Server 目录 Merkle hash → 整个目录跳过

#### Step 2: 文件级决策（遍历 Server 文件）

| client_hash | base_hash | server_hash | 决策 |
|-------------|-----------|-------------|------|
| == server_hash | - | - | **noop** |
| == base_hash | - | ≠ base | **pull**（Server 有更新） |
| ≠ base_hash | - | == base | **push**（Client 有更新） |
| ≠ base_hash | - | ≠ base | **push**（冲突，client wins） |
| - | empty | - | **push**（首次同步） |
| (不存在) | - | - | **pull**（Client 缺少） |

#### Step 3: 遍历 Client 文件
- Client 有但 Server 没有 → **push**（新文件）

### base_hash 概念

`base_hash` 是上次同步成功时该文件的 content_hash，存储在本地 `.slash/sync_state.json` 中。它代表这个文件在客户端和服务端"上次一致"的版本，用于判断是谁做了修改。

## 三、自动同步引擎 (`AutoSyncManager.ts`)

### 6 种触发器

| 触发器 | 条件 | 延迟 |
|--------|------|------|
| **文件变更** | 监听 `note:updated` 事件 → `markDirty()` → `scheduleSync()` | debounce 2s |
| **结构变更** | 监听 `vault:refresh` 事件（新建/删除/重命名）→ `scheduleSync()` | debounce 2s |
| **启动** | App 启动后首次同步 | 3s |
| **前台恢复** | `visibilitychange` 事件 + 距上次同步 > 60s | 立即 |
| **定时保底** | `setInterval` | 5 分钟 |
| **网络恢复** | `online` 事件 + (status=offline 或 dirty_queue 非空) | 立即 |

### 退出 flush

- `beforeunload` 事件 + dirty_queue 非空 → `forceSync('shutdown')`

### 防并发机制

- `isSyncing` 互斥锁：同一时刻只能有一个 sync 在执行
- `pendingSync` 标记：新请求到达时设为 true，当前 sync 完成后自动触发
- `syncCooldownUntil`：Pull 写文件后 3 秒冷却期，忽略 watcher 触发的 dirty
- watcher 事件在 `isSyncing || Date.now() < syncCooldownUntil` 时被忽略，防止 pull 写文件→watcher→markDirty 无限循环

### 状态机

```
disabled ──(配置连接)──► idle
idle ──(触发同步)──► syncing
syncing ──(成功)──► success ──(3s)──► idle
syncing ──(网络错误)──► offline ──(online 事件)──► syncing
syncing ──(服务器错误)──► error ──(5s)──► idle
```

### 编辑中文件保护

- `editingPath` 记录当前正在编辑的文件路径
- Pull 阶段跳过该路径，避免覆盖用户正在编辑的内容
- 被跳过的文件记入 `skipped_pulls`

### beforeSyncHook

- 可注册 sync 前回调（`setBeforeSyncHook`），用于 flush 编辑器内容到磁盘
- 确保 negotiate 计算的 hash 反映真实的最新编辑内容，消除 debounce 竞态

### Promote 暂停/恢复

- `pauseForPromote()`：等待进行中的 sync 完成（最多 15s），设 30s 冷却期，清除 debounce timer
- `resumeAfterPromote()`：清除冷却期，立即触发一次同步

### 同步后事件

- `sync:pulled`：通知编辑器刷新当前笔记（内部有内容对比，相同则跳过 reload）
- `sync:completed`：通知 UI 刷新
- `team:tree-refresh`：团队文件树刷新
- Pull 下来的 `.md` 文件自动调用 `scan_note_tasks` 提取待办任务到 SQLite

## 四、Token 刷新

```
SyncService.syncVault()
  ├─ 调用 Tauri sync_vault 命令
  ├─ 捕获 401 错误
  │   ├─ POST /api/auth/refresh (带旧 Token)
  │   ├─ 成功 → 保存新 Token → 重试 syncVault
  │   └─ 失败 → dispatch sync:auth-expired 事件
  └─ 返回 SyncResult
```

Server `/api/auth/refresh` 端点：
- 验证旧 JWT（允许 7 天过期宽限）
- 确认用户仍存在于 DB
- 签发新的 1 小时 JWT

## 五、离线队列

- **检测**：`!navigator.onLine` 或 `fetch` 抛出网络错误 (含 `fetch`/`network`/`Failed to fetch`/`connect` 关键词)
- **保留**：dirty_queue（`Set<string>`）不清空，状态设为 `offline`
- **恢复**：`window.addEventListener('online', ...)` → `requestSync('online_recovery')`
- **服务器错误**：非网络错误时不保留 dirty_queue（避免无限重试），5s 后恢复 idle

## 六、同步状态持久化 (`sync_state.json`)

位置：`{vault}/.slash/sync_state.json`

格式：
```json
{
  "01_Projects/note.md": "a1b2c3d4e5f6...",
  "02_Areas/diary.md": "f6e5d4c3b2a1..."
}
```

### 防竞态 base_hash 策略

核心问题：用户可能在 sync 执行期间继续编辑并保存，post-scan 会读到 server 没有的新 hash。

更新规则：
- **pushed 文件**：使用 **pre-scan hash**（negotiate 前扫描的版本，即实际上传到 server 的版本）
- **pulled 文件**：使用 **post-scan hash**（server 写入磁盘后重新扫描的 hash）
- **其他文件**：保持旧 base_hash 不变
- **全新文件**（不在 synced_paths 中）：记录 post-scan hash
- **已删除文件**：sync_state 中移除（通过 `retain` 只保留 post-scan 中存在的路径）

## 七、删除传播

### Desktop 端
1. 对比 `sync_state.json`（上次同步时存在的文件）与当前本地文件列表
2. sync_state 中有但本地已不存在的路径 → `deleted_paths`
3. 通过 `SyncNegotiateRequest.deleted_paths` 发送给 Server

### Server 端
1. Negotiate Step 0：遍历 `deleted_paths`
2. 从 `file_states` 表中 DELETE 对应记录
3. 从 `FileStorage` 中删除文件
4. Step 2 遍历 server_files 时，跳过 `deleted_set`

## 八、事件系统

| 事件名 | 发送方 | 接收方 | 作用 |
|--------|--------|--------|------|
| `note:updated` | FileWatcher / Editor | AutoSyncManager | 标记文件为 dirty |
| `vault:refresh` | FileWatcher | AutoSyncManager | 结构变更（新建/删除/重命名）触发同步 |
| `sync:config-changed` | SyncService | AutoSyncManager / UI | 配置变更后刷新 |
| `sync:pulled` | AutoSyncManager | useEditorEvents | Pull 后刷新当前笔记 |
| `sync:completed` | AutoSyncManager | UI | 任何成功同步后通知 UI 刷新 |
| `sync:auth-expired` | SyncService | SyncStatusIndicator | Token 过期提示 |
| `sync:pr-created` | SyncService | UI | 团队 vault PR 创建通知 |
| `team:tree-refresh` | AutoSyncManager | TeamTreeView | 团队文件树刷新 |

## 九、Per-Vault 配置隔离

每个 Vault 独立存储同步配置：

- `localStorage` key 前缀：`slash_sync_{vaultSlug}_*`（vaultSlug = 路径最后两层目录名拼接）
- 存储内容：`serverUrl` / `accessToken` / `vaultId` / `accessCode` / `lastSync` / `autoSync`
- 切换 Vault → `setActiveVault(path)` → 读取对应配置 → dispatch `sync:config-changed`
- 断开连接时只清除 `accessToken` 和 `lastSync`，保留地址、配对码和 vault_id（方便重连，避免全量重推）

## 十、Server 端 API

### Auth 端点 (`/api/auth`)

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/auth/pair` | POST | 无 | 首次配对（Access Code） |
| `/api/auth/connect` | POST | 无 | PIN 登录（后续设备） |
| `/api/auth/refresh` | POST | Bearer (7天宽限) | 刷新 Token |
| `/api/auth/me` | GET | Bearer | 获取用户信息 |
| `/api/auth/me` | PUT | Bearer | 更新用户档案 |
| `/api/auth/reset-password` | POST | Bearer | 重置密码 |

### Sync 端点 (`/api/sync`)

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/sync/vaults` | GET | Bearer | 获取 Vault 列表 |
| `/api/sync/vaults/directories` | GET | Bearer | 获取 Vault 目录结构 |
| `/api/sync/vaults/tree` | GET | Bearer | 获取 Vault 完整文件树 |
| `/api/sync/vaults/file` | GET | Bearer | 获取 Vault 文件内容（只读） |
| `/api/sync/negotiate` | POST | Bearer | 差异协商 |
| `/api/sync/push` | POST | Bearer | 推送文件 |
| `/api/sync/pull` | POST | Bearer | 拉取文件 |
| `/api/sync/diff` | POST | Bearer | 语义 Diff 计算 |
| `/api/sync/task-bypass` | POST | Bearer | Task checkbox 旁路同步 |

### Server 管理端点 (`/api/server`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/server/info` | GET | 服务器信息 |
| `/api/server/pin` | POST | 设置 PIN |
| `/api/server/reset-code` | POST | 重置 Access Code |
| `/api/server/request-new-code` | POST | 请求新 Access Code |

### Team 端点 (`/api/team`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/team/create` | POST | 创建团队 |
| `/api/team/invite` | POST | 邀请成员 |
| `/api/team/members` | GET | 团队成员列表 |
| `/api/team/members/{user_id}/role` | PUT | 更新成员角色 |
| `/api/team/reset` | POST | 重置团队 Vault |
| `/api/team/my-scope` | GET | 获取我的 scope |
| `/api/team/directories/files` | GET | 获取目录下的文件列表 |
| `/api/team/directories/rename` | POST | 重命名目录 |
| `/api/team/migrate-identity` | POST | 迁移身份 |

### PR 端点 (`/api/pr`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/pr/list` | GET | PR 列表 |
| `/api/pr/{id}` | GET | PR 详情 |
| `/api/pr/{id}/approve` | POST | 批准 PR |
| `/api/pr/{id}/reject` | POST | 拒绝 PR |

### 其他

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/health` | GET | 无 | 健康检查 |

## 十一、文件存储

- **Trait**：`FileStorage`（`put` / `get` / `delete` / `exists`）
- **LocalFileStorage**：文件存于 Server 本地 `./data/{vault_id}/{path}`
- **S3FileStorage**：S3/Minio 兼容存储（已实现），通过环境变量配置：
  - `S3_BUCKET`：Bucket 名称
  - `S3_REGION`：区域（默认 us-east-1）
  - `S3_ENDPOINT_URL`：自定义 endpoint（Minio 必填）
  - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`：凭证
- **选择**：`STORAGE_BACKEND=s3|minio` → S3FileStorage，否则默认 LocalFileStorage
- **本地路径**：`STORAGE_LOCAL_DIR` 环境变量控制（默认 `./data`）

## 十二、团队同步 (`sync_team_full`)

个人同步完成后，自动执行团队同步。复用同一套 negotiate→push+pull 引擎，区别在于：

### 路径映射
- 本地持久化在 `.slash/team_path_mappings.json`（含 `vault_id` 绑定，防 Docker 重建误用旧映射）
- 源路径（个人空间）↔ 目标路径（团队 vault）双向映射
- PARA 反向映射自动发现：`01_PROJECTS→01_Projects`, `02_AREAS→02_Areas` 等

### Scope 驱动
- `/api/team/my-scope` 返回用户的 scope（权限范围）
- Admin + `is_full_scope=true` + `scope_dirs` 为空时：同步所有有映射的目录
- 其他用户：只同步有映射 **AND** 有权限的目录

### 独立 sync_state
- 团队同步状态独立存储：`.slash/team_sync_{vault_id}.json`

### 目录级隔离
- `managed_dirs` 过滤：排除属于独立管理子目录的文件
- Pull 安全过滤：只 Pull 有 reverse_mappings 映射的文件

## 十三、Tauri 命令

| 命令 | 说明 |
|------|------|
| `sync_vault` | 完整同步（个人 + 团队） |
| `push_directory_to_vault` | Promote to Team（推送目录到团队 vault） |
| `check_sync_connection` | 检查 Server 连接状态 |
