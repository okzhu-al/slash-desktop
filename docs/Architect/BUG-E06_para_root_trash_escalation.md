# BUG-E06：PARA 根目录回收站越权访问

> **优先级**：P1（安全缺陷）
> **状态**：定位完成，等待修复

## 1. 现象

非 Admin 用户（Join，角色 Observer/TeamMember）在个人空间打开 `01_Projects/` 目录页面时，能够看到 PARA 根目录 `01_PROJECTS` 的团队回收站，并可以执行恢复和彻底删除操作。

## 2. 攻击链路分析

```
Join 打开 01_Projects/ → FolderPage PARA 映射 → teamRelPath="01_PROJECTS"
→ TeamDirPanel(directoryPath="01_PROJECTS")
→ getDirectoryPermissions("01_PROJECTS")
→ 如果返回含 Join 的 Owner 记录 → isOwnerNow=true
→ getTrashedFiles("01_PROJECTS") 加载回收站 → 可操作
```

## 3. 根因

### 3.1 客户端层（TeamDirPanel.tsx）

L124-125 判断逻辑：
```typescript
if (userIsAdmin || isOwnerNow) {
    // 加载回收站
}
```

对于 PARA 根目录（`01_PROJECTS` / `02_AREAS` / `03_RESOURCES` / `04_ARCHIVE`），任何有子目录 Owner 权限的人都不应被视为"根目录管理者"。**只有 Admin 才能管理 PARA 根目录的回收站**。

### 3.2 服务端层（trash.rs）

`list_trashed_files`、`restore_trashed_file`、`hard_delete_trashed_file` 三个 API 使用 `ManageDirectory` 鉴权，但如果数据库中存在 Join 在 `01_PROJECTS` 上的权限记录（可能由边缘操作写入），则 `resolve_effective_role` 会返回 Owner 角色，导致鉴权通过。

## 4. 修复方案（双重防护）

### Fix 1：客户端 — PARA 根目录回收站仅 Admin 可见

**文件**：`TeamDirPanel.tsx` L124-126

PARA 根目录（不含 `/` 的路径）的回收站应**仅限 Admin 查看**，不允许 Owner 越权。

```typescript
// 修复前
if (userIsAdmin || isOwnerNow) {

// 修复后
const isParaRoot = !directoryPath.includes('/');
const canViewTrash = isParaRoot ? userIsAdmin : (userIsAdmin || isOwnerNow);
if (canViewTrash) {
```

同时 UI 渲染处 L579 也需同步修改：

```typescript
// 修复前
{canManageDir && trashedFiles.length > 0 && (

// 修复后
const canViewTrashUI = isParaRoot ? isAdmin : canManageDir;
// ...
{canViewTrashUI && trashedFiles.length > 0 && (
```

### Fix 2：服务端 — PARA 根目录强制 Admin-Only

**文件**：`trash.rs` L35-41, L128-134, L289-295

在三个回收站 API 中，增加 PARA 根目录的 Admin-Only 守卫：

```rust
// 在现有 ensure_team_permission 之后追加
if !params.directory_path.contains('/') {
    // PARA 根目录回收站操作仅限 Admin
    let role = permission::resolve_effective_role(
        &state.pool, user_id, vault_id, &params.directory_path
    ).await?;
    if !matches!(role, permission::EffectiveRole::Admin) {
        return Err(ApiError::Forbidden(
            "PARA root trash requires Admin".into()
        ));
    }
}
```

## 5. 影响范围

| 文件 | 修改点 |
|:---|:---|
| `TeamDirPanel.tsx` L124-126, L579 | 回收站加载/显示条件增加 PARA 根识别 |
| `trash.rs` L35-41, L128-134, L289-295 | 三个 API 增加 PARA 根 Admin-Only 守卫 |
