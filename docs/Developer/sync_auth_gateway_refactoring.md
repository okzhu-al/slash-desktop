# Sync Authentication & Gateway Optimization Handoff

## 概述 (Overview)
本文档旨在交接近期针对 Slash 同步网关（Sync Auth Gateway）、登录页面交互以及个人/团队模式升级流程的重构与优化工作。这些改动主要集中在分离基础网关创建功能与已授权状态下的平滑升级功能，并修复了在此重构期间出现的 Vite HMR 构建崩溃与国际化翻译冲突等问题。

## 核心优化内容 (Key Optimizations)

### 1. 动态认证模式侦测 (Dynamic Auth Mode Detection)
**问题背景**：以往的网关界面中，对于目标云端应该输入 `PIN` 还是 `配对码(Pairing Code)` 缺乏准确的预判，UI 占位符和文案常常被硬编码。
**重构方案**：
- **急切获取 (Eager Fetching)**：修改了 `useSyncFlow.ts` 中的 `fetchServerInfo` 逻辑，在用户输入 Server URL 后立即下发请求，而不是等待提交验证时才获取。
- **条件渲染**：`AuthGatewayStep.tsx` 会直接根据服务器返回的 `ctx.serverInfo?.has_pin` 动态切换输入框的 Title、Placeholder 与上下文提示，消除了用户的操作疑义。

### 2. 国际化与错误提示隔离 (i18n & Error Handling Isolation)
**问题背景**：后端的配对码失效错误与 PIN 判断绑定过深，导致即使用户使用的是配对码，报错文案中（如 `pair_code_used`）也会出现“请使用 PIN”的奇怪提示。
**重构方案**：
- 更新了 `zh-CN/common.json` 与 `en/common.json`。
- 将 `pair_code_used` 和其它相关底层错误的提示拆分，去除了配对码过期错误中针对 PIN 的强假定和硬编码。

### 3. 底层路由修复与「平滑升级」路径校准 (Routing Fix & Upgrade Path)
**问题背景**：此前的更新中，曾错误地将 `AuthGatewayStep`（登录网关页）下方的三个基础操作按钮（创建团队、加入团队、创建个人）充当为“升级”途径，但这破坏了数据污染防线并引发了严重逻辑矛盾。同时真正的升级入口路由断链闪退。
**重构方案**：
- **基础按钮纯粹化**：明确规定登录页的三个底部按钮仅作为**全新生成 (Zero-state Creation)** 的入口。撤销了曾在 `VaultBindingService.ts` 中为其开绿灯的越级 hack 代码，恢复了严格的数据污染阻断（Contamination Block）。
- **打通真实升级路径**：
  - 修复了 `SyncTab.tsx` 中 `choose_mode` 路由直接 fallback 到无登录态页面的 bug。
  - 将 `ConnectedPersonalStep.tsx` 中 `需要团队协作？开启团队空间` 的按钮直接路由至 `create_team`。
  - 由于用户是从个人态跳转，系统自带了原有 Token (`hasToken === true`)，因此 `CreateTeamStep` 会自动隐藏「配对码」字段，实现了无缝且符合逻辑的业务升频。

### 4. Vite HMR 与构建环境稳定性修复 (Vite Parser Stability)
**问题背景**：在联调阶段，由于 `AuthGatewayStep.tsx` 及 `useSyncFlow.ts` 中内联正则表达式引发的解析器转义符错误，会导致开发服务器频繁抛出 `500 Internal Server Error (Importing a module script failed)`。
**重构方案**：
- 清理了相关代码中产生歧义的内联 `Regex literal`。
- 全面替换为安全且清晰的字符串 `replace()` 及 `new RegExp()` 构造，彻底根除了热更新的解析链崩溃。

## 后续建议与未尽事宜 (Next Steps & Handover Notes)

1. **污染拦截防线的监控**：
   目前的 `VaultBindingService.ts` 已被回滚为全严格模式。因此未来如果需要支持更深层次的资产合并机制，应在相应的 Backend Service 或前端 Migration Hook 中进行显式处理，而不能再次在底层探测方法 (`findConflictingBinding`) 中打补丁。
2. **ChooseModeStep 利用率**：
   `ChooseModeStep` （加入/新建团队的选择页）目前充当了创建页点击返回后的后撤缓冲（Fallback Cache）。它的代码已经被修复为可用状态，后续如果引入“已链接个人但选择加入已有团队”的跨界权限时，可重点复用此组件。
3. **i18n 文案一致性检查**：
   此次仅清理了 Pair Code 相关的失效提示，若后续拓展 `Oauth` 等更复杂的 Auth Provider，需再复审 `common.json` 里的登录提示组。
