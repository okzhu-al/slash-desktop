# ⚖️ 架构判定：Team Sync 传播失效（Joiner 场景）深度调查报告

## 1. 故障表现分析

在 Joiner 加入团队并 Promote 个人空间目录后，出现以下差异化表现：

| 场景 | 文件路径示例 | 同步状态 | 快照状态 | 判定逻辑节点 |
| :--- | :--- | :--- | :--- | :--- |
| **Fail** | `01_Projects/Join Folder/Join note 01.md` (旧文件) | ❌ 忽略 | ❌ 未生成 | Server: Negotiate Filter (Scope) |
| **Fail** | `01_Projects/Join Folder/Join note 02.md` (新文件) | ❌ 忽略 | ❌ 未生成 | Client: Scanning Guard (Isolation) |
| **OK** | `01_Projects/Join note 03.md` (根级新文件) | ✅ 正常 | ✅ 正常 | Client: Root Pass |
| **OK** | `01_Projects/Join Folder 2/Join note 04.md` (新目录) | ✅ 正常 | ✅ 正常 | Client: Unmanaged Pass |

---

## 2. 核心根因 A：前端“独立子目录”过激隔离
**代码位置**：`apps/desktop/src-tauri/src/commands/sync/team.rs` (build_team_mapped_files)

### 故障机制：
目前代码中存在一个旨在隔离“嵌套 Mapping”的 Guard 逻辑（Line 822）。当满足以下条件时，扫描引擎会跳过该路径：
1. 该子目录出现在服务器下发的 `managed_dirs` 清单中（即该目录在服务器上已经有权限记录或已被他人认领）。
2. **且** 当前用户本地**没有**为该子目录建立显式的独立 Mapping。

### 结论：
`Join Folder` 是迁移过来的旧文件夹，在服务器上属于 `Managed` 状态。由于 Join 仅建立了 `01_Projects` 的父级映射，导致 `Join Folder` 被判定为“第三方 Silo”，从而在扫描阶段就被阻断，根本没有进入同步队列和快照流。

---

## 3. 核心根因 B：服务器 Homesteading 深度漏洞
**代码位置**：`apps/server/src/routes/sync/homestead.rs` (process_homesteading)

### 故障机制：
服务器在处理 `accepted` 推送列表时，会尝试自动认领（Homesteading）目录所有权。
```rust
for depth in 2..parts.len() {
    let scope_dir = parts[..depth].join("/");
    claimed_dirs.insert(scope_dir);
}
```
### 结论：
1. **深度阈值错误**：循环起始于 2，而 PARA 根目录（如 `01_Projects`）的深度恰好为 1。
2. **权限缺失**：Join 在 Promote 时，服务器未能自动为其创建 `01_Projects` 的 `directory_permissions` 记录。
3. **Negotiate 拦截**：在同步协商阶段，服务器检测到文件路径的前缀没有对应的权限记录（Sync Scope 不匹配），直接跳过对比。这就是为何“编辑旧文件”无法被 Negotiate 发现并触发 PUSH 的原因。

---

## 4. 判定结论与建议

此问题并非同步引擎本身功能损坏，而是**权限认领机制（后端）**与**隔离扫描逻辑（前端）**在“父级目录映射涵盖子级 Managed 目录”场景下的不兼容。

### 建议操作：
1. **后端**：修正 `homestead.rs` 循环阈值，允许认领深度 1 的目录。
2. **前端**：调整 `team.rs` 中的隔离逻辑，允许同一 Vault 内的父级映射管理未分配的 Managed 子目录。

---
**核准人**：架构师/开发者 (Antigravity 辅助调查)
**日期**：2026-04-19
