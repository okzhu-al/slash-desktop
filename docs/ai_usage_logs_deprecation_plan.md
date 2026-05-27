# AI Usage Log 模块底层移除计划

## 1. 移除背景与理由 (Why)
在目前的架构中，所有的底层操作报错和执行耗时实际上已经能通过统一的终端系统日志与“导出诊断报告（Export Diagnostics）”被有效地收集。这就使得原先专门设计的带 UI 展现的 `AI Usage Log`（AI 用量日志）功能显得非常鸡肋与冗余。
废弃并彻底从底层清空这套自定义日志方案能够带来以下收益：
- **消减数据库的单点性能开销**：原有的方案要求无论是生成摘要、提取标签，成功还是失败，都要往本地 SQLite `ai_usage_logs` 表里高频并发排队写入。取消后可以直接给 Heavy Queue 解绑不必要的数据库 I/O 动作。
- **让 `ai_metadata` 处理更原子化**：废弃了这套“中间状态”维护流程，在未来的代码理解和逻辑追踪中将变得更容易，也不用再担心外键和孤儿数据。
- **减少前端与 Tauri 后端间的通讯体量**：减轻前后端上下文及内存的负担。

---

## 2. 数据库安全迁移计划 (How - Database)
不能简单粗暴地直接在代码中注释掉建表语句，防止影响已经升级的旧库用户。在**接下来的下一次数据库升版 (例如 V33)** 时，应在 `manager.rs` 的 migration 数组中强制执行 DROP 指令。

**操作动作**：
在未来的 SQLite 数据库 Migration 执行脚本中新增：
```sql
DROP TABLE IF EXISTS ai_usage_logs;
```
同时从 `init_db` 的标准建库 SQL 初始化脚本中删除对应 `CREATE TABLE ai_usage_logs...` 的相关片段，保证后续全新安装的用户不再创建这个幽灵表。

---

## 3. 后端 Rust 重点拆除点 (How - Codebase)

在下发 `DROP` 迁移行文并重构系统时，应当以串根的形式彻底拔除下列代码：

| 彻底删除的文件或模块坐标 | 作用描述与操作动作 |
| :--- | :--- |
| **`core/db/repository/usage.rs`** | 这是真正操控写入用量表的核心层。可以直接删除该文件，并从 `mod.rs` 中取消 `pub use usage::*;` 的导出声明。 |
| **`commands/ai/usage.rs`** | 这是负责把数据吐给前端供表格读取的 Tauri 宏绑定层。整个模块全盘删除。 |
| **`src-tauri/src/lib.rs`** | 在插件配置和调度中心内，解绑注册在 `Builder...invoke_handler` 上的预留路由 `commands::ai::get_ai_usage_logs` 等衍生宏指令。 |
| **`commands/ai/orchestrator.rs` 与 `service.rs`** | 目前 AI 执行的核心队列里，一定还在底层调用 `log_ai_usage()` 或 `repository::log_ai_usage(...)`进行日志塞入。需要通过全局搜索把所有挂载了日志上线的断点彻底删除掉。 |
| **`core/db/manager.rs`** | 除了添加版本升级带来的 `DROP TABLE` migration 外，还需要清理在初始化阶段的旧版本创建语句。 |

> **执行建议：**
> 在正式执行这些大规模“文件级”清理时，建议单独开辟一条名为 `chore/deprecate-ai-usage-logs` 的 Git 独立分支，并确保移除以上 Rust 代码后不仅可以通过 `cargo check` 的编译，还要确认新的 Migration 号下发后应用能够正常平滑挂载旧版数据库。
