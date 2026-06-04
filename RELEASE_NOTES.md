## v0.1.3-beta.7

#### 中文

##### Bug 修复

- 修复 Slash Server 注册和加入团队时中文账号可能导致团队同步卡片显示异常的问题。账号名现在限制为英文、数字、下划线、连字符和点号；显示名称仍支持中文。
- 修复 AI 设置页中保存 DeepSeek 等在线服务商后，页面又显示自定义 API 模型的问题。
- 修复协作编辑锁请求偶发失败时，客户端可能误判为全局断线并导致无法编辑的问题。
- 优化团队笔记只读状态提示，现在会明确说明是离线、协作锁暂不可用、他人正在编辑、非 Editor 或缺少 Editor 信息。
- 修复断开连接、待机恢复、登录过期和权限拒绝时提示文案不准确的问题。“管理员强制下线”现在只会在管理员执行强制下线后出现。

#### English

##### Bug Fixes

- Fixed an issue where Chinese usernames could render incorrectly in the Team Sync card. Usernames are now limited to letters, numbers, underscore, hyphen, and dot; display names still support Chinese.
- Fixed AI Settings showing the Custom API model again after saving DeepSeek or another online provider.
- Fixed transient collaboration lock failures being promoted to a global offline state, which could incorrectly prevent editing.
- Improved team-note read-only feedback with specific reasons such as offline, lock temporarily unavailable, another member editing, non-Editor access, or missing Editor metadata.
- Fixed inaccurate disconnect/session messages after server disconnects, sleep recovery, login expiry, and permission denial. “Forced logout by administrator” is now reserved for the actual admin force-logout action.
