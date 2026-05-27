# 架构师指令：修复 BUG21 回归 — isTeamNote 异步竞态导致 Editor 篡改

> **优先级**: 🔴 P0
> **缺陷类型**: 数据完整性 — Editor 所有权篡改（BUG21 回归）
> **关联**: `docs/Architect/editor_semantic_and_drift_fix.md`（原始 BUG21 修复）

---

## 问题描述

在 Collab 模式下，Lucia（被邀成员）编辑团队文件 `Join T001.md` 后，frontmatter 的 `editor` 字段从 `Join` 被改为 `Lucia`。

**原 BUG21 修复**（`isTeamNoteRef`）理论上应阻止此行为，但存在**异步竞态窗口**。

## 根因定案

`useIsTeamNote(noteId)` 是异步的（需异步读取 `.slash/team_path_mappings.json`），初始值为 `false`。

```
时序线：
  t=0    Editor Mount  → isTeamNote = false（初始值）
  t=0    isTeamNoteRef.current = false
  t=50ms 用户开始输入  → hasUserEditedRef.current = true
  t=200ms isTeamNoteAsync 完成 → isTeamNote = true → isTeamNoteRef.current = true
  t=500ms autoSave 触发 → 但如果异步未完成或在 t=50~200ms 间触发了保存...
```

如果保存在 `isTeamNote` 异步结果返回之前触发，`isTeamNoteRef.current` 仍为 `false`，走入 Personal 分支（L114-116），强行注入 `mergedMeta.editor = displayName`。

## 修复方案：Frontmatter 同步信号兜底

`doc_status` 字段**只在团队文件中存在**（`solo` 或 `collab`），个人文件没有这个字段。因此它可以作为「这是团队文件」的**同步可靠信号**，完全不依赖异步 I/O。

### 修改文件
`apps/desktop/src/features/editor/hooks/useContentPersistence.ts`

### 修改位置
L112-116（`saveContent` 函数内 editor 注入逻辑）

### 具体改动

```diff
         // 🛡️ contributor 写入门控：仅用户真正编辑时才加入（防止 B 打开笔记即改变 frontmatter hash）
         const displayName = useSessionStore.getState().displayName;
         if (displayName && hasUserEditedRef.current) {
-            if (!isTeamNoteRef.current) {
+            // 🛡️ BUG21-v2: 双重信号判定 — 异步 isTeamNote + 同步 doc_status 兜底
+            // doc_status 仅存在于团队文件（solo/collab），个人文件无此字段
+            const effectiveIsTeamNote = isTeamNoteRef.current || !!mergedMeta.doc_status;
+            if (!effectiveIsTeamNote) {
                 // Personal Space Note: Automatically claim ownership to avoid lockout
                 mergedMeta.editor = displayName;
             } else {
```

**一行核心变更**：将 `!isTeamNoteRef.current` 替换为 `!effectiveIsTeamNote`。

### 不要动的代码
- `isTeamNoteRef` 的 useRef 追踪逻辑（L69-72）— 保留，作为主判定路径
- `useIsTeamNote.ts` — 保留，异步逻辑本身没有错
- `hasUserEditedRef` 门控 — 保留

---

## 验证

1. Lucia 打开团队文件 `Join T001.md`（从个人空间文件树点击）
2. 编辑并等待自动保存
3. 检查 frontmatter：`editor` 应仍为 `Join`（原创者），不被改为 `Lucia`
4. 检查 `contributors` 数组：应包含 `Lucia`
5. 用 Join 打开同一文件，确认 `editor` 未被篡改

---

**架构师签发。2026-04-20**
