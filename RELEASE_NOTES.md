## v0.1.3-beta.2

#### 中文

##### Bug 修复

- 修复客户端发现新版本后，Titlebar 的“更新”胶囊不会自动出现的问题。手动检查发现更新后，Titlebar 也会立即同步显示。
- 修复 Titlebar 中“更新”胶囊与 AI 状态文字在窄宽度下相互挤压、换成两行的问题。
- 修复普通文本、普通列表和任务列表中，软换行后的后续行光标高度明显高于文字的问题。
- 修复首次创建新 Vault 时没有写入默认用户指南文档的问题。

##### 体验优化

- 启动后会在短时间内更积极地检查新版本，减少新版本已发布但客户端暂时没有提示的情况。
- 100% 缩放时不再向编辑器写入额外缩放样式，降低 WebKit 渲染副作用。
- 新 Vault 的默认用户指南会按当前应用语言写入：中文界面写入中文文档，其他语言写入英文文档。
- 补齐 Desktop 与 Server 用户文档英文版，并在公开镜像仓生成英文 README。

#### English

##### Bug Fixes

- Fixed an issue where the Titlebar update badge did not appear automatically after the client detected a new version. Manual update checks now notify the Titlebar immediately as well.
- Fixed the Titlebar update badge and AI status text wrapping into two lines or squeezing each other in narrow layouts.
- Fixed oversized caret height on wrapped visual lines in paragraphs, regular lists, and task lists.
- Fixed missing default user guide documents when creating a new Vault for the first time.

##### Improvements

- The client now checks for updates more actively shortly after launch, reducing the delay before a newly published version is shown.
- Removed the extra editor zoom style at 100% scale to reduce WebKit rendering side effects.
- New Vault guide documents now follow the current app language: Chinese for the Chinese UI, English for other languages.
- Added English user documentation for Desktop and Server, with English README files generated in the public mirror repositories.
