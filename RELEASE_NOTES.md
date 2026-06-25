## v0.1.4

#### 中文

##### Bug 修复

- 修复表格单元格中的硬换行在保存后偶发被写成异常链接或裸 `[hardBreak]` 文本的问题。
- 修复图片在重启 Slash 后的恢复问题，包括首屏仍停留在“正在同步资源”占位，以及表格图片重启后丢失的问题。
- 修复在编辑区标题中重命名笔记时，偶发把同一笔记错误变成两个独立文件的问题。

#### English

##### Bug Fixes

- Fixed hard line breaks inside table cells sometimes being serialized into broken links or raw `[hardBreak]` text after save.
- Fixed image recovery regressions after restarting Slash, including first-open placeholder cards and table images disappearing after relaunch.
- Fixed an intermittent note-rename bug where editing the title in the editor could incorrectly duplicate one note into two separate files.
