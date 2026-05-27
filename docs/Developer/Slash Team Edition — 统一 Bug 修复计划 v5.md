# Slash Team Edition — 统一 Bug 修复计划 v5

## 背景

本（V5版）计划接续了先前的 V4 版本，并在此基础上整合了最新几轮深度重构的战果。本次计划囊括了以下五大来源的 Bug 与优化：
1. **代码审计**：UUID-First 架构转型后的代码走读发现（BUG-001 ~ BUG-009）
2. **模块 A 测试**：团队创建与成员加入的实测发现（TC-01 ~ TC-03，BUG-A01 ~ BUG-A10）
3. **模块 B 测试**：Promote / 可见性 / 拉人 / 目录 rename 的实测发现（TC-04 ~ TC-07，BUG-B11 ~ BUG-B20）
4. **增补与边界防护**：Vault 污染三层防御实施验证反馈 + Phase 4 UX 优化
5. **最新引入 (v5 重大攻坚)**：
   - **Phase 5b: 多团队映射隔离与离线保护**（彻底解决了漏洞百出的多团队穿透 BUG-B11 遗留逻辑，拔除了 BUG-A02）
   - **Phase 8: 协作态 Editor 字段漂移保护与双域防污染**（BUG21, BUG22）

---

## 一、Bug 清单总览

### 已修复 (33项：Phase 1-8 + Vault 隔离防护)

| 编号 | 来源 | 优先级 | 类型 | 简述 | Phase | 状态 |
|------|------|--------|------|------|-------|------|
| BUG-A08 | TC-02 | 🔴 P0 | 安全 | 已使用邀请码注册时仍创建孤儿用户 | 1 | ✅ |
| BUG-A09 | TC-02 | 🔴 P0 | 安全 | 已有用户名+invite_code 被当成登录 | 1 | ✅ |
| BUG-A10 | TC-03 | 🔴 P0 | 安全 | 错误验证码后仍创建孤儿用户 | 1 | ✅ |
| BUG-002 | 审计 | 🔴 P0 | 安全 | push.rs 跨界 Rename 防篡改用错字段 | 1 | ✅ |
| BUG-A06 | TC-01 | 🔴 P0 | 功能 | 登出时未清空 Personal Sync 上下文 | 1 | ✅ |
| BUG-001 | 审计 | 🟡 P1 | 功能 | negotiate rename 后 server_files 时序不一致 | 2 | ✅ |
| BUG-008 | 审计 | 🟡 P1 | 功能 | rename_directory INSERT 丢失 file_id | 2 | ✅ |
| BUG-A07 | TC-01 | 🟡 P1 | 功能 | token 失效后客户端未自动刷新 | 2 | ✅ |
| BUG-003 | 审计 | 🟡 P1 | 健壮 | UUID 仅凭长度 36 判断，无格式校验 | 2 | ✅ |
| BUG-005 | 审计 | 🟡 P1 | 健壮 | 关键路径 `let _ =` 吞掉数据库错误 | 2 | ✅ |
| BUG-004 | 审计 | 🟡 P1 | 健壮 | directories 查/建竞态条件 | 2 | ✅ |
| BUG-009 | 审计 | 🟢 P2 | 卫生 | delete_directory 未广播 collab 事件 | 3 | ✅ |
| VAULT-L1 | 增补 | 🟡 P1 | 安全 | Layer 1: .slash/vault_binding.json 身份持久化 | Vault | ✅ |
| VAULT-L2 | 增补 | 🟡 P1 | 安全 | Layer 2: 6 个连接点三元组校验 | Vault | ✅ |
| VAULT-L3 | 增补 | 🟡 P1 | UX | Layer 3: 断开后引导关闭 Vault | Vault | ✅ |
| VAULT-L3-FIX | 增补 | 🟡 P1 | UX | Layer 3 每次登出都询问（移除 localStorage 缓存） | 6 | ✅ |
| BUG-B11 | TC-04 | 🔴 P0 | 数据完整 | 彻底解决：同目录重复 Promote 及**异架构穿透限制拦截** | 5b/6 | ✅ |
| BUG-B12 | TC-04 | 🔴 P0 | 数据完整 | 后端未拦截重复 Promote，file_states 发生了写入 | 6 | ✅ |
| BUG-B13 | TC-04 | 🔴 P0 | 事务性 | Promote 缺少事务性：非法请求导致 file_states 半写入 | 6 | ✅ |
| BUG-B14 | TC-04 | 🔴 P0 | 数据完整 | 文件层引用了不存在的合法目录实体路径 | 6 | ✅ |
| BUG-B16 | TC-04 | 🟡 P1 | 数据完整 | 同一 file_id 在同一 Vault 下出现多路径映射 | 6 | ✅ |
| **BUG-A02** | TC-01 | 🟠 P1.5 | 架构 | **同一用户需支持创建/加入多个团队**（结构突破） | **5b** | ✅ |
| BUG-B18 | TC-07 | 🟡 P1 | 功能 | 目录 rename 后 team_trash_records 路径不一致 | 7 | ✅ |
| BUG-B19 | TC-07 | 🟡 P1 | 功能 | 目录 rename 后成员侧路径（由 T-3/T-4 自动覆盖） | 7 | ✅ |
| BUG-B20 | TC-07 | 🟡 P1 | 卫生 | 目录 rename 后 file_snapshots 路径不一致 | 7 | ✅ |
| VAULT-i18n | 增补 | 🟢 P2 | UX | Layer 2/3 弹窗硬编码中文 → i18n 国际化 | 4 | ✅ |
| VAULT-L3-TIMING | 增补 | 🟡 P1 | UX | Layer 3 confirm 弹窗在 state reset 之后（时序错误） | 4 | ✅ |
| BUG-A01 | TC-01 | 🟢 P2 | UX | 创建团队页面增加配对码 + handleCreateTeam 自动 pair | 4 | ✅ |
| BUG-A04 | TC-01 | 🟢 P2 | UX | 创建团队表单分组重排（连接→团队→管理员） | 4 | ✅ |
| WelcomeStep-i18n | 增补 | 🟢 P2 | UX | WelcomeStep 3 处硬编码中文 → i18n | 4 | ✅ |
| BUG-B17 | TC-04 | 🟢 P2 | UX | 非法 Promote 后展示不一 (随B11-16前端重构消除) | / | ✅ |
| **BUG21** | TC-08 | 🔴 P0 | 语义防篡改 | **Editor 字段强行漂移问题** (Stale Closure 漏洞) | **8** | ✅ |
| **BUG22** | TC-08 | 🔴 P0 | 数据隔离 | **Personal Sync 错误打包上行团队文件**导致归属混淆 | **8** | ✅ |

### 待完成 (5项收尾 UX/优化与搁置项目)

| 编号 | 来源 | 优先级 | 类型 | 简述 | 状态 |
|------|------|--------|------|------|------|
| BUG-A05 | TC-01 | 🟢 P2 | UX | 加入团队表单内容及顺序优化 | ⏳ 下一步 |
| BUG-A03 | TC-01 | 🟢 P2 | UX | 登录/加入团队页面增加 team/vault 选择 | ⏳ 下一步 |
| BUG-B15 | TC-04 | 🟢 P2 | UX | 已 Promote 目录右键改为 Remove Team Binding | ⏳ 下一步 |
| BUG-006 | 审计 | ⚪ Defer | 卫生 | directories 模式重复 6+ 次 | 🔒 Deferred |
| BUG-007 | 审计 | ⚪ Defer | 卫生 | negotiate.rs 函数臃肿（478 行） | 🔒 Deferred |

---

## 二、最新攻坚集群解析 (Phase 5b & Phase 8)

### Phase 5b — 多团队隔离重构与底层突破 ✅
*(彻底解决并发多团队架构及高级别的混绑阻断)*

1. **V2 映射架构热更**：`team_path_mappings.json` 由 Flat JSON 升级为 Dictionary `<vault_id, Map>` 的簇模式，在底层彻底解开了多团队同源存储的纠缠，实现了 BUG-A02 提及的多团队合法并联。
2. **读写态双钩子并轨**：`useTeamDirectoryMapping.ts` 切分为 `activeMappings` 与 `offlineMappings` 两域。
3. **彻底防穿轨拦截 (BUG-B11)**：在进行 Promote 操作时，不仅检查了自身的在线状态，更全盘屏蔽了存在于 offlineMappings 中的外围目录。如果某目录已“叛逃”或挂靠在另外的团队，前端界面会强行死锁它的转移（并依然展示不可拖拽的保护徽章）。

### Phase 8 — 协作态数据安全与物理反渗透拦截 ✅
*(应对在极端环境组合下个人数据被大范围篡改的漏洞)*

1. **Editor 字段闭包防篡改 (BUG21)**：
   拦截了 `useContentPersistence` 中的 Stale Closure。新增 `isTeamNoteRef` 作为安全防线过滤了协同写入环节，强行制止了因为拉取延迟而将被修改文档认为是“由自己创建的本地文档”从而非法注入个人 Username 到 Editor 栏位的行径。
2. **Personal 隔离扫描引擎 (BUG22)**：
   在 Rust 端扫描层级（`scan_directory_manifests`）加筑沙盒围篱。使用 `team_path_mappings` 文件逆向构造了隔离黑名单目录池。即便是属于 Personal Vault 的全盘拉取行动，只要前缀命中了任意 Team 的领地，直接在树节点遍历阶段予以抹杀，保障 Team File 再无泄漏进私人上云信道的机会。

*(注：原 Phase 1 - 7，及 Vault 保护的修复明细可留置翻阅历史 V4 计划。)*

---

## 三、总体进度 (v5 评估)

> [!NOTE]
> - 追踪进度跃升：**33/38 Bug 已彻底修复**。
> - 系统稳定性评卷：目前**最高等级破坏性漏洞（多库数据污染、Editor伪造者覆盖、物理全盘越权扫描等）均被清零**。系统地基能够承接大规模多团队协作生产。

---

## 四、下一步工作规划 (Next Steps)

按照当下底层清爽、高危已空的态势，我们的下一步工作流可转为：**（1）团队视觉及切换器收网 -> （2）业务链路补测 -> （3）版本封装**。

### 行动重点：

#### 1. 团队前台调度终端补充 (UX 收尾及操作释放)
   - **完成 Team Switcher（团队切换器）**：针对 `BUG-A03` 和已经铺平的 Phase 5b 接口，我们在左侧边栏或顶部放置下拉选单。用户点击不同团队，仅需更新 `sessionStore.teamVaultId` 并触发 `autoSyncManager`，系统在现有 V2 Mapping 的辅佐下将能实现平滑的纯数据热切换。
   - **完成左侧树上下文菜单剥离 (BUG-B15)**：为已经 Promote 上云的目录右键菜单赋予 `Remove Team Binding` 功能，不再暴露 Promote 选项，避免使用户感到迷茫。
   - **加入流程的表单复核 (BUG-A05)**：补齐 加入团队（Join Team） 表单上的次序以及 UX 体验，打好最后一块补丁。

#### 2. 测试火力转移点 (模块 C ~ I 连环压测)
目前的测试进度已经完成：
✅ 模块 A（队伍创建与成员管理） 
✅ 模块 B（Promote 与 映射空间护林墙）

**下一批次移交测试环节**：
- **模块 C / D（权限判定与 Owner 制霸）**：Owner 主动拉人、Team-Member 拉人可见性及越权访问。
- **模块 E（安全回收站）**：文件物理删除向虚拟 Trash 的冒泡级联、回收站重命名覆盖策略。
- **模块 F（并发快照）**：针对协同的高频 `collab_event_log` 推送进行冲撞测试。

是否同意上述思路，进入团队切换及右键菜单这些可视组件（BUG-A03, BUG-A05, BUG-B15）的攻防阶段？
