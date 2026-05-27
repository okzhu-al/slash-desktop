# 📂 Slash 团队协作与目录权限隔离业务规则白皮书

本白皮书定义了 Slash 团队协作体系下的核心设计哲学、权限隔离准则、物理删除与级联拦截边界、编辑器全局提及机制、以及多端同步时的状态自愈逻辑，是多团队高一致性同步的“设计宪法”。

---

## 1. 核心设计哲学 (Design Philosophy)

1. **零本地目录实体表设计 (Stateless Directories)**：
   客户端本地 SQLite 数据库**只同步和缓存文件的 ID (`slash_id`)，不维护任何目录 (directories) 实体表**。物理目录本身只存在于本地文件系统中，其在云端的团队归属权与远程路径由映射配置文件唯一驱动。
2. **映射配置文件为真理之源 (Path Mappings as Source of Truth)**：
   `.slash/team_path_mappings.json` 是多团队协作体系下的唯一路径映射真理之源。由于本地 SQLite 不存目录实体，物理映射文件承担了本地绝对路径与远程云端路径的“转换桥梁”。
3. **UUID-First 与身份位置解耦**：
   团队笔记在传输和本地缓存中全程使用云端 `file_id` (UUID) 作为唯一身份标识（写入笔记 Frontmatter），而其物理路径 (Path) 作为位置属性可随时变更。重命名或移动只变更位置，不损灭身份。

---

## 2. 协作目录权限与隔离级别 (Permissions & Isolation)

* **创建者即 Owner**：用户在协作团队目录中创建子目录时，创建者在云端 `directory_permissions` 中自动被赋予该子目录的 `Owner` 角色；团队管理员 (Admin) 与其他协作者自动降级为普通 `Member`。
* **Member 权限边界**：Member 拥有该目录下笔记的读写、修改、重命名权，但不拥有级联删除该目录的物理控制权。

---

## 3. 删除与级联拦截机制 (Deletion & Cascade Interception)

### 📌 机制 A：普通删除鉴权（`manageMode = false`）
适用于普通的侧边栏右键删除菜单。Admin 和所有普通成员发起删除时都必须通过此屏障，以保护他人资产：
1. **防越权处决（单个文件）**：非笔记的前一个 Editor（记录在 Metadata Frontmatter 中）或 Admin，无法在侧边栏物理删除该团队文件。
2. **非目录 Owner 阻断**：若发起者不是该协作目录的 `Owner`（且非全局 Admin），则直接阻断删除并报 `not_owner` 越权提示。
3. **他人资产级联阻断**：即使是目录的 `Owner`（或全局 Admin），若被删除目录的子树中含有**其他成员创建/编辑的子目录或文件**，普通删除也会直接阻断并报 `has_other:username` 越权提示，强制保护他人资产不被级联误抹！

### 📌 机制 B：特权紧急救灾（`manageMode = true`）
仅限全局管理员 (Admin) 在专门的“Admin 维护控制台”中使用：
* **强行拔除**：豁免“他人资产级联阻断”，允许 Admin 强行清理已废弃、混乱或含有冲突资产的目录。
* **本地超度**：Admin 强行清理后，通过 `directory_deleted` 等广播信号级联超度其他协作者本地的物理缓存与同步状态（`unified_sync_state.json` 中的 `team_hash`）。

---

## 4. 全局 @ 提及与人员自愈拉取机制 (Global Mentions & Member Autogrow)

为了支持“在笔记中提及成员自动加入目录”的高级逻辑，编辑器内任何地方的 `@` 提及必须随时具备全局团队视野：
1. **全局成员数据驱动**：任务列表中的 `@` 提及选择器（`UserPopup` 及 `TaskItemComponent`）统一订阅全局变量 `(window as any).__slashTeamMembers` 作为其下拉候选人的唯一真理之源。
2. **个人视图下的自愈拉取**：
   * 在个人库视图（`teamVaultId` 在前端 session 中为空）下，客户端原本无法直接从侧边栏获取全局成员。
   * **解决方案**：一旦用户打开任何一篇被标记为团队协作的物理笔记，编辑器底层的 `useEditorCollaboration` 在自愈推导出 `resolvedVaultId` 后，**将自动绕过当前库视图的限制，动态向云端发起 `listMembers` 请求**。
   * 客户端异步将最新的团队全局成员列表（包含所有新加入的团队成员，如新成员 `OO`）全量拉取，并直接写入全局变量 `__slashTeamMembers` 作用域中，保证协作提及的 100% 连通性。

---

## 5. 两端同步自愈与空目录幽灵防复活算法 (Heal & Anti-Ghosting Sync)

### 1) 动态 Mapping 自愈机制（受邀端）
当协作者处于个人库视图（前端全局 session 的 `teamVaultId` 为空）时，其内存中的激活映射为空。为防止在此时删除属于团队的所有权目录时漏发云端删除信号：
* **落盘自愈**：当前端发起删除时，若算不出远程路径，将回退读取磁盘 `.slash/team_path_mappings.json`，反向动态匹配绝对物理路径。
* **匹配补齐**：自动标准化反斜杠（兼容 Windows/macOS），动态逆向推导出真实的 `currentTeamVaultId` 与云端 `targetRemotePath`，成功补齐 REST 请求参数，确保云端被完全同步删除。

### 2) T-4 🧹 幽灵清剿与精确匹配（拉取端）
当 Owner 将云端目录物理删除后，云端关于该目录的 `directory_permissions` 记录会被物理清空。当协作者设备拉取同步时：
* **结构化精确匹配**：在 T-4 清剿算法判定映射路径是否在 `managed_dirs` 中时，对子目录必须使用**精确匹配**，防止因为其上级目录（父团队目录）在 `managed_dirs` 中而使失效的子目录被误判为存活。
* **本地物理超度**：精确匹配失败后，T-4 逻辑将果断从本地 `team_path_mappings.json` 中物理抹除该子目录的残留映射，并使用 `std::fs::remove_dir_all` 连根拔起本地对应的空文件夹，阻断其在下轮同步中因 `Step 3.5` 被幽灵般再次 `mkdir` 重建！

---

## 6. 重命名传播与避让 (Rename & Cascade Update)
1. **重命名冲突避让**：在本地拉取或创建团队目录时，若物理路径与用户现存的个人物理目录发生同名冲突，客户端将采用 **“避让改名”** 策略，将原个人文件夹重命名为 `dir_name（个人）`，保障团队目录映射绝对放行。
2. **权限与回收站级联传播**：重命名团队子目录时，云端将自增 Logical Clock，不仅批量同步重映射旗下所有笔记路径，还会级联更新 `directory_permissions` 缓存以及 `team_trash_records`（回收站记录），保证被软删除的垃圾条目在改名后依然保持“原路恢复”的完美一致性。
