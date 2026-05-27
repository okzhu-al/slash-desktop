# OPT-05 / OPT-06 实施路线颗粒度分解清单 (v2.0)

> **前置依赖**: OPT-04 (Asset Closure) 已于 2026-04-27 圆满完成
> **OPT-05**: 大体量资产引擎重构 (Large Asset Engine)
> **OPT-06**: 静默多媒体向量化引擎 (Background Media Indexing & Zero-Shot Transcription)

---

## OPT-04 已落地的基建成果（本清单的起跑线）

以下能力已经存在于代码库中，本清单所有任务均从此基线出发：

- ✅ `file_assets` 依赖图谱表（PostgreSQL）— 笔记与资产的精确绑定关系
- ✅ 闭包式 Push/Pull — Markdown + 依赖 Asset 原子同步
- ✅ 前端 50MB 团队空间硬限流拦截（Drag/Paste/Import 三入口）
- ✅ Storage Dashboard 分区看板（Team/Personal/Snapshot/Legacy 四区）
- ✅ Safe GC 引用计数垃圾回收
- ✅ 全栈 i18n 国际化
- ⚠️ **已知 Gap**：`asset_id` 当前使用原始文件名而非 `content_hash`，与 OPT-04 架构设计文档不一致（阶段零修复）

---

## 阶段零：CAS 内容寻址存储迁移（关键基建补债）

*OPT-04 架构文档明确规定 `asset_id` 应等于 `content_hash`，但实际代码使用原始文件名。这将导致碰撞、去重失效和跨端数据污染。必须在其他阶段之前修复。*

0-1. **`assets.rs` 落盘命名改造**：`save_asset` 和 `save_asset_from_path` 落盘时，文件名从原始名称改为 `{content_hash}.{ext}` 格式（如 `a3f8b2c1d4e5.png`）
0-2. **`AssetIndex` 索引结构适配**：确认 `AssetIndex` 的 `entries` 映射 key 已经是 hash（✅ 现有逻辑已满足），`relative_path` 值更新为 `assets/{hash}.{ext}`
0-3. **`helpers.rs` 闭包扫描器改造**：`extract_asset_refs` 中 `asset_id` 从 `filename.clone()` 改为提取文件名中的 hash 部分（即去掉扩展名的 stem）
0-4. **Markdown 链接格式变更**：`saveAsset` 返回的 `relative_path` 从 `assets/原始名.png` 变为 `assets/{hash}.png`，编辑器中 `![](assets/{hash}.png)` 持久化
0-5. **服务端 `file_assets` 表兼容**：`push.rs` 中收到的 `asset_id` 将自然变为 hash 值，需确认服务端存储路径也对齐为 `assets/{hash}.{ext}`
0-6. **去重逻辑强化验证**：相同内容通过 Drag 和 Paste 两种方式引入，应命中同一个 `{hash}.{ext}` 文件，不产生副本

---

## 阶段一：治理基建 — 从硬编码升级为服务端下发

*将 OPT-04 遗留的 50MB 写死防线升级为可配置、可协商的动态治理体系*

1. 服务端 `.env` 增加 `MAX_SYNC_FILE_SIZE_MB` 配置项
2. 服务端 Config 模型读取并持有该配置值（启动时加载）
3. 服务端登录/握手接口返回体增加 `server_capabilities` 字段（含上限值、允许的媒体类型等）
4. 客户端抽取 `AssetBoundsManager` 单例，废除散落的 `50 * 1024 * 1024` 硬编码判断
5. 客户端连接成功后从握手响应中提取并缓存服务端下发的上限值
6. Personal 空间走 `Infinite` 兜底（本地不设限），Team 空间严格使用服务端值
7. 现有三入口（Drag/Paste/Import）的拦截逻辑改读 `AssetBoundsManager` 而非硬编码常量

---

## 阶段二：前端 OOM 根治 — Path-based Handoff

*将 OPT-04 的"拦截大文件"升级为"零内存加载大文件"*

8. 前端所有文件尺寸判定改用 `@tauri-apps/plugin-fs` 的 `stat`，禁止 `file.arrayBuffer()` / `Blob.size`
9. `stat` 结果中同时获取文件的绝对物理路径，存入临时上下文
10. ImportHub 的 Sidecar 请求从 `FormData(Blob)` 改为 `JSON { local_absolute_path }` 轻量投递
11. Drag/Paste 入口对超过内存警戒线（如 10MB）的文件同样走路径透传而非内存加载

---

## 阶段三：Python Sidecar 路径直读改造

*与阶段二配合，Sidecar 端接收路径并直接系统级 I/O 读取*

12. `/parse` 接口新增非必传参数 `local_absolute_path: str`
13. 当收到 `local_absolute_path` 时，校验路径合法性（归属 Vault 目录）
14. 通过 `open(path, "rb")` 系统级读取文件，绕过 HTTP 上传缓冲区
15. 原有 `file: UploadFile` 通道保持兼容（小文件、远程调用场景）

---

## 阶段四：Zero-Shot 多语种本地转写引擎

*替换 Google API 依赖，引入纯离线的 faster-whisper 模型*

16. `requirements.txt` 新增 `faster-whisper` 依赖
17. `Dockerfile` 确认 `ffmpeg` 已存在（✅ 已有）
18. 删除 `main.py` 中 `speech_recognition` 的 Monkey Patch 代码块（中英降级 hack）
19. 新增文件类型嗅探分流器：`ext in [mp3, wav, mp4, avi, m4a]` → 走私有分支
20. 私有分支初始化 `WhisperModel("tiny", device="cpu", compute_type="int8")`（单例懒加载）
21. 调用 `model.transcribe(file)`，不传 `language` 参数，依赖模型原生 Auto-Detect
22. 拼接所有 Segments 文本，封装为 `ParseResponse(markdown=...)` 返回
23. 对非音视频文件保持原有 MarkItDown 通道不变

---

## 阶段五：Rust 后端静默提纯 — Embedding 织网

*在现有 Embedding Pipeline 中注入多媒体语义抽取能力*

24. `pipeline.rs` 的 `process_paragraph_chunk` 增加媒体链接正则扫描 `!?\[.*?\]\((assets/[^)]+)\)`
25. 对匹配到的 asset 路径，基于 `vault_path` 组装绝对物理路径
26. 通过 HTTP POST 调用本机 `localhost:3722/parse`（传入 `local_absolute_path`）
27. 等待 Sidecar 返回解析文本（OCR / 转写结果）
28. 将解析文本 Append 到当前 Chunk 的原始文本后，形成"超级文本"
29. 用增强后的超级文本调用 `ai_service.generate_embedding()` 生成融合向量
30. 对 Sidecar 请求失败的情况（如图片解析依赖 LLM 但用户未配置），静默跳过不阻塞原有文本 Embedding

---

## 阶段六：双轨同步管线剥离（长期战役）

*将大二进制资产从 JSON Push/Pull 中剥离，建立独立传输通道*

31. Push 阶段分流：文本/Meta/小图元（<1MB）走 JSON 快车道；大二进制资产走独立慢车道
32. 慢车道引入分块传输协议（支持断点续传）
33. Negotiate 阶段区分快/慢车道的 `client_needs` 清单
34. 服务端 Pull 对慢车道资产支持 Range 请求（按块下载）
35. 前端侧边栏增加「传输管理器」面板（进度条 / 暂停 / 重试）
36. 快车道确保：即便 1GB 视频卡在慢车道，其 80KB 的 OCR 文本照常秒级同步到队友

---

## 依赖拓扑与建议执行顺序

```
阶段零 (CAS 迁移)          [最高优先级，所有阶段的前置]
  ↓
阶段一 (治理基建)
  ↓
阶段二 (前端 OOM) ←→ 阶段三 (Sidecar 路径直读)  [可并行]
  ↓                       ↓
  └───────┬───────────────┘
          ↓
阶段四 (Zero-Shot 转写引擎)   [独立可先行，但建议在阶段三之后]
          ↓
阶段五 (Rust Embedding 织网)  [依赖阶段三 + 阶段四]
          ↓
阶段六 (双轨同步)             [独立长期项目]
```

> **注**: 阶段零是所有后续工作的根基。如果不先完成 CAS 迁移，后续阶段中 `asset_id` 的碰撞问题会导致 `file_assets` 表数据污染，跨端同步时产生幻影覆盖。

