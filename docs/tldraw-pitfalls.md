# Tldraw 嵌入踩坑交底

> **环境**：Tauri v2 + TipTap/ProseMirror + Tldraw v3，WebKit (Safari) 内核
>
> **日期**：2026-02-28
>
> **目的**：记录 Tldraw 嵌入过程中遇到的四大类关键 bug，防止后续开发者踩坑或 revert 关键修复。

---

## 1. 拖拽卡死（~2s 冻结 + 截屏闪过）

### 现象

画箭头、调整矩形/便签大小时，页面卡死约 2 秒，期间一张截屏图片飞过屏幕。控制台出现：

```
📥 [Sidebar] DragDrop event at (xxx, xxx) with 0 files
```

### 根因

```
DrawingExtension.ts → draggable: true
```

ProseMirror 的 `ReactNodeViewRenderer` 会在 NodeView 的 DOM 包装元素上设置 `draggable="true"` HTML 属性。当用户在画布内拖拽（画箭头、调整大小），**WebKit 将这个手势升级为原生 HTML5 drag-and-drop**：

1. macOS 生成窗口截屏作为拖拽快照（drag ghost image）→ **~2s 冻结**
2. Tauri 收到 OS 级 drop 事件 → Sidebar 的 `onDragDropEvent` 处理器触发（0 files）

### 修复

```typescript
// DrawingExtension.ts
draggable: false,  // ← 绝对不能改回 true
```

> [!CAUTION]
> **不要把 `draggable` 改回 `true`！** 这不是一个"可选优化"，而是防止 macOS 窗口级卡死的必要设置。Drawing 节点是全画布交互元素，不需要 ProseMirror 拖拽排序。

### 排查过程中的错误方向

以下方案均**无效**，因为 Tauri 的 `onDragDropEvent` 是 OS 级事件，完全绕过浏览器 DOM：

- ❌ React `onDragStart={(e) => e.preventDefault()}`
- ❌ CSS `-webkit-user-drag: none`
- ❌ DOM capture 阶段 `dragstart` 事件拦截

---

## 2. WebKit SVG foreignObject 光标偏移

### 现象

在箭头标签、便签、矩形、独立文本中编辑文字时，光标（caret）位置严重偏移，飞到形状上方很远的位置，或者完全不可见。

### 根因

WebKit 对 SVG `<foreignObject>` 内的 `contenteditable` 元素强制膨胀高度至 ~299px，无视 CSS `height` 约束。Tldraw 的 `align-items: center` 进一步将内容推到 `overflow: hidden` 剪裁区域外。

```
实际 DOM 高度链（诊断数据）：
  ProseMirror     → 299px（WebKit 膨胀）
  tl-rich-text    → 299px
  __inner wrapper → 32px（Tldraw inline min-height）
  tl-shape        → 24px
```

### 修复

```css
/* DrawingStyles.css */
.tl-container .tl-shape .tl-text-content__wrapper {
    overflow: hidden;
    max-height: 0;
    align-items: flex-start !important;
}
```

三个属性缺一不可：

| 属性 | 作用 |
|------|------|
| `max-height: 0` | 利用 CSS 规范：`min-height`（Tldraw 内联设置）> `max-height` → 高度 = `min-height` |
| `overflow: hidden` | 裁剪 299px 的膨胀内容 |
| `align-items: flex-start` | 阻止 Tldraw 的 `center` 将内容推到剪裁区外 |

> [!IMPORTANT]
> **选择器用 `.tl-text-content__wrapper`，不要用 `.tl-text-label__inner`！**
>
> 两种形状的内层类名不同：
> - Arrow/Note/Geo → `.tl-text-label__inner.tl-text-content__wrapper`
> - 独立 Text → `.tl-text-shape-label__inner.tl-text-content__wrapper`
>
> 共有类是 `.tl-text-content__wrapper`，用这个才能统一覆盖。

---

## 3. ProseMirror 焦点抢夺（光标跳出画布）

### 现象

在画布中选择工具、点击调色板按钮后，ProseMirror 编辑器的文本光标出现在画布外的文档中（如 placeholder "开始输入..."）。

### 根因

两层问题叠加：

**A. `stopEvent` 未覆盖 Portal 元素**

Tldraw 的调色板、菜单、弹窗通过 **React Portal 渲染在 `document.body`**，不在 `.drawing-container` 内。原始 `stopEvent` 只检查 `.drawing-container.is-editing`，对 Portal 元素返回 `false` → ProseMirror 接管事件 → 设置文本选区。

```typescript
// DrawingExtension.ts — 修复后
stopEvent: ({ event }) => {
    const target = event.target as HTMLElement;
    if (target.closest('.drawing-container.is-editing')) return true;
    if (target.closest('[class*="tlui-"]')) return true;   // Tldraw UI
    if (target.closest('[class*="tl-"]')) return true;     // Tldraw 核心
    if (target.closest('[data-radix-popper-content-wrapper]')) return true;
    if (target.closest('[data-radix-dialog-content]')) return true;
    return false;
}
```

**B. 进入编辑模式时未 blur ProseMirror**

即使 `stopEvent` 正确返回 `true`，ProseMirror 的 view 仍然保持焦点状态并显示光标。

```typescript
// DrawingNodeView.tsx
useEffect(() => {
    if (localEditing && editor) {
        editor.commands.blur();
    }
}, [localEditing, editor]);
```

> [!WARNING]
> 如果新增了 Tldraw 的 UI 组件类型（新的弹窗、面板等），需要在 `stopEvent` 中添加对应的 `closest` 检查。

---

## 4. handleClickOutside 误触发保存

### 现象

在画布中操作时，`handleSave` 被意外触发，执行 `editor.toImage()` 导致性能下降。

### 根因

`handleClickOutside` 监听 `document` 的 `mousedown` 事件。当用户点击 Tldraw 的 Portal 元素（调色板、菜单等渲染在 `document.body` 的元素）时，这些点击不在 `.tldraw-editor-container` 内部，被误判为"点击外部" → 触发 `handleSave()`。

### 当前防护

```typescript
// TldrawEditor.tsx — handleClickOutside 内的 Portal 检测
const isInsidePortal =
    target.closest('[class*="tlui"]') ||
    target.closest('[class*="tl-"]') ||
    target.closest('[data-radix-popper-content-wrapper]') ||
    target.closest('[data-radix-dialog-content]');
```

> [!NOTE]
> 这段检测和 `stopEvent` 的 Portal 检测逻辑相同。如果后续 Tldraw 升级引入新的 Portal 类名，**两处都要同步更新**。

---

## 5. CSS 布局注意事项

### tldraw-header 悬浮工具栏

Header（×、保存、全屏按钮）使用 `position: absolute` 悬浮在画布上方：

```css
.tldraw-header {
    position: absolute;
    z-index: 100;
    pointer-events: none;     /* 让点击穿透到画布 */
}
.tldraw-header > * {
    pointer-events: auto;     /* 按钮本身可点击 */
}
```

- **不要加背景色/渐变**——与画布内容重叠时视觉效果差
- Canvas 高度设为 `100%`（不需要减去 header 高度）

### 调色板偏移

```css
.tldraw-editor-container .tlui-style-panel__wrapper {
    top: 36px !important;  /* 避开 header 按钮 */
}
```

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `DrawingExtension.ts` | 节点定义、`draggable: false`、`stopEvent` |
| `DrawingNodeView.tsx` | 双模切换、ProseMirror blur |
| `TldrawEditor.tsx` | Tldraw 编辑器、保存/取消、键盘拦截、handleClickOutside |
| `DrawingStyles.css` | WebKit foreignObject 修复、布局、z-index |
