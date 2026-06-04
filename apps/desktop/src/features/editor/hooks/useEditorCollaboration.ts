import { useMemo, useState, useEffect } from 'react';
import { DocStatus } from '../components/DocStatusBar';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileSystemStore } from '@/core/fs/store';
import { useCollabLock, CollabLockState } from './useCollabLock';

interface CollaborationState {
    isTeam: boolean;
    localUser: string;
    teamRole: string;
    noteDocStatus: DocStatus;
    noteEditorName: string;
    isNoteEditor: boolean;
    isVaultOwner: boolean;
    effectiveReadOnly: boolean;
    readOnlyReason: string | null;
    collabLockState: CollabLockState;
    collabLockedByName: string | null;
    /** 是否处于协作离线状态（用于封锁评论/批注/回复） */
    isCollabOffline: boolean;
    reportActivity: (mode?: 'request' | 'renew') => void;
}

/**
 * Encapsulates the logic for computing collaboration limits, 
 * read-only states, and solo/team document status.
 */
export function useEditorCollaboration(
    initialMetadata: any, 
    activeReadOnlyProp: boolean = false,
    noteId?: string | null,
    isTeamNote: boolean = false,
    liveDocStatus: string = 'solo',
    fileId: string | null = null
): CollaborationState {
    // 🛡️ 使用 zustand hook 响应式订阅，确保 session 变化时触发重渲染
    const isTeam = !!useSessionStore(s => s.teamVaultId);
    const localUser = useSessionStore(s => s.displayName) ?? '';
    const teamRole = useSessionStore(s => s.teamRole) ?? '';
    const vaultId = useSessionStore(s => s.teamVaultId);
    
    const noteDocStatus = liveDocStatus as DocStatus;
    
    // YAML frontmatter 的 editor 字段（创建笔记时写入创建者的 display name）
    const noteEditorName = (initialMetadata as any)?.editor ?? '';
    
    const isNoteEditor = (isTeam || isTeamNote) && !!localUser && localUser === noteEditorName;
    const isVaultOwner = isTeam && teamRole?.toLowerCase() === 'admin';
    
    // 🌸 史诗级自愈增强：如果当前处于个人库视图（vaultId 为空），但它确实是团队笔记，
    // 我们从磁盘上的物理 mappings 文件中反推其团队归属并自动补齐，激活云端 Collab 悲观锁通道
    const [resolvedVaultId, setResolvedVaultId] = useState<string | null>(vaultId);
    
    useEffect(() => {
        if (vaultId) {
            setResolvedVaultId(vaultId);
            return;
        }
        if (!isTeamNote || !noteId) {
            setResolvedVaultId(null);
            return;
        }

        let isMounted = true;
        (async () => {
            try {
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                const { getRelativePath } = await import('@/shared/utils/pathUtils');
                const rootPath = useFileSystemStore.getState().root?.path;
                if (!rootPath) return;

                const raw = await readTextFile(`${rootPath}/.slash/team_path_mappings.json`);
                const data = JSON.parse(raw);
                let parsedTeams: Record<string, Record<string, string>> = {};
                if (data.teams) {
                    parsedTeams = data.teams;
                } else if (data.vault_id && data.mappings) {
                    parsedTeams[data.vault_id] = data.mappings;
                }

                const currentRelPath = getRelativePath(noteId, rootPath).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                let matchedId = null;
                for (const [vId, maps] of Object.entries(parsedTeams)) {
                    for (const [src] of Object.entries(maps)) {
                        const srcNorm = src.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                        if (currentRelPath === srcNorm || currentRelPath.startsWith(srcNorm + '/')) {
                            matchedId = vId;
                            break;
                        }
                    }
                    if (matchedId) break;
                }
                if (isMounted && matchedId) {
                    setResolvedVaultId(matchedId);
                }
            } catch (e) {
                console.warn('[useEditorCollaboration] Resolution of team vaultId failed:', e);
            }
        })();

        return () => { isMounted = false; };
    }, [vaultId, isTeamNote, noteId]);

    // 🌸 史诗级自愈增强 2：在自愈出的团队 ID 不为空时，即使处于个人视图，也自动异步拉取全局团队成员，
    // 回填至全局变量 (window as any).__slashTeamMembers，确保 @ 提及功能随时能够拉出全局所有成员！
    useEffect(() => {
        if (!resolvedVaultId) return;

        let isMounted = true;
        (async () => {
            try {
                const { syncService } = await import('@/services/SyncService');
                const config = syncService.getConfig();
                if (!config || !config.serverUrl || !config.accessToken) return;

                const { teamService } = await import('@/services/TeamService');
                const result = await teamService.listMembers(config.serverUrl, config.accessToken, resolvedVaultId);
                if (isMounted) {
                    (window as any).__slashTeamMembers = result.members.map(m => ({
                        username: m.username,
                        display_name: m.display_name,
                    }));
                    console.log('[useEditorCollaboration] Automatically synced global team members for @mention:', (window as any).__slashTeamMembers.length);
                }
            } catch (e) {
                console.warn('[useEditorCollaboration] Failed to sync team members for @mention:', e);
            }
        })();

        return () => {
            isMounted = false;
        };
    }, [resolvedVaultId]);

    // RULE 1: Enforce lock if the file is mapped to the Team space AND doc_status is solo AND not the editor
    const isCollabSoloStatusBlocked = isTeamNote && noteDocStatus === 'solo' && !isNoteEditor;

    // RULE 2: Dynamic Pessimistic Lock for Collab mode
    const { lockState, lockedByName, reportActivity } = useCollabLock(resolvedVaultId, fileId, noteDocStatus, isTeamNote);

    // Asynchronously verify if the original editor is no longer part of the team
    const [isOrphaned, setIsOrphaned] = useState(false);

    useEffect(() => {
        setIsOrphaned(false);
        if (!isCollabSoloStatusBlocked || !isTeam || !noteEditorName || !noteId) return;

        let isMounted = true;
        (async () => {
            try {
                const { teamService } = await import('@/services/TeamService');
                const { syncService } = await import('@/services/SyncService');
                const { getRelativePath } = await import('@/shared/utils/pathUtils');
                const { readTextFile } = await import('@tauri-apps/plugin-fs');

                const config = syncService.getConfig();
                const checkVaultId = useSessionStore.getState().teamVaultId;
                const rootPath = useFileSystemStore.getState().root?.path;

                if (!config || !checkVaultId || !rootPath) return;

                const listRes = await teamService.listMembers(config.serverUrl, config.accessToken, checkVaultId);
                const editorStillInTeam = listRes.members.some(m => m.display_name === noteEditorName || m.username === noteEditorName);
                
                if (editorStillInTeam) return;

                // Editor has left. Check if the current user is Admin
                if (teamRole?.toLowerCase() === 'admin') {
                    if (isMounted) setIsOrphaned(true);
                    return;
                }

                // Not Admin. Check if Directory Owner
                const raw = await readTextFile(`${rootPath}/.slash/team_path_mappings.json`).catch(()=>null);
                if (raw) {
                    const data = JSON.parse(raw);
                    let mappings: Record<string, string> = {};
                    if (data.teams && data.teams[checkVaultId]) {
                        mappings = data.teams[checkVaultId];
                    } else if (data.mappings) {
                        mappings = data.mappings as Record<string, string>;
                    } else {
                        mappings = data as Record<string, string>;
                    }
                    const relPath = getRelativePath(noteId, rootPath).replace(/\\/g, '/');
                    let remoteDir = '';
                    for (const [src, tgt] of Object.entries(mappings)) {
                        if (relPath === src || relPath.startsWith(src + '/')) {
                            remoteDir = tgt as string;
                            break;
                        }
                    }

                    if (remoteDir) {
                        const perms = await teamService.getDirectoryPermissions(config.serverUrl, config.accessToken, checkVaultId, remoteDir);
                        const currentUserId = (() => {
                            try {
                                const parts = config.accessToken.split('.');
                                return parts.length === 3 ? JSON.parse(atob(parts[1])).sub : '';
                            } catch { return ''; }
                        })();

                        const isOwner = perms.some(p => p.user_id === currentUserId && p.dir_role?.toLowerCase() === 'owner');
                        if (isMounted && isOwner) {
                            setIsOrphaned(true);
                        }
                    }
                }
            } catch (e) {
                console.error('[Inheritance Check] Failed to verify orphan status:', e);
            }
        })();

        return () => { isMounted = false; };
    }, [isCollabSoloStatusBlocked, isTeam, noteEditorName, noteId, teamRole]);

    // 离线状态：collab 模式下 lockState === 'offline'
    const isCollabOffline = isTeamNote && noteDocStatus === 'collab' && lockState === 'offline';

    // effectiveReadOnly：
    // - activeReadOnlyProp（外部传入的强制只读）
    // - Solo 模式下被封锁（非编辑者且非孤儿继承）
    // - Collab 模式下未拿到悲观锁前都只读；用户点击编辑区后才尝试抢锁
    const collabBlocked = isTeamNote && noteDocStatus === 'collab' && lockState !== 'acquired';
    const effectiveReadOnly = activeReadOnlyProp || (isCollabSoloStatusBlocked && !isOrphaned) || collabBlocked;

    const readOnlyReason = (() => {
        if (!effectiveReadOnly) return null;
        if (activeReadOnlyProp) return 'forced';
        if (isCollabSoloStatusBlocked && !isOrphaned) {
            return noteEditorName ? 'solo_not_editor' : 'solo_missing_editor';
        }
        if (isTeamNote && noteDocStatus === 'collab') {
            if (lockState === 'offline') return 'collab_offline';
            if (lockState === 'unavailable') return 'collab_unavailable';
            if (lockState === 'locked_by_other') return 'collab_locked_by_other';
            if (lockState === 'loading') return 'collab_lock_loading';
            return 'collab_lock_required';
        }
        return 'team_readonly';
    })();

    return useMemo(() => ({
        isTeam,
        localUser,
        teamRole,
        noteDocStatus,
        noteEditorName,
        isNoteEditor,
        isVaultOwner,
        effectiveReadOnly,
        readOnlyReason,
        collabLockState: lockState,
        collabLockedByName: lockedByName,
        isCollabOffline,
        reportActivity,
    }), [isTeam, localUser, teamRole, noteDocStatus, noteEditorName, isNoteEditor, isVaultOwner, effectiveReadOnly, readOnlyReason, lockState, lockedByName, isCollabOffline, reportActivity]);
}
