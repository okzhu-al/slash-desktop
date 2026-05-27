# 报告：BUG-E07 团队删除操作传播同步修复 (Team Delete Propagation Fix)

**日期**：2026-04-21
**状态**：已解决 (Resolved)

## 问题回顾 (The Problem)

在 Team Vault 中，当具有 Admin 或 Owner 权限的用户删除结构性内容（例如目录或整个包含大量文件的结构）时，由于服务端目录的 `directory_permissions` 一并被清除，非操作端在执行同步（Sync V3 Negotiate）时，发生过滤漏洞导致本地路径陷入同步盲区。
结果，这些早已被服务端删除（soft delete）的文件不但没有同步到其他客户端删除，反而会因为其他客户端对未删除的本地文件执行上报，重新发起 `push` 导致已经被删除的僵尸文件或结构被**重新复活**。

## 架构级定位与应对原则

问题核心在于权限截断引起的“同步视窗消失”，我们主要采取“操作端即时物理清理”与“同步引擎后备冗余防盲”的双线策略来修复该问题。

---

## 具体的修复点 (Implemented Fixes)

### 1. 前端：Admin 主动本地清理与状态剥离 (Proactive Purge)
**修改目标**：`apps/desktop/src/features/sidebar/hooks/useTeamAdminActions.ts`
**具体动作**：
*   在 `handleAdminDeleteDir` 与 `handleAdminDeleteFile` API 成功返回（删除云端资源）后，第一时间调用物理层直接解析并清除本地遗留文件，无需干等同步引擎计算。
*   清除掉同步大脑记忆，利用正则和相对路径匹配清剿 `.slash/unified_sync_state.json` 中的 `team_hash` 记录，保证系统不再有关于被删内容的历史包袱。

### 2. 客户端引擎：PARA 根级智能回推 (Root Fallback)
**修改目标**：`apps/desktop/src-tauri/src/commands/sync/team.rs` (`detect_team_deleted`)
**具体动作**：
*   当本地系统失去具体的目录 `target_path` 的 `reverse_mapping` 记录（往往意味着某个中层目录已被服务端没收），系统会回退到使用最外层的宏观领域知识：`PARA_TEAM_TO_PERSONAL` (例如 `01_PROJECTS` => `01_Projects`) 自动拼凑恢复路径。
*   以此成功推算出它本应属于的云端目标路径，将其正确标为已被本地删除，触发协商删除。

### 3. 服务端：Negotiate 条件的安全放宽 (Relaxed Condition)
**修改目标**：`apps/server/src/routes/sync/negotiate.rs` (`Step 4`)
**具体动作**：
*   修复前，必须是在上报的合法目录 `client_dirs` 层级中才会下发删除指令。
*   现在进行了关键**放宽（Relaxed）**：即使该目录不在服务端的常规目录列表中，只要客户端依然直接**上报了具备该路径的文件（client_has_file）**，或**报告该目录产生了差异（dir_unmatched）**，服务端就会直接下发明确指引：“该文件已在我这死掉，请你立刻进行清理”。防止僵尸文件重活。

### 4. 客户端引擎：空壳目录清剿 (Phantom Directory Cleanup)
**修改目标**：`apps/desktop/src-tauri/src/commands/sync/team.rs` (`Step 7.5 Server Deleted`)
**具体动作**：
*   当 `negotiate` 的 `server_deleted` 成功在本地物理删除某遗骸文件后，补上了一步往上溯回检测操作。
*   自动循环识别，如果此父目录仅存在此被删文件，清理干净空目录。一路向上直到撞见真正的系统文件夹树状顶部结束。

---

## 验证与预防 (Verification)

1.  **已避免僵尸复活**：任何被服务删除的文件，已经具备完整的防弹衣：前线 Admin 物理强删 + 服务端强迫下发指示 + 客户端自动向上溯源。
2.  **避免了不当的重上传**：由于本地统一历史 `unified_sync_state.json` 一致被清空且服务端防线松绑，非 Admin 用户打开应用同步时，只有被通知清掉的命，不存在将自己未知的盘面僵尸二次污染整个团队网的机会。

## 下一步 (Next Steps)

*   **持续观测**：留意有大量极速嵌套的协同并发时，是否依然能平滑同步。当前已经极大提升了 V3 Sync Engine 被滥用或大面积结构调整下的鲁棒性。
