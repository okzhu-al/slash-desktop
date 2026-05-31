import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { FileSystemItem } from './types';

const SNAPSHOT_DIR = '.slash';
const SNAPSHOT_FILE = 'file-tree-cache.json';
const SNAPSHOT_VERSION = 1;

interface FileTreeSnapshot {
    version: number;
    rootPath: string;
    generatedAt: number;
    tree: FileSystemItem;
}

const stripVolatileFields = (item: FileSystemItem): FileSystemItem => ({
    id: item.id,
    name: item.name,
    path: item.path,
    type: item.type,
    isOpen: item.isOpen,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    title: item.title,
    tags: item.tags,
    children: item.children?.map(stripVolatileFields),
});

class FileTreeSnapshotService {
    private async getSnapshotPath(rootPath: string): Promise<string> {
        return join(rootPath, SNAPSHOT_DIR, SNAPSHOT_FILE);
    }

    async load(rootPath: string): Promise<FileSystemItem | null> {
        try {
            const snapshotPath = await this.getSnapshotPath(rootPath);
            if (!(await exists(snapshotPath))) return null;

            const raw = await readTextFile(snapshotPath);
            const parsed = JSON.parse(raw) as FileTreeSnapshot;
            if (parsed.version !== SNAPSHOT_VERSION || parsed.rootPath !== rootPath || !parsed.tree) {
                return null;
            }

            return parsed.tree;
        } catch (e) {
            console.warn('[FileTreeSnapshot] Failed to load snapshot:', e);
            return null;
        }
    }

    async save(rootPath: string, tree: FileSystemItem): Promise<void> {
        try {
            const folderPath = await join(rootPath, SNAPSHOT_DIR);
            if (!(await exists(folderPath))) {
                await mkdir(folderPath, { recursive: true });
            }

            const snapshotPath = await this.getSnapshotPath(rootPath);
            const snapshot: FileTreeSnapshot = {
                version: SNAPSHOT_VERSION,
                rootPath,
                generatedAt: Date.now(),
                tree: stripVolatileFields(tree),
            };

            await writeTextFile(snapshotPath, JSON.stringify(snapshot, null, 2));
        } catch (e) {
            console.warn('[FileTreeSnapshot] Failed to save snapshot:', e);
        }
    }
}

export const fileTreeSnapshotService = new FileTreeSnapshotService();
