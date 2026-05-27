# Slash 数据存储分级治理方案 v2

> 创建：2026-03-24 | 最新评估：2026-03-29  
> 背景：清空 LocalStorage 后同步异常、红点失控、Token 裸存等问题的系统性治理
> **当前状态**：核心 P0 与 P1 治理已全部落地，完成度 85%+。

---

## 问题清单与分级

| 编号 | 数据 | 当前存储 | 核心问题 | 优先级与状态 |
|---|---|---|---|---|
| D1 | access_token / refresh_token | localStorage | XSS 可读走，session 模型不完整 | **P0 安全** ✅已解决 |
| D2 | collab 事件游标 | localStorage 裸时间戳 | 游标丢失 → 事件回放 → 红点失控 | **P1 正确性** ✅已解决 |
| D3 | unreadPaths 红点状态 | localStorage | 跨设备不一致，清 LS 消失 | **P1 正确性** ✅已解决 |
| D4 | team_sync_state.json | 磁盘非原子写 | 崩溃可产生半写文件 | **P1 正确性** ✅已解决 |
| D5 | server_url | localStorage | 应用级配置不应依赖浏览器存储 | **P2 健壮性** ⏸️ 维持现状 |
| D6 | vault_id | localStorage + 磁盘（重复） | 磁盘已有，localStorage 多余 | **P2 健壮性** ⏸️ 维持现状 |
| D7 | display_name | localStorage | 展示缓存可重拉，无正确性风险 | 可接受 ✅ |

---

## P0 — access_token 安全存储 + 会话模型【✅已完成】

### 当前问题

```
localStorage.getItem('slash_sync_access_token')  // XSS 直接可读
// 无 refresh token 机制
// 多账号 / 多 server 无 Keychain key 规范
```

### 1. Token 下沉到 Rust / Keychain

**存储层级**

```
┌──────────────────────────────────────────────────────────┐
│  系统安全存储                                             │
│  macOS  → Keychain (security add-generic-password)       │
│  Windows→ Credential Manager (DPAPI)                     │
│  Linux  → Secret Service (libsecret)                     │
└───────────────────────── ↑ ──────────────────────────────┘
                     Rust 启动时加载到 AppState
                     前端不持有 token，全程 invoke 代理
```

**Rust 命令改造**

```rust
// 之前：前端把 token 传给 Rust
pub async fn sync_vault(access_token: String, ...) {}

// 之后：Rust 自己从 Keychain 读
pub async fn sync_vault(state: State<'_, AppState>, ...) {
    let token = state.session.access_token()?;
}
```

### 2. Keychain Key 命名规范（多账号 / 多 server）

**Key 格式**：`slash.{service_host}.{user_id}.{token_type}`

```
slash.myserver.example.com.u-abc123.access_token
slash.myserver.example.com.u-abc123.refresh_token
slash.myserver2.com.u-xyz456.access_token
```

- `service_host`：规范化的 server hostname（去掉协议、端口标准化）
- `user_id`：JWT sub 字段（登录后解析）
- 多 server / 多账号完全隔离，不会混淆

**Keychain Key 注册表**（内存中，`AppState` 持有）

```rust
pub struct SessionStore {
    entries: HashMap<SessionKey, SessionTokens>,
    active: Option<SessionKey>,  // 当前活跃账号
}

pub struct SessionKey {
    server_host: String,
    user_id: String,
}

pub struct SessionTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: DateTime<Utc>,
}
```

### 3. Refresh Token 模型

**服务端（已有 `/api/auth/refresh`，需完善）**

```
POST /api/auth/refresh
Authorization: Bearer {refresh_token}
→ { access_token, refresh_token, expires_in }
```

- `access_token`：短期，15 分钟有效
- `refresh_token`：长期，30 天有效，一次性（用后失效，发新的）
- refresh_token 轮换：每次刷新都更新 Keychain

**Rust 自动刷新**

```rust
impl SessionStore {
    /// 获取有效 access_token，必要时自动刷新
    pub async fn access_token(&mut self, http: &Client) -> Result<String> {
        let tokens = self.active_tokens()?;
        
        // 提前 60s 主动刷新，避免临界过期
        if tokens.expires_at - Utc::now() < Duration::seconds(60) {
            let new_tokens = self.refresh(http, tokens).await?;
            self.store_to_keychain(&new_tokens)?;
            return Ok(new_tokens.access_token);
        }
        
        Ok(tokens.access_token.clone())
    }
}
```

**设备会话（Device Session）**

```sql
-- 服务端 device_sessions 表（可选，用于远程踢出）
CREATE TABLE device_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    device_name     TEXT,                    -- "MacBook Pro - macOS 14.3"
    refresh_token_hash TEXT NOT NULL,        -- 存 hash，不存明文
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. 迁移兼容性

```rust
// 启动时检测旧 localStorage token（需要前端配合传一次）
// 迁移到 Keychain 后清除 localStorage
```

---

## P1-A — 协作事件游标（消费游标 vs 已读游标分离）【✅已完成】

### 核心设计原则

**两个游标，语义不同，不能混用**

| 游标 | 语义 | 更新时机 | 跨设备同步 |
|---|---|---|---|
| **消费游标** `consumed_seq` | 拉取边界：「我已经处理到第 N 条事件」 | 每次成功拉取后更新 | ✅ 服务端持有，各设备同步 |
| **已读游标** `read_seq_per_file` | 红点边界：「我已经看过文件 F 的第 N 条事件」 | 用户打开文件时更新 | ✅ 服务端持有，跨设备同步 |

**消费游标丢失 → 重拉事件（多打红点，最坏情况是重复提醒）**  
**已读游标丢失 → 旧事件重新变成未读（显示已消除的红点）**

两者分开，互不干扰。

---

### 全局事件序号设计修正

**原方案问题**：两张表各有 `BIGSERIAL`，UNION 后序号不单调，无法当全局游标。

**修正：统一事件表（Event Sourcing 模式）**

```sql
-- 迁移：008_collab_event_log.sql

-- 全局事件日志（只追加，不修改）
CREATE TABLE collab_event_log (
    seq         BIGSERIAL PRIMARY KEY,           -- 全局单调递增
    vault_id    UUID NOT NULL,
    kind        TEXT NOT NULL,                   -- 'annotation' | 'comment' | 'file_edit'
    file_path   TEXT NOT NULL,
    author_id   UUID NOT NULL REFERENCES users(id),
    author_name TEXT NOT NULL,
    payload     JSONB,                           -- 事件详情（可扩展）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_collab_event_vault_seq ON collab_event_log(vault_id, seq);

-- 消费游标（per user per vault）
CREATE TABLE collab_consumed_cursors (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id    UUID NOT NULL,
    consumed_seq BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, vault_id)
);

-- 已读游标（per user per vault per file）
CREATE TABLE collab_read_cursors (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id    UUID NOT NULL,
    file_path   TEXT NOT NULL,
    read_seq    BIGINT NOT NULL DEFAULT 0,    -- 该文件已读到的最新 seq
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, vault_id, file_path)
);
```

**现有表改造（写入时同步写 event_log）**

```rust
// 在 create_annotation / create_doc_comment 的事务中同步写 collab_event_log
INSERT INTO collab_event_log (vault_id, kind, file_path, author_id, author_name, payload)
VALUES ($1, 'annotation', $2, $3, $4, $5)
RETURNING seq;
```

---

### API 设计

```
# 拉取新事件（增量）
GET /api/collab/events?vault_id=xxx&after_seq=1234&limit=100
→ {
    events: [{ seq, kind, file_path, author_name, created_at, payload }],
    max_seq: 1250
  }

# 读取消费游标
GET /api/collab/cursor?vault_id=xxx
→ { consumed_seq: 1234 }

# 更新消费游标
PUT /api/collab/cursor
body: { vault_id, consumed_seq: 1250 }

# 标记文件已读（更新 read_seq）
PUT /api/collab/read
body: { vault_id, file_path, read_seq: 1250 }

# 查询未读文件（有新事件 seq > read_seq 的文件列表）
GET /api/collab/unread?vault_id=xxx
→ {
    unread_files: [
      { file_path, unread_count: 3, latest_seq: 1250 }
    ]
  }
```

---

### 客户端改造

**`checkCollabActivity` 完整流程**

```ts
private async checkCollabActivity() {
    const teamVaultId = localStorage.getItem('slash_team_vault_id');
    if (!teamVaultId) return;

    // 1. 本地热缓存读游标（避免登录时多一次 RTT）
    let consumedSeq = parseInt(localStorage.getItem('slash_collab_consumed_seq') || '-1', 10);
    if (consumedSeq < 0) {
        // 首次或本地缓存丢失：从服务端同步游标
        const cursor = await collabService.getCursor(teamVaultId);
        consumedSeq = cursor.consumed_seq;
        localStorage.setItem('slash_collab_consumed_seq', String(consumedSeq));
    }

    // 2. 拉取 after_seq 的新事件（幂等：重复拉取按 seq 去重）
    const { events, max_seq } = await collabService.getEvents(teamVaultId, consumedSeq);
    
    // 3. 过滤自己的事件
    const currentUser = localStorage.getItem('slash_user_display_name');
    const othersEvents = events.filter(e => e.author_name !== currentUser);
    
    if (othersEvents.length > 0) {
        // 4. 分发给红点系统（基于 read_seq 判断是否真正未读）
        window.dispatchEvent(new CustomEvent('collab:new-events', {
            detail: { events: othersEvents }
        }));
    }

    // 5. 更新消费游标（本地 + 服务端异步）
    if (max_seq > consumedSeq) {
        localStorage.setItem('slash_collab_consumed_seq', String(max_seq));
        collabService.updateCursor(teamVaultId, max_seq).catch(console.warn); // 非阻塞
    }
}
```

**幂等与重复拉取处理**

```ts
// 事件去重（本地 Set，进程内有效）
private processedSeqs = new Set<number>();

processEvents(events: CollabEvent[]) {
    for (const ev of events) {
        if (this.processedSeqs.has(ev.seq)) continue; // 跳过已处理
        this.processedSeqs.add(ev.seq);
        this.handleEvent(ev);
    }
    // 保持 Set 大小合理（只保留最近 1000 条）
    if (this.processedSeqs.size > 1000) {
        const min = Math.min(...this.processedSeqs);
        this.processedSeqs.delete(min);
    }
}
```

---

## P1-B — 红点语义定义 + unreadPaths 改派生【✅已完成】

### 红点语义（钉死）

| 维度 | 定义 |
|---|---|
| **粒度** | 按**文件**，不按事件条数（一个文件有 N 条新事件，只显示 1 个红点） |
| **判断条件** | 该文件存在 `seq > read_seq[file_path]` 的**他人**事件 |
| **打红点时机** | 拉取到新事件后，根据 `read_seq` 判断，有新事件则打 |
| **消红点时机** | 用户**显式打开**该文件的协作历史面板（非仅打开文件编辑器） |
| **为什么不是「打开文件就消红」** | 用户可能只想编辑，没注意到协作面板；消红应证明用户「已知」 |

**消红触发条件（精确）**

1. 用户打开右侧协作历史 Tab，**且**当前文件是该路径 → 消红 + `PUT /api/collab/read { file_path, read_seq: latest_seq }`
2. 用户打开后滚动到底部（可选强化，目前不需要）

**未读数量计算（服务端）**

```sql
-- 某文件的未读事件数（排除自己）
SELECT COUNT(*) FROM collab_event_log
WHERE vault_id = $1
  AND file_path = $2
  AND seq > (SELECT read_seq FROM collab_read_cursors
             WHERE user_id = $3 AND vault_id = $1 AND file_path = $2)
  AND author_id != $3;
```

### unreadPaths 改为派生状态

```ts
// useCollabNotifyStore 改造后
// unreadPaths 不再持久化到 localStorage
// 完全基于服务端 /api/collab/unread 重建

interface CollabNotifyState {
    // 内存状态（不持久化）
    unreadFiles: Map<string, { latestSeq: number; count: number }>;
    
    // 动作
    refreshUnread: (vaultId: string) => Promise<void>; // 从服务端全量拉取
    markUnread: (path: string, latestSeq: number) => void; // 本地增量更新
    markRead: (path: string) => void; // 本地清除 + 触发服务端更新
}

// App 启动 / 登录后
store.refreshUnread(teamVaultId); // 从 GET /api/collab/unread 重建完整红点状态

// 每次收到新事件
store.markUnread(file_path, event.seq);

// 用户打开协作历史 Tab
store.markRead(file_path); // 消红 + 发请求
```

---

## P1-C — team_sync_state.json 原子写入【✅已完成】

**tmp + rename + fsync**

```rust
fn save_unified_state(root: &Path, state: &HashMap<String, TeamFileState>) {
    let state_path = root.join(".slash").join("team_sync_state.json");
    let tmp_path = root.join(".slash").join("team_sync_state.json.tmp");
    
    let json = serde_json::to_string_pretty(state).expect("serialize");
    
    // 写临时文件 → fsync → atomic rename
    std::fs::write(&tmp_path, &json).expect("write tmp");
    {
        let f = std::fs::File::open(&tmp_path).expect("open tmp");
        f.sync_all().expect("fsync"); // 确保数据真正落盘
    }
    std::fs::rename(&tmp_path, &state_path).expect("atomic rename");
}

fn load_unified_state(path: &Path) -> HashMap<String, TeamFileState> {
    // 优先读正式文件，失败时降级到 .tmp（崩溃恢复）
    let content = std::fs::read_to_string(path)
        .or_else(|_| std::fs::read_to_string(path.with_extension("json.tmp")))
        .unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}
```

---

## P2 — server_url / vault_id 清理

### P2-A: server_url → AppData 配置文件

```toml
# ~/.local/share/slash/config.toml  (Linux)
# ~/Library/Application Support/slash/config.toml  (macOS)
[server]
url = "https://my-server.com"
```

```rust
// Tauri 启动时加载，暴露只读 invoke 给前端
#[tauri::command]
pub fn get_server_url(state: State<'_, AppState>) -> String {
    state.config.server_url.clone()
}
```

### P2-B: vault_id 统一磁盘，去除 localStorage 副本

- 磁盘已有 `.slash/sync_vault_id`
- 所有读取改为 `invoke('get_vault_id')`，Rust 从磁盘读
- localStorage 的 `slash_sync_vault_id_*` key 系列废弃并清除

---

## 实施时序

```
P1-C  原子写入        0.5d   零依赖，最低风险，立即可做
  ↓
P1-A  事件日志 + 游标  2d    DB 迁移 + 新路由 + 客户端重构
  ↓ 依赖 P1-A
P1-B  红点语义 + 派生  0.5d  依赖 /api/collab/unread 接口
  ↓
P0-服务端  refresh token + device session  1d
P0-客户端  Keychain + session store        1.5d
  ↓
P2  配置清理           0.75d  低风险收尾
```

**总计约 6-7 工作日**

---

## 工作量汇总

| 编号 | 内容 | 工作量 | 风险 | 依赖 |
|---|---|---|---|---|
| P1-C | 原子写入 | 0.5d | 低 | 无 | ✅ 已完成 |
| P1-A 服务端 | 事件日志表、游标表、3 个新路由 | 1.5d | 中 | 无 | ✅ 已完成 |
| P1-A 客户端 | AutoSyncManager 重构、CollabService | 0.5d | 低 | P1-A 服务端 | ✅ 已完成 |
| P1-B | 红点语义、store 改派生 | 0.5d | 低 | P1-A | ✅ 已完成 |
| P0 服务端 | refresh token、device_sessions 表 | 1d | 中 | 无 | ✅ 已完成 |
| P0 客户端 | Keychain 集成、SessionStore、通过 user_id 与 server_url 精确寻址唤醒重连 | 1.5d | 高 | P0 服务端 | ✅ 已完成 |
| P2 | server_url/vault_id 清理 | 0.75d | 低 | P0 | ⏸️ 暂缓（性价比较低） |
