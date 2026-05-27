# OPT-05/06 阶段一：动态治理体系改造 — 研发执行报告

> **执行**: 研发工程师  
> **日期**: 2026-04-27  
> **相关指令**: `OPT-05_06_Phase1_Governance_Instruction.md`

## 一、改造情况概述

阶段一（Phase 1）的动态治理体系改造（前端拦截与展示、Desktop Rust 持久化集成、Server Negotiate API 提供）已全面落地。系统目前已经成功地从原本硬编码的 `50MB` 文件同步限制，过渡为以服务端数据库配置为主、前端与 Tauri 客户端智能响应拦截的动态协商治理体系。

所有的硬编码均已替换为动态下发机制，并做好了 `50MB` 回退降级保护，同时保证了向后的协议兼容性。

## 二、架构及代码落地点

### 1. 服务端配置体系 (Server Layer)
- **API 提供**: 新增 `GET /api/team/settings` 和 `PUT /api/team/settings`，支持具有 Admin 权限的管理员查询和配置空间范围内的文件大小限制，数据持久化到 PostgreSQL 的 `server_settings` 表。
- **协议握手下发**: `negotiate` 同步协商流在生成 `SyncNegotiateResponse` 时，读取 DB 提取配置并塞入 `server_capabilities.max_sync_file_size` 字段。
- **协议兼容**: 在 `slash-sync-proto` 中采用 `Option<ServerCapabilities>`，加上 `serde(default, skip_serializing_if)` ，确保旧版客户端通讯不雪崩。

### 2. 桌面客户端 Rust 层 (Desktop Core Layer)
- **全局状态缓存**: 注册了 `SyncCapabilitiesState` 作为 Tauri Managed State。
- **动态缓存更新**: 改造了 `sync_team_full` 和 `sync_vault` 生命周期，在接收到 `negotiate` 的 `server_capabilities` 后立即存入上述内存状态，确保最新配置全系统共享。
- **硬编码清理**: 将原本写死在 `packages/slash-core` 的常量重命名为 `TEAM_ASSET_MAX_SIZE_DEFAULT`。
- **推送扫描 (Promote & Team Sync)**: `push_directory_to_vault` 等函数不再依赖常量，而是改为读取 `SyncCapabilitiesState` 中保存的动态上限（附带 50MB 降级容错）。

### 3. 前端交互与管理层 (Frontend Layer)
- **前端状态代理 (`capabilities.ts`)**: 引入前端级别的缓存封装 `getMaxSyncFileSize`，调用底层 `invoke('get_sync_capabilities')` 并处理 fallback 机制，保证同步拦截无明显延迟。
- **拖拽与粘贴阻断 (`clipboardHandlers.ts`)**: 文件上传的 `file.size` 验证逻辑全面替换为动态下发值，直接在引入节点处截断超大文件，避免无谓的磁盘写入及后台卡顿。
- **管理界面 (`TeamManagePage.tsx`)**: 在"成员管理"配置视图下新增 **空间设置** 卡片，允许拥有 Admin 权限的用户直接设置单文件体积上限（上限扩充至 10GB），更改后一键刷新前端与服务端缓存。
- **i18n 动态化**: 将以往写死 `50MB` 的提示信息统一改为 `{{limit}}` 占位符结构，现在能智能提示 "此文件超出团队空间 200MB 大小限制" 这类根据实际能力定制的信息。

## 三、验收与质量保证

1. **编译检查**: `cargo check -p slash` 和前端 `npm run typecheck` 均 0 Error 通过。
2. **逻辑异常修复**: 成功清理由于 Rust Option 传值及依赖变更所产生的 Type Mismatch 错误。
3. **安全与容错**: 前端断网 / Tauri API 未暴露 / 旧版 Server 的等边界异常情形均已由默认的 `TEAM_ASSET_MAX_SIZE_DEFAULT (50MB)` 保底。个人空间则完全不受该逻辑影响。

## 四、后续建议

目前动态治理的第一阶段前端和协议栈改造已经成熟。后续可继续跟进多设备文件传输的流式重构，或者在此协议基础上，下发更多的团队资源管治策略（如团队成员总存储配额等）。
