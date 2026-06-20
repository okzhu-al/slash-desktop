## v0.1.3

#### 中文

##### Bug 修复

- 修复更新弹窗在发现新版本后，下载阶段仍可能使用旧版本资源地址，导致安装失败的问题。
- 修复团队目录下的本地笔记被错误排除出个人云备份范围，甚至把已有个人云记录误判为删除的问题。
- 修复团队笔记协作历史中“全部标为已读”在部分入口下时灵时不灵的问题。

#### English

##### Bug Fixes

- Fixed updater downloads sometimes using stale release asset URLs after a newer version was detected.
- Fixed local files under active team directories being wrongly excluded from Personal Vault backup, which could also tombstone existing personal-cloud records by mistake.
- Fixed the "mark all as read" action in team note activity history intermittently failing under some entry paths.
