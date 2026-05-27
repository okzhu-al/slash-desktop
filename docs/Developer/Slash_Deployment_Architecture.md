# Slash 部署架构计划

> **版本**: v1.0  
> **日期**: 2026-05-04  
> **原则**: 用户零配置、开发者少维护、架构分层清晰

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    Slash Desktop (DMG)                       │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │   Tauri 主进程        │  │  Python Sidecar (PyInstaller)│ │
│  │   (Rust + WebView)   │  │  ┌────────────┐ ┌──────────┐│ │
│  │                      │  │  │ MarkItDown │ │ Whisper  ││ │
│  │  • 编辑器            │──│  │ (文档解析)  │ │ (音视频) ││ │
│  │  • AI 引擎 (Ollama)  │  │  └────────────┘ └──────────┘│ │
│  │  • 本地存储 (SQLite)  │  │  localhost:3722             │ │
│  │  • 同步客户端         │  └──────────────────────────────┘ │
│  └──────────┬───────────┘                                   │
└─────────────┼───────────────────────────────────────────────┘
              │ HTTPS (可选)
┌─────────────▼───────────────────────────────────────────────┐
│                 Slash Server (Docker Compose)                │
│  ┌──────────────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  slash-server (Rust) │  │  PostgreSQL   │  │ S3/MinIO  │ │
│  │  • 同步协议           │  │  • 用户/团队  │  │ • 资产存储│ │
│  │  • 团队 RBAC          │  │  • 文件状态   │  │           │ │
│  │  • 邀请码管理         │  │              │  │           │ │
│  │  端口: 3721           │  │  端口: 5432   │  │ 端口: 9000│ │
│  └──────────────────────┘  └──────────────┘  └───────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**两个独立分发单元**:

| 分发物 | 内容 | 适用场景 |
|--------|------|----------|
| **Desktop DMG** | Tauri 主程序 + Python Sidecar 二进制 | 所有用户（单机即可用） |
| **Server Docker** | slash-server + PostgreSQL + S3 | 需要同步/团队协作时部署 |

---

## 二、Desktop 分发

### 2.1 目标

用户下载一个 DMG，双击安装，打开即用。无需安装 Python、pip、Ollama 等任何前置依赖。

### 2.2 最终产物结构

```
Slash.app/
  Contents/
    MacOS/
      slash                     ← Tauri 主程序 (~19 MB)
      slash-sidecar             ← PyInstaller 打包的 Python 服务
    Resources/
      _internal/                ← PyInstaller 运行时（Python 解释器 + 依赖库）
    Info.plist
```

### 2.3 Python Sidecar 打包

**工具**: PyInstaller (--onefile 或 --onedir)

**打包命令**:
```bash
cd apps/python-sidecar
pyinstaller --name slash-sidecar \
  --onedir \
  --hidden-import markitdown \
  --hidden-import faster_whisper \
  --hidden-import uvicorn \
  --hidden-import fastapi \
  --collect-all markitdown \
  --collect-all faster_whisper \
  app/main.py
```

**推荐 `--onedir` 而非 `--onefile`**:
- `--onefile` 每次启动需解压到临时目录，首次启动慢 3-5 秒
- `--onedir` 直接从 `_internal/` 加载，启动速度接近原生

**预计体积**:
- PyInstaller 输出 (未压缩): ~200-250 MB
- DMG 压缩后: ~80-120 MB（整体 DMG 含 Tauri ~100-130 MB）

### 2.4 Tauri Sidecar 生命周期管理

**配置** (`tauri.conf.json`):
```json
{
  "bundle": {
    "externalBin": ["binaries/slash-sidecar"]
  }
}
```

**Rust 启动代码** (在 `lib.rs` 的 `setup` 中):
```rust
// 启动 sidecar
let sidecar = app.shell()
    .sidecar("slash-sidecar")
    .expect("failed to create sidecar command")
    .spawn()
    .expect("failed to spawn sidecar");

// 存储句柄以便退出时清理
app.manage(SidecarState(Mutex::new(Some(sidecar))));
```

**退出清理**: Tauri 退出事件中 kill sidecar 进程。

**健康检查**: 前端调用 ImportHub 前检测 `localhost:3722/health`，失败时显示"解析服务启动中"而非报错。

### 2.5 离线能力矩阵

| 功能 | 无 Server | 无 Ollama | 无网络 |
|------|-----------|-----------|--------|
| Markdown 编辑 | ✅ | ✅ | ✅ |
| 本地搜索 (FTS5) | ✅ | ✅ | ✅ |
| ImportHub (PDF/Word) | ✅ | ✅ | ✅ |
| 音视频转写 (Whisper) | ✅ | ✅ | ✅ |
| AI 摘要/标签/分类 | ✅ | ❌ | ❌¹ |
| 语义搜索 (Embedding) | ✅ | ❌ | ❌¹ |
| GhostLink 推荐 | ✅ | ❌ | ❌¹ |
| 图片 AI 描述 (Vision) | ✅ | ❌ | ❌¹ |
| 云同步 | ❌ | ✅ | ❌ |
| 团队协作 | ❌ | ✅ | ❌ |

> ¹ 如果使用本地 Ollama 可在无网络下工作；使用在线 API (OpenAI/Deepseek) 需联网。

---

## 三、Server 分发

### 3.1 目标

一条 `docker compose up -d` 命令启动全部服务。

### 3.2 Docker Compose

```yaml
# docker-compose.yml
version: "3.8"

services:
  # ── Slash Sync Server ──
  slash-server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    ports:
      - "3721:3721"
    environment:
      - DATABASE_URL=postgres://slash:${DB_PASSWORD}@postgres:5432/slash
      - STORAGE_BACKEND=s3
      - S3_ENDPOINT_URL=http://minio:9000
      - S3_BUCKET=slash-storage
      - S3_REGION=us-east-1
      - AWS_ACCESS_KEY_ID=${MINIO_ROOT_USER}
      - AWS_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD}
      - RUST_LOG=info
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  # ── PostgreSQL ──
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: slash
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: slash
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U slash"]
      interval: 5s
      retries: 5
    restart: unless-stopped

  # ── MinIO (S3 兼容存储) ──
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - s3data:/data
    restart: unless-stopped

volumes:
  pgdata:
  s3data:
```

### 3.3 环境变量

```bash
# .env
DB_PASSWORD=your_secure_password
MINIO_ROOT_USER=slash-admin
MINIO_ROOT_PASSWORD=your_secure_s3_key
S3_BUCKET=slash-storage
S3_REGION=us-east-1
```

### 3.4 Server 不包含 Python Sidecar

MarkItDown 和 Whisper **仅在 Desktop 端**运行，Server 端不需要。原因：

1. 文档解析和音视频转写是**用户本地操作**，数据不离开用户电脑
2. 同步只传输 Markdown 文本和资产文件，不传原始 PDF/Word
3. 避免 Server 端承担计算压力

---

## 四、构建 & CI 流水线

### 4.1 Desktop 构建流程

```
Step 1: 打包 Python Sidecar
  ├── python -m PyInstaller ... → dist/slash-sidecar/
  └── 复制到 apps/desktop/src-tauri/binaries/

Step 2: 构建 Tauri Desktop
  ├── npm run build (前端)
  └── cargo tauri build (Rust + 打包 DMG)

产出: Slash_{version}_aarch64.dmg
```

### 4.2 Server 构建流程

```
Step 1: docker compose build
  └── 多阶段构建: rust:bookworm → debian:bookworm-slim

产出: Docker 镜像 (slash-server:latest)
```

### 4.3 平台矩阵

| 平台 | Desktop | Server |
|------|---------|--------|
| macOS aarch64 (M1+) | ✅ DMG | — |
| macOS x86_64 | ✅ DMG | — |
| Linux x86_64 | 🔜 AppImage/deb | ✅ Docker |
| Windows x86_64 | 🔜 MSI/NSIS | — |

> 当前优先 macOS aarch64，后续扩展其他平台。

---

## 五、版本与升级策略

### 5.1 版本号

```
Desktop: v{major}.{minor}.{patch}-{platform}
         例: v1.0.0-macos-aarch64

Server:  v{major}.{minor}.{patch}
         例: v1.0.0
```

Desktop 和 Server 版本独立，通过同步协议版本号保证兼容：
- 协议字段 `protocol_version` 在 negotiate 握手时交换
- Server 向后兼容至少 2 个 minor 版本

### 5.2 Desktop 升级

**内测阶段**: 手动分发 DMG，用户覆盖安装。

**正式阶段** (规划):
- Tauri 内置 updater（基于 S3 或 GitHub Releases）
- 增量更新：仅下载变更的文件，不重新下载 Sidecar（除非 Python 依赖变更）

### 5.3 Server 升级

```bash
docker compose pull
docker compose up -d
# PostgreSQL 迁移由 slash-server 启动时自动执行
```

---

## 六、安全考虑

1. **Sidecar 隔离**: Python Sidecar 仅监听 `127.0.0.1:3722`，外部不可访问
2. **数据本地性**: 文档解析和音视频转写在用户本机完成，原始文件不上传
3. **同步加密**: 客户端-服务端通信走 HTTPS，文件内容在传输层加密
4. **Keychain**: API Key 存储在系统 Keychain 中，不落盘明文

---

## 七、体积预估

| 组件 | 未压缩 | DMG/Docker 压缩后 |
|------|--------|-------------------|
| Tauri 主程序 | ~19 MB | ~9 MB |
| Python Sidecar (含 MarkItDown + Whisper) | ~200-250 MB | ~80-100 MB |
| **Desktop DMG 总计** | — | **~100-120 MB** |
| Server Docker 镜像 | ~80 MB | ~30 MB |
| PostgreSQL 镜像 | ~230 MB | — |
| MinIO 镜像 | ~160 MB | — |

---

## 八、实施优先级

```
Phase 1 — PyInstaller 打包验证 (1-2 天)
  ├── 编写 .spec 文件，验证 MarkItDown + faster-whisper 打包成功
  ├── macOS 签名 & 公证 (ad-hoc 先行)
  └── 验证 localhost:3722 API 功能完整

Phase 2 — Tauri Sidecar 集成 (1 天)
  ├── tauri.conf.json 添加 externalBin
  ├── Rust setup() 中 spawn/kill 生命周期
  └── 前端健康检查 & 优雅降级 UI

Phase 3 — 端到端验证 (1 天)
  ├── DMG 全新安装测试（无 Python 环境的干净 macOS）
  ├── ImportHub: PDF/Word/Excel/PPT/音视频 全格式验证
  ├── Media Enrichment: 图片描述、音视频向量化
  └── 与 Server Docker Compose 联调同步

Phase 4 — CI/CD (1-2 天)
  ├── GitHub Actions: 自动打包 Sidecar → 构建 DMG
  └── Server: 自动构建 Docker 镜像 → 推送 Registry
```

---

## 九、验证清单

- [ ] Desktop DMG 在无 Python 环境的 macOS 上可正常安装启动
- [ ] Sidecar 随 Tauri 自动启动，退出时自动关闭
- [ ] ImportHub 导入 PDF/Word/Excel/PPT 正常
- [ ] 音视频转写 (MP3/MP4/M4A) 正常
- [ ] 图片 AI 描述（需 Ollama Vision 模型）正常
- [ ] Desktop 无 Server 时，同步功能优雅禁用，其他功能不受影响
- [ ] Server `docker compose up -d` 一键启动
- [ ] Desktop 连接 Server 后同步/团队功能正常
- [ ] 成员首次 pull (mapped_files=0) 正常恢复团队文件
