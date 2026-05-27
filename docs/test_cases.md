# Slash 内部测试用例与系统全景验收大纲 (V1.0 测试手册)

> **目的**：Slash Phase 1～3 的结构性开发已经告一段落。此文档用于在正式进入“内测上线”阶段前，提供一份全局视角、事无巨细的功能验收与边界测试指南。
> **要求范畴**：基础编辑、设置与管理、文件系统与持久化、AI 自动化流程、Team 协同以及多端 i18n。

---

## 模块 I：核心编辑器与其序列化协议 (TipTap & Markdown Bridge)

> **护栏检查重点**：确保所有的高级互动组件在前端画布与后端 Markdown 文件之间的无损穿梭。重点测试 CJK（中日韩字符）边界以及结构节点防穿透。

### 1. 纯文本与排版基础
- [ ] **多语言混排测试**：输入大段连贯混合的中英文文本，在句首和句尾执行频繁的 Undo/Redo，观察文本切分处是否存在不安全 UTF-8 Char Boundary 导致的光标抖动或乱码。
- [ ] **列表与层级结构**：嵌套四层无序与有序列表，利用 `Tab` 和 `Shift+Tab` 验证节点层级缩进；使用 `Enter` 按键连续截断列表（查看连续空行时是否触发 Paragraph 挤压 BUG）。
- [ ] **高亮与行内格式**：在单词内部局部高亮、局部加粗。并观察 Markdown 反映在磁盘上的内容是否产生了多余的空格。

### 2. 高级 Block 容器
- [ ] **Table 表格深度测试**：
  - 测试 BUG-007 修复：插入多列多行数据的大型表格，光标在最后一行回车时，确保不再破坏外层 Document 结构。
  - 表格内外选择：拖拽框选多个单元格，使用 Backspace 删除。
- [ ] **CodeBlock 低亮与解析**：
  - 切换多种语言 (Rust, TS, Python) 检查语法高亮规则，拷贝带有连续反引号的 Markdown 代码粘入，验证逃逸符序列化是否正常。
- [ ] **Tldraw (画板) 重构渲染测试 (Tier 12)**：
  - 在 Tldraw 组件中进行极大视野缩小、平移并在边缘绘制图形。
  - **核心验证**：关闭文档后，检查生成的 Sidecar PNG 文件（结合 `getSvgJsx` 最新修复），确保图形不再被强行裁剪或是出现 WebKit metric 脱轨导致的长宽比病变。

---

## 模块 II：文件树索引管理与存储持久化

> **护栏检查重点**：验证基于 Rust 的 "Backend-Driven Authority" (后端权威) 文件索引树的表现以及 Vault Identity (库身份) 的隔离度。

### 1. Sidebar 与路径抽象管理
- [ ] **点击区域隔离 (Click-Zone Separation)**：
  - 精准点击文件树节点的 `Arrow` 展开目录（不应触发 Note 跳转）。
  - 精准点击文件名字（应触发 Note 加载，并验证 Active Tab 高亮联动）。
- [ ] **排他性交互测试 (Rename/Delete)**：
  - 验证基于 Pattern 67 模式的重命名：在修改名称时改变大小写，检查 macOS 默认不敏感大小写限制引起的“假失败”是否被成功劫持与安全恢复。
  - 删除一个带有大量嵌套子文件夹的目录树，使用 `Cmd+Z` 操作（如果支持）或从 OS 回收站还原时验证 Watcher 是否快速补全缺失的 UI 阴影。
- [ ] **隔离安全网 (Vault 切换)**：快速切换本地多库，验证 `clearRoot` 或 "Immediate Invalidation" 会不会瞬间阻断前一个 Vault 在后台遗留的异步渲染请求，彻底防御跨库数据交叉感染 BUG-011。

### 2. I/O 持久与双态存储
- [ ] **防覆盖冲突检测**：
  - 修改 `note.md` 的内容不保存。从终端通过 VSCode 打开同一路径对应的 Markdown，执行外部修改并强制落盘。切回 Slash 后必须触发并正确走完 File Watcher 检测 -> 前后端版本对齐逻辑。

---

## 模块 III：AI 管道与自主化引擎

> **护栏检查重点**：AI 的 Orchestrator （后台大模型调度池），包含新修复的 `Connection` 防串联污染保护，与嵌入向量垃圾回收逻辑。

### 1. 原子技能与异步并发稳定性 (关键测试)
- [ ] **Summarization / Tagging 极端并发测试**：
  - 断开网络后在同一篇长文连按（或触发防抖）多次 AI Summarization / Tagging。然后连接网络，检查 DB 是否抛出 `disk image is malformed`；（已修复：应平稳独立更新数据库而不抛出连接崩溃）。
- [ ] **向量孤儿清理机制检测**：
  - 在包含 2000 个字的文档存盘后，使用 SQLite 查询确保 Paragraph 分块切分成功并在 `embeddings_v2` 表入账。
  - 一次性抹除其中 1900 个字后保存，验证过时的（孤儿）嵌入向量是否被清理干净，从而防止搜索时出没“幽灵引用”。

### 2. 知识萃取与 RAG 搜索
- [ ] **GhostLink 与智能高亮**：创建两个完全没有链接过，但是具备高度相似描述段落的笔记，触发 GhostLink 建议，允许注入后点击，验证双向锚点跳转准度。
- [ ] **混合全搜 4-Pillar (FTS5 + Semantic)**：
  - 采用模糊语义提问（例：“上次那个处理数据合并的模块”），验证 `RAG`（温度 0.0）合成功能。
  - **边缘测试**：利用 FTS5 查询关键字截取时，对齐高亮是否会出现把 HTML 标签劈开从而导致 React Crash。

### 3. PARA Inbox 决断引擎 (v7.4.x)
- [ ] **漏斗模型把关**：新建零星几段话的潦草碎片（字数不满足阈值）放在 Inbox，观察是否会自动触发分类（应拦截）。
- [ ] **跨模型多目录分词映射**：写入一篇标准的学习笔记，利用大模型自动建议移动至对应的 Project / Resource 目录下，观察其“本地图谱（Local Graph）”的 UI 状态能否伴随目录跳跃成功衔接和响应。

---

## 模块 IV：全局任务中心面板 (Note-Centric Task System)

### 1. SQLite 增量检索与 UI 强绑定
- [ ] **多端数据防串改**：在 A 文档写入一组特定的 Markdown Tasks (`- [ ] xxxx`)。跳转到对应的全局任务搜索 Tab 或者日历面板里寻找该任务，通过全局视图点击 `[x]` 修改为完成状态。
- [ ] **溯源变更即时性 (Query-after-Insert)**：切回到原始 A 文档，验证编辑器的 Markdown 代码块是否已被后台重写入真正的 `[x]`，而不必重新刷新组件。

---

## 模块 V：Slash 团队协同版本 (Team Collaboration v3)

> **护栏检查重点**：权限控制 (RBAC) 、私有库隔离度及 Diff 合并引擎。

### 1. 数据隔离沙箱与模式显隐 (Space Isolation Guardrails)
- [ ] **目录挂载隔离**：确保 Local（本地硬盘）和 Team（服务端下推）两者的 SideBar 可以纵向无缝拆分，滚动互不干扰。
- [ ] **UI 精确隐藏降级功能**：
  - 打开 Local 文件夹里的一篇 Markdown，确保顶部的“协作（Collaboration History）”、“模式切换胶囊 (Mode Switching)” 及协同图标**彻底消失**。
  - 打开 Team 目录里的文件，验证胶囊图标如期恢复渲染，且点击后实时建立连接。

### 2. Sync 同步舱稳定性
- [ ] **覆盖与仲裁优先权**：
  - 在弱网环境下发起大篇幅修改。如果服务端哈希发生竞态推回，并且本地正在进行 Active Edit 活动，系统应当使用 `editingPath` 热锁存，防止输入过程被老旧版本霸凌覆盖。
- [ ] **TeamManagement Page (统一配置)**：
  - 进入全屏的 Team 管理页，进行一次成员邀请并通过终端模拟 Join Via Invite 链路入库，验证界面的 Head/Shell 无刷新自动获取新兵身份，验证 RBAC 中二态切换 (Admin/Reader) 的即时后端校验是否阻拦越权写入。

---

## 模块 VI：横向工程规范与国际化 (i18n & Settings)

> **护栏检查重点**：全站的多语种静态与动态热切换、按键抢占及用户自定义配置。

- [ ] **多语言动态降级 (Fallback)**：在系统语言中设置到应用尚未全面兼容的小语种。查看设置面板、侧边栏工具栏以及 AI Skill 的内置报错，是否能够完美 Fallback 回英语或中文。
- [ ] **键盘生命周期与悬浮劫持**：
  - 焦点位于 In-Note Search（内联查找搜索框）内部输入时，尝试使用全局快捷键（如 `Cmd+Shift+K`）。
  - **规则要求**：要求内联框焦点优先级退让而激活全局行为，且窗口切换完毕后恢复原焦点。
- [ ] **维护与重用记录**：验证当前项目的任何 UI 组件没有随意复写 Tailwind 而违背 UI-UX-Pro-Max 中定义的设计系统，且保证所有的新模块（如 Sync Tab Redesign）继续遵循了 Shell-and-Module 层级封装协议。

---
`Document Generated relative path: <project_root>/docs/test_cases.md`
`End of testing guide. Keep KISS and First Principle Thinking.`
