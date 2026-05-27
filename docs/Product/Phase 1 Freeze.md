# Slash Phase 1 Code Freeze

## 冻结日期：2026-01-15

## 冻结范围

以下模块已完成核心功能开发，进入 **Code Freeze** 状态：

### ✅ 冻结模块

| 模块 | 路径 | 说明 |
|------|------|------|
| TipTap 扩展 | `src/features/editor/extensions/` | 30+ 个自定义扩展 |
| 序列化器 | `src/features/editor/serializers/` | Markdown 序列化 |
| 编辑器配置 | `src/features/editor/config/` | 扩展注册 & Markdown 桥接 |
| 编辑器组件 | `src/features/editor/components/` | Editor.tsx 核心逻辑 |
| 存储层 | `src/core/storage/` | FileSystemNoteRepository |
| 标签系统 | `src/core/tabs/` | TabsStore |
| 文件系统 | `src/core/fs/` | FileSystemStore |

### 🔓 可扩展模块

以下模块可继续开发新功能：

| 模块 | 路径 | 建议操作 |
|------|------|----------|
| Hooks | `src/hooks/` | 添加新 hooks |
| 核心服务 | `src/core/` | 添加新服务 |
| 侧边栏 | `src/features/sidebar/` | UI 优化 |
| 设置 | `src/features/settings/` | 新配置项 |
| Rust 后端 | `src-tauri/src/core/` | AI 功能增强 |

---

## 冻结验证清单

### 数据完整性 ✅
- [x] Markdown 回环测试通过
- [x] WikiLink 格式保持
- [x] 嵌套列表/表格序列化正确

### 交互鲁棒性 ✅
- [x] 中文输入法 (IME) 无吞字
- [x] 粘贴清洗正常
- [x] 大文件拖拽不卡死

### 性能基线 ✅
- [x] 5000+ 字输入无明显延迟
- [x] 切换笔记无内存泄漏

### 架构隔离 ✅
- [x] Extensions 配置分离 (`config/extensions.ts`)
- [x] IO 操作分离 (通过 hooks)
- [x] 无直接 fs 调用在 Editor.tsx

---

## 修改规则

### 冻结模块修改需要：

1. **Bug 修复**：必须有明确的 Issue 编号
2. **紧急修复**：需要至少两轮测试验证
3. **功能增强**：禁止，使用插件模式

### 新功能开发方式：

```typescript
// ✅ 正确：通过 config/extensions.ts 添加新扩展
export function createEditorExtensions(options) {
    return [
        ...existingExtensions,
        NewPluginExtension, // 新插件在这里添加
    ];
}

// ❌ 错误：直接修改现有扩展
// WikiLink.ts 已冻结，不应修改
```

---

## Git 标签

建议创建标签：
```bash
git tag -a v1.0-core-freeze -m "Phase 1 Core Freeze - 2026-01-15"
git push origin v1.0-core-freeze
```

---

## 下一阶段：Phase 2 特色功能

- [ ] 命令面板 (Cmd+K)
- [ ] 全文搜索
- [ ] AI 智能标签
- [ ] 语义搜索
- [ ] 知识图谱可视化

---

*本文档标志 Slash 核心编辑功能开发完成，后续进入插件式开发阶段。*
