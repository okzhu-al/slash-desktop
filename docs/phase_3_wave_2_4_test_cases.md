# Phase 3 波次 2-4 集成测试用例

> 前置条件：`docker compose build server && docker compose up`，删除旧 vault 数据，重新配对

---

## 一、环境准备

| # | 步骤 | 预期结果 |
|---|------|----------|
| E-1 | Admin 用户 (zhujh) 配对并创建团队 | 进入 `connected_team` 步骤 |
| E-2 | Observer 用户通过邀请码加入团队 | 进入 `connected_team` 步骤 |
| E-3 | Admin Promote 一个目录到团队空间 | 团队文件树显示该目录 |

---

## 二、波次 2：PR 审阅 UI

### TC-2.1 PRReviewPanel 渲染

| # | 操作 | 预期结果 |
|---|------|----------|
| 2.1.1 | Admin 进入 Settings → Sync（connected_team 状态） | 双栏下方出现「PR 审阅」可折叠面板 |
| 2.1.2 | 点击折叠/展开按钮 | 面板正确折叠和展开 |
| 2.1.3 | 切换 Pending / Approved / Rejected 标签 | 各标签激活态样式正确，列表刷新 |
| 2.1.4 | 无 PR 时 | 显示「暂无记录」空状态 |
| 2.1.5 | 点击「刷新」按钮 | loading 动画 → 列表刷新 |

### TC-2.2 PR 创建流程

| # | 操作 | 预期结果 |
|---|------|----------|
| 2.2.1 | Observer 用户编辑团队文件并保存 | 下次同步时走 PR 流程 |
| 2.2.2 | Observer 触发同步（手动或自动） | SyncService 分发 `sync:pr-created` 事件 |
| 2.2.3 | 同步完成后检查 PRReviewPanel | Pending 标签下出现新 PR 卡片 |
| 2.2.4 | PR 卡片信息完整性 | 显示文件名、目录路径、时间（如 "2m"） |

### TC-2.3 PR 审批/拒绝

| # | 操作 | 预期结果 |
|---|------|----------|
| 2.3.1 | Admin 点击 PR 卡片的「通过」按钮 | loading → 列表刷新 → PR 从 Pending 消失 |
| 2.3.2 | 切换到 Approved 标签 | 该 PR 出现在 Approved 列表 |
| 2.3.3 | Admin 点击另一个 PR 的「拒绝」按钮 | loading → PR 从 Pending 消失 |
| 2.3.4 | 切换到 Rejected 标签 | 该 PR 出现在 Rejected 列表 |
| 2.3.5 | API 报错时 | 操作栏显示红色错误提示文本 |

### TC-2.4 SyncStatusIndicator 角标

| # | 操作 | 预期结果 |
|---|------|----------|
| 2.4.1 | 有 pending PR 时观察侧边栏云图标 | 右上角红色角标显示数量（如 "1"） |
| 2.4.2 | Approve 所有 PR 后 | 角标消失 |
| 2.4.3 | 等待 60 秒 | 角标自动刷新（轮询） |
| 2.4.4 | Observer 推送新 PR 后 | Admin 侧角标即时刷新（`sync:pr-created` 事件） |

---

## 三、波次 3：Diff 可视化

### TC-3.1 DiffOverlay 渲染

| # | 操作 | 预期结果 |
|---|------|----------|
| 3.1.1 | 通过编辑器命令 `setDiffOps` 注入测试数据 | 编辑器中出现绿色/红色装饰 |
| 3.1.2 | Insert 行 | 绿色背景 + 左侧绿色边框（3px） |
| 3.1.3 | Delete 行 | 红色 widget 块显示在对应位置，带删除线 |
| 3.1.4 | 调用 `clearDiff` | 所有装饰清除 |
| 3.1.5 | Dark mode 下观察 | 绿/红色调合理降低亮度 |

### TC-3.2 DiffActionBar

| # | 操作 | 预期结果 |
|---|------|----------|
| 3.2.1 | Diff 模式激活时 | 顶部出现紫色操作栏 |
| 3.2.2 | 操作栏内容 | 显示文件名 + PR ID 前 8 位 + 图例 + 按钮 |
| 3.2.3 | 点击 Approve | 调用 `prService.approvePR` → 刷新 |
| 3.2.4 | 点击 Reject | 调用 `prService.rejectPR` → 刷新 |
| 3.2.5 | 点击关闭 (×) | `clearDiff` → 操作栏消失 |

### TC-3.3 端到端 Diff 流程

| # | 操作 | 预期结果 |
|---|------|----------|
| 3.3.1 | Observer 修改文件 → 同步创建 PR | PR 中包含 diff_ops |
| 3.3.2 | Admin 在 PRReviewPanel 点击 PR 卡片 | 打开对应文件 + 注入 Diff 装饰 |
| 3.3.3 | 修改内容可视化 | Insert 行绿色、Delete 行红色 |
| 3.3.4 | Admin 通过 ActionBar 批准 | Diff 清除 + 文件内容更新 |

---

## 四、波次 4：Task 旁路同步

### TC-4.1 TaskBypassDetector 逻辑

| # | 输入 | 预期结果 |
|---|------|----------|
| 4.1.1 | old: `- [ ] 任务A`<br>new: `- [x] 任务A` | `isBypassable: true, changes.length: 1, checked: true` |
| 4.1.2 | old: `- [x] 任务B`<br>new: `- [ ] 任务B` | `isBypassable: true, changes.length: 1, checked: false` |
| 4.1.3 | old: `正常文本`<br>new: `修改后文本` | `isBypassable: false, hasTextChanges: true` |
| 4.1.4 | checkbox + 文本同时变更 | `isBypassable: false, changes.length > 0, hasTextChanges: true` |
| 4.1.5 | 行数不同（新增/删除行） | `isBypassable: false` |
| 4.1.6 | 多个 checkbox 同时切换 | `isBypassable: true, changes.length: N` |

### TC-4.2 SHA-256 哈希一致性

| # | 操作 | 预期结果 |
|---|------|----------|
| 4.2.1 | 前端 `calculateContentHash("hello")` | 与 Rust `calculate_content_hash("hello")` 结果一致 |
| 4.2.2 | 含中文内容 `"任务一"` | 两端 hash 一致 |
| 4.2.3 | 含特殊字符 `"- [ ] task!"` | 两端 hash 一致 |

### TC-4.3 端到端旁路流程

| # | 操作 | 预期结果 |
|---|------|----------|
| 4.3.1 | 在团队空间打开含 checkbox 的笔记 | 正常显示 |
| 4.3.2 | 勾选一个 checkbox | `notifyCheckboxToggle` 被调用 |
| 4.3.3 | 检查服务器日志 | 出现 `Task checkbox toggled via bypass` |
| 4.3.4 | 另一个客户端同步 | checkbox 状态已更新 |
| 4.3.5 | 非团队文件 checkbox 切换 | 不触发旁路（走常规 sync） |
| 4.3.6 | hash 不匹配时（并发编辑） | 返回 `success: false`，不影响正常同步 |

---

## 五、i18n 验证

| # | 操作 | 预期结果 |
|---|------|----------|
| 5.1 | 中文环境查看 PR 面板 | 所有文本为中文（待审/已通过/已拒绝/通过/拒绝...） |
| 5.2 | 英文环境查看 PR 面板 | 所有文本为英文 |
| 5.3 | Diff 图例 | 中文"新增/删除"，英文"Added/Deleted" |

---

## 六、Dark Mode 验证

| # | 位置 | 检查点 |
|---|------|--------|
| 6.1 | PRReviewPanel | 卡片边框、背景、文字对比度 |
| 6.2 | PR 标签页 | 激活/未激活态样式区分 |
| 6.3 | Diff Insert | 绿色背景不刺眼（opacity 0.1） |
| 6.4 | Diff Delete | 红色背景柔和（opacity 0.06） |
| 6.5 | DiffActionBar | 紫色底栏可见、按钮清晰 |
| 6.6 | SyncStatusIndicator 角标 | 红色角标在深色背景下醒目 |
