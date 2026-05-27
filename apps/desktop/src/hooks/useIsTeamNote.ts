import { useState, useEffect } from 'react';
import { useFileSystemStore } from '@/core/fs/store';
import { readTextFile } from '@tauri-apps/plugin-fs';
export async function isTeamNoteAsync(vaultPath: string | undefined | null, notePath: string): Promise<boolean> {
    if (!vaultPath || !notePath) return false;
    if (notePath.startsWith('__team__/')) return true;

    try {
        const raw = await readTextFile(`${vaultPath}/.slash/team_path_mappings.json`);
        const data = JSON.parse(raw);
        let allMappings: Record<string, string> = {};
        
        if (data.teams) {
            for (const teamId of Object.keys(data.teams)) {
                Object.assign(allMappings, data.teams[teamId]);
            }
        } else if (data.mappings) {
            allMappings = data.mappings;
        }

        // 🛡️ Windows 兼容：统一转换为正斜杠，并将盘符转为小写
        let normNote = notePath.replace(/\\/g, '/');
        if (/^[a-zA-Z]:\//.test(normNote)) normNote = normNote.charAt(0).toLowerCase() + normNote.slice(1);
        
        let normVault = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
        if (/^[a-zA-Z]:\//.test(normVault)) normVault = normVault.charAt(0).toLowerCase() + normVault.slice(1);

        const relPath = normNote.startsWith(normVault + '/')
            ? normNote.slice(normVault.length + 1)
            : normNote;

        console.log('[isTeamNote] relPath=', relPath, 'sources=', Object.keys(allMappings));
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
