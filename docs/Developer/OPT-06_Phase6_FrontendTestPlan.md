# Phase 6: 前端功能测试用例

> 覆盖 TransferIndicator、TransferPanel、资产占位符（Image/Video）、i18n、同步流程闭环
> 
> 适用范围：**个人空间 + 团队空间**（Phase 6 不区分空间类型，两种空间均须验证）

---

## 一、TransferIndicator（底栏传输指示器）

### 1.1 可见性

| ID | 前置条件 | 操作 | 预期结果 |
|:---|:---|:---|:---|
| IND-01 | 传输队列为空（无任何 pending/active/failed 任务） | 观察编辑器底栏 | 指示器**完全隐藏**，不占位 |
| IND-02 | 队列中有 1 条 pending 上传 | 观察底栏 | 显示 HardDrive 图标 + 数字 "1"，颜色为蓝色（#60a5fa） |
| IND-03 | 队列中有 3 条任务（1 pending + 1 active + 1 failed） | 观察底栏 | 显示数字 "3" |
| IND-04 | 所有任务都变为 completed | 等待 5 秒轮询 | 指示器消失（completed 不计入 activeCount） |
| IND-05 | 面板已打开（isOpen=true），但 activeCount=0 | 观察底栏 | 指示器**保持可见**（isOpen 时不隐藏） |

### 1.2 交互

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| IND-06 | 点击指示器 | TransferPanel 浮动面板弹出 |
| IND-07 | 面板已打开 → 再次点击指示器 | 面板关闭 |
| IND-08 | 面板打开状态 → 指示器背景色 | 带蓝色高亮（rgba(59, 130, 246, 0.15)） |

### 1.3 轮询

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| IND-09 | 后台新增一条任务（通过 Tauri 命令） | 最多 5 秒后指示器数字自动更新 |
| IND-10 | 切换页面/笔记 | 轮询不中断，指示器持续显示 |
| IND-11 | `TransferService.getQueue()` 调用失败 | 静默处理，不弹错误提示，数字保持上次值 |

---

## 二、TransferPanel（传输管理浮动面板）

### 2.1 面板布局

| ID | 前置条件 | 预期结果 |
|:---|:---|:---|
| PNL-01 | 面板打开 | 固定定位：`bottom: 36px, right: 12px`，宽度 360px，最大高度 420px |
| PNL-02 | 面板打开 | 毛玻璃效果：`backdrop-filter: blur(16px)`，圆角 12px |
| PNL-03 | 面板打开 | Header 显示 HardDrive 图标 + "资产传输" 标题 + 关闭按钮 (✕) |
| PNL-04 | 面板打开，有任务 | Header 标题旁显示蓝色 badge，内容为任务总数 |
| PNL-05 | 面板打开，无任务 | badge 不显示 |

### 2.2 空状态

| ID | 前置条件 | 操作 | 预期结果 |
|:---|:---|:---|:---|
| PNL-06 | 队列完全为空 | 打开面板 | 居中显示灰色 HardDrive 图标 + "暂无传输任务" |
| PNL-07 | 首次加载中（loading=true, tasks=[]） | 打开面板 | 显示 Loader2 旋转动画 + "加载中..." |

### 2.3 任务分区

| ID | 前置条件 | 预期结果 |
|:---|:---|:---|
| PNL-08 | 2 条上传 + 1 条下载 | "上传" 分区显示 2 行，带 ↑ 图标 + "(2)"；"下载" 分区显示 1 行，带 ↓ 图标 + "(1)" |
| PNL-09 | 仅有上传任务 | 只显示 "上传" 分区，无 "下载" 分区 |
| PNL-10 | 仅有下载任务 | 只显示 "下载" 分区，无 "上传" 分区 |

### 2.4 任务行渲染

| ID | 任务状态 | 预期渲染 |
|:---|:---|:---|
| PNL-11 | `status: 'pending'` | Clock 图标（灰色），文件名，`"0 B / 4.2 MB"` 格式的进度文本 |
| PNL-12 | `status: 'active'`, transferred=2MB, total=8MB | Loader2 旋转（蓝色），进度条可见（25%），蓝→紫渐变色 |
| PNL-13 | `status: 'active'`, transferred=8MB, total=8MB | 进度条 100%，等待 commit 中 |
| PNL-14 | `status: 'completed'` | CheckCircle2 图标（绿色），进度显示完整字节数 |
| PNL-15 | `status: 'failed'`, error_message 有值 | XCircle 图标（红色），"失败" 红色文本，hover 显示完整错误 |
| PNL-16 | `status: 'paused'` | Clock 图标（琥珀色） |
| PNL-17 | `asset_path: "assets/images/超长文件名_2024_项目截图_最终版_v3.png"` | 文件名截断显示 `...`（text-overflow: ellipsis），hover 无 tooltip（仅显示截断） |

### 2.5 进度条细节

| ID | 条件 | 预期结果 |
|:---|:---|:---|
| PNL-18 | `total_bytes = 0` | progress 计算为 0%，不显示进度条（避免除零） |
| PNL-19 | `transferred_bytes > total_bytes`（异常数据） | progress clamp 到 100%，不溢出 |
| PNL-20 | 进度从 30% → 60% | 进度条有 `transition: width 0.3s ease` 平滑动画 |

### 2.6 操作按钮

| ID | 条件 | 操作 | 预期结果 |
|:---|:---|:---|:---|
| PNL-21 | 任务 `status: 'failed'`, `retry_count(2) < max_retries(5)` | 观察 | 显示蓝色重试按钮（RotateCcw 图标） |
| PNL-22 | 同上 | 点击重试 | 调用 `TransferService.retryTask(id)` → 面板刷新 → 任务变 pending |
| PNL-23 | 任务 `status: 'failed'`, `retry_count = max_retries` | 观察 | 重试按钮**不显示**（已耗尽重试次数） |
| PNL-24 | 任务 `status: 'pending'` 或 `'active'` | 观察 | 无重试按钮 |
| PNL-25 | 队列中有 completed 任务 | 观察 Header | 显示 Trash2 清除按钮 |
| PNL-26 | 同上 | 点击清除 | 调用 `clearCompleted()` → completed 任务消失 → badge 更新 |
| PNL-27 | 队列中无 completed 任务 | 观察 Header | Trash2 清除按钮**不显示** |
| PNL-28 | 点击 ✕ 关闭按钮 | 面板关闭 | `onClose` 回调触发，面板隐藏 |

### 2.7 自动刷新

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| PNL-29 | 面板打开后等待 6 秒 | `getQueue()` 至少被调用 3 次（打开时 1 次 + 每 3 秒 1 次） |
| PNL-30 | 面板关闭 | 定时器清除，不再轮询 |
| PNL-31 | 面板关闭 → 再打开 | 立即刷新 1 次，定时器重新启动 |

### 2.8 hover 交互

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| PNL-32 | 鼠标 hover 到任务行上 | 行背景变为 `rgba(63, 63, 70, 0.3)` |
| PNL-33 | 鼠标离开任务行 | 行背景恢复透明 |

---

## 三、资产占位符（ImageComponent）

### 3.1 占位符显示条件

| ID | 条件 | 预期渲染 |
|:---|:---|:---|
| IMG-01 | `src = "assets/images/photo.jpg"`，`resolvedSrc = ""` | 虚线框占位符：`1px dashed` 边框 + 图片 SVG 图标 + "⏳ Syncing asset…" |
| IMG-02 | `src = "assets/images/photo.jpg"`，`resolvedSrc = ""` | SVG 图标有 `pulse 2s infinite` 动画 |
| IMG-03 | `src = "/Users/x/vault/notes/inline.png"`，`resolvedSrc = ""` | 同样的虚线框，但显示 "Loading…"（无 pulse 动画） |
| IMG-04 | `src = "https://example.com/img.png"`，`resolvedSrc = ""` | 同上，显示 "Loading…" |

### 3.2 占位符 → 正常渲染过渡

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| IMG-05 | `resolvedSrc` 从 "" 变为有效 blob URL | 占位符消失，`<img>` 正常显示 |
| IMG-06 | 切换 vault → `resolvedSrc` 清空 → 新 vault resolve | 先显示占位符 → 再显示新图片（无破损 img 闪烁） |

### 3.3 占位符样式

| ID | 验证点 | 预期结果 |
|:---|:---|:---|
| IMG-07 | 占位符宽度（width 已设置） | 宽度 = currentWidth（与原图一致），高度 ≥ 100px |
| IMG-08 | 占位符宽度（width 未设置） | 固定 240px，高度 ≥ 100px |
| IMG-09 | hover 占位符 | 显示 indigo 选中框（`boxShadow: 0 0 0 2px rgb(99 102 241)`） |
| IMG-10 | 占位符背景色 | 使用 CSS 变量 `--asset-placeholder-bg`，暗色模式默认 `rgba(39, 39, 42, 0.5)` |

### 3.4 占位符 + resize 手柄

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| IMG-11 | hover 占位符 → 观察右下角 | resize 圆点出现（indigo-500 背景色） |
| IMG-12 | 拖拽 resize 手柄 | 占位符宽度跟随变化 |

---

## 四、资产占位符（VideoComponent）

### 4.1 占位符显示条件

| ID | 条件 | 预期渲染 |
|:---|:---|:---|
| VID-01 | `src = "assets/videos/demo.mp4"`，`showPlayer = false` | 虚线框 + 视频 SVG 图标（摄像机）+ "⏳ Syncing asset…" |
| VID-02 | `src = "assets/videos/demo.mp4"` | SVG 有 `pulse` 动画 |
| VID-03 | `src = "notes/inline.mp4"`，workspace root 未加载 | 虚线框 + "Loading…"（无 pulse） |
| VID-04 | `src = "notes/inline.mp4"`，root 已加载但 resolving | 虚线框 + "Resolving…" |

### 4.2 过渡与正常播放

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| VID-05 | `resolvedSrc` 变为有效 URL | 占位符消失，视频播放器渲染（黑色背景 + 播放按钮覆盖层） |
| VID-06 | 视频 resolve 后点击播放按钮 | 视频正常播放，覆盖层变透明 |

### 4.3 团队空间失败态（已有逻辑）

| ID | 条件 | 预期渲染 |
|:---|:---|:---|
| VID-07 | `failed = true` + `isTeamSpace = true` | 不显示 sync 占位符，而是显示 amber 警告框 "视频文件超出团队文件大小限制" |
| VID-08 | `failed = true` + `isTeamSpace = false`（个人空间） | 走正常 retry 逻辑（retryCount < 3 自动重试） |

### 4.4 不支持格式（MKV 等）

| ID | 条件 | 预期渲染 |
|:---|:---|:---|
| VID-09 | `src = "assets/videos/clip.mkv"` | 不显示 sync 占位符，显示 "Unsupported format • Click to external play" 卡片 |

---

## 五、i18n 国际化

### 5.1 中文（zh-CN）

| ID | key | 预期显示 |
|:---|:---|:---|
| I18N-01 | `transfer.title` | 资产传输 |
| I18N-02 | `transfer.empty` | 暂无传输任务 |
| I18N-03 | `transfer.uploads` | 上传 |
| I18N-04 | `transfer.downloads` | 下载 |
| I18N-05 | `transfer.clear_completed` | 清除已完成 |
| I18N-06 | `transfer.retry` | 重试 |
| I18N-07 | `transfer.failed` | 失败 |
| I18N-08 | `asset_placeholder.downloading` | 下载中… |
| I18N-09 | `asset_placeholder.waiting_sender` | 等待发送方上传 |
| I18N-10 | `asset_placeholder.declared` | 资产已声明，等待同步 |

### 5.2 英文（en）

| ID | key | 预期显示 |
|:---|:---|:---|
| I18N-11 | `transfer.title` | Asset Transfer |
| I18N-12 | `transfer.empty` | No transfer tasks |
| I18N-13 | `transfer.uploads` | Uploads |
| I18N-14 | `transfer.downloads` | Downloads |
| I18N-15 | `asset_placeholder.waiting_sender` | Waiting for sender to upload |

### 5.3 语言切换

| ID | 操作 | 预期结果 |
|:---|:---|:---|
| I18N-16 | 设置 → 语言 → 切换为英文 | TransferPanel 内所有文案即时切换 |
| I18N-17 | 切回中文 | 所有文案恢复中文 |

---

## 六、TransferService（Tauri 桥接层）

| ID | 调用 | Mock 返回 | 预期 |
|:---|:---|:---|:---|
| SVC-01 | `getQueue()` | `[]` | 返回空数组，类型为 `TransferTask[]` |
| SVC-02 | `getQueue()` | 3 条任务 | 返回长度 3，字段类型正确（id: number, direction: 'upload'\|'download' 等） |
| SVC-03 | `enqueueUpload(vaultId, hash, path, bytes)` | `42` | 返回 number 类型的 task id |
| SVC-04 | `enqueueDownload(vaultId, hash, path, bytes)` | `43` | 返回 number |
| SVC-05 | `retryTask(99)` | `true` | 返回 boolean |
| SVC-06 | `retryTask(999)` — 不存在的 id | `false` | 返回 false |
| SVC-07 | `clearCompleted()` | `5` | 返回清除数量 |
| SVC-08 | Tauri invoke 调用失败（后端 panic） | reject | Promise reject，调用方 catch 处理 |

---

## 七、个人空间 vs 团队空间 对比验证

> Phase 6 核心断言：**个人空间与团队空间行为一致**

| ID | 场景 | 个人空间 | 团队空间 | 预期一致性 |
|:---|:---|:---|:---|:---|
| SPACE-01 | 笔记引用 `assets/img.png` 同步后 | 编辑器显示 "⏳ Syncing asset…" 占位符 | 同左 | ✅ 完全一致 |
| SPACE-02 | 占位符 → blob 下载完成 | 占位符消失，图片正常渲染 | 同左 | ✅ 完全一致 |
| SPACE-03 | TransferPanel 显示上传任务 | vault_id 为个人 vault UUID | vault_id 为团队 vault UUID | ✅ 功能一致，仅 ID 不同 |
| SPACE-04 | 同步纯文本笔记（无 assets） | 无占位符，秒同步完成 | 同左 | ✅ 零影响 |
| SPACE-05 | 传输队列混合两种空间的任务 | 队列同时显示个人+团队任务 | 同左 | ✅ 共享同一 transfer_queue |
| SPACE-06 | 团队空间视频超限 | N/A | 显示 amber "超出限制" 卡片 | ⚠️ 仅团队空间有此逻辑 |

---

## 八、端到端用户故事

### E2E-FE-01：个人空间上传一张图片

```
前置：个人空间已连接同步
步骤：
  1. 在笔记中粘贴一张 5MB 的 PNG 图片
  2. 点击「立即同步」
  3. 观察编辑器底栏
  4. 观察 TransferPanel
  5. 等待上传完成
  6. 在另一台设备登录同一个人空间

预期：
  - 步骤 2：Fast Sync 秒级完成，笔记 Markdown 已到达服务端
  - 步骤 3：TransferIndicator 出现，显示 "1"
  - 步骤 4：面板显示「上传(1)」→ 进度条从 0% → 100%
  - 步骤 5：指示器消失
  - 步骤 6：另一设备同步后，编辑器先显示占位符 → 后台下载 → 图片正常显示
```

### E2E-FE-02：团队空间接收他人上传的视频

```
前置：团队空间，用户 A 上传了 20MB 的 MP4 视频
步骤：
  1. 用户 B 打开含该视频的笔记
  2. 观察编辑器中视频位置
  3. 等待后台下载

预期：
  - 步骤 2：视频位置显示虚线框 + 摄像机图标 + "⏳ Syncing asset…" + pulse 动画
  - 步骤 3：TransferIndicator 出现 → 面板显示下载进度 → 完成后占位符消失 → 视频播放器渲染
```

### E2E-FE-03：网络断开重连后恢复

```
前置：正在上传 50MB 文件（进度 40%）
步骤：
  1. 断开网络
  2. 观察 TransferPanel
  3. 恢复网络
  4. 观察 TransferPanel

预期：
  - 步骤 2：任务状态变为 failed，显示错误信息
  - 步骤 3-4：手动点击重试 → 进度从断点处继续（不重传已完成的 chunks）
```

### E2E-FE-04：应用崩溃恢复

```
前置：2 条 active 传输任务
步骤：
  1. 强制退出 Slash（模拟崩溃）
  2. 重新打开 Slash
  3. 打开 TransferPanel

预期：
  - 步骤 3：2 条任务状态为 pending（崩溃恢复），可自动继续或手动触发
```

### E2E-FE-05：快同步不受大文件阻塞

```
前置：正在上传 200MB 视频
步骤：
  1. 在另一篇笔记中编辑文字
  2. 点击同步

预期：
  - 文字编辑秒级同步完成
  - 200MB 视频继续在后台传输，不阻塞 Fast Sync
```
