/**
 * CommentService — 文档评论 API 封装
 * Phase 3.2②: 文档级评论的 CRUD 操作
 */

import { syncService } from './SyncService';

// ============================================================
// Types
// ============================================================

export interface CommentInfo {
    id: string;
    author_name: string | null;
    content: string;
    parent_id: string | null;
    parent_type: string | null;
    created_at: string;
}

// ============================================================
// Service
// ============================================================

class CommentServiceImpl {
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

    /** 获取指定文件的评论列表 */
    async listComments(vaultId: string, filePath: string): Promise<CommentInfo[]> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const params = new URLSearchParams({
            vault_id: vaultId,
            file_path: filePath,
        });

        const resp = await fetch(`${base}/api/comment/list?${params}`, { headers });
        if (!resp.ok) throw new Error(`Failed to list comments: ${resp.status}`);

        const data = await resp.json();
        return data.comments;
    }

    /** 创建评论/回复 */
    async createComment(vaultId: string, filePath: string, content: string, parentId?: string, parentType?: string): Promise<string> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/comment`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ vault_id: vaultId, file_path: filePath, content, parent_id: parentId, parent_type: parentType }),
        });
        if (!resp.ok) throw new Error(`Failed to create comment: ${resp.status}`);

        const data = await resp.json();
        return data.id;
    }

    /** 删除评论（仅限本人） */
    async deleteComment(commentId: string): Promise<void> {
        const base = this.getBaseUrl();
        const headers = this.getHeaders();
        if (!base || !headers) throw new Error('Sync not configured');

        const resp = await fetch(`${base}/api/comment/${commentId}`, {
            method: 'DELETE',
            headers,
        });
        if (!resp.ok) throw new Error(`Failed to delete comment: ${resp.status}`);
    }
}

export const commentService = new CommentServiceImpl();
