# Slash Team Edition 产品需求文档 (PRD)

## 1. 核心理念与愿景

**产品愿景**：打造一款专注于深度技术团队的本地优先 (Local-First) 知识协作中枢。
**核心定调**：
- **拒绝“大乱炖”式实时协同**：采用类似于 Git 的 **异步 PR (Pull Request) 机制**，保护深阅读与深度创作者的心流，防止知识库被随意的实时编辑破坏。
- **本地性能至上**：即使在无网络的极端环境（如飞机上），成员依然能在个人和团队空间内拥有极速的搜索和写作体验。
- **数据结构性与纯净度**：通过外置隔离的 `MarkItDown Sidecar` 智能解析容器去杂存真，仅保留最干净的标准 Markdown 格式汇入端内。
- **高度模块化的端云架构**：桌面端（Desktop）作为唯一操作入口，Server 端仅承担状态中继和团队中枢验证角色。

## 2. 功能架构 (Functional Architecture)

### 2.1 空间隔离结构 (Dual-Vault Architecture)
在用户的本地文件系统中，Slash 将管理两个完全物理隔离的根目录，并在客户端树状视图中平滑合并。

```text
Slash_Vault/
├── Personal/ (个人空间 - 绝对私有，离线自治)
│   ├── 00_Inbox/
│   ├── 01_Projects/
│   ├── 02_Areas/
│   ├── 03_Resource/
│   └── 04_Archive/
│
└── Team_Name/ (团队空间 - 大写规范，云端受控)
    ├── 01_PROJECTS/ (各项目组的进度、方案、PRD)
    ├── 02_AREAS/    (团队长期维护的规范、架构图)
    ├── 03_RESOURCE/ (技术资料、外部共享素材)
    └── 04_ARCHIVE/  (已归档项目与废弃文档)
```

### 2.2 核心用户流程与功能

#### A. 个人文件管理 (Personal)
- **纯粹的本地优先**：笔记存储为 Markdown，附件存在 `.slash/assets`，元数据保存在 `vault/.slash/slash.db`。
- **开源/社区自托管协议**：用户可以使用免费的 **Slash Server Community** 部署在私人 NAS 或树莓派上。
- **Slash Sync Protocol**：基于 **内容 Hash 和逻辑时钟 (Logical Clocks)** 的高并发无感增量同步策略。
- **极客导入**：拖拽 PDF / Docx 文件至侧边栏，自动将文件抛给 Server 端，Server 调用 Python `MarkItDown` 剥离结构并转换为纯净的 `.md` 文件再流式下发给客户端。

#### B. 团队组建与管理 (Team Management)
- **部署模式**：公司管理层部署 **Slash Server Pro**，输入 License Key 激活。
- **权限与面板**：客户端侧边栏展示全新的 `Team Vault` 区域。拥有管理器权限的管理员，可以在此入口生成加入团队的邀请码、审批申请、分配全局宏观权限。
- **目录级动态授权**：管理员可在每个团队子目录（如 `01_PROJECTS`）分配局部权限（分为只读/读写/Manager），Server 捕获操作后，向下 Push 更新给组员的掩码。

#### C. 数据升格 (Personal to Team)
- **“提权”共享**：用户可在对应的个人目录上，一键选择 **“提升为团队文件”** (Promote to Team)。文件不仅存在于本地，还会挂载至 Team Vault 的指定目录下进行版本追踪，Server 端会在其元信息加上源作者追踪。
- **局部权限分发**：提权者成为 Owner，可将协作者拉入局部目录。

#### D. Git式的异步审阅流 (PR Review Flow)
- **非覆盖式修改**：如果 B（拥有读写权限）修改了 A 建立的文档，B 的本地不会立即污染正式目录。
- **提交与 Diff 视图**：B 完成修改后提交“合并请求” (PR)。A（或该目录 Manager）在客户端收到提示。
- **红绿对比 UI**：凭借基于 ProseMirror 的 Track-Change 机制，在同一篇笔记左右（或下划线）显示删减内容的 Diff 差异视图，并批注出修改人 `Modified By: xxx`。A 可一键点击 `Accept` (采纳) 或 `Reject` (驳回)。

#### E. 离线模式降级策略 (Offline Mode)
- 若用户在无网环境下（如飞机上）向团队目录试图操作：
  - **允许“草稿态”写入**：依然可以创建笔记及内容修改（本地落盘生成 Markdown 和 SQLite 新增标记）。
  - **网络恢复静默同步**：探测到恢复网络连接后，通过内置 Worker 静默批量将这段时间的 `queue` 变更推送并合并。

#### F. 移动端轻量延伸 (Mobile Extension)
- **定位**：“无处不在的阅读与快速捕获中枢”，摒弃重量级操作。
- **能力缩放**：仅支持单边文本输入直接推入 Inbox；团队空间设为全局全局只读（Read Only Mode）；不支持进行 PR 的审核与编辑操作；高保真还原 PC 端的样式和图片渲染。

---

## 3. 技术栈选型表

### 3.1 客户端 (Slash Desktop) *统一交互入口*
- **UI & 渲染层**: React 18 + TailwindCSS, Zustand 状态管理
- **原生壳与后端**: Tauri v2, Rust
- **引擎层**: TipTap / ProseMirror (深度重构拦截事件与 AST 渲染)
- **本地索引引擎**: Rust 原生 SQLite (使用 WAL 模式解决高并发竞态)
- **Diff 组件**: `@tiptap/extension-collaboration` 的降级利用或基于 `prosemirror-changeset`

### 3.2 服务端核心 (Slash Server Pro/Community)
- **高性能网关服务**: Rust + **Axum** 框架（处理长链接、JWT、鉴权与高频 Hash 协商）
- **持久化关系库**: **PostgreSQL** (核心数据的多租户隔离、RBAC 控制表)
  - *注：仅 Community 版本或极小微型团队支持 SQLite 平滑降级*
- **对象存储对接层**: S3 API 兼容组件 (MinIO或 AWS S3) 直接用于图床和附件存储。

### 3.3 异步解析节点 (MarkItDown Sidecar)
- **运行环境**: 独立 Docker 容器化运行，防止崩溃级联蔓延。
- **协议栈**: Python + FastAPI 
- **拆卸依赖**: `microsoft/markitdown`，对接外部复杂非标文档的结构化提取。

### 3.4 商业化网关模块
- **订阅集成**: Lemon Squeezy (SDK 与 Webhook 鉴权对接)。

---

## 4. 系统集成与架构解耦设计 (Monorepo)

为彻底解决端云协作时的数据结构断崖，全面重构至 **Monorepo (统一仓库)** 模式。
采用 `pnpm workspace` 与 `Cargo Workspace` 混编的终极形态：

```text
/slash-monorepo
├── apps/
│   ├── pnpm-desktop/      # (现存项目演变) Tauri 桌面主程序
│   ├── cargo-server/      # (新增) Rust Axum 服务端进程核心
│   └── python-sidecar/    # (新增) MarkItDown 解析容器
├── packages/
│   ├── rust-slash-core/   # [端云共享的核心基座] 计算Hash / 抽象数据库特征 / Tokenizer
│   ├── rust-sync-proto/   # [端云共享的 RPC/时钟定义] Slash Sync Protocol Struct的绝对真理
│   ├── js-editor-core/    # [TipTap基座] 脱离 Tauri 限制的文本跨平台渲染模块
│   └── js-shared-types/   # [TS基座] 生成跨界接口签名，保证 JSON 序列化安全
```

**(Open Core 开源分发架构)**：
公开 Github 维护至基础同步能力。针对商业级特性（如 RBAC、SSO、高级安全审计），将作为私有 submodule 通过 CI (Github Actions) 流入并在构建阶段注入为 Pro 版本。

---

## 5. 实施计划 (Milestone Roadmap)

### 阶段一：破釜沉舟与基建抽象 (M1 - 核心架构 Monorepo 化)
* **不要写新业务代码**。
* 将现有的杂乱业务全面梳理剥离，将共用数据结构放入 `packages/*`。
* 改造本机的 SQLite 表格结构（支持 Space Type、Team ID 的元信息容纳）。
* 确保重构完毕的版能达到 `cargo c` 及原表现一致的验收指标。

### 阶段二：建立对话与云盘级同步 (M2 - Slash Server Community 先行)
* 构建 Rust Axum 空壳 Server，打通 JWT Auth 与多租户雏形。
* **Slash Sync Protocol** 第一次验证：针对 Personal Space，试验客户端连接服务器并计算出目录 Hash 并完成增量同步逻辑，搭建好 Minio/S3 环境。
* (副任务：部署跑通 Python Sidecar 文件解析网关)

### 阶段三：异步协同网络与 PR 流转 (M3 - Team Version 攻坚)
* 上线 Team 架构树权限校验 (RBAC)。
* 重点研发客户端针对他人产生修改事件时的交互 UI：拦截写入、产生 Pull Request、状态置换（State Replacement）。
* 完成 TipTap Red-Green Diff 高分辨率对比渲染组件的整合（这是整个产品最高感知价值的点）。

### 阶段四：封闭测试与商业化组装 (M4 - Commercialize)
* 对接 Lemon Squeezy 和许可证发布。
* 开始筹备移动版极简客户端对只读体系和 API 聚合进行联调。
* 面向种子团队进行邀请制封闭测试，检测高低丢包下的同步死锁率。
