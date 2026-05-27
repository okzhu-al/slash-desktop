# Step 8/9: 维护模式前端体验优化与修复报告

本报告记录了前置阶段中针对团队空间维护模式（Maintenance Mode）在前端 UI 及用户操作体验上的一系列增强与修复过程。所有改进均严格遵循最小化干预（零 DB 迁移、零 WebSocket）的架构规范，通过现有的基于内存的 `is_maintenance` 字段进行全员同步。

---

## 一、 Step 8: 基础体验缺陷修复与安全拦截

本阶段致力于优化维护状态的可视化感知，并彻底杜绝 Admin 在维护期间对远端和本地数据进行危险的硬删除。

### 1. 补全 Titlebar 维护提示多语言文本 (i18n)
- **修复背景**：早期在进入维护模式时，团队文件树（TreeHeader / Titlebar）上的警示文案仅包含或遗漏了中文定义，导致体验不一致。
- **改动过程**：在 `apps/desktop/src/locales/zh-CN/common.json` 及对应的英文 `en/common.json` 文件中，补全并规范化了多语言词条：
  - 更新了进入维护时的二次确认文案：`maintenance_confirm_body`，详细说明了单次维护时长（30 min）、超时的自毁倒计时逻辑，以及预删除功能代替强删除的功能变更。
  - 添加了对应的警示条词汇，确保多语言切换时文案的一致性。

**代码变更片段 (zh-CN/common.json)**:
```diff
-       "maintenance_confirm_title": "⚠️ 维护模式",
+       "maintenance_confirm_title": "⚠️ 维护模式",
+       "maintenance_confirm_body": "团队空间维护时可移动/重命名团队目录和文件，如成员同步操作相同内容，以 Admin 为准，维护时 Admin 不可以直接删除目录或文件，Admin 的删除操作将修改文件名为原名 + (预删除)，以此来提示原 Owner/Editor 尽快处理。\n\n单次维护时长为 30 min，倒计时结束将自动退出维护模式，如未完成可再此开启。",
+       "maintenance_confirm_ok": "进入维护模式",
+       "maintenance_enter": "开始维护",
+       "admin_pre_delete": "预删除",
+       "admin_pre_delete_suffix": "(预删除)",
```

### 2. 将硬删除降级为安全的“预删除 (Pre-delete)”
- **修复背景**：为防止通过 `handleAdminDeleteDir / File` 删除文件造成多端冲突卡死，架构决定在维护锁生效期间，废弃全部默认红色的硬删除按钮，彻底切断物理文件删除路径。
- **改动过程 (`TeamTreeItem.tsx`)**：
  - 检测如果是维护模式 (`isAdminManageMode == true`)，彻底隐藏原有的“删除”右键菜单选项，从 UI 层面斩断可能的误调用。
  - 新创建一个与“删除”同等级的**“预删除 / Pre-delete”**新按钮。
  - **核心逻辑**：预删除本质是一个带有标准后缀挂载的**重命名快捷动作**。点击后，不再调用危险的 Delete API，而是直接将 `node.name` 修改拼接 `(预删除)`（中文环境）或 `(Pre-delete)`（英文环境）。
  - 对文件 (`.md`) 重命名时剥离扩展名进行插词，例如：`File(预删除).md`；对于目录则是直接追加后缀：`Folder(预删除)`。
  - 通过这种方式对成员空间进行柔性锁定，不仅在同步上安全（等同于重命名同步），也在 UI 视觉上清晰地提醒原创建者尽快进行垃圾清理。

**代码变更片段 (TeamTreeItem.tsx)**:
```diff
                              <ContextMenuSeparator />
-                             <ContextMenuItem 
-                                 onClick={() => onDeleteDir?.(node.path, node.name)} 
-                                 className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50"
-                             >
-                                 <Trash2 size={14} className="mr-2" />
-                                 {t('team.admin_delete_dir')}
-                             </ContextMenuItem>
+                             {isMaintenanceMode ? (
+                                 <ContextMenuItem 
+                                     onClick={() => onRenameDir?.(node.path, node.name, node.name + t('team.admin_pre_delete_suffix', { defaultValue: '(预删除)'}))} 
+                                     className="text-amber-600 focus:text-amber-600 focus:bg-amber-50 dark:focus:bg-amber-950/50"
+                                 >
+                                     <Trash2 size={14} className="mr-2" />
+                                     {t('team.admin_pre_delete')}
+                                 </ContextMenuItem>
+                             ) : (
+                                 <ContextMenuItem 
+                                     onClick={() => onDeleteDir?.(node.path, node.name)} 
+                                     className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50"
+                                 >
+                                     <Trash2 size={14} className="mr-2" />
+                                     {t('team.admin_delete_dir')}
+                                 </ContextMenuItem>
+                             )}
```

---

## 二、 Step 9: 30 分钟生命周期与倒计时全员感知

短时管理员行为需要避免由于意外下线造成的“死锁”。因此，我们为维护动作赋予了 30 分钟的默认寿命，并将生命周期感知下放给所有终端成员。

### 1. 明确生命周期约束
按照优化后的逻辑规范，开启维护的单次时间被**严格限定为 30 分钟**。倒计时结束时：
- 服务端会主动清理或作废此次维护请求的有效性。
- Admin 未完成的维护操作可以等待下一次再次手动触发开启；这防止了遗忘关闭导致团队空间长时瘫痪。

### 2. 前端 Titlebar 倒计时全局显示
- **修复背景**：成员感知到进入维护模式时只知道“不能动文件”，但不清楚还要等多久，引起协作焦虑。
- **改动过程**：
  - 所有检测到当前服务端同步下发的 `is_maintenance == true` 的客户端（不论所有者或成员），都会在团队文件树的顶部警示文案旁（Titlebar 区域）渲染时间倒计时（如：`维护中 (29:59)`）。
  - 这种轻量化的定时渲染避免了与服务器强同步时间，依靠收到最新握手状态时顺次建立的本地定时循环提供反馈。

**代码变更片段 (Sidebar.tsx)**:
```diff
+                                       {isAdminManageMode && (
+                                           <span className="flex flex-none items-center gap-1.5 rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-700 uppercase dark:bg-amber-500/20 dark:text-amber-400 border border-amber-200/50 dark:border-amber-500/30">
+                                               <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-[pulse_1.5s_ease-in-out_infinite] shadow-[0_0_8px_rgba(245,158,11,0.6)]" />
+                                               <span>{t('team.maintenance_badge')}</span>
+                                               {timeLeftStr && <span className="text-amber-600/90 dark:text-amber-500/90 tabular-nums ml-0.5 font-mono">{timeLeftStr}</span>}
+                                           </span>
+                                       )}
```

---

## 三、 本次整改影响评估

- **代码复杂度**：低。无需深入复杂的数据库层、不引发并发锁争议。
- **用户体验**：显著增强。通过快捷预删除代替物理级禁止，在业务流转上实现了柔性提醒。通过双语言倒计时的支持，增强了所有团队成员同步等待过程中的掌控感。
- **架构兼容**：所有机制对齐最新的 `维护状态全员同步指令.md` 的要求和设计规范。

本报告确认了前述需求中提到的所有缺陷（序号 `1` - `4`）及第 6 项 “预删除的处理逻辑变更” 的实现思路记录。针对以上修复内容的全部前端和逻辑整改已融合进入历史递交中。
