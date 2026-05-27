# Phase 3: Team Version 路线图（修订版 v2）

> Phase 2 (Community Edition) 已交付：单用户多设备增量同步 + docker-compose 一键部署 + MarkItDown 文件导入。
> Phase 3 目标：从个人工具升级为团队异步协作平台。
> 修订说明：本版基于 v1 审核反馈，校准了 PR 语义、大小写隔离架构、5 角色体系、混合 Diff 引擎、Task 即时性旁路等关键设计。

---

## 里程碑总览

| Step | 模块 | 核心交付 | 预估 |
|------|------|----------|------|
| 1 | 团队基础设施 + RBAC | 5 角色体系 + 目录级权限 + 大小写隔离 | 2-3 周 |
| 2 | 混合 Diff 引擎 | Rust 后端 Diff 计算 + TipTap Decoration 渲染 | 2-3 周 |
| 3 | PR 审阅流转 | 基于文件所有权的文件修改审批流程 | 2 周 |
| 4 | S3/Minio 存储 | 附件云端持久化，替换 LocalFileStorage | 1 周 |
| 5 | Task 属性级旁路同步 | 勾选状态实时同步，绕过 PR 流程 | 1 周 |
| 6 | Mobile 极简客户端 | 只读浏览 + 基础编辑 + 同步 | 3-4 周 |
| 7 | 商业化组装 | Lemon Squeezy + 许可证 + Pro 功能注入 | 2 周 |

---

## 一、核心设计校准

### 1.1 PR 是"流程"不是"权限"

> [!IMPORTANT]
> v1 错误地将 PR 视为"角色权限门控"（Editor Push → 拦截 → 生成 PR）。正确理解：PR 是**文件所有权驱动的修改审批流程**。

**核心规则**：不论角色高低，**任何人修改他人文件必须走 PR**。

| 场景 | 行为 |
|------|------|
| A 修改自己创建的文件 | 直接 Push，无需审批 |
| B 修改 A 创建的文件 | B 的修改 → 生成 PR → A（文件 Editor）审核 |
| Editor 缺位 | 上级 Owner 自动继承审核权 |
| Admin 修改他人文件 | 同样走 PR（Admin 特权仅限于成员管理和目录管理） |

**本质**：PR 保护的是**文件内容的创作者权益**，而不是角色等级的访问控制。

### 1.2 大小写隔离架构

> [!IMPORTANT]
> 个人空间和团队空间通过目录名称的**大小写**进行物理隔离，此约定贯穿全局。

```text
Slash_Vault/
├── Personal/                        ← 个人空间（首字母大写小写混合）
│   ├── 00_Inbox/
│   ├── 01_Projects/
│   ├── 02_Areas/
│   ├── 03_Resource/
│   └── 04_Archive/
│
└── Team_Alpha/                      ← 团队空间（PARA 目录全大写）
    ├── 01_PROJECTS/
    ├── 02_AREAS/
    ├── 03_RESOURCE/
    └── 04_ARCHIVE/
```

**技术要求**：

| 检查点 | 规则 |
|--------|------|
| 宪法目录保护 | 个人空间的 5 个 PARA 宪法目录（`00_Inbox`、`01_Projects`、`02_Areas`、`03_Resource`、`04_Archive`）**禁止 Promote 为团队目录**，仅允许其子目录或独立目录提权 |
| 客户端 Push 校验 | Server 拒绝团队空间出现小写 PARA 目录名 |
| 自动修正 | `promote_to_team` 时自动将 `01_Projects/` → `01_PROJECTS/` |
| 目录树渲染 | 侧边栏视觉层对个人/团队空间使用不同图标前缀 |
| 路径比较 | 团队空间路径匹配一律 **case-sensitive**（不做 macOS 的 case-insensitive fallback） |

### 1.3 五角色体系

> 取代 v1 中简单的 `owner/admin/editor/viewer` 四角色。角色与**作用域**绑定，同一用户在不同目录下可以是不同角色。

| 角色 | 作用域 | 核心职责 |
|------|--------|----------|
| **Admin** | 全局 | 创建团队空间、管理成员（增删、提升角色）、为目录绑定 Owner 和 Team-members、管理 Observer 可见性、移动团队目录/文件、Pull 任意团队目录 |
| **Owner** | 目录级 | 管理所绑定目录的 Team-members、控制 Observer 可见性、自动接收目录内所有文件变更、在绑定目录内创建子目录/文件、**移动绑定目录内的目录/文件**、继承子目录的子级 Owner 权限 |
| **Team-members** | 目录级 | 自动接收所属目录内文件变更（被移除的子目录除外）、可在目录内创建子目录（创建后晋升为该子目录的 Owner） |
| **Editor** | 文件级 | 笔记的创建者 = 该笔记的 Editor，负责审核他人对该笔记的修改（PR 审批）、Editor 缺位时上级 Owner 自动接管 |
| **Observer** | 全局 | 默认入团身份、仅可查看 Admin/Owner 开放的文件、无本地残留（流式只读）、被 `@` 后自动晋升为该目录的 Team-members |

**与 v1 对比**：

| v1 角色 | v2 校准 |
|---------|---------|
| `owner` (vault 级) | → `Admin` (全局) + `Owner` (目录级) 分离 |
| `admin` | → 与 `Admin` 合并 |
| `editor` (可 push) | → `Team-members` (目录级协作) + `Editor` (文件级所有权) 分离 |
| `viewer` (只读) | → `Observer` (零残留流式只读 + 可被 @激活) |

### 1.4 全局规则

| # | 规则 |
|---|------|
| G-1 | 任何人都可以进入 Team 空间查看有权限的文件 |
| G-2 | Team 空间拦截 `Cmd/Ctrl+C/A`、右键拷贝、文本选中拖拽（防止内容外泄） |
| G-3 | 任何人不能在 Team 空间直接增删文件/目录（必须通过个人空间 Push） |
| G-4 | 个人空间团队目录内的操作自动 Push 到团队目录 |
| G-5 | 不得直接修改他人文件，修改 → Diff → PR 合并 |
| G-6 | OS 层面手工拷入个人仓库团队目录的文件/目录，同样 Push 到 Team 空间。谁 Push 的**文件**谁是该文件的 `Editor`；谁 Push 的**目录**谁是该目录的 `Owner` |

### 1.5 团队与个人空间同步原则

> [!IMPORTANT]
> 以下 5 条原则定义了团队空间与个人空间之间内容流动的边界和行为。

| # | 原则 | 说明 |
|---|------|------|
| T-1 | **禁止 Promote 根目录** | 个人空间的 PARA 宪法目录（`Projects`、`Areas` 等）禁止整体 Promote 到团队空间，仅允许其子目录提权（已实现 ✅） |
| T-2 | **禁止 Pull 团队根目录** | 团队空间的根级 PARA 目录（`01_PROJECTS`、`02_AREAS` 等）禁止整体 Pull 到个人空间，仅允许 Pull 其子目录 |
| T-3 | **添加成员自动 Push** | 任何目录添加 team-member 后，该目录自动 Push 到该成员的个人空间对应目录结构下（例：团队 `01_PROJECTS/Beta` → 个人 `Projects/Beta`）。如个人空间已存在同名目录则合并处理（文件冲突由 sync negotiate hash 比较解决） |
| T-4 | **团队内容来源标识** | 个人空间中来自团队的目录/笔记在文件树中必须有视觉标识，且区分来源类型：`Promoted`（用户主动提权）vs `Synced`（被动推送/拉取） |
| T-5 | **YAML Editor 字段** | 笔记在 Promote/Push 到团队空间时，Rust 后端自动在 YAML frontmatter 中注入 `editor` 字段，值为推送者的显示名 |

**T-3 自动 Push 流程**：

```
Admin/Owner 在团队目录 D 中添加用户 U 为 team-member
  → Server 记录 directory_permissions (D, U, 'team_member')
  → Server 发送 push 事件给 U 的客户端
  → U 的客户端收到事件后：
      1. 计算个人空间映射路径：01_PROJECTS/Beta → Projects/Beta
      2. 执行 Pull D 到个人空间对应路径
      3. 建立增量同步映射（team_path_mappings.json）
      4. 后续文件变更通过 sync_team_full 自动双向同步
```

**T-4 内容来源标识**（已实现 ✅）：

| 来源类型 | 文件树标识 | 触发方式 |
|----------|----------|----------|
| `Promoted` | 🟣 紫色图标+文字 | 用户从个人空间主动 Promote 到团队（`team_path_mappings.json` source→target 映射） |
| `Synced` | 🔵 蓝色图标+文字 | 被添加为 team-member 后自动推送 / 手动 Pull |

数据源与判定逻辑：
- **唯一权威数据源**：服务端团队目录树（`teamTree`，通过 `/api/sync/vaults/tree` API 获取）
- **双通道匹配**：
  1. **PARA 反向映射**：`PARA_TEAM_TO_PERSONAL`（`01_PROJECTS` → `Projects`）将团队树路径映射为个人空间路径（适用于直属子目录）
  2. **嵌套路径交叉验证**：`team_path_mappings.json` 中的 `source → target` 映射，验证 target 确实存在于团队树中才标记（适用于嵌套目录如 `01_Projects/P-1/P-2/P-3 → 01_PROJECTS/P-3`）
- **安全保障**：target 不在团队树中 → 不标记（防重建后残留）；未连接团队时 → `promotedMappings` 清空 → 无团队样式
- **已团队化目录允许 re-Promote**：右键菜单对已标记目录显示 "Sync to Team"，对未标记目录显示 "Promote to Team"

**T-5 YAML Editor 字段**（已实现 ✅）：

```yaml
---
title: 项目进展报告
editor: zhu
created: 2026-03-10
---
```

**Editor 注入全链路**：

| 层 | 文件 | 职责 |
|----|------|------|
| 存储 | `SyncTab.tsx` | Join/Create Team 时存储 `slash_user_display_name` 到 localStorage |
| 前端 | `Sidebar.tsx` | `handlePromoteToTeam` 从 localStorage 读取并传入 `editorName` |
| 服务层 | `SyncService.ts` | `pushDirectoryToTeam` 将 `editorName` 传给 Rust Invoke |
| 后端 | `sync.rs` | `push_directory_to_vault` 对每个 `.md` 文件注入/更新 `editor` 到 YAML frontmatter |

Rust 端注入逻辑覆盖三种情况：
- 有 frontmatter 且已有 `editor:` → 替换
- 有 frontmatter 但无 `editor:` → 追加
- 无 frontmatter → 创建 `---\neditor: xxx\n---\n`

### 1.6 空间可见性与数据治理原则

> [!IMPORTANT]
> 以下 4 条原则定义了团队空间/个人空间的可见性规则和团队内容的数据主权。

| # | 原则 | 说明 | 状态 |
|---|------|------|------|
| V-1 | **登录后可见** | 登录团队账户后 Desktop 侧边栏出现团队空间栏，成员在 Observer 可见性允许范围内查看目录/文件 | 已实现 ✅ |
| V-2 | **登出后隐藏** | 登出后团队空间栏不可见；`teamTree` 清空 → 个人空间团队样式自动消失 | 已实现 ✅ |
| V-3 | **个人空间团队内容始终可见** | 通过 Promote / Pull / 自动 Push 进入个人空间的团队目录/文件，**任何时候**（与登录状态无关）都可在个人空间中查看和编辑。修改/删除非本人文件走 PR（PR 流程待实现） | 已实现 ✅（PR 部分待 Step 3） |
| V-4 | **本地删除 ≠ 云端删除** | 个人空间中对团队文件的删除仅影响本地，云端需由上级 Owner / Admin 确认后才能删除 | 待实现（PR 阶段） |

### 1.7 空间管理规则

| # | 规则 | 说明 |
|---|------|------|
| S-1 | **一账号一团队** | 每个账号最多创建一个团队空间，已有团队时禁止重复创建 |
| S-2 | **个人空间名称匹配** | 本地个人空间与云端个人空间按名称一一对应（`zhu` ↔ `zhu'`），禁止交叉同步 |
| S-3 | **团队绑定唯一个人空间** | 团队空间只能与一个本地个人空间绑定，绑定后该空间成为团队文件的同步桥梁 |

**连接流程（简化后）**：

```
用户输入邮箱密码 → 登录/注册
  → 获取 vault 列表
  → 按本地 vault 名称自动匹配云端个人 vault → 自动连接
  → 如有团队空间 → 自动绑定到侧边栏
  → 首次连接且有团队空间时：
      ├── 仅一个个人空间 → 自动绑定
      └── 多个个人空间 → 提示选择绑定哪个 + 可选新建
```

---

## Step 1: 团队基础设施 + RBAC

**现状**：`space_type` 已预留 `team` 枚举，`SyncNegotiateRequest` 已支持 space_type 字段。DB 仅有 users / vaults / file_states / sync_logs 四张表。
**目标**：建立 5 角色权限体系 + 目录级权限 + 大小写隔离。

### 1.1 数据库扩展

```sql
-- Migration 002: Team RBAC

-- 团队全局成员表（Admin / Observer）
CREATE TABLE team_members (
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  global_role VARCHAR(20) NOT NULL DEFAULT 'observer',  -- 'admin' / 'observer'
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vault_id, user_id)
);

-- 目录级权限绑定（Owner / Team-members）
CREATE TABLE directory_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  directory_path TEXT NOT NULL,                    -- 如 '01_PROJECTS/Alpha/'
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dir_role VARCHAR(20) NOT NULL,                   -- 'owner' / 'team_member'
  observer_visible BOOLEAN NOT NULL DEFAULT true,  -- Observer 是否可见此目录
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vault_id, directory_path, user_id)
);

CREATE INDEX idx_dir_perm_vault_path ON directory_permissions(vault_id, directory_path);
CREATE INDEX idx_dir_perm_user ON directory_permissions(user_id);

-- 文件所有权追踪（Editor 身份）
ALTER TABLE file_states
  ADD COLUMN editor_id UUID REFERENCES users(id),      -- 文件创建者 = Editor
  ADD COLUMN pushed_by UUID REFERENCES users(id),       -- 最近 Push 者
  ADD COLUMN pushed_at TIMESTAMPTZ;

-- 邀请码表
CREATE TABLE invitations (
  code VARCHAR(32) PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  used_by UUID REFERENCES users(id),
  used_at TIMESTAMPTZ
);
```

### 1.2 权限判定逻辑

```
resolve_role(user_id, vault_id, path) → EffectiveRole:
  1. team_members.global_role == 'admin' → Admin
  2. directory_permissions 匹配 path 或其祖先目录：
     - dir_role == 'owner' → Owner
     - dir_role == 'team_member' → Team-members
  3. 以上都不匹配 → Observer
  4. file_states.editor_id == user_id → 该文件的 Editor（叠加角色）
```

**Owner 继承规则**：`01_PROJECTS/` 的 Owner 自动继承 `01_PROJECTS/Alpha/` 的 Owner 权限（祖先路径前缀匹配）。

### 1.3 Server 端路由扩展

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/team/invite` | POST | Admin 生成邀请码 |
| `/api/team/join` | POST | Observer 通过邀请码加入 |
| `/api/team/members` | GET | 成员列表 |
| `/api/team/members/:id/role` | PUT | 变更全局角色 |
| `/api/team/directories/:path/permissions` | GET/PUT | 目录权限管理 |

### 1.4 Push 端权限校验中间件

```rust
// ensure_vault() 扩展 → ensure_team_permission()
async fn ensure_team_permission(
    state: &AppState,
    user_id: &str,
    vault_id: &str,
    path: &str,
    action: TeamAction,  // Push / Pull / ManageMembers / ManageDirectory
) -> Result<EffectiveRole, ApiError> { ... }
```

### 变更文件

| 文件 | 说明 |
|------|------|
| `migrations/002_team_rbac.sql` [NEW] | 团队权限 Schema |
| `routes/team.rs` [NEW] | 成员管理 + 目录权限 API |
| `routes/sync.rs` [MODIFY] | Push/Pull 增加 `ensure_team_permission()` 校验 |
| `models.rs` [MODIFY] | 新增 `EffectiveRole` / `TeamAction` 枚举 |
| `slash-sync-proto/lib.rs` [MODIFY] | 新增 `TeamInviteRequest` / `DirectoryPermission` 等结构体 |

---

## Step 2: 混合 Diff 引擎（Hybrid Semantic Diff）

**现状**：Phase 2 冲突策略为 client-wins，无 Diff 可视化。
**目标**：构建后端计算 + 前端可视化的混合语义 Diff 系统。

> [!CAUTION]
> **拒绝纯文本级 Diff**。原因：
> 1. **语义黑洞**：纯文本 Diff 无法理解 Slash 的结构化节点（Tldraw 画板、Task 列表、代码块等）
> 2. **结构风险**：手动合并字符级 Diff 极易破坏 Markdown 语法（如破坏 frontmatter YAML）
> 3. **性能瓶颈**：JS 线程处理大文件 Diff 会阻塞 UI 渲染

### 2.1 架构：后端计算 + 前端渲染

```
                  ┌──────────────────────────┐
  Client          │   Server (Rust)          │
  (TipTap)        │                          │
                  │  ┌─────────────────────┐ │
  Negotiate ──────┤► │ similar::TextDiff   │ │
                  │  │   ↓                 │ │
                  │  │ DiffResult (ops[])  │ │
                  │  └─────────────────────┘ │
                  │           │              │
  ◄───────────────┤───────────┘              │
  DiffOp[]        └──────────────────────────┘
       │
       ▼
  TipTap Editor
  ┌─────────────────────────────┐
  │ Decoration Plugin           │
  │  • 红色背景 = 删除行         │
  │  • 绿色背景 = 新增行         │
  │  • 黄色背景 = 修改行         │
  │  • 灰色侧栏标注 = 修改者     │
  └─────────────────────────────┘
```

### 2.2 后端 Diff 引擎（Rust `similar` 库）

```rust
// packages/slash-core/src/diff.rs [NEW]

use similar::{ChangeTag, TextDiff};

/// 语义 Diff 操作
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffOp {
    pub tag: DiffTag,         // Insert / Delete / Equal
    pub old_range: Option<LineRange>,  // 旧版本行范围
    pub new_range: Option<LineRange>,  // 新版本行范围
    pub content: String,              // 受影响的文本片段
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiffTag { Insert, Delete, Equal }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineRange { pub start: usize, pub end: usize }

/// 计算两个 Markdown 文件的语义 Diff
pub fn compute_diff(old: &str, new: &str) -> Vec<DiffOp> {
    let diff = TextDiff::from_lines(old, new);
    diff.ops()
        .iter()
        .map(|op| /* 转换为 DiffOp */)
        .collect()
}
```

**结构化节点保护**：

| 节点类型 | Diff 策略 |
|----------|-----------|
| 普通文本段落 | 行级 Diff（`similar::TextDiff::from_lines`） |
| 代码块（```） | 整块对比，不拆分内部行（保护缩进语义） |
| Tldraw 画板 | 标记为"二进制节点"，仅显示"画板已修改"，不展示内联 Diff |
| Frontmatter（---） | 整块对比，不拆分 YAML 字段 |
| Task 列表 | 见 Step 5 旁路机制，此处仅对比文本内容 |

### 2.3 前端渲染：TipTap Decoration（非新窗口）

> [!IMPORTANT]
> **不创建全新的预览窗口**。直接在当前 TipTap 编辑器中通过 Decoration 装饰器给受影响的文本块打上视觉标记。

```typescript
// packages/js-editor-core/src/extensions/DiffOverlay/ [NEW]

/**
 * DiffOverlayExtension — TipTap 扩展
 *
 * 接收 DiffOp[] 数据后，通过 ProseMirror Decoration 在编辑器中
 * 叠加红/绿/黄背景，用户可逐块 Accept / Reject。
 */
export const DiffOverlayExtension = Extension.create({
  name: 'diffOverlay',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, decorations) => {
            const diffOps = tr.getMeta('diffOps');
            if (diffOps) {
              return buildDecorations(tr.doc, diffOps);
            }
            return decorations.map(tr.mapping, tr.doc);
          }
        },
        props: {
          decorations(state) {
            return this.getState(state);
          }
        }
      })
    ];
  }
});

function buildDecorations(doc: Node, ops: DiffOp[]): DecorationSet {
  // 将 DiffOp[] 的行范围映射到 ProseMirror 节点位置
  // Delete → 红色背景 inline decoration
  // Insert → 绿色背景 inline decoration
  // Change → 黄色背景 + 侧栏标注 widget decoration
}
```

### 2.4 Server 端 Diff API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sync/diff` | POST | 接收 `{ vault_id, path, client_content }` → 返回 `DiffOp[]` |
| `/api/sync/negotiate` | POST | 扩展：冲突文件附带 `DiffOp[]`（可选，大文件时客户端按需请求） |

### 变更文件

| 文件 | 说明 |
|------|------|
| `packages/slash-core/src/diff.rs` [NEW] | Rust Diff 算法引擎（基于 `similar` crate） |
| `packages/slash-core/Cargo.toml` [MODIFY] | 添加 `similar` 依赖 |
| `apps/server/src/routes/sync.rs` [MODIFY] | 新增 `/api/sync/diff` 端点 |
| `slash-sync-proto/lib.rs` [MODIFY] | 新增 `DiffOp` / `DiffRequest` / `DiffResponse` 结构体 |
| `packages/js-editor-core/src/extensions/DiffOverlay/` [NEW] | TipTap Decoration 插件 |
| `apps/desktop/src/components/DiffActionBar.tsx` [NEW] | Accept/Reject 操作栏 |

---

## Step 3: PR 审阅流转

**目标**：实现基于文件所有权的修改审批流程。

> [!NOTE]
> PR 的触发条件是**"修改他人文件"**，而不是"角色为 Editor"。详见 §1.1 的核心规则。

### 3.1 流程

```
B 修改 A 的文件
  → B 本地编辑并保存
  → B Push 触发
  → Server 检测到 file_states.editor_id ≠ B.user_id
  → Server 拒绝直接写入，创建 PR 记录
  → A（或上级 Owner）收到 PR 通知
  → A 打开 PR → TipTap DiffOverlay 显示红/绿标记
  → A 点击 Accept → Server 合入正式版
     或 Reject → 通知 B
```

### 3.2 数据库

```sql
-- Migration 003: PR Flow

CREATE TABLE pull_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,                        -- 受影响文件的相对路径
  author_id UUID NOT NULL REFERENCES users(id),   -- 提交修改者（B）
  reviewer_id UUID REFERENCES users(id),          -- 审核者（A = Editor / 上级 Owner）
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending' / 'approved' / 'rejected'
  source_content BYTEA NOT NULL,                  -- B 修改后的完整内容
  source_hash TEXT NOT NULL,                      -- B 修改后的 content_hash
  target_hash TEXT NOT NULL,                      -- 提交时的 Server 正式版 hash
  diff_ops JSONB,                                 -- 预计算的 DiffOp[] (可选缓存)
  comment TEXT,                                   -- 审核意见
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_pr_vault_status ON pull_requests(vault_id, status);
CREATE INDEX idx_pr_reviewer ON pull_requests(reviewer_id, status);
```

### 3.3 审核者自动判定

```
resolve_reviewer(vault_id, file_path) → user_id:
  1. file_states.editor_id 存在且有效 → Editor
  2. Editor 缺位 → directory_permissions 中 path 最近的祖先 Owner
  3. 均不存在 → Admin
```

### 3.4 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/pr/list` | GET | 获取 pending PR 列表（按 reviewer 过滤） |
| `/api/pr/:id` | GET | 获取 PR 详情 + DiffOp[] |
| `/api/pr/:id/approve` | POST | 审批通过 → 合入正式版 |
| `/api/pr/:id/reject` | POST | 驳回 + 附加理由 |

### 3.5 Desktop 端交互

- `SyncStatusIndicator` 增加 PR 未读计数角标
- 侧边栏新增"审阅队列"面板（或集成到通知中心）
- 点击 PR → 打开对应笔记 → 自动激活 DiffOverlay → 显示 Accept/Reject 操作栏
- PR 合入后触发 `sync:pr-merged` 事件 → 通知相关方

### 变更文件

| 文件 | 说明 |
|------|------|
| `migrations/003_pr_flow.sql` [NEW] | PR 表 Schema |
| `routes/pr.rs` [NEW] | PR 审批 API |
| `routes/sync.rs` [MODIFY] | Push 逻辑分流（自有文件 → 直接写入，他人文件 → 创建 PR） |
| `slash-sync-proto/lib.rs` [MODIFY] | 新增 `PullRequestInfo` / `PRAction` 等结构体 |
| `apps/desktop/src/components/PRReviewPanel.tsx` [NEW] | 审阅队列 UI |
| `SyncStatusIndicator.tsx` [MODIFY] | PR 角标 |

### 3.6 多人编辑：悲观锁机制（待实现）

> 当前限制：同一文件同一时刻多人编辑会导致内容互相覆盖（全文件级 PR 无法合并不同用户的局部修改）。

**方案：Pessimistic Locking（悲观锁）**

| 阶段 | 行为 |
|------|------|
| 打开团队文件（非 Editor） | 只读模式，顶部提示 "🔒 点击编辑" |
| 点击编辑 | 请求锁 `lock_file(vault, path, user, ttl=30min)` |
| 编辑中 | 定期 heartbeat 续租，其他人看到 "🔒 User-B 正在编辑" |
| 提交/释放 | push + 释放锁 → 创建 PR（或直接生效） |

**容错**：

| 风险 | 对策 |
|------|------|
| 用户忘记释放 | TTL 自动过期（30分钟无 heartbeat 自动释放） |
| App 崩溃 | heartbeat 停止 → 锁过期 |
| 网络断开 | 本地缓存编辑内容，重连后重新获取锁 |

### 3.7 删除文件 PR 流程（待实现）

> 对应 V-4 原则：个人空间中对团队文件的删除仅影响本地，云端需走审批流程。

**流程**：

```
B 在个人空间删除 A 的团队文件
  → 本地删除（即时生效）
  → sync deleted_paths 发送到 Server
  → Server 检测 editor_id ≠ B → 创建 DeletePR
  → A（或上级 Owner）审核：Accept = 云端删除 / Reject = 下次 sync 恢复到 B 本地
```

---

## Step 4: S3/Minio 存储

**现状**：`FileStorage` trait 已抽象，`LocalFileStorage` 实现完毕。
**目标**：新增 `S3FileStorage` 实现，生产环境使用 S3/Minio。

> [!NOTE]
> D-3 技术债务（大文件增量/分块优化）并入本步骤。团队场景附件共享是高频需求。

### 变更文件

| 文件 | 说明 |
|------|------|
| `storage.rs` [MODIFY] | 新增 `S3FileStorage` 实现 |
| `config.rs` [MODIFY] | S3 环境变量（bucket / region / access_key / secret） |
| `main.rs` [MODIFY] | `STORAGE_BACKEND` 环境变量切换 Local / S3 |
| `docker-compose.yml` [MODIFY] | 新增 Minio 服务 |
| `Cargo.toml` [MODIFY] | 添加 `aws-sdk-s3` 依赖 |

---

## Step 5: Task 属性级旁路同步

> [!IMPORTANT]
> **Task 的"即时性"**：`- [ ]` 到 `- [x]` 的状态流转应**绕过 PR 流程**，通过高优先级事件实时同步。

### 5.1 设计原理

任务勾选是**属性变更**（状态从 `unchecked` → `checked`），不是**内容修改**（文字编辑）。强制走 PR 会导致：
- 团队看板中任务完成状态延迟数小时甚至数天
- 审核者被大量"仅勾选"的 PR 淹没
- 与 Task 系统的"实时事件驱动同步"理念冲突（参见 KI: Slash Tasks System）

### 5.2 旁路规则

| 变更类型 | 判定方法 | 走 PR？ | 同步方式 |
|----------|----------|---------|----------|
| 文本内容修改 | Diff 非空（排除 checkbox 行） | ✅ 是 | 常规 Push / PR |
| Task 状态勾选 | 仅 `- [ ]` ⇆ `- [x]` 的变化 | ❌ 否 | 高优先级 Event 直接同步 |
| 混合修改 | 既有文本修改又有勾选 | ✅ 是 | 合并成一个 PR，但 Task 状态立即旁路同步 |

### 5.3 技术方案

```
B 在 A 的文件中勾选任务
  → 客户端检测到仅 checkbox 状态变更
  → 发送 TaskBypassEvent { path, line, checked: true, user_id }
  → Server 直接更新 file_states 中该行的 checkbox 状态
  → Server 广播 sync:task-toggled 事件给所有订阅者
  → 各客户端接收并更新本地文件对应行
```

**防冲突**：Task 旁路同步使用**行号 + 行内容 hash** 定位，避免行号偏移导致修改了错误的 checkbox。

### 5.4 协议扩展

```rust
// slash-sync-proto 新增

/// Task 属性级旁路同步事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBypassEvent {
    pub vault_id: String,
    pub file_path: String,
    pub line_number: usize,
    pub line_content_hash: String,  // 行内容 hash，防行号偏移
    pub checked: bool,
    pub toggled_by: String,         // user_id
    pub timestamp: i64,
}
```

### 变更文件

| 文件 | 说明 |
|------|------|
| `slash-sync-proto/lib.rs` [MODIFY] | 新增 `TaskBypassEvent` |
| `routes/sync.rs` [MODIFY] | 新增 `/api/sync/task-bypass` 端点 |
| `apps/desktop/src/services/AutoSyncManager.ts` [MODIFY] | 检测 checkbox-only 变更 → 旁路同步 |
| `packages/js-editor-core/src/extensions/TaskItem/` [MODIFY] | 勾选事件发射 `task:toggled` |

---

## Step 6: Mobile 极简客户端

**目标**：iOS/Android 只读浏览 + 基础编辑 + 同步。

### 技术选型

- **框架**：React Native 或 Swift/Kotlin 原生
- **编辑器**：轻量 Markdown 渲染（非 TipTap），编辑用简单 textarea
- **同步**：复用 `slash-sync-proto`（已有 Negotiate/Push/Pull 协议）
- **Token**：复用 `/api/auth/refresh` 端点
- **团队空间**：全局只读模式（Read Only），不支持 PR 审核与编辑操作

### 前置依赖

- `@slash/editor-core` Tauri 残留耦合已清零（D-1 已完成 ✅）

---

## Step 7: 商业化

- Lemon Squeezy 集成（订阅 / 一次性许可证）
- Pro 功能注入（RBAC / SSO / 高级审计）通过 CI 私有 submodule
- 种子团队邀请制封闭测试

---

## Phase 2 Desktop 端功能复用参考

> 详见 [sync_architecture.md](./sync_architecture.md)

### Phase 3 直接复用

| 模块 | 说明 |
|------|------|
| `slash-sync-proto` | Negotiate/Push/Pull 协议结构体 |
| `slash-core` | 目录扫描 + Merkle hash 算法 |
| `SyncService.ts` | Token 刷新 + per-vault 配置隔离 |
| `AutoSyncManager.ts` | 5 种触发器 + 离线队列 + online 恢复 |
| Server auth 端点 | Register/Login/Refresh/Me |

### Phase 3 需扩展

| 模块 | 扩展点 |
|------|--------|
| `ensure_vault()` | → `ensure_team_permission()` 5 角色权限校验 |
| Push 端点 | 所有权校验 + PR 分流 |
| Pull 端点 | 目录级可见性过滤 |
| `slash-core` | 新增 `diff.rs` (Rust `similar`) |
| `SyncStatusIndicator` | 冲突/PR 角标 + Observer 只读标识 |
| `AutoSyncManager` | 冲突检测暂停 + Task 旁路分流 |

---

## 与 v1 版本的关键差异摘要

| 维度 | v1 | v2（本版） |
|------|-----|----------|
| PR 触发逻辑 | 角色为 Editor → 拦截 Push → 生成 PR | **任何人修改他人文件** → 生成 PR |
| 角色体系 | 4 角色 (owner/admin/editor/viewer) | **5 角色** (Admin/Owner/Team-members/Editor/Observer)，目录级 + 文件级 |
| Diff 引擎 | JS 前端 `diff-match-patch` 纯文本 Diff | **Rust 后端 `similar`** + TipTap Decoration，语义 Diff |
| Diff UI | 左右双栏 Modal | **原位 Decoration**（红/绿/黄背景叠加） |
| 目录规范 | 未强调 | **大小写隔离**（Personal 小写 / Team 全大写 PARA） |
| Task 同步 | 与普通内容一视同仁 | **属性级旁路同步**，绕过 PR 实时同步 |
| Observer 体验 | 简单 Viewer 只读 | **零残留流式只读** + @激活自动晋升 |
