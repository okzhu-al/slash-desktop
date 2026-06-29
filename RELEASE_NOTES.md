## v0.1.5-beta.1

#### 中文

##### Bug 修复

- 修复 Smart Rename 完成后会把当前笔记标签页关闭，再以新标题重新打开的问题。
- 修复团队笔记历史版本与协作历史过于频繁切段，以及团队成员接力编辑时历史记录分段不准确的问题。
- 修复协作历史评论输入框回车直接发布、评论内容被强制单行省略的问题。
- 修复多级混合列表在重新编号或切换有序/无序类型时，嵌套子列表可能丢层、断裂或只转换部分列表的问题。

##### 体验优化

- 优化任务指派 `@` 成员选择，支持输入过滤并可直接键盘确认。
- 统一文档顶部协作状态胶囊样式，并在滚动正文后继续悬浮显示当前编辑状态。
- 点击团队笔记时不再因为未读协作事件自动切换右侧边栏到协作历史。

#### English

##### Bug Fixes

- Fixed Smart Rename closing the current note tab and reopening it under the new title instead of updating the existing tab in place.
- Fixed overly frequent history splitting for note edit sessions, and fixed incorrect history segmentation when team members continue editing the same note in sequence.
- Fixed collaboration comment inputs sending on plain Enter, and fixed long comments being forced into a single truncated line.
- Fixed nested mixed lists losing structure or converting only partially when renumbering or switching between ordered and bullet list markers.

##### Improvements

- Improved task assignee `@` selection with inline filtering and keyboard confirmation.
- Unified the document status pills and kept collaboration/editing state visible with a floating pill while scrolling.
- Stopped team notes from auto-switching the right sidebar to collaboration history just because unread activity exists.
