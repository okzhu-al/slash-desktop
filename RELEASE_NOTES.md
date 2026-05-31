## v0.1.3-beta.4

#### 中文

##### 体验优化

- 优化已有 Vault 的冷启动体验。应用会先恢复上次文件树快照和退出前的 active tab，再在后台刷新真实磁盘结构和索引。
- 在线更新下载页的进度数字现在使用固定宽度展示，下载过程中不会因为文件大小或百分比位数变化而左右跳动。

##### Bug 修复

- 清理任务列表问题排查期间残留的控制台调试日志，减少编辑器使用时的控制台噪声。

#### English

##### Improvements

- Improved cold startup for existing Vaults. Slash now restores the previous file tree snapshot and active tab first, then refreshes the real disk tree and indexes in the background.
- Stabilized the online update download progress layout. File size and percentage values now use fixed-width display to avoid horizontal jitter while downloading.

##### Bug Fixes

- Removed leftover task-list diagnostic console logs from the editor to reduce console noise during normal use.
