/**
 * AnnotationService — 段落级批注 API 封装
 * Phase 3.2③: 选中文本添加批注，支持回复和解决
 */

import { syncService } from './SyncService';

// ============================================================
// Types
// ============================================================

export interface AnnotationInfo {
    id: string;
    anchor_id: string;
    anchor_preview: string | null;
    author_name: string | null;
    content: string;
    parent_id: string | null;
    resolved: boolean | null;
    created_at: string;
}

// ============================================================
// Service
// ============================================================

class AnnotationServiceImpl {
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

    /** 获取指定文件的批注列表 */
    async listAnnotations(vaultId: string, filePath: string): Promise<AnnotationInfo[]> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const params = new URLSearchParams({ vault_id: vaultId, file_path: filePath });
        const resp = await fetch(`${base}/api/annotation/list?${params}`, { headers });
        if (!resp.ok) throw new Error(`Failed to list annotations: ${resp.status}`);

        const data = await resp.json();
        return data.annotations;
    }

    /** 创建批注 */
    async createAnnotation(
        vaultId: string,
        filePath: string,
        anchorId: string,
        anchorPreview: string,
        content: string,
        parentId?: string,
    ): Promise<string> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/annotation`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                vault_id: vaultId,
                file_path: filePath,
                anchor_id: anchorId,
                anchor_preview: anchorPreview,
                content,
                parent_id: parentId,
            }),
        });
        if (!resp.ok) throw new Error(`Failed to create annotation: ${resp.status}`);

        const data = await resp.json();
        return data.id;
    }

    /** 切换批注已解决状态 */
    async resolveAnnotation(annotationId: string): Promise<void> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/annotation/${annotationId}/resolve`, {
            method: 'POST',
            headers,
        });
        if (!resp.ok) throw new Error(`Failed to resolve annotation: ${resp.status}`);
    }

    /** 删除批注 */
    async deleteAnnotation(annotationId: string): Promise<void> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/annotation/${annotationId}`, {
            method: 'DELETE',
            headers,
        });
        if (!resp.ok) throw new Error(`Failed to delete annotation: ${resp.status}`);
    }

    /**
     * 查询 vault 内自 since（Unix ms）之后有新批注/评论的文件路径列表
     * 用于 sync 完成后检测"批注/评论活动"（批注不改文件内容，不出现在 pulled_paths）
     */
    async getCollabActivity(vaultId: string, since: number): Promise<string[]> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) return [];

        try {
            const params = new URLSearchParams({ vault_id: vaultId, since: String(since) });
            const resp = await fetch(`${base}/api/annotation/activity?${params}`, { headers });
            if (!resp.ok) return [];
            const data = await resp.json();
            return data.paths ?? [];
        } catch {
            return [];
        }
    }
}

export const annotationService = new AnnotationServiceImpl();
