# Phase 6: Fast Sync + Background Asset Transfer — 测试用例

> 覆盖范围：Protocol → Fast Track → Slow Track API → Client TransferManager → Frontend UI

---

## 一、协议层测试 (`slash-sync-proto`)

> 已有 9 个单元测试通过。以下为补充覆盖。

| ID | 用例 | 预期 |
|:---|:---|:---|
| P-01 | `ServerAssetState` 5 态序列化/反序列化 round-trip | JSON ↔ Enum 完全对称 |
| P-02 | `LocalTransferState` 5 态序列化/反序列化 round-trip | 同上 |
| P-03 | `AssetManifestEntry` 含 `Option<String>` 字段的 serde 默认值 | `original_name: null` 正确处理 |
| P-04 | `UploadInitRequest.size = 0` 的边界 | 序列化不 panic |
| P-05 | `SyncNegotiateResponse.asset_manifest` 为空数组 | 反序列化成功，旧客户端兼容 |

---

## 二、Fast Track Hardening (`push.rs` / `pull.rs` / `negotiate.rs`)

### 2.1 Push 资产分流

| ID | 用例 | 验证方法 | 预期 |
|:---|:---|:---|:---|
| FT-01 | Push 一篇引用了 `assets/img.png` 的 Markdown | 检查 DB: `file_assets` 有记录；`storage.put` **未被调用**（asset blob 跳过） | metadata upsert ✅，blob 跳过 ✅ |
| FT-02 | Push 纯 Markdown（无 assets 引用） | `file_assets` 无新增；`storage.put` 正常写入 | 标准路径不受影响 |
| FT-03 | Push `assets/video.mp4` 且 `file_assets` 中**无声明** | 兜底 `assets/` 路径检测命中 | metadata upsert ✅，blob 跳过 ✅ |
| FT-04 | Push 笔记更新：旧引用 `A.png` 变为 `B.png` | `file_assets` 中 A 被清除，B 被插入 | 声明图准确更新 |

### 2.2 Pull 资产过滤

| ID | 用例 | 预期 |
|:---|:---|:---|
| FT-05 | Pull 包含已声明资产的笔记 | 响应中 Markdown `content` 完整返回；资产文件的 `content` 字段为空 |
| FT-06 | Pull 纯文本笔记 | `content` 正常返回（无资产过滤干扰） |

### 2.3 Negotiate 资产清单

| ID | 用例 | 预期 |
|:---|:---|:---|
| FT-07 | Negotiate: 资产 blob 已在 storage | `asset_manifest[].state = Available` |
| FT-08 | Negotiate: 资产有 active upload session | `state = Uploading` |
| FT-09 | Negotiate: 资产声明存在但无 blob 且无 session | `state = Declared` |
| FT-10 | Negotiate: upload session 状态为 failed | `state = Failed` |

---

## 三、Slow Track Server API (`assets_transfer.rs`)

### 3.1 Upload Init

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-01 | 正常 init：`file_assets` 已声明、有权限 | 201 返回 `upload_id`，`already_exists = false` |
| ST-02 | **CAS 去重**：blob 已存在于 storage | 返回 `already_exists = true`，无新 session 创建 |
| ST-03 | **未声明拦截**：`asset_id` 不在 `file_assets` | 400 `"Asset not declared"` |
| ST-04 | **权限拦截**：用户无该 vault 访问权 | 403 Forbidden |
| ST-05 | **无效 vault_id** | 400 Bad Request |
| ST-06 | 无 JWT token | 401 Unauthorized |

### 3.2 Upload Status

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-07 | 查询有效 session | 返回 `received_bytes`, `received_chunks[]`, `expired = false` |
| ST-08 | 查询不存在的 `upload_id` | 404 |
| ST-09 | session 已过期 | `expired = true` |

### 3.3 Chunk Upload

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-10 | 上传第一个 chunk（index=0，4MB） | 200 OK，临时文件写入，`received_size` 递增 |
| ST-11 | **幂等性**：重复上传相同 `index` | 200 OK（静默跳过），`received_size` 不重复累加 |
| ST-12 | session 已过期后上传 chunk | 404 `"not found or expired"` |
| ST-13 | session 状态非 active（如 committed） | 400 `"not active"` |
| ST-14 | 多 chunk 顺序上传（3 个 chunk 覆盖 10MB 文件） | 每次 `chunk_count` 递增，`received_size` 累计准确 |

### 3.4 Commit

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-15 | 正常 commit：所有 chunk 已到齐，大小匹配 | `success = true`，blob 写入 storage，session → committed |
| ST-16 | **大小不匹配**：`received_size ≠ expected_size` | `success = false`，session → failed，返回 error 描述 |
| ST-17 | session 不存在 | 404 |
| ST-18 | `put_stream` storage 写入失败 | `success = false`，session → failed |
| ST-19 | commit 后临时 chunks 目录被清理 | 目录不存在 |

### 3.5 Blob HEAD

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-20 | blob 存在 | 200，`x-blob-ready: true`，`content-length` 正确 |
| ST-21 | blob 不存在（声明有但未上传） | 200，`x-blob-ready: false`，`content-length: 0` |
| ST-22 | hash 不在 file_states 中 | 404 |
| ST-23 | 用户无 vault 权限 | 403 |

### 3.6 Blob Download

| ID | 用例 | 预期 |
|:---|:---|:---|
| ST-24 | 无 Range header：全量下载 | 200 OK，body = 完整文件 |
| ST-25 | `Range: bytes=0-1023` | 206 Partial Content，`content-range: bytes 0-1023/N` |
| ST-26 | `Range: bytes=1024-` → 到末尾 | 206，返回剩余部分 |
| ST-27 | blob 尚未上传 | 404 `"pending upload"` |
| ST-28 | 超出范围 `Range: bytes=99999-` | 正常 clamp 到 total_size-1 |

---

## 四、客户端 TransferManager (`transfer_manager.rs`)

### 4.1 SQLite 队列 CRUD

| ID | 用例 | 预期 |
|:---|:---|:---|
| TM-01 | `enqueue_upload` 插入新任务 | 返回 id > 0，status = pending |
| TM-02 | **幂等入队**：相同 vault_id+hash+direction 再次 enqueue | 返回已有 id，不创建重复行 |
| TM-03 | 幂等入队：已有任务状态为 failed | UPSERT 重置为 pending，retry_count 归零 |
| TM-04 | `enqueue_download` 正常插入 | direction = download |
| TM-05 | `get_active_queue` 返回 pending + active + failed | 不含 completed |
| TM-06 | `get_pending_tasks(limit=2)` 在 5 个 pending 中 | 仅返回 2 条，按 created_at ASC |
| TM-07 | `update_task_status(id, "active", None)` | status 更新，error_message = NULL |
| TM-08 | `update_progress(id, 2097152)` | transferred_bytes = 2MB |
| TM-09 | `save_upload_id(id, "uuid-xxx")` | upload_id 字段回填 |
| TM-10 | `retry_failed(id)` 当 retry_count < max_retries | 返回 true，status → pending，retry_count +1 |
| TM-11 | `retry_failed(id)` 当 retry_count = max_retries | 返回 false，状态不变 |
| TM-12 | `clear_completed` 清除 3 条 completed | 返回 3，pending/failed 不受影响 |

### 4.2 崩溃恢复

| ID | 用例 | 预期 |
|:---|:---|:---|
| TM-13 | 2 条 active 任务 → `recover_active_tasks` | 返回 2，两条变为 pending |
| TM-14 | 无 active 任务 → `recover_active_tasks` | 返回 0，其他状态不变 |

### 4.3 Upload 执行逻辑

| ID | 用例 | 预期 |
|:---|:---|:---|
| TM-15 | 正常上传 8MB 文件（2 个 4MB chunk） | init → chunk×2 → commit，成功 |
| TM-16 | **CAS 短路**：init 返回 `already_exists = true` | 直接返回 Ok，无 chunk/commit 调用 |
| TM-17 | 本地文件不存在 | 立即返回 Err `"Local file not found"` |
| TM-18 | init HTTP 失败 | 返回 Err 含服务端错误信息 |
| TM-19 | chunk 上传中某一个失败 | 返回 Err，标识哪个 chunk |
| TM-20 | commit 返回 `success = false` | 返回 Err 含 error 字段内容 |

### 4.4 Download 执行逻辑

| ID | 用例 | 预期 |
|:---|:---|:---|
| TM-21 | 正常下载 12MB 文件（3 个 4MB Range） | HEAD → 3 次 GET Range → 本地文件完整 |
| TM-22 | HEAD 返回 `x-blob-ready: false` | 立即返回 Err `"Blob not yet available"` |
| TM-23 | 目标目录不存在 | 自动 `create_dir_all` 后写入成功 |
| TM-24 | 下载完成后文件大小 = total_size | 字节精确匹配 |

---

## 五、Tauri 命令层 (`commands/transfer.rs`)

| ID | 用例 | 预期 |
|:---|:---|:---|
| CMD-01 | `transfer_get_queue` 无任务 | 返回空数组 `[]` |
| CMD-02 | `transfer_enqueue_upload` → `transfer_get_queue` | 队列含 1 条 upload 任务 |
| CMD-03 | `transfer_enqueue_download` | 返回 task id |
| CMD-04 | `transfer_retry_task` 对 failed 任务 | 返回 true |
| CMD-05 | `transfer_retry_task` 对 pending 任务 | 返回 false（非 failed 状态） |
| CMD-06 | `transfer_clear_completed` | 返回清除数量 |

---

## 六、前端 UI 测试

### 6.1 TransferPanel

| ID | 用例 | 验证方法 |
|:---|:---|:---|
| UI-01 | 队列为空 | 面板显示空状态图标 + "暂无传输任务" |
| UI-02 | 1 上传 + 1 下载任务 | 面板分上传/下载两个分区，各显示 1 条 |
| UI-03 | active 任务 | 进度条可见，spinner 动画旋转 |
| UI-04 | failed 任务 + retry_count < max | 显示重试按钮，点击后状态变 pending |
| UI-05 | 有 completed 任务 | Header 显示清除按钮，点击后 completed 行消失 |
| UI-06 | 3 秒自动刷新 | 面板打开后任务列表自动更新 |

### 6.2 TransferIndicator

| ID | 用例 | 预期 |
|:---|:---|:---|
| UI-07 | 无活跃任务 | 指示器隐藏 |
| UI-08 | 有 2 个非 completed 任务 | 指示器显示图标 + 数字 "2" |
| UI-09 | 点击指示器 | TransferPanel 展开 |

### 6.3 资产占位符

| ID | 用例 | 预期 |
|:---|:---|:---|
| UI-10 | 图片 src 在 `assets/` 下且未 resolve | 显示虚线框 + 图片 SVG + "⏳ Syncing asset…" + pulse 动画 |
| UI-11 | 图片 src 非 assets 路径且未 resolve | 显示 "Loading…"（无 pulse） |
| UI-12 | 图片 resolve 成功 | 占位符消失，正常 `<img>` 渲染 |
| UI-13 | 视频 src 在 `assets/` 下且未 resolve | 虚线框 + 视频 SVG + "⏳ Syncing asset…" |
| UI-14 | 视频 resolve 成功 | 占位符消失，正常视频播放器渲染 |

---

## 七、集成/端到端场景

| ID | 场景 | 步骤 | 预期 |
|:---|:---|:---|:---|
| E2E-01 | **完整上传流程** | 客户端 Push 含图片笔记 → enqueue_upload → init → chunks → commit | 服务端 blob 可用，negotiate 返回 Available |
| E2E-02 | **完整下载流程** | 客户端 B negotiate 发现 Declared → enqueue_download → HEAD → Range GET | 本地文件完整写入 |
| E2E-03 | **CAS 去重端到端** | A 上传 img.png → B 引用同一 hash → B 上传 init | 返回 `already_exists = true`，无重复传输 |
| E2E-04 | **断点续传** | 上传 3 chunk 中第 2 个网络断开 → 重启 → recover → 重新 init → status 查询已收到 chunks → 补传 | 最终 commit 成功 |
| E2E-05 | **饥饿防御** | 后台传输 500MB 视频期间，并行 Push 5 篇 Markdown | Markdown Push 在 2 秒内完成，不被阻塞 |
| E2E-06 | **权限隔离** | 用户 A 的 vault 资产，用户 B 尝试 download | 403 Forbidden |
| E2E-07 | **崩溃恢复** | 2 条 active 任务 → 杀进程 → 重启 | 两条自动恢复为 pending |

---

## 八、安全与边界

| ID | 用例 | 预期 |
|:---|:---|:---|
| SEC-01 | 伪造 hash 执行 init | 若 file_assets 无匹配 → 400 拒绝 |
| SEC-02 | 篡改 chunk body（传错数据）→ commit | 大小匹配但内容错误 → commit 成功（当前版本不做 hash 校验，列为后续增强项） |
| SEC-03 | 过期 JWT 调用所有 6 个 endpoint | 全部返回 401 |
| SEC-04 | 并发 init 同一 asset | 两个独立 session 创建成功（CAS 在 commit 阶段去重） |
| SEC-05 | chunk 大小 > body limit (50MB) | Axum body limit 层拦截 → 413 |
