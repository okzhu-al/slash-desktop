## v0.1.3-beta.9

#### 中文

##### Bug 修复

- 修复个人空间部分重命名时序下，同一笔记 UUID 可能在服务端留下两个 active 文件路径的问题。
- 修复团队成员管理页切换成员 Admin/Observer 时，成员列表整体刷新闪烁的问题。
- 修复标题中使用中文输入法时，首个词条确认后页面可能跳动的问题。

#### English

##### Bug Fixes

- Fixed a Personal Vault rename edge case where the same note UUID could remain active at two server paths.
- Fixed the Team Members page refreshing the whole member list when switching a member between Admin and Observer.
- Fixed a possible page jump after confirming the first IME candidate while typing Chinese in headings.
