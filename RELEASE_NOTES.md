## v0.1.3-beta.12

#### 中文

##### Bug 修复

- 修复新建笔记、创建文件夹或保存内容后，手动折叠的 PARA 根目录会被重新展开的问题。现在根目录会记住用户的折叠状态，不再在刷新后自动打断侧边栏视图。
- 修复团队批注高亮在文档切换后偶发残留到另一篇笔记上的问题。批注恢复现在会在切换笔记时立即清理旧高亮，并丢弃已经过期的异步恢复结果。

#### English

##### Bug Fixes

- Fixed manually collapsed PARA root folders reopening after creating notes, creating folders, or saving content. The sidebar now remembers the user's collapsed root state across refreshes.
- Fixed team annotation highlights occasionally lingering on the next note after switching documents. Annotation restore now clears stale marks on note switch and ignores outdated async restore results.
