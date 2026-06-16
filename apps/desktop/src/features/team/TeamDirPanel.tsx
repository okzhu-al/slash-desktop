/**
 * TeamDirPanel — 团队空间目录管理面板
 *
 * 功能：
 * ① 成员列表 (Owner 排第一)
 * ② 从 Observer 中邀请 team-member
 * ③ Observer 可见性开关
 * ④ 子目录/文件列表 (含元数据)
 * ⑤ Pull 到本地 (仅 Admin)
 * ⑥ Task Kanban (仅 PROJECT 子目录)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    Users, User, UserPlus, Crown, UserMinus, Eye, EyeOff,
    Folder, FileText, Loader2, ChevronDown, ChevronRight,
    Trash2, RotateCcw,
} from 'lucide-react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { cn } from '@/shared/utils/cn';
import { syncService } from '@/services/SyncService';
import { autoSyncManager } from '@/services/AutoSyncManager';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileSystemStore } from '@/core/fs/store';
import { PARA_TEAM_TO_PERSONAL } from '@/features/sidebar/hooks/useTeamDirectoryMapping';
import {
    teamService,
    type TeamMemberInfo,
    type DirectoryPermissionInfo,
    type DirectoryFileInfo,
    type TrashedFileInfo,
} from '@/services/TeamService';

interface TeamDirPanelProps {
    /** 团队目录的相对路径 (如 '01_PROJECTS/Alpha') */
    directoryPath: string;
    /** UUID-first directory identity */
    directoryId?: string | null;
    /** 目录名称 */
    directoryName?: string;
}

export function TeamDirPanel({
    directoryPath,
    directoryId,
}: TeamDirPanelProps) {
    const { t } = useTranslation();

    // ── 连接信息 ──
    const teamVaultId = useSessionStore(s => s.teamVaultId);

    // ── 数据 ──
    const [dirMembers, setDirMembers] = useState<DirectoryPermissionInfo[]>([]);
    const [allTeamMembers, setAllTeamMembers] = useState<TeamMemberInfo[]>([]);
    const [files, setFiles] = useState<DirectoryFileInfo[]>([]);
    const [trashedFiles, setTrashedFiles] = useState<TrashedFileInfo[]>([]);
    const [observerVisible, setObserverVisible] = useState(false); // 默认不可见，与后端一致
    const [loading, setLoading] = useState(true);
    const [currentUserRole, setCurrentUserRole] = useState<'admin' | 'observer'>('observer');

    // ── 操作状态 ──
    const [inviteUserId, setInviteUserId] = useState('');
    const [actionLoading, setActionLoading] = useState<string | null>(null);

    // ── 折叠/展开 + 分页 ──
    const [membersExpanded, setMembersExpanded] = useState(true);
    const [filesExpanded, setFilesExpanded] = useState(true);
    const [trashExpanded, setTrashExpanded] = useState(true);
    const FILE_PAGE_SIZE = 10;
    const [trashVisibleCount, setTrashVisibleCount] = useState(FILE_PAGE_SIZE);
    const [fileVisibleCount, setFileVisibleCount] = useState(FILE_PAGE_SIZE);
    const loadSeqRef = useRef(0);
    const refreshTimerRef = useRef<number | null>(null);
    const allMembersSigRef = useRef('');
    const filesSigRef = useRef('');
    const dirMembersSigRef = useRef('');
    const trashedFilesSigRef = useRef('');

    const isAdmin = currentUserRole === 'admin';

    // 目录 Owner 也可管理成员（不只是 Admin）
    const [isDirOwner, setIsDirOwner] = useState(false);
    const canManageDir = isAdmin || isDirOwner;

    const setArrayIfChanged = <T,>(
        sigRef: MutableRefObject<string>,
        setter: Dispatch<SetStateAction<T[]>>,
        next: T[],
    ) => {
        const signature = JSON.stringify(next);
        if (sigRef.current === signature) return;
        sigRef.current = signature;
        setter(next);
    };

    const teamPathToLocalPath = (teamPath: string): string | null => {
        const normalized = teamPath.replace(/\\/g, '/').replace(/\/$/, '');
        for (const [teamPrefix, personalPrefix] of Object.entries(PARA_TEAM_TO_PERSONAL)) {
            if (normalized === teamPrefix) return personalPrefix;
            if (normalized.startsWith(`${teamPrefix}/`)) {
                return `${personalPrefix}${normalized.slice(teamPrefix.length)}`;
            }
        }
        return null;
    };

    const isActiveMappingForPath = async (
        vaultRoot: string,
        localPath: string,
        remotePath: string,
    ): Promise<boolean> => {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const localNorm = localPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        const remoteNorm = remotePath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

        try {
            const raw = await readTextFile(`${vaultRoot}/.slash/team_directory_mappings.json`);
            const data = JSON.parse(raw);
            const directories = teamVaultId ? data?.teams?.[teamVaultId]?.directories : null;
            if (directories && typeof directories === 'object') {
                for (const mapping of Object.values(directories) as Array<any>) {
                    if (mapping?.status !== 'active') continue;
                    const mappedLocal = String(mapping.local_path || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                    const mappedRemote = String(mapping.remote_path || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                    if (mappedLocal === localNorm && mappedRemote === remoteNorm) return true;
                }
            }
        } catch {
            // Mapping files are optional.
        }

        try {
            const raw = await readTextFile(`${vaultRoot}/.slash/team_path_mappings.json`);
            const data = JSON.parse(raw);
            const mappings = teamVaultId ? data?.teams?.[teamVaultId] : null;
            if (mappings && typeof mappings === 'object') {
                for (const [source, target] of Object.entries(mappings)) {
                    const mappedLocal = String(source).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                    const mappedRemote = String(target).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                    if (mappedLocal === localNorm && mappedRemote === remoteNorm) return true;
                }
            }
        } catch {
            // Legacy mapping is optional.
        }

        return false;
    };

    const shouldForceRecoverDirectory = async (trash: TrashedFileInfo): Promise<boolean> => {
        if (!trash.original_directory_id) return false;
        const vaultRoot = useFileSystemStore.getState().root?.path;
        if (!vaultRoot) return false;
        const parentRemote = trash.original_path.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
        const localParent = teamPathToLocalPath(parentRemote);
        if (!localParent) return false;

        const { exists } = await import('@tauri-apps/plugin-fs');
        const occupied = await exists(`${vaultRoot.replace(/\/$/, '')}/${localParent}`).catch(() => false);
        if (!occupied) return false;

        return !(await isActiveMappingForPath(vaultRoot, localParent, parentRemote));
    };

    // 🛡️ BUG-E06: PARA 根目录（01_PROJECTS 等不含 /）回收站仅 Admin 可操作
    const isParaRoot = !directoryPath.includes('/');
    const canViewTrash = isParaRoot ? isAdmin : canManageDir;

    // ── 加载所有数据 ──
    const loadData = useCallback(async (showLoader = true) => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        const seq = ++loadSeqRef.current;
        if (showLoader) setLoading(true);
        try {
            // 先从 JWT 判断角色
            let currentUserId = '';
            try {
                const tokenParts = config.accessToken.split('.');
                if (tokenParts.length === 3) {
                    const payload = JSON.parse(atob(tokenParts[1]));
                    currentUserId = payload.sub || '';
                }
            } catch { /* JWT decode failed */ }

            // 加载成员列表（observer 也可以查看成员列表）
            const [membersResult, filesResult] = await Promise.all([
                teamService.listMembers(config.serverUrl, config.accessToken, teamVaultId),
                teamService.getDirectoryFiles(config.serverUrl, config.accessToken, teamVaultId, directoryPath, directoryId),
            ]);

            if (seq !== loadSeqRef.current) return;
            setArrayIfChanged(allMembersSigRef, setAllTeamMembers, membersResult.members);
            setArrayIfChanged(filesSigRef, setFiles, filesResult);

            // 判断当前用户是否为 Admin
            const me = membersResult.members.find(m => m.user_id === currentUserId);
            const userIsAdmin = !!(me && me.global_role === 'Admin');
            setCurrentUserRole(userIsAdmin ? 'admin' : 'observer');

            // 保存 currentUserId 供目录 Owner 判断
            const savedUserId = currentUserId;

            // 所有用户都加载目录权限（成员列表只读），管理操作在 UI 层由 isAdmin 控制
            try {
                const permResult = await teamService.getDirectoryPermissions(
                    config.serverUrl, config.accessToken, teamVaultId, directoryPath, directoryId
                );
                if (seq !== loadSeqRef.current) return;
                setArrayIfChanged(dirMembersSigRef, setDirMembers, permResult);
                const directPerms = permResult.filter(p => !p.inherited);
                if (directPerms.length > 0) {
                    setObserverVisible(directPerms[0].observer_visible);
                } else if (permResult.length > 0) {
                    setObserverVisible(permResult[0].observer_visible);
                } else {
                    setObserverVisible(false);
                }
                // 判断当前用户是否为目录 Owner
                const isOwnerNow = permResult.some(p => p.user_id === savedUserId && p.dir_role === 'Owner');
                setIsDirOwner(isOwnerNow);

                // 🛡️ BUG-E06: PARA 根目录回收站仅 Admin 可查看
                const isRoot = !directoryPath.includes('/');
                const trashAllowed = isRoot ? userIsAdmin : (userIsAdmin || isOwnerNow);
                if (trashAllowed) {
                    try {
                        const trasheds = await teamService.getTrashedFiles(
                            config.serverUrl, config.accessToken, teamVaultId, directoryPath, directoryId
                        );
                        if (seq !== loadSeqRef.current) return;
                        setArrayIfChanged(trashedFilesSigRef, setTrashedFiles, trasheds);
                    } catch (e) {
                        console.warn('[TeamDirPanel] Failed to load trash:', e);
                        setArrayIfChanged(trashedFilesSigRef, setTrashedFiles, []);
                    }
                } else {
                    setArrayIfChanged(trashedFilesSigRef, setTrashedFiles, []);
                }
            } catch (permErr) {
                console.warn('[TeamDirPanel] Failed to load directory permissions (read-only fallback):', permErr);
                setArrayIfChanged(dirMembersSigRef, setDirMembers, []);
                setObserverVisible(false);
            }
        } catch (e) {
            console.error('[TeamDirPanel] Failed to load:', e);
        } finally {
            if (showLoader && seq === loadSeqRef.current) setLoading(false);
        }
    }, [teamVaultId, directoryPath, directoryId]);

    useEffect(() => { loadData(true); }, [loadData]);

    // ── 监听后台全局同步及变化事件，实现实时无损刷新视图 ──
    useEffect(() => {
        const hasMeaningfulSyncChange = (event: Event): boolean => {
            if (event.type !== 'sync:completed') return true;
            const detail = (event as CustomEvent)?.detail;
            if (!detail) return false;
            const hasServerDeleted = Array.isArray(detail.server_deleted) && detail.server_deleted.length > 0;
            const actuallyPulled = Array.isArray(detail.actually_pulled_paths) ? detail.actually_pulled_paths.length : 0;
            const filesPulled = Number(detail.files_pulled || 0);
            const filesPushed = Number(detail.files_pushed || 0);
            return hasServerDeleted || actuallyPulled > 0 || filesPulled > 0 || filesPushed > 0;
        };

        const handleAutoRefresh = (event: Event) => {
            if (!hasMeaningfulSyncChange(event)) return;
            if (refreshTimerRef.current) {
                window.clearTimeout(refreshTimerRef.current);
            }
            refreshTimerRef.current = window.setTimeout(() => {
                refreshTimerRef.current = null;
                loadData(false);
            }, 300);
        };
        window.addEventListener('slash:team-file-deleted', handleAutoRefresh);
        window.addEventListener('slash:team-dir-changed', handleAutoRefresh);
        window.addEventListener('team:directories-changed', handleAutoRefresh);
        window.addEventListener('sync:completed', handleAutoRefresh);
        return () => {
            window.removeEventListener('slash:team-file-deleted', handleAutoRefresh);
            window.removeEventListener('slash:team-dir-changed', handleAutoRefresh);
            window.removeEventListener('team:directories-changed', handleAutoRefresh);
            window.removeEventListener('sync:completed', handleAutoRefresh);
            if (refreshTimerRef.current) {
                window.clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, [loadData]);

    // ── 邀请成员到目录 ──
    const handleInviteMember = async () => {
        if (!inviteUserId) return;
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setActionLoading('invite');
        try {
            await teamService.setDirectoryPermissions(
                config.serverUrl, config.accessToken, teamVaultId,
                directoryPath, inviteUserId, 'TeamMember', observerVisible, directoryId,
            );
            setInviteUserId('');
            await loadData(false);
            // 立即触发同步，让新加入的目录内容尽快 pull 到个人空间
            autoSyncManager.manualSync();
        } catch (e) {
            console.error('[TeamDirPanel] Invite failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    const handleInviteAllMembers = async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId || availableObservers.length === 0) return;
        setActionLoading('invite-all');
        try {
            await Promise.all(availableObservers.map(member =>
                teamService.setDirectoryPermissions(
                    config.serverUrl, config.accessToken, teamVaultId,
                    directoryPath, member.user_id, 'TeamMember', observerVisible, directoryId,
                )
            ));
            setInviteUserId('');
            await loadData(false);
            autoSyncManager.manualSync();
        } catch (e) {
            console.error('[TeamDirPanel] Invite all failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    // ── 移除成员 ──
    const handleRemoveMember = async (userId: string) => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setActionLoading(userId);
        try {
            await teamService.removeDirectoryMember(
                config.serverUrl, config.accessToken, teamVaultId,
                directoryPath, userId, directoryId,
            );
            await loadData(false);
        } catch (e) {
            console.error('[TeamDirPanel] Remove failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    // ── 切换 Owner/TeamMember ──
    const handleToggleRole = async (userId: string, currentRole: string) => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setActionLoading(userId);
        const newRole = currentRole === 'Owner' ? 'TeamMember' : 'Owner';
        try {
            await teamService.setDirectoryPermissions(
                config.serverUrl, config.accessToken, teamVaultId,
                directoryPath, userId, newRole as 'Owner' | 'TeamMember', observerVisible, directoryId,
            );
            await loadData(false);
        } catch (e) {
            console.error('[TeamDirPanel] Role toggle failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    // ── Observer 可见性切换 ──
    const handleToggleVisibility = async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        const newVal = !observerVisible;
        setObserverVisible(newVal);
        try {
            const directMembers = dirMembers.filter(m => !m.inherited);
            if (directMembers.length > 0) {
                // 更新所有现有权限记录的 observer_visible
                for (const m of directMembers) {
                    await teamService.setDirectoryPermissions(
                        config.serverUrl, config.accessToken, teamVaultId,
                        directoryPath, m.user_id, m.dir_role, newVal, directoryId,
                    );
                }
            } else {
                // 无权限记录时，用当前用户创建一条 owner 记录来设置可见性
                const currentUserId = (() => {
                    try {
                        const parts = config.accessToken.split('.');
                        return parts.length === 3 ? JSON.parse(atob(parts[1])).sub : '';
                    } catch { return ''; }
                })();
                if (currentUserId) {
                    await teamService.setDirectoryPermissions(
                        config.serverUrl, config.accessToken, teamVaultId,
                        directoryPath, currentUserId, 'Owner' as any, newVal, directoryId,
                    );
                }
            }
            // 刷新数据确保状态同步
            await loadData(false);
        } catch (e) {
            console.error('[TeamDirPanel] Visibility toggle failed:', e);
            setObserverVisible(!newVal); // rollback
        }
    };


    // ── 回收站操作 ──
    const handleRestoreTrash = async (trash: TrashedFileInfo) => {
        const isConfirmed = await confirm(
            t('team.trash_restore_confirm', '确定要恢复该文件吗？\n文件将回到原有的路径。如果原路径已有同名文件可能会被覆盖。'),
            { title: t('common.confirm', '确认'), kind: 'warning' }
        );
        if (!isConfirmed) return;
        
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        const forceRecoverDirectory = await shouldForceRecoverDirectory(trash);
        setActionLoading(`restore-${trash.id}`);
        try {
            await teamService.restoreTrashedFile(
                config.serverUrl,
                config.accessToken,
                teamVaultId,
                trash.id,
                { forceRecoverDirectory },
            );
            await loadData(false);
            // 直接触发本地全域同步脉搏，防止恢复文件落后于 Personal Space 视野
            autoSyncManager.manualSync();
        } catch (e) {
            console.error('[TeamDirPanel] Restore trash failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    const handleHardDeleteTrash = async (trashId: string) => {
        const isConfirmed = await confirm(
            t('team.trash_delete_confirm', '【警告】彻底删除后不可恢复！\n该文件将从此世界上永久消失。\n\n真的要继续吗？'),
            { title: t('common.warning', '警告'), kind: 'warning' }
        );
        if (!isConfirmed) return;
        
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setActionLoading(`delete-${trashId}`);
        try {
            await teamService.hardDeleteTrashedFile(config.serverUrl, config.accessToken, teamVaultId, trashId);
            await loadData(false);
        } catch (e) {
            console.error('[TeamDirPanel] Hard delete trash failed:', e);
        } finally {
            setActionLoading(null);
        }
    };

    // ── 可邀请的成员列表（排除已在此目录的）──
    const availableObservers = allTeamMembers.filter(m => {
        const isInDir = dirMembers.some(dm => dm.user_id === m.user_id);
        return !isInDir;
    });

    // ── 排序：Owner 排第一 ──
    const sortedMembers = [...dirMembers].sort((a, b) => {
        if (a.dir_role === 'Owner' && b.dir_role !== 'Owner') return -1;
        if (a.dir_role !== 'Owner' && b.dir_role === 'Owner') return 1;
        return (a.display_name || a.username).localeCompare(b.display_name || b.username);
    });

    // ── 显示名解析：__personal__ → Admin 的显示名 ──
    const resolveDisplayName = (username: string | null, displayName: string | null): string => {
        if (!username && !displayName) return '-';
        const name = displayName || username || '-';
        if (name === '__personal__') {
            // 查找 Admin 的显示名
            const admin = allTeamMembers.find(m => m.global_role === 'Admin');
            return admin?.display_name || admin?.username || 'Admin';
        }
        return name;
    };

    // ── 格式化时间 ──
    const formatTime = (ts: number | null) => {
        if (!ts) return '-';
        return new Date(ts).toLocaleDateString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 text-zinc-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                {t('common.loading')}
            </div>
        );
    }

    const headerActionsElement = document.getElementById('folder-page-header-actions');

    return (
        <div className="space-y-6 max-w-4xl">
            {/* ③ Observer 可见性 (传送到 FolderPage Header 右侧) */}
            {canManageDir && headerActionsElement && createPortal(
                <div className="flex items-center gap-2 hover:bg-zinc-100/50 dark:hover:bg-white/5 pl-3 pr-2 py-1.5 rounded-full transition-colors" title={t('team.dir_observer_hint', '开启后，未指派具体权限的团队访客也可在树中查看此目录')}>
                    {observerVisible ? (
                        <Eye size={14} className="text-teal-500" />
                    ) : (
                        <EyeOff size={14} className="text-zinc-400" />
                    )}
                    <span className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
                        {t('team.dir_observer_visible', '访客可见')}
                    </span>
                    <button
                        onClick={handleToggleVisibility}
                        className={cn(
                            "relative w-9 h-5 rounded-full transition-colors outline-none",
                            observerVisible ? "bg-teal-500 dark:bg-teal-600" : "bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600"
                        )}
                    >
                        <span
                            className={cn(
                                "absolute top-[2px] left-[2px] w-4 h-4 bg-white rounded-full transition-transform duration-300 shadow-sm",
                                observerVisible ? "translate-x-4" : "translate-x-0"
                            )}
                        />
                    </button>
                </div>,
                headerActionsElement
            )}

            {/* ① 成员管理（可折叠，Title同行含 ②邀请功能） */}
            <section>
                <div className="flex items-center justify-between w-full mb-3 group">
                    <div 
                        role="button"
                        onClick={() => setMembersExpanded(v => !v)}
                        className="flex items-center gap-2 cursor-pointer"
                    >
                        <ChevronRight size={14} className={cn('shrink-0 transition-transform text-zinc-400', membersExpanded && 'rotate-90')} />
                        <Users size={18} className="text-indigo-500 dark:text-blue-400" />
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {t('team.dir_section_members')}
                        </h3>
                        <span className="text-xs text-zinc-400">({sortedMembers.length})</span>
                    </div>

                    {/* 右侧：邀请表单 & 刷新 */}
                    <div className="flex items-center gap-2">
                        {/* ② 精致紧凑型 邀请成员 (Admin/Owner) */}
                        {canManageDir && availableObservers.length > 0 && (
                            <div className="flex items-center gap-1 bg-zinc-100/50 dark:bg-zinc-800/60 rounded-lg p-0.5 border border-zinc-200/50 dark:border-zinc-700/50 focus-within:border-indigo-500/50 dark:focus-within:border-blue-400/50 focus-within:ring-1 focus-within:ring-indigo-500/20 dark:focus-within:ring-blue-400/20 transition-all">
                                <div className="relative">
                                    <select
                                        value={inviteUserId}
                                        onChange={e => setInviteUserId(e.target.value)}
                                        className="w-[110px] sm:w-[130px] pl-2 pr-6 py-1 bg-transparent text-xs font-medium text-zinc-600 dark:text-zinc-300 appearance-none outline-none cursor-pointer"
                                    >
                                        <option value="">{t('team.dir_add_member_placeholder', '添加成员...')}</option>
                                        {availableObservers.map(m => (
                                            <option key={m.user_id} value={m.user_id}>
                                                {m.display_name || m.username}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                                </div>
                                <button
                                    onClick={handleInviteMember}
                                    disabled={!inviteUserId || actionLoading === 'invite' || actionLoading === 'invite-all'}
                                    className={cn(
                                        "p-1 rounded-md transition-all flex items-center justify-center",
                                        inviteUserId
                                            ? "text-indigo-600 dark:text-blue-300 bg-white dark:bg-blue-500/10 shadow-sm hover:bg-indigo-50 dark:hover:bg-blue-500/15"
                                            : "text-zinc-400 opacity-50 cursor-not-allowed"
                                    )}
                                    title={t('common.add', '确认添加')}
                                >
                                    {actionLoading === 'invite' ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <UserPlus size={14} />
                                    )}
                                </button>
                                <button
                                    onClick={handleInviteAllMembers}
                                    disabled={actionLoading === 'invite' || actionLoading === 'invite-all'}
                                    className="px-2 py-1 rounded-md text-xs font-medium text-indigo-600 dark:text-blue-300 bg-white dark:bg-blue-500/10 shadow-sm hover:bg-indigo-50 dark:hover:bg-blue-500/15 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                    title={t('team.dir_add_all_members', '添加所有成员')}
                                >
                                    {actionLoading === 'invite-all' ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        t('team.dir_add_all_short', '全部')
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {membersExpanded && (
                    <div className="space-y-4 pl-5">
                        {/* 成员列表 */}
                        {sortedMembers.length === 0 ? (
                            <p className="text-sm text-zinc-400 italic">{t('team.stats_unknown')}</p>
                        ) : (
                            <div className="space-y-1">
                                {sortedMembers.map(m => (
                                    <div
                                        key={m.user_id}
                                        className="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50"
                                    >
                                        <div className="flex items-center gap-2">
                                            {m.dir_role === 'Owner' ? (
                                                <Crown size={14} className="text-amber-500" />
                                            ) : (
                                                <User size={14} className="text-indigo-500 dark:text-blue-400" />
                                            )}
                                            <span className="text-sm text-zinc-800 dark:text-zinc-200">
                                                {m.display_name || m.username}
                                            </span>
                                            <span className="text-xs text-zinc-400">
                                                {m.dir_role === 'Owner' ? 'Owner' : 'Member'}
                                            </span>
                                        </div>
                                        {canManageDir && !m.inherited && (
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={() => handleToggleRole(m.user_id, m.dir_role)}
                                                    disabled={actionLoading === m.user_id}
                                                    className="px-2 py-0.5 text-xs rounded-md text-indigo-600 dark:text-blue-300 hover:bg-indigo-50 dark:hover:bg-blue-500/15 transition-colors"
                                                    title={m.dir_role === 'Owner' ? t('team.dir_role_demote', '降为 Member') : t('team.dir_role_promote', '升为 Owner')}
                                                >
                                                    {m.dir_role === 'Owner' ? t('team.dir_role_to_member', '→ Member') : t('team.dir_role_to_owner', '→ Owner')}
                                                </button>
                                                <button
                                                    onClick={() => handleRemoveMember(m.user_id)}
                                                    disabled={actionLoading === m.user_id}
                                                    className="p-1 text-zinc-400 hover:text-red-500 transition-colors"
                                                    title={t('team.dir_remove_member')}
                                                >
                                                    {actionLoading === m.user_id ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : (
                                                        <UserMinus size={14} />
                                                    )}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </section>

            {/* ④ 子目录/文件列表（可折叠 + 显示更多） */}
            <section>
                <button
                    onClick={() => { setFilesExpanded(v => !v); setFileVisibleCount(FILE_PAGE_SIZE); }}
                    className="flex items-center gap-2 mb-3 w-full"
                >
                    <ChevronRight size={14} className={cn('shrink-0 transition-transform text-zinc-400', filesExpanded && 'rotate-90')} />
                    <FileText size={18} className="text-zinc-500" />
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {t('team.dir_files')}
                    </h3>
                    <span className="text-xs text-zinc-400">({files.length})</span>
                </button>

                {filesExpanded && (
                    <>
                        {files.length === 0 ? (
                            <p className="text-sm text-zinc-400 italic pl-5">{t('team.dir_empty')}</p>
                        ) : (
                            <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-zinc-50 dark:bg-zinc-800/50 text-zinc-500 dark:text-zinc-400">
                                            <th className="text-left px-3 py-2 font-medium">{t('team.dir_table_name')}</th>
                                            <th className="text-left px-3 py-2 font-medium">{t('team.dir_table_editor')}</th>
                                            <th className="text-left px-3 py-2 font-medium">{t('team.dir_table_modified')}</th>
                                            <th className="text-left px-3 py-2 font-medium">{t('team.dir_table_modifier')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {files.slice(0, fileVisibleCount).map((f, i) => (
                                            <tr
                                                key={f.relative_path}
                                                className={cn(
                                                    "border-t border-zinc-100 dark:border-zinc-800",
                                                    i % 2 === 0 ? "bg-white dark:bg-zinc-900" : "bg-zinc-50/50 dark:bg-zinc-800/20"
                                                )}
                                            >
                                                <td className="px-3 py-2">
                                                    <div className="flex items-center gap-1.5">
                                                        {f.is_dir ? (
                                                            <Folder size={14} className="text-indigo-500 dark:text-blue-400 shrink-0" />
                                                        ) : (
                                                            <FileText size={14} className="text-zinc-400 shrink-0" />
                                                        )}
                                                        <span className="truncate text-zinc-800 dark:text-zinc-200">
                                                            {f.name}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                                                    {resolveDisplayName(f.editor_username, f.editor_display_name)}
                                                </td>
                                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                                                    {formatTime(f.pushed_at)}
                                                </td>
                                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                                                    {resolveDisplayName(f.pushed_by_username, null)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {files.length > fileVisibleCount && (
                                    <button
                                        onClick={() => setFileVisibleCount(v => v + FILE_PAGE_SIZE)}
                                        className="w-full py-2 text-sm text-indigo-600 dark:text-blue-400 hover:text-indigo-700 dark:hover:text-blue-300 hover:bg-indigo-50 dark:hover:bg-blue-500/10 transition-colors border-t border-zinc-200 dark:border-zinc-700"
                                    >
                                        {t('team.dir_show_more', { count: files.length - fileVisibleCount })}
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </section>



            {/* ⑦ 团队回收站 (仅 Admin / Owner 可见) */}
            {canViewTrash && trashedFiles.length > 0 && (
                <section className="border-t border-zinc-200 dark:border-zinc-700 pt-6">
                    <button
                        onClick={() => { setTrashExpanded(v => !v); setTrashVisibleCount(FILE_PAGE_SIZE); }}
                        className="flex items-center gap-2 mb-3 w-full group"
                    >
                        <ChevronRight size={14} className={cn('shrink-0 transition-transform text-zinc-400', trashExpanded && 'rotate-90')} />
                        <Trash2 size={18} className="text-red-400 group-hover:text-red-500 transition-colors" />
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {t('team.dir_trash', '回收站 (Team Trash)')}
                        </h3>
                        <span className="text-xs text-zinc-400">({trashedFiles.length})</span>
                    </button>

                    {trashExpanded && (
                        <div className="border border-red-200/50 dark:border-red-900/30 rounded-lg overflow-hidden bg-red-50/30 dark:bg-red-900/10">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-red-50/50 dark:bg-red-900/20 text-red-500/70 dark:text-red-400/70">
                                        <th className="text-left px-3 py-2 font-medium">{t('team.dir_trash_name', '笔记名称 (路径)')}</th>
                                        <th className="text-left px-3 py-2 font-medium">{t('team.dir_trash_user', '删除用户')}</th>
                                        <th className="text-left px-3 py-2 font-medium">{t('team.dir_trash_time', '删除时间')}</th>
                                        <th className="text-right px-3 py-2 font-medium">{t('common.actions', '操作')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trashedFiles.slice(0, trashVisibleCount).map((f, i) => {
                                        const isRestoring = actionLoading === `restore-${f.id}`;
                                        const isDeleting = actionLoading === `delete-${f.id}`;
                                        const disabled = isRestoring || isDeleting;

                                        return (
                                            <tr
                                                key={f.id}
                                                className={cn(
                                                    "border-t border-red-100/50 dark:border-red-900/20",
                                                    i % 2 === 0 ? "bg-transparent" : "bg-red-50/30 dark:bg-red-900/5"
                                                )}
                                            >
                                                <td className="px-3 py-2 max-w-[240px]">
                                                    <div className="flex flex-col justify-center">
                                                        <div className="flex items-center gap-1.5 opacity-60">
                                                            <FileText size={14} className="text-red-400 shrink-0" />
                                                            <span className="truncate text-red-900 dark:text-red-200" title={f.original_path.split('/').pop() || f.original_path}>
                                                                {f.original_path.split('/').pop() || f.original_path}
                                                            </span>
                                                        </div>
                                                        <span className="truncate text-[10px] text-red-500/50 dark:text-red-400/40 ml-[20px] font-mono leading-none mt-1" title={f.original_path}>
                                                            {f.original_path}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                                                    {resolveDisplayName(f.deleted_by_username, f.deleted_by_display_name)}
                                                </td>
                                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                                                    {formatTime(f.deleted_at ? new Date(f.deleted_at).getTime() : null)}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <button
                                                            onClick={() => handleRestoreTrash(f)}
                                                            disabled={disabled}
                                                            className="p-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-500 dark:hover:bg-emerald-900/30 rounded-md transition-colors"
                                                            title={t('team.trash_restore_btn', '恢复文件')}
                                                        >
                                                            {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                                        </button>
                                                        <button
                                                            onClick={() => handleHardDeleteTrash(f.id)}
                                                            disabled={disabled}
                                                            className="p-1.5 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors"
                                                            title={t('team.trash_hard_delete_btn', '彻底删除')}
                                                        >
                                                            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            {trashedFiles.length > trashVisibleCount && (
                                <button
                                    onClick={() => setTrashVisibleCount(v => v + FILE_PAGE_SIZE)}
                                    className="w-full py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors border-t border-red-200/50 dark:border-red-900/30"
                                >
                                    {t('team.dir_show_more', { count: trashedFiles.length - trashVisibleCount })}
                                </button>
                            )}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
