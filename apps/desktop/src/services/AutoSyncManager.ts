/**
 * AutoSyncManager — 自动同步管理器（单例）
 *
 * 负责所有自动同步触发、节流与安全规则：
 * - 文件变更触发（debounce 2s）
 * - App 生命周期触发（启动/前台恢复/退出）
 * - 定时保底（5 分钟）
 * - dirty_queue Set 去重 + isSyncing 防并发
 */
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { syncService } from './SyncService';
import { executeTaskBypass, type CheckboxChange } from './TaskBypassDetector';
import { useSessionStore } from '@/stores/useSessionStore';
import { normalizePath } from '@/shared/utils/pathUtils';

// ============================================================
// Types
// ============================================================

export type AutoSyncStatus = 'idle' | 'syncing' | 'success' | 'error' | 'disabled' | 'offline';

export interface AutoSyncEvent {
    status: AutoSyncStatus;
    lastSyncTime: number | null;
    lastResult?: string;
    error?: string;
}

type StatusListener = (event: AutoSyncEvent) => void;

// ============================================================
// Constants
// ============================================================

const DEBOUNCE_MS = 500;         // 文件变更后 0.5s debounce（快照实时性优化）
const PERIODIC_MS = 5 * 60_000;  // 5 分钟保底
const STARTUP_DELAY_MS = 3000;   // 启动后 3s 首次同步
const FOREGROUND_MIN_GAP_MS = 60_000; // 前台恢复最小间隔 60s
const COLLAB_POLL_MS = 30_000;   // 协作活动轮询间隔 30s
const COLLAB_CONSUMED_SEQ_KEY = 'slash_collab_consumed_seq'; // 本地热缓存，丢失可从服务端恢复

// ============================================================
// AutoSyncManager
// ============================================================

class AutoSyncManager {
    private static instance: AutoSyncManager | null = null;

    // 状态
    private vaultPath: string | null = null;
    private dirtyQueue = new Set<string>();
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private periodicTimer: ReturnType<typeof setInterval> | null = null;
    private collabPollTimer: ReturnType<typeof setInterval> | null = null;
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    private isSyncing = false;
    private pendingSync = false; // debounce 期间又有新请求
    private lastSyncTime: number | null = null;
    private enabled = false;
    private editingPath: string | null = null; // 当前编辑中的文件
    private syncCooldownUntil = 0; // 仅用于 vault:refresh 防循环（结构变更场景）
    private pullCooldownPaths = new Set<string>(); // pull 写盘的路径集合，3s 内忽略这些路径的 note:updated
    private pullCooldownTimer: ReturnType<typeof setTimeout> | null = null;
    /** beforeSyncHook 写盘的路径，300ms 内屏蔽其 watcher 事件（精确噪音过滤，替代全局时间冷却）*/
    private beforeSyncHookPaths = new Set<string>();
    private beforeSyncHook: (() => Promise<void>) | null = null; // sync 前 flush 编辑器

    // 事件
    private unlisteners: UnlistenFn[] = [];
    private statusListeners = new Set<StatusListener>();
    private currentStatus: AutoSyncStatus = 'disabled';

    private constructor() { }

    static getInstance(): AutoSyncManager {
        if (!AutoSyncManager.instance) {
            AutoSyncManager.instance = new AutoSyncManager();
        }
        return AutoSyncManager.instance;
    }

    // ============================================================
    // Public API
    // ============================================================

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
        if (!navigator.onLine) {
            this.updateStatus('offline');
        } else {
            this.updateStatus('idle');
        }

        // 🛡️ FIX BUG-A07: 启动时主动检查 token 有效期，过期则刷新
        const tokenFresh = await this.ensureTokenFresh();
        if (!tokenFresh) {
            console.warn('[AutoSync] Token refresh failed during start. Aborting AutoSync start.');
            this.stop();
            return;
        }

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

    /** 允许外部组件探测到网络断开时，全局强制置为离线，保持 UI 绝对同步 */
    reportNetworkError() {
        if (this.currentStatus !== 'offline' && this.enabled) {
            this.updateStatus('offline');
        }
    }

    /** 允许外部组件探测到网络恢复时，全局强制恢复，保持 UI 绝对同步 */
    reportNetworkRestored() {
        if (this.currentStatus === 'offline' && this.enabled) {
            this.updateStatus('idle');
            // If there's pending changes, trigger a sync
            if (this.dirtyQueue.size > 0) {
                this.requestSync('online_recovery');
            }
        }
    }

    /**
     * 🛡️ BUG-A07: 检查 JWT access_token 是否即将过期，过期则从 Keyring 取 refresh_token 刷新
     * 解析 JWT payload 中的 exp 字段，若距离过期不足 5 分钟则主动刷新
     */
    private async ensureTokenFresh(): Promise<boolean> {
        const config = syncService.getConfig();
        if (!config?.accessToken) return true;

        try {
            // 解析 JWT 中的 exp
            const parts = config.accessToken.split('.');
            if (parts.length !== 3) return true;
            const payload = JSON.parse(atob(parts[1]));
            const exp = payload.exp;
            if (!exp) return true;

            const now = Math.floor(Date.now() / 1000);
            const margin = 5 * 60; // 5 分钟提前量

            if (now < exp - margin) {
                // token 还有 > 5 分钟有效期，不需要刷新
                return true;
            }



            const refreshed = await syncService.refreshToken();
            if (refreshed) {

                return true;
            } else {
                console.warn('[AutoSync] Token refresh failed, aborting...');
                return false;
            }
        } catch (e) {
            console.warn('[AutoSync] Token refresh check failed (will retry on next sync):', e);
            return true;
        }
    }

    /**
     * 启动时主动查询服务端，确认当前用户是否属于某个团队。
     * 如果是，则确保本地 team_sync_state.json 存在（被邀成员首次同步必需）。
     * 同时恢复 useSessionStore 中的团队信息（内存态，重启后会丢失）。
     */
    private async ensureTeamDiscovery(): Promise<boolean> {
        if (!this.vaultPath) return false;
        const config = syncService.getConfig();
        if (!config) return false;

        try {
            const resp = await fetch(`${config.serverUrl}/api/server/info`, {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            });
            if (!resp.ok) return false;

            const info = await resp.json();

            // 🛡️ 极致短路保护：优先服从本地 SessionStore 中绑定的当前团队 ID，杜绝被 info.team_vault_id 覆盖！
            const currentTeamId = useSessionStore.getState().teamVaultId;
            const teamVaultId = currentTeamId || info.team_vault_id;
            const teamVaultName = currentTeamId ? (useSessionStore.getState().teamVaultName || info.team_name || undefined) : (info.team_name || undefined);

            if (!teamVaultId) return false;

            // 🛡️ 多团队强物理隔离保护：
            // 只有当当前仓库物理根目录下本身就含有团队同步状态或团队目录映射时，
            // 才能去更新和写入。如果是完全干净的未绑定任何团队的新个人仓库，绝对禁止强制创建 team_sync_state.json，
            // 保证其纯净的个人库属性不被任何全局 Session 会话污染。
            const { exists } = await import('@tauri-apps/plugin-fs');
            const hasState = await exists(`${this.vaultPath}/.slash/team_sync_state.json`);
            const hasLegacyMappings = await exists(`${this.vaultPath}/.slash/team_path_mappings.json`);
            const hasDirectoryMappings = await exists(`${this.vaultPath}/.slash/team_directory_mappings.json`);
            const hasMappings = hasLegacyMappings || hasDirectoryMappings;

            if (hasState || hasMappings) {
                // 1. 确保本地 team_sync_state.json 存在
                await invoke('ensure_team_sync_state', {
                    vaultPath: this.vaultPath,
                    teamVaultId,
                });
            } else {
                console.log(`[AutoSync] Skip ensuring team sync state for personal vault: ${this.vaultPath}`);
            }

            // 2. 恢复 useSessionStore 内存态（若确实需要更新或从未发现过）
            if (currentTeamId !== teamVaultId) {
                useSessionStore.getState().setTeamInfo({
                    teamVaultId,
                    teamVaultName,
                });
                console.log(`[AutoSync] Team discovered & synced: ${teamVaultId}`);
            }
            return true;
        } catch (e) {
            console.warn('[AutoSync] Team discovery failed (non-blocking):', e);
            return false;
        }
    }

    /** 查询协作活动，dispatch collab:new-events
     *
     * 使用服务端持久化的 seq 游标（替代 localStorage 裸时间戳）：
     * - 本地 localStorage 只做热缓存，丢失可从服务端恢复
     * - 游标单调递增，避免时钟漂移、重复拉取等问题
     */
    private async checkCollabActivity() {
        let teamVaultId = useSessionStore.getState().teamVaultId;
        if (!teamVaultId) {
            await this.ensureTeamDiscovery();
            teamVaultId = useSessionStore.getState().teamVaultId;
        }
        if (!teamVaultId) return;

        try {
            const { collabService } = await import('@/services/CollabService');

            // 1. 从本地热缓存读 seq（避免每次 RTT）
            let consumedSeq = parseInt(localStorage.getItem(COLLAB_CONSUMED_SEQ_KEY) || '-1', 10);
            if (consumedSeq < 0) {
                // 热缓存丢失（清 localStorage 或首次）→ 从服务端恢复
                consumedSeq = await collabService.getCursor(teamVaultId);
                localStorage.setItem(COLLAB_CONSUMED_SEQ_KEY, String(consumedSeq));
            }

            // 2. 增量拉取新事件（幂等，after_seq 保证不重复）
            const { events, max_seq } = await collabService.getEvents(teamVaultId, consumedSeq);

            if (events.length > 0) {
                // 3. dispatch（含事件详情，供 useCollabNotifyStore 按 seq 更新已读游标）
                window.dispatchEvent(new CustomEvent('collab:new-events', {
                    detail: { events },
                }));

                // Phase 7: Reverse mapping for Team Solo mode (Absolute local paths)
                let mappings: Record<string, string> = {};
                try {
                    const vaultRoot = localStorage.getItem('slash_vault_path');
                    if (vaultRoot) {
                        const { readTextFile } = await import('@tauri-apps/plugin-fs');
                        const { useSessionStore } = await import('@/stores/useSessionStore');
                        const teamId = useSessionStore.getState().teamVaultId;

                        try {
                            const raw = await readTextFile(`${vaultRoot}/.slash/team_directory_mappings.json`);
                            const data = JSON.parse(raw);
                            const directories = teamId ? data?.teams?.[teamId]?.directories : undefined;
                            if (directories && typeof directories === 'object') {
                                for (const mapping of Object.values(directories) as Array<any>) {
                                    if (mapping?.status !== 'active') continue;
                                    if (typeof mapping.local_path === 'string' && typeof mapping.remote_path === 'string') {
                                        mappings[mapping.local_path] = mapping.remote_path;
                                    }
                                }
                            }
                        } catch { }

                        try {
                            const raw = await readTextFile(`${vaultRoot}/.slash/team_path_mappings.json`);
                            const data = JSON.parse(raw);
                            if (data.teams) {
                                if (teamId && data.teams[teamId]) {
                                    Object.assign(mappings, data.teams[teamId]);
                                }
                            } else {
                                Object.assign(mappings, data.mappings || data);
                            }
                        } catch {
                            // Suppress read errors if legacy mappings missing.
                        }
                    }
                } catch { /* Suppress read errors if mappings missing */ }

                // Process specific event kinds like task_toggle to update editor DOM
                events.forEach((ev: any) => {
                    // ── folder_joined：Admin 刚给我授予了目录权限，立即同步拉取 ──
                    if (ev.kind === 'folder_joined') {
                        console.log('[AutoSync] folder_joined received, triggering immediate sync & sidebar refresh');
                        this.ensureTeamDiscovery().finally(() => {
                            // 触发一次全量同步，拉取新目录及其文件
                            this.requestSync('folder_joined');
                            // 通知侧边栏树重建（让新目录立即可见）
                            window.dispatchEvent(new CustomEvent('vault:refresh'));
                        });
                        return;
                    }

                    // ── version/status 变更：立即拉取内容，取代 5 分钟保底 ──
                    if (ev.kind === 'version' || ev.kind === 'status') {
                        this.requestSync('collab_' + ev.kind);
                        return;
                    }

                    if (ev.kind === 'maintenance_toggled') {
                        const payload = ev.payload;
                        if (payload) {
                            console.log('[AutoSync] maintenance_toggled received:', payload);
                            import('@/stores/useSessionStore').then(({ useSessionStore }) => {
                                const currentState = useSessionStore.getState();
                                if (payload.is_maintenance) {
                                    const startedAt = payload.started_at;
                                    const MAINTENANCE_DURATION_MS = 30 * 60 * 1000;
                                    if (startedAt && !currentState.isAdminManageMode) {
                                        const expiry = startedAt * 1000 + MAINTENANCE_DURATION_MS;
                                        useSessionStore.setState({
                                            isAdminManageMode: true,
                                            adminManageModeExpiry: expiry,
                                        });
                                    } else if (!startedAt && !currentState.isAdminManageMode) {
                                        useSessionStore.getState().setAdminManageMode(true);
                                    }
                                } else {
                                    if (currentState.isAdminManageMode) {
                                        useSessionStore.getState().setAdminManageMode(false);
                                    }
                                }
                            });
                        }
                        return;
                    }

                    if (ev.kind === 'task_toggle') {
                        const payload = ev.payload;
                        if (payload) {
                            // Needs Editor's ID format. Assuming ev.file_path matches the ID loaded in Editor.
                            // 1. Team Collab virtual path format
                            const noteIdTeam = `__team__/${ev.file_path}`;
                            
                            // 2. Team Solo raw absolute path
                            let absolutePath = null;
                            const normFilePath = normalizePath(ev.file_path);
                            const firstDir = normFilePath.split('/')[0];
                            const reverseMappedDir = Object.keys(mappings).find(key => 
                                mappings[key] === firstDir // Match root directory PARA map
                            );
                            
                            if (reverseMappedDir) {
                                const vaultRoot = localStorage.getItem('slash_vault_path') || '';
                                // Reconstruct absolute path
                                const localRelPath = normFilePath.replace(firstDir, reverseMappedDir);
                                absolutePath = `${vaultRoot}/${localRelPath}`;
                            } else {
                                // Fallback if no exact match but we still try absolute vault injection
                                const vaultRoot = localStorage.getItem('slash_vault_path') || '';
                                absolutePath = `${vaultRoot}/${ev.file_path}`;
                            }

                            const fireToggle = (path: string) => {
                                window.dispatchEvent(new CustomEvent('slash:remote-task-toggle', {
                                    detail: {
                                        notePath: path,
                                        fileId: ev.file_id,
                                        directoryId: ev.directory_id,
                                        lineNumber: payload.line_number,
                                        rawText: payload.raw_text,
                                        isCompleted: payload.checked
                                    }
                                }));
                            };

                            fireToggle(noteIdTeam);
                            if (absolutePath) {
                                fireToggle(absolutePath);
                            }
                        }
                    }
                });
            }

            // 4. 游标前进（本地立即更新，服务端异步写）
            if (max_seq > consumedSeq) {
                localStorage.setItem(COLLAB_CONSUMED_SEQ_KEY, String(max_seq));
                collabService.updateCursor(teamVaultId, max_seq); // 非阻塞
            }
        } catch { /* 静默忽略，不影响主流程 */ }
    }

    /** 停止自动同步 */
    stop() {

        this.enabled = false;
        this.dirtyQueue.clear();

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.periodicTimer) {
            clearInterval(this.periodicTimer);
            this.periodicTimer = null;
        }
        if (this.collabPollTimer) {
            clearInterval(this.collabPollTimer);
            this.collabPollTimer = null;
        }
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }

        // 清理事件监听
        for (const unlisten of this.unlisteners) {
            try {
                // unlisten 是异步的，但在 stop 时我们尽力而为
                unlisten();
            } catch (e) {}
        }
        this.unlisteners = [];

        this.updateStatus('disabled');
    }

    /** 标记文件为 dirty（外部调用：saveNote 写盘后） */
    markDirty(relativePath: string) {
        if (!this.enabled) return;
        this.dirtyQueue.add(relativePath);

        this.scheduleSync('file_change');
    }

    /** Promote 操作前暂停 auto-sync（避免竞态写 team_sync_state） */
    async pauseForPromote() {
        // 等待进行中的 sync 完成（最多 15s）
        const maxWait = 15_000;
        const start = Date.now();
        while (this.isSyncing && Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, 200));
        }
        this.syncCooldownUntil = Date.now() + 30_000; // 30s 冷却
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /** Promote 完成后恢复 auto-sync 并立即触发一次同步 */
    resumeAfterPromote() {
        this.syncCooldownUntil = 0;
        if (this.enabled) {
            this.requestSync('post_promote');
        }
    }

    /** 设置当前编辑中的文件路径（Pull 时跳过） */
    setEditingPath(absolutePath: string | null) {
        this.editingPath = absolutePath;
    }

    /** 获取当前 vault 路径 */
    getVaultPath(): string | null {
        return this.vaultPath;
    }

    /** 获取当前编辑中的文件相对路径 */
    getEditingRelativePath(): string | null {
        if (!this.editingPath || !this.vaultPath) return null;
        // \ud83d\udee1\ufe0f Windows \u517c\u5bb9\uff1a\u7edf\u4e00\u6b63\u659c\u6760\u518d\u505a\u622a\u53d6
        const normEditing = this.editingPath.replace(/\\/g, '/');
        const normVault = this.vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
        return normEditing.startsWith(normVault + '/') 
            ? normEditing.slice(normVault.length + 1)
            : normEditing;
    }

    /** 注册 sync 前回调（用于 flush 编辑器内容到磁盘，消除竞态） */
    setBeforeSyncHook(hook: (() => Promise<void>) | null) {
        this.beforeSyncHook = hook;
    }

    /** 立即同步（用于退出前 flush） */
    async forceSync(reason: string): Promise<void> {
        if (!this.enabled || !this.vaultPath) return;

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        await this.executeSync(reason);
    }

    /** 手动触发同步（UI 按钮） */
    async manualSync(): Promise<void> {
        if (!this.vaultPath) return;

        // 即使 autoSync 未开启也允许手动同步
        if (this.isSyncing) return;

        await this.executeSync('manual');
    }

    /**
     * Task Checkbox 旁路同步 — 绕过 PR 直接同步 checkbox 翻转
     *
     * 由 TaskItem checkbox onChange 调用。
     * 如果文件在团队空间中，立即通过 taskBypass API 同步到服务器，
     * 不走常规 Push/PR 流程，实现即时协同。
     *
     * @param relativePath 文件相对路径
     * @param lineNumber 0-indexed 行号
     * @param lineContent 该行原始文本内容
     * @param checked 目标 checked 状态
     */
    async notifyCheckboxToggle(
        relativePath: string,
        lineNumber: number,
        lineContent: string,
        checked: boolean,
    ): Promise<void> {
        if (!this.enabled) return;
        const teamVaultId = useSessionStore.getState().teamVaultId;
        if (!teamVaultId) return; // 非团队模式，跳过

        // 检查路径是否在团队同步范围（以大写 PARA 目录开头）
        const isTeamPath = relativePath.match(/^(01_PROJECTS|02_AREAS|03_RESOURCE|04_ARCHIVE)\//i);
        if (!isTeamPath) return;

        try {
            const change: CheckboxChange = {
                lineNumber,
                originalLine: lineContent,
                checked,
            };
            const count = await executeTaskBypass(relativePath, [change]);
            if (count > 0) {
                console.log(`[AutoSync] Task bypass succeeded: ${relativePath}:${lineNumber} → ${checked}`);
            }
        } catch (e) {
            console.warn('[AutoSync] Task bypass failed, will sync normally:', e);
        }
    }

    /** 订阅同步状态变化 */
    onStatusChange(listener: StatusListener): () => void {
        this.statusListeners.add(listener);
        // 立即发送当前状态
        listener({
            status: this.currentStatus,
            lastSyncTime: this.lastSyncTime,
        });
        return () => this.statusListeners.delete(listener);
    }

    /** 查询是否已启用 */
    isEnabled(): boolean {
        return this.enabled;
    }

    /** 查询当前状态 */
    getStatus(): AutoSyncStatus {
        return this.currentStatus;
    }

    // ============================================================
    // 触发器设置
    // ============================================================

    /** 监听 file watcher 的 note:updated 事件 */
    private async setupFileChangeListener() {
        // 内容变更（已有文件修改）
        const unlisten = await listen<string>('note:updated', (event) => {
            if (!this.enabled) return;
            const changedPath = event.payload;

            if (this.isSyncing) {
                // sync 进行中：排队，sync 结束后自动重跑
                console.debug(`[AutoSync] note:updated queued (isSyncing) path=${changedPath}`);
                this.dirtyQueue.add(changedPath);
                this.pendingSync = true;
                return;
            }
            if (this.beforeSyncHookPaths.has(changedPath)) {
                // beforeSyncHook 写盘触发的 watcher 噪音，精确过滤（300ms 自动失效）

                return;
            }
            if (this.pullCooldownPaths.has(changedPath)) {
                // pull 写盘触发的 watcher 事件，忽略（防止 pull→watcher→sync 死循环）

                return;
            }

            this.markDirty(changedPath);
        });
        this.unlisteners.push(unlisten);

        // 结构变更（新建/删除/重命名）→ 也需要触发同步
        const unlistenRefresh = await listen('vault:refresh', () => {
            if (!this.enabled) return;
            const now = Date.now();
            if (this.isSyncing) {

                return;
            }
            if (now < this.syncCooldownUntil) {

                return;
            }

            this.scheduleSync('structural');
        });
        this.unlisteners.push(unlistenRefresh);

        // 🔔 [Phase 6] Asset download 完成 → 触发 PersonalSync 同步 asset 到 Personal vault
        const unlistenDownload = await listen<{ vault_id: string; hash: string; asset_path: string }>(
            'transfer:download-completed',
            (event) => {
                if (!this.enabled) return;
                console.debug(
                    `[AutoSync] transfer:download-completed → scheduling sync for asset closure: ${event.payload.asset_path}`
                );
                // 延迟 2 秒：等待文件系统稳定，避免与进行中的 sync 冲突
                setTimeout(() => {
                    if (this.enabled && !this.isSyncing) {
                        this.requestSync('asset_download_completed');
                    }
                }, 2000);
            }
        );
        this.unlisteners.push(unlistenDownload);
    }

    /** App 生命周期：前台恢复 + 退出 */
    private setupLifecycleListeners() {
        // 前台恢复
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (!this.enabled) return;

            const gap = Date.now() - (this.lastSyncTime || 0);
            if (gap > FOREGROUND_MIN_GAP_MS) {

                this.requestSync('foreground');
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        this.unlisteners.push(() => document.removeEventListener('visibilitychange', handleVisibilityChange));

        // 网络恢复自动同步
        const handleOnline = () => {
            if (!this.enabled) return;
            if (this.currentStatus === 'offline' || this.dirtyQueue.size > 0) {
                this.requestSync('online_recovery');
            }
        };
        window.addEventListener('online', handleOnline);
        this.unlisteners.push(() => window.removeEventListener('online', handleOnline));

        // 网络断开自动切离线状态
        const handleOffline = () => {
            if (!this.enabled) return;
            this.updateStatus('offline');
        };
        window.addEventListener('offline', handleOffline);
        this.unlisteners.push(() => window.removeEventListener('offline', handleOffline));

        // App 退出前 flush
        const handleBeforeUnload = () => {
            if (this.dirtyQueue.size > 0) {
                this.forceSync('shutdown');
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        this.unlisteners.push(() => window.removeEventListener('beforeunload', handleBeforeUnload));

        // 🛡️ 全局状态熔断：Token 彻底过期且刷新失败时，切断死循环
        const handleAuthExpired = () => {
            console.warn('[AutoSync] sync:auth-expired received. Halting AutoSyncManager to prevent infinite loops.');
            this.stop();
        };
        window.addEventListener('sync:auth-expired', handleAuthExpired);
        this.unlisteners.push(() => window.removeEventListener('sync:auth-expired', handleAuthExpired));
    }

    /** 5 分钟定时保底 */
    private startPeriodicSync() {
        this.periodicTimer = setInterval(() => {
            if (!this.enabled) return;

            this.requestSync('periodic');
        }, PERIODIC_MS);
    }

    // ============================================================
    // 同步调度
    // ============================================================

    /** 带 debounce 的同步请求 */
    private scheduleSync(reason: string) {

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.requestSync(reason);
        }, DEBOUNCE_MS);
    }

    /**
     * G-4: 个人空间团队目录变更自动 Push 到团队空间
     * 读取 team_path_mappings.json，对每个映射执行 pushDirectoryToTeam
     */
    // G-4 syncTeamDirectories 已废弃：sync_team_full 已内置完整的 team push/pull

    /** 请求一次同步（防并发） */
    private requestSync(reason: string) {
        if (this.isSyncing) {
            this.pendingSync = true;

            return;
        }
        this.executeSync(reason);
    }

    /** 执行一次完整同步 */
    private async executeSync(_reason: string): Promise<void> {
        if (!this.vaultPath || this.isSyncing) return;
        if (!syncService.isConfigured()) return;

        this.isSyncing = true;
        this.pendingSync = false;
        this.updateStatus('syncing');
        let filesPulled = 0; // finally 块用于判断是否需要设冷却期
        let pulledPaths: string[] = []; // finally 块用于设置路径级冷却
        try {
            // 🛡️ sync 前 flush 编辑器内容到磁盘，消除 debounce 竞态
            // 确保 negotiate 计算的 hash 反映真实的最新编辑内容
            if (this.beforeSyncHook) {
                // 记录正在编辑的路径到 beforeSyncHookPaths，精确过滤 watcher 噪音
                const hookPath = this.getEditingRelativePath();
                if (hookPath) {
                    this.beforeSyncHookPaths.add(hookPath);
                    // 300ms 后清除（watcher debounce=200ms，300ms 足够让噪音消散）
                    setTimeout(() => this.beforeSyncHookPaths.delete(hookPath), 300);
                }
                try {
                    await this.beforeSyncHook();
                } catch (e) {
                    console.warn('[AutoSync] beforeSyncHook failed:', e);
                }
            }

            // 始终保护编辑中文件，防止 Pull 覆盖正在编辑的内容
            const editingPath = this.getEditingRelativePath();
            if (!useSessionStore.getState().teamVaultId) {
                await this.ensureTeamDiscovery();
            }
            // 团队显示名：团队同步 Push 时注入 Editor 字段到 YAML frontmatter
            const editorName = useSessionStore.getState().displayName || undefined;

            const result = await syncService.syncVault(this.vaultPath, editingPath, editorName);
            
            // 🛡️ App 生命周期防御：如果同步期间 manager 被 stop了（如切换仓库），
            // 则放弃后续状态更新与事件派发，防止 Callback Warning 与状态污染。
            if (!this.enabled) {
                console.warn('[AutoSync] Sync result ignored because manager was stopped.');
                return;
            }

            filesPulled = result.files_pulled ?? 0;
            pulledPaths = result.actually_pulled_paths ?? []; // 仅真正写盘的文件，不含 task scan 路径
            this.dirtyQueue.clear();
            this.lastSyncTime = Date.now();

            const label = `↑${result.files_pushed} ↓${result.files_pulled}`;

            // G-4 已废弃：sync_team_full 已内置 team push/pull，无需额外调用
            // syncTeamDirectories 会覆盖 team_sync_state 导致冗余 Pull

            // Handle global maintenance mode status from sync response
            if (typeof result.is_maintenance === 'boolean') {
                import('@/stores/useSessionStore').then(({ useSessionStore }) => {
                    const currentState = useSessionStore.getState();
                    
                    if (result.is_maintenance) {
                        // 服务端携带了开启时间戳 → 用它反推剩余时间设置本地 expiry
                        // maintenance_started_at 是 Unix 秒，30 分钟维护窗口
                        const MAINTENANCE_DURATION_MS = 30 * 60 * 1000;
                        const startedAt = result.maintenance_started_at;
                        if (startedAt && !currentState.isAdminManageMode) {
                            // 计算 expiry 并直接写入 store（不通过 setAdminManageMode 避免 expiry 被重置为 now+30min）
                            const expiry = startedAt * 1000 + MAINTENANCE_DURATION_MS;
                            useSessionStore.setState({
                                isAdminManageMode: true,
                                adminManageModeExpiry: expiry,
                            });
                        } else if (!startedAt && !currentState.isAdminManageMode) {
                            // 服务端未携带时间戳（旧版兼容）→ 用当前时间估算
                            useSessionStore.getState().setAdminManageMode(true);
                        }
                        // 已处于维护模式时不重置（避免 expiry 被覆盖）
                    } else {
                        // 维护模式已关闭
                        if (currentState.isAdminManageMode) {
                            useSessionStore.getState().setAdminManageMode(false);
                        }
                    }
                });
            }

            // Pull 成功 或 有文件被本地注入（如 editor 字段），通知编辑器刷新当前笔记
            // handleSyncPulled 内部有内容对比，相同则跳过 reload
            // 🛡️ 仅在实际有文件被 Pull 时才触发 reload，避免 push-only 同步覆盖编辑器正在编辑的内容
            if (result.files_pulled > 0) {
                window.dispatchEvent(new CustomEvent('sync:pulled', { detail: result }));

                // 团队变更通知：dispatch collab:new-events（替代 Toast）
                // App.tsx 监听后写入 useCollabNotifyStore，驱动文件树小红点 + 自动打开协作面板
                if (result.pulled_paths && result.pulled_paths.length > 0) {
                    const mdPaths = result.pulled_paths.filter((p: string) => p.endsWith('.md'));
                    if (mdPaths.length > 0) {
                        window.dispatchEvent(new CustomEvent('collab:new-events', {
                            detail: { paths: mdPaths },
                        }));
                    }
                }

                // ── 批注/评论活动检测（不改文件内容，不在 pulled_paths 里）──
                // 查询 since 上次同步后有新协作活动的文件路径，补充通知
                const teamVaultId = useSessionStore.getState().teamVaultId;
                const sinceTs = this.lastSyncTime ? this.lastSyncTime - 60_000 : 0; // 多往前 1min 容错
                if (teamVaultId && sinceTs > 0) {
                    import('@/services/AnnotationService').then(({ annotationService }) => {
                        annotationService.getCollabActivity(teamVaultId, sinceTs).then(activityPaths => {
                            if (activityPaths.length > 0) {
                                window.dispatchEvent(new CustomEvent('collab:new-events', {
                                    detail: { paths: activityPaths },
                                }));
                            }
                        }).catch(() => {/* 静默忽略 */});
                    });
                }
            }

            // 任何成功的同步都通知 UI 刷新
            window.dispatchEvent(new CustomEvent('sync:completed', { detail: result }));

            // 团队文件树只在远端确有文件变化时刷新，避免无变化同步反复请求目录树。
            if ((result.pulled_paths && result.pulled_paths.length > 0) || filesPulled > 0) {
                window.dispatchEvent(new Event('team:tree-refresh'));
            }

            // Pull 下来的 .md 文件自动提取待办任务到 SQLite（未打开的文件也能入 Kanban）

            if (result.pulled_paths && result.pulled_paths.length > 0) {
                const mdPaths = result.pulled_paths.filter((p: string) => p.endsWith('.md'));
                if (mdPaths.length > 0) {
                    Promise.allSettled(
                        mdPaths.map((p: string) => invoke('scan_note_tasks', { notePath: p }))
                    ).then(results => {
                        const failed = results.filter(r => r.status === 'rejected');

                        failed.forEach((r) => {
                            if (r.status === 'rejected') {
                                console.warn(`[AutoSync] Task scan failed for ${mdPaths[results.indexOf(r)]}:`, r.reason);
                            }
                        });
                    });
                }
            }

            this.updateStatus('success', label);

            // 3 秒后恢复 idle
            setTimeout(() => {
                if (this.currentStatus === 'success') {
                    this.updateStatus('idle');
                }
            }, 3000);
        } catch (err) {
            const errorMsg = String(err);

            // 区分网络错误 vs 服务器错误
            const isNetworkError = !navigator.onLine ||
                errorMsg.includes('fetch') ||
                errorMsg.includes('network') ||
                errorMsg.includes('Failed to fetch') ||
                errorMsg.includes('connect');

            if (isNetworkError) {
                // 网络错误：dirty_queue 保留，等恢复后自动重试
                this.updateStatus('offline');
                window.dispatchEvent(new CustomEvent('sync:physical-disconnected', { detail: { error: errorMsg } }));
            } else {
                // 服务器错误：清 dirty_queue 避免无限重试
                console.error('[AutoSync] Sync failed:', errorMsg);
                this.updateStatus('error', undefined, errorMsg);

                // 5 秒后恢复 idle
                setTimeout(() => {
                    if (this.currentStatus === 'error') {
                        this.updateStatus('idle');
                    }
                }, 5000);
            }
        } finally {
            this.isSyncing = false;

            // vault:refresh 防循环：pull 会触发结构变更通知，短暂冷却防止重复 structural sync
            this.syncCooldownUntil = Date.now() + 500;

            // pull 写盘路径：加入降噪集合，3s 后清除（防止 pull→watcher→note:updated→sync 死循环）
            if (filesPulled > 0) {
                pulledPaths.forEach(p => this.pullCooldownPaths.add(p));
                if (this.pullCooldownTimer) clearTimeout(this.pullCooldownTimer);
                this.pullCooldownTimer = setTimeout(() => {
                    this.pullCooldownPaths.clear();
                    this.pullCooldownTimer = null;
                }, 3000);
            }

            // 有排队的同步请求，用 scheduleSync（500ms 防抖）而非立即执行
            // 避免 beforeSyncHook 捕获用户正在打字的半成品内容
            if (this.pendingSync && this.enabled) {
                this.pendingSync = false;
                this.scheduleSync('queued');
            }
        }
    }

    // ============================================================
    // 状态通知
    // ============================================================

    private updateStatus(status: AutoSyncStatus, lastResult?: string, error?: string) {
        this.currentStatus = status;
        const event: AutoSyncEvent = {
            status,
            lastSyncTime: this.lastSyncTime,
            lastResult,
            error,
        };
        for (const listener of this.statusListeners) {
            try {
                listener(event);
            } catch (e) {
                console.error('[AutoSync] Status listener error:', e);
            }
        }
    }
}

// 导出单例
export const autoSyncManager = AutoSyncManager.getInstance();
