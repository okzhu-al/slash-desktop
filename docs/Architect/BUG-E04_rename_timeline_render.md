# 架构师指令：BUG-E04 补充 — Rename 快照前端渲染国际化

> **优先级**: P3（UX 补全）
> **前置**: BUG-E04 服务端 `snapshot_type = 'rename'` 已实现
> **状态**: 待开发

---

## 问题

服务端已正确生成 `snapshot_type = 'rename'` 快照，`change_summary` 格式为固定英文：
```
Renamed: 01_PROJECTS/Join Team 02/Join T02.md -> 01_PROJECTS/Join Team 02/Join T02-rename.md
```

但 `VersionTimeline.tsx` 前端尚未识别 `rename` 类型，当前会 fallthrough 到默认的"修改"标签。需要：
1. 识别 `rename` 类型并渲染专属标签 + 颜色
2. 解析 `change_summary` 提取新旧路径，用 i18n 友好文案展示

---

## 修改文件

`apps/desktop/src/features/collaboration/VersionTimeline.tsx`

### 改动 1：`typeLabel()` 函数（L59-64）

增加 `rename` 分支：

```diff
 function typeLabel(type: string | null, t: any): { text: string; cls: string } {
     if (type === 'create') return { text: t('versions.type_create', { defaultValue: '创建' }), cls: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' };
     if (type === 'revert') return { text: t('versions.type_revert', { defaultValue: '回退' }), cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' };
     if (type === 'freeze') return { text: t('versions.type_freeze', { defaultValue: '冻结' }), cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' };
+    if (type === 'rename') return { text: t('versions.type_rename', { defaultValue: '重命名' }), cls: 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400' };
     return { text: t('versions.type_sync', { defaultValue: '修改' }), cls: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400' };
 }
```

### 改动 2：时间线圆点颜色（L361-366）

增加 `rename` 圆点颜色：

```diff
                                     <div className={`w-2 h-2 rounded-full shrink-0 ${
                                         snap.snapshot_type === 'create'
                                             ? 'bg-emerald-500'
                                             : snap.snapshot_type === 'revert'
                                                 ? 'bg-amber-500'
-                                                : isLatest ? 'bg-indigo-500' : 'bg-zinc-300 dark:bg-zinc-600'
+                                                : snap.snapshot_type === 'rename'
+                                                    ? 'bg-violet-500'
+                                                    : isLatest ? 'bg-indigo-500' : 'bg-zinc-300 dark:bg-zinc-600'
                                     }`} />
```

### 改动 3：时间线文字渲染（L384-396）

在 `create`/`revert` 分支后增加 `rename` 分支，解析 `change_summary` 提取文件名：

```diff
                                             {snap.snapshot_type === 'create'
                                                 ? t('versions.type_create', '创建')
                                                 : snap.snapshot_type === 'revert'
                                                     ? (() => { ... revert 逻辑保持不变 ... })()
+                                                    : snap.snapshot_type === 'rename'
+                                                        ? (() => {
+                                                            // 解析 "Renamed: old -> new" 提取文件名
+                                                            const match = snap.change_summary?.match(/^Renamed:\s*(.+?)\s*->\s*(.+)$/);
+                                                            if (match) {
+                                                                const oldName = match[1].split('/').pop() || match[1];
+                                                                const newName = match[2].split('/').pop() || match[2];
+                                                                return t('versions.renamed_detail', '重命名 {{oldName}} → {{newName}}', { oldName, newName });
+                                                            }
+                                                            return t('versions.type_rename', '重命名');
+                                                        })()
                                                     : t('versions.type_sync', '修改')}
```

> **注意**：`snap.change_summary` 字段需要确认 `SnapshotInfo` 类型定义中包含该字段。如果缺失，需在 `SnapshotService.ts` 的 `SnapshotInfo` interface 中添加 `change_summary?: string`。

---

## i18n 新增 keys

**`zh-CN/common.json`**：
```json
"versions.type_rename": "重命名",
"versions.renamed_detail": "重命名 {{oldName}} → {{newName}}"
```

**`en/common.json`**：
```json
"versions.type_rename": "Rename",
"versions.renamed_detail": "Renamed {{oldName}} → {{newName}}"
```

---

**架构师签发。2026-04-20**
