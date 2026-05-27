# Slash AI 模块开发与运维交底文档 (AI Module Handover Guide)

## 1. 架构总览
Slash 的 AI 模块是一个**端到端、本地优先的智能处理流水线**。不仅支持各大云端语言模型（OpenAI/Anthropic 等），更核心的是深度集成了本地 Ollama 模型，主打隐私安全和离线可用。

整个 AI 工作流被拆分为三个核心层：
- **前端调度层 (TypeScript/Pinia)**：负责用户交互、多任务队列统筹、流式输出接收与降级重试。
- **后端中枢层 (Rust/Tauri)**：负责封装底层数据库连接、并发队列（`HeavyQueue`）、调用服务网关（Service Gateway）。
- **底层基础设施层 (Rust/SQLite)**：负责 Prompt 构建、文本截断、向量化（Embeddings），以及 AI 衍生元数据（标题、摘要、标签）的原子化持久存储。

---

## 2. 核心执行周期与并发模型

### 2.1 重负载队列 (`HeavyQueue`)
为了防止高资源消耗任务（如本地 LLM 生成、长文本向量化）阻塞主 UI 线程，几乎所有非流式、不需要实时展示给用户的 AI 任务都被压入 `HeavyQueue` 单线程原子队列。

**关键规则**：
- 队列中的任务是**严格按需串行**（Serialize）执行的，且自带基础的去重或节流逻辑。
- 任务包括：**摘要提取 (Summarization)**、**标签生成 (Tagging)**、**智能重命名 (Smart Rename)** 和 **向量化嵌入 (Embedding)**。

### 2.2 离线存储防崩指南：SQLite 与 FTS 陷阱
升级与后期运维中最容易出事的地方是**状态持久化和 SQLite 并发写锁**，请后继开发者牢记以下两条“血泪教训”：

#### ⚠️ 避雷 1. SQLite FTS5 的 "UPSERT" 致命触发器
**背景**：
在以往的插入逻辑中，开发者通常习惯用 `INSERT ... ON CONFLICT DO UPDATE` (Upsert) 来更新 AI 结果。
**隐患**：
SQLite 内部在处理 `UPSERT` 时，无论冲不冲突都会强制触发一次该表的 `BEFORE INSERT` 和 `BEFORE UPDATE` 触发器。我们的 FTS5（全文搜索引擎）阴影表重度依赖这些触发器。一旦双重触发，就会导致 FTS 内部索引错乱，直接抛出灾难性的 `database disk image is malformed`！
**运维准则**：
> **严禁对任何挂载了全文索引触发器的表使用 `UPSERT`。**
> 对于 `ai_metadata` 和相关表，必须一律改用**“先 UPDATE，受影响行数为 0 则 fallback 到 INSERT”**的标准原子写法（详见 `orchestrator.rs` 中 `process_heavy_summary` 函数的代码规范）。

#### ⚠️ 避雷 2. 幽灵并发：系统文件监听器 (File Watcher) 与 AI 的竞态条件
**背景**：
当运行 `Smart Rename` 时，除了数据库要改名，操作系统底层的物理文件也要被 `std::fs::rename` 重命名。
**隐患**：
如果您先调用 `std::fs::rename`，操作系统会立刻派发一个超低延迟的 `FS Event`。后端的 `file_watcher` 线程拿到事件后，会以为旧笔记**“被用户删除了”**，顺手就把旧笔记从数据库里给扬了——而此时 `ai_metadata` 表因为外键级联删除 (`ON DELETE CASCADE`) 的缘故，前置生成的摘要、标签也会跟着瞬间灰飞烟灭！由于时差极小，常规 Debug 极难追踪。
**运维准则**：
> 凡是跟文件路径挂钩的 AI 文件 I/O 操作，**必须将本地 I/O (如重命名) 包裹在数据库独占事务 (`with_connection`) 内部**！
> 最佳实践是：先在 DB 里篡改旧路径 -> 攥着 DB 锁去执行 `fs::rename` -> 然后立即写入新 metadata -> 最后释放 DB 锁。
> 这样可以强行阻塞 File Watcher 的监听进程，避免脏数据和级联误删。

---

## 3. 重要模块与文件坐标
未来的功能迭代，您可以直接前往以下坐标：

| 目录/文件路径 | 核心功能职责 |
| :--- | :--- |
| **`core/ai/service.rs`** | 统一大语言模型网关。封装了 OpenAI、Anthropic 接口调用及 Ollama 适配，控制流式输出和 Timeout 断路器。新增模型时在这加。 |
| **`commands/ai/orchestrator.rs`** | AI 编排器。统筹上述提到的所有 Heavy Job（生成摘要、打标、自动命名）。数据库防抖、原子化的核心发源地。 |
| **`core/ai/input_strategy.rs`** | 提示词（Prompt）工程与拼接逻辑。这里包含了 `ContextChunking`, `TokenEstimation` 以及为保证中文质量特别定做的系统级提示（System Prompt）。 |
| **`core/db/repository/notes.rs`** | 与 AI 高度耦合的核心表驱动（增删查改）。其中的重命名和写入均需仔细审视外键关联。 |
| **前端 `AutoSyncManager.ts`** | 把控前端文档编辑频率与调用后台 AI 压缩队列的核心防抖策略控制器。 |

## 4. 后续性能优化建议 (Next-Steps)

1. **向量检索（Embedding）平滑升级**
   目前 Embeddings 获取采用批量单线程限流策略。未来可切换为按 CPU 核心数隔离出独立的 Vector-DB Worker，以减少大批量导入时的锁等待时间。
2. **多模态扩展的护栏**
   如果要让模型直接处理图像上下文，记得使用 `blob` 数据而非直接把高解析度 Base64 塞进现成的 FTS 或 AI 状态表里（很容易让单条记录超标导致内存爆表）。需要建立隔离的 `ai_media_cache` 表。
3. **更智能的重做策略 (Retry)**
   当前 `ai_skill_state` 作为执行状态总表，已基本记录了文本 `hash` 及 `timestamp`。后续可以在前端开发“一键重新生成元数据大盘”，去扫描库中处于 `failed` 或未覆盖的数据行，批量重排进 Queue 中。

> **结束语**：此文档浓缩了 Slash AI 模块底层在极端并发条件下的防御哲学。后续开发不论是接新模型还是新引擎，**保证数据完整性、警惕 SQLite 的微秒级并发死角**都将永远排在第一位。
