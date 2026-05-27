# 协作编辑管线开发运维交底文档 (Collab Editing Pipeline Handover)

文档版本: 1.0 (Phase 7 协同防冲突加固后)
最后更新: 2026-04

本文档旨在为开发和运维团队提供针对 Slash 团队协作模式 (Team Collab / Solo Collab) 核心编辑与同步管线的**终极交底**。经过连续高强度的竞态条件修复与 UI 隔离重构，Slash 的协同同步机制已全面升级。

## 1. 核心架构与挑战 (Architecture & Challenges)

在协作环境下，最大的挑战是如何解决**高频操作的本地持久化竞态 (Race Conditions)** 与**幽灵冲突 (Phantom Conflicts)**。

### 1.1 团队同步的核心思想：双擎机制
*   **Editor 自身写入**: 用户在主编辑器对当前文档的主动敲击，触发正常的 `tauri::fs::write` 和 `AutoSyncManager` 的定时防抖推流。
*   **Bypass 事件穿透 (Task Bypass)**: 当用户在处于“非激活态”的组件（如右侧 Task 面板）上点击 Checkbox 切换任务状态时，**严禁触发本地整盘读取与覆写**。而是以指令形态（`syncService.taskBypass`）直接越权推送给 Server 集群。Server 响应后散播 `task_toggle` 广播，最后再由 Editor DOM 在内存中进行无感静默抹平。

### 1.2 引入 `is_user_edit` 协议栈屏障
**隐患**: 在高频输入时，如果后台收到其他人推送的旧同步快照，自动静默合并 (Auto-Merge) 并复写磁盘时，会导致正在打字的本地内容被系统强制清空/覆盖。
**防线**: 在 `FileManifest` 通讯协议层面强刷了 `is_user_edit: bool` 字段。
*   只有真正的用户键盘操作、按钮动作才会携带 `is_user_edit: true` 作为主动快照。
*   背景同步、后台 Task 等自动化流程携带 `is_user_edit: false`。避免系统因为后置合并产生的空文件被误当成用户的高优级意图上传到 Server 端清空历史记录。

---

## 2. 团队路径投影机制 (Team Path Projection)

团队节点在渲染时存在两套平行的视图体系（Team Collab 与 Team Solo 模式）。一旦处理报错，就会导致 `Task Not Found` 或 `Sync Disabled` 异常。

### 2.1 路径格式解析
*   **虚拟协同路径 (Virtual URL)**: 以 `__team__/<file_path>` 开头。当通过团队面板直接点开协作记录时出现。它是去绝对路径化的。
*   **原生绝对路径 (Absolute URL)**: 正常的本地硬盘路径，如 `/Users/xxx/slash-vault/01_PROJECTS/Subfolder/Note.md`。出现在单机模式下将团队节点 `Promote` 之后的文件树里。

### 2.2 UI 层动态隔离 Hook (`useIsTeamNote.ts`)
我们**废弃了硬编码的字符串特征判断**（例如 `notePath.startsWith('__team__/')`），取而代之的是统一的 React Hook：`useIsTeamNote(notePath)`。

**它的核心原理**是热解析本地的 `team_path_mappings.json`，将绝对物理路径实时刻录到 Server 端 PARA 结构的虚拟路径上以辨识它是否属于 Team 资产，从而达到 UI 层在极速切换下的平滑展现（协作历史面板、编辑锁、幽灵链的动态隐藏等）。

---

## 3. SQLite 防丢失最佳实践 : 任务扫描器 (Task Scanner)

在修复任务状态触发的整个笔记崩溃甚至内容丢失的问题期间，暴露出 SQLite 关联表的致命漏洞，必须以此为戒。

### 3.1 抛弃脆弱的 UUID (Drop Volatile ID Dependency)
**过去做法**: Task Panel 组件传给底层的是 `taskId: 42`，Rust 根据数据库中 ID=42 的条目取出。
**致命隐患**: 任何一次自动同步，底层为了保证一致性往往采取了 "**Delete ALL & Re-Insert**" 的清洗逻辑（导致所有局部 ID 洗牌）。此时点击前端滞留的历史组件，就会触发 `"Task not found"` 找不到对象，或者修改了串过线的目标池，进而导致整篇笔记触发不可回撤的崩塌清空！

**安全原则准则 (Phase 7 稳定版)**
> **严禁在协同高频写入的局部 Node（如任务、块）生命周期中依赖自增 ID 或内部关联的 SQLite UUID 更新数据。**
> 在 `tasks.rs:update_task_completion` 的更新方法中，采用的是 **Path + Raw Text (内容摘要) 的特征锁定法**来防偏位。

### 3.2 离线快照安全锁 (Size Threshold Check)
关于 Size 防线的设定：
*   **非编辑态免记快照**：如果用户根本没打开某笔记或应用处于后台挂起，即使出现极端合并覆盖导致的字节暴跌，也**绝不允许**将空内容判定为有效快照归档（避免清空叠加覆盖丢失）。
*   **仅在激活态计入差异**：在持续的 Active 编辑阶段产生的合理清空动作（如全选+Delete删减了 99% 的字数）才会正常打快照留存。

---

## 4. 协作面板开发运维雷区 (Operations Minefield)

1.  **右侧面板的状态越过保护**:
    右侧全局面板（如 Activity History）的 DOM 在笔记切换时极易残留时区引用。**务必使用 `useIsTeamNote` 进行条件组装**。
2.  **Team Solo 状态分发**:
    由 Server 下推的 Collab 活动同步信号（如 `task_toggle`，由 `AutoSyncManager.ts` 捕获）下推的内容一定是“虚拟协同路径”（`file_path: 01_PROJECTS/X.md`）。
    为了让处在绝对物理路径视角的底层编辑器能捕获到该事件：我们在 `AutoSyncManager.ts` 利用路由反查（Reverse Maping）进行了双向投递：同时广播 `__team__/` 路线与**逆推导的绝对路径**，确保用户无感知的 DOM 更新。 

> **结束语**： 
> 此文档为协同编辑基建稳定版本的最后一块拼图。协作同步本质上是多客户端抢占同一片物理硬盘缓冲区的零和博弈。只有敬畏每一条写入时序（引入 Bypass 隔离），在读写边界布设安全屏障（放弃局部 ID 的持久关联，使用 `is_user_edit` 拒绝系统黑盒快照覆盖），方可长治久安。
