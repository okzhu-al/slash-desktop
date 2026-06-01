import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DragEndEvent } from '@dnd-kit/core';
import { autoSyncManager } from '@/services/AutoSyncManager';
import { syncService, type TeamTreeNode } from '@/services/SyncService';
import { useSessionStore } from '@/stores/useSessionStore';
import { useTabsStore } from '@/core/tabs/TabsStore';
import { getBasename, getParentPath, getRelativePath } from '@/shared/utils/pathUtils';
import { PARA_TEAM_TO_PERSONAL } from './useTeamDirectoryMapping';
interface UseTeamAdminActionsProps {
    refreshTeamData: (vaultId: string) => void;
    activeMappings: Map<string, string>;
    removeMapping: (matchRef: 'source' | 'target', prefixMatch: string) => Promise<void>;
    rootDir?: string;
    onNoteDeleted?: (id: string) => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
}

export function useTeamAdminActions({
    refreshTeamData,
    activeMappings,
    removeMapping,
    rootDir,
    onNoteDeleted }: UseTeamAdminActionsProps) {
    const { t } = useTranslation();

    const resolveTeamToPhysicalPaths = useCallback((teamPath: string): string[] => {
        if (!rootDir) return [];
        const paths: string[] = [];
        // 1. PARA fallback mapping
        for (const [teamPrefix, personalPrefix] of Object.entries(PARA_TEAM_TO_PERSONAL)) {
            if (teamPath === teamPrefix || teamPath.startsWith(teamPrefix + '/')) {
                const subPath = teamPath === teamPrefix ? '' : teamPath.slice(teamPrefix.length);
                paths.push(`${rootDir}/${personalPrefix}${subPath}`);
                break;
            }
        }
        // 2. Active mappings
        for (const [personalPath, remoteTgt] of activeMappings) {
            if (teamPath === remoteTgt || teamPath.startsWith(remoteTgt + '/')) {
                const subPath = teamPath === remoteTgt ? '' : teamPath.slice(remoteTgt.length);
                paths.push(`${rootDir}/${personalPath}${subPath}`);
            }
        }
        return paths;
    }, [rootDir, activeMappings]);

    const handleAdminDeleteFile = useCallback(async (filePath: string, fileName: string) => {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        const yes = await ask(t('team.admin_delete_file_confirm', { name: fileName }), {
            title: t('common.delete', { defaultValue: 'Delete' }),
            kind: 'warning'
        });
        if (!yes) return;

        try {
            const config = syncService.getConfig();
            const teamVaultId = useSessionStore.getState().teamVaultId;
            if (!config || !teamVaultId) return;
            const { teamService } = await import('@/services/TeamService');
            await teamService.deleteFile(config.serverUrl, config.accessToken, teamVaultId, filePath, true);
            toast.success(t('team.admin_delete_success', { name: fileName }));

            // 🛡️ BUG-E07 Fix 1b: Admin 主动清理单文件的本地物理副本
            const physPaths = resolveTeamToPhysicalPaths(filePath);
            for (const physPath of physPaths) {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(physPath)) {
                        await remove(physPath);
                        console.log(`[AdminDeleteFile] Purged local: ${physPath}`);
                    }
                } catch (e) {
                    console.warn(`[AdminDeleteFile] Failed to purge ${physPath}:`, e);
                }
            }

            // 清理 unified_sync_state.json
            if (rootDir) {
                try {
                    const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const statePath = `${rootDir}/.slash/unified_sync_state.json`;
                    const stateStr = await readTextFile(statePath);
                    const state = JSON.parse(stateStr);
                    let changed = false;
                    for (const physPath of physPaths) {
                        if (physPath.startsWith(rootDir + '/')) {
                            const relPath = physPath.substring(rootDir.length + 1);
                            if (state[relPath]) {
                                // 🛡️ BUG-E07 Fix: 只清 team_hash/local_snapshot，保留 personal_hash
                                // personal_hash 必须保留，否则 Personal sync 无法检测删除，会从服务端拉回文件
                                delete state[relPath].team_hash;
                                delete state[relPath].local_snapshot;
                                delete state[relPath].edit_started_at;
                                console.log(`[AdminDeleteFile] Cleared team state for: ${relPath} (personal_hash preserved: ${!!state[relPath].personal_hash})`);
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        await writeTextFile(statePath, JSON.stringify(state, null, 2));
                    }
                } catch (e) {
                    console.warn('[AdminDeleteFile] unified_sync_state cleanup failed:', e);
                }
            }

            refreshTeamData(teamVaultId);

            console.log(`[AdminDeleteFile] Target filePath: ${filePath}`);

            if (onNoteDeleted) {
                const targetId = `__team__/${filePath}`;
                console.log(`[AdminDeleteFile] Forcing close for virtual: ${targetId}`);
                onNoteDeleted(targetId);
                for (const tab of useTabsStore.getState().tabs) {
                    if (tab.teamPath === filePath) {
                        console.log(`[AdminDeleteFile] Forcing close for stable team tab: ${tab.id}`);
                        onNoteDeleted(tab.id);
                    }
                }

                const physPaths = resolveTeamToPhysicalPaths(filePath);
                for (const phys of physPaths) {
                    console.log(`[AdminDeleteFile] Forcing close for physical: ${phys}`);
                    onNoteDeleted(phys);
                }
            }

            autoSyncManager.forceSync('admin_delete_file');
        } catch (e: any) {
            toast.error(t('team.admin_action_failed', { error: e.message }));
        }
    }, [t, refreshTeamData, resolveTeamToPhysicalPaths, onNoteDeleted]);

    const handleAdminDeleteDir = useCallback(async (dirPath: string, dirName: string) => {
        try {
            const config = syncService.getConfig();
            const teamVaultId = useSessionStore.getState().teamVaultId;
            if (!config || !teamVaultId) return;
            const { teamService } = await import('@/services/TeamService');
            const check = await teamService.canDeleteDirectory(config.serverUrl, config.accessToken, teamVaultId, dirPath, true);
            if (!check.allowed) {
                toast.error(check.reason || t('team.admin_action_failed', { error: 'Cannot delete' }));
                return;
            }

            const { ask } = await import('@tauri-apps/plugin-dialog');
            const yes = await ask(t('team.admin_delete_dir_confirm', { name: dirName }), {
                title: t('common.delete', { defaultValue: 'Delete' }),
                kind: 'warning'
            });
            if (!yes) return;

            let toastId = toast.loading(t('common.delete', { defaultValue: 'Deleting...' }));
            await teamService.deleteDirectory(config.serverUrl, config.accessToken, teamVaultId, dirPath, true);
            toast.dismiss(toastId);
            toast.success(t('team.admin_delete_success', { name: dirName }));

            // 🛡️ BUG-E07 Fix 1: Admin 主动清理本地物理文件 + unified_sync_state
            const physicalPaths = resolveTeamToPhysicalPaths(dirPath);
            for (const physPath of physicalPaths) {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(physPath)) {
                        await remove(physPath, { recursive: true });
                        console.log(`[AdminDeleteDir] Purged local: ${physPath}`);
                    }
                } catch (e) {
                    console.warn(`[AdminDeleteDir] Failed to purge ${physPath}:`, e);
                }
            }

            // 清理 unified_sync_state.json 中的 team_hash + personal_hash
            if (rootDir) {
                try {
                    const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const statePath = `${rootDir}/.slash/unified_sync_state.json`;
                    const stateStr = await readTextFile(statePath);
                    const state = JSON.parse(stateStr);
                    let changed = false;

                    const localRelPaths: string[] = [];
                    for (const physPath of physicalPaths) {
                        if (physPath.startsWith(rootDir + '/')) {
                            localRelPaths.push(physPath.substring(rootDir.length + 1));
                        }
                    }

                    for (const key of Object.keys(state)) {
                        const normKey = key.replace(/\\/g, '/').toLowerCase();
                        const shouldClean = localRelPaths.some(lp => {
                            const normLp = lp.replace(/\\/g, '/').toLowerCase();
                            return normKey === normLp || normKey.startsWith(normLp + '/');
                        });
                        if (shouldClean && state[key]) {
                            // 🛡️ BUG-E07 Fix: 只清 team_hash/local_snapshot，保留 personal_hash
                            // personal_hash 必须保留，否则 Personal sync 无法检测删除，会从服务端拉回文件
                            const hadPersonalHash = !!state[key].personal_hash;
                            delete state[key].team_hash;
                            delete state[key].local_snapshot;
                            delete state[key].edit_started_at;
                            console.log(`[AdminDeleteDir] Cleared team state for: ${key} (personal_hash preserved: ${hadPersonalHash})`);
                            changed = true;
                        }
                    }

                    if (changed) {
                        await writeTextFile(statePath, JSON.stringify(state, null, 2));
                        console.log(`[AdminDeleteDir] Cleaned unified_sync_state for deleted dir`);
                    }
                } catch (e) {
                    console.warn('[AdminDeleteDir] unified_sync_state cleanup failed (non-fatal):', e);
                }
            }

            if (onNoteDeleted) {
                const tabs = useTabsStore.getState().tabs;
                const dirPrefix = `__team__/${dirPath}/`;
                const exactDirMatch = `__team__/${dirPath}`;
                const physicalPrefixes = resolveTeamToPhysicalPaths(dirPath);

                console.log(`[AdminDeleteDir] Scanning ${tabs.length} tabs for deletion. Target prefix: ${dirPrefix}`);
                for (const tab of tabs) {
                    console.log(`[AdminDeleteDir] Checking tab: ${tab.id}`);

                    const teamPath = tab.teamPath ? `__team__/${tab.teamPath}` : null;
                    let shouldClose = tab.id.startsWith(dirPrefix)
                        || tab.id === exactDirMatch
                        || Boolean(teamPath && (teamPath.startsWith(dirPrefix) || teamPath === exactDirMatch));
                    if (!shouldClose) {
                        for (const physPrefix of physicalPrefixes) {
                            if (tab.id.startsWith(physPrefix + '/') || tab.id === physPrefix) {
                                shouldClose = true;
                                break;
                            }
                        }
                    }

                    if (shouldClose) {
                        console.log(`[AdminDeleteDir] Match found! Closing tab: ${tab.id}`);
                        onNoteDeleted(tab.id);
                    }
                }
            }

            // Cleanup local mapping
            await removeMapping('target', dirPath);

            refreshTeamData(teamVaultId);
            autoSyncManager.forceSync('admin_delete_dir');
        } catch (e: any) {
            toast.error(t('team.admin_action_failed', { error: e.message }));
        }
    }, [t, refreshTeamData, removeMapping, resolveTeamToPhysicalPaths, onNoteDeleted]);

    const handleAdminRenameDir = useCallback(async (dirPath: string, currentName: string, targetNewName?: string) => {
        const newName = targetNewName || prompt(t('team.admin_rename_prompt'), currentName);
        if (!newName || newName === currentName) return;
        try {
            const config = syncService.getConfig();
            const teamVaultId = useSessionStore.getState().teamVaultId;
            if (!config || !teamVaultId) return;
            const { teamService } = await import('@/services/TeamService');
            const parentDir = dirPath.includes('/') ? dirPath.substring(0, dirPath.lastIndexOf('/')) : '';
            const newPrefix = parentDir ? `${parentDir}/${newName}` : newName;
            await teamService.renameDirectory(config.serverUrl, config.accessToken, teamVaultId, dirPath, newPrefix);
            toast.success(t('team.admin_rename_success', { name: newName }));

            // 🛡️ BUG-E07 Fix: 重命名后主动清理旧路径的本地文件
            const oldPhysPaths = resolveTeamToPhysicalPaths(dirPath);
            for (const physPath of oldPhysPaths) {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(physPath)) {
                        await remove(physPath, { recursive: true });
                        console.log(`[AdminRenameDir] Purged old local: ${physPath}`);
                    }
                } catch (e) {
                    console.warn(`[AdminRenameDir] Failed to purge ${physPath}:`, e);
                }
            }

            // 清理旧路径的 unified_sync_state（只清 team_hash，保留 personal_hash）
            if (rootDir) {
                try {
                    const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const statePath = `${rootDir}/.slash/unified_sync_state.json`;
                    const stateStr = await readTextFile(statePath);
                    const state = JSON.parse(stateStr);
                    let changed = false;
                    const localRelPaths: string[] = [];
                    for (const physPath of oldPhysPaths) {
                        if (physPath.startsWith(rootDir + '/')) {
                            localRelPaths.push(physPath.substring(rootDir.length + 1));
                        }
                    }
                    for (const key of Object.keys(state)) {
                        const normKey = key.replace(/\\/g, '/').toLowerCase();
                        const shouldClean = localRelPaths.some(lp => {
                            const normLp = lp.replace(/\\/g, '/').toLowerCase();
                            return normKey === normLp || normKey.startsWith(normLp + '/');
                        });
                        if (shouldClean && state[key]) {
                            delete state[key].team_hash;
                            delete state[key].local_snapshot;
                            delete state[key].edit_started_at;
                            console.log(`[AdminRenameDir] Cleared old state: ${key}`);
                            changed = true;
                        }
                    }
                    if (changed) {
                        await writeTextFile(statePath, JSON.stringify(state, null, 2));
                    }
                } catch (e) {
                    console.warn('[AdminRenameDir] state cleanup failed:', e);
                }
            }

            // Clean up local mapping so Team Sync can correctly pull the renamed directory purely based on remote truth
            await removeMapping('target', dirPath);

            refreshTeamData(teamVaultId);
            autoSyncManager.forceSync('admin_rename_dir');
        } catch (e: any) {
            toast.error(t('team.admin_action_failed', { error: e.message }));
        }
    }, [t, refreshTeamData, removeMapping, resolveTeamToPhysicalPaths, rootDir]);

    const handleAdminRenameFile = useCallback(async (filePath: string, currentName: string, targetNewName?: string) => {
        const newName = targetNewName || prompt(t('team.admin_rename_prompt'), currentName);
        if (!newName || newName === currentName) return;
        try {
            const config = syncService.getConfig();
            const teamVaultId = useSessionStore.getState().teamVaultId;
            if (!config || !teamVaultId) return;
            const { teamService } = await import('@/services/TeamService');
            const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
            const newPrefix = parentDir ? `${parentDir}/${newName}` : newName;
            
            // Re-use renameDirectory as backend supports file paths
            await teamService.renameDirectory(config.serverUrl, config.accessToken, teamVaultId, filePath, newPrefix);
            toast.success(t('team.admin_rename_success', { name: newName }));

            // Purge local file
            const oldPhysPaths = resolveTeamToPhysicalPaths(filePath);
            for (const physPath of oldPhysPaths) {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(physPath)) {
                        await remove(physPath);
                        console.log(`[AdminRenameFile] Purged old local: ${physPath}`);
                    }
                } catch (e) {
                    console.warn(`[AdminRenameFile] Failed to purge ${physPath}:`, e);
                }
            }

            // Sync state scrubbing
            if (rootDir) {
                try {
                    const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const statePath = `${rootDir}/.slash/unified_sync_state.json`;
                    const stateStr = await readTextFile(statePath);
                    const state = JSON.parse(stateStr);
                    let changed = false;
                    for (const physPath of oldPhysPaths) {
                        if (physPath.startsWith(rootDir + '/')) {
                            const relPath = physPath.substring(rootDir.length + 1);
                            if (state[relPath]) {
                                delete state[relPath].team_hash;
                                delete state[relPath].local_snapshot;
                                delete state[relPath].edit_started_at;
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        await writeTextFile(statePath, JSON.stringify(state, null, 2));
                    }
                } catch (e) {
                    console.warn('[AdminRenameFile] state cleanup failed:', e);
                }
            }

            refreshTeamData(teamVaultId);
            autoSyncManager.forceSync('admin_rename_file');
        } catch (e: any) {
            toast.error(t('team.admin_action_failed', { error: e.message }));
        }
    }, [t, refreshTeamData, resolveTeamToPhysicalPaths, rootDir]);

    const handleTeamDragEnd = useCallback(async (event: DragEndEvent, setActiveTeamDragNode: (node: TeamTreeNode | null) => void) => {
        setActiveTeamDragNode(null);
        const srcNode = event.active.data.current?.teamNode as TeamTreeNode | undefined;
        const destNode = event.over?.data.current?.teamNode as TeamTreeNode | undefined;
        if (!srcNode || !destNode || !destNode.is_dir) return;
        // 不能拖到同级父目录
        const srcParent = getParentPath(srcNode.path);
        if (srcParent === destNode.path) return;
        // 不能拖入自身或子目录
        if (srcNode.path === destNode.path || destNode.path.startsWith(srcNode.path + '/')) return;
        try {
            const config = syncService.getConfig();
            const teamVaultId = useSessionStore.getState().teamVaultId;
            if (!config || !teamVaultId) return;
            const { teamService } = await import('@/services/TeamService');
            if (srcNode.is_dir) {
                const dirName = getBasename(srcNode.path) || srcNode.path;
                const newPrefix = `${destNode.path.replace(/\/$/, '')}/${dirName}`;
                await teamService.renameDirectory(config.serverUrl, config.accessToken, teamVaultId, srcNode.path, newPrefix);
            } else {
                await teamService.moveFile(config.serverUrl, config.accessToken, teamVaultId, srcNode.path, destNode.path);
            }
            toast.success(t('team.admin_move_success'));

            // 🛡️ BUG-E07 Fix: 移动后主动清理旧路径的本地文件
            const oldPhysPaths = resolveTeamToPhysicalPaths(srcNode.path);
            for (const physPath of oldPhysPaths) {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(physPath)) {
                        await remove(physPath, { recursive: true });
                        console.log(`[TeamDragEnd] Purged old local: ${physPath}`);
                    }
                } catch (e) {
                    console.warn(`[TeamDragEnd] Failed to purge ${physPath}:`, e);
                }
            }

            // 清理旧路径的 unified_sync_state（只清 team_hash，保留 personal_hash）
            if (rootDir) {
                try {
                    const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const statePath = `${rootDir}/.slash/unified_sync_state.json`;
                    const stateStr = await readTextFile(statePath);
                    const state = JSON.parse(stateStr);
                    let changed = false;
                    const localRelPaths: string[] = [];
                    for (const physPath of oldPhysPaths) {
                            localRelPaths.push(getRelativePath(physPath, rootDir));
                    }
                    for (const key of Object.keys(state)) {
                        const normKey = key.replace(/\\/g, '/').toLowerCase();
                        const shouldClean = localRelPaths.some(lp => {
                            const normLp = lp.replace(/\\/g, '/').toLowerCase();
                            return normKey === normLp || normKey.startsWith(normLp + '/');
                        });
                        if (shouldClean && state[key]) {
                            delete state[key].team_hash;
                            delete state[key].local_snapshot;
                            delete state[key].edit_started_at;
                            console.log(`[TeamDragEnd] Cleared old state: ${key}`);
                            changed = true;
                        }
                    }
                    if (changed) {
                        await writeTextFile(statePath, JSON.stringify(state, null, 2));
                    }
                } catch (e) {
                    console.warn('[TeamDragEnd] state cleanup failed:', e);
                }
            }

            // Clean up local mapping so Team Sync can correctly pull the moved directory
            await removeMapping('target', srcNode.path);

            refreshTeamData(teamVaultId);
            autoSyncManager.forceSync('admin_move');
        } catch (e: any) {
            toast.error(t('team.admin_action_failed', { error: e.message }));
        }
    }, [t, refreshTeamData, removeMapping, resolveTeamToPhysicalPaths, rootDir]);

    return {
        handleAdminDeleteFile,
        handleAdminDeleteDir,
        handleAdminRenameDir,
        handleAdminRenameFile,
        handleTeamDragEnd
    };
}
