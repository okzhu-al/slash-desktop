/**
 * SyncService — Desktop ↔ Server 同步服务
 *
 * 封装 Tauri sync 命令调用，提供前端可用的同步 API。
 * 配置按 vault 隔离存储，切换 vault 时自动切换配置上下文。
 */
import { invoke } from '@tauri-apps/api/core';
import { normalizePath } from '@/shared/utils/pathUtils';
import { useSessionStore } from '@/stores/useSessionStore';

// ============================================================
// Types (mirror slash-sync-proto)
// ============================================================

export type SyncStatusType =
    | 'idle'
    | 'connecting'
    | 'syncing'
    | 'success'
    | 'error'
    | 'offline';


export interface SyncConfig {
    serverUrl: string;
    accessToken: string;
    vaultId: string;
    userId?: string;
    accessCode?: string;
}

export interface DeletedFileInfo {
    path: string;
    file_id?: string | null;
}

export interface SyncResult {
    status: { [key: string]: unknown };
    files_pushed: number;
    files_pulled: number;
    conflicts: string[];
    server_deleted: DeletedFileInfo[];
    skipped_pulls: string[];
    /** 团队同步 Pull 下来的本地相对路径列表（含 task scan 路径） */
    pulled_paths: string[];
    /** 真正从服务端写盘到本地的文件路径（仅实际 pull，用于 watcher 冷却过滤） */
    actually_pulled_paths: string[];
    /** 服务端返回的全局维护模式状态 */
    is_maintenance?: boolean;
    /** 维护模式开启时间（Unix 秒）。非 Admin 客户端用此计算剩余倒计时 */
    maintenance_started_at?: number | null;
}



// ============================================================
// Storage — per-vault 隔离
// ============================================================

/** 生成简短的 vault 路径 hash 作为 storage key 前缀 */
function vaultKey(vaultPath: string): string {
    // 用路径最后两层目录名做简单标识，足够区分
    const parts = normalizePath(vaultPath).replace(/\/$/, '').split('/');
    const slug = parts.slice(-2).join('_').replace(/[^a-zA-Z0-9_]/g, '');
    return `slash_sync_${slug}`;
}

function storageKeys(prefix: string) {
    return {
        SERVER_URL: `${prefix}_server_url`,
        ACCESS_TOKEN: `${prefix}_access_token`,
        VAULT_ID: `${prefix}_vault_id`,
        ACCESS_CODE: `${prefix}_access_code`,
        USER_ID: `${prefix}_user_id`,
        LAST_SYNC: `${prefix}_last_sync`,
        AUTO_SYNC: `${prefix}_auto_enabled`,
    };
}

// ============================================================
// Service
// ============================================================

class SyncServiceImpl {
    private keys = storageKeys('slash_sync_default');
    private refreshInFlight: Promise<boolean> | null = null;

    /** 设置当前活跃 vault（切换 vault 时调用） */
    setActiveVault(vaultPath: string | null) {
        if (vaultPath) {
            this.keys = storageKeys(vaultKey(vaultPath));
        } else {
            this.keys = storageKeys('slash_sync_default');
        }
    }

    getConfig(): SyncConfig | null {
        const serverUrl = localStorage.getItem(this.keys.SERVER_URL);
        const accessToken = localStorage.getItem(this.keys.ACCESS_TOKEN);
        const vaultId = localStorage.getItem(this.keys.VAULT_ID);
        const accessCode = localStorage.getItem(this.keys.ACCESS_CODE);
        const userId = localStorage.getItem(this.keys.USER_ID) || undefined;

        if (!serverUrl || !accessToken || !vaultId) return null;
        return { serverUrl, accessToken, vaultId, ...(accessCode ? { accessCode } : {}), ...(userId ? { userId } : {}) };
    }

    /** 获取保存的服务器地址、配对码和 vault_id（即使未连接也可用） */
    getSavedConnection(): { serverUrl: string; accessCode?: string; vaultId?: string } | null {
        const serverUrl = localStorage.getItem(this.keys.SERVER_URL);
        const vaultId = localStorage.getItem(this.keys.VAULT_ID) || undefined;
        if (!serverUrl) return null;
        // 注意：不返回 accessCode (PIN)，由用户每次手动输入
        return { serverUrl, vaultId };
    }

    saveConfig(config: SyncConfig) {
        localStorage.setItem(this.keys.SERVER_URL, config.serverUrl);
        localStorage.setItem(this.keys.ACCESS_TOKEN, config.accessToken);
        localStorage.setItem(this.keys.VAULT_ID, config.vaultId);
        if (config.userId) {
            localStorage.setItem(this.keys.USER_ID, config.userId);
        }
        // 不保存 accessCode (PIN)，遵循零持久化原则

        // 连接后通知 AutoSyncManager 和 UI 更新
        window.dispatchEvent(new CustomEvent('sync:config-changed'));
    }

    clearConfig() {
        // 断开连接：清 token 和同步状态，保留地址和 vault_id。不保留配对码(PIN)
        localStorage.removeItem(this.keys.ACCESS_TOKEN);
        localStorage.removeItem(this.keys.LAST_SYNC);
        localStorage.removeItem(this.keys.ACCESS_CODE);
        localStorage.removeItem(this.keys.USER_ID);
        // 注意：断开连接不清除团队数据（可能是离线/飞行模式）
        // 团队数据清理在登录新账号时执行（见 onUserChanged）
        // 断开后通知 AutoSyncManager 和 UI 更新
        window.dispatchEvent(new CustomEvent('sync:config-changed'));
    }

    async checkConnection(serverUrl: string): Promise<boolean> {
        try {
            return await invoke<boolean>('check_sync_connection', { serverUrl });
        } catch {
            return false;
        }
    }

    async syncVault(vaultPath: string, editingPath?: string | null, editorName?: string): Promise<SyncResult> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const editingPaths: string[] = editingPath ? [editingPath] : [];

        try {
            const result = await invoke<SyncResult>('sync_vault', {
                serverUrl: config.serverUrl,
                accessToken: config.accessToken,
                vaultId: config.vaultId,
                vaultPath,
                editingPaths,
                editorName: editorName || null,
            });

            localStorage.setItem(this.keys.LAST_SYNC, Date.now().toString());
            return result;
        } catch (err) {
            const errMsg = String(err);
            
            // 🚨 403 熔断拦截：被踢出团队 (Forbidden) 时，零延迟执行退登与强退警告
            if (errMsg.includes('403') || errMsg.includes('Forbidden')) {
                const { useSessionStore } = await import('@/stores/useSessionStore');
                this.clearConfig();
                useSessionStore.getState().clearAll();
                window.dispatchEvent(new CustomEvent('sync:auth-expired'));
                throw err;
            }

            // 401 → 尝试刷新 Token 后重试
            if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
                const refreshed = await this.refreshToken();
                if (refreshed) {
                    const newConfig = this.getConfig()!;
                    const result = await invoke<SyncResult>('sync_vault', {
                        serverUrl: newConfig.serverUrl,
                        accessToken: newConfig.accessToken,
                        vaultId: newConfig.vaultId,
                        vaultPath,
                        editingPaths,
                        editorName: editorName || null,
                    });
                    localStorage.setItem(this.keys.LAST_SYNC, Date.now().toString());
                    return result;
                }
            }
            throw err;
        }
    }

    async syncTeamVault(vaultPath: string, editingPath?: string | null, editorName?: string): Promise<SyncResult> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const editingPaths: string[] = editingPath ? [editingPath] : [];

        try {
            const result = await invoke<SyncResult>('sync_team_vault', {
                serverUrl: config.serverUrl,
                accessToken: config.accessToken,
                vaultPath,
                editingPaths,
                editorName: editorName || null,
            });

            localStorage.setItem(this.keys.LAST_SYNC, Date.now().toString());
            return result;
        } catch (err) {
            const errMsg = String(err);

            if (errMsg.includes('403') || errMsg.includes('Forbidden')) {
                const { useSessionStore } = await import('@/stores/useSessionStore');
                this.clearConfig();
                useSessionStore.getState().clearAll();
                window.dispatchEvent(new CustomEvent('sync:auth-expired'));
                throw err;
            }

            if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
                const refreshed = await this.refreshToken();
                if (refreshed) {
                    const newConfig = this.getConfig()!;
                    const result = await invoke<SyncResult>('sync_team_vault', {
                        serverUrl: newConfig.serverUrl,
                        accessToken: newConfig.accessToken,
                        vaultPath,
                        editingPaths,
                        editorName: editorName || null,
                    });
                    localStorage.setItem(this.keys.LAST_SYNC, Date.now().toString());
                    return result;
                }
            }
            throw err;
        }
    }

    /** 尝试刷新 Token，成功返回 true */
    public async refreshToken(): Promise<boolean> {
        if (this.refreshInFlight) return this.refreshInFlight;

        this.refreshInFlight = this.doRefreshToken().finally(() => {
            this.refreshInFlight = null;
        });
        return this.refreshInFlight;
    }

    private async doRefreshToken(): Promise<boolean> {
        try {
            const config = this.getConfig();
            const serverUrl = config?.serverUrl;
            // BUG-A06 FIX: 优先使用本地隔离存储的 userId，防止跨 Vault 全局 store 污染
            const userId = config?.userId || useSessionStore.getState().userId || "__personal__";
            if (!serverUrl) {
                throw new Error("Missing serverUrl for refresh");
            }
            const newAccessToken = await invoke<string>('refresh_session', { serverUrl, userId });
            
            if (config) {
                this.saveConfig({
                    ...config,
                    accessToken: newAccessToken
                });
            }
            return true;
        } catch (e) {
            console.warn('[SyncService] Refresh token failed:', e);
            const errorMsg = String(e);
            const isNetworkError = !navigator.onLine ||
                errorMsg.toLowerCase().includes('fetch') ||
                errorMsg.toLowerCase().includes('network') ||
                errorMsg.toLowerCase().includes('connect') ||
                errorMsg.toLowerCase().includes('connection') ||
                errorMsg.toLowerCase().includes('timeout') ||
                errorMsg.toLowerCase().includes('unreachable');
            
            if (isNetworkError) {
                window.dispatchEvent(new CustomEvent('sync:physical-disconnected', { detail: { error: errorMsg } }));
            } else {
                // 逻辑断联：清理已失效配置（实现状态熔断），防止后续继续使用过期的 Token 和轮询
                this.clearConfig();
                window.dispatchEvent(new CustomEvent('sync:auth-expired'));
            }
            return false;
        }
    }

    public async ensureAccessTokenFresh(marginSeconds = 60): Promise<boolean> {
        const config = this.getConfig();
        if (!config?.accessToken) return false;

        try {
            const parts = config.accessToken.split('.');
            if (parts.length !== 3) return true;
            const payload = JSON.parse(atob(parts[1]));
            const exp = payload.exp;
            if (!exp) return true;

            const now = Math.floor(Date.now() / 1000);
            if (now < exp - marginSeconds) return true;

            return await this.refreshToken();
        } catch {
            return true;
        }
    }

    getLastSyncTime(): number | null {
        const ts = localStorage.getItem(this.keys.LAST_SYNC);
        return ts ? parseInt(ts, 10) : null;
    }

    isConfigured(): boolean {
        return this.getConfig() !== null;
    }

    isAutoSyncEnabled(): boolean {
        const val = localStorage.getItem(this.keys.AUTO_SYNC);
        return val !== 'false';
    }

    setAutoSyncEnabled(enabled: boolean) {
        localStorage.setItem(this.keys.AUTO_SYNC, enabled ? 'true' : 'false');
    }

    /** Task 属性级旁路同步 */
    async taskBypass(event: {
        vault_id: string;
        file_path: string;
        file_id?: string | null;
        directory_id?: string | null;
        line_number: number;
        line_content_hash: string;
        checked: boolean;
        toggled_by: string;
    }): Promise<{ success: boolean; message: string }> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const resp = await fetch(`${config.serverUrl}/api/sync/task-bypass`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...event,
                timestamp: Math.floor(Date.now() / 1000),
            }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || `Task bypass failed: ${resp.status}`);
        }

        return resp.json();
    }

    /** 将指定目录推送到团队 vault（Promote to Team）
     * @param vaultPath 本地 vault 根路径
     * @param sourceDir 源目录相对路径 (e.g. "01_Projects/新建文件夹")
     * @param targetDir 团队 vault 中的目标路径 (e.g. "01_PROJECTS/新建文件夹")
     * @param teamVaultId 团队 vault ID
     */
    async pushDirectoryToTeam(vaultPath: string, sourceDir: string, targetDir: string, teamVaultId: string, editorName?: string): Promise<number> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const count = await invoke<number>('push_directory_to_vault', {
            serverUrl: config.serverUrl,
            accessToken: config.accessToken,
            vaultPath,
            sourceDir,
            targetDir,
            targetVaultId: teamVaultId,
            editorName: editorName || null,
        });
        return count;
    }

    /** 获取指定 vault 的目录列表（用于 Promote to Team 目标选择） */
    async listVaultDirectories(teamVaultId: string): Promise<string[]> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const resp = await fetch(
            `${config.serverUrl}/api/sync/vaults/directories?vault_id=${encodeURIComponent(teamVaultId)}`,
            {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            }
        );

        if (!resp.ok) {
            throw new Error(`Failed to list directories: ${resp.status}`);
        }

        return resp.json();
    }

    /** 获取指定 vault 的完整文件树 */
    async getVaultTree(vaultId: string): Promise<TeamTreeNode[]> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const resp = await fetch(
            `${config.serverUrl}/api/sync/vaults/tree?vault_id=${encodeURIComponent(vaultId)}`,
            {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            }
        );

        if (!resp.ok) {
            throw new Error(`Failed to get vault tree: ${resp.status}`);
        }

        return resp.json();
    }

    /** 获取指定 vault 中文件的内容（只读） */
    async getVaultFile(vaultId: string, filePath: string): Promise<string> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const resp = await fetch(
            `${config.serverUrl}/api/sync/vaults/file?vault_id=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(filePath)}`,
            {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            }
        );

        if (!resp.ok) {
            throw new Error(`Failed to get file: ${resp.status}`);
        }

        return resp.text();
    }

    /** 通过稳定 file_id 获取团队文件内容与当前路径（只读） */
    async getVaultFileById(vaultId: string, fileId: string): Promise<{ content: string; filePath: string; fileId: string }> {
        const config = this.getConfig();
        if (!config) throw new Error('Sync not configured');

        const resp = await fetch(
            `${config.serverUrl}/api/sync/vaults/file?vault_id=${encodeURIComponent(vaultId)}&file_id=${encodeURIComponent(fileId)}`,
            {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            }
        );

        if (!resp.ok) {
            throw new Error(`Failed to get file by id: ${resp.status}`);
        }

        const content = await resp.text();
        return {
            content,
            filePath: resp.headers.get('X-Slash-File-Path') || '',
            fileId: resp.headers.get('X-Slash-File-Id') || fileId,
        };
    }
}

/** 团队空间文件树节点 */
export interface TeamTreeNode {
    name: string;
    path: string;
    is_dir: boolean;
    file_id?: string | null;
    editor_id?: string | null;
    children?: TeamTreeNode[];
    size?: number;
    editor_username?: string;
    editor_display_name?: string;
}

export const syncService = new SyncServiceImpl();
