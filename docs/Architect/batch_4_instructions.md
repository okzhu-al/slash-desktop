# 架构师修复指令 — Batch 4: 维护 UX 加固 + 代码卫生

> **签发**: 2026-04-22 22:16  
> **签发人**: Architect  
> **适用范围**: OPT-03 + BUG-006 + BUG-007  
> **要求**: 每一步完成后出具修改说明，等待验证后进入下一步

---

## Step 8: OPT-03 — Admin 维护模式架构升级

### 架构决策背景

经过完整的威胁分析（见 `docs/Developer/后端全局锁升级架构方案.md` 及架构师审阅），最终方案如下：

**核心原则**：维护期间 Admin 只做 **rename/move**，不做 **delete**。剥夺 delete 后，所有冲突场景要么被 UUID-First 协议消化，要么被 PostgreSQL 事务序列化保证安全。**不需要后端全局锁（423）**，成员同步不受影响。

**决策依据**：

| 冲突场景 | 无 delete 时的结果 | 处理机制 |
|---------|-------------------|---------|
| 成员编辑 + Admin rename 父目录 | 内容保留在新路径 | UUID-First file_id 匹配 |
| 成员 delete + Admin rename 父目录 | 成员 delete 生效或被 Admin rename 覆盖 | 服务端权威，无数据丢失 |
| 成员 rename + Admin rename 同目录 | Admin 结果优先 | PostgreSQL 事务序列化 |
| 成员新建文件 + Admin rename 父目录 | 文件实时同步，跟随 rename 迁移 | negotiate 实时传播 |
| 成员 Promote + Admin move 到同路径 | 路径冲突 | **前端禁 Promote 消灭** |

**不采用后端 423 的理由**：
- 成员操作实时传播比冻结后堆积再对账更安全（新建文件可即时被 Admin rename 捎带迁移，不会变孤儿）
- 减少工程量（无需 DB migration、新 API、拦截器、AutoSyncManager 423 退避处理）
- Admin 想"删除"的目录 → 移入 `04_ARCHIVE/待整理/`，由 Owner 自行处理，更安全且符合 PARA Archive 语义

### 已完成项（开发同学已实现）

以下子任务已在上一轮开发中完成，**不需要重做**：

- ✅ **8a** 入口迁移：扳手图标已从 Sidebar 移除，"启动系统维护"按钮已添加到 `TeamManagePage.tsx` L289-314，含原生确认弹窗
- ✅ **8b** 状态标记：`Sidebar.tsx` L451-456 已实现 `MAINTENANCE` 标签（amber 色 pill + 脉冲圆点）
- ✅ **8c** Promote 禁用：`FileTreeItem.tsx` L447-479 已实现 `isMaintenanceMode` 检查，disabled 态 + tooltip "团队正在维护中，暂时无法提交"

### 修改文件

- `apps/desktop/src/features/team/TeamManagePage.tsx`
- `apps/desktop/src/features/sidebar/components/TeamTreeItem.tsx`
- `apps/desktop/src/features/sidebar/Sidebar.tsx`
- `apps/desktop/src/locales/zh-CN/common.json`
- `apps/desktop/src/locales/en/common.json`

### 指令

#### 8a-fix. 更新确认弹窗文案（风险提示修正）

当前 `TeamManagePage.tsx` L295-298 的确认弹窗文案不准确（还写着"删除"），需更新为最新方案的风险提示：

**修改位置**：`TeamManagePage.tsx` 约 L294-299，`confirm()` 的文案参数。

**替换为**（使用 i18n key）：

```tsx
const ok = await confirm(
    t('team.maintenance_confirm_body'),
    { title: t('team.maintenance_confirm_title'), kind: 'warning', okLabel: t('team.maintenance_confirm_ok'), cancelLabel: t('common.cancel') }
);
```

同时将按钮文案 L313 中的硬编码中文也替换为 i18n key：

```tsx
{isAdminManageMode ? t('team.maintenance_exit') : t('team.maintenance_enter')}
```

#### 8d. 维护模式下禁用目录删除（Admin 侧 —— 新增）

在 `TeamTreeItem.tsx` 的右键菜单中（约 L130-143），将 Delete 菜单项在维护模式下禁用并引导 Admin 使用「待整理」：

**步骤**：

1. `TeamTreeItem` 新增 prop `isMaintenanceMode?: boolean`
2. `Sidebar.tsx` 构建 `<TeamTreeItem>` 时传入 `isMaintenanceMode={isAdminManageMode}`（约 L492 附近 `<TeamTreeItem>` 调用处），**注意递归子节点也要传递**
3. 修改右键菜单中 Delete 菜单项（约 L140-142）：

```tsx
<ContextMenuItem 
    onClick={() => isMaintenanceMode ? undefined : onDeleteDir?.(node.path, node.name)} 
    disabled={isMaintenanceMode}
    className={cn(
        isMaintenanceMode
            ? "opacity-50 cursor-not-allowed"
            : "text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50"
    )}
    title={isMaintenanceMode ? t('team.maintenance_no_delete_hint') : undefined}
>
    <Trash2 size={14} className="mr-2" />
    {isMaintenanceMode 
        ? t('team.admin_delete_dir') + t('team.maintenance_disabled_suffix')
        : t('team.admin_delete_dir')}
</ContextMenuItem>
```

#### 8e. i18n 补全

在 `zh-CN/common.json` 的 `"team"` 对象中追加以下 key（约 L795 之前）：

```json
"maintenance_confirm_title": "⚠️ 维护模式",
"maintenance_confirm_body": "可以：移动 / 重命名 团队目录\n不可以：删除目录（请移至「04_ARCHIVE/待整理」）\n\n⚠️ 维护期间成员同步不受影响",
"maintenance_confirm_ok": "进入维护模式",
"maintenance_enter": "开始维护",
"maintenance_exit": "退出维护",
"maintenance_no_delete_hint": "维护期间不可删除目录，请移至 04_ARCHIVE/待整理",
"maintenance_disabled_suffix": "（维护中禁用）",
"maintenance_promote_hint": "团队正在维护中，暂时无法提交"
```

在 `en/common.json` 的 `"team"` 对象中追加对应 key：

```json
"maintenance_confirm_title": "⚠️ Maintenance Mode",
"maintenance_confirm_body": "Allowed: Move / Rename team directories\nNot allowed: Delete directories (move to \"04_ARCHIVE/Unsorted\")\n\n⚠️ Member sync is not affected",
"maintenance_confirm_ok": "Enter Maintenance",
"maintenance_enter": "Start Maintenance",
"maintenance_exit": "Exit Maintenance",
"maintenance_no_delete_hint": "Cannot delete during maintenance. Move to 04_ARCHIVE/Unsorted instead",
"maintenance_disabled_suffix": " (disabled)",
"maintenance_promote_hint": "Team is under maintenance, unable to submit"
```

同时将 `FileTreeItem.tsx` 中 L452 和 L473 的硬编码 `"团队正在维护中，暂时无法提交"` 替换为 `t('team.maintenance_promote_hint')`（需确保 FileTreeItem 中可以访问 `t` 函数，如已有则直接使用）。

### 验证方案

1. `vite build` 无错误
2. 确认弹窗文案已更新：文案明确写 "不可以：删除目录（请移至待整理）" ✅
3. 维护模式下团队目录右键 → "重命名"可用，"删除"灰色且显示 tooltip ✅
4. 切换语言到 English → 所有维护相关文案正确显示英文 ✅
5. 退出维护模式 → 删除菜单恢复可用 ✅

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 9: BUG-006 — `directories` 表 SQL 模式抽取为公共函数

### 背景

`SELECT directory_id FROM directories WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL` 这条 SQL **散布在 7 处**，跨 4 个文件：

| 文件 | 出现次数 |
|------|---------|
| `directories.rs` | 3 处（L123, L255, L903） |
| `trash.rs` | 2 处（L57, L208） |
| `homestead.rs` | 1 处（L219） |
| `helpers.rs` | 1 处（L10） |

同样，`INSERT INTO directories (vault_id, current_path, created_by) VALUES ($1, $2, $3) RETURNING directory_id` 也有 4 处重复。

### 指令

在 `apps/server/src/routes/sync/helpers.rs`（或新建 `apps/server/src/routes/team/helpers.rs`）中提取两个公共函数：

```rust
/// 查找目录 ID（不含已删除的）
pub async fn find_directory_id(
    pool: &sqlx::PgPool,
    vault_id: uuid::Uuid,
    dir_path: &str,
) -> Result<Option<uuid::Uuid>, crate::error::ApiError> {
    let id: Option<uuid::Uuid> = sqlx::query_scalar(
        "SELECT directory_id FROM directories WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL"
    )
    .bind(vault_id)
    .bind(dir_path)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// 确保目录存在，不存在则创建（幂等）
pub async fn ensure_directory(
    pool: &sqlx::PgPool,
    vault_id: uuid::Uuid,
    dir_path: &str,
    created_by: uuid::Uuid,
) -> Result<uuid::Uuid, crate::error::ApiError> {
    // 先查
    if let Some(id) = find_directory_id(pool, vault_id, dir_path).await? {
        return Ok(id);
    }
    // 不存在则创建
    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO directories (vault_id, current_path, created_by) VALUES ($1, $2, $3) RETURNING directory_id"
    )
    .bind(vault_id)
    .bind(dir_path)
    .bind(created_by)
    .fetch_one(pool)
    .await?;
    Ok(id)
}
```

然后**逐文件替换** — 将 7 处 SELECT 替换为 `find_directory_id()` 调用，4 处 INSERT 替换为 `ensure_directory()` 调用。

### 替换清单

| # | 文件 | 行号 | 原始 SQL | 替换为 |
|---|------|------|----------|--------|
| 1 | `helpers.rs` | L10 | SELECT... | `find_directory_id(pool, vault_id, dir_path)` |
| 2 | `directories.rs` | L123 | SELECT... | `find_directory_id(...)` |
| 3 | `directories.rs` | L255 | SELECT... | `find_directory_id(...)` |
| 4 | `directories.rs` | L903 | SELECT... | `find_directory_id(...)` |
| 5 | `trash.rs` | L57 | SELECT... | `find_directory_id(...)` |
| 6 | `trash.rs` | L208 | SELECT... | `find_directory_id(...)` |
| 7 | `homestead.rs` | L219 | SELECT... | `find_directory_id(...)` |
| 8 | `homestead.rs` | L63 | INSERT... | `ensure_directory(...)` |
| 9 | `directories.rs` | L135 | INSERT... | `ensure_directory(...)` |
| 10 | `directories.rs` | L264 | INSERT... | `ensure_directory(...)` |
| 11 | `trash.rs` | L236 | INSERT... | `ensure_directory(...)` |

### 注意事项

- `helpers.rs` 中 `ensure_homesteading_permissions` 已有 `find_directory_id` 的内联版本（L9-16），直接改为调用新函数
- `trash.rs` L66 有一处 INSERT 不含 `created_by`，需单独处理或统一字段
- 任何替换都**不得改变业务逻辑**，仅做 Extract Method 重构

### 验证方案

1. `cargo check` 编译通过
2. `cargo test`（如有）全部通过
3. 全项目 `grep "SELECT directory_id FROM directories WHERE vault_id"` → 仅剩 `helpers.rs` 中的函数定义

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 10: BUG-007 — `negotiate.rs` 函数拆分

### 背景

`negotiate()` 函数当前 **740 行单函数**，含 5 个 Step + 大量 rename/UUID 逻辑，严重影响可维护性。

### 现状结构映射

| Step | 行号范围 | 职责 | 建议拆分函数名 |
|------|---------|------|---------------|
| 前置 | L14-139 | 认证 + 权限校验 + 路径规范化 + scope 过滤 | 保留在 `negotiate()` |
| Step 0 | L140-270 | 处理客户端删除 | `process_client_deletions()` |
| Step 1 | L271-553 | UUID-First rename 检测 + 墓碑传播 + 权限守卫 | `process_rename_detection()` |
| Step 2 | L556-678 | Server 文件对比 → client_needs / server_needs | `diff_server_files()` |
| Step 3 | L645-681 | Client 文件对比（Client-only 新增） | `diff_client_files()` |
| Step 4 | L683-708 | Team soft-deleted 主动下发 | `propagate_team_deletions()` |
| 收尾 | L710-739 | 获取 clock + 构建 response + 日志 | 保留在 `negotiate()` |

### 指令

#### 10a. 定义共享上下文结构体

```rust
/// negotiate 各阶段共享的协商上下文
struct NegotiateContext<'a> {
    pool: &'a sqlx::PgPool,
    storage: &'a dyn crate::storage::StorageBackend,
    vault_id: &'a str,
    vault_uuid: uuid::Uuid,
    user_id: uuid::Uuid,
    is_team: bool,
    // 可变状态
    server_files: Vec<ServerFileState>,
    client_needs: Vec<String>,
    server_needs: Vec<String>,
    server_deleted: Vec<String>,
    all_deleted_paths: std::collections::HashSet<String>,
}
```

#### 10b. 逐 Step 提取

按照上述映射表，从最低风险的 Step 开始拆：

1. **Step 4** `propagate_team_deletions()` — 最独立，无副作用
2. **Step 0** `process_client_deletions()` — 逻辑自包含
3. **Step 2+3** `diff_files()` — 核心对比逻辑
4. **Step 1** `process_rename_detection()` — 最复杂，最后拆

每提取一个函数后 `cargo check` 验证编译通过，再拆下一个。

#### 10c. 函数签名参考

```rust
async fn process_client_deletions(
    ctx: &mut NegotiateContext<'_>,
    deleted_paths: &[String],
    rejected_deletions: &mut HashSet<String>,
) -> Result<HashSet<String>, ApiError> { ... }

async fn process_rename_detection(
    ctx: &mut NegotiateContext<'_>,
    req: &SyncNegotiateRequest,
    client_file_map: &HashMap<&str, (&str, &str, Option<&str>)>,
) -> Result<(), ApiError> { ... }

fn diff_server_files(
    ctx: &mut NegotiateContext<'_>,
    client_file_map: &HashMap<&str, (&str, &str, Option<&str>)>,
    matched_dirs: &HashSet<String>,
    deleted_set: &HashSet<&str>,
    rejected_deletions: &HashSet<&str>,
) { ... }

fn diff_client_files(
    ctx: &mut NegotiateContext<'_>,
    client_files: &[ClientFileState],
    server_file_map: &HashMap<&str, &ServerFileState>,
) { ... }

fn propagate_team_deletions(
    ctx: &mut NegotiateContext<'_>,
    client_file_map: &HashMap<&str, (&str, &str, Option<&str>)>,
    matched_dirs: &HashSet<String>,
    client_dirs: &HashSet<String>,
) { ... }
```

### 注意事项

> [!WARNING]
> - **绝对不改变业务逻辑** — 这是纯重构（Extract Method），不修复/不优化任何行为
> - 每拆一个 Step 都做 `cargo check`，确保借用检查器通过
> - `NegotiateContext` 的生命周期标注需特别注意 `&'a` 对齐

### 验证方案

1. `cargo check` 编译通过
2. `cargo test`（如有）全部通过
3. `negotiate()` 函数行数降至 **200 行以内**（前置 + 委派调用 + 收尾）
4. 全项目 `grep "fn negotiate" negotiate.rs` → 确认 1 个 pub 入口 + 4-5 个 private 子函数

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## 执行顺序

```
Step 8 (OPT-03 维护 UX) → 验证 → Step 9 (BUG-006 SQL 抽取) → 验证 → Step 10 (BUG-007 函数拆分) → 验证
```

> [!TIP]
> **推荐顺序理由**：
> - Step 8 纯前端，独立修改，快速见效
> - Step 9 是 Step 10 的前置 — 先抽取公共 SQL，拆分 negotiate 时行数进一步缩减
> - Step 10 依赖 Step 9 完成后的 helpers.rs 结构

## INDEX 状态更新

完成后需更新 INDEX.md：
- OPT-03: ⏳ → **Closed**
- BUG-006: Defer 🔒 → **Closed**
- BUG-007: Defer 🔒 → **Closed**
