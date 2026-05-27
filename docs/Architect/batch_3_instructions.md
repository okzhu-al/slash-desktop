# 架构师修复指令 — Batch 3: UX 体验提升

> **签发**: 2026-04-22 21:20  
> **签发人**: Architect  
> **适用范围**: BUG-B15 + BUG-E01 + BUG-E02 + BUG-E08 + OPT-02 状态确认  
> **要求**: 每一步完成后出具修改说明，等待验证后进入下一步

---

## 前置发现：OPT-02 已实现 ✅

经代码审计确认：

- `TeamTreeItem.tsx` L27/136-138：已有 `onRenameDir` prop 和右键 Rename 菜单
- `useTeamAdminActions.ts` L249-310：已有完整的 `handleAdminRenameDir` handler（含 API 调用 + 本地文件清理 + unified_state 清理）
- `TeamService.ts` L215：已有 `renameDirectory` API

**结论**：OPT-02 (Admin 维护模式 Rename) **功能已完整**，从 Open 列表移入 Closed。

---

## Step 5: BUG-B15 — 已 Promote 目录隐藏 Promote 子菜单

### 背景

已 Promote 到团队的目录，右键仍显示 "Sync to Team" 子菜单，让用户困惑。

经架构审计，"Remove Team Binding" 功能存在未解决的设计冲突（仅断链→孤岛数据 / 等价删除→功能重复），且 Admin 维护模式已能删除团队目录。

**正确做法**：已 Promote 的目录不需要任何团队操作入口，**直接隐藏** Promote 子菜单。

### 修改文件

`apps/desktop/src/features/sidebar/components/FileTreeItem.tsx`

### 指令

修改 L417 的渲染条件，增加排除已 Promote 目录：

```diff
- {actions?.onPromoteToTeam && !isProtectedParaFolder && (() => {
+ {actions?.onPromoteToTeam && !isProtectedParaFolder && !isTeamRoot && !actions.teamDirectories?.has(item.path) && (() => {
```

一行改动，无需新增类型或 handler。

### 验证方案

1. `vite build` 无错误
2. 未 Promote 的目录右键 → 正常显示 "Promote to Team" 子菜单 ✅
3. 已 Promote 的目录右键 → **无 Promote 相关菜单项** ✅

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 6: BUG-E01 — 编辑器 Rename/Sync 并发 RangeError 防护

### 背景

文件 rename 或 sync pull 后，编辑器尝试 `setContent` + `setTextSelection` 时，如果新文档比旧文档短，光标位置可能超出文档范围，导致 `RangeError: Position X out of range`。

### 现状

`useEditorEvents.ts` L178-185 和 L249-256 已有 `Math.min(from, maxPos)` 和 `try-catch` 保护。**但**：

1. L175 的 `editor.commands.setContent(parsed.content)` 本身可能在 ProseMirror 内部抛出 RangeError（content 为空或 parse 异常）
2. `note:updated` 事件（L71-123）中 `readTextFile(currentNoteId)` 在 rename 进行中可能读到已不存在的旧路径

### 修改文件

`apps/desktop/src/features/editor/hooks/useEditorEvents.ts`

### 指令

#### 6a. 加固 `slash:reload-note` handler（L162-193）

在 L175 的 `editor.commands.setContent` 外包裹 try-catch + 硬回退：

```typescript
if (editor && !editor.isDestroyed && parsed.content) {
    const currentMarkdown = (editor.storage as any)?.markdown?.getMarkdown?.() || '';
    if (currentMarkdown.trim() === parsed.content.trim()) {
        console.log('[useEditorEvents] reload-note — content unchanged, skip body reload');
        return;
    }

    const { from, to } = editor.state.selection;
    const scrollTop = editor.view.dom.closest('.ProseMirror')?.parentElement?.scrollTop ?? 0;

    // 🛡️ BUG-E01: setContent 可能因内容解析异常抛出 RangeError
    try {
        editor.commands.setContent(parsed.content);
    } catch (contentErr) {
        console.warn('[useEditorEvents] setContent failed, hard reset:', contentErr);
        try { editor.commands.clearContent(); } catch {}
        return;
    }

    const maxPos = editor.state.doc.content.size;
    const safeFrom = Math.min(from, Math.max(maxPos - 1, 0));
    const safeTo = Math.min(to, Math.max(maxPos - 1, 0));
    try {
        if (safeFrom > 0) {
            editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
        }
    } catch {
        // 位置无效时静默回退
    }

    const scrollContainer = editor.view.dom.closest('.ProseMirror')?.parentElement;
    if (scrollContainer) {
        requestAnimationFrame(() => { scrollContainer.scrollTop = scrollTop; });
    }
}
```

#### 6b. 加固 `sync:pulled` handler（L232-267）

同理，在 L246 的 `editor.commands.setContent` 外包裹同样的 try-catch + 硬回退。

#### 6c. 加固 `note:updated` handler（L91-121）

L94 的 `readTextFile(currentNoteId)` 需处理 rename 进行中文件不存在：

```typescript
try {
    if (currentNoteId.startsWith('__team__/')) return;
    const content = await readTextFile(currentNoteId);
    // ... 原有逻辑
} catch (e) {
    // 🛡️ BUG-E01: rename 进行中旧路径可能不存在，静默跳过
    if (String(e).includes('No such file') || String(e).includes('not found')) {
        return;
    }
    console.error('❌ [useEditorEvents] Failed to reload:', e);
}
```

### 验证方案

1. `vite build` 无错误
2. 文件 rename 时编辑器不报 RangeError（console 无红色错误）
3. sync pull 后编辑器内容正确刷新、光标不跳到奇怪位置

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## Step 7: BUG-E02 + BUG-E08 — 远端变更后页面自动刷新

### 背景

- **BUG-E02**: `doc_status` 远端变更后当前页面未实时刷新，需切换页面才更新
- **BUG-E08**: Promote 后目录管理页面未自动刷新

这两个本质相同：远端事件触发后，前端的数据 query 未重新 fetch。

### 指令

#### 7a. BUG-E02: doc_status 实时刷新

找到 `doc_status` 的数据源（通常是一个 useEffect 或 useSyncExternalStore），在 `sync:pulled` 事件后重新查询。

需先确认 `doc_status` 的获取位置和 store 结构，然后添加事件监听触发 re-fetch。

#### 7b. BUG-E08: 管理页面自动刷新

在 `handlePromoteToTeam`（`useFileTreeActions.ts` L603）的 `refreshTeamData(teamVaultId)` 调用后，额外 dispatch 一个事件通知管理页面刷新：

```typescript
window.dispatchEvent(new CustomEvent('team:directories-changed', { 
    detail: { vaultId: teamVaultId } 
}));
```

在管理页面组件中监听该事件，执行数据重新加载。

### 验证方案

1. `doc_status` 切换后当前页面立即显示变化 ✅
2. Promote 操作后管理页面自动刷新显示新目录 ✅

### 产出物

修改说明需包含：修改的文件、行号、diff 片段。

---

## 执行顺序

```
Step 5 (BUG-B15) → 验证 → Step 6 (BUG-E01) → 验证 → Step 7 (BUG-E02/E08) → 验证
```

## INDEX 状态更新

完成后需更新 INDEX.md：
- OPT-02: Open → **Closed**（已确认代码已实现）
- BUG-B15: ⏳ → **Closed**（改为隐藏，不再新增功能）
- BUG-E01: P2 → **Closed**
- BUG-E02: P3 → **Closed**
- BUG-E08: P3 → **Closed**

**预期结果**：Open Bug 清零 → Beta Ready 🎯
