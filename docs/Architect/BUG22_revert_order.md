# 架构师勘误令：撤销 BUG22 路径过滤器

> **优先级**: 🔴 P0 — 立即执行
> **类型**: 架构师自纠（Architect Self-Correction）
> **关联**: 对此前 `sync_propagation_verdict.md` 的补充修正

---

## 背景

在此前对 editor 漂移问题的排查中，我（架构师）错误地将 Personal Sync 扫描到团队文件判定为"越界行为"，并在 `personal.rs` 中植入了路径过滤器将团队映射目录从 Personal Sync 中踢出。

**这个判断是错误的。** 正确的架构语义是：

```
Personal Sync = 全量底座（所有文件都走，包括团队文件）
Team Sync     = 叠加层（团队文件额外走一次团队同步）
```

editor 漂移的真正根因是 BUG21（React 闭包陷阱导致 `isTeamNote` 永远为 `false`，使 `saveContent` 在保存时篡改 frontmatter 的 `editor` 字段）。BUG21 的 `isTeamNoteRef` 修复已经从源头阻断了 editor 篡改。**Personal Sync 推送团队文件是正常行为，不需要额外过滤。**

我错误植入的过滤器使团队映射目录下的文件被 Personal Sync 跳过，叠加上 `team_sync_state.json` 不存在导致 Team Sync 也不启动，造成了这些文件彻底无法同步的"无主之地"问题。

---

## 执行指令

### 修改文件
`apps/desktop/src-tauri/src/commands/sync/personal.rs`

### 具体操作
**删除** L56-L71 的整个路径过滤块，恢复为直接使用全量扫描结果：

```diff
     // Phase 2: 个人同步（团队 pull 后本地已是最新，直接推到个人云端）
     // ============================================================

-    // Step 1: 扫描本地文件生成 manifest（必须剔除属于 Team 映射的路径）
-    // 🛡️ 物理隔离防线：阻止团队拉取的文件被打包作为 Personal 文件强行 PUSH
-    use super::path_mapping::{TeamPathMappingsFile, normalize_prefix};
-    let mappings_path = root.join(".slash").join("team_path_mappings.json");
-    let mapped_prefixes: Vec<String> = TeamPathMappingsFile::load(&mappings_path)
-        .teams
-        .values()
-        .flat_map(|m| m.keys())
-        .map(|k| normalize_prefix(k))
-        .collect();
-
-    let all_manifests = scan_directory_manifests(&root);
-    let manifests: Vec<_> = all_manifests
-        .into_iter()
-        .filter(|m| !mapped_prefixes.iter().any(|prefix| m.relative_path.starts_with(prefix)))
-        .collect();
+    // Step 1: 扫描本地文件生成 manifest（全量扫描，团队文件同样走 Personal Sync 备份）
+    let manifests = scan_directory_manifests(&root);
```

### 不要动的代码
- `useContentPersistence.ts` 中的 `isTeamNoteRef` 修复 — 这是 BUG21 的正确修复，必须保留。
- `promote.rs` 中新增的 `team_sync_state.json` 写入 — P0 修复，保留。
- `team.rs` 中新增的 `read_known_team_vault_id` fallback — P1 修复，保留。
- `homestead.rs` 的深度修复 — P2 修复，保留。

---

## 验证清单（修改完成后自检）

1. `cargo check` 编译通过（确认 `path_mapping` 的 `use` 语句如果没有其他引用可一并清理）
2. 检查 `personal.rs` 中是否还有其他地方引用了 `mapped_prefixes` 或 `TeamPathMappingsFile`，如有则一并清理

## 交付要求

修改完毕后：
1. 运行 `cargo check` 确保编译通过
2. 在修复报告 `Sync_Propagation_Fix_Report.md` 中追加本次变更记录
3. 通知架构师复检

---

**架构师签发。2026-04-19**
**性质：自纠令 — 此前 BUG22 的路径过滤修复为架构师本人的误诊，特此勘误。**
