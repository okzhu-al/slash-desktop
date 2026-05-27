/**
 * SnapshotService — 版本快照 API 封装
 * Phase 3.1: 替代 PRService，提供版本列表/查看/回退
 */

import { syncService } from './SyncService';
import { useSessionStore } from '@/stores/useSessionStore';

// ============================================================
// Types
// ============================================================

export interface SnapshotInfo {
    id: string;
    file_path: string;
    author_name: string | null;
    change_summary: string | null;
    snapshot_type: string | null; // 'create' | 'sync' | 'push' | 'revert' | 'freeze'
    content_hash: string;
    created_at: string;
}

export interface SnapshotContent {
    content: string;
    content_hash: string;
    author_name: string | null;
    created_at: string;
}

export interface SnapshotListResult {
    snapshots: SnapshotInfo[];
    /** 当前用户是否可回退（Admin | Owner | Editor），前端用于隐藏回退按钮 */
    can_revert: boolean;
}

export interface RevertResult {
    success: boolean;
    message: string;
    new_content_hash: string;
}

export async function calculateSnapshotHash(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

const PARA_TEAM_TO_PERSONAL: Record<string, string> = {
    '01_PROJECTS': '01_Projects',
    '02_AREAS': '02_Areas',
    '03_RESOURCE': '03_Resources',
    '04_ARCHIVE': '04_Archives',
};

function joinVaultPath(vaultRoot: string, relPath: string): string {
    return `${vaultRoot.replace(/\/$/, '')}/${relPath.replace(/^\/+/, '')}`;
}

async function resolveTeamNoteCandidates(teamNotePath: string): Promise<string[]> {
    const vaultRoot = (window as any).__slashVaultPath || '';
    if (!vaultRoot) return [];

    const teamPath = teamNotePath.slice('__team__/'.length).replace(/\\/g, '/');
    const candidates: string[] = [];

    for (const [teamPrefix, personalPrefix] of Object.entries(PARA_TEAM_TO_PERSONAL)) {
        if (teamPath === teamPrefix || teamPath.startsWith(`${teamPrefix}/`)) {
            const subPath = teamPath === teamPrefix ? '' : teamPath.slice(teamPrefix.length);
            candidates.push(joinVaultPath(vaultRoot, `${personalPrefix}${subPath}`));
            break;
        }
    }

    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const raw = await readTextFile(joinVaultPath(vaultRoot, '.slash/team_path_mappings.json'));
        const data = JSON.parse(raw);
        const teamVaultId = useSessionStore.getState().teamVaultId;
        const teams: Record<string, Record<string, string>> = data.teams
            ?? (data.vault_id && data.mappings ? { [data.vault_id]: data.mappings } : {});
        const mappings = (teamVaultId && teams[teamVaultId]) || Object.values(teams)[0] || {};

        for (const [localDir, remoteDir] of Object.entries(mappings)) {
            const remote = remoteDir.replace(/\\/g, '/').replace(/\/$/, '');
            if (teamPath === remote || teamPath.startsWith(`${remote}/`)) {
                const subPath = teamPath === remote ? '' : teamPath.slice(remote.length);
                candidates.push(joinVaultPath(vaultRoot, `${localDir}${subPath}`));
            }
        }
    } catch {
        // Missing mappings is normal before a team directory has been promoted locally.
    }

    return [...new Set(candidates)];
}

async function getLocalNoteCandidates(notePath: string | null | undefined): Promise<string[]> {
    if (!notePath) return [];
    return notePath.startsWith('__team__/')
        ? resolveTeamNoteCandidates(notePath)
        : [notePath];
}

export async function getLocalNoteContentHash(notePath: string | null | undefined): Promise<string | null> {
    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        for (const candidate of await getLocalNoteCandidates(notePath)) {
            try {
                return await calculateSnapshotHash(await readTextFile(candidate));
            } catch {
                // Try the next possible local path.
            }
        }
    } catch {
        // ignored
    }
    return null;
}

async function getLocalNoteModifiedAt(notePath: string | null | undefined): Promise<number | null> {
    try {
        const { stat } = await import('@tauri-apps/plugin-fs');
        for (const candidate of await getLocalNoteCandidates(notePath)) {
            try {
                const info = await stat(candidate);
                const mtime = info.mtime instanceof Date
                    ? info.mtime.getTime()
                    : info.mtime ? new Date(info.mtime as any).getTime() : null;
                if (mtime) return mtime;
            } catch {
                // Try the next possible local path.
            }
        }
    } catch {
        // ignored
    }
    return null;
}

export async function keepSnapshotsVisibleFromLocalState(
    snapshots: SnapshotInfo[],
    notePath: string | null | undefined,
): Promise<SnapshotInfo[]> {
    const localHash = await getLocalNoteContentHash(notePath);
    if (!localHash) return [];

    const currentIndex = snapshots.findIndex((s) => s.content_hash === localHash);
    if (currentIndex === 0) return snapshots;
    if (currentIndex > 0) return snapshots.slice(currentIndex);

    const localMtime = await getLocalNoteModifiedAt(notePath);
    if (!localMtime) return [];

    return snapshots.filter((s) => new Date(s.created_at).getTime() <= localMtime + 1000);
}

// ============================================================
// Service
// ============================================================

export interface AssetRef {
    asset_id: string;
    relative_path: string;
    kind: string;
    group_id: null;
}

export function extractAssetRefs(content: string): AssetRef[] {
    const assets: AssetRef[] = [];
    const seen = new Set<string>();
    // 兼容可能带有 title 属性的老图链接
    const regex = /!\[[^\]]*\]\(((?:\.slash[/\\])?assets[/\\][^)"]+)(?: "[^"]*")?\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const rawPath = match[1];
        const filename = rawPath.split(/[\/\\]/).pop();
        if (!filename) continue;
        
        const decoded = decodeURIComponent(filename);
        if (seen.has(decoded)) continue;
        seen.add(decoded);
        
        const ext = decoded.split('.').pop()?.toLowerCase() || 'bin';
        let kind = 'file';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) kind = 'image';
        else if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) kind = 'video';
        else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) kind = 'audio';

        assets.push({
            asset_id: decoded,
            relative_path: `assets/${decoded}`,
            kind,
            group_id: null
        });
    }
    return assets;
}

class SnapshotServiceImpl {
    private getHeaders(): { Authorization: string; 'Content-Type': string } | null {
        const config = syncService.getConfig();
        if (!config) return null;
        return {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
        };
    }

    private getBaseUrl(): string | null {
        const config = syncService.getConfig();
        return config?.serverUrl || null;
    }

    /** 获取指定文件的版本快照列表（含 can_revert 权限标志） */
    async listSnapshots(vaultId: string, filePath: string, limit = 50): Promise<SnapshotListResult> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const params = new URLSearchParams({
            vault_id: vaultId,
            file_path: filePath,
            limit: String(limit),
        });

        const resp = await fetch(`${base}/api/snapshot/list?${params}`, { headers });
        if (!resp.ok) throw new Error(`Failed to list snapshots: ${resp.status}`);

        const data = await resp.json();
        return { snapshots: data.snapshots ?? [], can_revert: data.can_revert ?? false };
    }


    /** 获取快照内容 */
    async getSnapshotContent(snapshotId: string): Promise<SnapshotContent> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/snapshot/${snapshotId}/content`, { headers });
        if (!resp.ok) throw new Error(`Failed to get snapshot: ${resp.status}`);

        return resp.json();
    }

    /** 回退到指定快照 (附加该快照的资产闭包图谱) */
    async revertToSnapshot(snapshotId: string, assets?: AssetRef[]): Promise<RevertResult> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/snapshot/${snapshotId}/revert`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ assets }),
        });
        if (!resp.ok) throw new Error(`Failed to revert: ${resp.status}`);

        return resp.json();
    }

    /** 删除指定快照（仅限个人空间） */
    async deleteSnapshot(snapshotId: string): Promise<RevertResult> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/snapshot/${snapshotId}`, {
            method: 'DELETE',
            headers,
        });
        if (!resp.ok) throw new Error(`Failed to delete: ${resp.status}`);

        return resp.json();
    }
}

export const snapshotService = new SnapshotServiceImpl();
