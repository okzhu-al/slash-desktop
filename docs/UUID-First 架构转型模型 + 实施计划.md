# UUID-First 架构转型：终局模型 + 实施计划

## 设计原则

1. **身份与位置分离**：`directory_id` / `file_id` 是身份，`current_path` 是可变属性
2. **实体一等公民**：目录和文件都是独立实体，权限/回收站/快照都按 ID 关联
3. **判断优先级**：`file_id > current_path > content_hash`，全链路统一
4. **rename 是正式语义**：不是"删除+创建"，而是"更新 current_path"
5. **术语统一**：frontmatter 保留 `slash_id`，协议/数据库/服务端统一用 `file_id`，目录统一用 `directory_id`

---

## 一、终局数据模型

### 1.1 directories 表（新建 — 目录实体）

```sql
CREATE TABLE directories (
    directory_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id      UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    current_path  TEXT NOT NULL,         -- 可变：rename 时 UPDATE
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ           -- NULL = 存活，非 NULL = 已删除
);

-- 同一时刻同一路径只允许一个存活目录
CREATE UNIQUE INDEX idx_directories_alive
    ON directories(vault_id, current_path)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_directories_vault ON directories(vault_id);
```

> [!IMPORTANT]
> `directories` 只管理 **团队目录实例**（即被 promote 或 homestead 注册过的目录）。纯个人目录不入此表。`deleted_at IS NULL` 的偏序唯一索引允许同一路径有多个已删除的历史实例。

### 1.2 file_states 表（重构 — file_id 为身份主键）

```sql
-- 原有 UNIQUE(vault_id, relative_path) 改为：
-- 身份键: file_id（非空时唯一）
-- 位置键: current_path（可变）

ALTER TABLE file_states RENAME COLUMN relative_path TO current_path;
ALTER TABLE file_states RENAME COLUMN file_uuid TO file_id;

-- 新增唯一索引：同一 vault 内 file_id 唯一（排除 NULL）
CREATE UNIQUE INDEX idx_file_states_identity
    ON file_states(vault_id, file_id)
    WHERE file_id IS NOT NULL;

-- 保留路径索引（查询辅助，不作为身份）
-- 原 UNIQUE(vault_id, relative_path) 降级为普通索引
DROP INDEX IF EXISTS file_states_vault_id_relative_path_key;
CREATE UNIQUE INDEX idx_file_states_path_alive
    ON file_states(vault_id, current_path)
    WHERE is_deleted = false;
```

> [!WARNING]
> `relative_path` → `current_path` 的列重命名影响所有引用此列的服务端代码。需要全局搜索替换。这是改动最大的一步。或者在迁移阶段保留 `relative_path` 列名，通过注释标注其语义已变为"可变位置"——视实际改动量决定。

### 1.3 directory_permissions 表（改造 — 绑定 directory_id）

```sql
-- 终局结构：
-- PRIMARY KEY: id (UUID)
-- 身份关联: directory_id (NOT NULL, FK → directories)
-- directory_path 列保留但降级为冗余/缓存（便于日志、调试），不作为查询主键

ALTER TABLE directory_permissions
    ADD COLUMN directory_id UUID REFERENCES directories(directory_id);

-- 迁移完成后：
-- ALTER TABLE directory_permissions ALTER COLUMN directory_id SET NOT NULL;
-- DROP INDEX idx_dir_perm_vault_path; -- 路径索引降级
-- 新唯一约束
-- UNIQUE(vault_id, directory_id, user_id)
```

### 1.4 team_trash_records 表（改造 — 绑定 directory_id + file_id）

```sql
ALTER TABLE team_trash_records
    ADD COLUMN directory_id UUID REFERENCES directories(directory_id);

ALTER TABLE team_trash_records RENAME COLUMN original_uuid TO file_id;

-- 查询改造：按 directory_id 查归属，不再 LIKE path
CREATE INDEX idx_trash_directory ON team_trash_records(vault_id, directory_id);
```

> [!IMPORTANT]
> **Trash 归属规则**：trash record 的 `directory_id` 指向该文件所属的**最近的团队目录祖先**（即在 `directories` 表中能找到的、`current_path` 是其前缀的、且 `deleted_at IS NULL` 的最长匹配目录实例）。这确保 trash 不会挂到任意物理子目录上。

### 1.5 file_snapshots 表（改造）

```sql
ALTER TABLE file_snapshots RENAME COLUMN file_uuid TO file_id;
-- file_path 保留为快照时刻的路径快照（不可变，历史记录），不作为查询主键
-- 查询改为 WHERE vault_id = $1 AND file_id = $2
```

### 1.6 doc_comments / annotations（改造）

```sql
ALTER TABLE doc_comments RENAME COLUMN file_uuid TO file_id;
-- file_path 保留为冗余/缓存
-- 查询改为 WHERE vault_id = $1 AND file_id = $2
```

### 1.7 同步协议（终局）

```rust
// NegotiateFileEntry — 文件级协商条目
pub struct NegotiateFileEntry {
    pub file_id: Option<String>,    // 身份主键（优先）
    pub current_path: String,       // 当前路径（辅助 + fallback）
    pub hash: String,
    pub base_hash: String,
}

// NegotiateDeleteEntry — 删除声明（替代原 deleted_paths: Vec<String>）
pub struct NegotiateDeleteEntry {
    pub file_id: Option<String>,    // 文件身份
    pub last_known_path: String,    // 最后已知路径
}

// SyncNegotiateRequest 改造
pub struct SyncNegotiateRequest {
    pub vault_id: String,
    pub space_type: SpaceType,
    pub directory_hashes: Vec<DirectoryHash>,
    pub client_clock: u64,
    pub client_files: Vec<NegotiateFileEntry>,       // file_id 优先
    pub deleted_entries: Vec<NegotiateDeleteEntry>,   // 替代 deleted_paths
}
```

**服务端 negotiate 匹配算法：**

```
对每个 client_file:
  1. 如果 file_id 非空 → 按 (vault_id, file_id) 查 file_states
     - 找到 且 current_path 不同 → RENAME（更新 path，记录 rename snapshot）
     - 找到 且 current_path 相同 → 比较 hash（正常 push/pull 判断）
     - 没找到 → NEW FILE（首次注册）
  2. 如果 file_id 为空 → 按 (vault_id, current_path) 查 file_states（兼容无 UUID 的文件）

对每个 deleted_entry:
  1. 如果 file_id 同时出现在 client_files 中 → 跳过（rename，不是删除）
  2. 否则 → 执行 soft-delete + trash 入库
```

### 1.8 客户端同步状态（终局）

```rust
// UnifiedFileState — 每个文件的同步状态
pub struct UnifiedFileState {
    pub personal_hash: String,
    pub team_hash: String,
    pub local_snapshot: String,
    pub edit_started_at: Option<i64>,
    pub file_id: Option<String>,       // 文件身份 UUID
    pub current_path: Option<String>,  // 该 file_id 当前对应的本地路径
}

// UnifiedSyncState — 双索引结构
pub struct UnifiedSyncState {
    // 主索引：local_path → state（兼容现有逻辑）
    pub by_path: HashMap<String, UnifiedFileState>,
    // 副索引：file_id → local_path（rename 检测 + 状态迁移）
    pub id_to_path: HashMap<String, String>,
}
```

**Rename 时的状态收敛：**

```
renameNote(old_path → new_path):
  1. 从 by_path[old_path] 取出 state（含 file_id）
  2. 删除 by_path[old_path]
  3. 更新 state.current_path = new_path
  4. 写入 by_path[new_path] = state
  5. 更新 id_to_path[file_id] = new_path
  6. persist
```

**detect_team_deleted 终局逻辑：**

```
对 by_path 中每个 (local_path, state)：
  如果 state.team_hash 非空 且 本地文件不存在:
    如果 state.file_id 非空:
      检查 id_to_path[file_id] 是否指向另一个存活的路径
        → 是：这是 rename，不是 delete。跳过。
        → 否：真删除，加入 deleted_entries。
    否则：
      按旧逻辑处理（无 UUID 的遗留文件）
```

---

## 二、术语映射表

| 位置 | 旧术语 | 新术语 | 说明 |
|------|--------|--------|------|
| YAML frontmatter | `slash_id` | `slash_id` | 保持不变，用户可见 |
| 协议层 (proto) | `file_uuid` | `file_id` | NegotiateFileEntry / FileManifest |
| 服务端 DB | `file_uuid` / `original_uuid` | `file_id` | file_states / file_snapshots / team_trash_records |
| 客户端 state | 无 | `file_id` | UnifiedFileState |
| 目录实体 | 不存在 | `directory_id` | directories 表 |
| 目录权限 | `directory_path` (身份) | `directory_id` (身份) + `directory_path` (缓存) | directory_permissions |
| 文件路径 | `relative_path` (身份) | `current_path` (属性) | file_states |

---

## 三、实施步骤

> 终局模型已定，以下 Step 只影响开发顺序，不改变最终数据模型。

### Step 1：建实体表 + Schema 迁移

**范围**：纯数据库层，不改业务代码。

1. 创建 `015_uuid_first.sql` 迁移脚本：
   - CREATE TABLE `directories`
   - ALTER `directory_permissions` ADD COLUMN `directory_id`
   - ALTER `team_trash_records` ADD COLUMN `directory_id`，RENAME `original_uuid` → `file_id`
   - ALTER `file_snapshots` RENAME `file_uuid` → `file_id`

2. 暂不 RENAME `file_states.relative_path`（因为引用点太多，放到 Step 3 和业务代码一起改）。先 ADD COLUMN 方式过渡也可。

3. 历史数据处理策略：
   - `directories`：从现有 `directory_permissions` 的 `DISTINCT (vault_id, directory_path)` 组合生成目录实体，回填 `directory_id`
   - `team_trash_records`：**不做 path 推断回填**。无法确认归属的历史记录 `directory_id` 留 NULL
   - 新架构查询只认 `directory_id IS NOT NULL` 的记录，legacy 数据单独处理（或显示为"历史遗留"分区）

**验证**：`cargo check`（服务端编译通过），迁移脚本可执行。

---

### Step 2：服务端目录生命周期切换

**范围**：`directories.rs` + `trash.rs` + `homestead.rs` + `negotiate.rs`（目录相关部分）。

改造顺序：

1. **`set_directory_permissions`** — 推送/Homestead 创建目录时：
   - 先查 `directories WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL`
   - 不存在 → INSERT 新 `directories` 行，拿到 `directory_id`
   - 存在 → 复用已有 `directory_id`
   - `directory_permissions` INSERT 时带上 `directory_id`

2. **`delete_directory`** — 删除目录时：
   - UPDATE `directories SET deleted_at = NOW() WHERE directory_id = $dir_id`
   - 写 `team_trash_records` 时带上 `directory_id`
   - 不再 DELETE `directories` 行（只 soft-delete）

3. **`rename_directory`** — 重命名目录时：
   - UPDATE `directories SET current_path = $new_path WHERE directory_id = $dir_id`
   - `directory_id` 不变（身份不变，位置变）
   - `directory_permissions.directory_path` 同步更新（冗余缓存字段）

4. **`list_trashed_files`** — 回收站查询：
   - 查当前目录的 `directory_id`（从 `directories` 表查）
   - `WHERE tr.directory_id = $dir_id`（不再 LIKE）
   - 无 `directory_id` 或 `directory_id IS NULL` → 返回空（不 fallback 到 path）

5. **`restore_trashed_file`** — 恢复逻辑不变：
   - 恢复路径碰撞时仍走 `(Recovered)` 重命名

6. **`get_my_scope` / `get_directory_permissions`** — 改为按 `directory_id` 查询：
   - `SELECT d.current_path, dp.dir_role FROM directory_permissions dp JOIN directories d ON dp.directory_id = d.directory_id WHERE dp.vault_id = $1 AND dp.user_id = $2`

7. **negotiate.rs 中写 trash 墓碑** — 带上 `directory_id`：
   - 从 `directories` 表查文件路径对应的最近团队目录祖先的 `directory_id`

**验证**：
- 新建目录 → `directories` 表有记录
- 删除目录 → `directories.deleted_at` 非 NULL
- 重建同名 → 新 `directory_id`，旧 `directory_id` 的 trash 不可见
- Rename → `directory_id` 不变，`current_path` 更新

---

### Step 3：服务端文件层切换

**范围**：`push.rs` + `negotiate.rs` + `pull.rs` + `snapshot.rs` + `permission.rs` + `file_states` 表结构。

1. **`file_states` 列改造**：
   - 确保所有团队文件都有 `file_id`（push 时如果 frontmatter 无 `slash_id`，服务端生成一个）
   - RENAME `relative_path` → `current_path`（或保留旧名，在代码中统一语义）
   - 调整唯一约束：`UNIQUE(vault_id, current_path) WHERE is_deleted = false`

2. **push.rs — Upsert 逻辑**：
   - 当前：`ON CONFLICT (vault_id, relative_path)` — 按路径冲突
   - 终局：优先按 `(vault_id, file_id)` 查是否已存在
     - 存在 且 path 不同 → **Rename**：UPDATE `current_path`，记录 rename snapshot
     - 存在 且 path 相同 → 正常 UPDATE hash/size/clock
     - 不存在 → INSERT 新行

3. **negotiate.rs — 文件级对比**：
   - 解析 `NegotiateFileEntry.file_id`
   - 按 `file_id` 匹配 server_files，再按 `current_path` fallback
   - 处理 `deleted_entries`：检查 `file_id` 是否在当前批次 `client_files` 中存活

4. **snapshot.rs — detect_rename**：
   - 已有 UUID rename 检测逻辑，保持并强化
   - Rename snapshot 记录旧路径 → 新路径

5. **permission.rs — resolve_effective_role**：
   - 当前按 path 查 `directory_permissions`
   - 改为：先从 `directories` 查 `directory_id`，再按 `directory_id` 查权限
   - 保留 path 前缀匹配作为 `directories` 表内的 JOIN 条件

**验证**：
- 新建笔记 → `file_states` 有 `file_id`
- 重命名笔记 → `file_states.current_path` 更新，`file_id` 不变
- 回收站无幽灵删除记录

---

### Step 4：客户端 Sync 层切换

**范围**：`team.rs` + `personal.rs` + `state.rs` + `helpers.rs` + `lib.rs (slash-core/slash-sync-proto)`

1. **`FileManifestBasic` 扩展**：
   - 新增 `file_id: Option<String>`
   - `scan_directory_manifests` 扫描 `.md` 文件时提取 `slash_id`

2. **`NegotiateFileEntry` 协议扩展**：
   - 新增 `file_id: Option<String>`（`serde(default)` 向后兼容）
   - 新增 `NegotiateDeleteEntry` 结构（替代 `deleted_paths: Vec<String>`）

3. **`UnifiedSyncState` 重构**：
   - `UnifiedFileState` 新增 `file_id` + `current_path`
   - 实现双索引（`by_path` + `id_to_path`）
   - `save/load` 序列化保持向后兼容（旧 JSON 加载时 `file_id` 为 None）

4. **`detect_team_deleted` 重写**：
   - 基于 `file_id` 检测 rename vs delete
   - rename 时自动迁移 state（旧路径 entry → 新路径 entry）

5. **`renameNote` 联动**：
   - Rename 成功后，从 `unified_sync_state` 迁移旧路径的 state 到新路径
   - 更新 `id_to_path` 索引

6. **构建 `NegotiateFileEntry` 时带上 `file_id`**

**验证**：
- 新建笔记 + 立刻重命名 → 无幽灵删除
- Rename 后 sync → 服务端正确识别 rename
- `unified_sync_state.json` 中新路径有完整 state

---

### Step 5：清理 + Legacy 处理

1. 去除所有路径作为身份的 fallback 逻辑（LIKE 查询等）
2. Legacy `team_trash_records`（`directory_id IS NULL`）在 UI 中显示为"历史遗留"或不显示
3. 去除 `negotiate.rs` 中的 `deleted_paths` 字段（用 `deleted_entries` 替代）
4. 确认 `FolderPage.tsx` 的 PARA fallback 已不需要（因为目录身份由 `directory_id` 决定）
5. 全面回归测试

---

## 四、开发顺序与并行策略

```
Step 1 (Schema 迁移)
  ↓
Step 2 (服务端目录层)  ←→  Step 3 (服务端文件层)  ← 可并行：一个改目录系统,一个改文件系统
  ↓                          ↓
  └──────────┬───────────────┘
             ↓
Step 4 (客户端 Sync 层)
             ↓
Step 5 (清理 + Legacy)
```

Step 2 和 Step 3 代码交集小（目录 vs 文件），可并行开发。Step 4 依赖 Step 2+3 的协议改动。

---

## 五、关键风险

| 风险 | 应对 |
|------|------|
| `relative_path` 全局重命名影响面大（50+ 处引用） | 可先保留列名不改，只在语义上重新定义。代码注释标注"此字段含义已变为可变位置"。 |
| 无 `slash_id` 的二进制文件如何处理 | 服务端 push 时为无 `file_id` 的文件自动生成 UUID，回写到 `file_states.file_id`。客户端在下次 pull 时获得此 `file_id` 并存入 sync state。 |
| 旧客户端发送无 `file_id` 的 negotiate 请求 | `serde(default)` 确保反序列化不失败，服务端 fallback 到 path 匹配（但新客户端不再走此路径）。 |
| `directories` 表与现有 `directory_permissions` 的一致性 | 在 Step 1 迁移时从 `directory_permissions` 生成 `directories` 行并回填，Step 2 开始后所有写入都同时操作两张表。 |

---

## 六、修改文件总览

| Step | 文件 | 改动性质 |
|------|------|----------|
| 1 | `migrations/015_uuid_first.sql` | [NEW] |
| 2 | `routes/team/directories.rs` | [MODIFY] 全文 |
| 2 | `routes/team/trash.rs` | [MODIFY] 查询改造 |
| 2 | `routes/sync/homestead.rs` | [MODIFY] directory_id 生成 |
| 2 | `routes/sync/negotiate.rs` | [MODIFY] trash 墓碑带 directory_id |
| 3 | `routes/sync/push.rs` | [MODIFY] file_id-first upsert |
| 3 | `routes/sync/negotiate.rs` | [MODIFY] file_id 匹配 + deleted_entries |
| 3 | `routes/sync/pull.rs` | [MODIFY] file_id 传递 |
| 3 | `routes/sync/snapshot.rs` | [MODIFY] 术语统一 file_id |
| 3 | `routes/sync/helpers.rs` | [MODIFY] 术语统一 |
| 3 | `permission.rs` | [MODIFY] directory_id JOIN 查询 |
| 4 | `slash-core/src/lib.rs` | [MODIFY] FileManifestBasic + file_id |
| 4 | `slash-sync-proto/src/lib.rs` | [MODIFY] 协议结构 + NegotiateDeleteEntry |
| 4 | `commands/sync/team.rs` | [MODIFY] detect_team_deleted + negotiate 构建 |
| 4 | `commands/sync/state.rs` | [MODIFY] UnifiedSyncState 双索引 |
| 4 | `commands/sync/helpers.rs` | [MODIFY] file_id 提取 |
| 4 | `commands/sync/promote.rs` | [MODIFY] file_id 传递 |
| 5 | `features/folder/FolderPage.tsx` | [MODIFY] 去除 PARA fallback |
| 5 | `features/team/TeamDirPanel.tsx` | [MODIFY] 确认只按 directory_id 查 |
