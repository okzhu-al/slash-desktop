# BUG-E02: doc_status 远端变更未实时刷新当前页面

> **优先级**: P3（体验优化）
> **发现时间**: 2026-04-20
> **状态**: 已记录，待修复

## 复现步骤

1. Join 和 Lucia 同时打开 `Join T001.md`
2. Join 将文件从 Solo 切换为 Collab 模式
3. Lucia 的协作历史正确显示 "Join 已将文件切换为 Collab 模式"
4. 但 Lucia 的编辑器状态栏仍然显示 Solo 模式
5. Lucia 切换到其他页面再切回来后，正确显示 Collab 模式

## 根因

当前页面的 `doc_status` 状态在组件 mount 时从服务端获取，但没有监听 `sync:pulled` / `collab:new-events` 等事件来实时刷新。远端状态变更后，已打开的页面不会重新渲染。

## 修复方向

在 `useEditorCollaboration.ts` 或相关 hook 中监听 `sync:pulled` 事件，当检测到当前文件的 `doc_status` 发生变化时，重新获取状态并更新 UI。

## 规避方法

切换到其他页面再切回来即可。
