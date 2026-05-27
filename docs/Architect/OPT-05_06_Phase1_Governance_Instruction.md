# OPT-05/06 阶段一：动态治理体系改造 — 研发执行指令

> **签发**: 架构师  
> **日期**: 2026-04-27  
> **前置依赖**: 阶段零（CAS 内容寻址存储）✅ 已完成  
> **预计工作量**: 中等，涉及 Server / Proto / Client 三层

---

## 一、项目背景

Slash 是一款本地优先的结构化笔记应用，支持 Personal（个人）和 Team（团队）两种空间。用户在笔记中嵌入的多媒体附件会通过同步管线推送到服务端。

**当前状态**：团队空间的附件体积上限 **50MB** 被硬编码在三个不同位置：
- `packages/slash-core/src/lib.rs` 第 178 行：`pub const TEAM_ASSET_MAX_SIZE: u64 = 50 * 1024 * 1024;`
- `apps/desktop/src/features/editor/utils/clipboardHandlers.ts` 两处：`file.size > 50 * 1024 * 1024`
- 前端 i18n 文案中写死了 "50MB"

这些硬编码同步使用在：
- `commands/sync/promote.rs` —— Promote（个人升团队）时的扫描过滤
- `commands/sync/team.rs` —— 团队同步扫描和闭包过滤
- `clipboardHandlers.ts` —— 前端 Paste/Drag 入口拦截

**问题**：自建部署用户有自己的服务器和大容量存储，50MB 限制不合理。且限制值散落在三个代码层，维护困难。

---

## 二、改造目标

建立 **Admin 前端可配 → 服务端 DB 持久化 → Negotiate 下发 → 客户端消费** 的动态治理体系：

1. Admin 在 TeamManagePage 中配置限额，保存到 `server_settings` 表
2. 服务端 Negotiate 响应中携带 `server_capabilities`
3. 客户端所有入口从能力声明中读取限额，不再硬编码

---

## 三、架构总览

```
Admin UI (TeamManagePage)
    ↓ PUT /api/team/settings
server_settings 表 (key='max_sync_file_size_mb', value='200')
    ↓ Negotiate 响应
SyncNegotiateResponse.server_capabilities.max_sync_file_size
    ↓
客户端 SyncCapabilitiesState (Tauri Managed State)
    ↓ invoke('get_sync_capabilities')
前端 capabilities.ts 缓存 → clipboardHandlers.ts 消费
```

---

## 四、详细改动

### 4.1 服务端：Settings 读写 API

**文件**: `apps/server/src/routes/team/core.rs`（或新建 `settings.rs`）

新增两个接口：

```rust
/// GET /api/team/settings — 读取团队设置（Admin only）
pub async fn get_team_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TeamSettings>, ApiError> {
    let claims = extract_claims(&state.jwt_secret, &headers)?;
    // 验证 Admin 权限 ...
    
    let max_size: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM server_settings WHERE key = 'max_sync_file_size_mb'"
    ).fetch_optional(&state.pool).await?;
    
    Ok(Json(TeamSettings {
        max_sync_file_size_mb: max_size
            .and_then(|v| v.0.parse::<u64>().ok())
            .unwrap_or(50), // 默认 50MB
    }))
}

/// PUT /api/team/settings — 更新团队设置（Admin only）
pub async fn update_team_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UpdateTeamSettingsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let claims = extract_claims(&state.jwt_secret, &headers)?;
    // 验证 Admin 权限 ...
    
    sqlx::query(
        "INSERT INTO server_settings (key, value) VALUES ('max_sync_file_size_mb', $1) 
         ON CONFLICT (key) DO UPDATE SET value = $1"
    )
    .bind(req.max_sync_file_size_mb.to_string())
    .execute(&state.pool).await?;
    
    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Serialize)]
pub struct TeamSettings {
    pub max_sync_file_size_mb: u64,
}

#[derive(Deserialize)]
pub struct UpdateTeamSettingsRequest {
    pub max_sync_file_size_mb: u64,
}
```

**文件**: `apps/server/src/routes/team.rs`

注册路由：
```rust
.route("/settings", get(core::get_team_settings))
.route("/settings", put(core::update_team_settings))
```

### 4.2 协议层：Negotiate 响应增加 Capabilities

**文件**: `packages/slash-sync-proto/src/lib.rs`

在 `SyncNegotiateResponse` 中新增：
```rust
/// 服务端能力声明（随 Negotiate 响应下发）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    /// 单文件同步体积上限（字节）
    pub max_sync_file_size: u64,
}
```

在 `SyncNegotiateResponse` 中追加字段：
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub server_capabilities: Option<ServerCapabilities>,
```

> **关键**: 使用 `Option` + `serde(default)` + `skip_serializing_if` 确保旧版客户端不会因缺少该字段而反序列化失败。

### 4.3 服务端：Negotiate 响应中填充 Capabilities

**文件**: `apps/server/src/routes/sync/negotiate.rs`

在 negotiate 函数中，查询 DB 获取限额并填入响应：

```rust
// 读取服务端配置的限额
let max_sync_file_size: u64 = sqlx::query_scalar::<_, String>(
    "SELECT value FROM server_settings WHERE key = 'max_sync_file_size_mb'"
)
.fetch_optional(&state.pool).await
.ok().flatten()
.and_then(|v| v.parse::<u64>().ok())
.map(|mb| mb * 1024 * 1024)
.unwrap_or(50 * 1024 * 1024); // 默认 50MB
```

在构造 `SyncNegotiateResponse` 时填充：
```rust
server_capabilities: Some(slash_sync_proto::ServerCapabilities {
    max_sync_file_size,
}),
```

注意：negotiate 函数可能有多个返回 `SyncNegotiateResponse` 的出口，需要全部补上。

### 4.4 客户端 Rust 侧：消费 Capabilities

**文件**: `apps/desktop/src-tauri/src/state.rs`

新增 Managed State：
```rust
/// 服务端下发的同步能力（缓存于客户端内存）
pub struct SyncCapabilitiesState(pub Mutex<SyncCapabilities>);

pub struct SyncCapabilities {
    pub max_sync_file_size: u64,
}

impl Default for SyncCapabilities {
    fn default() -> Self {
        Self {
            max_sync_file_size: 50 * 1024 * 1024, // 离线降级默认值
        }
    }
}
```

在 `lib.rs` 中注册到 Tauri Managed State。

**文件**: `apps/desktop/src-tauri/src/commands/sync/personal.rs` 和 `team.rs`

在收到 negotiate 响应后更新缓存：
```rust
if let Some(caps) = &negotiate_resp.server_capabilities {
    if let Ok(mut sync_caps) = sync_caps_state.0.lock() {
        sync_caps.max_sync_file_size = caps.max_sync_file_size;
    }
}
```

**新增 Tauri command**（供前端查询）：
```rust
#[tauri::command]
pub fn get_sync_capabilities(
    state: State<'_, SyncCapabilitiesState>,
) -> Result<SyncCapabilitiesResponse, String> {
    let caps = state.0.lock().map_err(|e| e.to_string())?;
    Ok(SyncCapabilitiesResponse {
        max_sync_file_size: caps.max_sync_file_size,
    })
}

#[derive(Serialize)]
pub struct SyncCapabilitiesResponse {
    pub max_sync_file_size: u64,
}
```

### 4.5 客户端 Rust 侧：替换硬编码常量

**文件**: `packages/slash-core/src/lib.rs`

保留常量但重命名，明确其为离线降级值：
```rust
/// Team 空间的单文件同步体积上限（离线降级默认值：50MB）
/// 在线模式下，实际限制由 server_capabilities.max_sync_file_size 决定
pub const TEAM_ASSET_MAX_SIZE_DEFAULT: u64 = 50 * 1024 * 1024;
```

**文件**: `commands/sync/promote.rs` 和 `commands/sync/team.rs`

所有引用 `slash_core::TEAM_ASSET_MAX_SIZE` 的地方，改为优先从 `SyncCapabilitiesState` 读取，读取失败时降级使用 `TEAM_ASSET_MAX_SIZE_DEFAULT`。

### 4.6 前端：新建 capabilities 模块

**新建文件**: `apps/desktop/src/core/sync/capabilities.ts`

```typescript
import { invoke } from '@tauri-apps/api/core';

interface SyncCapabilities {
  max_sync_file_size: number;
}

let cachedMaxSize: number | null = null;

/** 获取服务端下发的文件体积上限（字节） */
export async function getMaxSyncFileSize(): Promise<number> {
  if (cachedMaxSize !== null) return cachedMaxSize;
  try {
    const caps = await invoke<SyncCapabilities>('get_sync_capabilities');
    cachedMaxSize = caps.max_sync_file_size;
    return cachedMaxSize;
  } catch {
    return 50 * 1024 * 1024; // 离线降级默认值
  }
}

/** 同步成功后刷新缓存（确保下次读到最新值） */
export function invalidateCapabilitiesCache() {
  cachedMaxSize = null;
}

/** 格式化文件大小为人类可读字符串 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
```

### 4.7 前端：clipboardHandlers 消费动态值

**文件**: `apps/desktop/src/features/editor/utils/clipboardHandlers.ts`

**当前代码**（两处）：
```typescript
if (isTeam && file.size > 50 * 1024 * 1024) {
```

**改为**：
```typescript
import { getMaxSyncFileSize, formatFileSize } from '@/core/sync/capabilities';

const maxSize = await getMaxSyncFileSize();
if (isTeam && file.size > maxSize) {
    toast.warning(t('common:media.file_too_large_title'), {
        description: t('common:media.team_size_limit_block', { limit: formatFileSize(maxSize) }),
    });
```

### 4.8 前端：i18n 文案动态化

**文件**: `apps/desktop/src/locales/zh-CN/common.json` 和 `en/common.json`

将 "50MB" 替换为占位符：
```json
"team_size_limit_block": "此文件超出团队空间 {{limit}} 大小限制，无法引入"
```

英文：
```json
"team_size_limit_block": "This file exceeds the team space {{limit}} size limit"
```

### 4.9 前端：TeamManagePage 增加限额配置

**文件**: `apps/desktop/src/features/team/TeamManagePage.tsx`

在 Admin 视图中增加一个配置区域。建议放在 Storage Dashboard tab 的顶部或新增一个 "Settings" tab。

核心 UI：
- 一个数字输入框，标签为"单文件同步上限 (MB)"
- 当前值从 `GET /api/team/settings` 获取
- 修改后 `PUT /api/team/settings` 保存
- 仅 Admin 可见

**文件**: `apps/desktop/src/services/TeamService.ts`

新增两个 API 方法：
```typescript
async getTeamSettings(serverUrl: string, token: string): Promise<TeamSettings> { ... }
async updateTeamSettings(serverUrl: string, token: string, settings: UpdateTeamSettings): Promise<void> { ... }
```

---

## 五、不需要修改的文件

| 文件 | 原因 |
|:---|:---|
| `assets.rs` | 资产落盘逻辑不涉及体积限制 |
| `helpers.rs` | 闭包扫描器不涉及体积限制 |
| `config.rs` / `.env` | 改用 DB 持久化，不走环境变量 |
| `AppState` | 改为每次 negotiate 时实时查 DB，不需要在 AppState 中持有 |

---

## 六、验收条件

1. **Admin 配置**：在 TeamManagePage 中将限额改为 200MB → 保存成功 → 刷新页面后显示 200MB
2. **DB 持久化**：`SELECT * FROM server_settings WHERE key = 'max_sync_file_size_mb'` 返回 `200`
3. **Negotiate 下发**：客户端同步时，Negotiate 响应中 `server_capabilities.max_sync_file_size = 209715200`
4. **前端拦截**：在 Team 空间拖入一个 100MB 文件 → 不被拦截（限额已升至 200MB）
5. **i18n 文案**：拖入一个 300MB 文件 → 提示 "此文件超出团队空间 200MB 大小限制"
6. **离线降级**：断开服务端连接 → 拖入 100MB 文件 → 被拦截（降级到默认 50MB）
7. **Personal 空间**：Personal 空间拖入大文件 → 不受此限制
8. **向后兼容**：旧版客户端不识别 `server_capabilities` 不崩溃
9. **编译通过**：`cargo check` 全通过（Server + Client 两侧）

---

## 七、注意事项

- **不要删除 `TEAM_ASSET_MAX_SIZE` 常量**——重命名为 `TEAM_ASSET_MAX_SIZE_DEFAULT` 作为离线降级值
- `SyncNegotiateResponse` 的新字段必须用 `Option` 包裹 + `serde(default)` 确保向后兼容
- Settings API 必须校验 Admin 权限，非 Admin 不可修改
- 限额输入应有合理范围校验（建议 1MB ~ 10240MB）
- `server_settings` 表已有 `ON CONFLICT (key) DO UPDATE` 能力，可以直接 UPSERT
- 修改完成后请撰写简要报告放在 `docs/Developer/OPT-05_06_Phase1_Report.md`
