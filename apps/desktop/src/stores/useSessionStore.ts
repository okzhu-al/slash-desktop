/**
 * useSessionStore — 统一会话状态管理
 *
 * 收归之前散落在 localStorage 中直接读写的会话状态：
 * - slash_team_vault_id    (26处 → store.teamVaultId)
 * - slash_user_display_name(16处 → store.displayName)
 * - slash_user_id          (5处  → store.userId)
 * - slash_team_vault_name  (4处  → store.teamVaultName)
 * - slash_sync_user_type   (3处  → store.userType)
 * - slash_team_username    (1处  → store.teamUsername)
 * - slash_team_role        (1处  → store.teamRole)
 * - slash_team_bound_vault_path (1处 → store.teamBoundVaultPath)
 *
 * 后端仍用 localStorage 做持久化（通过 Zustand persist middleware），
 * 但所有组件统一从此 store 读写，消除散射调用。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SessionState {
    // ── 团队 ──
    teamVaultId: string | null;
    teamVaultName: string | null;
    teamUsername: string | null;
    teamRole: string | null;
    teamBoundVaultPath: string | null;

    // ── 用户 ──
    userId: string | null;
    displayName: string | null;
    userType: 'personal' | 'team' | null;

    // ── 动作 ──
    isAdminManageMode: boolean;
    adminManageModeExpiry: number | null;
    setAdminManageMode: (enabled: boolean) => void;

    setTeamInfo: (info: {
        teamVaultId: string;
        teamVaultName?: string;
        teamUsername?: string;
        teamRole?: string;
        teamBoundVaultPath?: string;
    }) => void;
    setUserInfo: (info: {
        userId?: string;
        displayName?: string;
        userType?: 'personal' | 'team';
    }) => void;
    clearTeamInfo: () => void;
    clearAll: () => void;
}

export const useSessionStore = create<SessionState>()(
    persist(
        (set) => ({
            teamVaultId: null,
            teamVaultName: null,
            teamUsername: null,
            teamRole: null,
            teamBoundVaultPath: null,
            userId: null,
            displayName: null,
            userType: null,
            isAdminManageMode: false,
            adminManageModeExpiry: null,

            setTeamInfo: (info) =>
                set((state) => ({
                    teamVaultId: info.teamVaultId ?? state.teamVaultId,
                    teamVaultName: info.teamVaultName ?? state.teamVaultName,
                    teamUsername: info.teamUsername ?? state.teamUsername,
                    teamRole: info.teamRole ?? state.teamRole,
                    teamBoundVaultPath: info.teamBoundVaultPath ?? state.teamBoundVaultPath,
                })),

            setUserInfo: (info) =>
                set((state) => ({
                    userId: info.userId ?? state.userId,
                    displayName: info.displayName ?? state.displayName,
                    userType: info.userType ?? state.userType,
                })),

            setAdminManageMode: (enabled) => set({ 
                isAdminManageMode: enabled,
                adminManageModeExpiry: enabled ? Date.now() + 30 * 60 * 1000 : null
            }),

            clearTeamInfo: () =>
                set({
                    teamVaultId: null,
                    teamVaultName: null,
                    teamUsername: null,
                    teamRole: null,
                    teamBoundVaultPath: null,
                }),

            clearAll: () =>
                set({
                    teamVaultId: null,
                    teamVaultName: null,
                    teamUsername: null,
                    teamRole: null,
                    teamBoundVaultPath: null,
                    userId: null,
                    displayName: null,
                    userType: null,
                    isAdminManageMode: false,
                }),
        }),
        {
            name: 'slash-session',
            // 持久化到 localStorage，key 为 'slash-session'
            // 所有旧的散落 key 不再被新代码写入
            // 启动时通过 migrateFromLegacy() 一次性迁入
            partialize: (state) => Object.fromEntries(
                Object.entries(state).filter(([key]) => key !== 'isAdminManageMode')
            ) as SessionState,
        }
    )
);

/**
 * 一次性迁移：从旧 localStorage 散落 key 读入 store，然后清除旧 key。
 * 在 App 启动时调用一次。
 */
export function migrateFromLegacyLocalStorage(): void {
    const state = useSessionStore.getState();
    // 只在 store 为空时迁移（避免覆盖）
    if (state.teamVaultId || state.userId) return;

    const teamVaultId = localStorage.getItem('slash_team_vault_id');
    const teamVaultName = localStorage.getItem('slash_team_vault_name');
    const teamUsername = localStorage.getItem('slash_team_username');
    const teamRole = localStorage.getItem('slash_team_role');
    const teamBoundVaultPath = localStorage.getItem('slash_team_bound_vault_path');
    const userId = localStorage.getItem('slash_user_id');
    const displayName = localStorage.getItem('slash_user_display_name');
    const userType = localStorage.getItem('slash_sync_user_type') as 'personal' | 'team' | null;

    const hasLegacy = teamVaultId || userId || displayName;
    if (!hasLegacy) return;

    console.log('[SessionStore] Migrating from legacy localStorage keys...');

    useSessionStore.setState({
        teamVaultId,
        teamVaultName,
        teamUsername,
        teamRole,
        teamBoundVaultPath,
        userId,
        displayName,
        userType,
    });

    // 清除旧 key（新代码不再写入这些 key）
    const legacyKeys = [
        'slash_team_vault_id',
        'slash_team_vault_name',
        'slash_team_username',
        'slash_team_role',
        'slash_team_bound_vault_path',
        'slash_user_id',
        'slash_user_display_name',
        'slash_sync_user_type',
    ];
    for (const key of legacyKeys) {
        localStorage.removeItem(key);
    }

    console.log('[SessionStore] Migration complete, removed', legacyKeys.length, 'legacy keys');
}
