/**
 * useTeamDirectoryMapping — 团队目录映射推导
 *
 * 职责：
 * 1. 加载磁盘 team_directory_mappings.json / team_path_mappings.json（promoted 目录映射）
 * 2. 仅从显式路径映射推导 teamDirectories，避免同名个人目录被远端 teamTree 接管
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

async function loadActiveTeamMappings(rootDir: string, teamVaultId: string): Promise<Map<string, string>> {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const active = new Map<string, string>();

    try {
        const raw = await readTextFile(`${rootDir}/.slash/team_directory_mappings.json`);
        const data = JSON.parse(raw);
        const directories = data?.teams?.[teamVaultId]?.directories;
        if (directories && typeof directories === 'object') {
            for (const mapping of Object.values(directories) as Array<any>) {
                if (mapping?.status !== 'active') continue;
                if (typeof mapping.local_path === 'string' && typeof mapping.remote_path === 'string') {
                    active.set(mapping.local_path, mapping.remote_path);
                }
            }
        }
    } catch {
        // v3 mapping is optional during migration.
    }

    try {
        const raw = await readTextFile(`${rootDir}/.slash/team_path_mappings.json`);
        const data = JSON.parse(raw);

        let parsedTeams: Record<string, Record<string, string>> = {};

        if (data.teams) {
            parsedTeams = data.teams;
        } else if (data.vault_id && data.mappings) {
            // V1 兼容 fallback
            parsedTeams[data.vault_id] = data.mappings;
        }

        const legacyMappings = parsedTeams[teamVaultId] || {};
        for (const [sourcePath, targetPath] of Object.entries(legacyMappings)) {
            if (![...active.values()].includes(targetPath)) {
                active.set(sourcePath, targetPath);
            }
        }
    } catch {
        // Legacy mapping is also optional after v3 migration.
    }

    return active;
}

export function useTeamDirectoryMapping({ rootDir, hasTeamVault, teamTree }: UseTeamDirectoryMappingOptions) {
    const [activeMappings, setActiveMappings] = useState<Map<string, string>>(new Map());

    // 加载磁盘上的显式 mapping 来区分 Online 与 Offline 目录
    useEffect(() => {
        if (!rootDir || !hasTeamVault) {
            setActiveMappings(new Map());
            return;
        }
        const currentTeamVaultId = useSessionStore.getState().teamVaultId;
        if (!currentTeamVaultId) {
            setActiveMappings(new Map());
            return;
        }
        (async () => {
            try {
                const active = await loadActiveTeamMappings(rootDir, currentTeamVaultId);
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
            let updated = false;
            const prefixNorm = prefixMatch.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

            try {
                const raw = await readTextFile(mappingPath);
                const data = JSON.parse(raw);

                let parsedTeams: Record<string, Record<string, string>> = {};
                if (data.teams) {
                    parsedTeams = data.teams;
                } else if (data.vault_id && data.mappings) {
                    parsedTeams[data.vault_id] = data.mappings;
                }

                const teamMappings = parsedTeams[currentTeamVaultId];
                if (teamMappings) {
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
                    }
                }
            } catch {
                // Legacy mapping may not exist in v3-only vaults.
            }

            try {
                const v3Path = `${rootDir}/.slash/team_directory_mappings.json`;
                const raw = await readTextFile(v3Path);
                const data = JSON.parse(raw);
                const directories = data?.teams?.[currentTeamVaultId]?.directories;
                if (directories && typeof directories === 'object') {
                    for (const [id, mapping] of Object.entries(directories) as Array<[string, any]>) {
                        const cmpStr = matchRef === 'source' ? mapping?.local_path : mapping?.remote_path;
                        const cmpNorm = String(cmpStr || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                        if (cmpNorm === prefixNorm || cmpNorm.startsWith(prefixNorm + '/')) {
                            delete directories[id];
                            updated = true;
                        }
                    }
                    if (updated) {
                        await writeTextFile(v3Path, JSON.stringify(data, null, 2));
                    }
                }
            } catch {
                // v3 mapping may not exist yet.
            }

            if (updated) {
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

    // 从显式 mapping 推导 teamDirectories。不能只靠 teamTree + PARA 反推本地路径，
    // 否则其他成员创建的同名团队目录会把本地同名个人目录误判为团队目录。
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

        for (const localRelPath of activeMappings.keys()) {
            roots.add(`${normRoot}/${localRelPath}`);
        }
        return roots;
    }, [rootDir, hasTeamVault, activeMappings]);

    return {
        teamDirectories,
        teamRoots,
        activeMappings,
        removeMapping,
    };
}
