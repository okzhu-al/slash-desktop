## v0.1.3-beta.11

#### 中文

##### Bug 修复

- 修复团队空间笔记打开后，顶部标签页可能显示内部编码而不是笔记名称的问题。
- 修复批注高亮可能按相同文本误恢复到其他笔记上的问题；错误高亮在重新打开笔记后会自动清理。
- 修复空白笔记直接插入表格时，光标可能被锁定在左上单元格、无法点击切换到其他单元格或编辑区的问题。
- 修复表格选中整行、整列或整块区域后按退格键时，只删除单元格内容而不是按结构删除的问题。

#### English

##### Bug Fixes

- Fixed team-space notes sometimes showing an internal identifier instead of the note title in the top tab bar.
- Fixed annotation highlights being restored onto other notes that happened to contain the same text; stale wrong highlights are cleared after reopening the note.
- Fixed empty notes trapping the caret in the top-left table cell when a table was inserted before any text.
- Fixed Backspace on full-row, full-column, or larger table selections deleting only cell contents instead of removing the intended table structure.
