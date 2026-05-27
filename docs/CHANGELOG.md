# Slash 版本记录 (CHANGELOG)

> 本文件记录 Slash 各版本的核心变更。每次大版本迭代后需及时更新。

---

## v9.0 — Team Edition: Collaboration & Sync V3 *(2026-03)* ✅

**目标**：从个人的单机增量云同步网盘，彻底跃迁为异步网络协作流转平台。

### 核心功能与架构
- **协作共识引擎 (轻量异步)**：确立了「直接同步合并 + 段落级锚定批注 + 全局轻量评论 + 快照版本线」为核心范式。果断移除了阻碍文档流转的 Git-style 文档级 PR 审批流。
- **RBAC 五角色权限体系**：重构了 Admin (全局) / Owner (目录级) / Team-members (目录级) / Editor (文件级) / Observer (全局只读) 精细管控网络。
- **快照版本线系统 (Snapshot)**：构建 `draft → review → approved → frozen` 文档生命周期状态机。集成时间轴管理，提供状态冻结与一键抗干扰极速回退 (Revert)。
- **段落级文档批注系统 (Annotation)**：实现划词即刻生成嵌套式回复流，深度整合至 TipTap Extension (`AnnotationMark`)，评论状态完美随文本漂移。
- **单/双空间视觉与架构隔离**：严守「协作特性 UI 仅在团队空间显影」的神圣隔离规则。引入紫/蓝色源追溯角标（Promoted vs Synced），实现了 Team_Alpha 等全大写 PARA 目录的健壮倒排映射体系。
- **属性级无损旁路同步 (Task Bypass)**：创新的 Task Checkbox Toggled 旁路机制，绕过繁重的文本冲突验证树，使用行号与 Hash 双重锚定，实现毫秒级状态同步。
- **企业级会话防线机制**：Tauri 深度桥接 OS Native Keychain，全面干掉 localStorage 明文存储软肋；服务器级强化设备越权防御，实装「一键记住我」的绝对安全态解法。
- **Lint Zero-Base 与重构战役**：完美剥离拆解长达 1600+ 行的 `sync.rs` 与 `team.rs` 历史巨石（Monolith），分形拆解至高度内聚的子模块结构，保持骄傲的 0 编译警告。
- **云端接入扩展**：完成 `S3FileStorage` 驱动构建，支持云端 S3 / Minio 替代方案。

---

## v8.0 — Community Edition: Server & Sync *(2026-02 ~ 2026-03)* ✅

**目标**：构建 Rust Axum 服务端，实现 Personal Space 端云增量同步 + Docker 一键部署。

### 新增
- **Slash Server** (`apps/server/`)：Axum 0.8 + PostgreSQL + JWT 鉴权，监听 `0.0.0.0:3721`
- **Slash Sync Protocol** (`slash-sync-proto`)：完整 Merkle 差异协商 + 三步握手 (negotiate → push → pull)
- **自动同步 5 触发器**：文件变更 (debounce 2s) / 启动 (3s) / 前台恢复 (>60s) / 定时 (5min) / 退出 flush
- **离线队列**：网络错误时 dirty_queue 保留，`online` 事件自动恢复同步，侧边栏 WifiOff 图标
- **Token 自动刷新**：Server `POST /api/auth/refresh` (7天宽限期)，Desktop 401 → 自动刷新 → 重试
- **编辑中文件保护**：Pull 时跳过正在编辑的文件，避免冲突
- **Pull 后实时刷新**：`sync:pulled` 事件通知编辑器重载当前笔记
- **Per-Vault 配置隔离**：切换 Vault 时自动切换同步配置上下文
- **同步 UI**：Settings Sync Tab (Server URL / 邮箱密码 登录注册)，侧边栏 6 态指示器 (idle/syncing/success/error/disabled/offline)
- **Docker 部署**：`docker-compose.yml` 一键启动 PostgreSQL + Slash Server + MarkItDown Sidecar
- **Server Dockerfile**：两阶段 Rust 构建 (rust:latest → debian:bookworm-slim)
- **MarkItDown Sidecar** (`apps/python-sidecar/`)：FastAPI + markitdown，POST /parse 支持 21 种格式 (PDF/Word/Excel/PPT/HTML/图片/音频等)
- **文件导入功能**：侧边栏 FileUp 按钮 → 选择文件 → Sidecar 转换 → 00_Inbox 创建笔记
- **Tauri Sync Commands** (`commands/sync.rs`)：`sync_vault` / `check_sync_connection`
- **Merkle Hash 算法** (`slash-core`)：`calculate_directory_hash` + `scan_directory_manifests`

### 修复
- `scan_directory_manifests` 隐藏文件过滤器改用相对路径
- Client/Server 目录路径双斜杠 Bug
- `ensure_vault` 幂等化 (ON CONFLICT DO UPDATE)，支持重建数据库后复用 vault_id
- Sync router 独立 body limit (DefaultBodyLimit::disable)，解决 nested 路由 413 问题
- SyncTab `vaultPath` 传递链修复 (App → SettingsModal → SyncTab)

### 数据库迁移
- PostgreSQL: `users`, `vaults`, `file_states`, `sync_logs` 四表

> 详细方案见 [phase_2_server_sync_plan.md](./phase_2_server_sync_plan.md) | 架构记录见 [sync_architecture.md](./sync_architecture.md) | Phase 3 路线图见 [phase_3_team_roadmap.md](./phase_3_team_roadmap.md)

---

## v7.4.x — PARA 分类引擎精炼 *(2026-02)*

**目标**：提升 AI 分类准确率与 UX 稳定性。

### 新增
- **解耦决策架构**：LLM 仅负责语义判断（PARA 类别 + 学科名），文件操作由确定性 Rust 后端仲裁
- **领域词典归一化** (`domain_dictionary.rs`)：20+ 学科、关键词模糊映射，防止文件夹名碎片化
- **Placeholder 提示词模式**：使用抽象标签 `[DOMAIN_NAME]` 替代具体示例，抑制 LLM 偏向

### 修复
- **Contextual Panel Handoff (Pattern 67)**：离开 Inbox 时自动切回 Local Graph，解决"过期面板"问题
- **Deep Directory Path Guardrails**：强制 LLM 返回完整 PARA 路径，修复路径截断
- **Lint Zero-Base**：Rust 后端活跃逻辑路径 100% 零警告

---

## v7.0 — 稳定化与基础设施基线 *(2026-02)*

**目标**：从激进功能扩张转向系统性 Bug 修复与文档对齐。

### 核心稳定化 (BUG-006 ~ BUG-020 全部已修复 ✅)

| Bug ID | 问题 | 方案要点 |
|--------|------|----------|
| BUG-006 | Task Item 拆分/序列化结构间隙 | Block Aggregation + 自定义结构序列化器 |
| BUG-007 | 表格内复制粘贴出现递归嵌套 | HTML 消毒 + 高优先级拦截 Hook |
| BUG-008 | 表格内 Markdown 语法意外转换 | Context-Aware Rule Wrapping |
| BUG-009 | 切换笔记后多行换行丢失 | 移除破坏性正则 `\n{3,} -> \n\n`，确立不干涉原则 |
| BUG-010 | 多行 Task Item 中 Checkbox 垂直居中偏移 | `flex-start` + `0.3rem` margin-top |
| BUG-011 | 跨 Vault 切换时笔记状态泄漏 | Per-Vault 持久化 + Triple-Guard 资源解析 + `clearRoot()` |
| BUG-012 | 启动时未恢复上次 Vault | `slash-last-vault` localStorage + Tauri `stat` 验证 |
| BUG-013 | 单空格误触 Task 属性菜单 | 双空格 500ms 窗口触发 |
| BUG-014 | 设置模态框被滚动条穿透 | z-index 提升至 `z-[100]` |
| BUG-015 | 全局选择样式不一致 | Opacity-to-Color 迁移 + 结构遮罩 + Ring 禁用 |
| BUG-016 | Ollama 连接状态不透明 | TitleBar 脉冲交通灯指示器 (绿/琥珀/红) |
| BUG-017 | Task Item 双重 Bullet 回归 | 剥离 taskItem 序列化器的重复前缀 |
| BUG-018 | 重启后笔记"弹回"旧文件 | Immediate Persistence Parity |
| BUG-019 | 零宽空格阻断 TaskItem InputRule | 加载时清洗 `\u200B`，存储时保留 |
| BUG-020 | CJK 格式标记偏移 | patch-package 补丁禁用 CommonMark flanking 规则 |

### 其他改进
- Embedding Worker 维护自治化（5m 冷却重试、10m 放弃剪枝），退役手动 "Retry/Cleanup" 按钮
- AI Skill 日志统一为结构化终端格式
- 文档标准化：`docs/` 目录三支柱覆盖要求 (Architecture, Data, Function)

---

## v6.0 — 增强发现与搜索 *(2026-01)*

**目标**：从检索迈向合成，打造世界级 RAG 和发现体验。

### 新增
- **分页搜索 UI**："搜索结果" 与 "AI 回答" 双 Tab 布局，零点击 Deep Search
- **In-Note 搜索 (Cmd+F)**：ProseMirror Decoration 高亮 + 匹配计数器 + Enter/Shift+Enter 导航
- **Embedding v2 基础设施**：三级向量产品 — P0 段落 / P1 笔记档案 / P2 摘要
- **搜索 V2 整合**：语义搜索 + HyDE 扩展迁移至 V2 索引，混合权重 (0.4 关键词 / 0.6 语义)
- **GhostLink Discovery V2**：相似性发现迁移至 V2 索引，优先使用 P1 Profile

### 修复
- Zombie 向量防护：Orchestrator 短内容清除时执行 Atomic Purge
- 孤儿向量回收：EmbeddingWorker 自动清理已删除笔记的残留向量
- Worker Retry Latch：修复全量失败状态下后台循环停滞

---

## v5.0 — 稳定化、清洁与语义完整性 *(2026-01)*

**目标**：强化 "Markdown-First" 数据层，执行严格的结构清洁与 AI 门控。

### 新增
- **结构清洁模式**：空 taskItem 自清理 + 序列化后正则清理 (`- [ ]` 语法碎片)
- **语义密度过滤**：`extract_meaningful_content` 基于有效文本长度门控 AI Skill
- **AI 炼狱清扫**：内容删除/低于阈值时自动清除过期 AI 元数据

### 修复
- 持久化时序竞态：清洁逻辑移入序列化周期

---

## v4.0 — 前端重构 *(2026-01)*

**目标**：将 `Editor.tsx` 从 God Object 重构为 Logic-Free View。

### 核心变更
- **Hook Suite 提取**：100% 异步业务逻辑抽入专用 Hooks (`useEditorEvents`, `useAIIdle`, `useFileDrop`, `useContentPersistence`, `useNoteData`, `useSlashEditor`, `useNoteContent`)
- **Editor.tsx 瘦身**：818 行 → 277 行 (66% 缩减)，达到 "Dumb View" 状态
- **Zero-Extraction Policy**：前端仅发送原始 Markdown，元数据提取全部下沉至 Rust 后端
- **Sanitize-Parse-Lock 三阶加载管线**：防止保存循环反馈与段落坍缩

---

## v3.0 — 后端重构 *(2026-01)*

**目标**：完成接口层的高可扩展性与领域清晰度。

### 核心变更
- **AI 子模块化**：1300+ 行 `commands/ai.rs` 拆分为 6 个领域模块 (skills, data, ghostlink, relations, feedback, service)
- **GhostLink 规则优化**：Top-K=5 + 目录邻近排除 (Radius 1) + Inbox 特权区
- **三代架构定型**：Entry Point → Interface Layer → Core Layer
- **`lib.rs` 复杂度降低 95%**：2179 行 → ~110 行

---

## v2.0 — 知识插件 (Phase 2) *(2026-01)*

**目标**：从通用编辑器转型为专业知识工具。

### Phase 2.1: WikiLink 体验升级
- WikiLink React NodeView 迁移 + 未解析链接虚线提示
- Link Hover Preview (AI 摘要 / 300ms 防抖)
- Local Knowledge Graph (右侧栏力导向图)
- Inline Attribute Links (`Key:: [[Value]]` 语法)
- Section Backlinks (标题级反向链接徽章)
- Context-Aware Triggers (代码/数学块内禁止触发)

### Phase 2.2: 后端重构 & AI 集成
- Tauri 后端三层架构重构 (95% lib.rs 瘦身)
- 四态 AI 策略 (Open/Active/Idle/Blur) + Hash/Delta 门控
- GhostLink 推理优化 (防御式 JSON 提取 + 源上下文完整性)
- Split-Authority 同步策略 (即时基线 + 保留审阅)

### 内部插件
- Kanban 看板 (PARA 子目录映射 + 跨列拖拽)
- Task 系统 (Content-Keyed Write-back + V14 扫描协议)

---

## v1.0-core-freeze — 核心冻结 *(2026-01-15)*

**里程碑**：核心编辑器与桥架构宣布稳定并冻结。

### 稳定化冲刺
- 配置隔离：扩展工厂 `createEditorExtensions()` 替代内联定义
- I/O 解耦：Editor.tsx 零直接 FS 调用
- macOS RC 测试 100% 通过 (含快捷键 Reactive Global Listener 热修复)
- 跨平台路径审计 (`pathUtils.ts` 集中化)
- Slash 命令国际化 (i18n)

### 冻结模块
TipTap 扩展 / 序列化器 / 编辑器配置 / 存储层 / 标签系统 / 文件系统 / SQLite 数据库

---

## Phase 1 — 核心基础 *(2025-12 ~ 2026-01)*

**目标**：建立像素级 UI 和健壮的文件系统编辑器基础。

- TipTap / ProseMirror 深度集成
- 自定义 TitleBar (macOS) + Inter/PingFang 排版
- WikiLink `[[note]]` 实时自动补全
- 安全媒体管线 (hash 去重 + 可调节大小节点)
- Math/Mermaid 渲染 (Backspace-to-Edit 回退)
- SQLite 元数据持久化 + Rust 文件系统实时监控
- 侧边栏多层排序 (PARA 优先 + 自然排序)
- Editor Breathing Space (50vh 底部填充)

---

## Team Edition Monorepo 迁移 (Phase 1) *(2026-02)*

**目标**：无痛安全地将 Slash 迁移至 Monorepo 架构，为 Team Edition 铺路。

### 已完成 ✅
- Step 1: Monorepo 根基盘 (`pnpm-workspace.yaml` + `Cargo.toml`)
- Step 2: 物理搬家 → `apps/desktop/`
- Step 3: `@slash/shared-types` 前端类型包
- Step 4: `slash-core` Rust 共享算法包 (hash, JSON 提取, 内容过滤等)
- Step 5: `@slash/editor-core` TipTap 编辑器核心包 (结构搬家完成，Tauri 解耦待完善)
- `slash-sync-proto` 占位骨架创建

### 迁移后 Bug 修复轮 ✅
- Phase 1 造成的路径引用误伤全部修复
- 个人客户端使用恢复正常
