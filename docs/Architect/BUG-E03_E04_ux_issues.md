# BUG-E03: 权限拦截提示不统一 + 国际化不完整

> **优先级**: P3（UX 打磨）
> **发现时间**: 2026-04-20
> **状态**: 已记录，待修复

## 问题描述

四种越权操作的拦截方式、UI 形态、文案风格、语言均不统一：

| 操作 | 提示方式 | 语言 | 文案风格 |
|:---|:---|:---|:---|
| 删除文件（非 Editor） | Modal 弹窗 | 中文 | 友好提示"请联系 Editor" |
| 移动文件（团队目录内） | Toast | 中文 | 简短提示"不允许移动" |
| 删除目录（非 Owner） | Modal 弹窗 | 中文 | 系统性提示"必须是 Owner 或管理员" |
| 重命名目录（无权限） | Toast | **英文（原始错误消息）** | 技术性"Role TeamMember cannot perform ManageDirectory" |

## 期望

1. **统一提示方式**：全部使用弹窗或全部使用 Toast（推荐 Toast，减少打断）
2. **统一文案风格**：用户友好语言，不暴露角色名/操作名等技术术语
3. **全部国际化**：所有提示走 i18n `t()` 函数
4. **重命名目录**的错误尤其需要修复：直接暴露了服务端原始错误消息

## 产品决策

> **所有越权拦截必须使用 Modal 弹窗，统一标题为"越权提示"。**

理由：越权是严重安全事件，需要强提示阻断用户操作流，不能用容易被忽略的 Toast。

## 修复指令

### 统一规范

| 属性 | 规范 |
|:---|:---|
| 提示方式 | **Modal 弹窗**（`@tauri-apps/plugin-dialog` 的 `message()`，非 Toast） |
| 标题 | `t('team.permission_denied_title')` → **"越权提示"** |
| 文案 | 用户友好语言，走 i18n，不暴露技术术语 |
| kind | `'error'` |

---

### 拦截点 1：删除文件（非 Editor）
**文件**: `useFileTreeActions.ts` **L88**
**现状**: ✅ 已用 `message()` Modal，文案 OK
**改动**: 仅统一 title

```diff
- await message(t('sidebar.delete_denied_not_editor', '您不是该笔记的 Editor 无法进行删除操作，如需删除请联系 Editor'), { title: t('sidebar.delete_unauthorized_title', "越权拦截"), kind: 'error' });
+ await message(t('team.permission_denied_delete_file', '您不是该笔记的 Editor，无法进行删除操作。如需删除请联系 Editor。'), { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
```

---

### 拦截点 2：删除目录（非 Owner/Admin）
**文件**: `useFileTreeActions.ts` **L130**
**现状**: ✅ 已用 `message()` Modal，但 title 不统一
**改动**: 统一 title

```diff
- await message(errorMessage, { title: t('sidebar.delete_blocked_title', "删除操作已被系统拦截"), kind: 'error' });
+ await message(errorMessage, { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
```

---

### 拦截点 3：移动文件（团队目录内）— 2 处
**文件 A**: `useFileTreeActions.ts` **L485**
**文件 B**: `useSidebarDragDrop.ts` **L115**
**现状**: 🔴 使用 `toast.error()`，需改为 Modal

**文件 A 改动** (`useFileTreeActions.ts` L484-486):
```diff
                 if (sourcePath === fullPath || sourcePath.startsWith(fullPath + '/')) {
-                    toast.error(t('team.move_blocked', '团队目录内容不允许移动位置，请保持团队空间目录结构'));
+                    const { message } = await import('@tauri-apps/plugin-dialog');
+                    await message(t('team.permission_denied_move_file', '团队目录内的文件不允许移动位置，请保持团队空间目录结构。'), { title: t('team.permission_denied_title', '越权提示'), kind: 'error' });
                     return;
```

**文件 B 改动** (`useSidebarDragDrop.ts` L114-116):
```diff
                 if (draggedItem.path === fullPath || draggedItem.path.startsWith(fullPath + '/')) {
-                    toast.error(t('team.move_blocked', '团队目录内容不允许移动位置，请保持团队空间目录结构'));
+                    const { message } = await import('@tauri-apps/plugin-dialog');
+                    await message(t('team.permission_denied_move_file', '团队目录内的文件不允许移动位置，请保持团队空间目录结构。'), { title: t('team.permission_denied_title', '越权提示'), kind: 'error' });
                     return;
```

---

### 拦截点 4：重命名目录（无权限）
**文件**: `useFileTreeActions.ts` **L332-337** + **L373-375**
**现状**: 🔴 throw Error 后被 L375 的 `alert()` 捕获，暴露英文技术消息
**改动**: 在 catch 块中直接弹 Modal，不再 throw

**L332-338 改动**:
```diff
                                 } catch (e) {
                                     console.warn('[useFileTreeActions] Server rename failed, rolling back:', e);
                                     const { rename } = await import('@tauri-apps/plugin-fs');
                                     await rename(newPath, oldPath);
                                     await refreshNode(parentPath);
-                                    throw new Error(`Permission denied or server error: ${(e as Error).message}`);
+                                    const { message } = await import('@tauri-apps/plugin-dialog');
+                                    await message(t('team.permission_denied_rename_dir', '您没有权限重命名该团队目录，请联系管理员。'), { title: t('team.permission_denied_title', '越权提示'), kind: 'error' });
+                                    return;
                                 }
```

**L373-376 改动**（`alert` 兜底也需统一）:
```diff
         } catch (e) {
             console.error("[useFileTreeActions] Failed to rename", e);
-            alert("Failed to rename: " + (e as Error).message);
+            const { message } = await import('@tauri-apps/plugin-dialog');
+            await message(t('team.rename_failed', { error: (e as Error).message, defaultValue: `重命名失败: ${(e as Error).message}` }), { title: t('common.error', '错误'), kind: 'error' });
         }
```

---

### i18n 新增 keys

**`zh-CN/common.json`** 添加：
```json
"team.permission_denied_title": "越权提示",
"team.permission_denied_delete_file": "您不是该笔记的 Editor，无法进行删除操作。如需删除请联系 Editor。",
"team.permission_denied_move_file": "团队目录内的文件不允许移动位置，请保持团队空间目录结构。",
"team.permission_denied_delete_dir": "您必须是该目录的 Owner 或管理员才能删除。",
"team.permission_denied_rename_dir": "您没有权限重命名该团队目录，请联系管理员。",
"team.rename_failed": "重命名失败: {{error}}"
```

**`en/common.json`** 添加：
```json
"team.permission_denied_title": "Permission Denied",
"team.permission_denied_delete_file": "You are not the Editor of this note. Please contact the Editor to delete.",
"team.permission_denied_move_file": "Files in team directories cannot be moved. Please maintain the team space structure.",
"team.permission_denied_delete_dir": "You must be the Owner or an Admin to delete this directory.",
"team.permission_denied_rename_dir": "You do not have permission to rename this team directory. Please contact an Admin.",
"team.rename_failed": "Rename failed: {{error}}"
```

### 可清理的旧 i18n keys（修复完成后删除）

- `sidebar.delete_denied_not_editor`
- `sidebar.delete_unauthorized_title`
- `sidebar.delete_blocked_title`

---

**架构师签发。2026-04-20**

---

# BUG-E04: Rename 操作无独立快照事件

> **优先级**: P3（数据完整性 — 审计链路）
> **发现时间**: 2026-04-20
> **状态**: 已记录，待修复

## 问题描述

文件被 rename 后，快照表中没有单独的 `rename` 类型快照事件，而是被合并到 300s idle 窗口内的"格式调整"笼统摘要中。

## 影响

协作历史/版本时间线中无法精确追溯"谁在什么时候改了文件名"，审计链路不完整。

## 修复方向

在 negotiate.rs 的 rename 检测命中后，主动创建一条 `snapshot_type = 'rename'` 的快照记录，`change_summary` 包含新旧路径信息。
