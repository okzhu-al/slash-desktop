# OPT-07: 启动日志审计 & 优化计划

> **审计日期**: 2026-04-30  
> **审计范围**: 应用启动 → 稳态同步（09:57:25 ~ 10:36:16）  
> **Vault 状态**: 4 个可同步文件（含 2 个超大 MP4），1 个空 Team Vault

---

## 一、已修复的关键 Bug

### BUG-SYNC-ASSET-01: ImportService 写入错误的 frontmatter 字段名

**严重度**: 🔴 Critical（导致附件永久丢失）

**根因**:  
`ImportService.ts` 在 `importFile()` 和 `importUrl()` 中生成的 frontmatter 使用了 `id:` 字段，但同步系统的 UUID 提取函数 `extract_slash_id_from_content`（`slash-core/src/lib.rs:307`）只识别 `slash_id:` 前缀。

**致命链路**:
```
ImportService 写入 id: "xxx"
  → 服务端 push.rs 读取 file_id = None
  → file_assets 注册被跳过
  → GC Step 2 标记附件为 orphan
  → negotiate 的 allowed_asset_paths 不含该附件
  → 附件永久丢失
```

**修复文件**:
- `apps/desktop/src/services/ImportService.ts` — `id:` → `slash_id:`（两处）
- Vault 中 10 个历史笔记的 frontmatter 批量修正

---

### BUG-SYNC-ASSET-02: CAS 优化被 max_file_size 过滤截断

**严重度**: 🟠 High（导致超大文件每次重启都被重新下载）

**根因**:  
`scan_directory_manifests`（`slash-core/src/lib.rs`）中，`max_file_size` 的 size 过滤（第 221 行）在 assets CAS 快捷路径（第 236 行）**之前**执行。assets 目录下的文件用文件名当 hash（零 IO），根本不需要受 size 限制，但 71MB 的 MP4 在 size 过滤阶段就被 `continue` 跳过了。

**致命链路**:
```
scan_directory_manifests(root, Some(50MB))
  → 71MB MP4 在 size 过滤处被 continue
  → manifests 不含该 MP4
  → client_files 不含该 MP4
  → 服务端认为客户端缺失 → client_needs=1
  → 每次重启下载 71MB + 253MB
```

**修复**:  
将 assets CAS 判断移到 size 过滤**之前**。修复后执行顺序：

```rust
// 修复后：
let size = metadata.len();
// 1️⃣ 先走 CAS 快捷路径（零 IO，不受 size 限制）
if relative.starts_with("assets/") { 
    results.push(FileManifestBasic { content_hash: file_stem, ... });
    continue;
}
// 2️⃣ 再做 size 过滤（只影响需要读取内容的非 assets 文件）
if size > limit { continue; }
```

**修复文件**:
- `packages/slash-core/src/lib.rs` — 调换 size 过滤与 assets 判断的顺序

---

## 二、启动时序审计（逐段分析）

### Phase 1: 初始化序列（09:57:25）✅ 正常

```
PARA 目录检查 ×6 → FTS5 健康检查 → AI Provider 加载 → Watcher 启动
```

- 启动耗时约 7 秒（主要花在 AI provider 异步加载）
- `⚠️ No API key found in Keychain` 是正常的——此时还未加载 provider 配置

### Phase 2: AI 引擎预热（09:57:32）⚠️ 有问题

| 子系统 | 行为 | 状态 |
|--------|------|------|
| EmbeddingWorker | 启动后台线程 | ✅ |
| GhostLink | 查询 `大文件.md` 的相似笔记 | ⚠️ 见 OPT-07-A |
| Orchestrator | `on_open` 触发，`hash_changed=false` | ⚠️ 见 OPT-07-B |
| PersonalSync | `client_files=4, deleted_paths=0` ×3 | ✅（但 3 次重复） |

### Phase 3: 重复初始化（09:57:43）⚠️ 浪费

**与 Phase 1 完全相同的序列在 18 秒后重跑了一遍**。包括：
- PARA 目录检查 ×6
- AI Provider 加载
- GhostLink 查询（`req_id=1`）
- Orchestrator `on_open`
- Watcher 重启（`Started` + `Event handler stopped`）

**原因推测**: React 组件生命周期中 vault 被重新挂载，可能来自：
1. React StrictMode（开发模式 double-mount）
2. Sync 完成后触发的 vault reload
3. 前端路由/状态管理导致的 provider 重挂载

### Phase 4: 同步 + 向量化（09:57:55 ~ 09:59:03）⚠️ 重复计算

**正常部分**:
- TeamSync: 空 vault，`server_needs=0, client_needs=0`
- PersonalSync: `client_files=4`，大文件修复已生效
- EmbeddingWorker 第一轮: 正确处理 1 个 pending paragraph

**问题部分**:
- 09:58:43 Idle 触发 `hash_changed=true`（但内容未变）
- Scheduler 的孤儿清理删除了刚生成的向量
- 09:59:03 同一个 paragraph 被重新向量化

### Phase 5: 稳态轮询（09:59:27+）✅ 功能正常

- TeamSync + PersonalSync 周期性执行
- 间隔: 初期 ~90s → 之后固定 20-30s
- 所有轮次 `server_needs=0, client_needs=0`，纯空转

---

## 三、优化项清单

### OPT-07-A: GhostLink product_type 查询不兼容

**现状**: GhostLink 查询只接受 `product_type IN ('note_profile', 'paragraph')`，但 `大文件.md` 的向量记录 `product_type = 'text'`（媒体 enrichment 产出的类型），导致 `No embedding yet`。

**影响**: 含媒体的笔记无法参与 GhostLink 语义推荐。

**修复方案**: 在 `ghostlink.rs:154` 的 SQL 中添加 `'text'` 到 IN 列表。

**关键代码**:
```rust
// ghostlink.rs:154
AND product_type IN ('note_profile', 'paragraph')
// 改为:
AND product_type IN ('note_profile', 'paragraph', 'text')
```

**涉及文件**:
- `apps/desktop/src-tauri/src/core/ai/skills/ghostlink.rs` — `find_similar_notes_v2()` 中的两处 SQL

---

### OPT-07-B: on_open 不保存 tracking 导致 Idle hash 误判

**现状**: `trigger_ai_orchestrated` 中，`hash_changed=false` 时不保存 `_tracking` 状态（第 485 行 `if hash_changed`）。当双重初始化导致 DB 状态不一致时，后续 Idle 触发会误判 `hash_changed=true`，进而触发不必要的向量重算。

**影响**:
1. 同一段落被向量化两次（09:58:03 和 09:59:03）
2. Scheduler 的孤儿清理误删有效向量

**修复方案**: `on_open` 时，即使 `hash_changed=false`，也应保存 tracking 状态（至少更新 timestamp），确保后续 Idle 不会误判。

**关键代码**:
```rust
// orchestrator.rs:485
// 修改前: if hash_changed { save tracking }
// 修改后: always save tracking (idempotent upsert)
```

**涉及文件**:
- `apps/desktop/src-tauri/src/commands/ai/orchestrator.rs` — `process_fast_job()` 末尾的 tracking 保存逻辑

---

### OPT-07-C: 孤儿 chunk 清理过于激进

**现状**: `EmbeddingScheduler::schedule_blur()` 或 `schedule_idle()` 中的孤儿清理逻辑会删除"不在当前 chunk 列表中"的 embeddings_v2 记录。但如果 EmbeddingWorker 后台刚刚完成了一个 chunk 的向量化，Scheduler 可能因为时序差将其视为孤儿删除。

**影响**: 刚计算好的向量被删除，导致下一轮 Worker 重算。

**修复方案**:
1. 孤儿清理应排除最近 N 秒内创建的记录（grace period）
2. 或改为：只删除 `status = 'pending'` 的孤儿，保留 `status = 'completed'` 的记录

**涉及文件**:
- `apps/desktop/src-tauri/src/core/embedding/scheduler.rs` — 孤儿清理逻辑

---

### OPT-07-D: 双重初始化（启动时整套流程跑两遍）

**现状**: 应用启动后，PARA 检查 + AI 配置 + GhostLink + Orchestrator + Watcher 完整序列被执行了两次（09:57:25 和 09:57:43）。

**影响**: 启动时间延长，两次 GhostLink 向量计算，两次 Orchestrator 调用。

**修复方案**:
1. 检查前端 vault 初始化流程，确认是否有重复挂载
2. 如果是 React StrictMode 导致，在 production build 中不会出现
3. 如果是 sync 回调导致的 reload，添加防抖/去重

**涉及文件**:
- 前端 vault provider / `useVaultConnection.ts` / App.tsx 初始化逻辑

---

### OPT-07-E: 空 Team Vault 仍执行 negotiate

**现状**: TeamSync 每次都执行完整的 negotiate 流程（HTTP 请求），即使 `mapped_files=0` 且历史上从未有过文件。

**影响**: 每 20-30 秒一次无意义的 HTTP 请求。

**修复方案**:
```typescript
// 快速跳过：如果上次同步结果也是空且无变化，直接跳过
if (lastTeamFileCount === 0 && currentTeamFileCount === 0) {
    return; // Skip negotiate
}
```

**涉及文件**:
- `apps/desktop/src-tauri/src/commands/sync/team.rs` 或前端同步调度器

---

### OPT-07-F: 稳态同步间隔过于频繁

**现状**: 用户完全空闲时（无编辑、无文件变更），同步仍以 20-30 秒间隔执行。

**影响**: 不必要的 CPU 使用（文件系统扫描）和网络请求。

**修复方案**: 实现指数退避策略：
```
有变更 → 立即同步 → 30s → 30s → 30s...
无变更 → 30s → 60s → 120s → 300s (cap at 5min)
检测到变更 → 重置为 30s
```

**涉及文件**:
- `apps/desktop/src/services/AutoSyncManager.ts`

---

### OPT-07-G: `vault_id` 状态条目日志噪音

**现状**: 每次 PersonalSync 都会打印 `⚠️ 1 state entries not on disk: 'vault_id' personal_hash_empty=true`。这是一个内部标记条目，不代表真实文件，无害但增加日志噪音。

**影响**: 日志可读性降低，可能在排查问题时造成干扰。

**修复方案**: 在打印前过滤掉 `vault_id` 条目，或将其日志级别降为 `debug`。

**涉及文件**:
- `apps/desktop/src-tauri/src/commands/sync/personal.rs` — state entries 日志过滤

---

## 四、优先级排序

| 优先级 | 编号 | 问题 | 修复复杂度 | 影响范围 |
|--------|------|------|------------|----------|
| P0 | OPT-07-A | GhostLink product_type | 1 行 SQL | 媒体笔记无法推荐 |
| P0 | OPT-07-B | Idle hash 误判 | ~5 行 | 每次启动重复向量化 |
| P1 | OPT-07-C | 孤儿清理过激 | ~10 行 | 向量被误删重算 |
| P2 | OPT-07-D | 双重初始化 | 需前端调查 | 启动速度 |
| P2 | OPT-07-E | 空 Team negotiate | ~5 行 | 网络开销 |
| P2 | OPT-07-F | 同步间隔退避 | ~20 行 | CPU/网络开销 |
| P3 | OPT-07-G | vault_id 噪音 | 1 行 | 日志可读性 |

---

## 五、验证清单

- [x] BUG-SYNC-ASSET-01: JPEG 不再消失
- [x] BUG-SYNC-ASSET-02: 超大 MP4 不再重复下载
- [x] OPT-07-A: 媒体笔记能出现在 GhostLink 推荐中（`product_type IN` 增加 `'text'`）
- [x] OPT-07-B: Idle 不再误判 hash_changed（`_tracking` 无条件 upsert）
- [x] OPT-07-C: 刚生成的向量不被孤儿清理删除（60s grace period）
- [ ] OPT-07-D: 启动时不重复执行初始化序列（暂缓 — 需 production build 验证）
- [ ] OPT-07-E: 空 Team Vault 跳过 negotiate（暂缓 — 避免破坏成员首次 pull）
- [x] OPT-07-F: 空闲时同步间隔 ≥ 60s（已优化为 PERIODIC_MS=5min）
- [x] OPT-07-G: vault_id 不再出现在日志中（过滤伪路径）
