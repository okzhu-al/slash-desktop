# Tiptap + Markdown 编辑器调试经验总结

> 基于 Math Formula 渲染问题的完整调试过程

## 🎯 问题背景

在 Slash 编辑器中实现 LaTeX 数学公式功能时，遇到了一个复杂的序列化/反序列化问题：
- **输入时**：`$E=mc^2$` 能正确转换为渲染的公式
- **重新打开时**：公式变成 `<p><></p>` 或纯文本

---

## 🔍 调试方法论

### 1. 分段日志追踪

在数据流经过的每个关键节点添加日志：

```
用户输入 → onUpdate → getMarkdown() → saveContent → Repository → 文件
文件 → Repository.getNote → App.setContent → Editor.setContent → 渲染
```

**关键日志点**：
```typescript
// 1. 序列化输出
console.log('💾 [onUpdate] Markdown:', content);

// 2. 保存时的内容
console.log('💾 [Repository] Received:', note.content);

// 3. 写入文件的完整内容  
console.log('💾 [Repository] Final file:', fileContent);

// 4. 加载时读取的内容
console.log('📖 [Repository] Parsed:', bodyContent);

// 5. 传递给编辑器的内容
console.log('🔍 [Load] About to parse:', cleanBody);
```

### 2. 对比分析法

始终对比两端的内容：
- **写入端**：实际写入文件的是什么？
- **读取端**：从文件读取的是什么？

用 VS Code 直接打开 `.md` 文件验证真实内容。

### 3. 隔离问题域

将问题分解为独立的子问题：
1. **序列化是否正确？** → 检查 `getMarkdown()` 输出
2. **文件写入是否正确？** → 用外部编辑器验证
3. **文件读取是否正确？** → 检查 `getNote()` 返回值
4. **解析是否正确？** → 检查 `setContent()` 后的 DOM

---

## ⚠️ 发现的陷阱

### 陷阱 1：异步竞态条件

```typescript
// ❌ 错误：debounce 期间内容可能被覆盖
onUpdate: ({ editor }) => {
    timerRef.current = setTimeout(() => {
        const content = editor.getMarkdown(); // 500ms 后重新获取，可能已被污染
        saveContent(content);
    }, 500);
}

// ✅ 正确：立即捕获快照
onUpdate: ({ editor }) => {
    const snapshot = editor.getMarkdown(); // 立即捕获
    timerRef.current = setTimeout(() => {
        saveContent(snapshot); // 使用快照
    }, 500);
}
```

### 陷阱 2：格式转换不一致

```typescript
// ❌ 错误：保存 Markdown，但加载时转换为 HTML
async getNote() {
    const markdown = readFile(path);
    return { content: toHTML(markdown) }; // 格式不匹配
}

// ✅ 正确：保持格式一致
async getNote() {
    const markdown = readFile(path);
    return { content: markdown }; // 直接返回 Markdown
}
```

### 陷阱 3：tiptap-markdown API 版本差异

```typescript
// ❌ v0.9 中可能不存在
markdown.parser.addRule('math', handler);

// ✅ 使用手动转换作为备选方案
doc.descendants((node, pos) => {
    if (node.isText && /\$([^$]+)\$/.test(node.text)) {
        // 手动替换为 Math node
    }
});
```

### 陷阱 4：ProseMirror atom 节点规范

```typescript
// ❌ 错误：缺少内容占位符
renderHTML() {
    return ['span', { 'data-type': 'math' }];
}

// ✅ 正确：atomic node 需要 0 作为占位符
renderHTML() {
    return ['span', { 'data-type': 'math' }, 0];
}
```

---

## 📋 后期开发注意事项

### 添加新的 Markdown 元素时

1. **在 Extension 中定义序列化**：
```typescript
addStorage() {
    return {
        markdown: {
            serialize(state, node) {
                // Node → Markdown string
            }
        }
    };
}
```

2. **在 Editor.tsx 中添加加载转换**：
```typescript
// safeParseAndSetContent 中添加新的 pattern 转换
const regex = /\[\[([^\]]+)\]\]/g; // 示例：wiki links
// ... 转换为对应的 Node
```

3. **验证完整流程**：
   - [ ] 输入时正确创建 Node
   - [ ] 保存时输出正确的 Markdown
   - [ ] 重新加载时正确渲染
   - [ ] 外部编辑器（VS Code）能正确显示

### 调试新功能时

1. **保留日志模板**：
```typescript
console.log('💾 [组件:阶段] 描述:', JSON.stringify(data.substring(0, 100)));
```

2. **使用 emoji 前缀区分来源**：
   - 💾 保存相关
   - 📖 读取相关  
   - 🔍 解析相关
   - 📐 扩展内部
   - ⚠️ 警告/错误

3. **验证文件真实内容**：
```bash
cat ~/Documents/slash/test.md
```

### 性能注意事项

- 手动 pattern 转换使用 `setTimeout(..., 10)` 避免阻塞
- 大文件时考虑分批处理 `doc.descendants()`
- 日志在生产环境应移除

---

## 🔧 最终架构

```
┌─────────────────────────────────────────────────────────────┐
│                         用户输入                              │
│                      $E=mc^2$ + $                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    InputRule (MathExtension)                 │
│                  匹配 $...$ → 创建 Math Node                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  onUpdate (Editor.tsx)                       │
│              getMarkdown() → "$E=mc^2$"                      │
│                    ↓ 500ms debounce                          │
│                  saveContent(snapshot)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│             FileSystemNoteRepository.saveNote               │
│                 写入: $E=mc^2$                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         [文件系统]
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│             FileSystemNoteRepository.getNote                │
│                 读取: "$E=mc^2$"                             │
│                 (直接返回 Markdown，不转换)                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              safeParseAndSetContent (Editor.tsx)            │
│                  1. setContent(markdown)                     │
│                  2. 手动转换 $...$ → Math Node               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  MathNodeView (React)                        │
│                    KaTeX 渲染公式                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📚 相关文件

- [MathExtension.ts](file:///Users/junior/Projects/slash/src/features/editor/extensions/MathExtension.ts) - Math Node 定义
- [MathNodeView.tsx](file:///Users/junior/Projects/slash/src/features/editor/components/MathNodeView.tsx) - 渲染组件
- [Editor.tsx](file:///Users/junior/Projects/slash/src/features/editor/components/Editor.tsx) - 编辑器主逻辑
- [FileSystemNoteRepository.ts](file:///Users/junior/Projects/slash/src/core/storage/FileSystemNoteRepository.ts) - 文件读写
