---
slash_id: 11796935-1482-4677-80bb-feb57bb20ff9
title: team_feature_test_cases
editor: User A
---

# 详细测试用例

## 模块 A：团队创建与成员加入

### TC-01 创建 Team

**目标**：验证使用服务端地址与配对码可正确创建团队及初始管理员。\
**前置条件**：服务端正常运行，Docker log 可看到配对码。\
**步骤**：

1. 从 Docker log 获取配对码 ✅，可通过前端重新生成配对码 ✅
2. 在客户端输入服务端地址与配对码创建团队 可创建团队 ✅，但是前端页面创建团队缺少填写配对码输入框，只能通过先创建客人空间，然后提升为团队空间的方法迂回创建 ⚠️
3. 完成管理员注册，填写用户名/密码/Display name，可正确注册 ✅，需优化填写表单顺序及文案
4. 在同一服务器上重复创建团队：不可创建重名团队 ✅，但是同一用户开启不同团队空间必须使用不同的用户名 ⚠️
5. 切换登陆不同团队：由于地址、端口一致，所以登录时无法从源头切换团队，而只能使用不同用户名登陆不同团队，这里和创建的问题源头一致。⚠️

**预期结果**：

- Team 创建成功
- 团队空间名称正确
- 创建者为管理员
- 用户名 / 密码 / 昵称正确保存
- 用户角色为 `Admin`

**数据库反向验证**：

- `vaults`：存在团队空间记录
- `users`：存在管理员用户记录
- `team_members`：存在创建者与团队的成员关系，角色为 `Admin`

数据库记录 ✅

```sql
- 连表查询
SELECT
    v.id AS vault_id,
    v.name AS vault_name,
    v.space_type,
    v.created_at AS vault_created_at,
    u.id AS user_id,
    u.username,
    u.display_name,
    tm.global_role,
    tm.joined_at
FROM vaults v
LEFT JOIN team_members tm ON tm.vault_id = v.id
LEFT JOIN users u ON u.id = tm.user_id
WHERE v.space_type = 'team'
ORDER BY v.created_at DESC, tm.joined_at DESC;

               vault_id               | vault_name | space_type |       vault_created_at        |               user_id                | username | display_name | global_role |           joined_at           
--------------------------------------+------------+------------+-------------------------------+--------------------------------------+----------+--------------+-------------+-------------------------------
 015fe85f-35c2-42dc-a222-4fd4054e4bcf | Test1      | team       | 2026-04-15 09:47:39.60125+08  | 3b80bf36-5ef1-45aa-a6f7-e94627f489f9 | aaa      | User a       | admin       | 2026-04-15 09:47:39.602217+08
 5fbf3886-a96a-4b0b-ba93-1a7edac9f592 | Test       | team       | 2026-04-15 09:39:44.500792+08 | fec1c6d0-c92d-436c-8e64-85c83e4fef3e | aa       | User A       | admin       | 2026-04-15 09:39:44.502036+08
(2 rows)
```

**其他异常及报错**

**同一用户在连续创建多个团队后，个人空间上下文被覆盖**

现象描述：在创建多个团队时，因被迫使用不同的用户创建，而再次使用第一个用户登录后控制台报错：

```bash
\[Error\] \[AutoSync\] Sync failed: – "Negotiate HTTP 403 Forbidden: {\\"error\\":\\"Not the owner of this personal vault\\"}"

executeSync (AutoSyncManager.ts:471)
```

查Personal Vault

```sql
SELECT
    v.id AS vault_id,
    v.name,
    v.space_type,
    v.owner_id,
    u.username,
    u.display_name
FROM vaults v
JOIN users u ON u.id = v.owner_id
WHERE v.space_type = 'personal'
ORDER BY v.created_at DESC;
  vault_id               | vault_name | space_type |       vault_created_at        |               user_id                | username | display_name | global_role |           joined_at           
--------------------------------------+------------+------------+-------------------------------+--------------------------------------+----------+--------------+-------------+-------------------------------
 015fe85f-35c2-42dc-a222-4fd4054e4bcf | Test1      | team       | 2026-04-15 09:47:39.60125+08  | 3b80bf36-5ef1-45aa-a6f7-e94627f489f9 | aaa      | User a       | admin       | 2026-04-15 09:47:39.602217+08
 5fbf3886-a96a-4b0b-ba93-1a7edac9f592 | Test       | team       | 2026-04-15 09:39:44.500792+08 | fec1c6d0-c92d-436c-8e64-85c83e4fef3e | aa       | User A       | admin       | 2026-04-15 09:39:44.502036+08

               vault_id               |      name      | space_type |               owner_id               | username | display_name 
--------------------------------------+----------------+------------+--------------------------------------+----------+--------------
 83e30db9-2881-4498-ade3-a6f80bb0e633 | Personal Vault | personal   | 3b80bf36-5ef1-45aa-a6f7-e94627f489f9 | aaa      | User a
```

所以根因时由于需要使用不同的用户创建团队，而 aa 和 aaa 使用的个人空间又是同一个空间，所以导致 aa 创建的个人空间被 aaa 覆盖

**服务端 token 失效后，客户端登录时未自动更新 token**

现象描述：当前服务端 token 失效后，客户端如果一直在线会自动更新 token，但是当恰好失效时关闭应用，那么当再次打开应用后未自动获取 token，控制台报错：

```bash
[Error] [AutoSync] Sync failed: – "Negotiate HTTP 401 Unauthorized: {\"error\":\"Invalid token\"}"
	executeSync (AutoSyncManager.ts:471)
[Error] Failed to load resource: the server responded with a status of 401 (Unauthorized) (events, line 0)
```

**TC-01 BUG 清单**：

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG1** | 创建团队页面需增加配对码填写框 |  |
| **BUG2** | 同一 Server 上，同一用户可创建/加入多个团队，不再要求为不同的团队创建不同的账号 |  |
| **BUG3** | 登陆页面/加入团队页面增加 team/vault 选择 |  |
| **BUG4** | 创建团队页面表单内容及顺序优化为，服务器地址、配对码、团队空间名称（原团队名称）、用户名、密码、密码确认、团队内显示名称（原显示名称） |  |
| **BUG5** | 加入团队页面表单内容及顺序优化为，服务器地址、团队选择菜单、邀请码、用户名、密码、密码确认、团队内显示名称（原显示名称） |  |
| **BUG6** | 登出时清空前用户 Personal Sync 上下文，退出 Vault,执行**Vault 污染三层防御实施** |  |
| **BUG7** | 服务端 token 失效后，客户端打开应用需自动更新 token |  |

### **增补Vault 污染三层防御实施测试**

**Layer 1：**`.slash/vault_binding.json` 读写 + 三元组校验验证通过 ✅

**Layer 2：6 个连接点**全部加入 `verifyVaultBinding()` 拦截 测试通过 ✅

**Layer 3：引导保存需求优化，不要保存用户操作结果了，每次登出都要求选择 ✅**

### TC-02 邀请用户加入 Team

**目标**：验证邀请码注册新用户及默认角色。\
**前置条件**：已存在 Team，Admin 已登录。\
**步骤**：

1. Admin 生成邀请码：Admin 连续生成邀请码 ✅
2. 新用户使用邀请码注册 ✅
3. 填写用户名/密码/昵称 ✅
4. 使用已使用邀请码注册提示：Invite code already used ✅，但用户表会增加孤儿用户 ❌
5. 使用已有的用户名进行注册，如果密码不一致前端返回 Invalid username or password ，但是如果密码也相同则被视为登录 ❌

**预期结果**：

- 用户注册成功
- 默认角色为 `Observer`

**数据库反向验证**：

- `invitations`：邀请码生成、状态正确
- `users`：新用户记录存在
- `team_members`：新用户与团队绑定，角色为 `Observer`

1. 生成2条邀请码，使用 bb 注册 User B ✅

```sql
SELECT
    i.code,
    v.name AS vault_name,
    creator.username AS invited_by,
    i.role AS invitation_role,
    used_user.username AS invited_user,
    used_user.display_name AS invited_user_display_name,
    tm.global_role AS joined_role,
    i.used_at,
    tm.joined_at
FROM invitations i
JOIN vaults v ON v.id = i.vault_id
JOIN users creator ON creator.id = i.created_by
LEFT JOIN users used_user ON used_user.id = i.used_by
LEFT JOIN team_members tm
       ON tm.vault_id = i.vault_id
      AND tm.user_id = i.used_by
ORDER BY i.used_at DESC NULLS LAST, tm.joined_at DESC;

               code               | vault_name | invited_by | invitation_role | invited_user | invited_user_display_name | joined_role |            used_at            |           joined_at           
----------------------------------+------------+------------+-----------------+--------------+---------------------------+-------------+-------------------------------+-------------------------------
 5ab630cd7b2307315024567a29e6720c | Slash Team | aa         | observer        | bb           | User B                    | observer    | 2026-04-15 16:04:41.586091+08 | 2026-04-15 16:04:41.584072+08
 1fc5d557522ed87b329f299066e73490 | Slash Team | aa         | observer        |              |                           |             |                               | 
```

2. 使用 bb 已使用的邀请码再次注册用户 cc, 前端提示 **Invite code already used ✅，但是查看用户表,显示cc 已注册成功 ❌**

```sql
SELECT
    id,
    username,
    display_name,
    created_at,
    updated_at
FROM users
ORDER BY created_at DESC;

                  id                  | username | display_name |          created_at           |          updated_at           
--------------------------------------+----------+--------------+-------------------------------+-------------------------------
 43910355-cf66-45b3-8f9a-ca12b6049efd | cc       | User C       | 2026-04-15 16:15:40.392087+08 | 2026-04-15 16:15:40.392087+08
 85b7909b-ee71-46ef-848c-68498c7a5a89 | bb       | User B       | 2026-04-15 16:04:41.581084+08 | 2026-04-15 16:04:41.581084+08
 9871cb47-aad6-4ea2-8e91-4b20a5f61a25 | aa       | User A       | 2026-04-15 15:50:21.349471+08 | 2026-04-15 15:50:21.349471+08
(3 rows)
```

3. 使用已有用户名进行注册 User D，前端返回 Invalid username or password ，但是如果在注册时更加巧合的使用了相同的用户名和密码，则被视为一次登录，风险在于两者会共用同步空间，互相覆盖

```sql
- 邀请码未使用
               code               | vault_name | invited_by | invitation_role | invited_user | invited_user_display_name | joined_role |            used_at            |           joined_at           
----------------------------------+------------+------------+-----------------+--------------+---------------------------+-------------+-------------------------------+-------------------------------
 5ab630cd7b2307315024567a29e6720c | Slash Team | aa         | observer        | bb           | User B                    | observer    | 2026-04-15 16:04:41.586091+08 | 2026-04-15 16:04:41.584072+08
 1fc5d557522ed87b329f299066e73490 | Slash Team | aa         | observer        |              |                           |             |                               | 

- 新用户未增加
                  id                  | username | display_name |          created_at           |          updated_at           
--------------------------------------+----------+--------------+-------------------------------+-------------------------------
 43910355-cf66-45b3-8f9a-ca12b6049efd | cc       | User C       | 2026-04-15 16:15:40.392087+08 | 2026-04-15 16:15:40.392087+08
 85b7909b-ee71-46ef-848c-68498c7a5a89 | bb       | User B       | 2026-04-15 16:04:41.581084+08 | 2026-04-15 16:04:41.581084+08
 9871cb47-aad6-4ea2-8e91-4b20a5f61a25 | aa       | User A       | 2026-04-15 15:50:21.349471+08 | 2026-04-15 15:50:21.349471+08
(3 rows)
```

**TC-02 BUG 清单：**

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG8** | 已使用邀请码注册时，系统仍会创建孤儿用户 | ✅ |
| **BUG9** | 加入团队流程将“已有用户名”错误当成登录，导致跨用户 vault 串线与覆盖风险 | ✅ |

---

### TC-03 错误配对码 / 邀请码

**目标**：验证非法加入操作失败且不写脏数据。\
**步骤**：

1. 输入错误配对码创建 Team：无法创建 ✅
2. 使用错误邀请码注册用户：无法加入团队，但是提示错误后再次回到登陆页面则可成功登录，查询 `users` 表可看到孤儿用户 ❌

**预期结果**：

- 操作失败，提示明确

**数据库反向验证**：

- `vaults` / `users` / `team_members` / `invitations` 无异常新增

```sql
- 残留孤儿用户，aa为admin，bb为正常创建，cc为使用过期邀请码的孤儿，ee,ff 为非法入侵的用户
                  id                  | username | display_name |          created_at           |          updated_at           
--------------------------------------+----------+--------------+-------------------------------+-------------------------------
 d92ca831-bebf-49f7-8281-6704971afd5d | ff       | User E       | 2026-04-15 16:53:58.302979+08 | 2026-04-15 16:53:58.302979+08
 d1bcb9bd-ea1c-4bd0-8786-e4b4ab62daad | ee       | User E       | 2026-04-15 16:52:40.021277+08 | 2026-04-15 16:52:40.021277+08
 43910355-cf66-45b3-8f9a-ca12b6049efd | cc       | User C       | 2026-04-15 16:15:40.392087+08 | 2026-04-15 16:15:40.392087+08
 85b7909b-ee71-46ef-848c-68498c7a5a89 | bb       | User B       | 2026-04-15 16:04:41.581084+08 | 2026-04-15 16:04:41.581084+08
 9871cb47-aad6-4ea2-8e91-4b20a5f61a25 | aa       | User A       | 2026-04-15 15:50:21.349471+08 | 2026-04-15 15:50:21.349471+08
```

**TC-03 BUG 清单：**

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG10** | 验证码错误后仍可创建孤儿用户 | ✅ |

**Pass**

## 模块 B：Promote 本地目录为团队目录

### TC-04 Promote 本地目录为团队目录

**目标**：验证目录实体、文件身份、Owner/Editor 绑定是否正确。\
**前置条件**：管理员或有权限用户在个人空间有本地目录与若干笔记。\
**步骤**：

1. 将本地目录 Promote 为团队目录
2. 等待同步完成

**预期结果**：

- 目录成为团队目录 ✅
- 推送人为目录 `Owner` ✅
- 文件作者为对应文件 `Editor` ✅
- 文件与目录绑定关系正确 ✅
- 重复 Promoto 同一目录 ❌

**禁止出现**：

- 同一目录 Promote 两次生成两个存活目录实例
- 文件没有 `file_id`
- Owner /Editor 绑定丢失

**数据库反向验证**：

- `directories`：新增团队目录实体，存在 `directory_id`
- `directory_permissions`：推送人与 `directory_id` 绑定，角色为 `Owner`
- `file_states`：目录下文件存在 `file_id`，路径归属正确
- `file_snapshots`：必要初始快照存在

```sql
-- 差推送 TeamDirOwnerA2 只有一条记录
                  id                  |               vault_id               | vault_name |       directory_path       |             directory_id             |               user_id                | username | display_name | dir_role | observer_visible |              granted_by              | granted_by_username |          granted_at           
--------------------------------------+--------------------------------------+------------+----------------------------+--------------------------------------+--------------------------------------+----------+--------------+----------+------------------+--------------------------------------+---------------------+-------------------------------
 0e54733a-d2cc-4875-95f4-dab4ca5072a9 | 4f98fbed-44a1-4534-b641-cd64f27556b9 | Slash Test | 01_PROJECTS/TeamDirOwnerA2 | d3a7b5da-5a5a-4bed-9217-826a2ce5a695 | 9ac37094-6961-431b-b2db-a137c17519fc | aa       | User A       | owner    | f                | 9ac37094-6961-431b-b2db-a137c17519fc | aa                  | 2026-04-15 23:44:19.556024+08
 0d1a91e6-057a-46fc-bad0-f9a4326ab7d2 | 4f98fbed-44a1-4534-b641-cd64f27556b9 | Slash Test | 01_PROJECTS/TeamDirOwnerA  | 9e27ec43-386f-442d-98a9-a270b562fca2 | 9ac37094-6961-431b-b2db-a137c17519fc | aa       | User A       | owner    | t                | 9ac37094-6961-431b-b2db-a137c17519fc | aa                  | 2026-04-15 22:40:07.590142+08

-- 查二次推送后的权限关系
             directory_id             |       directory_path       | dir_role | observer_visible |          granted_at           
--------------------------------------+----------------------------+----------+------------------+-------------------------------
 d3a7b5da-5a5a-4bed-9217-826a2ce5a695 | 01_PROJECTS/TeamDirOwnerA2 | owner    | f                | 2026-04-15 23:44:19.556024+08
(1 row)

-- 查按那个路径落库
               vault_id               |             relative_path              |               file_id                |          updated_at           
--------------------------------------+----------------------------------------+--------------------------------------+-------------------------------
 4f98fbed-44a1-4534-b641-cd64f27556b9 | 01_PROJECTS/TeamDirOwnerA2/A2 note.md  | 0fbeea53-3dac-4944-84db-5019d00bfe39 | 2026-04-16 11:11:46.333286+08
 4f98fbed-44a1-4534-b641-cd64f27556b9 | 02_AREAS/TeamDirOwnerA2/A2 note.md     | 0fbeea53-3dac-4944-84db-5019d00bfe39 | 2026-04-15 23:44:19.551809+08
 cea4d00d-c801-4905-9b9b-b10facb32b99 | 01_Projects/TeamDirOwnerA2/A2 note.md  | 0fbeea53-3dac-4944-84db-5019d00bfe39 | 2026-04-15 23:44:01.163029+08
 cea4d00d-c801-4905-9b9b-b10facb32b99 | 01_Projects/TeamDirOwnerA2/新建笔记.md | 0fbeea53-3dac-4944-84db-5019d00bfe39 | 2026-04-15 23:43:50.707194+08
```

**TC-04 优化清单：**

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG11** | 同一目录可被重复 promote 到多个团队目录，前端未拦截。 | ✅ |
| **BUG12** | 后端未拦截重复 Promote 请求，第二次 Promote 并没有被完整拒绝，至少 file_states 发生了写入变化 | ✅ |
| **BUG13** | **Promote 缺少事务性，非法请求导致半成功**，重复 Promote 请求如果非法，应该：目录实体不写、权限不写、文件状态不写、快照不写，也就是**全失败**。但实际数据库查询\[hardBreak\]**directories**&lt;br&gt;只保留了：01_PROJECTS/TeamDirOwnerA2&lt;br&gt;**directory_permissions**&lt;br&gt;也只保留了：01_PROJECTS/TeamDirOwnerA2&lt;br&gt;**但 file_states**&lt;br&gt;却出现了：01_PROJECTS/TeamDirOwnerA2/A2 note.md，02_AREAS/TeamDirOwnerA2/A2 note.md&lt;br&gt;说明第二次 Promote 只写进了**部分层**。 | ✅ |
| **BUG14** | 目录层与文件层状态不一致，文件层同时存在：01_PROJECTS/TeamDirOwnerA2/A2 note.md，02_AREAS/TeamDirOwnerA2/A2 note.md，也就是**文件状态引用了一个数据库中并不存在的合法目录实体路径。** | ✅ |
| **BUG15** | 当一个目录已经 Promoto 后，右键 Promoto 菜单改为 **Remove Team Binding** |  |
| **BUG16** | 非法重复 Promote 导致同一 file_id 在同一 Team Vault 下出现多路径映射 | ✅ |
| **BUG17** | 团队空间页面展示与持久化状态不一致，非法 Promoto 后团队空间页面可见两个位置，但 directories 只有一个合法目录实体。 | ✅ |

---

### TC-05 Promote 后 Observer 可见 / 不可见

**目标**：验证目录可见性与最小暴露范围。\
**步骤**：

1. Promote 目录但不添加 Observer ✅
2. Observer 查看团队空间 /个人空间拉取视图 ✅
3. 将 Observer 加入该目录后再次查看 ✅

**预期结果**：

- 未授权时 Observer 不可查看目录 ✅
- 授权后可查看指定目录，不应看到未授权内容 ✅

**数据库反向验证**：✅

- `directory_permissions`：Observer 与 `directory_id` 的绑定关系正确

**禁止出现**：

- Observer 自动看到所有 Team 内容
- UI 隐藏但服务端仍可拉取数据

**Pass**

---

### TC-06 主动拉人 / 被动拉人

**目标**：验证 Owner 主动添加成员，以及通过 @ 被动拉人的权限绑定是否正确。\
**步骤**：

1. Owner 主动将 User B 加入 Observer 可见目录 TeamDirOwnerA ✅


2) 在 Observer 不可见目录 TeamDirOwnerA2中的笔记中 @ User C，触发被动拉入 ✅
3) 被拉入成员在本地 pull 团队目录内容 ✅

**预期结果**：

- 成员被正确加入目录 ✅
- 被动拉入的最小授权规则符合设计 ✅
- 本地出现 New 提示 ✅

**数据库反向验证**：✅

- `directory_permissions`：成员与 `directory_id` 绑定，角色为 `Team-member` 或设计指定角色
- `sync_logs`：存在目录拉取记录
- `collab_event_log` / 相关事件表：存在 @ 或邀请事件

**禁止出现**：

- @ 后获得超出预期的目录权限
- New 提示与实际拉取内容不一致

**Pass**

---

### TC-07 Promote 后目录重命名

**目标**：验证目录 rename 后身份不变。\
**步骤**：

1. 对已 Promote 的目录 TeamDirOwnerA 执行 rename 为 TeamDirOwnerA1 ✅
2. 同步完成后查看目录权限、成员、trash ✅

**预期结果**：

- `directory_id` 不变
- `current_path` 更新
- 权限、成员、trash 归属不丢失

**禁止出现**：

- rename 生成新的目录实例
- 原目录成员消失

**数据库反向验证**：❌

- `directories`：同一 `directory_id`，`current_path` 更新
- `directory_permissions`：仍绑定原 `directory_id`
- `team_trash_records`：历史 `directory_id` 不重算

```sql
SELECT
    fs.vault_id,
    v.name AS vault_name,
    fs.relative_path,
    fs.file_id,
    eu.username AS editor,
    pu.username AS pushed_by,
    fs.updated_at
FROM file_states fs
LEFT JOIN vaults v
    ON v.id = fs.vault_id
LEFT JOIN users eu
    ON eu.id = fs.editor_id
LEFT JOIN users pu
    ON pu.id = fs.pushed_by
WHERE fs.relative_path LIKE '%TeamDirOwnerA/%'
   OR fs.relative_path LIKE '%TeamDirOwnerA1/%'
ORDER BY fs.vault_id, fs.relative_path;

               vault_id               |   vault_name   |             relative_path              |               file_id                | editor | pushed_by |          updated_at           
--------------------------------------+----------------+----------------------------------------+--------------------------------------+--------+-----------+-------------------------------
 4f98fbed-44a1-4534-b641-cd64f27556b9 | Slash Test     | 01_PROJECTS/TeamDirOwnerA/A note 1.md  | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | aa     | aa        | 2026-04-15 22:40:07.585515+08
 4f98fbed-44a1-4534-b641-cd64f27556b9 | Slash Test     | 01_PROJECTS/TeamDirOwnerA1/A note 1.md | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | aa     |           | 2026-04-15 22:40:07.585515+08
 b6e854a2-9624-4a71-825e-8505507be34d | Personal Vault | 01_Projects/TeamDirOwnerA/A note 1.md  | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | bb     | bb        | 2026-04-16 12:12:02.714086+08
 cea4d00d-c801-4905-9b9b-b10facb32b99 | Personal Vault | 01_Projects/TeamDirOwnerA/A note 1.md  | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | aa     | aa        | 2026-04-15 18:02:28.216876+08
 cea4d00d-c801-4905-9b9b-b10facb32b99 | Personal Vault | 01_Projects/TeamDirOwnerA1/A note 1.md | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | aa     | aa        | 2026-04-16 13:40:21.522707+08
(5 rows)

SELECT
    fsp.vault_id,
    v.name AS vault_name,
    fsp.file_path,
    fsp.file_id,
    fsp.snapshot_type,
    u.username AS author,
    fsp.created_at
FROM file_snapshots fsp
LEFT JOIN vaults v
    ON v.id = fsp.vault_id
LEFT JOIN users u
    ON u.id = fsp.author_id
WHERE fsp.file_path LIKE '%TeamDirOwnerA/%'
   OR fsp.file_path LIKE '%TeamDirOwnerA1/%'
ORDER BY fsp.created_at DESC;

               vault_id               |   vault_name   |               file_path                |               file_id                | snapshot_type | author |          created_at           
--------------------------------------+----------------+----------------------------------------+--------------------------------------+---------------+--------+-------------------------------
 b6e854a2-9624-4a71-825e-8505507be34d | Personal Vault | 01_Projects/TeamDirOwnerA1/A note 1.md | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | create        | bb     | 2026-04-16 12:12:02.71282+08
 4f98fbed-44a1-4534-b641-cd64f27556b9 | Slash Test     | 01_PROJECTS/TeamDirOwnerA/A note 1.md  | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | create        | aa     | 2026-04-15 22:40:07.583202+08
 cea4d00d-c801-4905-9b9b-b10facb32b99 | Personal Vault | 01_Projects/TeamDirOwnerA1/A note 1.md | 9dfd0c79-8dde-45fa-8554-d169dd96c5ab | create        | aa     | 2026-04-15 18:02:28.216312+08
(3 rows)
```

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG18** | 目录 rename 后，Team Vault 的 file_states 旧路径未清理，产生同一文件双路径活跃状态。 | ✅ |
| **BUG19** | 目录 rename 后，成员侧 Personal Vault 的文件状态未同步更新到新路径。 | ✅ |
| **BUG20** | 目录 rename 后，file_snapshots 与 file_states 的路径状态不一致。 | ✅ |

---

## 模块 C：团队文件权限控制

### TC-08 文件 Solo / Collab 切换

**目标**：验证文件模式切换对编辑权限的影响。\
**步骤**：

1. 创建团队笔记
2. 切换A note 1 为 Solo 模式，其他成员尝试编辑
3. 切换为 Collab 模式，其他成员再次尝试编辑

**预期结果**：

- Solo 模式下其他成员不可编辑 ✅
- Collab 模式下其他成员可编辑 ✅

**禁止出现**：

- UI 阻止但服务端仍写入编辑内容 ✅
- 模式切换后权限缓存未刷新 ✅

**数据库反向验证**：✅

- `file_states`：文件记录存在且 `file_id` 稳定
- `file_status_events` / 权限相关记录：模式切换事件可追踪

**TC-08 BUG 清单：**

| 编号 | 简述 | 状态 |
| --- | --- | --- |
| **BUG21** | **React Hooks 闭包导致 Editor 强行漂移**：`useContentPersistence` 中的 `saveContent` 漏写 `isTeamNote` 依赖，导致闭包永远锁定在初始的 `false`。协同编辑时系统被误导，认为这是 Personal 笔记，从而触发防篡改逻辑强行把 YAML `editor` 覆盖为当前编辑者。 | ✅ 已修复 |
| **BUG22** | **Personal Sync 物理隔离防线崩溃导致“首次创建”幻象**：客户端 `personal.rs` 处理同步时，直接扫描整个 `root` 硬盘却未剔除 `.slash/team_path_mappings.json` 中的 Team 目录。这导致刚从远程 PULL 下来的 Team 文件，被当成纯正的本地私人文件打包 PUSH 给了服务器。服务器在 Personal 空间找不到历史，自然判定为“全新创建”，并写入了推流者作为 `editor_id` 与 `create` 快照，导致严重的语义污染。 | ✅ 已修复 |

---

### TC-09 Editor 删除本人笔记

**目标**：验证 Editor 仅能删除本人笔记。\
**步骤**：

1. Editor aa 创建自己的团队笔记 01_Projects/TeamDirOwnerA01/A note 1.md
2. 执行删除

**预期结果**：

- 删除成功
- 笔记进入上级目录回收站

**数据库反向验证**：

- `file_states`：文件标记删除或从活跃路径移除
- `team_trash_records`：新增记录，带正确 `directory_id` / `file_id`

**禁止出现**：

- 删除成功但无 trash 记录
- `file_id` 丢失

---

### TC-10 他人删除他人笔记失败

**目标**：验证除本人外，他人不可在个人空间团队目录中删除该笔记。\
**步骤**：

1. A 创建团队笔记
2. B（Owner / Admin / Team-member）尝试删除 A 的笔记

**预期结果**：

- 删除失败
- 无数据库副作用

**数据库反向验证**：

- `file_states`：无删除变化
- `team_trash_records`：无新增

**禁止出现**：

- 服务端越权删除成功
- 写入错误 trash 记录

---

### TC-11 Team-member 新建 / 移入自己的笔记

**目标**：验证 Team-member 可新建或移入自己的笔记。\
**步骤**：

1. Team-member 在目录中新建笔记
2. 将个人笔记移入团队目录

**预期结果**：

- 操作成功
- 归属与权限链正确

**数据库反向验证**：

- `file_states`：新文件 / 移入文件的 `current_path` 与 `file_id` 正确
- `file_snapshots`：存在合理快照

**禁止出现**：

- 移入后失去文件身份
- 归属目录错误

---

## 模块 D：团队目录权限控制

### TC-12 Owner 主动添加成员

**目标**：验证仅目录 Owner 可主动添加成员。\
**步骤**：

1. Owner 添加成员
2. 非 Owner 尝试添加成员

**预期结果**：

- Owner 成功
- 非 Owner 失败

**数据库反向验证**：

- `directory_permissions`：仅 Owner 操作产生新增绑定

**禁止出现**：

- 非 Owner 也能写入成员关系

---

### TC-13 Team-member 创建子目录

**目标**：验证 Team-member 可在目录内创建子目录，且子目录归属正确。\
**步骤**：

1. Team-member 在团队目录中创建子目录

**预期结果**：

- 子目录创建成功
- 子目录 Owner 为创建人
- 父目录 Owner 自动成为该子目录 Team-member

**数据库反向验证**：

- `directories`：新增子目录实体
- `directory_permissions`：创建人与子目录 `Owner` 绑定；父目录 Owner 与子目录有成员绑定

**禁止出现**：

- 子目录没有独立身份
- 父目录 Owner 丢失对子目录的访问能力

---

### TC-14 仅目录 Owner 可删除目录

**目标**：验证目录删除权限。\
**步骤**：

1. 非 Owner 尝试删除目录
2. Owner 删除空目录

**预期结果**：

- 非 Owner 失败
- Owner 可删除空目录

**数据库反向验证**：

- `directories`：删除时 `deleted_at` 更新
- `team_trash_records`：如有墓碑，归属正确

**禁止出现**：

- 非 Owner 删除成功

---

### TC-15 含他人内容的目录不可删除

**目标**：验证目录中存在他人笔记或子目录时，Owner 也不能删除。\
**步骤**：

1. 在目录中放入他人笔记或他人创建子目录
2. 当前目录 Owner 尝试删除

**预期结果**：

- 删除失败

**数据库反向验证**：

- `directories`：无 `deleted_at` 变化
- `team_trash_records`：无新增

**禁止出现**：

- 部分级联删除
- 失败后残留半成品 trash

---

## 模块 E：删除 / 恢复 / 回收站

### TC-16 删除文件进入上级目录回收站

**目标**：验证文件删除后归属到上级目录回收站。\
**步骤**：

1. 删除团队文件
2. 查看上级目录回收站

**预期结果**：

- 文件出现在上级目录回收站

**数据库反向验证**：

- `team_trash_records`：存在正确 `directory_id` / `file_id` 记录

**禁止出现**：

- 错挂到物理子目录
- 路径前缀误归属

---

### TC-17 上级目录 Owner 恢复文件 / 目录

**目标**：验证恢复权限和命名冲突处理。\
**步骤**：

1. 删除文件或目录
2. 上级目录 Owner 执行恢复
3. 若存在同名对象，验证重命名为原名 + recover

**预期结果**：

- 恢复成功
- 同名冲突按规则重命名

**数据库反向验证**：

- `team_trash_records`：记录被移除或标记恢复
- `file_states` / `directories`：对象重新出现在活跃路径

**禁止出现**：

- 恢复覆盖现存对象
- 恢复后身份错乱

---

### TC-18 PARA 根目录恢复权限为 Admin

**目标**：验证根级恢复权限。\
**步骤**：

1. 在 PARA 根级回收站执行恢复
2. 分别使用 Admin / 非 Admin 测试

**预期结果**：

- 仅 Admin 可恢复

**数据库反向验证**：

- 非 Admin 恢复不产生任何写入

**禁止出现**：

- 非 Admin 越权恢复成功

---

### TC-19 同名目录删除后重建，再查看 trash

**目标**：验证新目录不继承旧目录 trash。\
**步骤**：

1. 删除目录 A
2. 重建同名目录 A
3. 查看新目录的回收站

**预期结果**：

- 新目录看不到旧目录 trash

**数据库反向验证**：

- `directories`：新旧目录 `directory_id` 不同
- `team_trash_records`：旧记录仍绑定旧 `directory_id`

**禁止出现**：

- 新目录看到旧垃圾

---

## 模块 F：协作（快照 / 评论 / 批注）

### TC-20 创建快照

**目标**：验证笔记创建时生成初始快照。\
**步骤**：

1. 新建团队笔记

**预期结果**：

- 生成创建快照

**数据库反向验证**：

- `file_snapshots`：存在对应 `file_id` 的创建快照

**禁止出现**：

- 新建无快照

---

### TC-21 编辑快照 Idle 300 聚合

**目标**：验证编辑快照按 Idle 300 规则聚合。\
**步骤**：

1. 连续多次编辑并保存
2. 在 300 秒内与跨 300 秒各测一轮

**预期结果**：

- 阈值内聚合
- 跨阈值拆分为多条快照

**数据库反向验证**：

- `file_snapshots`：数量与时间分布符合预期

**禁止出现**：

- 每次编辑都生成快照
- 应拆分的未拆分

---

### TC-22 评论 / 批注

**目标**：验证 team-member 可发表评论和文字批注。\
**步骤**：

1. team-member 在团队笔记上发表评论
2. team-member 选择文字添加批注

**预期结果**：

- 评论和批注创建成功

**数据库反向验证**：

- `doc_comments`：按 `file_id` 关联正确
- `annotations`：按 `file_id` 关联正确

**禁止出现**：

- 仅路径关联，rename 后丢失

---

### TC-23 rename 后评论 / 批注不丢

**目标**：验证文件 rename 后协作内容仍稳定。\
**步骤**：

1. 对文件添加评论与批注
2. rename 文件
3. 再次查看评论与批注

**预期结果**：

- 评论 / 批注仍存在且可访问

**数据库反向验证**：

- `doc_comments` / `annotations`：仍按同一 `file_id` 关联
- `file_states`：同一 `file_id`，`current_path` 更新

**禁止出现**：

- rename 后协作内容丢失

---

## 模块 G：协作通知（小红点）

### TC-24 协作后小红点向其他成员广播

**目标**：验证团队内容发生更新后，小红点能向其他相关成员正确广播。\
**前置条件**：至少两名有权限访问该目录/文件的成员。\
**步骤**：

1. A 在团队笔记中执行会触发通知的协作动作（如编辑、评论、批注）
2. B 登录或刷新个人空间 / 团队视图
3. C 登录或刷新个人空间 / 团队视图

**预期结果**：

- 除操作者本人外，其他相关成员出现小红点
- 无权限成员不出现小红点

**数据库反向验证**：

- `collab_event_log`：存在协作事件
- `collab_read_cursors` / `collab_consumed_cursors`：其他成员未读状态正确
- `file_status_events` / 通知相关状态表：存在未读标记或可推导未读状态

**禁止出现**：

- 操作者本人也收到自己的小红点
- 无权限成员收到小红点
- 广播不完整，部分相关成员漏掉

---

### TC-25 点击小红点后阅后消除

**目标**：验证成员点击小红点或进入对应内容后，未读状态被正确消费。\
**步骤**：

1. B 看到某目录 / 文件小红点
2. B 点击对应小红点或进入对应内容
3. 返回列表再次查看

**预期结果**：

- 对应小红点消失
- 其他未读项保留

**数据库反向验证**：

- `collab_read_cursors`：B 的游标推进
- `collab_consumed_cursors`：消费记录更新

**禁止出现**：

- 一个点消掉导致全部未读一起消失
- UI 消失但数据库未更新

---

### TC-26 点击扫把一键清空小红点

**目标**：验证一键清空未读通知。\
**步骤**：

1. 制造多个目录 / 文件未读小红点
2. 点击扫把清空
3. 刷新页面再次查看

**预期结果**：

- 当前用户全部相关小红点消失
- 其他成员的小红点不受影响

**数据库反向验证**：

- `collab_read_cursors` / `collab_consumed_cursors`：当前用户所有可清空项目状态更新
- 其他用户记录不变化

**禁止出现**：

- 清空影响其他成员
- 仅 UI 清空，刷新后又全部出现

---

## 模块 H：团队空间 / 个人空间关系

### TC-27 个人空间是团队内容生产主阵地

**目标**：验证团队内容主要在个人空间中的团队目录里完成生产与消费。\
**步骤**：

1. 在个人空间团队目录中创建 / 编辑 / 删除 / 查看团队内容
2. 检查团队空间展示

**预期结果**：

- 操作在个人空间完成
- 团队空间正确反映结果

**数据库反向验证**：

- `file_states` / `directories` / `sync_logs`：状态一致

**禁止出现**：

- 团队空间与个人空间状态不一致

---

### TC-28 团队空间图书馆 / Admin 整理能力

**目标**：验证团队空间主要用于浏览，Admin 在维护模式下可整理。\
**步骤**：

1. 非 Admin 在团队空间尝试移动 / 删除目录和笔记
2. Admin 在维护模式关闭时尝试移动 / 删除
3. Admin 开启维护模式后再次尝试

**预期结果**：

- 非 Admin 不可操作
- Admin 关闭维护模式不可操作
- Admin 开启维护模式可操作

**数据库反向验证**：

- 非法操作不写数据库
- 合法操作有正确写入

**禁止出现**：

- 非 Admin 越权整理
- Admin 关闭维护模式仍可改动

---

### TC-29 团队空间复制 / 粘贴限制

**目标**：验证团队空间笔记上复制、粘贴限制。\
**步骤**：

1. 在团队空间尝试复制 / 粘贴内容

**预期结果**：

- 系统按设计限制复制 / 粘贴

**数据库反向验证**：

- 不应产生内容变更写入

**禁止出现**：

- 前端禁用但通过其他路径仍提交成功

---

## 模块 I：Sync / UUID 稳定性

### TC-30 新建笔记后立刻 rename

**目标**：验证不再出现幽灵删除。\
**步骤**：

1. 新建团队笔记
2. 立刻 rename
3. 等待 sync 完成

**预期结果**：

- 无幽灵删除
- 系统识别为 rename

**数据库反向验证**：

- `file_states`：同一 `file_id`，仅路径变化
- `team_trash_records`：无旧路径误删记录
- `file_snapshots`：存在 rename 快照或等价记录

**禁止出现**：

- 旧名称进入 trash
- 新旧两条活跃文件记录并存

---

### TC-31 目录 rename 后文件归属稳定

**目标**：验证目录 rename 后文件仍归属原目录实例。\
**步骤**：

1. rename 团队目录
2. 查看目录内文件

**预期结果**：

- 目录 `directory_id` 不变
- 文件权限 / 成员 / trash 归属保持正确

**数据库反向验证**：

- `directories`：同一 `directory_id`
- `file_states`：路径随目录变化更新
- `directory_permissions`：绑定不丢

**禁止出现**：

- 目录 rename 后文件被视为新归属

---

### TC-32 同路径新建新文件

**目标**：验证路径复用不会复用旧文件身份。\
**步骤**：

1. 删除某文件
2. 在同一路径新建新文件

**预期结果**：

- 新文件获得新的 `file_id`

**数据库反向验证**：

- `file_states`：新旧记录身份不同
- `team_trash_records`：旧记录仍绑定旧 `file_id`

**禁止出现**：

- 新文件复用旧 `file_id`

---

### TC-33 无 `slash_id` 文件进入系统

**目标**：验证无 UUID 文件的兼容行为。\
**步骤**：

1. 导入一个无 `slash_id` 的 markdown 文件
2. 导入一个二进制文件
3. 执行 sync

**预期结果**：

- 系统按设计生成或分配 `file_id`
- 不影响正常同步

**数据库反向验证**：

- `file_states`：对应文件存在 `file_id`

**禁止出现**：

- 无 `file_id` 文件进入活跃同步链路后状态混乱

---

## 五、执行建议

### 先测 P0 主链路

建议优先执行：

- TC-01 \~ TC-07
- TC-08 \~ TC-19
- TC-30 \~ TC-33

### 再测协作与通知

- TC-20 \~ TC-26

### 最后测团队空间与外围能力

- TC-27 \~ TC-29

---

## 六、结果记录建议

建议每条用例补一列：

- 结果：Pass / Fail
- 实际行为
- 对应 SQL 证据
- 是否符合 UUID-first 语义

这样最后可以形成一份完整的 **Team 功能数据库验收矩阵**。