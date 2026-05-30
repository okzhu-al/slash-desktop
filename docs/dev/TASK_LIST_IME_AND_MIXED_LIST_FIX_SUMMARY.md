# Task List IME 与混合多级列表顽固问题修复总结

本文记录一次围绕 TipTap / ProseMirror 任务列表的集中排障。问题横跨中文输入法、React NodeView、混合多级列表缩进、任务元数据菜单和任务列表视觉对齐。

## 背景

Slash 编辑器使用自定义 `MixedTaskList` / `MixedTaskItem` 支持任务列表与有序、无序列表混合嵌套。任务项原本通过 React NodeView 渲染 checkbox、内容区和任务元数据菜单。

目标行为：

- `[] ` 或 `【】 ` 创建任务列表。
- 任务列表内回车生成新的 checkbox 行。
- 中文 IME 输入不应让任务行退化为普通段落。
- 混合多级列表中，Tab / Shift-Tab 只作用于当前光标所在的最近列表项。
- 任务列表缩进、行高、行间距应与有序、无序列表一致。

## 主要现象

### 中文 IME 退化

复现路径：

1. 输入 `[] ` 创建任务列表。
2. 第一行输入中文。
3. 回车生成第二个 checkbox。
4. 在第二行输入中文。

现象：

- 第二行先渲染为 checkbox。
- 中文输入期间，第二行会退化成普通段落，并与下一行合并。
- 英文输入没有该问题。
- 多级任务列表中，事后恢复会把二级任务错误恢复到一级。

关键输入事件链路：

```text
compositionstart
insertCompositionText
deleteCompositionText
insertFromComposition
compositionend
```

### 混合列表 Tab 错层

复现结构：

```text
[ ] 一级任务 1
[ ] 一级任务 2
    1. 二级有序 1
    2. 二级有序 2  <- 在这里按 Tab
```

错误行为：

```text
[ ] 一级任务 1
    [ ] 一级任务 2
        1. 二级有序 1
        2. 二级有序 2
```

期望行为：

```text
[ ] 一级任务 1
[ ] 一级任务 2
    1. 二级有序 1
        1. 三级有序 1
```

### 视觉不一致

问题包括：

- 一级任务列表看起来像二级有序/无序列表。
- 同级任务列表之间的行间距和跨级任务列表之间的行间距不同。
- 任务项从二级 outdent 回一级后，行间距突然变大。

## 定位过程

### 1. DOM mutation 日志只能说明现象

最初通过 DOM mutation 和 IME 事件日志发现：

- `deleteCompositionText` 之后出现多次 `ul[data-type="taskList"]` 重建。
- `insertFromComposition` 之前，光标可能已经落到普通 `<p>`。
- 顶级场景可以用事后恢复把段落并回 taskList，但多级场景会恢复错层。

结论：DOM 日志只能看到退化后的结果，不足以判断是哪一个 ProseMirror transaction 破坏了结构。

### 2. transaction 级日志确认根因

临时加入 transaction 诊断后，关键日志显示：

```json
{
  "stepType": "replace",
  "from": 11,
  "to": 18,
  "metaKeys": ["composition"]
}
```

旧结构中 `from: 11, to: 18` 正好覆盖当前整个 `taskItem`：

```text
11:taskItem "san"
12:paragraph "san"
19:paragraph ""
```

新结构变成：

```text
0:taskList "一二"
12:paragraph ""
```

结论：

中文 IME 的 `deleteCompositionText` 本应只删除临时拼音文本，但 ProseMirror / DOMObserver 计算出的 replace 范围越过了文本边界，覆盖了整个 `taskItem`。这才是任务项退化的直接原因。

### 3. React NodeView 不是唯一原因，但会放大风险

原 React NodeView 结构大致为：

```text
li
  React wrapper
    checkbox
    NodeViewContent
      contentDOM
        p
```

这个结构让 IME / DOMObserver 在复杂组合输入中更容易把变更范围扩大到 taskItem 边界。

将其改为薄原生 NodeView 后：

```text
li.slash-task-item
  span.task-checkbox-wrapper
  div.slash-task-content  <- contentDOM
```

退化风险下降，但单靠薄 NodeView 仍不能完全阻止 `deleteCompositionText` 越界。因此最终修复还需要专门拦截该输入事件。

## 最终修复

### 1. 使用薄原生 TaskItem NodeView

文件：

- `packages/js-editor-core/src/extensions/MixedListExtension.ts`

关键思路：

- 不再使用 `ReactNodeViewRenderer(TaskItemComponent)` 作为 task item 容器。
- `contentDOM` 直接挂在 `li` 下。
- checkbox 点击仍通过原生 DOM 事件更新 `checked` 属性。
- 保留 `renderHTML` 与 `parseHTML` 兜底，保证加载和复制粘贴兼容。

收益：

- 减少 React wrapper 对 IME range 计算的影响。
- 避免 NodeView contentDOM 被多层包装后，ProseMirror 把 composition 删除范围误判到 taskItem 边界。

### 2. 拦截 taskItem 内的 `deleteCompositionText`

文件：

- `packages/js-editor-core/src/extensions/MixedListExtension.ts`

关键思路：

- `compositionstart` 记录 composition 起点。
- 在 taskItem 内遇到 `beforeinput` 且 `inputType === "deleteCompositionText"` 时：
  - 阻止浏览器默认越界删除。
  - 只删除 composition 起点到当前 selection 之间的临时拼音文本。
  - 保持 selection 在 taskItem paragraph 内。
- 后续 `insertFromComposition` 继续由浏览器 / ProseMirror 正常插入最终汉字。

这解决了两个失败方案的问题：

- 只事后恢复：多级列表会恢复错层。
- 只拦截 destructive transaction：临时拼音残留，出现 `si四`。

最终行为：

- 不再肉眼可见先退化再恢复。
- 不再残留拼音。
- 顶级和多级任务列表均稳定。

### 3. 任务元数据菜单重新接回

原 `TaskItemComponent` 同时承担了元数据菜单入口。换成薄 NodeView 后，需要重新接回入口。

最终方案：

- task item 内双空格打开原生 DOM 主菜单。
- 菜单项插入对应 draft chip：
  - `dateChip`
  - `userChip`
  - `priorityChip`
- 具体日期选择器、人员选择器、优先级选择器仍由现有 chip React NodeView 负责。

这样避免重新引入包裹 taskItem `contentDOM` 的 React NodeView。

### 4. Tab / Shift-Tab 按最近列表项分发

文件：

- `packages/js-editor-core/src/extensions/MixedListExtension.ts`

根因：

光标在有序/无序 `listItem` 内时，外层仍有 `taskItem` 祖先。原生 taskItem 的 Tab shortcut 会抢先执行，导致缩进外层任务项。

修复：

- 增加 `findNearestListItemType($pos)`。
- `MixedListItem` 和 `MixedTaskItem` 都覆盖 `Tab` / `Shift-Tab`。
- 只有当前扩展类型等于离光标最近的列表项类型时才处理。

结果：

- 光标在有序/无序列表项内时，只缩进当前 `listItem`。
- 光标在任务项正文内时，才缩进当前 `taskItem`。

### 5. 任务列表视觉对齐

涉及文件：

- `apps/desktop/src/index.css`
- `packages/js-editor-core/src/extensions/Task/TaskItemStyles.css`

调整内容：

- taskList 首层缩进与普通列表一致。
- 嵌套 taskList 缩进与普通嵌套列表一致。
- taskItem 行高、行间距与普通 `li` 一致。
- checkbox 使用负 margin 占据普通 marker 位置，避免任务正文多缩进一层。
- 嵌套 taskList 最后一项不额外贡献底部 margin，避免 outdent 后出现双重间距。

## 被废弃的尝试

以下方案被验证不够稳定，最终没有保留：

- 在 `compositionend` 后把普通段落恢复成 taskItem。
  - 顶级场景可用，多级场景会恢复错层。
- 在 filterTransaction 中直接拒绝 destructive composition transaction。
  - 能阻止退化，但会残留拼音，出现 `si四`。
- 仅把 React NodeView 改成薄 NodeView。
  - 能降低风险，但仍无法完全阻止 `deleteCompositionText` 越界。
- 长期保留 transaction 诊断日志。
  - 只用于定位，最终已清理。

## 验证清单

建议每次改动任务列表相关逻辑后至少验证：

1. `[] ` 和 `【】 ` 创建任务列表。
2. 顶级任务列表第二行输入中文。
3. 多级任务列表空项输入中文。
4. 中文拼音输入不残留，例如 `si -> 四` 最终只保留 `四`。
5. task item 双空格打开元数据菜单。
6. 日期、人员、优先级 chip 插入和保存。
7. 混合列表中，在有序/无序列表项内按 Tab，只缩进当前行。
8. 在 task item 正文内按 Tab，只缩进当前任务项。
9. 任务列表、有序列表、无序列表的首层缩进、嵌套缩进、行高、行间距一致。
10. 二级任务 outdent 回一级后，行间距不突然变大。

## 经验总结

- 对 contenteditable + IME 问题，DOM mutation 日志通常只能看到结果；真正定位需要 transaction 级别的 step 和 selection 变化。
- React NodeView 可以用于 atom/chip，但作为复杂 block list item 的外层容器时，要谨慎处理 `contentDOM` 包装层。
- 混合列表中，键盘快捷键不能只按 `editor.isActive()` 判断；必须按 selection 所在的最近列表项类型分发。
- 列表视觉对齐不只是 `padding-left`，还包括 marker/checkbox 占位、嵌套列表顶部间距、最后一项底部 margin。
