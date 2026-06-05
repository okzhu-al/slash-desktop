## v0.1.3-beta.8

#### 中文

##### Bug 修复

- 修复团队笔记 solo 模式下，非 Editor 成员无法选中表格文字进行批注的问题；同时只读状态下不再允许通过表格行列控制修改表格结构。
- 修复团队笔记协作历史中，历史版本误显示“回到此版本”的问题。团队历史版本现在按协作语义提供“另存为副本”，当前最新版本显示“当前版本”。
- 修复部分环境下个人本地笔记点击右侧“笔记大纲”无法跳转的问题。
- 修复 Windows 自动更新时未结束 `slash-sidecar` 进程，导致安装器因文件占用无法写入的问题。

#### English

##### Bug Fixes

- Fixed table text selection in read-only team solo notes so non-Editor members can still add annotations, while table structure controls remain disabled in read-only mode.
- Fixed team-note collaboration history showing “revert to this version” for historical snapshots. Team snapshots now offer “save as copy”, and the latest snapshot is labeled as the current version.
- Fixed outline navigation not jumping in some local personal notes.
- Fixed Windows auto-update failing to overwrite files when the `slash-sidecar` process was still running.
