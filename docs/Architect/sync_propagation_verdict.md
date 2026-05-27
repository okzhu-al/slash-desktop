# 架构师审阅：Sync Propagation Failure — 定案裁决

> **审阅对象**: `docs/Developer/Sync_Propagation_Correction_Investigation.md`
> **结论**: 开发报告方向大体正确，但**定位散乱，遗漏了一个关键的交叉因素**。

---

## 一、对开发四项原因的逐项裁定

### ✅ 原因 A（team_sync_state.json 未更新）—— 判定：正确，且是 **唯一的主因**

代码铁证如下：

```rust
// team.rs L28-L41
pub(super) async fn sync_team_full(...) {
    let known_vault_id = read_known_team_vault_id(root);  // 读 team_sync_state.json
    if let Some(vid) = known_vault_id {
        return sync_team_single(...).await;
    }
    Ok((0, 0, vec![], vec![]))  // ← 没写过这个文件就直接跳过，静默返回零
}
```

而 `promote.rs`（L232-L240）只写了 `team_path_mappings.json`，**从头到尾没有一行代码写 `team_sync_state.json`**。我搜遍了整个 `desktop` 代码库，写入 `team_sync_state` 的地方极为有限。

**结果**：如果用户不是通过标准的"加入团队"流程进入（那个流程会写 `team_sync_state.json`），而是通过 Promote 操作间接触发团队同步，后台 AutoSync 就永远不会调用团队同步引擎。日志完美印证了这一点——22:48:10 和 22:48:23 **只有 Personal Negotiate 请求，零条 Team 请求**。

### ⚠️ 原因 B（403 身份漂移）—— 判定：真实存在，但属于**独立 BUG，与本次现象无直接关联**

开发把它混在一起分析了，但从你给的日志来看，本次操作并没有触发 403。这应该被拆分为独立的 BUG 单独追踪，不要和同步丢失混为一谈。

### ❌ 原因 C（大小写冲突）—— 判定：**红鲱鱼（Red Herring）**，分析不准确

开发说 `build_team_mapped_files` 的 `starts_with` 是大小写敏感的，会导致匹配失败。但他忽略了一个关键事实：**路径映射本身就承担了大小写转换的职责**。

```
path_mappings: { "01_Projects/Join Folder" → "01_PROJECTS/Join Folder" }
```

`build_team_mapped_files` 检查的是 `m.relative_path.starts_with(&src_prefix)`，其中 `src_prefix` 来自 `path_mappings` 的 **key**（即 `01_Projects/`），而本地磁盘扫描出来的路径也是 `01_Projects/`。两者大小写一致，`starts_with` 可以正常匹配。大小写转换只在构建 `target_path` 时才发生。

所以 Cause C 在本场景中不成立。

### ⚠️ 原因 D（Homesteading 深度截断）—— 判定：**真实但属于次生问题**

`2..parts.len()` 确实会跳过根级 PARA 目录的权限注册。但这影响的是**非 Admin 用户的 PULL 权限**，不是当前 Join 用户（Admin/Owner）的 PUSH 可见性。它是一个需要修复的独立缺陷，但不是本次"文件彻底不同步"的根因。

---

## 二、开发 **完全遗漏** 的关键因素

开发的报告完全没有提及我之前为修复 BUG22 而在 `personal.rs` 中植入的**团队路径过滤器**。这是拼图的另一半。

```rust
// personal.rs L56-L70 (我的 BUG22 修复)
let mapped_prefixes: Vec<String> = TeamPathMappingsFile::load(&mappings_path)
    .teams.values().flat_map(|m| m.keys())
    .map(|k| normalize_prefix(k)).collect();

let manifests: Vec<_> = all_manifests.into_iter()
    .filter(|m| !mapped_prefixes.iter().any(|prefix| m.relative_path.starts_with(prefix)))
    .collect();
```

**这段代码做的事情是**：凡是出现在 `team_path_mappings.json` 中的路径，一律从 Personal Sync 的扫描结果中剔除。

### 🔴 致命交叉效应（The Lethal Intersection）

| 步骤 | 发生了什么 | Personal Sync | Team Sync |
|:---|:---|:---|:---|
| 1. Promote 完成 | `team_path_mappings.json` 被写入映射 | 过滤器生效 → 文件被**踢出** ❌ | — |
| 2. 后台 AutoSync 启动 | 读取 `team_sync_state.json` | — | 文件不存在或无 vault_id → **静默跳过** ❌ |
| 3. 结果 | — | **不管** | **不管** |

**文件被两个引擎同时抛弃，进入了"无主之地（No Man's Land）"。**

在我实施 BUG22 修复之前，即使团队同步没有启动，这些文件至少还能通过 Personal Sync"兜底"同步上去（虽然会带来元数据污染）。现在我的修复正确地阻断了这条"脏路径"，但前提条件——团队同步引擎必须可靠运行——并没有被满足。**这就是你直觉感觉"不对头"的根本原因。**

---

## 三、定案结论与修复优先级

| 优先级 | 修复项 | 改动点 |
|:---|:---|:---|
| **P0** | Promote 完成后必须写入 `team_sync_state.json` | `promote.rs` 末尾追加 vault_id 写盘 |
| **P1** | `sync_team_full` 兜底：即使 `team_sync_state.json` 缺失，也应从 `team_path_mappings.json` 推断 vault_id | `team.rs` `read_known_team_vault_id` 增加 fallback |
| **P2** | Homesteading 根目录权限注册 | `homestead.rs` 循环起点从 2 改为 1 |
| **P3** | 403 身份漂移 | 独立 BUG，单独排查 |

### P0 的具体修复指令（给开发）

在 `promote.rs` 的 L240（`mappings_file.save` 之后），追加写入 `team_sync_state.json`：

```rust
// promote.rs — Promote 完成后激活后台团队同步
let team_state_path = root.join(".slash/team_sync_state.json");
let team_state = serde_json::json!({ "vault_id": target_vault_id });
if let Ok(json) = serde_json::to_string_pretty(&team_state) {
    let _ = std::fs::write(&team_state_path, json);
    log::info!("[Promote] Activated team sync: wrote vault_id={} to team_sync_state.json", target_vault_id);
}
```

### P1 的具体修复指令（给开发）

修改 `read_known_team_vault_id`，增加从 `team_path_mappings.json` 推断的 fallback：

```rust
fn read_known_team_vault_id(root: &std::path::Path) -> Option<String> {
    // 主路径：从 team_sync_state.json 读取
    let state_path = root.join(".slash/team_sync_state.json");
    if let Ok(raw) = std::fs::read_to_string(&state_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(vid) = json.get("vault_id").and_then(|v| v.as_str()) {
                if !vid.is_empty() { return Some(vid.to_string()); }
            }
        }
    }
    // Fallback：从 team_path_mappings.json 推断（取第一个团队的 vault_id）
    let mappings_path = root.join(".slash/team_path_mappings.json");
    let mappings = super::path_mapping::TeamPathMappingsFile::load(&mappings_path);
    mappings.teams.keys().next().cloned()
}
```

---

**架构师签发。2026-04-19**

> 致开发：你的调查报告展示了很好的日志分析功底，原因 A 的判断准确。但作为工程师，要养成**追踪交叉依赖**的习惯——一个模块的"正确修复"可能会让另一个模块的"隐藏缺陷"从无害变为致命。这次的 Personal 过滤器 + Team 同步缺失的组合拳就是典型案例。
