# 架构师指令：修复 logical_clock 重命名断链

> **优先级**: P1
> **缺陷类型**: 数据完整性 — 版本时钟断裂

---

## 问题描述

当文件被重命名时（UUID-First rename 检测），服务端在两个环节都未正确维护 `logical_clock` 的连续性：

**现象**（实测数据）：
```
file_id=e92e5fce  旧路径（新建笔记.md）  logical_clock=2  is_deleted=t
file_id=e92e5fce  新路径（Join local note 01.md）  logical_clock=0  ← 断链
```

同一个 `file_id` 的版本时钟从 2 掉回 0，多端并发场景下会导致冲突仲裁失去时序依据。

## 根因

两处代码各自贡献了一半的 Bug：

### 问题点 1：negotiate.rs L276-L277

UUID-First rename 检测命中后，只更新了 `relative_path`，**没有递增 `logical_clock`**：

```rust
"UPDATE file_states SET relative_path = $1 
 WHERE vault_id = $2 AND file_id = $3 AND is_deleted = false"
```

### 问题点 2：push.rs L350-L364

UPSERT 时 `logical_clock` 直接使用客户端传来的值（`$5 = manifest.logical_clock`）。客户端不追踪服务端的 clock，传上来的通常是 0。这意味着 push 会把 rename 后的记录的 clock **覆盖为 0**。

```rust
INSERT INTO file_states (..., logical_clock, ...)
VALUES ($1, $2, $3, $4, $5, ...)  -- $5 = manifest.logical_clock (客户端传 0)
ON CONFLICT (vault_id, relative_path)
DO UPDATE SET ..., logical_clock = $5, ...  -- 覆盖为 0
```

---

## 修复指令

### 修复 1：negotiate.rs — rename 时递增 clock

**文件**: `apps/server/src/routes/sync/negotiate.rs`
**位置**: L276-L281（`UPDATE file_states SET relative_path` 那一块）

```diff
 if let Err(e) = sqlx::query(
-    "UPDATE file_states SET relative_path = $1 WHERE vault_id = $2 AND file_id = $3 AND is_deleted = false"
+    "UPDATE file_states SET relative_path = $1, logical_clock = logical_clock + 1, updated_at = NOW() WHERE vault_id = $2 AND file_id = $3 AND is_deleted = false"
 )
 .bind(&cf.path)
 .bind(vault_uuid)
 .bind(fid_uuid)
 .execute(&state.pool).await {
```

### 修复 2：push.rs — UPSERT 时 clock 取 MAX 而非客户端值

**文件**: `apps/server/src/routes/sync/push.rs`
**位置**: L349-L358（INSERT INTO file_states 那一块）

将 INSERT 的 `logical_clock` 从直接使用客户端值 `$5`，改为取 `服务端当前该 vault 最大 clock + 1`：

```diff
 match sqlx::query(
     r#"INSERT INTO file_states (vault_id, relative_path, content_hash, size, logical_clock, updated_at, editor_id, pushed_by, pushed_at, file_id, doc_status, is_deleted)
-       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $6, NOW(), $7, $8, false)
+       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(logical_clock) FROM file_states WHERE vault_id = $1), 0) + 1, NOW(), $6, $6, NOW(), $7, $8, false)
        ON CONFLICT (vault_id, relative_path)
-       DO UPDATE SET content_hash = $3, size = $4, logical_clock = $5, updated_at = NOW(),
+       DO UPDATE SET content_hash = $3, size = $4, logical_clock = COALESCE((SELECT MAX(logical_clock) FROM file_states WHERE vault_id = $1), 0) + 1, updated_at = NOW(),
                      pushed_by = $6, pushed_at = NOW(),
                      editor_id = COALESCE(file_states.editor_id, $6),
                      file_id = COALESCE(file_states.file_id, $7),
                      doc_status = $8,
                      is_deleted = false"#
 )
 .bind(vault_id)
 .bind(&manifest.relative_path)
 .bind(&final_hash)
 .bind(final_content.len() as i64)
-.bind(manifest.logical_clock as i64)
 .bind(user_id)
 .bind(push_file_id)
 .bind(&push_doc_status)
```

**注意**：修复 2 中移除了 `.bind(manifest.logical_clock as i64)`（原来的第 5 个绑定参数），因为 `logical_clock` 现在由 SQL 子查询自动计算，不再需要客户端传值。**后续的 `.bind()` 序号需要对应调整**：原来的 `$6` 变为 `$5`，`$7` 变为 `$6`，`$8` 变为 `$7`。请仔细核对 bind 序号。

---

## 验证

修复完成后，执行以下测试：
1. 新建一个文件，编辑 3 次触发同步 → 确认 `logical_clock` 递增到 3
2. 重命名该文件 → 确认 `logical_clock` 变为 4（而非归零）
3. 再编辑一次 → 确认 `logical_clock` 变为 5

查询语句：
```sql
SELECT file_id, relative_path, logical_clock, is_deleted 
FROM file_states 
WHERE vault_id = '你的vault_id' 
ORDER BY file_id, logical_clock;
```

---

**架构师签发。2026-04-20**
