# Sync Propagation Failure Investigation Report (v2 - CORRECTED)

## 1. 核心现象分析 (Fact-based Analysis)

根据用户提供的 Server 日志和复现过程，我们观察到以下关键事实：

1.  **Promote 时刻 (Sync OK)**: `22:48:02` 提升目录时，`push_directory_to_vault` 命令成功调用了 Team Negotiate 并推送了 `Join note 04.md`。证明：**网络通路和 Promote 逻辑本身是通的。**
2.  **后期同步 (Sync Missing)**: 在 `22:48:10` 和 `22:48:23` 的自动同步循环中，**完全没有**针对 Team Vault (ID: 69df3cf1...) 的 Negotiate 请求。只有 Personal Vault 的请求。证明：**后台自动同步引擎在 Promote 后丢失了对团队空间的追踪。**
3.  **个人空间报错 (403 Regression)**: 个人空间同步报错 `403 Forbidden: Not the owner of this personal vault`。证明：**加入团队过程中，用户本地身份与个人 Vault 的权属关系发生了断裂。**
4.  **无快照、无同步 (Visibility Failure)**: 提升为团队目录后的内容（如 `note 04`），既不触发快照也不同步。证明：**该目录在扫描阶段被 Sync 引擎和快照引擎同时过滤或忽略了。**

---

## 2. 根本原因剖析 (Root Causes)

### 原因 A：自动同步状态未更新 (Sync Deadlock)
*   **现象**: 背景同步循环跳过了 Team Vault。
*   **代码位置**: `apps/desktop/src-tauri/src/commands/sync/team.rs` 中的 `sync_team_full`。
*   **逻辑漏洞**: 
    - 背景同步依赖 `.slash/team_sync_state.json` 中的 `vault_id` 来决定同步哪个团队空间。
    - `promote` 命令 (`push_directory_to_vault`) 虽然更新了路径映射，但**并不会**更新 `team_sync_state.json`。
    - 结果：除非用户重新执行“加入团队”操作，否则后台引擎根本不知道现在有一个活跃的团队空间需要同步。

### 原因 B：身份漂移导致个人空间被锁 (Identity Conflict)
*   **现象**: `403 Forbidden: Not the owner of this personal vault`。
*   **逻辑漏洞**:
    - 用户通过邀请码加入团队时，Client 的 `user_id` (JWT 中的 `sub`) 可能与最初创建 Personal Vault 时生成的 `user_id` (例如 `__personal__` 或旧生成的随机 ID) 不一致。
    - Server 在 `permission.rs` 中进行 `ensure_vault_access` 检查时，发现当前请求者不是个人空间的 `owner_id`，直接拦截。
    - 这导致用户加入团队后，本地的个人资产同步反而挂了。

### 原因 C：路径忽略与大小写冲突 (Visibility Hole)
*   **现象**: 文件夹变为“三不管”地带，既不触发快照也不触发同步。
*   **逻辑漏洞**:
    - **大小写不匹配**: Server 的 PARA 目录是 `01_PROJECTS` (全大写)，而本地扫描出来的路径是 `01_Projects` (混写)。
    - **过滤逻辑越权**: `team.rs` 中的 `build_team_mapped_files` 在判断一个文件是否属于团队时，使用了过于严格的 `starts_with` 检查（且没有处理大小写不敏感）。
    - 当 `Join note 04.md` 被提升为团队目录后：
        1. **Personal 引擎**识别到它已映射到团队，于是标记 `server_deleted` (日志 22:48:02.973 证实了这一点)。
        2. **Team 引擎**在背景扫描时，由于上述大小写或前缀匹配失败，无法识别该文件属于自己。
        3. **Snapshot 引擎**通常复用同步的 Manifest 扫描结果，同样将其漏掉。
    - 结果：该目录从个人 Manifest 移除了，但没进团队 Manifest，彻底隐身。

### 原因 D：Homesteading 深度截断 (Backend Logic Error)
*   **现象**: 即使 Sync 跑通了，根级 PARA 目录可能无法正确设置权限。
*   **逻辑漏洞**: `homestead.rs` 中 `process_homesteading` 的循环范围是 `2..parts.len()`。
    - 对于 `01_PROJECTS/note.md`，其深度为 2。循环 `2..2` 为空。
    - 导致 **根级 PARA 目录 (如 01_PROJECTS)** 不会被注册进 `directory_permissions`。
    - 对于非 Admin 用户，由于根目录缺失权限记录，`get_sync_scope_filter` 会将其过滤掉，导致客户端 PULL 不到。

---

## 3. 拟议修复方向 (Correction Path)

1.  **后端 (Server)**:
    - 修正 `homestead.rs` 循环范围，涵盖深度为 1 的根目录。
    - 处理 `403` 权属自动迁移：如果请求者是团队成员且个人空间的主人是旧 identity，应允许自动 Claim 所有权。

2.  **前端/Rust (Desktop)**:
    - 在 `promote.rs` 成功后，同步更新 `.slash/team_sync_state.json`，激活后台同步。
    - 统一同步引擎的路径匹配逻辑，确保大小写不敏感，并修正 `in_independent_subdir` 的过度过滤。
    - 确保 `AutoSyncManager` 在接收到 Promote 信号后，强制刷新本地 Manifest，使隐藏目录重新上线。
