# Slash Sync — Desktop 端功能点与逻辑记录

> 供 Phase 3（Mobile App / Team Vault）复用参考。

## 架构总览

```
Desktop (Tauri)                    Server (Axum)           Sidecar (FastAPI)
┌────────────────┐                ┌──────────────┐        ┌──────────────┐
│ AutoSyncManager│←── status ───→│ /api/auth/*  │        │ /parse       │
│ SyncService    │── negotiate →→│ /api/sync/*  │        │ /health      │
│ ImportService  │               │              │        │ /formats     │
└────────────────┘               └──────────────┘        └──────────────┘
```

## 1. 自动同步 (`AutoSyncManager.ts`)

### 触发条件

| 触发器 | 条件 | 延迟 |
|--------|------|------|
| 文件变更 | content_hash 变化 → markDirty → debounce | 2s |
| 启动 | App 启动后首次同步 | 3s |
| 前台恢复 | visibilitychange + 距上次 > 60s | 立即 |
| 定时保底 | setInterval | 5min |
| 退出 flush | beforeunload + dirty_queue 非空 | 立即 |
| 网络恢复 | `online` 事件 + status=offline 或 dirty_queue 非空 | 立即 |

### 关键机制

- **isSyncing 防并发**：同一时刻只能有一个 sync 在跑，新请求设 `pendingSync=true`
- **syncCooldownUntil**：pull 写文件后 3s 冷却期，忽略 watcher 触发的 note:updated，防止 pull → watcher → markDirty 无限循环
- **editingPath 保护**：文件变更/queued 触发的 sync 会跳过编辑中文件的 pull
- **dirty_queue**：`Set<string>` 去重，sync 成功后清空

### 离线队列

- 网络错误时（!navigator.onLine / fetch 失败 / connect 失败）→ status=`offline`，dirty_queue **不清空**
- 服务器错误时（非网络原因）→ status=`error`，5s 后恢复 idle
- `window.addEventListener('online', ...)` 自动触发 `online_recovery` 同步

## 2. 同步服务 (`SyncService.ts`)

### 配置隔离

- 每个 vault 独立存储 sync 配置（serverUrl/accessToken/vaultId）
- storage key 前缀：`slash_sync_{vaultSlug}_*`
- 切换 vault → `setActiveVault(path)` → 读取对应配置

### Token 刷新

- `syncVault()` 捕获 401 → 调用 `refreshToken()` → POST `/api/auth/refresh` 带旧 token
- 成功 → 保存新 token + 重试 sync
- 失败 → dispatch `sync:auth-expired` 事件 → UI 提示

### 事件系统

| 事件 | 发送方 | 接收方 | 作用 |
|------|--------|--------|------|
| `sync:config-changed` | SyncService | SyncStatusIndicator | 配置变更后刷新 UI |
| `sync:pulled` | AutoSyncManager | useEditorEvents | Pull 后刷新当前笔记 |
| `sync:auth-expired` | SyncService | SyncStatusIndicator | Token 过期提示 |
| `note:open` | ImportButton | App | 导航到新导入的笔记 |

## 3. 同步协议 (`slash-sync-proto`)

### Negotiate (POST /api/sync/negotiate)

- Client 发送 directory_hashes（Merkle）+ client_files（path/hash/base_hash）
- Server 返回 server_needs（push 列表）+ client_needs（pull 列表）
- base_hash 决策逻辑：

| client_hash | base_hash | server_hash | 决策 |
|-------------|-----------|-------------|------|
| == server | - | - | noop |
| == base | ≠ server | - | pull |
| ≠ base | == server | - | push |
| ≠ base | ≠ server | ≠ client | conflict → client wins (push) |

### sync_state.json

Desktop 端持久化，存于 `{vault}/.slash/sync_state.json`。
格式：`{ "relative_path": "content_hash" }`
- 只更新实际同步成功的文件的 hash
- SKIPPED/CONFLICT 文件保持旧 base_hash

## 4. 文件导入 (`ImportService.ts`)

### 流程

1. `readFile()` 读取源文件二进制
2. `FormData` POST 到 `http://localhost:3722/parse`
3. 写入 `{vault}/00_Inbox/{baseName}.md`（含 frontmatter）
4. 触发文件树刷新 + expandToPath + note:open

### 冲突处理

文件名冲突时追加 `_1`, `_2` 后缀。

## 5. Server 端

### API 端点

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/auth/register` | POST | 无 | 注册 |
| `/api/auth/login` | POST | 无 | 登录 |
| `/api/auth/refresh` | POST | Bearer（宽限7天） | Token 刷新 |
| `/api/auth/me` | GET | Bearer | 用户信息 |
| `/api/sync/negotiate` | POST | Bearer | 差异协商 |
| `/api/sync/push` | POST | Bearer | 推送文件 |
| `/api/sync/pull` | POST | Bearer | 拉取文件 |
| `/api/sync/vaults` | GET | Bearer | Vault 列表 |

### 存储

- 元数据：PostgreSQL（`file_states` 表）
- 文件内容：`LocalFileStorage`（`./data/{vault_id}/{path}`）
- Trait：`FileStorage`，未来可替换为 S3

## 6. Phase 3 复用要点

### 移动端需复用

- `slash-sync-proto` crate（Negotiate/Push/Pull 协议结构体）
- `slash-core`（scan_directory_manifests / calculate_directory_hash）
- 同步协议 base_hash 决策逻辑
- Token 刷新机制（refresh 端点已就绪）

### 团队协作需扩展

- `SyncNegotiateRequest.space_type` 已预留 Team 枚举
- `ensure_vault()` 需扩展 RBAC 权限检查
- conflict 策略需升级为 diff-merge（当前 client wins）
