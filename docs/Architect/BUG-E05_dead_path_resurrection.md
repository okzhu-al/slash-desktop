# BUG-E05: 墓碑路径复活冲突 — 在已删除文件同路径新建文件被错误吞噬

> **优先级**: P2（数据丢失风险）
> **发现时间**: 2026-04-20
> **状态**: 待修复 — 根因已定位

## 复现步骤

1. Lucia 创建 `Lucia02-01.md`（UUID-A）
2. Lucia 删除 → 服务端 `is_deleted=t`（UUID-A 成为墓碑）
3. Lucia 新建 `新建笔记.md`（UUID-B），rename 为 `Lucia02-01.md`
4. **结果**: UUID-B 被服务端错误下发 `server_deleted` 指令杀死

## 根因定案

`negotiate.rs` 两处仅按 **PATH 匹配**，不区分 UUID：

### 杀手 1：Step 2（L396-401）

```rust
if sf.is_deleted {
    if is_team {
        // 🔴 不检查 client 的 file_id 是否与 server 墓碑的 file_id 相同
        server_deleted.push(sf.relative_path.clone());
    }
}
```

服务端有墓碑 UUID-A（`is_deleted=t`），客户端有全新 UUID-B → 路径相同 → 无脑下发删除。

### 杀手 3：Step 4（L520+ 目录清理盲区）

```rust
if client_dirs.contains(&dir) && !matched_dirs.contains(&dir) {
    server_deleted.push(path.clone());
}
```

如果在 Step 2/3 中 `server_needs` 收录了新建文件（将要复活），Step 4 检测到该路径在 `all_deleted_paths` 中（因为有墓碑），会**再次将其强行推入 `server_deleted`**，导致最终下发 Delete 指令！

### 杀手 4：UNIQUE 约束导致数据库 Rename 失败

当客户端请求将新 UUID 的文件改名为墓碑名称时，`negotiate` 内的 UPDATE：
```rust
UPDATE file_states SET relative_path = '...', file_id = '新UUID' ...
```
会因为存在旧的墓碑记录满足 `UNIQUE(vault_id, relative_path)` 约束而**抛出 Constraint Violation 并忽略**！
最终数据库仍然保留旧路径！后续如果 `push` 强行写入，不仅无法新建，反而会通过 `ON CONFLICT DO UPDATE` 中的 `file_id = COALESCE(file_states.file_id, EXCLUDED.file_id)`，**死死抱住旧墓碑的 UUID 不放**，导致全数据结构混乱！

## 修复指令

### 修改文件

`apps/server/src/routes/sync/negotiate.rs`

### Fix 1：清理碍事墓碑（解决 杀手 4 数据库报错）

在 `UPDATE file_states SET relative_path = $1 ... WHERE file_id = $3` 前，提前清除路径的软删除记录（确保只清理不同 UUID 的墓碑）。

```rust
// 🛡️ BUG-E05 Fix 5: 在执行 rename 之前，清除目标路径上可能存在的旧墓碑
// 否则会触发 `file_states` 表的 `UNIQUE` 约束，导致改名失败
if let Err(e) = sqlx::query(
    "DELETE FROM file_states WHERE vault_id = $1 AND relative_path = $2 AND is_deleted = true AND file_id != $3"
)
.bind(vault_uuid).bind(&cf.path).bind(fid_uuid)
.execute(&state.pool).await {
    tracing::error!(path = %cf.path, error = %e, "Failed to clean tombstone before rename");
}
```

### Fix 2：主动避让已复活的 Live File（解决 杀手 3）

在 Step 4（对 `all_deleted_paths` 循环处理时），若目标路径对应的是正在复活的新起文件，禁止将其转为 `delete` 操作。

```diff
-                if client_dirs.contains(&dir) && !matched_dirs.contains(&dir) {
-                    tracing::debug!("negotiate file={} → proactive team soft-deleted", path);
-                    server_deleted.push(path.clone());
-                }
+                // 🛡️ BUG-E05 Fix 4: 如果该路径当前在 server_files 中代表【存活新文件】，绝不删除
+                let has_live_counterpart = server_files.iter().any(|sf| sf.relative_path == *path && !sf.is_deleted);
+                let already_needed_by_server = server_needs.contains(path);
+                
+                if client_dirs.contains(&dir) && !matched_dirs.contains(&dir) {
+                    if has_live_counterpart || already_needed_by_server {
+                        tracing::debug!("negotiate {} → proactive team soft-deleted skipped", path);
+                    } else {
+                        server_deleted.push(path.clone());
+                    }
+                }
```

### Fix 3：Step 2/3 UUID 复活甄别

(已按照上文代码块实施，此处略)

## 验证

1. 删除 `Join04-team.md`（UUID-A） → `is_deleted=t`
2. 新建文件 rename 为 `Join04-team.md`（UUID-B）
3. 同步后检查：前端双端可见，且 DB 表中最终 `file_id = UUID-B`。
4. 旧 UUID-A 墓碑记录应只存在于 `team_trash_records`，`file_states` 可安全剔除。

---

**架构师签发补充修正。2026-04-21**
