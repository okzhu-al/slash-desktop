import { useState, useEffect } from 'react';
import { useFileSystemStore } from '@/core/fs/store';
import { readTextFile } from '@tauri-apps/plugin-fs';

async function loadTeamSourceMappings(vaultPath: string): Promise<Record<string, string>> {
    const allMappings: Record<string, string> = {};

    try {
        const raw = await readTextFile(`${vaultPath}/.slash/team_directory_mappings.json`);
        const data = JSON.parse(raw);
        for (const team of Object.values(data?.teams || {}) as Array<any>) {
            for (const mapping of Object.values(team?.directories || {}) as Array<any>) {
                if (mapping?.status !== 'active') continue;
                if (typeof mapping.local_path === 'string' && typeof mapping.remote_path === 'string') {
                    allMappings[mapping.local_path] = mapping.remote_path;
                }
            }
        }
    } catch {
        // v3 mapping is optional during migration.
    }

    try {
        const raw = await readTextFile(`${vaultPath}/.slash/team_path_mappings.json`);
        const data = JSON.parse(raw);

        if (data.teams) {
            for (const teamId of Object.keys(data.teams)) {
                Object.assign(allMappings, data.teams[teamId]);
            }
        } else if (data.mappings) {
            Object.assign(allMappings, data.mappings);
        }
    } catch {
        // Legacy mapping is optional after v3 migration.
    }

    return allMappings;
}

export async function isTeamNoteAsync(vaultPath: string | undefined | null, notePath: string): Promise<boolean> {
    if (!vaultPath || !notePath) return false;
    if (notePath.startsWith('__team__/')) return true;

    try {
        const allMappings = await loadTeamSourceMappings(vaultPath);

        // 🛡️ Windows 兼容：统一转换为正斜杠，并将盘符转为小写
        let normNote = notePath.replace(/\\/g, '/');
        if (/^[a-zA-Z]:\//.test(normNote)) normNote = normNote.charAt(0).toLowerCase() + normNote.slice(1);
        
        let normVault = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
        if (/^[a-zA-Z]:\//.test(normVault)) normVault = normVault.charAt(0).toLowerCase() + normVault.slice(1);

        const relPath = normNote.startsWith(normVault + '/')
            ? normNote.slice(normVault.length + 1)
            : normNote;

        for (const source of Object.keys(allMappings)) {
            if (relPath === source || relPath.startsWith(source + '/')) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

export function useIsTeamNote(notePath?: string | null) {
    const [isTeamNote, setIsTeamNote] = useState(false);
    const vaultPath = useFileSystemStore(state => state.root?.path);

    useEffect(() => {
        if (!notePath) {
            setIsTeamNote(false);
            return;
        }
        if (notePath.startsWith('__team__/')) {
            setIsTeamNote(true);
            return;
        }

        let isMounted = true;
        isTeamNoteAsync(vaultPath, notePath).then(found => {
            if (isMounted) setIsTeamNote(found);
        });

        return () => { isMounted = false; };
    }, [notePath, vaultPath]);

    return isTeamNote;
}
