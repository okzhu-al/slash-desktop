# 架构师修复指令 — Batch 1 & 2

> **签发**: 2026-04-22 20:10  
> **适用范围**: Batch 1（OPT-01 + BUG-E09）+ Batch 2（OPT-04 + BUG-E11）  
> **要求**: 每一步完成后出具修改说明，等待验证后进入下一步

---

## Step 1: OPT-01 — 禁止 Admin 删除 PARA 根目录

> [!CAUTION]
> 这是防灾难性误操作的一行守卫，优先级最高。

### 背景

Admin 维护模式下可以删除 `01_PROJECTS`、`02_AREAS` 等 PARA 根目录，导致整个分类体系被摧毁。PARA 根目录的特征：**无父目录**（`directory_path` 不含 `/`，且是 PARA 命名规范）。

### 修改文件

`apps/server/src/routes/team/directories.rs`

### 指令

在 `can_delete_directory` 函数（L705）和 `delete_directory` 函数（L809）的**最前面**（权限检查之前），各加一个 PARA 根守卫：

#### 1a. `can_delete_directory`（L715 之后插入）

```rust
// 🛡️ OPT-01: 绝对禁止删除 PARA 根目录（01_PROJECTS, 02_AREAS 等）— 无论任何角色
let para_roots = ["01_PROJECTS", "02_AREAS", "03_RESOURCES", "04_ARCHIVES"];
if para_roots.iter().any(|r| directory_path.eq_ignore_ascii_case(r)) {
    return Ok(Json(CanDeleteDirectoryResponse {
        allowed: false,
        reason: Some("para_root_protected".into()),
    }));
}
```

#### 1b. `delete_directory`（L819 之后插入）

```rust
// 🛡️ OPT-01: 绝对禁止删除 PARA 根目录 — 即使绕过预检直调 API
let para_roots = ["01_PROJECTS", "02_AREAS", "03_RESOURCES", "04_ARCHIVES"];
if para_roots.iter().any(|r| directory_path.eq_ignore_ascii_case(r)) {
    return Err(ApiError::Forbidden("Cannot delete PARA root directory".into()));
}
```

### 验证方案

1. `cargo check` 通过
2. Admin 维护模式下尝试删除 PARA 根目录 → 按钮置灰或弹出 "para_root_protected" 提示
3. 直接调 API `DELETE /api/team/directories` body 含 `01_PROJECTS` → 403

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 2: BUG-E09 — Promote 礼尚往来

### 背景

场景：bb 添加 cc 为 `B1/` 的成员。当 cc Promote `C1/` 为团队目录时，`homestead.rs` 的成员继承逻辑把 bb 自动加入了 `C1/`。

### 根因分析

`homestead.rs` L48-56 的父目录成员查询：

```rust
let parent_perms: Vec<ParentPerm> = if let Some(ref pd) = parent_dir {
    sqlx::query_as(
        "SELECT user_id, dir_role, observer_visible 
         FROM directory_permissions 
         WHERE vault_id = $1 AND directory_path = $2"
    )
    .bind(vault_id).bind(pd)
    .fetch_all(pool).await.unwrap_or_default()
} else {
    Vec::new()
};
```

这段代码是**正确的** — 它只查询直接父目录的成员。

但 Promote 场景的问题在于：当 cc Promote `C1/` 时，文件路径是 `01_PROJECTS/C1/c1.md`。`claimed_dirs` 会递归生成 `["01_PROJECTS", "01_PROJECTS/C1"]`。

- `01_PROJECTS` 已注册 → 跳过 ✅
- `01_PROJECTS/C1` 未注册 → **新目录，执行 Homesteading**
  - 父目录 = `01_PROJECTS`
  - `01_PROJECTS` 的成员？→ bb（因为 bb Promote 了 `B1/`，Homesteading 时 `01_PROJECTS` 作为顶层可能包含 bb 的权限记录）

**真正的问题**：`01_PROJECTS` 作为 PARA 根，Homesteading 时所有 Promote 操作都会把 owner 注册进去。所以 bb Promote `B1/` 时，bb 被注册为 `01_PROJECTS` 的成员。后续 cc Promote `C1/` → 继承 `01_PROJECTS` 的成员（含 bb）→ bb 被加入 `C1/`。

### 修改文件

`apps/server/src/routes/sync/homestead.rs`

### 指令

将 L87-118 的 Step 5（继承父目录成员）**限定为仅对非 PARA 根的父目录继承**。如果父目录是 PARA 根（`01_PROJECTS` 等），**跳过继承**。PARA 根是公共容器，它的成员列表不应被子目录继承。

在 L87（`// Step 5: 继承父目录的所有成员`）之前插入 PARA 根判断：

```rust
// 🛡️ BUG-E09: PARA 根是公共容器，其成员列表不应级联到子目录
// 否则 Promote B1/ 时 bb 注册到 01_PROJECTS → 后续 cc Promote C1/ 时 bb 被继承到 C1/
let para_roots = ["01_PROJECTS", "02_AREAS", "03_RESOURCES", "04_ARCHIVES"];
let parent_is_para_root = parent_dir.as_ref()
    .map(|pd| para_roots.iter().any(|r| pd.eq_ignore_ascii_case(r)))
    .unwrap_or(false);
```

然后将 L88-118 的继承循环用 `if !parent_is_para_root` 包裹：

```rust
let mut inherited_count = 0u64;
if !parent_is_para_root {
    for pp in &parent_perms {
        // ... 原有继承逻辑不变 ...
    }
}
```

### 验证方案

1. `cargo check` 通过
2. 全新空间：bb Promote B1/ → cc Promote C1/ → C1/ 的成员列表**不含 bb** ✅
3. 反向验证：B2/ 下 B2/B3/ 子目录 → B3/ 应**正常继承** B2/ 的成员 ✅

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 3: OPT-04 — Promote 必须保持原有 PARA 根

### 背景

`01_Projects/X` 只能 Promote 到 `01_PROJECTS/X`，禁止跨 PARA 根（如 Promote 到 `02_AREAS/X`）。否则本地 `01_Projects/X` 映射到 Team vault 的 `02_AREAS/X`，会破坏 PARA 组织结构。

### 修改文件

`apps/desktop/src/features/sidebar/hooks/useFileTreeActions.ts`

### 指令

在 `handlePromoteToTeam` 函数（L544）的 **`targetDir` 构建之后、`toast.loading` 之前**（约 L587-588 之间），加入 PARA 根一致性校验：

```typescript
// 🛡️ OPT-04: Promote 必须保持原有 PARA 根一致
// 01_Projects/X → 只能 Promote 到 01_PROJECTS/，不能跨到 02_AREAS/
const sourceParaRoot = sourceDir.split('/')[0]; // e.g. "01_Projects"
const targetParaRoot = targetParaDir.split('/')[0]; // e.g. "01_PROJECTS"
const sourcePrefix = sourceParaRoot.split('_')[0]; // "01"
const targetPrefix = targetParaRoot.split('_')[0]; // "01"
if (sourcePrefix !== targetPrefix) {
    toast.error(
        t('team.promote_para_mismatch', {
            source: sourceParaRoot,
            target: targetParaRoot,
            defaultValue: `「${sourceParaRoot}」不能推送到「${targetParaRoot}」，请选择对应的 PARA 根目录`,
        }),
        { id: 'promote-team' },
    );
    setIsPromoting(false);
    return;
}
```

### 验证方案

1. `vite build` 无 TypeScript 错误
2. 尝试 Promote `01_Projects/X` 到 `02_AREAS/` → toast 报错并中止
3. Promote `01_Projects/X` 到 `01_PROJECTS/` → 正常执行 ✅

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 4: BUG-E11 — 小红点越权透传

### 背景

用户不是某团队子目录的成员时，子目录内的 collab event 仍透传到该父目录小红点上，导致用户看见无法消除的红点。

### 现状分析

经代码审计，**服务端 `get_unread_files`（collab.rs L311-357）已有 `strict_filter` 权限过滤**：只返回用户作为 `owner`/`team_member` 的目录下的未读事件。`is_path_in_sync_scope` 是精确匹配（非前缀）。

因此 BUG-E11 的根因有两种可能：

**可能 A**：用户对**父目录**有权限（如 `01_PROJECTS`），而子目录（如 `01_PROJECTS/C1`）内文件的路径 `01_PROJECTS/C1/c1.md` 的 `file_dir` = `01_PROJECTS/C1`，会被精确匹配过滤掉。但如果有事件的 `file_path` 是**目录级路径**（如 `folder_joined` 事件的 `file_path = "01_PROJECTS/C1"`），那么 `file_dir = "01_PROJECTS"` → 匹配上 → **泄漏**。

**可能 B**：前端 `FileTreeItem.tsx` L92-137 的 `hasCollabUnread` 用 `startsWith` 做目录聚合，即使 `unreadFiles` Map 已正确过滤，目录节点的 L136 `p.toLowerCase().startsWith(teamRelLower + '/')` 仍可能匹配到**属于不同子目录**的事件。

### 修改文件

首先需要**诊断**：请开发同学在复现 BUG-E11 场景时，在浏览器 DevTools Console 执行：

```javascript
// 查看当前小红点数据源
const store = window.__ZUSTAND_STORES?.collabNotify || {};
console.log('unreadFiles:', [...(store.getState?.()?.unreadFiles?.entries() || [])]);
```

或在 `FileTreeItem.tsx` 的 `hasCollabUnread` 计算中临时加日志：

```typescript
// 在 L92 之前加
if (isFolder && teamRelPath) {
    const matching = [...unreadFiles.keys()].filter(p => 
        p.toLowerCase().startsWith(teamRelPath.toLowerCase() + '/')
    );
    if (matching.length > 0) {
        console.log(`[REDDOT-AUDIT] 目录=${teamRelPath} 匹配的 unreadFiles:`, matching);
    }
}
```

根据诊断结果：

- **如果是可能 A**（服务端泄漏）：修改 `collab.rs` L328-344 的 SQL 查询，增加 `file_path` 级别的权限过滤
- **如果是可能 B**（前端聚合越界）：修改 `FileTreeItem.tsx` L133-137，只聚合用户有直接权限的子目录事件

### 验证方案

1. bb 不是 C1/ 成员 → bb 的父目录(如 01_PROJECTS) 不显示 C1/ 内事件的红点
2. bb 作为 B1/ 成员 → B1/ 内事件红点正常显示
3. bb 点击 B1/ → 红点消除 ✅

### 产出物

先提交诊断日志，确认泄漏来源后再进行代码修改。

---

## 执行顺序

```
Step 1 (OPT-01) → 验证 → Step 2 (BUG-E09) → 验证 → Step 3 (OPT-04) → 验证 → Step 4 (BUG-E11) → 诊断+验证
```

每一步完成后均需出具：
1. 修改的文件和行号
2. diff 片段
3. `cargo check` / `vite build` 结果
4. 验证结论
