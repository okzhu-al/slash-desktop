/**
 * useTeamDirectoryMapping — 团队目录映射推导
 *
 * 职责：
 * 1. 加载磁盘 team_path_mappings.json（promoted 目录映射）
 * 2. 从 teamTree + PARA 反向映射推导 teamDirectories
 * 3. 计算 teamRoots（用于 FileTreeItem 的 team badge 标记）
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { TeamTreeNode } from '@/services/SyncService';
import { useSessionStore } from '@/stores/useSessionStore';

/** 团队 PARA 路径 → 个人 PARA 路径的映射常量 */
export const PARA_TEAM_TO_PERSONAL: Record<string, string> = {
    '01_PROJECTS': '01_Projects',
    '02_AREAS': '02_Areas',
    '03_RESOURCE': '03_Resources',
    '04_ARCHIVE': '04_Archives',
};

interface UseTeamDirectoryMappingOptions {
    rootDir: string | undefined;
    hasTeamVault: boolean;
    teamTree: TeamTreeNode[];
}

export function useTeamDirectoryMapping({ rootDir, hasTeamVault, teamTree }: UseTeamDirectoryMappingOptions) {
    const [activeMappings, setActiveMappings] = useState<Map<string, string>>(new Map());
    const [hasTeamSyncState, setHasTeamSyncState] = useState(false);

    // 加载磁盘上的 team_path_mappings.json 来区分 Online 与 Offline 目录
    useEffect(() => {
        if (!rootDir || !hasTeamVault) {
            setActiveMappings(new Map());
            setHasTeamSyncState(false);
            return;
        }
        const currentTeamVaultId = useSessionStore.getState().teamVaultId;
        (async () => {
            try {
                const { exists } = await import('@tauri-apps/plugin-fs');
                const hasState = await exists(`${rootDir}/.slash/team_sync_state.json`);
                setHasTeamSyncState(hasState);
            } catch {
                setHasTeamSyncState(false);
            }

            try {
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                const raw = await readTextFile(`${rootDir}/.slash/team_path_mappings.json`);
                const data = JSON.parse(raw);

                let parsedTeams: Record<string, Record<string, string>> = {};
                
                if (data.teams) {
                    parsedTeams = data.teams;
                } else if (data.vault_id && data.mappings) {
                    // V1 兼容 fallback
                    parsedTeams[data.vault_id] = data.mappings;
                }

                const active = new Map<string, string>();
                for (const [vaultId, maps] of Object.entries(parsedTeams)) {
                    if (vaultId === currentTeamVaultId) {
                        for (const [sourcePath, targetPath] of Object.entries(maps)) {
                            active.set(sourcePath, targetPath);
                        }
                    }
                }
                setActiveMappings(active);
            } catch {
                setActiveMappings(new Map());
            }
        })();
    }, [rootDir, hasTeamVault, teamTree]);

    // UI Safe V2 Editor Helper
    const removeMapping = useCallback(async (
        matchRef: 'source' | 'target', 
        prefixMatch: string
    ) => {
        if (!rootDir) return;
        const currentTeamVaultId = useSessionStore.getState().teamVaultId;
        if (!currentTeamVaultId) return;

        try {
            const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
            const mappingPath = `${rootDir}/.slash/team_path_mappings.json`;
            const raw = await readTextFile(mappingPath);
            const data = JSON.parse(raw);

            let parsedTeams: Record<string, Record<string, string>> = {};
            if (data.teams) {
                parsedTeams = data.teams;
            } else if (data.vault_id && data.mappings) {
                parsedTeams[data.vault_id] = data.mappings;
            }

            const teamMappings = parsedTeams[currentTeamVaultId];
            if (!teamMappings) return;

            const prefixNorm = prefixMatch.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
            let updated = false;

            for (const [src, tgt] of Object.entries(teamMappings)) {
                const cmpStr = matchRef === 'source' ? src : tgt;
                const cmpNorm = cmpStr.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

                if (cmpNorm === prefixNorm || cmpNorm.startsWith(prefixNorm + '/')) {
                    delete teamMappings[src];
                    updated = true;
                }
            }

            if (updated) {
                await writeTextFile(mappingPath, JSON.stringify({ teams: parsedTeams }, null, 2));
                setActiveMappings(prev => {
                    const next = new Map(prev);
                    for (const [src, tgt] of next) {
                        const cmpStr = matchRef === 'source' ? src : tgt;
                        const cmpNorm = cmpStr.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                        if (cmpNorm === prefixNorm || cmpNorm.startsWith(prefixNorm + '/')) {
                            next.delete(src);
                        }
                    }
                    return next;
                });
            }
        } catch (e) {
            console.warn('Failed to update team_path_mappings safely:', e);
        }
    }, [rootDir]);

    // 从 teamTree 推导 teamDirectories (仅针对 Active Team 同步)
    const teamDirectories = useMemo(() => {
        const result = new Map<string, any>();
        if (!rootDir || teamTree.length === 0) return result;

        const currentTeamVaultId = useSessionStore.getState().teamVaultId;
        if (!currentTeamVaultId) return result;

        // 🛡️ Windows 兼容：统一正斜杠，避免 item.path 比较失败
        const normRoot = rootDir.replace(/\\/g, '/').replace(/\/$/, '');

        const collectPaths = (nodes: TeamTreeNode[]): Set<string> => {
            const paths = new Set<string>();
            for (const node of nodes) {
                paths.add(node.path);
                if (node.children) {
                    for (const p of collectPaths(node.children)) paths.add(p);
                }
            }
            return paths;
        };

        const allTeamPaths = collectPaths(teamTree);

        for (const teamPath of allTeamPaths) {
            if (
                teamPath === '01_PROJECTS' ||
                teamPath === '02_AREAS' ||
                teamPath === '03_RESOURCE' ||
                teamPath === '04_ARCHIVE'
            ) {
                continue;
            }

            for (const [teamPrefix, personalPrefix] of Object.entries(PARA_TEAM_TO_PERSONAL)) {
                if (teamPath === teamPrefix || teamPath.startsWith(teamPrefix + '/')) {
                    const subPath = teamPath === teamPrefix ? '' : teamPath.slice(teamPrefix.length);
                    const personalRelPath = personalPrefix + subPath;
                    const fullPath = `${normRoot}/${personalRelPath}`;
                    result.set(fullPath, { vaultId: currentTeamVaultId, remotePath: teamPath });
                    break;
                }
            }
        }

        for (const [sourceDir, targetDir] of activeMappings) {
            const fullPath = `${normRoot}/${sourceDir}`;
            if (!result.has(fullPath)) {
                if (allTeamPaths.has(targetDir)) {
                    result.set(fullPath, { vaultId: currentTeamVaultId, remotePath: targetDir });
                }
            }
        }

        return result;
    }, [teamTree, rootDir, activeMappings]);

    const teamRoots = useMemo(() => {
        const roots = new Set<string>();
        if (!rootDir || !hasTeamVault) return roots;

        // 🛡️ Windows 兼容
        const normRoot = rootDir.replace(/\\/g, '/').replace(/\/$/, '');

        // 🛡️ 安全加固判定：必须物理存在 team_sync_state.json，且 activeMappings 为空时，才视为全同步模式
        const isFullTeamVault = hasTeamSyncState && activeMappings.size === 0;
        if (isFullTeamVault) {
            Object.values(PARA_TEAM_TO_PERSONAL).forEach(p => {
                roots.add(`${normRoot}/${p}`);
            });
        }

        for (const localRelPath of activeMappings.keys()) {
            roots.add(`${normRoot}/${localRelPath}`);
        }
        return roots;
    }, [rootDir, hasTeamVault, activeMappings, hasTeamSyncState]);

    return {
        teamDirectories,
        teamRoots,
        activeMappings,
        removeMapping,
    };
}
