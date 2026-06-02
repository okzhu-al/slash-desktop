## v0.1.3-beta.5

#### 中文

##### 体验优化

- 团队空间完成 UUID-First 专项治理：团队目录和文件在同名、重命名、删除、恢复、任务 checkbox、评论批注、未读红点和稳定标签页场景下更稳定地按 UUID 跟随。
- 团队目录 Owner 现在可以在自己拥有的目录内部拖拽整理子目录和自己编辑的文件。跨 Owner 边界移动仍会被阻止。
- AI 设置页现在会更可靠地检测已安装的 Ollama，并在切出设置页后保留 bge/LLM 下载进度。
- 深色模式下团队相关界面的品牌蓝、图标和边框可读性更好。

##### Bug 修复

- 修复团队文件或目录被其他成员删除后，接收端标签关闭但编辑器页面仍残留的问题。
- 修复团队回收站恢复、同名目录重建和恢复重名时的成员权限与命名问题。
- 修复团队目录管理页在后台同步轮次中周期性跳动的问题。
- 修复任务列表中文输入法第二段输入覆盖前文，以及双空格任务元数据菜单无法触发的问题。
- 修复 Slash Server 物理断联后设置页和侧边栏仍显示已连接的问题。
- 修复 Windows/macOS 代码块语言菜单被截断或点击后立即关闭，以及复制按钮失效的问题。
- 修复团队文件本地同名时可能污染 Personal 同步链的问题，团队文件本地避让名不再影响远端事实路径。

#### English

##### Improvements

- Completed the UUID-First hardening pass for Team Space. Team directories and files now track by UUID more reliably across same-name conflicts, rename, delete, restore, task checkboxes, comments, annotations, unread badges, and stable tabs.
- Team directory Owners can now drag to organize subdirectories and files they edit inside their own owned directory. Moving across Owner boundaries remains blocked.
- AI settings now detect installed Ollama more reliably and preserve bge/LLM download progress when leaving and returning to Settings.
- Improved dark-mode readability for team-related brand-blue text, icons, borders, and focus states.

##### Bug Fixes

- Fixed a case where a remotely deleted team file or directory closed the tab but left the editor page visible on the receiving client.
- Fixed member permissions and naming behavior when restoring team directories from trash or recreating same-name directories.
- Fixed periodic jumping in the team directory management page during background sync rounds.
- Fixed Chinese IME input in task lists replacing earlier text, and restored the double-space task metadata menu trigger.
- Fixed Slash Server physical disconnect handling so Settings and the sidebar no longer keep showing a connected state.
- Fixed code block language menus being clipped or closing immediately on Windows/macOS, and fixed the code block copy button.
- Fixed local same-name team files from leaking into the Personal sync chain; local avoidance names no longer affect the remote team fact path.
