# 架构师指令（修正）：团队同步发现 — 从 UI Hook 迁移到启动层

> **优先级**: 🔴 P0（已验证前一版方案无效）
> **缺陷类型**: 功能缺失 — 被邀成员永远无法自动 Pull 团队文件
> **替代文档**: `docs/Architect/team_sync_member_discovery_fix.md`

---

## 为什么上一版方案不够

上一版在 `useSyncFlow.ts` 的 4 个 `setTeamInfo` 回调后注入 `ensure_team_sync_state`。但这些回调全部在 UI 交互路径中（连接、加入团队、创建团队）。**当已连接用户重启应用后，这些路径不会触发。**

实测结果：Lucia 重启 Desktop → 打开设置面板 → `team_sync_state.json` 仍未创建。

---

## 新方案：在 AutoSyncManager.start() 中主动发现团队

`AutoSyncManager.start()` 在 vault 加载时 **必定** 被调用。在这里查询服务端团队归属，就能覆盖所有场景。

### 修改文件：`apps/desktop/src/services/AutoSyncManager.ts`

在 `start()` 方法中，`ensureTokenFresh()` 之后、事件注册之前，加入团队状态发现逻辑：

```typescript
/** 启动自动同步（vault 加载后调用） */
async start(vaultPath: string) {
    if (this.enabled && this.vaultPath === vaultPath) return;

    this.stop(); // 清理旧状态

    if (!syncService.isConfigured()) {
        return;
    }

    this.vaultPath = vaultPath;
    this.enabled = true;
    this.lastSyncTime = syncService.getLastSyncTime();
    this.updateStatus('idle');

    // 🛡️ FIX BUG-A07: 启动时主动检查 token 有效期，过期则刷新
    await this.ensureTokenFresh();

    // ★ 新增：启动时主动发现团队归属，确保 team_sync_state.json 存在
    await this.ensureTeamDiscovery();

    // 注册所有触发器
    await this.setupFileChangeListener();
    this.setupLifecycleListeners();
    this.startPeriodicSync();

    // 启动后延迟首次同步
    this.startupTimer = setTimeout(() => {
        this.requestSync('startup');
    }, STARTUP_DELAY_MS);

    // 协作活动：启动时立即查（覆盖离线期间）+ 之后每 30s 轮询
    setTimeout(() => this.checkCollabActivity(), 2000);
    this.collabPollTimer = setInterval(() => this.checkCollabActivity(), COLLAB_POLL_MS);
}
```

### 新增私有方法：`ensureTeamDiscovery()`

加在 `ensureTokenFresh()` 方法之后：

```typescript
/**
 * 启动时主动查询服务端，确认当前用户是否属于某个团队。
 * 如果是，则确保本地 team_sync_state.json 存在（被邀成员首次同步必需）。
 * 同时恢复 useSessionStore 中的团队信息（内存态，重启后会丢失）。
 */
private async ensureTeamDiscovery() {
    if (!this.vaultPath) return;
    const config = syncService.getConfig();
    if (!config) return;

    try {
        const resp = await fetch(`${config.serverUrl}/api/server/info`, {
            headers: { 'Authorization': `Bearer ${config.accessToken}` },
        });
        if (!resp.ok) return;

        const info = await resp.json();
        const teamVaultId = info.team_vault_id;
        if (!teamVaultId) return;

        // 1. 确保本地 team_sync_state.json 存在
        await invoke('ensure_team_sync_state', {
            vaultPath: this.vaultPath,
            teamVaultId,
        });

        // 2. 恢复 useSessionStore 内存态（重启后会丢失）
        const currentTeamId = useSessionStore.getState().teamVaultId;
        if (currentTeamId !== teamVaultId) {
            useSessionStore.getState().setTeamInfo({
                teamVaultId,
                teamVaultName: info.team_name || undefined,
            });
            console.log(`[AutoSync] Team discovered: ${teamVaultId}`);
        }
    } catch (e) {
        console.warn('[AutoSync] Team discovery failed (non-blocking):', e);
    }
}
```

### 不动的代码

- `useSyncFlow.ts` 中的 4 处 `ensure_team_sync_state` 调用 — **保留**，作为 UI 交互路径的即时生效层
- `team.rs` 中的 `ensure_team_sync_state` 命令 — **保留**，已经实现了唯一幂等的状态文件管理
- `lib.rs` 中的命令注册 — **保留**

---

## 验证

1. 清除 Lucia 的 `.slash/team_sync_state.json`（如果有）
2. 重启 Desktop 应用
3. 查看控制台是否有 `[AutoSync] Team discovered: ...` 日志
4. 检查 `.slash/team_sync_state.json` 是否自动创建
5. 等待首次同步完成（约 3s），确认 Lucia 本地出现 `/Join Team 01/` 目录和 `Join T001.md` 文件

---

**架构师签发（修正版）。2026-04-20**
