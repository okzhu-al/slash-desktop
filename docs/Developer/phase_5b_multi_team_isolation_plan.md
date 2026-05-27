# Phase 5b: 多团队映射隔离与离线保护体系 (BUG-B11 整体改造方案)

## 背景问题 (The Problem)

在现有的同步机制与隔离下发现 BUG：
当系统允许一个用户连接多个 Team 时，同步系统与本地缓存发生冲突：
1. **多团队缓存污染**：`team_path_mappings.json` 被设定为单一定向记录。即使切换到了 Team B，Team A 创建/映射好的个人路径逻辑被保留，导致 Team A 的 Offline 文件夹有可能会不小心混入或意外上传到当前的 Team B 关联体系。
2. **状态误伤 (Promote 冲突)**：一个已推送给 Team A 的离线历史遗留目录，如果在当前的 Team B 环境下，系统未能识别其为"历史团队的个人隔离库"，会允许再次 Promote 到当前的 Team B 引发严重串账。

## 目标需求 (The Goals)

1. **服务端与文件存储结构**：升级 `team_path_mappings.json` 架构为 V2，允许基于 `vault_id` 为 Key 并发保留多团队资产记录。
2. **逻辑分流 (Online vs Offline)**：同步引擎仅读取当前激活队伍 (Online) 的记录进行推送和同步。
3. **全局读保护隔离**：个人视角的编辑限制钩子 (`useIsTeamNote.ts`) 和 UI 的 Promote 锁死限制要能够**兼顾 Offline 和 Online 记录**，从而禁止对已属 Offline 团队的 Personal Folder 再次执行不兼容的 CRUD/同步变更。

---

## 详细提议变更 (Proposed Implementation)

### 1. Backend 存储与拦截链路改造 (Rust Core)

**[NEW/MODIFY] `path_mapping.rs`**
将 `TeamPathMappingsFile` 的数据结构由扁平状变更为按 Team ID 隔离的字典树。
```rust
pub struct TeamPathMappingsFile {
    pub teams: HashMap<String, HashMap<String, String>>, // vault_id -> { local_dir: target_dir }
}
```
**热迁移逻辑 (`load` 阶段)**：对旧的基于 `"mappings"` 字段反序列化失败的回退方案。在第一次反序列化时如果识别到旧 `vault_id` 层级，直接洗入 `teams` 层级，避免破坏历史同步关联。

**[MODIFY] `sync/promote.rs` / `sync/personal.rs` / `sync/team.rs`**
放弃原先发现 Vault 变动就直接 `mappings.clear()` 的暴力清空行为。基于新的 `teams.get_mut(&vault_id)` 进行定向插入与擦除，实现多团队的离线配置共存。

---

### 2. Frontend 核心防线部署 (TypeScript)

**[MODIFY] `useTeamDirectoryMapping.ts` (Hooks Gateway)**
这是最关键的数据分捡口。改造钩子解析上述新型 `data.teams`，输出两条逻辑路径：
- `activeMappings`: 只有当前 `sessionStore` 登录持有的 `teamVaultId` 匹配的目录。
- `offlineMappings`: 当前不在登录上下文中，但曾经被 Promote 过的其他所有 Team 的剩余目录。
- **引入 `removeMapping` Agent 函数**：收拢以前零散在 UI 各处的 `.slash/team_path_mappings.json` 直接复写行为。提供安全更新指定源字典的功能。

**[MODIFY] 同步推送控制 (`AutoSyncManager.ts` & `store.ts`)**
- 全力修剪后台心跳与未读数据的解析：本地发起的 Pull/Push 拉取指令要求**彻底无视图鉴 `offlineMappings`**，只能遍历 `activeMappings`，避免把已退出的团队文件在后台反复重推给现任团队服务器。

**[MODIFY] UI 污染守护 (`useIsTeamNote.ts` & `FolderPage.tsx` 等)**
跨团队强隔离系统（安全检测防御机制）：
- 原拦截器一律升级；拦截规则：源路径受管控条件等于 `activeMappings.has(path) || offlineMappings.has(path)`。
- 对于遗留的其他团队离线目录文件，其徽章 Badge、编辑器只读权限、侧边栏不可拖曳判定，均严格向 Online 在线团队看齐，彻底锁死。
- `useFileTreeActions.ts` (Promote API 限制)：新增拦截点。当进行 Promote 操作时，检测当前目标目录是否已经在别的团队的离线映射中，强制弹出阻止提醒，阻止串联映射。

---

## 验证与验收方案 (System Verification)

1. **类型层 (Compile Checks)**：
   运行 `pnpm tsc --noEmit`，确保 `activeMappings` 与映射迭代器的 API 改动没有在深层级（如侧边栏拖拽模块 `useSidebarDragDrop.ts` 等）残留类型错误。
2. **底层防护验证 (Rust Tests)**：
   运行 `SQLX_OFFLINE=true cargo check` 以及重载映射，确保新旧版本结构 JSON 平滑跨越且成功读出记录。
3. **全链路行为验证 (Behavioral Validations)**：
   - 使用 Team A 登录并推广 (Promote) 一个本地 `Test1` 文件夹。
   - 切换登录到 Team B，确认 `Test1` 仍然显示团队图标并保留编辑限制。
   - 尝试在 Team B 对 `Test1` 进行再推广 (Promote)，确认触发"跨团队混绑禁止"错误弹窗。
   - 确认 Team B 的后台全量 Sync 以及 Pull 时，同步日志内没有对 `Test1` 做出任何拉取和变更。
