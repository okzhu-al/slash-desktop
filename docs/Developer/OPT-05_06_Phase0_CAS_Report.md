# OPT-05/06 阶段零：CAS 内容寻址存储改造报告

## 改造概述
根据架构师 `OPT-05_06_Phase0_CAS_Instruction.md` 指令，已完成本地存储模块向 CAS（Content-Addressable Storage）的彻底改造。此次改造消除了基于原始文件名落盘所引发的幻影覆盖风险与同步污染。

## 详细改动

**1. 核心存储逻辑改造 (`apps/desktop/src-tauri/src/commands/assets.rs`)**
- 修改 `save_asset` 函数：弃用了基于 `original_name` 或当前时间戳生成文件名的旧逻辑，完全改为使用已计算的 `file_hash`（SHA-256）配合原扩展名作为新文件名 (`{hash}.{ext}`)。
- 修改 `save_asset_from_path` 函数：改用哈希作为目标文件名。并引入了 CAS 天然的幂等性校验：如果目标文件路径已经存在，则认为文件内容完全一致，直接更新内存索引并返回 `is_duplicate: true`，避免了多余的 I/O 写入开销。
- 移除了废弃的辅助函数 `get_unique_filename`：因为 SHA-256 哈希天然防碰撞，不再需要基于原始文件名进行后缀递增（如 `_1`, `_2` 等）。
- 删除了废弃的包导入 `chrono::Local`。

**2. 闭包解析逻辑兼容确认 (`apps/desktop/src-tauri/src/commands/sync/helpers.rs`)**
- 经过核查，`extract_asset_refs` 中的正则表达式逻辑（捕获 `assets/` 后面的所有非空白字符）天然兼容新的哈希文件名。
- `slash_sync_proto::AssetRef` 生成中的 `asset_id` 值自然变为 `{hash}.{ext}`，并且在未修改协议定义的情况下自动满足同步契约。

## 验证与验收
- `cargo check -p slash` 通过，无新警告。
- 协议及外部系统（服务端 push/pull）无须修改，实现平滑替换。
