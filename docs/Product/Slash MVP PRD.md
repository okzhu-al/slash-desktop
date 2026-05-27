# Slash MVP PRD - 产品需求文档

> **状态**: ✅ MVP 完成 + Phase 1 冻结 (2026-01-15)

## 产品定义

- **名称**: Slash
- **类型**: 本地优先 Markdown 编辑器 + AI 知识管理
- **目标用户**: 知识工作者、开发者、写作者

---

## 功能清单

### Phase 1 核心功能 (✅ Frozen)

| 功能 | 状态 | 验收标准 |
|------|------|----------|
| Vault 选择 | ✅ | 无需登录即可启动 |
| PARA 结构 | ✅ | 自动创建 00-04 文件夹 |
| 侧边栏 | ✅ | 显示 vault 内所有文件 |
| 多标签页 | ✅ | 标签持久化 |
| WYSIWYG 编辑 | ✅ | TipTap 编辑器 |
| 自动保存 | ✅ | 500ms 防抖 |
| Markdown 存储 | ✅ | YAML frontmatter |
| 深色模式 | ✅ | 完整支持 |
| 中英双语 | ✅ | i18n 完整 |

### 编辑器扩展 (✅ Frozen)

| 扩展 | 状态 | 语法 |
|------|------|------|
| 标题 | ✅ | `#` - `######` |
| 粗体/斜体/删除 | ✅ | `**` / `*` / `~~` |
| 代码块 | ✅ | ` ``` ` |
| 表格 | ✅ | Markdown 表格 |
| 任务列表 | ✅ | `- [ ]`, `【】` |
| WikiLink | ✅ | `[[note]]` |
| 数学公式 | ✅ | `$latex$` |
| Mermaid | ✅ | ` ```mermaid ` |
| 图片/视频/音频 | ✅ | 拖拽上传 |

### 后端功能 (✅ Frozen)

| 功能 | 状态 | 说明 |
|------|------|------|
| SQLite 数据库 | ✅ | 元数据持久化 |
| 文件监控 | ✅ | 实时同步 |
| Hash 去重 | ✅ | 媒体资源 |
| AI 集成 | ✅ | Ollama 标签/摘要 |

---

## Phase 2 路线图

### 命令面板 (Cmd+K)
- [ ] 快速切换笔记
- [ ] 全文搜索
- [ ] 命令执行

### AI 增强
- [ ] 智能标签建议
- [ ] 自动摘要
- [ ] 语义搜索

### 知识图谱
- [ ] 可视化笔记关系
- [ ] 反向链接

### 发布
- [ ] 静态站点导出
- [ ] 分享链接

---

## 架构约束

### 冻结模块 (不可修改)
- `src/features/editor/extensions/`
- `src/features/editor/serializers/`
- `src/features/editor/config/`
- `src/core/storage/`

### 可扩展模块
- `src/hooks/` - 新 hooks
- `src/core/` - 新服务
- `src/features/` - 新功能模块

---

*详见 [Phase 1 Freeze.md](Phase%201%20Freeze.md)*
