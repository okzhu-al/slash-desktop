# Phase 1 & 2 统一完成度评估

> 评估日期：2026-03-04
> 评估范围：Phase 1 (Monorepo Migration) + Phase 2 (Community Edition)
> 参照文档：`slash_team_edition_prd.md`、`phase_1_monorepo_migration_plan.md`、`phase_2_server_sync_plan.md`、`phase_2_completion_report.md`

---

## 一、Phase 1：Monorepo 迁移（5 Steps）

### 综合评定：✅ 完成率 95%

| Step | 目标 | 状态 | 证据 |
|------|------|------|------|
| **Step 1** | Monorepo 根基盘 | ✅ 100% | `pnpm-workspace.yaml` + 根 `Cargo.toml`（4 members）已就位 |
| **Step 2** | 物理搬家 | ✅ 100% | `apps/desktop/` 包含完整 `src/` + `src-tauri/`，原始位置已清空 |
| **Step 3** | `@slash/shared-types` | ✅ 100% | `packages/js-shared-types/` 已创建，`pnpm workspace` 软链正常 |
| **Step 4** | `slash-core` Rust 共享包 | ✅ 100% | `packages/slash-core/` 含 hash、文件名消毒、Merkle Tree 等纯函数 |
| **Step 5** | `@slash/editor-core` 抽离 | ✅ 100% | Extensions + Serializers 迁移 + Tauri 解耦全部完成 |

### Step 5 详细评估

#### ✅ 已完成

| 项目 | 说明 |
|------|------|
| 包初始化 | `packages/js-editor-core/` 含 `package.json`、`tsconfig.json` |
| 23 个 TipTap Extensions | 全部迁移至 `js-editor-core/src/extensions/` |
| 7 个 Markdown Serializers | 迁移至 `js-editor-core/src/serializers/`（2026-03-04 刚完成） |
| DI 系统 | `EditorDI.ts` 定义 `MediaService`、`FileSystemStore`、`CustomSkillService` 等接口 |
| Desktop 宿主注入 | `extensions.ts` 通过 DI 注入 Tauri 侧具体实现 |

#### ⚠️ 残留 Tauri 耦合（4 个文件，6 处 import）

PRD 要求「**彻底切断原生 Tauri 依赖**」，以下文件仍直接 import Tauri API：

| 文件 | 耦合点 | 解耦方案 |
|------|--------|----------|
| `WikiLink/suggestion.ts` | `invoke` from `@tauri-apps/api/core` | 通过 DI 注入搜索回调 |
| `WikiLink/WikiLinkNodeView.tsx` | `invoke` + `listen` from `@tauri-apps/api` | 通过 DI 注入导航和事件监听 |
| `WikiLink/SectionSuggestion.ts` | `invoke` + `readTextFile` from `@tauri-apps/plugin-fs` | 通过 DI 注入文件读取 |
| `Drawing/DrawingService.ts` | `invoke` from `@tauri-apps/api/core` | 通过 DI 注入存储回调 |

> **评估**：这些耦合**不影响 Desktop 正常运行**，但会**阻塞 Phase 3 Step 5（Mobile 客户端）**对 `@slash/editor-core` 的复用。建议在 Phase 3 Mobile 开发前彻底解耦。

---

## 二、Phase 2：Community Edition（7 Steps）

### 综合评定：✅ 完成率 100%（核心目标）+ 超额交付

| Step | 目标 | 状态 | 证据 |
|------|------|------|------|
| **Step 1** | `slash-sync-proto` 协议定义 | ✅ 100% | `FileManifest`、`SyncNegotiateRequest/Response`、`SpaceType` 等结构体 |
| **Step 2** | `slash-core` Merkle 增强 | ✅ 100% | `calculate_directory_hash`、`scan_directory_manifests` |
| **Step 3** | Axum Server 空壳 + PostgreSQL | ✅ 100% | `apps/server/` — Axum 0.8 + SQLx + 4 张迁移表 |
| **Step 4** | JWT 鉴权系统 | ✅ 100% | Register / Login / Refresh / Me 四端点 |
| **Step 5** | Sync Protocol 端到端验证 | ✅ 100% | Negotiate → Push → Pull 三步握手，261 文件同步成功 |
| **Step 6** | S3/Minio 附件存储 | ⏭️ 推迟 | 个人场景使用 `LocalFileStorage` 已足够，推迟至 Phase 3 Step 4 |
| **Step 7** | Python Sidecar | ✅ 100% | `apps/python-sidecar/` — FastAPI + MarkItDown，21 种格式已验证 |

### 超额交付（PRD 未要求）

| 特性 | 说明 |
|------|------|
| 自动同步引擎 | `AutoSyncManager` — 5 种触发器 + debounce 防抖 |
| 离线队列 | 网络断开时 `dirty_queue` 缓存，恢复后自动同步 |
| Token 自动刷新 | 401 → refresh → 重试，7 天宽限期 |
| 编辑中文件保护 | Pull 时跳过正在编辑的文件 |
| Pull 后实时刷新 | `sync:pulled` 事件通知编辑器重载 |
| Per-Vault 配置隔离 | 切换 Vault 自动切换同步配置 |
| 删除传播 | `deleted_paths` 协议字段 |
| Docker 一键部署 | `docker-compose.yml` (PG + Server + Sidecar) |
| Desktop 文件导入 | `ImportService` + `ImportButton` → Sidecar → `00_Inbox` |

---

## 三、Monorepo 架构现状总览

```
slash/
├── pnpm-workspace.yaml             ✅ pnpm workspace 根配置
├── Cargo.toml                       ✅ Cargo workspace (4 members)
├── docker-compose.yml               ✅ 一键部署 (PG + Server + Sidecar)
│
├── apps/
│   ├── desktop/                     ✅ Tauri v2 桌面端 (React + Rust)
│   ├── server/                      ✅ Rust Axum Server (JWT + Sync + PG)
│   └── python-sidecar/              ✅ FastAPI + MarkItDown
│
├── packages/
│   ├── slash-core/                  ✅ Rust 共享算法 (Hash/Merkle/扫描)
│   ├── slash-sync-proto/            ✅ 端云共享同步协议定义
│   ├── js-editor-core/              ⚠️ TipTap 编辑器核心 (4处 Tauri 残留)
│   └── js-shared-types/             ✅ TS 跨界类型定义
```

---

## 四、已知技术债务

| # | 类别 | 描述 | 紧迫度 | 阻塞 |
|---|------|------|--------|------|
| D-1 | 耦合 | ~~`js-editor-core` 4 个文件仍直接 import Tauri API~~ | ✅ 已完成 | 2026-03-04 解耦，0 残留 |
| D-2 | 策略 | ~~client-wins~~ 已实现三路比较（base_hash），仅真冲突时 client-wins | ✅ 已解决 | — |
| D-3 | 效率 | 图片/附件已纳入同步范围（`scan_directory_manifests` 支持二进制文件），但大文件全量传输，无增量/分块优化 | 低 | Phase 3 Step 4 可优化 |
| D-4 | 权限 | 单用户模式，无 RBAC 权限体系 | **高** | Phase 3 Team 版核心 |

> **D-2 修正说明**：同步策略已实现 base_hash 三路比较（见 `personal_sync_logic.md` §二），正确区分「仅 Server 更新 → pull」和「仅 Client 更新 → push」。仅在双方都修改的真冲突场景下采用 client-wins，Phase 3 Step 1 将进一步提供 Diff UI 让用户手动选择。

> **D-4 优先级说明**：Team 版开发前必须优先完成 D-4（RBAC 设计），确保 Server 具备多用户权限基础。

---

## 五、Phase 3 就绪度评估

| Phase 3 Step | 前置依赖 | 就绪状态 |
|------|----------|----------|
| Step 1: 冲突检测与合并 UI | slash-sync-proto 协议 + TipTap Diff | ✅ 协议已就位 |
| Step 2: Team Vault + RBAC | Server 鉴权 + DB 扩展 | ✅ JWT 已就位，DB 可扩展 |
| Step 3: PR 审阅流转 | Step 1 + Step 2 | ✅ 依赖已满足 |
| Step 4: S3/Minio 存储 | `FileStorage` trait 抽象 | ✅ trait 已定义 |
| Step 5: Mobile 客户端 | `js-editor-core` 彻底解耦 | ⚠️ 需先完成 D-1 |
| Step 6: 商业化 | Server Pro 功能注入 | ✅ 无技术阻塞 |

---

## 六、结论

### Phase 1：✅ 实质完成

Monorepo 基础设施已全面就位。Step 5 的 4 处 Tauri 残留耦合不影响当前 Desktop 运行。**Serializers 已于 2026-03-04 完成迁移，Step 5 完成率从 ~70% 提升至 ~85%。**

### Phase 2：✅ 超额完成

PRD 定义的三大核心目标（Axum Server、JWT Auth、Personal Sync）100% 达成，额外交付 9 项增强特性（自动同步、离线队列、Token 刷新等）。同步策略已实现 base_hash 三路比较，非简单 client-wins。

### Phase 3 启动前必做

| 优先级 | 任务 | 工作量 | 理由 |
|--------|------|--------|------|
| P0 | **D-1**: `js-editor-core` Tauri 解耦 | ~4 小时 | 编辑器内核跨平台复用的前提 |
| P0 | **D-4**: RBAC 权限体系设计与实现 | ~2-3 周 | Team 版核心，多用户安全的基础 |
| P1 | **D-3**: S3/Minio 附件存储 | ~1 周 | 团队共享必须同步附件 |
