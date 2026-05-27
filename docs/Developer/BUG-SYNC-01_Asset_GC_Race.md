# BUG-SYNC-01: Personal Sync 资产竞态删除 & 相关问题

> 发现时间: 2026-04-28  
> 发现场景: Phase 4/5 媒体 Embedding 功能测试  
> 优先级: P1（会导致用户数据丢失）  

---

## 问题 A：Asset GC 时序竞态（P1 — 数据丢失）

### 现象
用户删除旧笔记并创建新笔记引用同一资产文件时，资产被服务器误删。

### 复现步骤
1. 创建 `New test 02.md`，粘贴视频 → 引用 `assets/831af595...MP4`
2. 删除 `New test 02.md`
3. 创建 `new test 02.md`，引用同一 MP4
4. Sync 触发 → MP4 在客户端被删除

### 根因
```
Sync 1: 旧文件删除 push → 服务器立即执行 Asset GC → MP4 标记为孤儿
         🧹 [Safe GC Step 2] Marked 1 orphan asset(s) as deleted
Sync 2: 新文件尚未 push → 服务器不知道 MP4 仍被引用
         → negotiate 告知客户端删除 MP4
         → 客户端执行: Deleted local file: assets/831af595...MP4
```

### 修复方向
- **Asset GC 延迟窗口**: 资产标记孤儿后不立即删除，设置 grace period（如 5 分钟），在窗口内如果有新文件引用则取消删除
- 或：**push 阶段先上传文件，再处理删除**，确保新引用在 GC 之前到达服务器

### 影响文件
- `apps/server/src/routes/sync/push.rs` — Safe GC Step 2 逻辑
- `apps/server/src/routes/sync/negotiate.rs` — 孤儿资产判定

---

## 问题 B：Sync 删除指令缺少 UUID 校验（P2）

### 现象
删除 `New test 02.md`（UUID: aaa）后创建 `new test 02.md`（UUID: bbb），新文件被 Sync 误删。

### 根因
Negotiate 的删除指令**仅以路径标识文件**，不携带 UUID：
```
服务器删除指令: path = "00_Inbox/New test 02.md"  ← 只有路径
客户端收到后按路径匹配 → 匹配到新文件（不同 UUID）→ 误删
```
每个文件都有独立 UUID，即使路径完全相同也应能区分为不同文件。问题本质不是 macOS 大小写，而是**删除协议不校验文件身份**。

### 修复方向
1. Negotiate 删除指令增加 `file_uuid` 字段
2. 客户端执行删除前，读取本地文件的 UUID 进行比对
3. UUID 不匹配 → 跳过删除（说明是同路径的新文件）

### 影响文件
- `apps/server/src/routes/sync/negotiate.rs` — 删除指令构建，增加 UUID
- `apps/desktop/src-tauri/src/commands/sync/personal.rs` — 删除执行，增加 UUID 校验

---

## 问题 C：PostgreSQL 查询错误 — `column "content" does not exist`（P3）

### 现象
```
postgres | ERROR: column "content" does not exist at character 52
STATEMENT: SELECT COUNT(*)::BIGINT, COALESCE(SUM(octet_length(content))::BIGINT, 0::BIGINT),
           MIN(updated_at) FROM file_states WHERE vault_id = $1 AND is_deleted = true
```

### 根因
`file_states` 表没有 `content` 列。该查询可能是存储统计/GC 相关的残留代码，引用了已删除或从未存在的字段。

### 修复方向
- 搜索 `octet_length(content)` 定位查询位置
- 替换为正确的列名（可能是 `size` 或直接移除该统计）

### 影响文件
- 搜索 `apps/server/src/` 中包含 `octet_length(content)` 的 `.rs` 文件

---

## 验证标准

### 问题 A
- [ ] 删除引用资产的旧笔记 → 创建引用同一资产的新笔记 → Sync 后资产仍在
- [ ] 确认 Asset GC 不在同一 push 周期内立即生效

### 问题 B  
- [ ] 删除 `Abc.md` → 创建 `abc.md` → Sync 后 `abc.md` 仍在
- [ ] 仅在路径精确匹配时执行删除

### 问题 C
- [ ] `docker compose logs postgres` 不再出现 `column "content" does not exist`
