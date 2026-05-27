# Phase 3: Team Version 完成评估报告（修订版 v4）

> 评估时间：2026-03-22  
> 基于代码深度扫描 + Phase 3 全周期实际交付物盘点  
> **重要说明**：本版本反映 2026-03-19 协作系统重大架构重构后的真实状态。PR 审阅流转系统已被彻底废弃并清除，替换为批注 + 评论 + 快照版本线的轻量级协作范式。

---

## 架构转向说明

### 废弃：PR 审阅流转（Phase 3 旧 Step 3）

原 Phase 3 Step 3 实现了 Git 分支式 PR 审阅流程（非 Editor 修改 → 创建 PR → Diff 审阅 → Approve/Reject），经过 6 个版本迭代后，评估结论为：

> **PR + Diff 审阅模式在文档协作中属于"过度工程化"**。代码协作范式解决文档协作问题，在技术实现（ProseMirror 嵌套 dispatch、节点映射）和用户体验（修改被卡住等待审阅）两个维度均遇到根本性障碍。

**已清除代码（2026-03-21 清理）：**
- `routes/pr.rs`（369 行）
- `slash-sync-proto` PR 相关 Structs（~75 行）
- `permission.rs` PR 辅助函数 `resolve_reviewer`、`normalize_directory_path`（~54 行）
- `sync.rs` `inject_contributor`（96 行）+ `SyncPushResponse.pr_created` 字段
- `models.rs` `PullRequestRow`（20 行）

### 替代：共识生产系统（Phase 3 重构版）

采用「**直接同步 + 批注 + 轻量评论 + 快照版本线**」的轻量级协作范式：

```
同步层：个人 ↔ 团队双向同步（直接合并），无审批卡点
批注层：段落级锚定批注，支持嵌套回复 + 状态追踪（resolved）
评论层：文档级浮动评论，快速低成本交流
版本层：同步触发快照 + 手动冻结，支持一键回退
文档生命周期：draft → review → approved → frozen 状态机
```

---

## 总览

| 模块 | Server 端 | Desktop 前端 | 综合 |
|------|-----------|-------------|------|
| 团队基础设施 + RBAC | ✅ | ✅ | ✅ |
| 混合 Diff 引擎 | ✅（保留，用于 future） | — | ✅ |
| **PR 审阅流转（废弃）** | 🗑️ 已清除 | 🗑️ 已清除 | 废弃 |
| S3/Minio 存储 | ✅ | — | ✅ |
| Task 属性级旁路同步 | ✅ | ✅ | ✅ |
| **快照版本系统（新）** | ✅ | ✅ | ✅ |
| **文档批注系统（新）** | ✅ | ✅ | ✅ |
| **文档评论系统（新）** | ✅ | ✅ | ✅ |
| **文档生命周期状态机（新）** | — | ✅ | ✅ |

---

## 原有模块完成清单

### Step 1: 团队基础设施 + RBAC ✅

| 组件 | 文件 | 状态 |
|------|------|------|
| DB Schema | `migrations/002_team_rbac.sql` | ✅ team_members + directory_permissions + invitations + file_states |
| 权限判定引擎 | `permission.rs` | ✅ `resolve_effective_role` / `ensure_team_permission` / `is_file_editor` / `validate_team_directory_name` / `get_sync_scope_filter` / `is_path_in_sync_scope` |
| 团队管理 API | `routes/team.rs` | ✅ create / invite / join / list_members / update_member_role / reset / my-scope / get_directory_permissions / set_directory_permissions |
| Vault 访问校验 | `permission.rs` | ✅ Personal(owner) + Team(member) 双模式 |
| Sync Scope 隔离 | `permission.rs` | ✅ Admin 同步范围限制，精确目录匹配 |
| Admin 密码重置 | `routes/auth.rs` | ✅ `POST /auth/admin-reset` |
| 配对码 Admin 前置校验 | `routes/server.rs` | ✅ `POST /server/request-new-code` 非 Admin 拒绝 |
| SyncTab 完整登录流程 | `desktop/*` | ✅ 连接 / 注册 / 重置管理员密码 / 错误提示 |

### Step 2: 混合 Diff 引擎 ✅（保留）

| 组件 | 文件 | 状态 |
|------|------|------|
| Diff 算法 | `slash-core/src/diff.rs`（506 行） | ✅ `compute_diff` + `compute_semantic_diff` |
| 结构化保护 | 同上 | ✅ CodeFence / Frontmatter / Tldraw 整块保护 |
| API 端点 | `sync.rs /api/sync/diff` | ✅ `DiffRequest → DiffResponse` |
| 单元测试 | `diff.rs` | ✅ 8 个测试 |

### Step 4: S3/Minio 存储 ✅

| 组件 | 状态 |
|------|------|
| `FileStorage` trait | ✅ put / get / delete / exists / list |
| `LocalFileStorage` | ✅ |
| `S3FileStorage` | ✅ |
| `STORAGE_BACKEND` 环境变量切换 | ✅ |

### Step 5: Task 属性级旁路同步 ✅

| 组件 | 状态 |
|------|------|
| Server 端 `/api/sync/task-bypass` | ✅ |
| `TaskBypassDetector.ts` | ✅ |
| `AutoSyncManager.notifyCheckboxToggle()` | ✅ |
| line_number + line_content_hash 防偏移 | ✅ |

---

## 新增模块完成清单

### Phase 3.1: 快照版本系统 ✅

**后端** — `routes/snapshot.rs`（264 行）

| API | 端点 | 状态 |
|-----|------|------|
| 列出快照列表 | `GET /api/snapshot/list?vault_id=&file_path=` | ✅ |
| 获取快照内容 | `GET /api/snapshot/{id}/content` | ✅ |
| 回退到快照 | `POST /api/snapshot/{id}/revert` | ✅ 直接写入 file_states + storage |

**触发机制**：同步 push 时自动创建快照；DocStatusBar 手动冻结（`frozen`）时创意快照。

**前端** — `VersionTimeline.tsx`（317 行）+ `SnapshotService.ts`（100 行）

| 功能 | 状态 |
|------|------|
| 时间轴列表（类型标签：revert/freeze/sync） | ✅ |
| 快照内容预览 Modal | ✅ |
| 一键回退 + Toast 反馈 | ✅ |
| 回退后强制更新编辑器（绕过 isFocused 拦截） | ✅（`snapshot:reverted` 事件 + `__snapshotRevertPending` flag） |
| TitleBar "History" 按钮集成 | ✅ |

### Phase 3.2: 文档批注系统 ✅

**后端** — `routes/annotation.rs`（231 行）

| API | 端点 | 状态 |
|-----|------|------|
| 列出批注 | `GET /api/annotation/list?vault_id=&file_path=` | ✅ |
| 创建批注 | `POST /api/annotation/` | ✅ 含锚点 ID + 预览文本 |
| 解决批注 | `POST /api/annotation/{id}/resolve` | ✅ |
| 删除批注 | `DELETE /api/annotation/{id}` | ✅ |

**DB Schema**：`annotations` 表（vault_id / file_path / anchor_id / anchor_preview / author / content / parent_id / resolved）

**前端** — `AnnotationPanel.tsx`（360 行）+ `AnnotationService.ts`（114 行）

| 功能 | 状态 |
|------|------|
| 文字选中 → 批注输入框弹出 | ✅ |
| 批注气泡渲染（锚定到段落） | ✅ |
| 批注面板列表（含嵌套回复） | ✅ |
| 标记已解决 / 删除 | ✅ |
| 持久化（重启后加载渲染） | ✅ |
| 批注标记 TipTap Extension（`AnnotationMark`） | ✅ |
| TitleBar 批注按钮集成 | ✅ |

### Phase 3.3: 文档生命周期状态机 ✅

**前端** — `DocStatusBar.tsx`（约 170 行）

| 功能 | 状态 |
|------|------|
| `draft → review → approved → frozen` 状态机 | ✅ |
| 状态写入 YAML frontmatter `doc_status` 字段 | ✅ |
| 冻结时触发快照（快照类型 `freeze`） | ✅ |
| i18n 支持（docStatus 命名空间） | ✅ |
| 各状态 Tooltip 说明 | ✅ |
| Editor.tsx 集成（从 frontmatter 读取初始状态） | ✅ |

**状态定义**：

| 状态 | 语义 |
|------|------|
| `draft` | 草稿，自由编辑 |
| `review` | 审阅中，提示谨慎修改 |
| `approved` | 已批准，内容确认 |
| `frozen` | 已冻结，触发快照并锁定 |

### Phase 3.4: 文档评论系统 ✅

**后端** — `routes/doc_comment.rs`（178 行）

| API | 端点 | 状态 |
|-----|------|------|
| 列出评论 | `GET /api/comment/list` | ✅ |
| 创建评论 | `POST /api/comment/` | ✅ |
| 删除评论 | `DELETE /api/comment/{id}` | ✅ |

**前端** — `CommentPanel.tsx`（257 行）+ `CommentService.ts`（87 行）

| 功能 | 状态 |
|------|------|
| 文档级评论列表 | ✅ |
| 发表 / 删除评论 | ✅ |
| TitleBar 评论按钮集成 | ✅ |

---

## 右侧面板集成架构

`App.tsx` 统一管理 `rightPanelMode`，TitleBar 按钮切换：

```
rightPanelMode
  ├── 'tasks'          → TaskPanel
  ├── 'ghostlink'      → GhostLinkPanel（默认）
  ├── 'annotations'    → AnnotationPanel   ← Phase 3.2
  ├── 'versions'       → VersionTimeline   ← Phase 3.1
  ├── 'comments'       → CommentPanel      ← Phase 3.4
  └── 'classification' → ClassificationPanel
```

---

## 代码清洁状态

**本周清理（2026-03-21）：**

| 操作 | 内容 |
|------|------|
| 删除 | `routes/pr.rs`（369 行遗留 PR 系统） |
| 删除 | Proto PR Structs（`PRStatus` / `PullRequestInfo` 等 7 个类型，~75 行） |
| 删除 | `sync.rs inject_contributor`（96 行） |
| 删除 | `permission.rs resolve_reviewer + normalize_directory_path`（54 行） |
| 删除 | `models.rs PullRequestRow`（20 行） |
| 修复 | `markdownBridge.ts` CJK patch 告警（删除 require monkey-patch） |
| 修复 | **0 Rust 编译警告**（13 个 dead_code 警告全部消除） |
| 修复 | **0 TypeScript 编译错误** |

---

## 遗留问题

| # | 问题 | 优先级 | 状态 |
|---|------|--------|------|
| P-1 | docker-compose 缺 Minio 服务定义 | 低 | ❌ |
| P-2 | Revert 后 Personal Vault 被误 push | 中 | 🟡 观察中，依赖前端路由阻断 |
| P-3 | `storage.rs` Arc 类型不匹配 lint | 低 | ❌ |
| P-4 | Tauri callback id not found 热重载告警 | 无害 | 不可修复 |

---

## 新增：Phase 3.5 底层防线与体验抛光 (2026-03-29 落地)

### 1. 数据存储分级治理（安全与一致性闭环）✅
在基础功能联通后，团队针对同步可靠性和凭证安全性进行了深度重构：
- **操作审计拆分**：彻底解耦“消费游标（`consumed_seq`）”与“已读游标（`read_seq`）”。游标防偏移状态100%交由服务端权威校验，结合彻底改派生的 `unreadPaths` 逻辑，**完全根治了「刷新前端/清空缓存导致红点失控、事件幽灵回放」的顽疾**。
- **状态树硬核保护**：团队状态配置文件（`team_sync_state.json`）实装 `.tmp` 后缀 + 强同步发落盘 + 原子重命名（Atomic Rename）机制。防断电、防弱网半写损坏。

### 2. 操作系统级安全会话模型 ✅
- **高阶 Token 防线**：废除 localStorage 裸奔明文存储 `refresh_token` 的粗放模式。Tauri 后端深度整合 OS Native Keychain（macOS 钥匙串 / Win DPAPI），前端全程无上下文黑盒代理续租，实现 0 感官 `401 Unauthorized` 自动治愈重连。
- **强制下线与一键驱逐**：实装 `POST /api/auth/revoke-sessions`，前端 TeamManagePage 提供强杀能力。
- **“一键记住我”真跨端方案**：基于原生的凭证保险柜为登录页赋能。清空前端缓存即执行安全的“交互失忆”，但真实凭证永不丢失，完美符合现代安全模型预期。

### 3. 加入团队流程与 UX 现代化翻新 ✅
- 废除了冗余的流转式步骤（`ChooseModeStep` 被降级为仅针对老用户的路由桥梁），重新梳理并构建了现代化的紧凑型“个人/团队”选项卡式登录页（`WelcomeStep`）。
- 全局严格实现了**「协作工具 UI 仅在团队空间显影」**的作用域隔离原则。本地知识库清爽依然。
- 精挑细选更新了各类视觉呈现，修复了侧边栏（`FileTreeItem`）过度渲染团队标识的视觉 Bug。

### 4. Phase 3.9: Lint Zero-Base & Backend Refactoring (2026-03-30 落地) ✅
作为迈向 Phase 4 的最终工业级净化战役：
- **核心网关解耦**：将长达 1600+ 行的 `sync.rs` 巨石完美拆分为 `negotiate`, `push`, `pull`, `diff`, `task_bypass` 独立模块，令增量同步逻辑清澈见底。
- **权限与管线剥离**：对承载了全部邀请/权限/重置逻辑的长达 1600+ 行的 `team.rs` 执行精密剥离手术，分形至 `core`, `members`, `directories`, `files`, `trash` 专用路由域。
- **Zero-Warning 纪律**：彻底清除了跨库的闲置 DTOs、无效生命周期导入以及冗余依赖提取，以 0 Error、0 Warning 的极净编译状态，为后续架构赋予最稳固的支撑。

---

## Phase 3 最终总结案（Final Verdict）

> 🚀 **Phase 3：团队协作引擎已达到全量 Release 标准，大获全胜！**
>
> 整个生命周期经历了非常具有挑战性但无比正确的**「架构自我手术」**。
> 从初期探索被困于“PR 代码审查逻辑”的文档协作死胡同，到果断壮士断腕清除 600 余行阻碍代码；最终成功转向了由 **「快照版本线 + 段落级批注 + 浮动评论 + 生命周期状态机」** 构建的轻量级共识流水线。
>
> 加上在本阶段末尾实施的《数据存储分级治理》，Slash 团队版已具备极强的数据健壮性、操作系统级的会话安全性和无与伦比的优雅协作体验。
> 
> **Phase 3 闭幕！Slash 准备好迎接下一个时代的挑战了。**

