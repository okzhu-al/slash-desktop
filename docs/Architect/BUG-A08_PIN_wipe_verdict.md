# 架构师裁决：BUG-A08 PIN 码被团队创建冲掉的根因与修复方案

> **严重程度**: 🔴 Critical (数据丢失 + 认证死锁)
> **关联报告**: 
> - Developer: `docs/Developer/auth_persistence_and_mode_transition_conflict.md`
> - QA-Tester: `docs/QA-Tester/20260419_Live_Test_Session_01.md` (场景 06)

---

## 1. 根因定案（Root Cause Verdict）

开发的分析方向大体正确，但**定位偏了**。他怀疑的是 `create_team` 本身会清除 PIN，实际上 `create_team`（`team/core.rs`）**完全没有碰过 `server_settings` 中的 `pin` 字段**。它唯一做的和 `server_settings` 有关的操作是删掉 `access_code`（配对码用后即废），这是正确且安全的。

**真正的凶手是: `POST /api/server/request-new-code`**（位于 `server.rs:L167-L265`）

关键代码（`server.rs:L253-256`）:
```rust
// 清除旧 PIN，迫使用户重新设置
sqlx::query("DELETE FROM server_settings WHERE key = 'pin'")
    .execute(&state.pool)
    .await?;
```

这个端点的**设计原意**是："当用户忘了密码/PIN，需要重新生成配对码时，连同旧 PIN 一起清除，迫使用户重新走一遍完整的安全初始化流程"。这在"只有一个用户"的个人空间场景下没有问题。

**但在多用户（Personal + Team 共存）场景下它变成了一颗核弹**：

### 完整的事故链路（Kill Chain）
```
1. Join 用户先创建了个人空间，设置了 PIN → server_settings 里有 pin 记录
2. 配对码被 Join 消耗 → access_code 被删除
3. Admin 用户想创建团队 → 发现没有 access_code 了
4. 前端调用 /api/server/request-new-code 重新生成配对码
5. request-new-code 内部同时执行了 DELETE pin ← 💀 这一步就是凶手
6. Admin 拿到新配对码创建了团队 → 成功
7. Join 再想用 PIN 连接 → 后端回应 "PIN not set" → 死锁
```

---

## 2. 架构层面的本质问题

当前将 PIN 作为 `server_settings` 中的**单一全局 Key** 存储，是一个典型的**"单租户设计被强拉进多租户场景"**的架构债务。

在 Personal-only 时代，`pin` 就是"这台服务器的主人密码"。一旦开始承载多个独立用户（Personal User + Team Admin + Team Member），这个全局锁就变成了**共享锁**，任何人的重置操作都会把其他人的凭证一并炸掉。

---

## 3. 最优修复方案

### 方案评估矩阵

| 方案 | 改动范围 | 风险 | 推荐 |
|:---|:---|:---|:---|
| A. `request-new-code` 去掉 PIN 删除 | 1 行 | 低 | ⭐️⭐️⭐️ 立即执行 |
| B. PIN 从全局迁移到 per-user | 多表重构 | 高 | 中长期 |
| C. `create_team` 流程绕过 `request-new-code` | 前端改 | 中 | 备选 |

### ⭐️ 推荐方案 A：精准外科手术（立即执行）

**核心判断**：`request-new-code` 清除 PIN 的行为，在多用户场景中**收益为零、破坏力为满**。

重新生成配对码的目的是让用户能够重新认证，而不是强迫他们重新设置 PIN。这两个操作应该彻底解耦。

**修改点**（`apps/server/src/routes/server.rs`）:
```diff
-    // 清除旧 PIN，迫使用户重新设置
-    sqlx::query("DELETE FROM server_settings WHERE key = 'pin'")
-        .execute(&state.pool)
-        .await?;
-
-    tracing::info!("New access code requested, old PIN cleared");
+    tracing::info!("New access code requested (PIN preserved)");
```

就这么简单：**删掉 L253-L256 这 3 行**。

**为什么这是安全的**：
1. PIN 本身已经有 Argon2 hash 保护（`server.rs:L93-L103`），不需要通过物理删除来"强制重置"。
2. 如果用户真的忘了 PIN，他们可以用新生成的配对码重新走 `/pair`（走 access_code 路径），然后通过 `/pin` 端点设置新的 PIN（UPSERT，会自动覆盖旧值）。
3. 删除 PIN 对于**其他用户**来说是灾难性的"附带损害（Collateral Damage）"，这种操作在多租户架构中绝对不允许。

### 中长期方案 B（备忘）
如果后续发展到 SaaS 级别的多租户模式，需要将 PIN 绑定到具体的 `user_id` 上（per-user PIN），而不是作为全局 `server_settings` 的 Key-Value。但当前阶段没有必要引入这个级别的重构。

---

## 4. 给开发的指令

1. **执行方案 A**：删除 `server.rs` 中 `request-new-code` 函数里的 PIN 清除逻辑（3 行代码）。
2. **前端清理**：检查 `useSyncFlow.ts` 中所有调用 `request-new-code` 的地方，确认不再依赖"调用后 PIN 被清除"的副作用假设。我看到 L971 已经有一条注释 `// 注意：不在这里调 request-new-code（会清除 PIN，导致返回时死循环）`，说明开发其实已经意识到了这个副作用，只是选择了在前端绕路而非从根上修掉它。现在我们从根上修。

## 5. 给测试的指令

修复落地后，请执行完整回归：
1. Join 创建个人空间 + 设置 PIN ✓
2. Admin 调用 `request-new-code` 获取新配对码
3. Admin 用新配对码创建团队
4. **关键检查**：穿透 `server_settings` 表，验证 `pin` 那一行**依然存在**
5. Join 用 PIN 重新连接 → 应通过认证

---

**架构师签发。2026-04-19**
