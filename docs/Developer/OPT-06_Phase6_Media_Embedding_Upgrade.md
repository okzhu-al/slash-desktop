# OPT-06 Phase 6: 媒体 Embedding 架构升级

> 优先级: P0  
> 前置依赖: Phase 4/5 已合并  
> 预计复杂度: 中-高（跨 Rust/前端/数据库三层）

## 问题摘要

当前媒体 Embedding 管线存在以下缺陷（Phase 4/5 测试数据）：

- **1 张图片被 LLM 调用 8 次**（应为 1 次），耗时 4 分 28 秒（应 < 1 分钟）
- **LLM 每次返回不同文本** → chunk ID 漂移 → abandoned → 重发现 → 伪无限循环
- **Local 模型处理时 CPU/GPU 满载**，前端打字卡顿
- **LLM 结果不持久化**，重建索引需重新调用

## 核心设计决策

| 项目 | 决策 |
|:---|:---|
| 触发方式 | 手动。笔记底部状态栏（字数统计旁）显示「📎 N 个媒体待索引」，点击控制 |
| 模型选择 | 遵循笔记所在目录 `.slash-folder.yml` 的 LLM 来源配置 |
| 结果存储 | `embeddings_v2.enriched_content` + `media_enrich_cache` 表 |
| 前端展示 | 鼠标悬停媒体时浮窗展示 LLM 语义描述 |

## 实施范围

### Rust 后端
1. `media_enrich_cache` 表：以 asset hash 为键缓存 LLM 结果，跨笔记复用
2. `embeddings_v2` 新增 `enriched_content TEXT` 字段
3. `enrich_with_media` 集成缓存查询（命中 → 0 次 Sidecar）
4. Worker 单实例保护，媒体未缓存时标记 `media_pending`（不自动处理）
5. 新增 `MediaScheduler`：用户触发后逐个处理，支持暂停/恢复
6. 新增 Tauri commands: `get_media_pending_count`, `trigger_media_embedding`, `get_enriched_content`

### 前端
1. 笔记底部状态栏：媒体索引计数 + 操作按钮
2. 处理进度指示器（处理中/暂停/完成）
3. 媒体悬浮预览组件：展示 enriched_content

### 详细方案
完整实施计划见：[implementation_plan.md](file:///Users/junior/.gemini/antigravity/brain/fe6822c3-5d8e-4afa-b535-b2c77c9e9584/implementation_plan.md)

## 验证标准
- 1 张图 = 1 次 LLM 调用（缓存后 0 次）
- 处理期间前端打字无卡顿
- 搜索可命中图片中的语义内容
