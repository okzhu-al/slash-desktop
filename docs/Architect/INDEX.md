# Slash Team Edition — 架构师文档导航

> **最后更新**: 2026-04-22 22:07
> **测试阶段**: 🎉 **BETA READY** — 全部 Bug 清零，35/35 测试用例全覆盖

---

## 一、已完成（✅ Closed）

这些缺陷和修复已经过实测验证，可视为关闭。

### 同步架构修复

| 编号 | 文档 | 摘要 | 修复日期 |
|:---|:---|:---|:---|
| **P0** | [sync_propagation_verdict.md](file:///Users/junior/Projects/slash/docs/Architect/sync_propagation_verdict.md) | 定案裁决：`team_sync_state.json` 未写入 + BUG22 过滤器致"无主之地"。P0-P2 三项修复指令 | 2026-04-19 |
| **P0** | [BUG22_revert_order.md](file:///Users/junior/Projects/slash/docs/Architect/BUG22_revert_order.md) | 架构师自纠令：撤销 `personal.rs` 路径过滤器，恢复 Personal Sync 全量底座语义 | 2026-04-19 |
| **P0** | [team_sync_member_discovery_fix.md](file:///Users/junior/Projects/slash/docs/Architect/team_sync_member_discovery_fix.md) | 被邀成员团队同步激活：V1 useSyncFlow Hook + V2 AutoSyncManager 启动层 `ensureTeamDiscovery()` | 2026-04-20 |
| **P1** | [logical_clock_continuity_fix.md](file:///Users/junior/Projects/slash/docs/Architect/logical_clock_continuity_fix.md) | 修复 rename 操作导致 `logical_clock` 归零断链：negotiate.rs 递增 + push.rs 服务端权威计算 | 2026-04-20 |

### 数据完整性 & 安全

| 编号 | 文档 | 摘要 | 修复日期 |
|:---|:---|:---|:---|
| **BUG21** | [editor_semantic_and_drift_fix.md](file:///Users/junior/Projects/slash/docs/Architect/editor_semantic_and_drift_fix.md) | Editor 字段语义确立：React Stale Closure 导致 Collab 下 editor 被篡改。`isTeamNoteRef` 防线 | 2026-04-18 |
| **BUG21-v2** | [BUG21v2_editor_async_race.md](file:///Users/junior/Projects/slash/docs/Architect/BUG21v2_editor_async_race.md) | BUG21 回归修复：`isTeamNote` 异步竞态 → `doc_status` 同步兜底信号消除竞态窗口 | 2026-04-20 |
| **BUG-A08** | [BUG-A08_PIN_wipe_verdict.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-A08_PIN_wipe_verdict.md) | PIN 码被 `request-new-code` 误删：删除 `server.rs` 中 3 行 PIN 清除逻辑 | 2026-04-19 |
| **BUG-E03** | [BUG-E03_E04_ux_issues.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E03_E04_ux_issues.md) | 越权拦截提示统一为 Modal + "越权提示" title + i18n | 2026-04-20 |
| **BUG-E04** | [BUG-E03_E04_ux_issues.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E03_E04_ux_issues.md) | negotiate.rs 补充 `snapshot_type = 'rename'` 独立快照审计记录 | 2026-04-20 |
| **BUG-E05** | [BUG-E05_dead_path_resurrection.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E05_dead_path_resurrection.md) | 墓碑路径复活冲突：negotiate UUID 甄别 + push UPSERT CASE WHEN | 2026-04-21 |
| **BUG-E06** | [BUG-E06_para_root_trash_escalation.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E06_para_root_trash_escalation.md) | PARA 根目录回收站越权：客户端 isParaRoot 拦截 + 服务端 Admin-Only 守卫 | 2026-04-21 |
| **BUG-E07** | [BUG-E07_code_review.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E07_code_review.md) | Ghost Directory Shell 全链路修复：Fix 5-8 共 6 个修复点，消灭空壳目录复活 + Observer 拒绝循环 + Personal Sync 文件复活 | 2026-04-22 |
| **BUG-E10** | — | **Team Hash Drift + Rename 传播断裂**：7 层修复 — team.rs 漂移检测 + personal.rs 团队文件 pull 守卫 + negotiate.rs rename 墓碑/反向拦截/ID 优先/权限守卫 | 2026-04-22 |
| **OPT-01** | — | **PARA 根目录删除保护**：`can_delete_directory` + `delete_directory` 双重守卫，绝对禁止删除 01_PROJECTS 等 PARA 根 | 2026-04-22 |
| **BUG-E09** | — | **Promote 礼尚往来修复**：Homesteading 时 PARA 根成员不级联到子目录，阻断跨目录成员误继承 | 2026-04-22 |
| **OPT-04** | — | **Promote PARA 根一致性守卫**：前端校验 PARA 编号前缀一致，禁止跨 PARA 根 Promote | 2026-04-22 |
| **BUG-E11** | — | **小红点越权透传修复**：服务端/前端权限过滤，子目录非成员的 collab event 不透传到父目录 | 2026-04-22 |
| **OPT-02** | — | **Admin 维护模式 Rename**：TeamTreeItem 右键 Rename + useTeamAdminActions handler + TeamService API（代码已实现，审计确认） | 2026-04-22 |
| **BUG-B15** | — | **UX 隐藏 Promote 选项**：已推送到团队的目录不再显示 Promote 选项，避免交互冲突 | 2026-04-22 |
| **BUG-E01** | [BUG-E01_editor_rename_race.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E01_editor_rename_race.md) | **编辑器 Rename/Sync 并发 RangeError 防护**，包裹 try-catch 和边界修复 | 2026-04-22 |
| **BUG-E02** | [BUG-E02_doc_status_reactivity.md](file:///Users/junior/Projects/slash/docs/Architect/BUG-E02_doc_status_reactivity.md) | **doc_status 自动刷新** `sync:pulled` 事件总线驱动的前端状态栏实时刷新 | 2026-04-22 |
| **BUG-E08** | — | **Promote 目录管理页面自动刷新** `team:directories-changed` 事件总线驱动 | 2026-04-22 |

### 统一修复计划

| 文档 | 摘要 |
|:---|:---|
| [Slash Team Edition — 统一 Bug 修复计划 v5.md](file:///Users/junior/Projects/slash/docs/Developer/Slash%20Team%20Edition%20%E2%80%94%20%E7%BB%9F%E4%B8%80%20Bug%20%E4%BF%AE%E5%A4%8D%E8%AE%A1%E5%88%92%20v5.md) | Phase 1-8 全部 33 项 Bug 已修复的主跟踪文档 |

---

## 二、待修复（⚠️ Open）

### 已定案，等开发排期

| 编号 | 文档 | 优先级 | 摘要 |
|:---|:---|:---|:---|
| **OPT-04** | [OPT-04_Asset_Closure.md](file:///Users/junior/Projects/slash/docs/Architect/OPT-04_Asset_Closure.md) | P0 | **Asset 精准内容闭包同步架构**：剥离本地全局权限漏洞，转为依赖声明式按需下发；统一50MB特大视频阻断与降级；落实基于 file_assets 的零信任秒传复用与引用基准 Safe GC。 |

### UX 收尾 & 优化提案

> **产品路线变更**：已放弃"一个本地仓库绑定多个团队"的路线。如需多团队，必须使用不同的本地仓库分别绑定。Phase 5b 的多团队映射架构保留为底层能力，但产品层不再暴露。

| 编号 | 优先级 | 简述 | 状态 |
|:---|:---|:---|:---|
| BUG-A05 | P2 | 加入团队表单内容及顺序优化 | ✅ 登录页 UX 重构中完成 |
| BUG-A03 | P2 | 登录/加入团队页面增加 team/vault 选择 | ✅ 登录页 UX 重构中完成（单团队模式，无需选择器） |
| BUG-B15 | P2 | 已 Promote 目录右键隐藏 Promote 子菜单（原 "Remove Team Binding" 需求经审计降级为隐藏） | ✅ Closed |
| **OPT-03** | P2 | 维护模式交互升级（醒目入口 ✅ / 确认弹窗 ✅ / "维护中"状态条 ✅ / 禁用 Promote ✅）— 全部项已就绪 | ✅ Closed |
| BUG-006 | Defer | `directories` 模式重复 6+ 次（代码结构优化） | ✅ Closed |
| BUG-007 | Defer | `negotiate.rs` 函数臃肿（478 行）（代码结构优化） | ✅ Closed |

---

## 三、开发报告索引

这些是开发提交的调查/实施报告，对应架构师指令的执行侧。

| 文档 | 对应架构师指令 | 状态 |
|:---|:---|:---|
| [Sync_Propagation_Investigation.md](file:///Users/junior/Projects/slash/docs/Developer/Sync_Propagation_Investigation.md) | → `sync_propagation_verdict.md` | ✅ 已审阅 |
| [Sync_Propagation_Correction_Investigation.md](file:///Users/junior/Projects/slash/docs/Developer/Sync_Propagation_Correction_Investigation.md) | → `BUG22_revert_order.md` | ✅ 已审阅 |
| [Sync_Propagation_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/Sync_Propagation_Fix_Report.md) | P0-P2 修复实施报告 | ✅ 已审阅 |
| [Logical_Clock_Continuity_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/Logical_Clock_Continuity_Fix_Report.md) | → `logical_clock_continuity_fix.md` | ✅ 已审阅 |
| [Team_Sync_Member_Discovery_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/Team_Sync_Member_Discovery_Fix_Report.md) | → `team_sync_member_discovery_fix.md` | ✅ 已审阅 |
| [auth_persistence_and_mode_transition_conflict.md](file:///Users/junior/Projects/slash/docs/Developer/auth_persistence_and_mode_transition_conflict.md) | → `BUG-A08_PIN_wipe_verdict.md` | ✅ 已审阅 |
| [sync_auth_gateway_refactoring.md](file:///Users/junior/Projects/slash/docs/Developer/sync_auth_gateway_refactoring.md) | Auth UI 重构报告 | ✅ 已审阅 |
| [Auth_UI_Refinement_Walkthrough.md](file:///Users/junior/Projects/slash/docs/Developer/Auth_UI_Refinement_Walkthrough.md) | Auth UI 精修记录 | ✅ 已审阅 |
| [phase_5b_multi_team_isolation_plan.md](file:///Users/junior/Projects/slash/docs/Developer/phase_5b_multi_team_isolation_plan.md) | 多团队隔离设计 | ✅ 已完成 |
| [Editor_Async_Race_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/Editor_Async_Race_Fix_Report.md) | → `BUG21v2_editor_async_race.md` | ✅ 已审阅 |
| [BUG_E04_Rename_Snapshot_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/BUG_E04_Rename_Snapshot_Fix_Report.md) | → `BUG-E03_E04_ux_issues.md` | ✅ 已审阅 |
| [BUG_E05_Dead_Path_Resurrection_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/BUG_E05_Dead_Path_Resurrection_Fix_Report.md) | → `BUG-E05_dead_path_resurrection.md` | ✅ 已审阅 |
| [BUG-E07_Team_Delete_Propagation_Fix_Report.md](file:///Users/junior/Projects/slash/docs/Developer/BUG-E07_Team_Delete_Propagation_Fix_Report.md) | → `BUG-E07_code_review.md` | ✅ 已审阅 |
| [BUG-E07_team_delete_propagation_fix.md](file:///Users/junior/Projects/slash/docs/Developer/BUG-E07_team_delete_propagation_fix.md) | BUG-E07 详细修复记录（Fix 5-8） | ✅ 已审阅 |
| [batch_3_execution_report.md](file:///Users/junior/Projects/slash/docs/Developer/batch_3_execution_report.md) | Batch 3 UX 体验提升：BUG-B15 / BUG-E01 / BUG-E02 / BUG-E08 修复收官报告 | ✅ 已完成 |
| [implementation_plan.md](file:///Users/junior/Projects/slash/docs/Developer/implementation_plan.md) | 实施计划 | 参考文档 |

---

## 四、BUG-E07 修复明细（2026-04-22）

Admin 删除团队目录后二级客户端出现空壳目录复活、Observer 拒绝循环、Personal Sync 文件复活。

### 修复点

| Fix | 文件 | 问题 | 修复 |
|:---|:---|:---|:---|
| **Fix 5** | `team.rs` T-4 | scope 前缀匹配过宽 → mapping 保留 → create_dir_all 重建空壳子 | 子目录级 mapping 精确匹配 scope_dirs |
| **Fix 5b** | `team.rs` Step 10 | T-4 purge 后 reverse_mappings 丢失 → team_hash 永不清理 | PARA 根级回退清理 |
| **Fix 6** | `negotiate.rs` Step 0 | 权限丢失回退 Observer → 永久拒绝循环 | 对已删文件跳过权限校验 |
| **Fix 7** | `team.rs` early return | source_dirs 归零提前返回 → 跳过所有清理 | 返回前清理废弃 team_hash |
| **Fix 7b** | `team.rs` Step 10 | Step 7.5 删文件后路径解析遗漏 | save 前最终死条目收割 |
| **Fix 8** | `directories.rs` | Personal vault 副本未级联删除 → Personal Sync 拉回 | **跨 vault 级联 soft-delete** |

### 修改文件

| 文件 | 改动 |
|:---|:---|
| `apps/desktop/src-tauri/src/commands/sync/team.rs` | +80 行 |
| `apps/server/src/routes/sync/negotiate.rs` | +12 行 |
| `apps/server/src/routes/team/directories.rs` | +55 行 |

---

## 五、实测验证通过项

### 2026-04-20 会话

- [x] Promote 目录后团队同步自动激活（Join）
- [x] BUG22 撤销后 Personal Sync 全量覆盖正常
- [x] 文件 rename 后 `logical_clock` 连续递增
- [x] 目录 rename 后跨 vault 传播一致
- [x] Observer（Lucia）只读不可编辑 ✅ 不可复制 ✅
- [x] 被邀成员（Lucia）重启后自动发现团队、Pull 团队文件
- [x] 服务端三层权限防护（`ensure_vault_access` → `get_sync_scope_filter` → `ensure_team_permission`）
- [x] Solo → Collab 模式切换跨端传播（数据侧）
- [x] BUG21-v2: Collab 下被邀成员编辑不篡改 `editor` 字段
- [x] Collab 下 `contributors` 数组正确追加
- [x] Lucia rename 团队文件 → 跨 vault 传播 + `file_id` 保持一致
- [x] RBAC: 非 Editor 不可删除文件 ✅
- [x] RBAC: 团队目录内文件不可移动 ✅
- [x] RBAC: 非 Owner/Admin 不可删除目录 ✅
- [x] RBAC: TeamMember 不可重命名目录 ✅
- [x] BUG-E03: 越权拦截提示统一 Modal + "越权提示" + i18n
- [x] BUG-E04: Rename 独立快照审计 `snapshot_type = 'rename'`
- [x] BUG-E04: VersionTimeline 前端 rename 标签渲染 + i18n
- [x] Lucia 删除自有文件目录 → Team + Personal 双端 soft-delete 一致
- [x] BUG-E05: 删除文件后同路径重建 → 新 file_id + 双端存活 ✅
- [x] 回收站恢复已删文件 → 旧 UUID 复活 + (Recover) 防碰撞 ✅
- [x] 删除目录后重建同名目录 → 新 directory_id + 不继承旧文件 ✅
- [x] TC-18: Admin (Junior) 恢复 PARA 根目录回收站文件 ✅
- [x] BUG-E06: 非 Admin 不可访问 PARA 根目录回收站 ✅
- [x] TC-33a: 无 slash_id 文件拷入团队目录 → 自动注入 UUID + 双端同步 ✅
- [x] TC-33b: 无 slash_id 文件拷入个人目录 → 自动注入 UUID + 个人同步 ✅
- [x] TC-28: Admin 管理模式守卫（未开启不可操作）✅
- [x] TC-28: Admin 管理模式删除他人文件 → 团队 Vault 正确 ✅，Owner 次轮同步正确 ✅
- [x] TC-28: Admin 管理模式跨 PARA 移动 → 团队 Vault 正确 ✅，Owner 次轮同步正确 ✅
- [x] BUG-E07: Admin (及无权限用户) 本地独立子目录残留孤儿文件清理 ✅
- [x] ⚠️ 同步删除后残留空目录壳自动超度 ✅（Personal Sync 补齐 remove_dir）

### 2026-04-22 会话（BUG-E07 Ghost Directory Shell 全链路修复）

- [x] **简单删除**：C1/c1.md 删除 → aa/bb/cc 三端无空壳子、unified_state 干净 ✅
- [x] **嵌套删除**：B2/b2.md + B2/C2/c2.md 删除 → 三端均正常删除、Fix 8 级联生效 ✅
- [x] **简单移动**：01_PROJECTS/C3 → 02_AREAS/C3 → 三端路径正确更新、UUID-First rename 正确 ✅
- [x] **嵌套叠加移动**：02_AREAS/C3/{c3.md, B3/b3.md} → 01_PROJECTS/C3 → 三端路径重写完美 ✅
- [x] BUG-E01: 文件 rename/sync 与编辑器并发 `RangeError` 防范补丁 ✅ 
- [x] BUG-E02: Collab 切换 / 同步拉取后当前页面实时刷新 ✅
- [x] BUG-E08: Promote 完成后，TeamManagePage 后台自动监听 `team:directories-changed` 刷新 ✅
- [ ] **UX 优化**: PARA 根目录回收站仅在团队空间展示，个人空间不显示（避免 Admin 认知过载）

### 2026-04-22 会话续（BUG-E10 Team Hash Drift + Rename 传播修复）

- [x] **BUG-E10 Fix 1-7**: 全部 7 层修复已完成并验证 ✅
- [x] **Rename 传播验证**: bb rename b1→b1-1 → aa/cc 三端一致 ✅
- [x] **TC-22/23 评论批注**: 功能通过，rename 后评论不丢失 ✅（UX 交互待优化）
- [x] **TC-24/25/26 小红点通知**: 协作广播 ✅、阅后消除 ✅、一键清空 ✅
- [x] **BUG-E11**: 小红点越权透传修复 — 服务端/前端权限过滤 ✅
- [x] **OPT-01**: PARA 根目录删除保护 — 双重守卫 ✅
- [x] **BUG-E09**: Promote 礼尚往来修复 — PARA 根成员不级联 ✅
- [x] **OPT-04**: Promote PARA 根一致性守卫 — 前端编号校验 ✅

---

## 六、测试覆盖矩阵

| 模块 | 用例 | 状态 | 备注 |
|:---|:---|:---|:---|
| **A: 创建与加入** | TC-01~03 | ✅ 已测 | BUG8-10 已修 |
| **B: Promote** | TC-04~07 | ✅ 已测 | BUG11-20 已修 |
| **C: 文件权限** | TC-08~11 | ✅ 已测 | BUG21/22 已修 |
| **D: 目录权限** | TC-12~15 | ✅ 已测 | |
| **E: 删除/恢复** | TC-16~19 | ✅ 已测 | 删除传播已修（BUG-E07） |
| **F: 快照** | TC-20~21 | ✅ 已测 | |
| **F: 评论批注** | TC-22~23 | ✅ 已测 | 功能正常，rename 后不丢失（UX 待优化） |
| **G: 小红点通知** | TC-24~26 | ✅ 已测 | 功能正常，BUG-E11 已修复 |
| **H: 空间关系** | TC-27~29 | ✅ 已测 | |
| **I: Sync/UUID** | TC-30~33 | ✅ 已测 | |

**统计**：✅ 已测 35/35 全覆盖 | ✅ P0-P3 Bug 全部清零 | ✅ 架构与代码卫生优化全部完成

---

## 七、BUG-E10 修复明细（2026-04-22）

Team Hash Drift + Rename 传播断裂。成员编辑/rename 后其他客户端无法同步最新内容。

### 修复点

| Fix | 文件 | 问题 | 修复 |
|:---|:---|:---|:---|
| **Fix 1** | `team.rs` | 守卫死锁：漂移未检测 | 三层守卫增加漂移分支 |
| **Fix 2** | `personal.rs` | Personal pull 覆盖 Team 内容 | team_hash 非空 → 跳过 pull |
| **Fix 3** | `negotiate.rs` | Rename 后旧路径无墓碑 | INSERT `is_deleted=true` 墓碑 |
| **Fix 4** | `negotiate.rs` | 过时客户端反向 rename | `hash==base_hash` 检测 → skip + delete+pull |
| **Fix 5** | `negotiate.rs` | 墓碑 INSERT 缺 `size` 列 | INSERT 加 `size=0` |
| **Fix 6** | `negotiate.rs` | `server_file_id_map` 墓碑覆盖活跃 | 构建时活跃优先、墓碑不覆盖 |
| **Fix 7** | `negotiate.rs` | Rename 无权限校验 | Team vault: editor/Admin/Owner 守卫 |

### 修改文件

| 文件 | 改动 |
|:---|:---|
| `apps/desktop/src-tauri/src/commands/sync/team.rs` | +12 行 |
| `apps/desktop/src-tauri/src/commands/sync/personal.rs` | +16 行 |
| `apps/server/src/routes/sync/negotiate.rs` | +90 行 |
