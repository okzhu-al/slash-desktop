/**
 * useFileTreeActions — 文件树 CRUD 操作
 *
 * 职责：
 * 1. handleDelete（含团队目录权限检查、sync state 清理）
 * 2. confirmRename（含团队映射同步、服务端改名）
 * 3. handleCreateNote / handleCreateFolder
 * 4. handleDuplicate / handleReveal / handleMoveFile
 * 5. handlePromoteToTeam（推送至团队空间）
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFileSystemStore } from '@/core/fs/store';
import { useTabsStore } from '@/core/tabs/TabsStore';
import { syncService } from '@/services/SyncService';
import { sanitizeFilename } from '@/core/utils/sanitization';
import { getRelativePath, getParentPath } from '@/shared/utils/pathUtils';
import { clearClassificationCache } from '@/features/classification/cache';
import type { FileSystemItem } from '@/core/fs/types';
import type { FileSystemNoteRepository } from '@/core/storage/FileSystemNoteRepository';
import type { Note } from '@/core/storage/types';
import { useSessionStore } from '@/stores/useSessionStore';
import { moveTeamMappedItemFromLocalTree } from '../utils/teamLocalMove';

interface TeamDeleteTarget {
    vaultId: string;
    remotePath: string;
    directoryId?: string | null;
}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');
const normalizePathKey = (path: string): string => normalizePath(path).toLowerCase();

async function resolveTeamDeleteTarget(
    itemPath: string,
    vaultRoot: string | undefined,
    teamVaultId: string | undefined | null,
    teamDirectories: Map<string, any>,
    activeMappings: Map<string, string>,
): Promise<TeamDeleteTarget | null> {
    if (!vaultRoot || !teamVaultId) return null;

    const currentRelPath = normalizePath(getRelativePath(itemPath, vaultRoot));
    const currentRelKey = currentRelPath.toLowerCase();

    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const raw = await readTextFile(`${vaultRoot}/.slash/team_directory_mappings.json`);
        const data = JSON.parse(raw);
        const directories = data?.teams?.[teamVaultId]?.directories;
        if (directories && typeof directories === 'object') {
            const entries = Object.entries(directories) as Array<[string, any]>;

            for (const [id, mapping] of entries) {
                if (mapping?.status !== 'active') continue;
                const localPath = typeof mapping.local_path === 'string' ? normalizePath(mapping.local_path) : '';
                const remotePath = typeof mapping.remote_path === 'string' ? normalizePath(mapping.remote_path) : '';
                if (!localPath || !remotePath) continue;
                if (localPath.toLowerCase() === currentRelKey) {
                    return {
                        vaultId: teamVaultId,
                        remotePath,
                        directoryId: mapping.directory_id || id || null,
                    };
                }
            }

            for (const [, mapping] of entries) {
                if (mapping?.status !== 'active') continue;
                const localPath = typeof mapping.local_path === 'string' ? normalizePath(mapping.local_path) : '';
                const remotePath = typeof mapping.remote_path === 'string' ? normalizePath(mapping.remote_path) : '';
                if (!localPath || !remotePath) continue;
                const localKey = localPath.toLowerCase();
                if (currentRelKey.startsWith(`${localKey}/`)) {
                    const suffix = currentRelPath.slice(localPath.length);
                    return {
                        vaultId: teamVaultId,
                        remotePath: `${remotePath}${suffix}`,
                        directoryId: null,
                    };
                }
            }
        }
    } catch {
        // v3 mapping is optional; fall back to legacy mappings below.
    }

    const legacyEntries = Array.from(activeMappings.entries());
    for (const [source, target] of legacyEntries) {
        const sourcePath = normalizePath(source);
        if (sourcePath.toLowerCase() === currentRelKey) {
            return { vaultId: teamVaultId, remotePath: normalizePath(target), directoryId: null };
        }
    }
    for (const [source, target] of legacyEntries) {
        const sourcePath = normalizePath(source);
        const sourceKey = sourcePath.toLowerCase();
        if (currentRelKey.startsWith(`${sourceKey}/`)) {
            const suffix = currentRelPath.slice(sourcePath.length);
            return { vaultId: teamVaultId, remotePath: `${normalizePath(target)}${suffix}`, directoryId: null };
        }
    }

    const currentAbsKey = normalizePathKey(itemPath);
    const mappedDirs = Array.from(teamDirectories.entries())
        .map(([fullPath, info]) => ({ fullPath: normalizePath(fullPath), info }))
        .sort((a, b) => b.fullPath.length - a.fullPath.length);

    for (const { fullPath, info } of mappedDirs) {
        const fullKey = fullPath.toLowerCase();
        if (currentAbsKey === fullKey || currentAbsKey.startsWith(`${fullKey}/`)) {
            const relToMapping = currentAbsKey === fullKey ? '' : normalizePath(itemPath).slice(fullPath.length + 1);
            const remotePath = normalizePath(info.remotePath || '');
            if (!remotePath) continue;
            return {
                vaultId: info.vaultId || teamVaultId,
                remotePath: relToMapping ? `${remotePath}/${relToMapping}` : remotePath,
                directoryId: currentAbsKey === fullKey ? (info.directoryId || null) : null,
            };
        }
    }

    return null;
}

interface UseFileTreeActionsOptions {
    repo: FileSystemNoteRepository;
    hasTeamVault: boolean;
    teamDirectories: Map<string, any>;
    activeMappings: Map<string, string>;
    teamDirectoryOptions: string[];
    removeMapping: (matchRef: 'source' | 'target', prefixMatch: string) => Promise<void>;
    refreshTeamData: (vaultId: string) => void;
    setEditingPath: (path: string | null) => void;
    onSelectNote: (note: Note) => void;
    onNoteDeleted?: (id: string) => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
    onFolderDeleted?: (folderPath: string) => void;
}

export function useFileTreeActions({
    repo,
    hasTeamVault,
    teamDirectories,
    activeMappings,
    teamDirectoryOptions,
    removeMapping,
    refreshTeamData,
    setEditingPath,
    onSelectNote,
    onNoteDeleted,
    onNoteRenamed,
    onFolderDeleted,
}: UseFileTreeActionsOptions) {
    const { t } = useTranslation();
    const { root, refreshNode, removeNode, toggleFolder } = useFileSystemStore();

    // ── Promote 防重入 ──
    const [isPromoting, setIsPromoting] = useState(false);

    // ── handleDelete ──
    const handleDelete = async (item: FileSystemItem) => {
        const config = syncService.getConfig();
        const sessionTeamVaultId = useSessionStore.getState().teamVaultId;
        const teamDeleteTarget = hasTeamVault
            ? await resolveTeamDeleteTarget(item.path, repo?.rootDir, sessionTeamVaultId, teamDirectories, activeMappings)
            : null;
        let targetRemotePath = teamDeleteTarget?.remotePath || '';
        let currentTeamVaultId = teamDeleteTarget?.vaultId || '';

        // [前哨防御 1]: 防御单个"他人名下"文件的越权处决
        if (item.type === 'file' && teamDeleteTarget) {
            try {
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                const content = await readTextFile(item.path);
                const { metadataService } = await import('@/core/metadata/MetadataService');
                const { metadata } = metadataService.parse(item.path, content);

                const currentUserName = useSessionStore.getState().displayName;
                if (metadata.editor && currentUserName && metadata.editor !== currentUserName) {
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    await message(t('team.permission_denied_delete_file', '您不是该笔记的 Editor，无法进行删除操作。如需删除请联系 Editor。'), { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
                    return;
                }
            } catch (e) {
                console.warn("[useFileTreeActions] File editor validation check failed:", e);
            }
        }

        if (teamDeleteTarget && (!currentTeamVaultId || !config)) {
            const { message } = await import('@tauri-apps/plugin-dialog');
            await message(t('team.delete_validation_failed', '团队内容删除权限校验失败，请确认服务端连接后重试。'), { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
            return;
        }

        if (item.type === 'folder' && teamDeleteTarget) {
            if (currentTeamVaultId && config) {
                let toastId;
                try {
                    const { teamService } = await import('@/services/TeamService');
                    toastId = toast.loading(t('team.delete_checking', '正在安全扫描团队目录...'));
                    const res = await teamService.canDeleteDirectory(
                        config.serverUrl,
                        config.accessToken,
                        currentTeamVaultId,
                        targetRemotePath,
                        false,
                        teamDeleteTarget.directoryId,
                    );
                    toast.dismiss(toastId);

                    if (!res.allowed) {
                        const { message } = await import('@tauri-apps/plugin-dialog');
                        let errorMessage = res.reason || t('sidebar.delete_forbidden', "禁止删除");
                        if (res.reason === 'not_owner') {
                            errorMessage = t('team.permission_denied_delete_dir', '您必须是该目录的 Owner 或管理员才能删除。');
                        } else if (res.reason?.startsWith('has_other:')) {
                            const user = res.reason.split(':')[1];
                            errorMessage = t('sidebar.delete_denied_has_other_files', { user, defaultValue: `该目录已包含他人（${user}）创建的目录/笔记，请通知作者清理后删除` });
                        }
                        await message(errorMessage, { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
                        return;
                    }
                } catch (e) {
                    toast.dismiss(toastId);
                    console.warn("[useFileTreeActions] Team directory delete validation failed:", e);
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    await message(t('team.delete_validation_failed', '团队目录删除权限校验失败，请确认服务端连接后重试。'), { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
                    return;
                }
            } else {
                const { message } = await import('@tauri-apps/plugin-dialog');
                await message(t('team.delete_validation_failed', '团队目录删除权限校验失败，请确认服务端连接后重试。'), { title: t('team.permission_denied_title', "越权提示"), kind: 'error' });
                return;
            }
        }

        try {
            const { ask } = await import('@tauri-apps/plugin-dialog');
            const yes = await ask(t("common.delete_confirm") || "Are you sure?", {
                title: t("common.delete") || "Delete",
                kind: 'warning'
            });
            if (!yes) return;

            // 服务端最终裁决：若为团队项目，正式通知云端实施物理拔除
            if (teamDeleteTarget && currentTeamVaultId && config) {
                let toastId;
                try {
                    const { teamService } = await import('@/services/TeamService');
                    if (item.type === 'folder') {
                        toastId = toast.loading(t('team.deleting_dir', '正在粉碎云端目录...'));
                        await teamService.deleteDirectory(
                            config.serverUrl,
                            config.accessToken,
                            currentTeamVaultId,
                            targetRemotePath,
                            false,
                            teamDeleteTarget.directoryId,
                        );
                    } else {
                        toastId = toast.loading(t('team.deleting_file', '正在粉碎云端文件...'));
                        await teamService.deleteFile(config.serverUrl, config.accessToken, currentTeamVaultId, targetRemotePath, false);
                    }
                    toast.dismiss(toastId);


                    // 清理 unified_sync_state.json 中的 team_hash
                    const vaultRoot = repo?.rootDir;
                    if (vaultRoot) {
                        try {
                            const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                            const statePath = `${vaultRoot}/.slash/unified_sync_state.json`;
                            const stateStr = await readTextFile(statePath);
                            const state = JSON.parse(stateStr);
                            let stateChanged = false;

                            const relPath = getRelativePath(item.path, vaultRoot);
                            const targetPrefix = relPath.replace(/\\/g, '/').toLowerCase() + '/';
                            const targetExact = relPath.replace(/\\/g, '/').toLowerCase();

                            for (const key in state) {
                                const normKey = key.replace(/\\/g, '/').toLowerCase();
                                if (normKey === targetExact || normKey.startsWith(targetPrefix)) {
                                    if (state[key]) {
                                        delete state[key].team_hash;
                                    }
                                    stateChanged = true;
                                }
                            }

                            if (stateChanged) {
                                await writeTextFile(statePath, JSON.stringify(state, null, 2));

                            }
                        } catch (e) {
                            console.warn('[useFileTreeActions] Cleanly scrub unified_sync_state failed (non-fatal):', e);
                        }
                    }

                    // 清理 team_path_mappings.json 的本地绑定映射
                    if (vaultRoot && activeMappings.size > 0) {
                        const currentRelPath = getRelativePath(item.path, vaultRoot).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                        await removeMapping('source', currentRelPath);
                    }

                } catch (e: any) {
                    if (toastId) toast.dismiss(toastId);
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    let errMsg = String(e.message || e);
                    let title = t('team.sync_delete_error', "同步删除异常");
                    
                    if (errMsg === 'not_owner' || errMsg.includes('not_owner')) {
                        errMsg = t('team.permission_denied_delete_dir', '您必须是该目录的 Owner 或管理员才能删除。');
                        title = t('team.permission_denied_title', "越权提示");
                    } else if (errMsg.includes('Only the editor')) {
                        errMsg = t('team.permission_denied_delete_file', '您不是该笔记的 Editor，无法进行删除操作。如需删除请联系 Editor。');
                        title = t('team.permission_denied_title', "越权提示");
                    } else if (errMsg?.startsWith('has_other:') || errMsg?.includes('has_other:')) {
                        const user = errMsg.split('has_other:')[1].trim();
                        errMsg = t('sidebar.delete_denied_has_other_files', { user, defaultValue: `该目录已包含他人（${user}）创建的目录/笔记，请通知作者清理后删除` });
                        title = t('team.permission_denied_title', "越权提示");
                    } else {
                        errMsg = t('team.delete_failed', { error: errMsg, defaultValue: `服务端抹除失败: ${errMsg}` });
                    }
                    
                    await message(errMsg, { title, kind: 'error' });
                    return;
                }
            }

            const separator = item.path.includes('\\') ? '\\' : '/';
            const deletedPrefix = item.path + separator;
            const deletedFolderTabId = '__folder__:' + item.path;
            const deletedFolderPrefix = deletedFolderTabId + separator;

            const tabsToClose = useTabsStore.getState().tabs
                .filter(t => t.id === item.path || t.id.startsWith(deletedPrefix) ||
                    t.id === deletedFolderTabId || t.id.startsWith(deletedFolderPrefix))
                .map(t => t.id);

            // 🛡️ 先关闭 Tab，强制触发 Editor unmount (可能会伴随最后一次 auto-save 落盘)
            tabsToClose.forEach(id => useTabsStore.getState().closeTab(id));
            
            if (tabsToClose.length > 0) {
                // 等待短暂时间，让因为关闭 tab 触发的底层 save_note 落盘跑完，防止其在被删除后再度幽灵复活
                await new Promise(resolve => setTimeout(resolve, 250));
            }

            // 彻底执行物理删除后再更新 UI，防止并发的 refreshTree 在文件尚未物理陨灭前将其扫回前端造成“闪现”幻影
            await repo.deleteNote(item.path);
            removeNode(item.path);

            // 空壳追踪斩草除根
            if (item.type === 'folder') {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(item.path)) {
                        await remove(item.path, { recursive: true });
                    }
                } catch (pe) {
                    console.warn(`[useFileTreeActions] Failed to purge ghost directory:`, pe);
                }
            }

            clearClassificationCache(item.path);

            if (item.type === 'folder') {
                onFolderDeleted?.(item.path);
            } else {
                onNoteDeleted?.(item.path);
            }

            // 🛡️ BUG-E07：立即触发一次 SyncEvent，否则会有长达 40 秒的静默观察期让用户迷茫
            try {
                const { autoSyncManager } = await import('@/services/AutoSyncManager');
                autoSyncManager.forceSync('file_deleted');
            } catch (e) {
                console.warn('[useFileTreeActions] Failed to trigger immediate sync:', e);
            }
        } catch (e) {
            console.error("Failed to delete", e);
            const separator = item.path.includes('\\') ? '\\' : '/';
            const parentPath = item.path.substring(0, item.path.lastIndexOf(separator));
            if (parentPath) await refreshNode(parentPath);
        }
    };

    // ── confirmRename ──
    const confirmRename = async (item: FileSystemItem, newNameRaw: string) => {


        if (!newNameRaw.trim()) return;

        const newName = sanitizeFilename(newNameRaw.trim());
        if (!newName || newName === item.name) return;

        const oldPath = item.path;
        let newPath = oldPath;

        try {
            if (item.type === 'file' && item.name.endsWith('.md')) {
                const newTitle = newName.replace(/\.md$/, '');

                const exists = await invoke<boolean>('check_note_exists', { noteName: newTitle });
                if (exists) {
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    await message(
                        t('sidebar.duplicate_name_warning', { name: newTitle }),
                        { title: t('sidebar.duplicate_name_title'), kind: 'warning' }
                    );
                    return;
                }

                newPath = await repo.renameNote(item.path, newTitle);
            } else {
                const { join } = await import('@tauri-apps/api/path');
                const { rename } = await import('@tauri-apps/plugin-fs');

                const separator = item.path.includes('\\') ? '\\' : '/';
                const parentPath = item.path.substring(0, item.path.lastIndexOf(separator));
                newPath = await join(parentPath, newName);

                await rename(item.path, newPath);
            }

            const separator = item.path.includes('\\') ? '\\' : '/';
            const parentPath = item.path.substring(0, item.path.lastIndexOf(separator));
            await refreshNode(parentPath);

            // 目录改名后同步更新 team_path_mappings.json + 服务端
            if (item.type === 'folder' && repo?.rootDir && activeMappings.size > 0) {
                const vaultRoot = repo.rootDir;
                const oldRelative = getRelativePath(oldPath, vaultRoot);
                const newRelative = getRelativePath(newPath, vaultRoot);
                const oldNorm = oldRelative.replace(/\\/g, '/').replace(/\/$/, '');
                const newNorm = newRelative.replace(/\\/g, '/').replace(/\/$/, '');

                let updated = false;
                const newMappings: Record<string, string> = {};
                const renameRequests: Array<{ oldRemote: string; newRemote: string; directoryId?: string | null }> = [];
                for (const [src, tgt] of activeMappings) {
                    const srcNorm = src.replace(/\\/g, '/').replace(/\/$/, '');
                    if (srcNorm === oldNorm || srcNorm.startsWith(oldNorm + '/')) {
                        const updatedSrc = newNorm + srcNorm.slice(oldNorm.length);
                        const tgtNorm = tgt.replace(/\\/g, '/').replace(/\/$/, '');
                        const tgtParent = tgtNorm.includes('/') ? tgtNorm.substring(0, tgtNorm.lastIndexOf('/')) : '';
                        const updatedRootTgt = tgtParent ? `${tgtParent}/${newName}` : newName;
                        const updatedTgt = updatedRootTgt + srcNorm.slice(oldNorm.length);
                        newMappings[updatedSrc] = updatedTgt;
                        updated = true;

                        if (srcNorm === oldNorm && tgt !== updatedTgt) {
                            renameRequests.push({ oldRemote: tgt, newRemote: updatedTgt });
                        }
                    } else {
                        newMappings[src] = tgt;
                    }
                }
                if (updated) {
                    try {
                        const { writeTextFile, readTextFile } = await import('@tauri-apps/plugin-fs');
                        const teamVaultId = useSessionStore.getState().teamVaultId;

                        if (teamVaultId) {
                            try {
                                const v3Path = `${vaultRoot}/.slash/team_directory_mappings.json`;
                                const raw = await readTextFile(v3Path);
                                const data = JSON.parse(raw);
                                const directories = data?.teams?.[teamVaultId]?.directories;
                                if (directories && typeof directories === 'object') {
                                    for (const [directoryId, mapping] of Object.entries(directories) as Array<[string, any]>) {
                                        if (mapping?.status !== 'active') continue;
                                        const srcNorm = String(mapping.local_path || '').replace(/\\/g, '/').replace(/\/$/, '');
                                        if (srcNorm === oldNorm || srcNorm.startsWith(oldNorm + '/')) {
                                            const updatedSrc = newNorm + srcNorm.slice(oldNorm.length);
                                            const remoteNorm = String(mapping.remote_path || '').replace(/\\/g, '/').replace(/\/$/, '');
                                            const remoteParent = remoteNorm.includes('/') ? remoteNorm.substring(0, remoteNorm.lastIndexOf('/')) : '';
                                            const updatedRootRemote = remoteParent ? `${remoteParent}/${newName}` : newName;
                                            const updatedRemote = updatedRootRemote + srcNorm.slice(oldNorm.length);

                                            if (srcNorm === oldNorm) {
                                                const existing = renameRequests.find(req => req.oldRemote === mapping.remote_path);
                                                if (existing) {
                                                    existing.directoryId = directoryId;
                                                } else if (mapping.remote_path !== updatedRemote) {
                                                    renameRequests.push({
                                                        oldRemote: mapping.remote_path,
                                                        newRemote: updatedRemote,
                                                        directoryId,
                                                    });
                                                }
                                            }

                                            mapping.local_path = updatedSrc;
                                            mapping.remote_path = updatedRemote;
                                        }
                                    }
                                    await writeTextFile(v3Path, JSON.stringify(data, null, 2));
                                }
                            } catch {
                                // v3 mapping may not exist for older vaults; legacy mapping below remains as fallback.
                            }

                            for (const req of renameRequests) {
                                const config = syncService.getConfig();
                                if (config) {
                                    try {
                                        const { teamService } = await import('@/services/TeamService');
                                        await teamService.renameDirectory(
                                            config.serverUrl, config.accessToken,
                                            teamVaultId, req.oldRemote, req.newRemote, req.directoryId,
                                        );
                                    } catch (e) {
                                        console.warn('[useFileTreeActions] Server rename failed, rolling back:', e);
                                        const { rename } = await import('@tauri-apps/plugin-fs');
                                        await rename(newPath, oldPath);
                                        await refreshNode(parentPath);
                                        const { message } = await import('@tauri-apps/plugin-dialog');
                                        await message(t('team.permission_denied_rename_dir', '您没有权限重命名该团队目录，请联系管理员。'), { title: t('team.permission_denied_title', '越权提示'), kind: 'error' });
                                        return;
                                    }
                                }
                            }

                            const mappingPath = `${vaultRoot}/.slash/team_path_mappings.json`;
                            
                            let dataObj: any = { teams: {} };
                            try {
                                const raw = await readTextFile(mappingPath);
                                dataObj = JSON.parse(raw);
                                if (!dataObj.teams) dataObj.teams = {};
                            } catch { }

                            dataObj.teams[teamVaultId] = newMappings;

                            await writeTextFile(mappingPath, JSON.stringify(dataObj, null, 2));
                        }
                        // The file watcher in useTeamDirectoryMapping will automatically reload activeMappings
                    } catch (e) {
                        console.warn('[useFileTreeActions] Failed to update team mappings after rename:', e);
                    }
                }
            }

            if (onNoteRenamed && item.type === 'file') {
                onNoteRenamed(oldPath, newPath);
            }

            if (item.type === 'file') {
                try {
                    const { autoSyncManager } = await import('@/services/AutoSyncManager');
                    autoSyncManager.forceSync('file_renamed');
                } catch (e) {
                    console.warn('[useFileTreeActions] Failed to trigger immediate rename sync:', e);
                }
            }
        } catch (e) {
            console.error("[useFileTreeActions] Failed to rename", e);
            const { message } = await import('@tauri-apps/plugin-dialog');
            await message(t('team.rename_failed', { error: (e as Error).message, defaultValue: `重命名失败: ${(e as Error).message}` }), { title: t('common.error', '错误'), kind: 'error' });
        }
    };

    // ── handleCreateNote ──
    const handleCreateNote = async (parentPath?: string) => {
        try {
            const targetPath = parentPath || (root ? `${root.path}/00_Inbox` : undefined);

            let counter = 1;
            let title = t("sidebar.new_note");
            let success = false;
            let newNote;

            while (!success) {
                try {
                    newNote = await repo.createNote(title, targetPath);
                    success = true;
                } catch (e) {
                    counter++;
                    title = `${t("sidebar.new_note")}${counter}`;
                    if (counter > 100) throw e;
                }
            }

            if (newNote && root) {
                if (root) await refreshNode(targetPath || root.path);

                const vaultPath = repo.rootDir;
                if (vaultPath && newNote.path) {
                    const relativePath = getRelativePath(newNote.path, vaultPath);
                    invoke('scan_single_file', { vaultPath, relativePath }).catch(console.warn);
                }

                if (targetPath) {
                    await toggleFolder(targetPath, true);
                }

                onSelectNote({ ...newNote, isNewNote: true } as any);
            }
        } catch (e) {
            console.error("Failed to create note", e);
        }
    };

    // ── handleCreateFolder ──
    const handleCreateFolder = async (parentPath?: string) => {
        try {
            const targetPath = parentPath || (root ? `${root.path}/00_Inbox` : undefined);

            let counter = 1;
            let name = t("sidebar.new_folder");
            let success = false;
            let folderPath;

            while (!success) {
                try {
                    if (!repo.createFolder) throw new Error("createFolder not implemented");
                    folderPath = await repo.createFolder(name, targetPath);
                    success = true;
                } catch (e) {
                    counter++;
                    name = `${t("sidebar.new_folder")}${counter}`;
                    if (counter > 100) throw e;
                }
            }

            if (folderPath && root) {
                await refreshNode(targetPath || root.path);
                if (targetPath) {
                    await toggleFolder(targetPath, true);
                }
                setEditingPath(folderPath);
            }
        } catch (e) {
            console.error("Failed to create folder", e);
        }
    };

    // ── handleRename (no-op placeholder) ──
    const handleRename = async (_item: FileSystemItem) => {
        // Inline editing is handled by FileTreeItem
    };

    // ── handleDuplicate ──
    const handleDuplicate = async (item: FileSystemItem) => {
        try {
            const { fileSystemService } = await import("@/core/fs/FileSystemService");
            await fileSystemService.duplicateFile(item.path);
        } catch (e) {
            console.error("Failed to duplicate", e);
        }
    };

    // ── handleReveal ──
    const handleReveal = async (item: FileSystemItem) => {
        try {
            const { fileSystemService } = await import("@/core/fs/FileSystemService");
            await fileSystemService.revealInSystem(item.path);
        } catch (e) {
            console.error("Failed to reveal", e);
        }
    };

    // ── handleMoveFile ──
    const handleMoveFile = async (sourcePath: string, destFolder: string) => {
        // 团队目录内的本地树移动必须走 Team API，由服务端按 Owner/editor 规则裁决。
        if (hasTeamVault && teamDirectories.size > 0) {
            const teamMoveResult = await moveTeamMappedItemFromLocalTree({
                rootDir: repo?.rootDir,
                sourcePath,
                destFolder,
                isDirectory: false,
                teamDirectories,
                t,
            });
            if (teamMoveResult.handled) {
                if (teamMoveResult.newPath && sourcePath.endsWith('.md')) {
                    onNoteRenamed?.(sourcePath, teamMoveResult.newPath);
                }
                await refreshNode(getParentPath(sourcePath));
                await refreshNode(destFolder);
                await toggleFolder(destFolder, true);
                return;
            }
        }

        try {
            const newPath = await invoke<string>('move_file', {
                sourcePath,
                destFolder,
                vaultPath: repo?.rootDir || '',
            });

            if (sourcePath.endsWith('.md')) {
                onNoteRenamed?.(sourcePath, newPath);
            }

            const sourceFolder = getParentPath(sourcePath);
            await refreshNode(sourceFolder);
            await refreshNode(destFolder);
            await toggleFolder(destFolder, true);
        } catch (e) {
            console.error("Failed to move file:", e);
            alert(`Failed to move file: ${e}`);
        }
    };

    // ── handlePromoteToTeam ──
    const handlePromoteToTeam = async (item: FileSystemItem, targetParaDir: string) => {
        if (isPromoting) return;
        
        // 🛡️ HARD GATE: 阻止在维护模式下发起 Promote
        if (useSessionStore.getState().isAdminManageMode) {
            toast.error(t('team.maintenance_promote_hint', '维护模式下禁止操作'), { id: 'promote-team' });
            return;
        }

        setIsPromoting(true);

        const teamVaultId = useSessionStore.getState().teamVaultId;
        const teamVaultName = useSessionStore.getState().teamVaultName || t('team.space_name');

        if (!teamVaultId || !repo?.rootDir) {
            toast.error(t('team.load_failed', { error: 'Team vault not found' }));
            setIsPromoting(false);
            return;
        }

        const currentVaultPath = repo!.rootDir;
        const sourceDir = getRelativePath(item.path, currentVaultPath);

        const sourceDirNorm = sourceDir.replace(/\\/g, '/').replace(/\/$/, '');
        for (const [existingSource, existingTarget] of activeMappings) {
            const existingNorm = existingSource.replace(/\\/g, '/').replace(/\/$/, '');

            // 🛡️ FIX BUG-B11: 完全相同的源目录 → 拒绝重复 Promote
            if (sourceDirNorm === existingNorm) {
                toast.error(
                    t('team.promote_already_promoted', {
                        name: item.name,
                        target: existingTarget,
                        defaultValue: `「${item.name}」已推送至团队空间 (${existingTarget})，不可重复推送`,
                    }),
                    { id: 'promote-team' },
                );
                setIsPromoting(false);
                return;
            }

            if (existingNorm.startsWith(sourceDirNorm + '/')) {
                alert(t('team.promote_conflict_child', { child: existingTarget, parent: item.name }));
                setIsPromoting(false);
                return;
            }
        }

        let targetDir = `${targetParaDir}/${item.name}`;

        // 🛡️ OPT-04: Promote 必须保持原有 PARA 根一致
        // 01_Projects/X → 只能 Promote 到 01_PROJECTS/，不能跨到 02_AREAS/
        const sourceParaRoot = sourceDir.split('/')[0]; // e.g. "01_Projects"
        const targetParaRoot = targetParaDir.split('/')[0]; // e.g. "01_PROJECTS"
        const sourcePrefix = sourceParaRoot.split('_')[0]; // "01"
        const targetPrefix = targetParaRoot.split('_')[0]; // "01"
        if (sourcePrefix !== targetPrefix) {
            toast.error(
                t('team.promote_para_mismatch', {
                    source: sourceParaRoot,
                    target: targetParaRoot,
                    defaultValue: `「${sourceParaRoot}」不能推送到「${targetParaRoot}」，请选择对应的 PARA 根目录`,
                }),
                { id: 'promote-team' },
            );
            setIsPromoting(false);
            return;
        }

        const normalizeTeamPath = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        const existingTeamDirs = new Set([
            ...teamDirectoryOptions,
            ...Array.from(activeMappings.values()),
        ].map(normalizeTeamPath));

        const isMappedToTarget = Array.from(activeMappings.entries()).some(([existingSource, existingTarget]) => (
            normalizeTeamPath(existingSource) === normalizeTeamPath(sourceDir)
            && normalizeTeamPath(existingTarget) === normalizeTeamPath(targetDir)
        ));

        if (!isMappedToTarget && existingTeamDirs.has(normalizeTeamPath(targetDir))) {
            const currentUserLabel = (
                useSessionStore.getState().displayName
                || useSessionStore.getState().teamUsername
                || 'member'
            ).replace(/[\\/:*?"<>|]/g, '').trim() || 'member';

            const baseTargetDir = `${targetParaDir}/${item.name} - ${currentUserLabel}`;
            targetDir = baseTargetDir;
            let suffix = 2;
            while (existingTeamDirs.has(normalizeTeamPath(targetDir))) {
                targetDir = `${baseTargetDir} ${suffix}`;
                suffix += 1;
            }
        }

        toast.loading(t('team.promote_pushing', { name: item.name, target: `${teamVaultName}/${targetDir}` }), { id: 'promote-team' });

        const { autoSyncManager } = await import('@/services/AutoSyncManager');
        await autoSyncManager.pauseForPromote();

        try {
            const editorName = useSessionStore.getState().displayName || undefined;
            const count = await syncService.pushDirectoryToTeam(currentVaultPath, sourceDir, targetDir, teamVaultId, editorName);

            if (count > 0) {
                toast.success(t('team.promote_success', { name: item.name, target: targetDir, count }), { id: 'promote-team' });
            } else {
                toast.success(t('team.promote_synced', { name: item.name, target: targetDir }), { id: 'promote-team' });
            }

            refreshTeamData(teamVaultId);
            window.dispatchEvent(new CustomEvent('team:directories-changed', {
                detail: { vaultId: teamVaultId }
            }));
        } catch (err) {
            const errMsg = String(err);
            console.error('[Promote] push failed:', err);
            if (errMsg.includes('EMPTY_DIR:')) {
                toast.dismiss('promote-team');
                setTimeout(() => {
                    alert(t('team.promote_empty_dir', { name: item.name }));
                }, 100);
            } else {
                toast.error(t('team.promote_failed') + `: ${errMsg}`, { id: 'promote-team' });
            }
        } finally {
            setIsPromoting(false);
            autoSyncManager.resumeAfterPromote();
        }
    };

    return {
        handleDelete,
        confirmRename,
        handleCreateNote,
        handleCreateFolder,
        handleRename,
        handleDuplicate,
        handleReveal,
        handleMoveFile,
        handlePromoteToTeam,
    };
}
