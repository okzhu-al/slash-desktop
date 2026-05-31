## v0.1.3-beta.3

#### 中文

##### Bug 修复

- 修复 `0.1.3-beta.2` 发布版启动后可能没有显示应用页面的问题。应用现在由后端提供启动显示兜底，即使前端首帧显示通知没有执行，也不会让主窗口一直隐藏。
- 增加前端启动兜底提示。如果 React 入口没有成功挂载，窗口会显示可诊断的加载失败提示，而不是空白或不可见状态。

#### English

##### Bug Fixes

- Fixed an issue in `0.1.3-beta.2` where the packaged app could launch without showing the application page. The backend now provides a startup reveal fallback, so the main window will not remain hidden if the frontend first-frame reveal does not run.
- Added a frontend startup fallback message. If the React entry fails to mount, the window now shows a diagnosable load-failure message instead of staying blank or invisible.
