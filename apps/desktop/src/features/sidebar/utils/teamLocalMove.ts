import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import { autoSyncManager } from '@/services/AutoSyncManager';
import { syncService } from '@/services/SyncService';
import { getBasename, getRelativePath, normalizePath } from '@/shared/utils/pathUtils';

type TeamDirectoryInfo = {
    vaultId: string;
    remotePath: string;
};

type TeamMappedPath = {
    vaultId: string;
    localRoot: string;
    remoteRoot: string;
    remotePath: string;
};

type Translate = TFunction<'translation', undefined>;

type TeamLocalMoveResult = {
    handled: boolean;
    newPath?: string;
};

function trimPath(path: string): string {
    return normalizePath(path).replace(/\/$/, '');
}

function samePath(left: string, right: string): boolean {
    return trimPath(left).toLowerCase() === trimPath(right).toLowerCase();
}

function joinPath(parent: string, name: string): string {
    return `${trimPath(parent)}/${name}`.replace(/\/+/g, '/');
}

async function readJsonFile(path: string): Promise<any | null> {
    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return JSON.parse(await readTextFile(path));
    } catch {
        return null;
    }
}

async function resolveFileMoveId(
    rootDir: string,
    teamVaultId: string,
    localPath: string,
    remotePath: string,
): Promise<string | null> {
    const data = await readJsonFile(`${trimPath(rootDir)}/.slash/team_file_mappings.json`);
    const files = data?.teams?.[teamVaultId]?.files;
    if (!files || typeof files !== 'object') {
        return null;
    }

    const localRel = getRelativePath(localPath, rootDir);
    for (const [fileId, entry] of Object.entries(files) as Array<[string, any]>) {
        if (entry?.status !== 'active') continue;
        if (
            samePath(String(entry.local_path || ''), localRel)
            || samePath(String(entry.remote_path || ''), remotePath)
        ) {
            return String(entry.file_id || fileId);
        }
    }
    return null;
}

async function resolveDirectoryIdForRemotePath(
    rootDir: string,
    teamVaultId: string,
    remotePath: string,
): Promise<string | null> {
    const data = await readJsonFile(`${trimPath(rootDir)}/.slash/team_directory_mappings.json`);
    const directories = data?.teams?.[teamVaultId]?.directories;
    if (!directories || typeof directories !== 'object') {
        return null;
    }

    for (const [directoryId, entry] of Object.entries(directories) as Array<[string, any]>) {
        if (entry?.status !== 'active') continue;
        if (samePath(String(entry.remote_path || ''), remotePath)) {
            return String(entry.directory_id || directoryId);
        }
    }
    return null;
}

export function resolveTeamMappedPath(
    path: string,
    teamDirectories: Map<string, TeamDirectoryInfo>,
): TeamMappedPath | null {
    const normalizedPath = trimPath(path);
    const candidates = [...teamDirectories.entries()]
        .map(([localRoot, info]) => ({
            localRoot: trimPath(localRoot),
            remoteRoot: trimPath(info.remotePath),
            vaultId: info.vaultId,
        }))
        .sort((a, b) => b.localRoot.length - a.localRoot.length);

    for (const candidate of candidates) {
        if (
            normalizedPath !== candidate.localRoot
            && !normalizedPath.startsWith(`${candidate.localRoot}/`)
        ) {
            continue;
        }

        const rest = normalizedPath === candidate.localRoot
            ? ''
            : normalizedPath.slice(candidate.localRoot.length + 1);
        return {
            vaultId: candidate.vaultId,
            localRoot: candidate.localRoot,
            remoteRoot: candidate.remoteRoot,
            remotePath: rest ? `${candidate.remoteRoot}/${rest}` : candidate.remoteRoot,
        };
    }

    return null;
}

function describeMoveError(error: unknown, t: Translate): string {
    const raw = error instanceof Error ? error.message : String(error || '');
    if (/Only the editor/i.test(raw)) {
        return t('team.permission_denied_move_editor', { defaultValue: '只有该文件的 Editor 可以移动它。' });
    }
    if (/Only the owner|Destination must be inside|Cannot move files across owner/i.test(raw)) {
        return t('team.permission_denied_move_dir', { defaultValue: '您只能在自己拥有的团队目录内部移动内容。' });
    }
    if (/Destination already exists/i.test(raw)) {
        return t('team.move_destination_exists', { defaultValue: '目标位置已存在同名文件或目录。' });
    }
    return raw || t('team.admin_action_failed', { defaultValue: '操作失败' });
}

export async function moveTeamMappedItemFromLocalTree({
    rootDir,
    sourcePath,
    destFolder,
    isDirectory,
    teamDirectories,
    t,
}: {
    rootDir?: string;
    sourcePath: string;
    destFolder: string;
    isDirectory: boolean;
    teamDirectories: Map<string, TeamDirectoryInfo>;
    t: Translate;
}): Promise<TeamLocalMoveResult> {
    const source = resolveTeamMappedPath(sourcePath, teamDirectories);
    if (!source) {
        return { handled: false };
    }

    const destination = resolveTeamMappedPath(destFolder, teamDirectories);
    if (!destination || destination.vaultId !== source.vaultId) {
        toast.error(t('team.permission_denied_move_dir', { defaultValue: '您只能在自己拥有的团队目录内部移动内容。' }));
        return { handled: true };
    }

    let serverMoveApplied = false;
    try {
        const config = syncService.getConfig();
        if (!config) {
            toast.error(t('team.load_failed', { defaultValue: '团队空间未连接。' }));
            return { handled: true };
        }

        const { teamService } = await import('@/services/TeamService');
        const { invoke } = await import('@tauri-apps/api/core');
        const { exists } = await import('@tauri-apps/plugin-fs');
        const sourceLocal = trimPath(sourcePath);
        const destLocal = trimPath(destFolder);
        const localTargetPath = joinPath(destLocal, getBasename(sourceLocal));

        if (!(await exists(sourceLocal))) {
            toast.error(t('team.admin_action_failed', { defaultValue: '操作失败' }));
            return { handled: true };
        }
        if (isDirectory && (samePath(destLocal, sourceLocal) || destLocal.startsWith(`${sourceLocal}/`))) {
            toast.error(t('team.permission_denied_move_dir', { defaultValue: '您只能在自己拥有的团队目录内部移动内容。' }));
            return { handled: true };
        }
        if (!samePath(localTargetPath, sourceLocal) && await exists(localTargetPath)) {
            toast.error(t('team.move_destination_exists', { defaultValue: '目标位置已存在同名文件或目录。' }));
            return { handled: true };
        }

        const destinationDirectoryId = rootDir
            ? await resolveDirectoryIdForRemotePath(rootDir, source.vaultId, destination.remotePath)
            : null;
        if (isDirectory) {
            const dirName = getBasename(source.remotePath) || source.remotePath;
            const newPrefix = `${destination.remotePath.replace(/\/$/, '')}/${dirName}`;
            const sourceDirectoryId = rootDir
                ? await resolveDirectoryIdForRemotePath(rootDir, source.vaultId, source.remotePath)
                : null;
            await teamService.renameDirectory(
                config.serverUrl,
                config.accessToken,
                source.vaultId,
                source.remotePath,
                newPrefix,
                sourceDirectoryId,
                destinationDirectoryId,
            );
            serverMoveApplied = true;
        } else {
            const fileId = rootDir
                ? await resolveFileMoveId(rootDir, source.vaultId, sourcePath, source.remotePath)
                : null;
            await teamService.moveFile(
                config.serverUrl,
                config.accessToken,
                source.vaultId,
                source.remotePath,
                destination.remotePath,
                fileId,
                destinationDirectoryId,
            );
            serverMoveApplied = true;
        }

        let newLocalPath: string | undefined;
        if (rootDir) {
            newLocalPath = await invoke<string>('move_file', {
                sourcePath,
                destFolder,
                vaultPath: rootDir,
            });
        }

        toast.success(t('team.admin_move_success', { defaultValue: '移动成功' }));
        autoSyncManager.forceSync('owner_local_tree_move');
        return { handled: true, newPath: newLocalPath };
    } catch (error) {
        if (serverMoveApplied) {
            autoSyncManager.forceSync('owner_local_tree_move_local_failed');
        }
        toast.error(describeMoveError(error, t));
    }

    return { handled: true };
}
