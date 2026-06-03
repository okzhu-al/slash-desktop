/**
 * CollabService — 服务端协作事件游标 API
 *
 * 替代 localStorage 裸时间戳，提供：
 * - 消费游标：从哪里开始拉事件（清 localStorage 后从服务端恢复）
 * - 已读游标：每个文件的红点消除状态（跨设备同步）
 * - 增量事件拉取：按 seq 幂等拉取
 */
import { syncService } from './SyncService';

export interface CollabEvent {
    seq: number;
    kind: 'annotation' | 'comment' | 'file_trashed' | 'file_deleted' | 'file_restored' | 'folder_joined' | 'maintenance_toggled' | 'version' | 'status' | 'task_toggle';
    file_path: string;
    file_id?: string | null;
    directory_id?: string | null;
    author_name: string;
    created_at: string;
    payload?: Record<string, unknown>;
}

export interface UnreadFile {
    file_path: string;
    file_id?: string | null;
    directory_id?: string | null;
    unread_count: number;
    latest_seq: number;
    unread_since: string | null;
}

export interface StatusEventInfo {
    id: string;
    author_name: string | null;
    old_status: string;
    new_status: string;
    created_at: string;
}

class CollabServiceImpl {
    private getBase(): string | null {
        const config = syncService.getConfig();
        return config?.serverUrl ?? null;
    }

    private getHeaders(): Record<string, string> | null {
        const config = syncService.getConfig();
        if (!config?.accessToken) return null;
        return { Authorization: `Bearer ${config.accessToken}` };
    }

    private async getFreshAuth(): Promise<{ base: string; headers: Record<string, string> } | null> {
        const fresh = await syncService.ensureAccessTokenFresh(60);
        if (!fresh) return null;

        const base = this.getBase();
        const headers = this.getHeaders();
        if (!base || !headers) return null;
        return { base, headers };
    }

    /** 从服务端读取消费游标（清 LocalStorage 后恢复用） */
    async getCursor(vaultId: string): Promise<number> {
        const auth = await this.getFreshAuth();
        if (!auth) return 0;

        try {
            const resp = await fetch(
                `${auth.base}/api/collab/cursor?vault_id=${encodeURIComponent(vaultId)}`,
                { headers: auth.headers }
            );
            if (!resp.ok) return 0;
            const data = await resp.json();
            return data.consumed_seq ?? 0;
        } catch {
            return 0;
        }
    }

    /** 更新消费游标（非阻塞，不 await） */
    async updateCursor(vaultId: string, consumedSeq: number): Promise<void> {
        const auth = await this.getFreshAuth();
        if (!auth) return;

        try {
            await fetch(`${auth.base}/api/collab/cursor`, {
                method: 'PUT',
                headers: { ...auth.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ vault_id: vaultId, consumed_seq: consumedSeq }),
            });
        } catch { /* 静默忽略，下次轮询时重试 */ }
    }

    /** 拉取 after_seq 之后的新事件（幂等，排除自己） */
    async getEvents(vaultId: string, afterSeq: number): Promise<{
        events: CollabEvent[];
        max_seq: number;
    }> {
        const auth = await this.getFreshAuth();
        if (!auth) return { events: [], max_seq: afterSeq };

        try {
            const params = new URLSearchParams({
                vault_id: vaultId,
                after_seq: String(afterSeq),
            });
            const resp = await fetch(`${auth.base}/api/collab/events?${params}`, { headers: auth.headers });
            if (resp.status === 401) {
                const refreshed = await syncService.refreshToken();
                if (refreshed) {
                    const newHeaders = this.getHeaders();
                    if (newHeaders) {
                        const retryResp = await fetch(`${auth.base}/api/collab/events?${params}`, { headers: newHeaders });
                        if (retryResp.ok) return await retryResp.json();
                    }
                }
                return { events: [], max_seq: afterSeq };
            }
            if (!resp.ok) return { events: [], max_seq: afterSeq };
            return await resp.json();
        } catch {
            return { events: [], max_seq: afterSeq };
        }
    }

    /** 标记文件已读（打开协作历史 Tab 时调用或强清除目录红点） */
    async markFileRead(
        vaultId: string,
        filePath: string,
        readSeq: number,
        clearChildren?: boolean,
        identity?: { fileId?: string | null; directoryId?: string | null },
    ): Promise<void> {
        const auth = await this.getFreshAuth();
        if (!auth) return;

        try {
            await fetch(`${auth.base}/api/collab/read`, {
                method: 'PUT',
                headers: { ...auth.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    vault_id: vaultId,
                    file_path: filePath,
                    file_id: identity?.fileId,
                    directory_id: identity?.directoryId,
                    read_seq: readSeq,
                    clear_children: clearChildren,
                }),
            });
        } catch { /* 静默忽略 */ }
    }

    /** 查询所有未读文件（登录后重建红点状态用） */
    async getUnreadFiles(vaultId: string): Promise<UnreadFile[]> {
        const auth = await this.getFreshAuth();
        if (!auth) return [];

        try {
            const resp = await fetch(
                `${auth.base}/api/collab/unread?vault_id=${encodeURIComponent(vaultId)}`,
                { headers: auth.headers }
            );
            if (!resp.ok) return [];
            const data = await resp.json();
            return data.unread_files ?? [];
        } catch {
            return [];
        }
    }

    /** 查询指定文件的系统协作事件（恢复、删除等） */
    async getFileEvents(vaultId: string, filePath: string, fileId?: string | null): Promise<CollabEvent[]> {
        const auth = await this.getFreshAuth();
        if (!auth) return [];

        try {
            const params = new URLSearchParams({ vault_id: vaultId, file_path: filePath });
            if (fileId) params.set('file_id', fileId);
            const resp = await fetch(`${auth.base}/api/collab/file_events?${params}`, { headers: auth.headers });
            if (!resp.ok) return [];
            const data = await resp.json();
            return data.events ?? [];
        } catch {
            return [];
        }
    }

    /** 查询指定文件的状态切换记录（Solo/Collab 互切） */
    async getStatusEvents(vaultId: string, filePath: string, fileId?: string | null): Promise<StatusEventInfo[]> {
        const auth = await this.getFreshAuth();
        if (!auth) return [];

        try {
            const params = new URLSearchParams({ vault_id: vaultId, file_path: filePath });
            if (fileId) params.set('file_id', fileId);
            const resp = await fetch(`${auth.base}/api/collab/status_events?${params}`, { headers: auth.headers });
            if (!resp.ok) return [];
            const data = await resp.json();
            return data.events || [];
        } catch {
            return [];
        }
    }

    /** 获取单文件的悲观锁 (仅用于 collab 模式) */
    async acquireLock(vaultId: string, fileId: string): Promise<{ success: boolean; lockedByName: string | null }> {
        const auth = await this.getFreshAuth();
        if (!auth) throw new Error('Missing base URL or headers');

        const resp = await fetch(`${auth.base}/api/collab/lock`, {
            method: 'POST',
            headers: { ...auth.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ vault_id: vaultId, file_id: fileId }),
        });
        
        if (resp.status === 401) {
            const refreshed = await syncService.refreshToken();
            const newHeaders = refreshed ? this.getHeaders() : null;
            if (newHeaders) {
                const retryResp = await fetch(`${auth.base}/api/collab/lock`, {
                    method: 'POST',
                    headers: { ...newHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vault_id: vaultId, file_id: fileId }),
                });
                if (retryResp.ok) {
                    const data = await retryResp.json();
                    return {
                        success: data.success,
                        lockedByName: data.locked_by_name ?? null
                    };
                }
            }
            throw new Error('Unauthorized');
        }

        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        const data = await resp.json();
        return {
            success: data.success,
            lockedByName: data.locked_by_name ?? null
        };
    }

    /** 显式释放悲观锁 (用于挂机或退出时) */
    async releaseLock(vaultId: string, fileId: string): Promise<void> {
        const auth = await this.getFreshAuth();
        if (!auth) return;

        try {
            await fetch(`${auth.base}/api/collab/unlock`, {
                method: 'POST',
                headers: { ...auth.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ vault_id: vaultId, file_id: fileId }),
            });
        } catch { /* 静默忽略 */ }
    }

    /** 查询当前用户是否为指定文件的 Solo 编辑者 */
    async checkIsEditor(vaultId: string, fileId: string): Promise<boolean> {
        const auth = await this.getFreshAuth();
        if (!auth) return false;

        try {
            const params = new URLSearchParams({ vault_id: vaultId, file_id: fileId });
            const resp = await fetch(`${auth.base}/api/collab/file_editor?${params}`, { headers: auth.headers });
            if (!resp.ok) return false;
            const data = await resp.json();
            return data.is_editor ?? false;
        } catch {
            return false;
        }
    }
}

export const collabService = new CollabServiceImpl();
