import { readTextFile } from '@tauri-apps/plugin-fs';
import matter from 'gray-matter';
import { useSessionStore } from '@/stores/useSessionStore';

/**
 * Checks if the current local user has write access to the given Team-mapped local file.
 * Returns true if the user is the 'editor' defined in the YAML frontmatter.
 */
export async function isUserNoteOwner(absolutePath: string): Promise<boolean> {
    try {
        const content = await readTextFile(absolutePath);
        const parsed = matter(content);
        const editorName = parsed.data?.editor;
        const localUser = useSessionStore.getState().displayName;
        return !!editorName && !!localUser && editorName === localUser;
    } catch (e) {
        console.warn('Failed to parse file for owner check:', e);
        // Default to false if we can't parse or confirm secure ownership
        return false;
    }
}
