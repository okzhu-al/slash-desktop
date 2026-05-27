# BUG-E07：Admin 删除 Team 目录/文件后本地不清理

> **严重等级**：P0  
> **影响范围**：Admin 发起的所有 Team Space 删除操作  
> **签发人**：架构师  
> **签发时间**：2026-04-21

---

## 一、故障现象

| 角色 | 删除后行为 | 预期行为 |
|------|-----------|---------|
| Admin（发起者） | 本地文件残留，Personal Vault `is_deleted=f` | 本地文件删除，Personal Vault `is_deleted=t` |
| bb（成员） | 首次登录正确删除，**二次登录空壳目录复活** | 永久删除 |
| cc（成员） | 首次登录正确删除，不复活 | ✓ 正确 |

---

## 二、根因（架构师已确认）

**权限-数据时序坍塌**：`delete_directory` 事务内部执行顺序为：

```
① DELETE FROM directory_permissions   ← 权限先消失
② UPDATE file_states SET is_deleted = true  ← 数据后标记
```

后续 `forceSync()` 触发的 sync engine **双端都依赖 `directory_permissions` 决定 sync scope**：

- **客户端**：`get_team_scope()` → `scope_dirs` 不含已删目录 → `resolve_source_dirs` 排除该目录 → `mapped_files` 不包含目标文件 → `client_files` 不上报
- **服务端**：`get_sync_scope_filter()` → `permitted_dirs` 不含已删目录 → `server_files` 排除目标文件 → `server_deleted` 无法下发

**结果**：双端对该文件视而不见，删除指令永远无法传播，本地文件成为永久幽灵。

---

## 三、修复指令

### 修复 1（P0 核心）：前端 `handleAdminDeleteDir` 增加本地清理

**文件**：`apps/desktop/src/features/sidebar/hooks/useTeamAdminActions.ts`  
**函数**：`handleAdminDeleteDir`（第 86 行）

**原则**：删除发起者必须自行清理本地副本，不能依赖 sync engine 间接传播。

在 `deleteDirectory` API 调用成功后、`forceSync` 之前，增加以下逻辑：

```typescript
// ---- 在 toast.success 之后，refreshTeamData 之前插入 ----

// 🛡️ BUG-E07 Fix 1: Admin 主动清理本地物理文件 + unified_sync_state
const physicalPaths = resolveTeamToPhysicalPaths(dirPath);
for (const physPath of physicalPaths) {
    try {
        const { exists, remove } = await import('@tauri-apps/plugin-fs');
        if (await exists(physPath)) {
            await remove(physPath, { recursive: true });
            console.log(`[AdminDeleteDir] Purged local: ${physPath}`);
        }
    } catch (e) {
        console.warn(`[AdminDeleteDir] Failed to purge ${physPath}:`, e);
    }
}

// 清理 unified_sync_state.json 中的 team_hash + personal_hash
if (rootDir) {
    try {
        const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
        const statePath = `${rootDir}/.slash/unified_sync_state.json`;
        const stateStr = await readTextFile(statePath);
        const state = JSON.parse(stateStr);
        let changed = false;

        // dirPath 是 team 路径 (如 "01_PROJECTS/B01")
        // 需要匹配所有可能对应的本地路径
        const localRelPaths: string[] = [];
        for (const physPath of physicalPaths) {
            if (physPath.startsWith(rootDir + '/')) {
                localRelPaths.push(physPath.substring(rootDir.length + 1));
            }
        }

        for (const key of Object.keys(state)) {
            const normKey = key.replace(/\\/g, '/').toLowerCase();
            const shouldClean = localRelPaths.some(lp => {
                const normLp = lp.replace(/\\/g, '/').toLowerCase();
                return normKey === normLp || normKey.startsWith(normLp + '/');
            });
            if (shouldClean) {
                delete state[key];
                changed = true;
            }
        }

        if (changed) {
            await writeTextFile(statePath, JSON.stringify(state, null, 2));
            console.log(`[AdminDeleteDir] Cleaned unified_sync_state for deleted dir`);
        }
    } catch (e) {
        console.warn('[AdminDeleteDir] unified_sync_state cleanup failed (non-fatal):', e);
    }
}
```

**同理**，`handleAdminDeleteFile`（第 49 行）也需要加同样的本地清理逻辑（单文件版本）：

```typescript
// ---- 在 toast.success 之后，resolveTeamToPhysicalPaths 循环之后插入 ----

// 🛡️ BUG-E07 Fix 1b: Admin 主动清理单文件的本地物理副本
const physPaths = resolveTeamToPhysicalPaths(filePath);
for (const physPath of physPaths) {
    try {
        const { exists, remove } = await import('@tauri-apps/plugin-fs');
        if (await exists(physPath)) {
            await remove(physPath);
            console.log(`[AdminDeleteFile] Purged local: ${physPath}`);
        }
    } catch (e) {
        console.warn(`[AdminDeleteFile] Failed to purge ${physPath}:`, e);
    }
}

// 清理 unified_sync_state.json
if (rootDir) {
    try {
        const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
        const statePath = `${rootDir}/.slash/unified_sync_state.json`;
        const stateStr = await readTextFile(statePath);
        const state = JSON.parse(stateStr);
        let changed = false;
        for (const physPath of physPaths) {
            if (physPath.startsWith(rootDir + '/')) {
                const relPath = physPath.substring(rootDir.length + 1);
                if (state[relPath]) {
                    delete state[relPath];
                    changed = true;
                }
            }
        }
        if (changed) {
            await writeTextFile(statePath, JSON.stringify(state, null, 2));
        }
    } catch (e) {
        console.warn('[AdminDeleteFile] unified_sync_state cleanup failed:', e);
    }
}
```

> **注意**：`handleAdminDeleteDir` 和 `handleAdminDeleteFile` 当前签名中没有 `rootDir`，需要从 props 中传入（已有 `rootDir?: string` 在 `UseTeamAdminActionsProps` 接口中，但当前未解构使用）。请在函数头部补充解构。

---

### 修复 2（P1）：客户端 `detect_team_deleted` 增加 PARA 根回退

**文件**：`apps/desktop/src-tauri/src/commands/sync/team.rs`  
**函数**：`detect_team_deleted`（第 877 行）

**问题**：当前仅通过 `reverse_mappings` 反向映射 local → team 路径。删除目录后，`reverse_mappings` 中可能不再包含该目录的映射（因为 scope 已变），导致残留的 unified_state 条目无法被转换为 team 路径、无法加入 `deleted_paths`。

**修复**：在 `reverse_mappings` 查找失败时，增加 PARA 根级回退映射：

```rust
// 在第 911 行 "本地不存在 → 反向映射为 team 路径" 的 for 循环之后，增加回退分支：

// 本地不存在 → 反向映射为 team 路径，加入删除列表
let mut found = false;
for (src_dir, tgt_dir) in reverse_mappings.iter().map(|(t, s)| (*s, *t)) {
    let src_prefix = normalize_prefix(src_dir);
    if local_path.starts_with(&src_prefix) {
        let relative = local_path.strip_prefix(&src_prefix).unwrap_or(local_path);
        let tgt_prefix = normalize_prefix(tgt_dir);
        let target_path = format!("{tgt_prefix}{relative}");
        if !current_target_paths.contains(target_path.as_str()) {
            deleted.push(target_path);
        }
        found = true;
        break;
    }
}

// 🛡️ BUG-E07 Fix 2: PARA 根级回退（reverse_mappings 中无映射时）
if !found {
    for (personal_root, team_root) in PARA_PERSONAL_TO_TEAM {
        let personal_prefix = normalize_prefix(personal_root);
        if local_path.starts_with(&personal_prefix) {
            let relative = local_path.strip_prefix(&personal_prefix).unwrap_or(local_path);
            let team_prefix = normalize_prefix(team_root);
            let target_path = format!("{team_prefix}{relative}");
            if !current_target_paths.contains(target_path.as_str()) {
                log::info!(
                    "[TeamSync] BUG-E07 fallback delete: '{}' → '{}'",
                    local_path, target_path
                );
                deleted.push(target_path);
            }
            break;
        }
    }
}
```

需要在 `team.rs` 顶部确保存在 PARA 映射常量：

```rust
const PARA_PERSONAL_TO_TEAM: &[(&str, &str)] = &[
    ("01_Projects", "01_PROJECTS"),
    ("02_Areas", "02_AREAS"),
    ("03_Resources", "03_RESOURCE"),
    ("04_Archives", "04_ARCHIVE"),
];
```

---

### 修复 3（P2）：服务端 negotiate 增强 — scope 外已删文件仍可下发

**文件**：`apps/server/src/routes/sync/negotiate.rs`  
**位置**：Step 4（第 532 行）

**问题**：Step 4 的条件 `client_dirs.contains(&dir)` 依赖客户端发来目录hash。如果客户端因 scope 变化没发送目标目录的 hash，该路径会被跳过。

**修复**：放宽 Step 4 的条件——对于 `all_deleted_paths` 中的路径，只要客户端的 `client_files` 包含该文件（不论 `client_dirs` 是否匹配），就应该下发 `server_deleted`：

```rust
// Step 4: Team vault 主动下发所有 soft-deleted 路径
if is_team {
    let already_in_deleted: std::collections::HashSet<String> = server_deleted.iter().cloned().collect();
    for path in &all_deleted_paths {
        if !already_in_deleted.contains(path) {
            let has_live_counterpart = server_files.iter().any(|sf| sf.relative_path == *path && !sf.is_deleted);
            let already_needed_by_server = server_needs.contains(path);
            
            if has_live_counterpart || already_needed_by_server {
                continue;
            }

            let dir = get_directory(path);
            // 🛡️ BUG-E07 Fix 3: 放宽条件 — 客户端上报了该文件 OR 该目录 hash 不匹配
            let client_has_file = client_file_map.contains_key(path.as_str());
            let dir_unmatched = client_dirs.contains(&dir) && !matched_dirs.contains(&dir);
            
            if client_has_file || dir_unmatched {
                tracing::debug!("negotiate file={} → proactive team soft-deleted (client_has={}, dir_unmatched={})", path, client_has_file, dir_unmatched);
                server_deleted.push(path.clone());
            }
        }
    }
}
```

---

### 修复 4（P1 附加）：bb 空壳目录复活问题

**文件**：`apps/desktop/src-tauri/src/commands/sync/team.rs`  
**位置**：Step 3.5（第 80-129 行）

**问题**：team sync 的 Step 3.5 会为所有 `source_dirs` 创建本地空目录。如果 bb 的 `scope_dirs` 通过上级目录继承仍包含 `B01`（或残留），会在二次登录时重建空壳。

**修复**：Step 3.5 创建目录前，先检查该目录在 team vault 中是否已被 soft-delete：

这个需要在 `sync_team_full` 的 negotiate 响应中获取 `server_deleted` 路径后，反向检查。更简单的方式是：**只为 `scope.scope_dirs` 中明确存在的目录创建本地目录，不为 path_mappings 中已不存在于 scope_dirs 的目录创建**。

当前 Step 3.5 遍历 `source_dirs`，而 `source_dirs` 来自 `resolve_source_dirs` 已经过 scope 过滤。所以 bb 的空壳问题更可能来自 `server_deleted` 处理中删除文件后没有清理空目录。

请确认 bb 的 `console.log` 中是否有 `[TeamSync] Deleted local file:` 日志。如果有，说明文件被删但空目录被 Step 3.5 重建。修复方式：在 Step 7.5 的 `server_deleted` 处理循环之后，再执行一次空目录清理：

```rust
// Step 7.5 循环结束后追加：
// 🛡️ BUG-E07 Fix 4: 清理因 server_deleted 产生的空壳目录
for local_rel in &server_deleted_local_paths {
    let local_full = root.join(local_rel);
    if let Some(parent) = local_full.parent() {
        // 递归向上清理空目录，直到遇到非空目录或 vault root
        let mut dir = parent.to_path_buf();
        while dir > *root {
            match std::fs::read_dir(&dir) {
                Ok(mut entries) => {
                    if entries.next().is_none() {
                        let _ = std::fs::remove_dir(&dir);
                        log::info!("[TeamSync] Removed empty dir: {}", dir.display());
                    } else {
                        break; // 非空，停止
                    }
                }
                Err(_) => break,
            }
            dir = match dir.parent() {
                Some(p) => p.to_path_buf(),
                None => break,
            };
        }
    }
}
```

---

## 四、验证清单

| # | 验证步骤 | 预期结果 |
|---|---------|---------|
| 1 | Admin 从 Team 面板删除 `B01` 目录 | Admin 本地 `01_Projects/B01/` 立即消失 |
| 2 | 查 DB：`SELECT is_deleted FROM file_states WHERE file_path LIKE '%b01.md'` | 四条记录全部 `is_deleted=t` |
| 3 | 查 Admin 本地 `unified_sync_state.json` | 不含 `B01/b01.md` 相关条目 |
| 4 | bb 二次登录后检查本地文件 | `01_Projects/B01/` 目录不存在 |
| 5 | Admin 从 Team 面板删除单个文件 | Admin 本地该文件立即消失 |

---

## 五、修改文件清单

| 文件 | 修复编号 | 改动类型 |
|------|---------|---------|
| `apps/desktop/src/features/sidebar/hooks/useTeamAdminActions.ts` | Fix 1 | 增加本地清理逻辑 |
| `apps/desktop/src-tauri/src/commands/sync/team.rs` | Fix 2, Fix 4 | detect_team_deleted PARA 回退 + 空目录清理 |
| `apps/server/src/routes/sync/negotiate.rs` | Fix 3 | Step 4 放宽条件 |
