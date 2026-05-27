/**
 * TeamService — 团队管理 API 封装
 *
 * 对应 Server /api/team/* 端点（Phase 3 Step 1）
 */

// ============================================================
// Types (mirror slash-sync-proto team types)
// ============================================================

export type TeamRole = 'Admin' | 'Observer';
export type DirectoryRole = 'Owner' | 'TeamMember';

export interface TeamCreateResponse {
    vault_id: string;
    name: string;
    access_token: string;
    refresh_token: string;
    user_id: string;
}

export interface CanDeleteDirectoryResponse {
    allowed: boolean;
    reason: string | null;
}

export interface TeamInviteResponse {
    code: string;
    expires_at: number | null;
}

export interface TeamSettingsResponse {
    vault_id: string;
    max_sync_file_size_mb: number;
    updated_by_username: string | null;
    updated_at: string | null;
}

export interface TeamMemberInfo {
    user_id: string;
    username: string;
    display_name: string | null;
    global_role: TeamRole;
    joined_at: number;
}

export interface TeamMembersResponse {
    vault_id: string;
    members: TeamMemberInfo[];
}

export interface DirectoryPermissionInfo {
    directory_path: string;
    user_id: string;
    username: string;
    display_name: string | null;
    dir_role: DirectoryRole;
    observer_visible: boolean;
}

// ============================================================
// Service
// ============================================================

class TeamServiceImpl {
    private async request<T>(
        serverUrl: string,
        token: string,
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const resp = await fetch(`${serverUrl}${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!resp.ok) {
            // 🚨 熔断拦截：处理强制下线或被删除导致的 401/403 权限失效
            if (resp.status === 401 || resp.status === 403) {
                const { syncService } = await import('@/services/SyncService');
                const { useSessionStore } = await import('@/stores/useSessionStore');
                syncService.clearConfig();
                useSessionStore.getState().clearAll();
                window.dispatchEvent(new CustomEvent('sync:auth-expired'));
            }
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || `Team API error: ${resp.status}`);
        }

        return resp.json();
    }

    /** 创建团队空间 */
    async createTeam(
        serverUrl: string,
        token: string,
        name: string,
        username: string,
        password: string,
        displayName: string,
        accessCode?: string,
    ): Promise<TeamCreateResponse> {
        // 当有 accessCode 时，不需要 JWT，直接发请求
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const resp = await fetch(`${serverUrl}/api/team/create`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name, username, password, display_name: displayName,
                access_code: accessCode || undefined,
            }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || `Team API error: ${resp.status}`);
        }
        return resp.json();
    }

    /** Admin 生成邀请码 */
    async generateInvite(
        serverUrl: string,
        token: string,
        vaultId: string,
        expiresInHours = 72,
    ): Promise<TeamInviteResponse> {
        return this.request(serverUrl, token, 'POST', '/api/team/invite', {
            vault_id: vaultId,
            expires_in_hours: expiresInHours,
        });
    }

    /** 切换团队维护状态 */
    async toggleMaintenance(
        serverUrl: string,
        token: string,
        vaultId: string,
        enabled: boolean
    ): Promise<{ ok: boolean; is_maintenance: boolean; maintenance_started_at?: number | null }> {
        return this.request(serverUrl, token, 'POST', '/api/team/maintenance', {
            vault_id: vaultId,
            enabled,
        });
    }

    /** 获取团队设置 (Admin only) */
    async getTeamSettings(
        serverUrl: string,
        token: string,
        vaultId: string,
    ): Promise<TeamSettingsResponse> {
        const params = new URLSearchParams({ vault_id: vaultId });
        return this.request(serverUrl, token, 'GET', `/api/team/settings?${params}`);
    }

    /** 更新团队设置 (Admin only) */
    async updateTeamSettings(
        serverUrl: string,
        token: string,
        vaultId: string,
        maxSyncFileSizeMb: number,
    ): Promise<TeamSettingsResponse> {
        return this.request(serverUrl, token, 'PUT', '/api/team/settings', {
            vault_id: vaultId,
            max_sync_file_size_mb: maxSyncFileSizeMb,
        });
    }

    /** 获取成员列表 */
    async listMembers(
        serverUrl: string,
        token: string,
        vaultId: string,
    ): Promise<TeamMembersResponse> {
        return this.request(
            serverUrl,
            token,
            'GET',
            `/api/team/members?vault_id=${encodeURIComponent(vaultId)}`,
        );
    }

    /** 变更成员全局角色 */
    async updateMemberRole(
        serverUrl: string,
        token: string,
        vaultId: string,
        targetUserId: string,
        newRole: TeamRole,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'PUT',
            `/api/team/members/${encodeURIComponent(targetUserId)}/role`,
            { vault_id: vaultId, target_user_id: targetUserId, new_role: newRole },
        );
    }

    /** 移除成员 */
    async removeMember(
        serverUrl: string,
        token: string,
        vaultId: string,
        targetUserId: string,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'DELETE',
            `/api/team/members/${encodeURIComponent(targetUserId)}?vault_id=${encodeURIComponent(vaultId)}`,
        );
    }

    /** 获取目录权限 */
    async getDirectoryPermissions(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
    ): Promise<DirectoryPermissionInfo[]> {
        const params = new URLSearchParams({ vault_id: vaultId, directory_path: directoryPath });
        return this.request(
            serverUrl,
            token,
            'GET',
            `/api/team/directories/permissions?${params}`,
        );
    }

    /** 设置目录权限 */
    async setDirectoryPermissions(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
        userId: string,
        dirRole: DirectoryRole,
        observerVisible?: boolean,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'PUT',
            '/api/team/directories/permissions',
            {
                vault_id: vaultId,
                directory_path: directoryPath,
                user_id: userId,
                dir_role: dirRole,
                observer_visible: observerVisible,
            },
        );
    }

    /** 重命名团队目录（Admin only） */
    async renameDirectory(
        serverUrl: string,
        token: string,
        vaultId: string,
        oldPrefix: string,
        newPrefix: string,
    ): Promise<{ renamed: number }> {
        return this.request(
            serverUrl,
            token,
            'POST',
            '/api/team/directories/rename',
            {
                vault_id: vaultId,
                old_prefix: oldPrefix,
                new_prefix: newPrefix,
            },
        );
    }

    /** Admin 重置成员密码 */
    async resetPassword(
        serverUrl: string,
        token: string,
        vaultId: string,
        targetUserId: string,
        newPassword: string,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'POST',
            '/api/auth/reset-password',
            { vault_id: vaultId, target_user_id: targetUserId, new_password: newPassword },
        );
    }

    /** 强制登出特定成员（撤销设备的所有 sessions，但不改密码） */
    async revokeSessions(
        serverUrl: string,
        token: string,
        vaultId: string,
        targetUserId: string,
    ): Promise<{ sessions_deleted: number }> {
        return this.request(
            serverUrl,
            token,
            'POST',
            '/api/auth/revoke-sessions',
            { vault_id: vaultId, target_user_id: targetUserId },
        );
    }

    /** 获取目录文件列表（含元数据） */
    async getDirectoryFiles(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
    ): Promise<DirectoryFileInfo[]> {
        const params = new URLSearchParams({ vault_id: vaultId, directory_path: directoryPath });
        return this.request(
            serverUrl,
            token,
            'GET',
            `/api/team/directories/files?${params}`,
        );
    }

    /** 获取团队目录回收站文件列表（软删除项） */
    async getTrashedFiles(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
    ): Promise<TrashedFileInfo[]> {
        const params = new URLSearchParams({ vault_id: vaultId, directory_path: directoryPath });
        return this.request(
            serverUrl,
            token,
            'GET',
            `/api/team/directories/files/trashed?${params}`,
        );
    }

    /** 恢复软删除的文件 */
    async restoreTrashedFile(
        serverUrl: string,
        token: string,
        vaultId: string,
        trashId: string,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'POST',
            '/api/team/directories/files/restore',
            { vault_id: vaultId, trash_id: trashId },
        );
    }

    /** 彻底删除回收站内的垃圾文件 */
    async hardDeleteTrashedFile(
        serverUrl: string,
        token: string,
        vaultId: string,
        trashId: string,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'DELETE',
            '/api/team/directories/files/trashed',
            { vault_id: vaultId, trash_id: trashId },
        );
    }

    /** 移除目录成员 */
    async removeDirectoryMember(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
        userId: string,
    ): Promise<void> {
        await this.request(
            serverUrl,
            token,
            'DELETE',
            '/api/team/directories/permissions',
            {
                vault_id: vaultId,
                directory_path: directoryPath,
                user_id: userId,
            },
        );
    }

    /**
     * 身份迁移 — 将绑定个人空间中旧用户的 file_states 迁移到当前用户
     * 场景: connect+invite 加入团队后, 或切换团队时
     */
    async migrateIdentity(
        serverUrl: string,
        token: string,
        oldUserId: string,
        personalVaultId: string,
    ): Promise<{ migrated_editor: number; migrated_pusher: number; vault_transferred: boolean }> {
        return this.request(
            serverUrl,
            token,
            'POST',
            '/api/team/migrate-identity',
            {
                old_user_id: oldUserId,
                personal_vault_id: personalVaultId,
            },
        );
    }

    /** 检查是否允许删除团队目录 */
    async canDeleteDirectory(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
        manageMode?: boolean,
    ): Promise<CanDeleteDirectoryResponse> {
        const params = new URLSearchParams({ vault_id: vaultId, directory_path: directoryPath });
        if (manageMode) {
            params.append('manage_mode', 'true');
        }
        return this.request(
            serverUrl,
            token,
            'GET',
            `/api/team/directories/can-delete?${params}`,
        );
    }

    /** 彻底删除团队目录（服务端清理 `directory_permissions` 和麾下全部存量文件） */
    async deleteDirectory(
        serverUrl: string,
        token: string,
        vaultId: string,
        directoryPath: string,
        manageMode?: boolean,
    ): Promise<{ success: boolean }> {
        return this.request(
            serverUrl,
            token,
            'DELETE',
            `/api/team/directories`,
            {
                vault_id: vaultId,
                directory_path: directoryPath,
                manage_mode: manageMode,
            }
        );
    }

    /** 移动单个文件到另一个目录（Admin 维护通道） */
    async moveFile(
        serverUrl: string,
        token: string,
        vaultId: string,
        sourcePath: string,
        destinationDir: string,
    ): Promise<{ success: boolean; new_path: string }> {
        return this.request(
            serverUrl,
            token,
            'POST',
            '/api/team/directories/files/move',
            {
                vault_id: vaultId,
                source_path: sourcePath,
                destination_dir: destinationDir,
            },
        );
    }

    /** 软删除单个文件（Admin 维护通道） */
    async deleteFile(
        serverUrl: string,
        token: string,
        vaultId: string,
        filePath: string,
        manageMode?: boolean,
    ): Promise<{ success: boolean }> {
        return this.request(
            serverUrl,
            token,
            'DELETE',
            '/api/team/directories/files',
            {
                vault_id: vaultId,
                file_path: filePath,
                manage_mode: manageMode,
            },
        );
    }

    /** 修改个人资料（display_name / 密码） */
    async updateProfile(
        serverUrl: string,
        token: string,
        data: { display_name?: string; current_password?: string; new_password?: string },
    ): Promise<{ id: string; username: string; display_name: string | null }> {
        const resp = await fetch(`${serverUrl}/api/auth/me`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || `Update profile failed: ${resp.status}`);
        }

        return resp.json();
    }

    /** 获取存储空间统计 (Admin only) */
    async getStorageStats(
        serverUrl: string,
        token: string,
        vaultId: string,
    ): Promise<StorageStatsResponse> {
        const params = new URLSearchParams({ vault_id: vaultId });
        return this.request(serverUrl, token, 'GET', `/api/team/storage/stats?${params}`);
    }

    /** 清理预览 (Admin only) */
    async cleanupPreview(
        serverUrl: string,
        token: string,
        vaultId: string,
        target: CleanupTarget,
        olderThanDays?: number,
    ): Promise<CleanupResponse> {
        return this.request(serverUrl, token, 'POST', '/api/team/storage/cleanup-preview', {
            vault_id: vaultId,
            target,
            older_than_days: olderThanDays,
        });
    }

    /** 执行清理 (Admin only) */
    async cleanup(
        serverUrl: string,
        token: string,
        vaultId: string,
        target: CleanupTarget,
        olderThanDays?: number,
    ): Promise<CleanupResponse> {
        return this.request(serverUrl, token, 'POST', '/api/team/storage/cleanup', {
            vault_id: vaultId,
            target,
            older_than_days: olderThanDays,
        });
    }
}

export interface DirectoryFileInfo {
    name: string;
    relative_path: string;
    is_dir: boolean;
    size: number;
    editor_username: string | null;
    editor_display_name: string | null;
    pushed_by_username: string | null;
    pushed_at: number | null;
}

export interface TrashedFileInfo {
    id: string;
    original_path: string;
    size: number;
    deleted_by_username: string | null;
    deleted_by_display_name: string | null;
    deleted_at: string | null;
}

// ── Storage Dashboard Types ──

export type CleanupTarget = 'snapshots' | 'trash' | 'legacy_files';

export interface CategoryStats {
    count: number;
    size_bytes: number;
}

export interface TemporalStats {
    count: number;
    size_bytes: number;
    oldest: string | null;
}

export interface MemberUsage {
    user_id: string;
    display_name: string;
    markdown: CategoryStats;
    media: CategoryStats;
    total_bytes: number;
}

export interface TeamSpaceStats {
    markdown: CategoryStats;
    media: CategoryStats;
    trash: TemporalStats;
}

export interface PersonalSpaceStats {
    markdown: CategoryStats;
    media: CategoryStats;
}

export interface SnapshotStats {
    team: TemporalStats;
    personal: TemporalStats;
}

export interface StorageStatsResponse {
    total_bytes: number;
    team_space: TeamSpaceStats;
    personal_space: PersonalSpaceStats;
    snapshots: SnapshotStats;
    legacy_files: CategoryStats;
    by_member: MemberUsage[];
}

export interface CleanupResponse {
    deleted_count: number;
    freed_bytes: number;
}

export const teamService = new TeamServiceImpl();
