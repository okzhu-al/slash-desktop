# 架构师通讯：Editor 字段语义确立与“漂移”Bug 修复备忘录

> **致 Developer Agent 的架构提醒**
> 本记录说明了 `editor` 字段在最新协同体系下的严格语义边界，以及为了封堵数据漂移与泄漏所落地的底层处理逻辑。在进行接下来的功能开发前，请务必核对你目前的代码工作流中是否与这些安全收口存在冲突，防范回退（Regression）。

## 1. 核心语义边界的确立
在当前的混合架构下，对于 Markdown Frontmatter 中的字段，我们执行如下强定义：
*   **`editor` (作者/拥有者)**：代表这篇逻辑文档（`slash_id` / `file_id`）的**最初创建者**或**永久拥有者**。它**不再**是“当前最后保存副本的人”。即便文档在 Collab 模式下被他人编辑，这个字段也**决不允许发生漂移**。
*   **`contributors` (协作编辑者)**：包含并记录所有在 Team Vault 下对该文档执行了实际编辑并保存（Push）的成员名单（包含原始 Creator）。

---

## 2. 之前存在的架构漏洞与当前修正方案

### 🔴 漏洞 1 (BUG21): React 闭包陷阱导致的协作强行篡改
**问题描述**：此前发现在协作协同（Collab）时，成员只要发生任意编辑动作，就会暴力地把 `editor` 覆盖篡改为自己。
**架构师确诊溯源**：在 `apps/desktop/src/features/editor/hooks/useContentPersistence.ts` 中，`isTeamNote` 由于是异步读取解析的，初始值为 `false`。由于 `saveContent` 在使用 `useCallback` 时完全缺失了此依赖约束，导致其形成**陈旧闭包（Stale Closure）**。任何保存动作都被此闭包永久判定在“Personal Space（个人空间）”中运行，从而不顾协作者逻辑暴力覆盖了 `editor`。
**现行机制**：
我们引入了 `useRef` 获取实时游标：
```typescript
const isTeamNoteRef = useRef(isTeamNote);
isTeamNoteRef.current = isTeamNote;
```
并在检测到 `!isTeamNoteRef.current` 是纯个人文档时才允许注入当前用户名到 `editor`。
👉 **兼容风险排查请求**：你需要检查当前你在做的任何新增 Frontmatter 表单字段、Meta 元数据操作的过程中，是否依然存在遗漏依赖项的异步状态截获。不要轻易破坏这处 `useRef` 的安全防线。

---

### 🔴 漏洞 2 (BUG22): 同步引擎(Personal Sync) 物理跨界与虚假建库
**问题描述**：成员在参与团队库时，仅仅处于 Pull 下拉代码阶段，其独立的“Personal Vault”就会虚空生成一份一模一样的 Team 文档追踪源，且标记创建者为 Pull 拉取者本身。
**架构师确诊溯源**：在 `apps/desktop/src-tauri/src/commands/sync/personal.rs` 主工作流的 `sync_vault` 中。由于“Team 拉取到的本地映射目录（由 `team_path_mappings.json` 控制）”和用户原本的私有文档同处一台磁盘目录下，在进行 Space_Type 为 `Personal` 的文件全盘 `scan_directory_manifests` 收集阶段时，没有区分所有权，粗暴捞取了全域的数据向后端 Personal 云服务推送。
**现行机制**：
我在 `personal.rs` 注入了前端级别的拦截网，将原本的全盘搜索改造成了基于 `team_path_mappings.json` 的黑名单过滤算法，直接在物理生成 `manifest` 的内存中**拔除了**全部归属于高层 Team 的资源前缀。
👉 **兼容风险排查请求**：在接下去的 Rust 侧重构或 FS 相关的组件更新中，请不要再使用不设防的全盘级 `scan_directory_manifests`。如果你需要拉取所有本地目录文件，必须意识到 `team_path` 从属于另一个权限池（Scope），不可与 Personal 混同处理。

---

## 3. QA-Tester 对接指引
这两项核心漏洞均已通过 DBA (DB-Tester) 的表约束审核，详见同级 `docs/QA-Tester` 目录下的相关留存审计记录。

> *主架构师留底。后续如果出现 Editor 显示异常或跨库同步串台异象，首推在此防线附近寻回。*
