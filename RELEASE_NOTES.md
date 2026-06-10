## v0.1.3-beta.10

#### 中文

##### Bug 修复

- 修复团队目录 `NEW` 标识和协作历史新事件红点点击消费后，刷新或后续同步又重新出现的问题。
- 修复任务列表中文输入法在任务开头、中间、退格取消拼音和行内代码后输入时，可能出现 checkbox 消失、前后文复制或整段误删的问题。
- 修复数学公式块创建、聚焦、鼠标点击输入框、确认关闭和 Markdown 往返中的多项稳定性问题。
- 修复从文件管理器拷贝文件到团队目录后，团队笔记可能因本地 YAML 缺少 Editor 信息而误进入只读保护的问题。
- 修复打开很多标签后，新激活标签可能落在横向视口外的问题。
- 修复创建或重命名笔记时，未确认的标题输入可能提前写入 frontmatter 标题和本地笔记标题的问题。

#### English

##### Bug Fixes

- Fixed team directory `NEW` badges and collaboration unread dots reappearing after they were read.
- Fixed Chinese IME issues in task lists, including checkbox loss, duplicated surrounding text, and accidental line deletion.
- Fixed several math block stability issues around creation, focus, mouse interaction, confirming edits, and Markdown round-trips.
- Fixed copied team notes being incorrectly protected as read-only when local YAML did not yet contain Editor metadata.
- Fixed active top tabs sometimes opening outside the visible tab bar when many tabs were open.
- Fixed unconfirmed note title edits being written too early into frontmatter and local note metadata during create or rename flows.
