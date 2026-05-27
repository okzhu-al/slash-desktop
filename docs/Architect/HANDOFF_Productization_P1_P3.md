# Slash 产品化交接文档 — Agent Handoff

> **编制日期**: 2026-05-11
> **目的**: 向接手 Agent 完整交接项目现状、架构要点和待推进任务

---

## 一、项目概述

Slash 是一个跨平台（macOS / Windows / Linux）的本地优先笔记应用，技术栈为 **Tauri v2 (Rust) + React + TypeScript + TipTap**。核心特性包括：

- **PARA 知识管理体系**：Projects / Areas / Resources / Archives 四层分类
- **AI 引擎**：本地 Ollama 模型提供向量嵌入（`bge-m3`）+ 文本生成，可选在线 LLM（Gemini / OpenAI / DeepSeek 等）
- **GhostLink**：基于语义向量的隐式笔记关联发现
- **团队协作**：Server 端同步 + RBAC 权限 + 实时协作
- **Sidecar 文档引擎**：Python 进程（MarkItDown + faster-whisper），负责 PDF/Office/音视频 → Markdown 转换

---

## 二、仓库结构速览

```
/Users/junior/Projects/slash/
├── apps/
│   ├── desktop/                    # Tauri 桌面客户端
│   │   ├── src/                    # React + TypeScript 前端
│   │   │   ├── features/
│   │   │   │   ├── editor/         # TipTap 编辑器（含 EditorStatusBar）
│   │   │   │   ├── settings/       # 设置页（AITab.tsx 等）
│   │   │   │   ├── sidebar/        # 侧边栏（ImportHubModal.tsx 等）
│   │   │   │   └── ...
│   │   │   └── services/
│   │   │       └── ImportService.ts  # 调用 Sidecar 的前端服务
│   │   └── src-tauri/              # Rust 后端
│   │       └── src/
│   │           ├── lib.rs          # Tauri 应用入口 + Sidecar 启动
│   │           ├── core/
│   │           │   ├── sidecar.rs  # ⭐ Sidecar 进程管理器
│   │           │   ├── ai/         # AI 服务（service.rs, provider/, skills/）
│   │           │   ├── embedding/  # Embedding 管线（pipeline.rs, worker.rs, media_scheduler.rs）
│   │           │   └── db/         # SQLite 数据库（migrations, repository）
│   │           └── commands/
│   │               ├── ai/         # AI 相关 Tauri 命令
│   │               ├── embedding.rs # 媒体索引相关命令
│   │               └── ...
│   ├── python-sidecar/             # ⭐ Python Sidecar（MarkItDown + Whisper）
│   │   ├── app/main.py             # FastAPI 服务端（/parse, /health 等）
│   │   ├── build.py                # PyInstaller 打包脚本
│   │   ├── version.json            # 版本元数据
│   │   └── requirements.txt
│   └── server/                     # 同步服务端 (Rust/Actix-web + PostgreSQL)
└── docs/
    ├── Architect/                  # 架构师文档（指令、裁决、规范）
    └── Developer/                  # 开发报告（实施记录、测试报告）
```

---

## 三、已完成里程碑

### 3.1 团队协作（Team Edition）— 全量完成 ✅

- 35/35 测试用例全通过
- RBAC 权限体系（Owner / Admin / Editor / Observer）
- Promote 目录推送 + 多端同步传播
- 所有 P0-P3 Bug 已清零
- 详见 `docs/Architect/INDEX.md`

### 3.2 Asset 闭包同步（OPT-04）— 完成 ✅

- 笔记 → 媒体资产依赖图持久化（`file_assets` 表）
- 闭包式同步（推送/拉取笔记时自动携带关联资产）
- Storage Dashboard UI（存储用量可视化 + 安全清理工具）

### 3.3 内容寻址存储（OPT-05 Phase 0-3）— 完成 ✅

- CAS（Content-Addressable Storage）：asset 文件名 = 内容 hash
- Sidecar `/parse` 端点支持路径直读模式（`local_path`）
- 详见 `docs/Developer/OPT-05_06_Phase0_CAS_Report.md` ~ `Phase2_3_Report.md`

### 3.4 多媒体 AI 管线（OPT-05/06 Phase 4-6）— 完成 ✅

| 阶段 | 内容 | 报告 |
|:---|:---|:---|
| **Phase 4** | faster-whisper 离线转写替代 Google API | `OPT-05_06_Phase4_5_Report.md` |
| **Phase 5** | Embedding 融合媒体语义（正则扫描 → Sidecar 提取 → 向量化） | 同上 |
| **Phase 6** | `media_enrich_cache` 缓存去重 + `MediaScheduler` 手动触发 + EditorStatusBar UI | `OPT-06_Phase6_Report.md` |

### 3.5 Sidecar 本地化迁移 — 完成 ✅

**之前**：Sidecar 运行在 Docker 容器中，用户需安装 Docker Desktop  
**现在**：PyInstaller 打包为原生二进制，Tauri 自动管理子进程

关键改动：
- `apps/python-sidecar/build.py` — PyInstaller `--onedir` 打包脚本
- `apps/desktop/src-tauri/src/core/sidecar.rs` — 进程启动、stdout 端口发现、全局端口共享
- `apps/desktop/src/services/ImportService.ts` — 动态获取 Sidecar URL
- `apps/python-sidecar/version.json` — 版本元数据（已创建，检查逻辑待实现）

**架构**：
```
App 启动 → SidecarManager::start()
         → Command::new(binary).spawn()
         → stdout 监听 "SIDECAR_READY:{port}"
         → GLOBAL_SIDECAR_PORT 全局共享
         → pipeline.rs / ImportService.ts 通过 get_sidecar_base_url() 获取地址
```

---

## 四、AI 引擎架构要点

> [!IMPORTANT]
> **Embedding 强制本地化**：无论生成模型使用本地还是在线，**向量嵌入始终通过 Ollama `bge-m3` 运行**。这是核心架构约束，不可改动。

### 关键文件

| 文件 | 职责 |
|:---|:---|
| `core/ai/service.rs` | AI 服务路由：Generation 按 provider_type 分发；Embedding 始终走 Ollama |
| `core/ai/provider/ollama.rs` | Ollama 本地模型接口 |
| `core/ai/provider/openai_compatible.rs` | OpenAI 兼容 API 接口（Gemini/DeepSeek/OpenAI 等） |
| `commands/ai/provider_config.rs` | AI 配置持久化（provider_type, models, host, port） |
| `settings/AITab.tsx` | 设置页 AI 配置 UI（`FIXED_EMBEDDING_MODEL = 'bge-m3'` 不可修改） |
| `settings/hooks/useAiSettingsManager.ts` | AI 设置状态管理 Hook |

### 在线模型选择机制

- 在线 Provider 配置存储在 `online_providers` 表中（通过 `get_online_providers` / `save_online_provider` 命令读写）
- 每个 provider 有 `active: boolean` 标志，系统只使用 active 的那个
- **EditorStatusBar 和 ImportHubModal 的模型选择下拉框** 已修复为从 `get_online_providers` 读取 active provider 的真实 model（而非读取可能过时的 `provider_config`）

---

## 五、Sidecar 当前状态与缺口

### 已实现 ✅

| 功能 | 文件 |
|:---|:---|
| PyInstaller `--onedir` 打包 | `build.py` |
| 进程启动 + stdout 端口发现 | `sidecar.rs :: start()` |
| 全局端口共享（OnceLock） | `sidecar.rs :: GLOBAL_SIDECAR_PORT` |
| 三级路径搜索（App Support → bundle → dev） | `sidecar.rs :: find_sidecar_binary()` |
| 优雅关闭（Drop trait） | `sidecar.rs :: shutdown()` |
| 版本元数据文件 | `version.json` |

### 未实现 ❌（即 P1 工作）

| 缺口 | 说明 |
|:---|:---|
| **崩溃自动恢复** | `start()` 是一次性的，进程退出后无监控、无重启 |
| **安装包集成** | 未将 sidecar 目录嵌入 `.app` bundle，`cargo tauri build` 产物不含 sidecar |
| **版本检查** | `version.json` 已有字段但无启动时兼容性检查逻辑 |
| **Whisper 模型管理** | 预装 tiny 模型，但无 UI 切换/下载更大模型 |
| **CI/CD** | 无 GitHub Actions 多平台构建流水线 |
| **健康检查** | Python 侧无 `/health` 端点，Rust 侧无探活逻辑 |

---

## 六、P1 → P3 待推进任务

### P1 — 上线阻断项（Must Have）

#### P1-1：Sidecar 安装分发与版本管理
- `sidecar.rs`：启动时若 App Support 无 sidecar，从 bundle 拷贝；读取 `version.json` 校验兼容性
- `tauri.conf.json`：配置 `externalBin` 嵌入 sidecar 目录到 `.app`
- `build.py`：适配 CI 输出路径

#### P1-2：Sidecar 崩溃自动恢复
- `sidecar.rs`：新增 `watchdog` 线程 — 检测子进程退出 → 自动重启（最多 3 次，间隔递增）
- `main.py`：添加 `GET /health` → `{"status": "ok"}` 端点
- `sidecar.rs`：定期调用 `/health` 探活

#### P1-3：Whisper 模型管理 UI
- 设置页新增 Whisper 模型区域（tiny/small/medium 选择 + 下载进度）
- `main.py`：新增 `/whisper/models`（列表）+ `/whisper/download`（下载）端点
- 支持动态切换模型

#### P1-4：CI/CD 多平台 Sidecar 打包
- `.github/workflows/build-sidecar.yml`：矩阵构建 macOS (arm64/x86_64) + Windows + Linux
- 与 Tauri build 流水线集成

### P2 — 体验增强（Should Have）

| 编号 | 任务 | 基建状态 |
|:---|:---|:---|
| P2-1 | 图片悬浮预览（hover 显示 AI 提取文本） | `get_enriched_content` 命令已就绪 |
| P2-2 | 媒体索引进度细粒度反馈（"1/3" 而非 "索引中..."） | 需 Tauri event emit |
| P2-3 | Sidecar 热更新（独立于主应用更新） | `version.json` 已定义字段 |
| P2-4 | macOS 代码签名（Gatekeeper 验证） | 需 Apple Developer Program |

### P3 — 技术债务（Nice to Have）

| 编号 | 任务 |
|:---|:---|
| P3-1 | Worker 并发保护（processing_lock） |
| P3-2 | media_enrich_cache 失效策略（模型升级时清除旧缓存） |
| P3-3 | skills.rs 路径统一 conn 传递（消除无缓存降级） |
| P3-4 | negotiate.rs 模块化拆分（740+ 行 → 按域拆分） |
| P3-5 | GhostLink 精度优化（TF-IDF 加权、阈值调优） |

---

## 七、开发环境与常用命令

```bash
# 仓库根目录
cd /Users/junior/Projects/slash

# Rust 编译检查
cd apps/desktop/src-tauri && cargo check

# 开发模式启动（前端 + 后端 + Sidecar）
cd apps/desktop && npm run tauri dev

# Sidecar 独立构建
cd apps/python-sidecar && python build.py

# Sidecar 输出位置（PyInstaller --onedir）
# apps/python-sidecar/dist/slash-sidecar-{target}/slash-sidecar-{target}
# 构建后自动拷贝到 apps/desktop/src-tauri/binaries/

# TypeScript 类型检查
cd apps/desktop && npx tsc --noEmit

# 生产构建（包含安装包）
cd apps/desktop && npm run tauri build
```

---

## 八、关键约束与雷区

> [!CAUTION]
> 以下是之前踩过的坑，务必遵守。

1. **Embedding 模型不可动态化**：`bge-m3` 是硬编码的向量模型，不跟随在线 provider 切换。设置页 UI 显示为只读固定值。
2. **`rusqlite::Connection` 不是 Send**：在 async 上下文中不能跨 `.await` 持有 `MutexGuard<Connection>`。需要用 `std::thread::spawn` + 独立 tokio Runtime。
3. **EditorStatusBar 有两处 model select**：一处用于有 media_pending 的状态，一处用于媒体已索引的重新提取。两处都需要保持一致。
4. **macOS 路径大小写不敏感**：路径比较必须经过 case-insensitive normalization。
5. **Sidecar 端口是动态的**：通过 stdout `SIDECAR_READY:{port}` 发现，不要硬编码端口号。Fallback 到 `localhost:3722` 仅为向后兼容。

---

## 九、参考文档索引

| 文档 | 路径 | 说明 |
|:---|:---|:---|
| 架构师文档总索引 | `docs/Architect/INDEX.md` | 全部 Bug/OPT 修复索引 |
| OPT-06 Phase 6 报告 | `docs/Developer/OPT-06_Phase6_Report.md` | 媒体 Embedding 架构最新状态 |
| Phase 4+5 报告 | `docs/Developer/OPT-05_06_Phase4_5_Report.md` | 离线转写 + 语义织网 |
| Phase 4+5 架构指令 | `docs/Architect/OPT-05_06_Phase4_5_MediaAI_Instruction.md` | 架构师原始设计指令 |
| Sidecar README | `apps/python-sidecar/README.md` | Sidecar 使用说明 |

---

## 十、建议启动顺序

**推荐从 P1-2（崩溃恢复）开始**，因为：
1. 改动集中在单个文件（`sidecar.rs` + `main.py`），风险最低
2. 是所有后续 P1 任务的基础（安装分发和热更新都依赖可靠的进程管理）
3. 可立即端到端验证（`kill -9` 测试）

```
P1-2（崩溃恢复）→ P1-1（安装分发）→ P1-4（CI/CD）→ P1-3（Whisper UI）
```
