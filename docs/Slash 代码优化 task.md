# 优化执行任务清单

## Wave 1：前端巨石组件拆分 ✅

### 1.1 Sidebar.tsx 拆分（1870 → 932 行 ✅）
- [x] `useTeamDirectoryMapping` hook 抽取（138 行）
- [x] `useFileWatcher` hook 抽取（244 行）
- [x] `useFileTreeActions` hook 抽取（577 行）
- [x] 残留代码清理 + useCommand 恢复
- [x] Sidebar.tsx 瘦身验证（**932 行 ✅**）

### 1.2 App.tsx 拆分（1038 → 784 行 ✅）
- [x] `useGhostLinkManager` hook 抽取（266 行）
- [x] `useAppEventListeners` hook 抽取（~200 行）
- [x] `TeamReadOnlyGuard` 组件抽取（63 行）
- [x] `navigateToNotePath` 辅助函数消除 5 处重复
- [x] 清理未使用 import
- [x] App.tsx **784 行 ✅**

## Wave 1.5：localStorage 散射收归 ✅
- [x] 创建 `stores/useSessionStore.ts`
- [x] 18 个文件、55+ 处调用 → 零残留
- [x] 构建验证通过

## Wave 2：后端核心函数领域切分 ✅

### 2.1 push.rs 拆分（1072 → 352 行 ✅）
- [x] 快照逻辑抽取 → `snapshot.rs`（481 行）
- [x] Homesteading + @Mention 抽取 → `homestead.rs`（242 行）
- [x] push.rs 只保留权限校验 + 文件状态 upsert + 调度
- [x] `cargo check` 通过

### 2.2 manager.rs 拆分（1504 → 141 行 ✅）
- [x] V1-V32 migration + FTS5 repair 抽取 → `migrations.rs`（1291 行）
- [x] manager.rs 只保留 DbState struct + init/close + migrate 调度器 + with_connection
- [x] 表驱动 migration 调度（替代 32 个 if 语句）
- [x] `cargo check` 通过

## Wave 3：运行时隐患治理 — 待执行

### 3.1 补丁依赖规范化
- [ ] 审计 patch-package 文件
- [ ] 评估上游合入/替代方案
