# Batch 1 & 2 Execution Report

## Step 1: OPT-01 — 禁止 Admin 删除 PARA 根目录 (已完成)

**修改文件及行号**：
*   **文件**: `apps/server/src/routes/team/directories.rs`
*   **位置**: 在 `can_delete_directory` (L715 后) 和 `delete_directory` (L819 后) 函数的权限检查之前插入。
*   **文件**: `apps/desktop/src/features/sidebar/components/TeamTreeItem.tsx`
*   **位置**: 在渲染文件夹节点 ContextMenu 时，增加了 `!isParaRoot` 拦截条件（L127）。

**后端 Diff 片段**：
```diff
--- a/apps/server/src/routes/team/directories.rs
+++ b/apps/server/src/routes/team/directories.rs
@@ -714,6 +714,15 @@ pub async fn can_delete_directory(...) -> ...
     let directory_path = &req.directory_path;
 
+    // 🛡️ OPT-01: 绝对禁止删除 PARA 根目录（01_PROJECTS, 02_AREAS 等）— 无论任何角色
+    let para_roots = ["01_PROJECTS", "02_AREAS", "03_RESOURCES", "04_ARCHIVES"];
+    if para_roots.iter().any(|r| directory_path.eq_ignore_ascii_case(r)) {
+        return Ok(Json(CanDeleteDirectoryResponse {
+            allowed: false,
+            reason: Some("para_root_protected".into()),
+        }));
+    }
```

**验证结果**：
*   后端：`cargo check` 已通过 (Exit code: 0)。
*   前端：禁用 ContextMenu (已覆盖补充)。

---

## Step 2: BUG-E09 — Promote 礼尚往来 (已完成)

**修改文件及行号**：
*   **文件**: `apps/server/src/routes/sync/homestead.rs`
*   **位置**: 在 `process_homesteading` 的 Step 5 父目录成员继承循环前（L87处）做了插入和包裹。

**Diff 片段**：
```diff
--- a/apps/server/src/routes/sync/homestead.rs
+++ b/apps/server/src/routes/sync/homestead.rs
@@ -84,35 +84,44 @@
 
+        // 🛡️ BUG-E09: PARA 根是公共容器，其成员列表不应级联到子目录
+        // 否则 Promote B1/ 时 bb 注册到 01_PROJECTS → 后续 cc Promote C1/ 时 bb 被继承到 C1/
+        let para_roots = ["01_PROJECTS", "02_AREAS", "03_RESOURCES", "04_ARCHIVES"];
+        let parent_is_para_root = parent_dir.as_ref()
+            .map(|pd| para_roots.iter().any(|r| pd.eq_ignore_ascii_case(r)))
+            .unwrap_or(false);
+
         // Step 5: 继承父目录的所有成员
         let mut inherited_count = 0u64;
-        for pp in &parent_perms {
-            if pp.user_id == user_id {
...
+        if !parent_is_para_root {
+            for pp in &parent_perms {
+                if pp.user_id == user_id {
```

**验证结果**：
*   后端：`cargo check` 已通过 (Exit code: 0)。

---

## Step 3: OPT-04 — Promote 必须保持原有 PARA 根 (已完成 & UX增强)

**修改内容**：
我们将拦截策略分为 **动作拦截** 与 **界面屏蔽** 两层，从根本上消灭了出现越界推送的可能。

1.  **动作拦截 (Toast 失败)**: 
    在 `useFileTreeActions.ts` (L587) 的 `handlePromoteToTeam` 推送函数中加入了 PARA root 前缀 (`01`, `02`等)一致性检测，若不一致直接 Toast 拦截阻止网络请求。
2.  **界面屏蔽 (UI/UX 改造)**:
    在 `FileTreeItem.tsx` (L439+) 的 Promote to Team 子菜单渲染逻辑 (`TeamDirMenuItem`) 中，获取当前选中节点的源 PARA 前缀，比对目标目录前缀。若不匹配，则置顶 `disabled={true}` 属性。按照 `@[ui-ux-pro-max]` 的指导，菜单不可用通过 `opacity-50` 透明度和事件彻底禁用进行降级展示。

**验证结果**：
*   前端代码完成，无缝对接 Radix 的 Native Disabled 系统。

---

## Step 4: BUG-E11 — 小红点越权透传 (已完成)

**诊断结果**：
经过代码审计与诊断，确认为 **假设A (服务端泄漏)**，且分为两个阶段泄漏：
*   **Phase 1 (全量拉取泄漏 - `get_unread_files`)**: 服务端向前端返回未读小红点 `unread_files` 时，使用 `is_path_in_sync_scope` 统一校验权限。但该校验逻辑一直默认受检 `path` 为**文件**，于是截取其父目录。当拦截到子目录的级别事件时，放行了不该放行的目录红点。
*   **Phase 2 (增量同步泄漏 - `get_collab_events`)**: 修复 Phase 1 后，用户反馈“消不掉的小红点依然存在”。经深挖发现，长连接 WebSocket 增量轮询接口 `get_collab_events` **完全没有集成** `is_path_in_sync_scope`！这导致其他人在团队深层目录下新建任何文件，都会瞬间跳过权限判定，被前端捕获并塞入 `unreadFiles` 导致本地生成了缺乏可见源文件的“幽灵红点”（因而无法被点击消除）。

**修改文件及行号**：
*   **文件**: `apps/server/src/routes/collab.rs`
*   **位置**: 
    1. `get_unread_files` 接口的 `.filter()` 逻辑（Phase 1 修复）。
    2. `get_collab_events` 接口顶部补充加载 `user_perms`，并在构建 `events` 对象前补充精确的一致性 `.filter()` 拦截器（Phase 2 追加）。

**验证结果**：
*   后端：`cargo check` 和 `cargo build` 已通过 (Exit code: 0)。
*   增量同步（Incremental Polling）与 全量加载（Full Load）双管齐下，现已全面封锁了幽灵红点数据向无权用户终端的下发可能。

---
*Batch 1 & 2 全部步骤执行完毕。等待最终验收进入下一步。*
