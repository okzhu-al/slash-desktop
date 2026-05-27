# BUG-E01：编辑器在重命名+同步竞态下崩溃（Position out of range）

> **优先级**: P2（体验缺陷，不阻塞功能）
> **状态**: 待修复
> **发现日期**: 2026-04-20
> **复现条件**: 偶发，重命名文件后立即编辑 + Auto-Sync 定时器恰好在同一时间窗口触发

---

## 现象

编辑器锁死，控制台报错：
```
RangeError: Position 11 out of range
RangeError: Applying a mismatched transaction
```

## 触发链路

```
T1: 用户重命名文件（侧边栏）
T2: 编辑器标签切换到新路径
T3: 用户开始编辑（光标在某位置）
T4: Auto-Sync 定时器触发 → negotiate + push
T5: Sync 回写本地状态 / file watcher 检测到文件变化
T6: useNoteContent 或 useEditorEvents 调用 editor.commands.setContent()
T7: 💥 ProseMirror DOM 观察队列中有 T3 的待处理变更，
    但 T6 的 setContent 已改变文档状态 → 位置越界
```

## 修复方向

在 `setContent` 调用前加一个 **编辑器忙碌检测 guard**：

```typescript
// useNoteContent.ts / useEditorEvents.ts
if (editor.isFocused && editor.state.tr.docChanged) {
  // 编辑器正在处理用户输入，延迟重载
  setTimeout(() => reloadContent(), 200);
  return;
}
editor.commands.setContent(parsed.content);
```

或者更彻底的方案：在 Auto-Sync 的 Pull 写盘逻辑中，如果检测到目标文件正在编辑器中被编辑（`editingSet` 包含该路径），跳过写盘，等下一个 sync 周期再处理。

## 涉及文件

- `apps/desktop/src/features/editor/hooks/useNoteContent.ts` (L73, L81)
- `apps/desktop/src/features/editor/hooks/useEditorEvents.ts` (L175, L246)
- `apps/desktop/src-tauri/src/commands/sync/personal.rs` (editing_set 过滤)

---

**架构师登记。2026-04-20**
