## v0.1.3-beta.2

### Bug 修复

- 更新检查：修复手动点击“检查更新”可以发现新版本，但 Titlebar “更新”胶囊不会自动出现的问题。修复方向是启动初期增加短周期补查，并在手动检查发现更新后同步通知 Titlebar。
- Titlebar：修复“更新”胶囊与旁边 AI 状态文字在窄宽度下相互挤压并换成两行的问题。更新胶囊与 AI 状态均改为不收缩、不换行的紧凑状态按钮。
- 国际化：补齐 Titlebar 更新胶囊文案的中英文 `settings.update_badge`，避免依赖代码 fallback。
- 编辑器：修复普通文本节点中软换行后的后续行 caret 高度明显高于文字的问题。根因是 WebKit/WKWebView 在 `contenteditable` 中按扩展 `line-height` 绘制后续视觉行 caret；正文、普通列表和任务列表改为使用 `line-height: normal`。
- Vault 初始化：修复 `createVault()` 路径没有写入 3 个默认用户指南文档，而 `openVault()` 会写入的问题。

### 体验优化

- 更新发现：Titlebar 启动后 5 秒执行首次更新检查，并在启动后的前 10 分钟每分钟补查一次；发现更新后停止短周期补查，长期检查仍保持低频轮询。
- 编辑器缩放：100% 缩放时不再向编辑器容器写入 `zoom: 1`，减少 WebKit 缩放类渲染副作用。
- 用户文档：补齐 Desktop 与 Server 用户文档英文版，镜像仓根目录额外生成 `README.en.md`。
- Vault 初始化：默认用户指南文档按当前应用语言写入。中文界面写入中文文档，其他语言写入英文文档；写入的 seed frontmatter 增加 `slash_seed_lang`。
- 发布流程：总发布脚本新增版本顺序校验，防止低于已发布版本的 beta 或旧版本被发布。
- 发布流程：总发布脚本要求 `beta-change-log.md` 必须存在当前版本段落，并从该段落生成 updater notes 与镜像仓 `RELEASE_NOTES.md`。

### 回归点

- 更新检查：从低版本客户端启动后，应能在 Titlebar 自动看到“更新”胶囊；手动检查发现更新后，Titlebar 也应立即同步显示。
- Titlebar：侧边栏较窄时，“更新”胶囊和 AI 状态不应换行或互相挤压。
- 国际化：中文界面显示“更新”，英文界面显示 “Update”。
- 编辑器：普通段落软换行后的第 2 行、第 3 行 caret 高度应与文字高度一致；普通列表和任务列表中也应保持一致。
- 任务列表：checkbox 垂直位置应在 `line-height: normal` 后仍与文本自然对齐。
- Vault 初始化：首次创建新 Vault 时应生成 3 个默认用户指南；中文界面生成中文文档，英文界面生成英文文档；目标文件已存在时不覆盖用户内容。
- 镜像仓：`slash-desktop` 与 `slash-server` 根目录应同时具备默认中文 `README.md` 和英文 `README.en.md`，且仍只发布各自 `docs/user/<target>/` 目录。
- 发布脚本：发布低于当前最高语义版本的版本号时应中止；缺少 `beta-change-log.md` 对应版本段落时应中止。
- Release Notes：镜像仓根目录 `RELEASE_NOTES.md` 应只包含当前发布版本的变更记录。

### 验证记录

- `pnpm --dir apps/desktop exec tsc --noEmit`
- `bash -n scripts/publish-desktop.sh scripts/publish-server.sh`
- `bash -n scripts/release-desktop.sh`
- `scripts/extract-release-notes.py --version 0.1.3-beta.1 --source docs/operations/beta-change-log.md`
