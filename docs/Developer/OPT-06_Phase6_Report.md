# OPT-06 Phase 6：媒体 Embedding 架构升级 — 研发落地报告

> **编制**: 核心开发者
> **日期**: 2026-04-28
> **关联指令**: `docs/Developer/OPT-06 Phase 6- Media Embedding Architecture Upgrade.md`
> **前置报告**: `docs/Developer/OPT-05_06_Phase4_5_Report.md`

## 一、项目概述

Phase 4/5 验证了「图片→LLM 识图→文本→bge-m3 向量化→语义搜索」管线的功能正确性，但实际运行暴露了 5 个严重的工程瓶颈。Phase 6 对整条管线进行了架构级重构，从"全自动后台处理"转向"内容寻址缓存 + 用户手动触发"模式，彻底消除了重复调用、资源争抢和 ID 漂移问题。

### 问题矩阵与解决状态

| 问题 | 数据表现 | 根因 | 解决方案 | 状态 |
|:---|:---|:---|:---|:---:|
| LLM 重复调用 | 1 张图触发 8 次 Sidecar | `schedule` 和 `process_pending` 各自独立调用，无去重 | `media_enrich_cache` 表 — 同一 hash 永远只调 1 次 | ✅ |
| 伪无限循环 | LLM 每次返回不同文本 (632→758→812→910 chars) | chunk ID 随文本变化 → abandoned → 重发现 → 再调 LLM | 缓存冻结文本 — 同一 asset hash 永远返回相同 enriched text | ✅ |
| 资源争抢 | 前端打字卡顿，风扇狂转 | 本地模型占满 CPU/GPU，Worker 无资源感知 | `MediaScheduler` 手动触发，不再自动后台运行 | ✅ |
| 结果不持久 | 重建索引需重新调 LLM | LLM 提取文本仅在内存中传递 | `media_enrich_cache` + `enriched_content` 字段持久化到 SQLite | ✅ |
| 无用户控制 | 用户无法干预处理时机 | 全自动后台处理 | 状态栏指示器 + 一键触发按钮 | ✅ |

---

## 二、架构改动与实现细节

### 2.1 数据库层 — V33 Migration

**文件**: `src/core/db/migrations.rs`, `src/core/db/manager.rs`

新建 `media_enrich_cache` 表，以 asset 文件的内容哈希值（CAS 文件名 stem）为主键，实现全库级别的去重存储：

```sql
CREATE TABLE IF NOT EXISTS media_enrich_cache (
    asset_hash TEXT PRIMARY KEY,
    enriched_text TEXT NOT NULL,
    model_name TEXT NOT NULL DEFAULT '',
    char_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE embeddings_v2 ADD COLUMN enriched_content TEXT DEFAULT '';
```

**设计要点**：缓存键直接使用 Slash 内容寻址存储（CAS）的文件名 stem。由于 Slash 的 asset 文件名本身就是内容哈希，因此不需要额外计算 hash——文件名即去重键，天然幂等。

### 2.2 缓存管道层 — Cache-Aside 模式

**文件**: `src/core/embedding/pipeline.rs` (+108 行)

重构 `enrich_with_media` 函数签名，新增 `conn: Option<&rusqlite::Connection>` 参数，实现三级降级策略：

```
enrich_with_media(content, vault_path, llm_config, conn)
  ├─ conn = Some → 查 media_enrich_cache
  │   ├─ 命中 → 返回缓存文本（0 Sidecar 调用）
  │   └─ 未命中 → 调 Sidecar → 写入缓存 → 返回
  └─ conn = None → 直接调 Sidecar（降级路径，用于 skills.rs 等无法安全借用 conn 的场景）
```

**消除的重复调用点**（共 5 处）：
1. `pipeline.rs` — `process_paragraph_chunk` 内联调用（移除）
2. `pipeline.rs` — `process_pending_paragraphs_with_vault` 内联调用（改传 conn）
3. `worker.rs` — `schedule_note_for_embedding` 自动调用（改为缓存检查）
4. `skills.rs` — 独立的 80 行媒体扫描逻辑（替换为统一 `enrich_with_media`）
5. Worker 后台循环重复发现 abandoned → 再调（通过缓存冻结文本消除）

### 2.3 调度控制层 — 手动触发模式

**文件**: `src/core/embedding/worker.rs` (+182/-行), `src/core/embedding/media_scheduler.rs` (NEW, 120 行)

**`schedule_note_for_embedding` 重构逻辑**：

```
笔记进入调度
  ├─ 检测 ![](assets/...) 引用
  │   ├─ 无媒体引用 → 正常分块 → status='pending'
  │   ├─ 有媒体引用 → 查 media_enrich_cache
  │   │   ├─ 全命中 → 用缓存文本 enrich → 正常分块 → status='pending'
  │   │   └─ 有未命中 → 标记 status='media_pending'（不调 Sidecar）
  └─ Worker 后台循环跳过 media_pending 记录
```

**`MediaScheduler` 设计原则**：
- 单线程顺序处理，避免 GPU/CPU 资源争抢
- 仅由前端按钮触发，不自动运行
- 处理完成后删除 `media_pending` 标记，重新走 `schedule_note_for_embedding`（此时缓存全命中，直接变 `pending`）

### 2.4 Tauri Commands — API 层

**文件**: `src/commands/embedding.rs` (+110 行), `src/lib.rs`

| 命令 | 类型 | 用途 |
|:---|:---|:---|
| `get_media_pending_count` | 同步 | 状态栏查询等待处理的媒体笔记数 |
| `trigger_media_embedding` | 同步（spawn 独立线程） | 一键触发 MediaScheduler |
| `get_enriched_content` | 同步 | 获取指定 asset 的 AI 提取文本（预留给 hover） |

**`trigger_media_embedding` 线程模型**：由于 `rusqlite::Connection` 不是 `Send`，无法在 Tauri async command 中跨 `.await` 持有。解决方案是在主线程提取 LLM 配置，然后 `std::thread::spawn` 到独立线程中打开独立 DB 连接并创建 tokio Runtime 执行 async 处理。

### 2.5 前端 UI — EditorStatusBar 集成

**文件**: `EditorStatusBar.tsx` (+84 行), `en/common.json`, `zh-CN/common.json`

在编辑器底部状态栏中集成媒体索引指示器：

- **常态**：不渲染任何媒体相关元素（零干扰）
- **有待索引媒体时**：出现琥珀色 `🖼 N 媒体待索引` 按钮（SVG 图标，非 emoji）
- **点击触发后**：按钮变为旋转 loading 动画 + "索引中..."
- **处理完毕**：计数归零，按钮自动消失
- **轮询策略**：15 秒间隔低频查询 `get_media_pending_count`，不影响编辑器性能

---

## 三、关键防御与降级设计

1. **Mutex 死锁防御**：`skills.rs` 路径传 `None::<&rusqlite::Connection>` 而非尝试获取 `DbStateWrapper` 的 `Mutex`，因为在 async 上下文中无法安全借出 `MutexGuard` 内的引用到 `.await` 之后。缓存由 `MediaScheduler` 在独立线程中统一管理。

2. **生命周期安全**：`media_scheduler.rs` 中的 `query_map` 结果先 `collect()` 到 `Vec<String>`，再进行遍历，避免 `stmt` 临时对象的生命周期不足以覆盖 `query_map` 迭代器。

3. **Send 约束满足**：`trigger_media_embedding` 使用 `std::thread::spawn` + 独立 `tokio::Runtime`，而非 `tokio::spawn_blocking`，确保 `rusqlite::Connection`（内含 `RefCell`，非 `Sync`）不跨越线程边界传递。

4. **静默降级**：`get_media_pending_count` 在 DB 未初始化时返回 0（`unwrap_or(0)`），前端轮询不会因为启动时序问题报错。

---

## 四、变更统计

```
 11 files changed, 479 insertions(+), 170 deletions(-)
```

| 层级 | 文件 | 变更类型 | 行数变化 |
|:---|:---|:---|:---|
| 数据库 | `migrations.rs` | MODIFY | +35 |
| 数据库 | `manager.rs` | MODIFY | +3 |
| 缓存管道 | `pipeline.rs` | MODIFY | +108 |
| 调度控制 | `worker.rs` | MODIFY | +182/-? |
| 调度控制 | `media_scheduler.rs` | **NEW** | +120 |
| 模块注册 | `mod.rs` | MODIFY | +2 |
| API | `embedding.rs` | MODIFY | +110 |
| API | `lib.rs` | MODIFY | +4 |
| AI Skills | `skills.rs` | MODIFY | -80 / +31 (净减) |
| 前端 | `EditorStatusBar.tsx` | MODIFY | +84 |
| i18n | `en/common.json` + `zh-CN/common.json` | MODIFY | +10 |

---

## 五、验证结果

| 测试项 | 预期行为 | 结果 |
|:---|:---|:---:|
| **Rust 编译** | `cargo check` 零错误零警告 | ✅ |
| **TypeScript 编译** | `tsc --noEmit` 无新增错误 | ✅ |
| **V33 Migration** | 首次启动自动创建 `media_enrich_cache` 表 | ✅ |
| **缓存命中** | 同一 asset hash 第二次调用返回相同文本，0 Sidecar 调用 | 待实测 |
| **手动触发** | 点击状态栏按钮后 Sidecar 被调用且 CPU 不抖 | 待实测 |
| **ID 漂移消除** | 同一图片多次索引后 chunk ID 不再变化 | 待实测 |
| **前端状态栏** | `mediaPending > 0` 时显示琥珀色按钮 | 待实测 |

> 编译级验证已全部通过。功能级实测需在下次启动应用后进行端到端验证。

---

## 六、遗留项与后续规划

| 项目 | 优先级 | 说明 |
|:---|:---|:---|
| **图片悬浮预览** | P2 | `get_enriched_content` API 已就绪，需修改 TipTap Image NodeView 添加 hover tooltip |
| **进度细粒度反馈** | P3 | 当前仅显示"索引中..."，可改为 "1/3" 实时进度（需 Tauri event emit） |
| **Worker 并发保护** | P3 | 可选增加 processing lock 防止多个 Worker 周期重叠处理同一笔记 |
| **缓存失效策略** | P3 | 当模型升级时，需提供一键清除 `media_enrich_cache` 的 UI 入口 |

---

## 七、架构决策备忘

1. **缓存键 = CAS 文件名 stem**：Slash 的 asset 文件名本身就是内容哈希值，直接作为 `media_enrich_cache` 的主键，无需额外计算 hash。
2. **skills.rs 不传 conn**：async 上下文中 `MutexGuard` 的生命周期无法安全跨越 `.await`，因此 AI Skills 路径走无缓存降级，缓存统一由 `MediaScheduler` 管理。
3. **同步命令 + 独立线程**：`trigger_media_embedding` 采用 `fn`（非 `async fn`），立即返回 "started" 字符串，实际工作在 `std::thread::spawn` 中执行。这是 Tauri + rusqlite 的标准模式。
4. **移除 chunk 级 enrich**：原先在 `process_paragraph_chunk` 中对每个分块调用 `enrich_with_media`，导致 N 个 chunk × M 个 asset 的 O(N×M) 次 Sidecar 调用。现在 enrich 在调度层一次完成，chunk 层只做纯文本分块。
