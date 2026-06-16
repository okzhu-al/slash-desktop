## v0.1.3-beta.17

#### 中文

##### Bug 修复

- 修复团队笔记在本地目录大小写与团队映射不一致时，可能被误判为个人笔记，进而错误切回单人模式并重置协作者列表的问题。
- 修复团队笔记普通内容编辑偶发被记录为“切换为单人模式”的协作历史问题。现在只有显式修改文档协作状态时才会生成状态切换事件。

##### 体验优化

- 团队目录成员管理新增“全部”快捷操作，目录 Owner/Admin 可以一键把当前未加入该目录的团队成员全部加入。

#### English

##### Bug Fixes

- Fixed team notes being misidentified as personal notes when local path casing did not match team mappings, which could incorrectly switch notes back to solo mode and reset contributors.
- Fixed normal team-note content edits occasionally being recorded as “switched to solo mode” in collaboration history. Status events are now emitted only for explicit document mode changes.

##### Improvements

- Added an “All” shortcut to team-directory member management so directory Owners/Admins can add every currently unjoined team member in one action.
