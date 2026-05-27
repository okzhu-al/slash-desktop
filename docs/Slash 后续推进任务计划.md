# Slash 后续推进任务计划（P1 → P3）

> **制定日期**: 2026-05-11
> **基于**: Sidecar 本地化迁移完成 + OPT-06 Phase 6 媒体 Embedding 架构完成 + 媒体索引模型选择 BUG 修复

---

## 现状总结

| 里程碑 | 状态 |
|:---|:---:|
| Sidecar 本地化（PyInstaller + Tauri Sidecar） | ✅ 完成 |
| Zero-Shot 离线转写（faster-whisper 替代 Google API） | ✅ 完成 |
| 多媒体语义织网（Embedding 融合媒体内容） | ✅ 完成 |
| Phase 6 — 缓存去重 + 手动触发 + EditorStatusBar | ✅ 完成 |
| EditorStatusBar Vision Model 选择修复 | ✅ 完成 |
| Team Edition 35/35 测试用例全通过 | ✅ 完成 |

---

## P1 — 上线阻断项（Must Have）

> 不完成就无法发布安装包

### P1-1：Sidecar 首次安装分发与版本管理

**目标**：用户安装 Slash.dmg 后 sidecar 可用，无需手动操作

**当前缺口**：
- Sidecar 二进制仅在本地 `build.py` 构建，未集成到 Tauri 打包流程
- `version.json` 已创建但无启动时版本检查逻辑
- 无首次安装时自动拷贝到 `~/Library/Application Support/Slash/sidecar/` 的逻辑

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `sidecar.rs` | 启动时检查 App Support 目录，若不存在则从 bundle 拷贝；读取 `version.json` 校验兼容性 |
| `tauri.conf.json` | 配置 `externalBin` 将 sidecar 目录嵌入 `.app` bundle |
| `build.py` | 适配 CI/CD 输出路径，生成 checksum |

**验收标准**：
- [ ] `cargo tauri build` 产出的 `.dmg` 包含完整 sidecar
- [ ] 首次启动自动部署到 App Support
- [ ] 版本不匹配时日志警告

---

### P1-2：Sidecar 进程崩溃自动恢复

**目标**：Sidecar 异常退出后自动重启，不中断用户操作

**当前缺口**：
- `sidecar.rs` 的 `start()` 是一次性启动，进程退出后无监控
- 无健康检查机制

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `sidecar.rs` | 新增 `watchdog` 线程：定期检查子进程存活状态，异常退出时自动重启（最多 3 次，间隔递增） |
| `sidecar.rs` | 新增 `/health` 端点探活（Sidecar 侧已有 FastAPI，添加 `/health` 路由即可） |
| `main.py` | 添加 `GET /health` → `{"status": "ok"}` |

**验收标准**：
- [ ] `kill -9 sidecar-pid` 后 5 秒内自动重启
- [ ] 连续崩溃 3 次后停止重试并 log 警告
- [ ] 重启后端口更新，调用方无感知

---

### P1-3：Whisper 模型管理 UI

**目标**：设置页提供 Whisper 模型选择与下载界面

**当前缺口**：
- 预装 `tiny` 模型，但用户无法切换到更大的模型（`small`, `medium`）
- 无下载进度展示
- Sidecar 不支持动态切换模型

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `AITab.tsx` / 新组件 | 模型选择下拉 + 下载按钮 + 进度条（复用 Ollama 模型管理的 UI 模式） |
| `main.py` | 新增 `/whisper/models` 列表端点 + `/whisper/download` 下载端点 + 动态加载模型 |
| `sidecar.rs` 或新 command | 转发前端请求到 Sidecar |

**验收标准**：
- [ ] 设置页显示已安装 / 可下载的 Whisper 模型
- [ ] 下载进度实时展示
- [ ] 切换模型后新导入的音视频使用新模型

---

### P1-4：CI/CD 多平台 Sidecar 打包

**目标**：GitHub Actions 自动构建 macOS / Windows / Linux 的 sidecar 二进制

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `.github/workflows/build-sidecar.yml` | **[NEW]** 矩阵构建：macOS (arm64, x86_64) + Windows (x86_64) + Linux (x86_64) |
| `.github/workflows/build-desktop.yml` | 在 Tauri build 之前触发 sidecar build，将产物注入到 `binaries/` |
| `build.py` | 支持 `--target` 参数指定平台 triple |

**验收标准**：
- [ ] PR 合并后自动构建三平台 sidecar
- [ ] 产物自动上传为 Release Asset
- [ ] Tauri build 能正确引用对应平台的 sidecar

---

## P2 — 体验增强（Should Have）

> 上线后用户体验显著提升的优化

### P2-1：图片悬浮预览（AI 提取内容展示）

**目标**：编辑器中 hover 图片时显示 AI 提取的描述文本

**当前基建**：
- `get_enriched_content` Tauri command **已就绪**
- `media_enrich_cache` 表已持久化 AI 提取文本

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| TipTap Image NodeView | 新增 hover tooltip 组件，调用 `get_enriched_content` |
| 新 CSS | tooltip 样式（毛玻璃效果 + 渐入动画） |

**验收标准**：
- [ ] Hover 图片 500ms 后出现 AI 描述浮窗
- [ ] 未索引的图片显示「待索引」状态
- [ ] 不影响图片的点击/拖拽交互

---

### P2-2：媒体索引进度细粒度反馈

**目标**：索引中显示 "1/3" 实时进度，而非仅 "索引中..."

**当前缺口**：
- `trigger_media_embedding` 在独立线程运行，无进度回报
- 前端仅显示 spinning loader

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `media_scheduler.rs` | 处理每个 asset 后 emit Tauri event `media:progress` |
| `EditorStatusBar.tsx` | 监听 `media:progress` 事件，显示 `{current}/{total}` |

**验收标准**：
- [ ] 索引 3 张图片时显示 "1/3" → "2/3" → "3/3" → 自动消失
- [ ] 进度异常（Sidecar 超时）时显示错误提示

---

### P2-3：Sidecar 热更新

**目标**：Sidecar 可独立于主应用更新

**当前基建**：
- `version.json` 已定义 `sidecar_version` 和 `min_app_version`

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `sidecar.rs` | 启动时检查远程 `version.json`（CDN），若有新版本则后台下载 → hash 校验 → 热替换 → 重启进程 |
| 新组件 | 设置页「Sidecar 版本」区域，显示当前版本 + 更新按钮 |

**验收标准**：
- [ ] 检测到新版本后后台下载，不阻塞用户操作
- [ ] 下载完成后下次启动自动使用新版本
- [ ] Hash 校验失败时回滚到旧版本

---

### P2-4：macOS 代码签名

**目标**：`.dmg` 安装包通过 Gatekeeper 验证，用户无需手动允许

**改动范围**：

| 文件 | 改动 |
|:---|:---|
| `.github/workflows/build-desktop.yml` | 集成 Apple Developer Certificate 签名 + Notarization |
| `tauri.conf.json` | 配置 signing identity |

> [!IMPORTANT]
> 需要 Apple Developer Program 账号（$99/年）。Sidecar 二进制也需要 ad-hoc 签名或正式签名。

---

## P3 — 技术债务与未来储备（Nice to Have）

> 不紧急但长期有价值

### P3-1：Worker 并发保护

**问题**：多个 Worker 周期可能重叠处理同一笔记
**方案**：`processing_lock` Mutex + 笔记级别去重

### P3-2：media_enrich_cache 失效策略

**问题**：模型升级后缓存中的旧文本不会自动刷新
**方案**：在 cache 表中记录 `model_name`（已有字段），当模型变更时标记为 stale；设置页提供「清除媒体缓存」按钮

### P3-3：Sidecar skills.rs 路径统一 conn 传递

**问题**：`skills.rs` 因 async MutexGuard 限制传 `None` 给 `enrich_with_media`，走无缓存降级路径
**方案**：提取 conn 到 spawn_blocking 作用域，或使用 `tokio::sync::Mutex`

### P3-4：negotiate.rs 模块化拆分

**问题**：negotiate.rs 已达 740+ 行，维护成本高
**方案**：按域拆分为 `negotiate/deletion.rs`、`negotiate/rename.rs`、`negotiate/diff.rs`

### P3-5：知识图谱校准与 GhostLink 精度优化

**问题**：GhostLink 语义关联存在噪声，需要更精确的阈值和排序
**方案**：引入 TF-IDF 加权、调优余弦相似度阈值、增加负样本过滤

---

## 推进优先级矩阵

```
         紧急
          ↑
    P1-1  |  P1-2
    P1-4  |  P1-3
          |
  --------+------→ 重要
          |
    P2-4  |  P2-1
    P2-3  |  P2-2
          |
    P3-4  |  P3-1
    P3-5  |  P3-2, P3-3
```

## 建议执行顺序

```
Week 1:  P1-2（崩溃恢复）→ P1-1（安装分发）
Week 2:  P1-4（CI/CD）→ P1-3（Whisper UI）
Week 3:  P2-1（图片预览）→ P2-2（进度反馈）
Week 4:  P2-3（热更新）→ P2-4（代码签名）
Backlog: P3-1 ~ P3-5 穿插进行
```
