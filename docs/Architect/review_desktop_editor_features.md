# Slash 编辑器编辑功能架构审阅报告 (Batch 2 ~ Batch 2.8)

本报告对 Slash 桌面端富文本编辑功能（格式定制、表格控制、公式块、列表缩进等）的底层架构设计、ProseMirror 事务原子性安全性，以及 WikiLink 落盘级联进行了深入的架构审计。

---

## 1. 编辑器扩展层架构与分层清洁度

### 1.1 模块化与自定义扩展设计
* **架构分层现状**：Slash 编辑器逻辑完全定义在独立的 `packages/js-editor-core` npm 包下。前端 React 主程序 `apps/desktop` 通过引入并向编辑器实例传入自定义的 `extensions` 配置数组来定制其功能，从而将底层的 ProseMirror/Tiptap 的 DOM 驱动逻辑与 React 的状态机 UI 彻底分离，维持了极佳的分层清洁度。
* **自定义扩展管理**：
  * **行内格式扩展**：如加粗 `CustomBold`、斜体 `CustomItalic`、删除线 `CustomStrike`、高亮 `CustomHighlight` 等。通过继承 Tiptap 自带的基础 Mark 扩展并覆写 `addInputRules` 和 `addKeyboardShortcuts` 来改变其退格删除与样式阻断的行为，确保底层 PM Schema 定义不需要因为客户端特性而进行破坏性改动。
  * **命令分层**：斜杠命令通过 `SlashCommand` 插件捕获 `/` 键入并弹出菜单，采用 Tiptap Command 模式派发底层 Transaction 事务，保持了纯粹的数据流驱动。
* **清洁度审计与重构**：
  * **引用块的重构**：之前直接使用 `StarterKit` 默认的 blockquote 导致难以添加自定义占位符和初始物理双引号对。重构后将其剥离为独立的 [CustomBlockquote.ts](file:///Users/junior/Projects/slash/packages/js-editor-core/src/extensions/CustomBlockquote.ts) 扩展，集中承载对其 `InputRule` 转换和 `TextSelection` 的控制。
  * **异构提升解耦**：列表扩展 [MixedListExtension.ts](file:///Users/junior/Projects/slash/packages/js-editor-core/src/extensions/MixedListExtension.ts) 将空列表项退格时的“同异构提升与转换”解耦为独立的命令 `safeLiftListItem`，避免直接对 PM 核心的 `liftListItem` 源码进行破坏性 hack，架构更加优雅、可维护。

---

## 2. ProseMirror 事务的原子性与安全性设计

### 2.1 选区映射与 Transaction 防崩溃 (防 RangeError 机制)
* **技术原理**：ProseMirror 中的 Transaction (`tr`) 是修改文档状态的唯一原子管道。然而，`tr` 中的修改是非幂等的且具有时序累积性。一旦在 `tr` 中执行了 `tr.delete()` 或 `tr.insert()` 等修改文档节点结构的操作后，文档的绝对尺寸和所有未决节点的绝对偏移位置均已发生了实质性改变。此时如果继续使用修改前从旧状态导出的 `ResolvedPos`（如旧的 `$from`）去定位、选取或插入文字，便会 100% 触发严重崩溃，控制台报错：
  `RangeError: Position out of range` 或 `RangeError: No cell with offset...`
* **案例分析与修复方案**：
  - 在原版 `CustomBlockquote.ts` 输入规则中，由于在 `tr.delete(range.from, range.to)` 修改文档之后，直接以未映射的旧 `$from.before(1)` 替换节点，触发了严重崩溃。
  - **修复后设计 (Bug 14 重构)**：放弃了复杂的 Tiptap 链式 `.toggleBlockquote()` 操作，改为直接在 inputRule 中计算当前空段落的起止坐标 `start = $from.before(1)` 和 `end = $from.after(1)`。在单次 `tr.replaceWith` 原子事务中，直接将该空段落整行替换为包含单个空段落（引号完全由 CSS 伪元素前后包裹）的 `blockquote` 节点。
  - **绝对定位防护**：替换完成后，通过 `start + 2` 绝对选区计算，将光标精准定位到唯一空段落的行首。通过在 CSS 中引入针对空引用段落 `p.is-empty` 的伪元素绝对定位（`position: absolute`）夹持定位方案，使得前、后引号脱离 `<br>` 换行流的物理折行约束，在视觉上完美实现了 `｜“|”` 的 1 行结构。一旦用户录入文字，自动失效并无缝回退为常规的行内流式引号排版。配合防抖 `undefined` 返回拦截，杜绝了重入、折行与重复双引号。
  * **Bug 20b 表格列手柄 RangeError 崩溃**：当删除最边缘列时，旧的手柄坐标获取函数依然引用 React Props 传入的旧 `node` 去计算偏移，由于 React 状态渲染异步滞后于 PM 事务派发，使得点击瞬间坐标已被删除，触发越界 RangeError。
    * **加固后架构**：在 `TableNodeView.tsx` 中，不再信任 React props 中的旧 node，改由通过事务中的当前文档 `doc.nodeAt(startPos)` 动态拉取最新的 table 节点，再根据最新的 table 节点重新通过 `TableMap` 计算行列映射，彻底杜绝了边界 RangeError。
  * **Bug 13 嵌套列表提升崩溃**：
    * **加固后架构**：在 `safeLiftListItem` 转换并提升异构项时，由于提升操作（`liftListItem`）会瞬间改变缩进层级和选区，我们先使用 `chain().command` 原子事务修改当前类型并重置选区为映射后的 `mappedStart + relativeOffset`，然后再执行 `liftListItem`，并在最终提升完毕后再进行一次安全的选区重映射。这确保了不论列表深度如何嵌套，光标永不丢失，事务具备最高等级的原子安全性。

### 2.2 行内退格重绘与 WebKit Caret 阴影消除架构
* **技术原理**：由于 Chrome 和 WebKit (Tauri macOS 的底层渲染引擎 WebKit/Safari) 的排编引擎在处理 `ContentEditable` 的 Mark 边界节点删除时，经常出现 caret 视图缓存残影的问题（即底色底板删除了，但光标残影或灰色背景残存）。
* **架构设计**：
  * 在 [CustomInlineCode.ts](file:///Users/junior/Projects/slash/packages/js-editor-core/src/extensions/CustomInlineCode.ts) 的 `Backspace` 拦截器中，在成功处理退格删除并降级为纯文本后，并不立即完成，而是分发一个 `queueMicrotask` 异步微任务。
  * 在微任务里执行：
    ```typescript
    queueMicrotask(() => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0).cloneRange();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });
    ```
  * 这强迫 WebKit 排版引擎在当前 DOM 宏任务操作全部落盘并生效之后，对原生选区（Caret Selection）进行一次强制的主动重绘，清空显卡/渲染引擎的 Caret 伪状态缓存，彻底根治了高频行内退格产生的残影。

---

## 3. WikiLink 双链落盘后端架构与数据库一致性

### 3.1 级联扫描与关系合并设计 (Scanner Core)
在 `apps/desktop/src-tauri/src/core/db/repository/scanner.rs` 的 `scan_and_upsert` 中，双链解析落盘具有清晰的数据管线：

```mermaid
graph TD
    A[Markdown 文件修改] --> B[FS Watcher / 显式保存触发]
    B --> C[调用 scan_file]
    C --> D[parse_frontmatter 解析 relations]
    C --> E[extract_links 正则匹配 [[WikiLink]] 集合]
    E --> F[合并 YAML relations 到 Links 标签]
    F --> G[进入数据库事务: BEGIN IMMEDIATE]
    G --> H[upsert_note 更新 notes 表]
    G --> I[delete_links_for_source 清空旧 links 记录]
    G --> J[insert_links 写入最新 links 表]
    J --> K[COMMIT 提交事务]
    H -.->|抛出错误| L[ROLLBACK 事务回滚]
    I -.->|抛出错误| L
    J -.->|抛出错误| L
    D -.->|清理 relations 孤儿| M[重写 .md 文件 Frontmatter]
```

### 3.2 事务安全设计 (SQLite RAII Safety)
* **并发写入防护与锁机制**：
  由于本地文件系统发生变化（由 Watcher 监听）与 SQLite 数据库更新之间是异步且高频并发发生的。在有大量文件导入或高频自动保存时，极易产生不同线程并发向数据库同一条目写数据的竞态冲突。
  * **BEGIN IMMEDIATE**：在 `scan_and_upsert` 中，不使用默认的 `BEGIN`（延迟锁），而是显式启动 `BEGIN IMMEDIATE` 排他性锁。这能立刻阻止其他线程获取数据库的写连接，从而防止在多文件 Watcher 事件并发触发时发生 SQLite 数据库死锁（`database is locked`）或脏写风险。
  * **RAII 事务管理器与闭包回滚**：通过 Rust 的 RAII 特性，定义一个内部匿名闭包 `tx_result`。所有的数据库子事务操作（`upsert_note`、`delete_links_for_source`、`insert_links`）被封装在闭包内，如果闭包内任何一个操作返回了错误（如解析错误、外键约束报错等），事务会自动中断，并显式执行 `ROLLBACK`（回滚）。这保障了物理 Markdown 文件与其在 SQLite `links` / `notes` 表中的元数据具有物理意义上的绝对强一致性。

### 3.3 链接数据物理外键级联销毁设计
* **表 schema 的强一致设计**：
  在 `schema.sql` 中，`links` 表通过外键约束与 `notes` 表进行强物理绑定：
  ```sql
  FOREIGN KEY(source_path) REFERENCES notes(path) ON DELETE CASCADE
  ```
  * 当用户在侧边栏或物理目录中删除一篇笔记，或在同步下发删除操作时，`notes` 表对应的物理记录被清空。
  * 数据库底层的 `ON DELETE CASCADE` 引擎会自动、立刻、干净地清空 `links` 表中所有以该笔记为 `source_path` 的关联关系。
  * 之后，再由 Watcher 触发针对 target 端的局部图谱更新，完美保证了数据库中不会残存任何没有出处的“孤儿链接（Orphaned Links）”，架构完整度极高。
