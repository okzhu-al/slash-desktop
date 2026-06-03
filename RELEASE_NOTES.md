## v0.1.3-beta.6

#### 中文

##### 新增

- 新增 Desktop 团队与同步使用指南，覆盖个人同步、团队空间、权限角色、评论批注、版本历史、编辑锁和维护模式，同步提供英文版。
- 新 Vault 初始化时自动写入团队使用指南。

##### 体验优化

- 深色模式下团队管理与同步相关界面的品牌蓝可读性更好。
- 设置页同步流程中的输入框样式在深色模式下更统一。
- Whisper 语音模型下载新增更多镜像源支持，网络受限时提供清晰的手动下载路径引导。

##### Bug 修复

- 修复团队同步中同名目录/文件、重命名、删除、恢复等场景下可能出现的身份跟随问题，团队内容现在更稳定地按 UUID 跟随。
- 修复团队文件或目录被其他成员删除后，接收端标签和编辑器页面可能残留的问题。
- 修复团队回收站恢复时成员权限丢失和重名冲突的问题。
- 修复团队目录管理页在后台同步轮次中周期性跳动的问题。
- 修复任务列表中文输入法第二段输入覆盖前文，以及双空格任务元数据菜单无法触发的问题。
- 修复 Slash Server 物理断联后设置页和侧边栏仍显示已连接的问题。
- 修复个人同步与团队同步之间的文件和资产隔离问题。
- 修复 Owner 目录维护中跨边界移动、子目录继承和 Promote 相关问题。
- 修复 Windows 冷启动时可能短暂显示"加载失败"的问题。
- 修复 AI 设置页 Ollama 检测和本地模型下载进度在切页后丢失的问题。
- 修复 Windows/macOS 代码块语言菜单被截断或复制按钮失效的问题。

#### English

##### New

- Added Desktop Team & Sync Guide covering personal sync, team space, permissions, comments, version history, edit locks, and maintenance mode, with English translation.
- New Vault initialization now includes a Team Guide.

##### Improvements

- Improved brand-blue readability in dark mode for team management and sync interfaces.
- Unified input field styles in Settings sync flow under dark mode.
- Added more Whisper model download mirrors with clear manual download guidance when network is restricted.

##### Bug Fixes

- Fixed UUID tracking issues in team sync across same-name directories/files, rename, delete, and restore scenarios.
- Fixed a case where a remotely deleted team file or directory left the tab and editor page visible on the receiving client.
- Fixed member permissions and naming behavior when restoring team directories from trash.
- Fixed periodic jumping in the team directory management page during background sync rounds.
- Fixed Chinese IME input in task lists replacing earlier text, and restored the double-space task metadata menu trigger.
- Fixed Slash Server physical disconnect handling so Settings and the sidebar no longer keep showing a connected state.
- Fixed personal/team sync file and asset isolation issues.
- Fixed Owner directory maintenance, subdirectory inheritance, and Promote-related issues.
- Fixed Windows cold startup briefly showing a "load failed" message.
- Fixed AI settings Ollama detection and local model download progress being lost when navigating away.
- Fixed code block language menus being clipped and copy button not working on Windows/macOS.
