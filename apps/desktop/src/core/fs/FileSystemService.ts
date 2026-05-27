import { readDir, mkdir, remove, rename as fsRename, stat, writeTextFile, watch, exists, copyFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { FileSystemItem } from './types';
import { cacheService } from '@/core/cache/CacheService';

export class FileSystemService {

    async getDirectoryContents(path: string): Promise<FileSystemItem[]> {
        let entries = [];
        try {
            entries = await readDir(path);
        } catch (e) {
            const msg = String(e);
            // Ignore access denied/forbidden path errors, common with system folders or .trash
            if (!msg.includes('forbidden path') && !msg.includes('Operation not permitted')) {
                console.warn(`[FileSystemService] Failed to read dir ${path}:`, e);
            }
            return [];
        }

        const items: FileSystemItem[] = [];

        for (const entry of entries) {
            // Skip hidden files/folders and specific system folders
            if (entry.name.startsWith('.') || entry.name === '.trash' || entry.name === '.DS_Store') continue;

            const fullPath = await join(path, entry.name);

            // Metadata Cache Integration
            const cached = cacheService.get(fullPath);

            // Trigger background reconciliation
            if (entry.isFile && entry.name.endsWith('.md')) {
                cacheService.reconcile(fullPath).catch(console.error);
            }

            // 时间戳优先级：Slash frontmatter > 文件系统 stat
            let createdAt: number | undefined = cached?.created;
            let updatedAt: number | undefined = cached?.updated;

            // Fallback 到文件系统时间戳（非 .md 文件、或 frontmatter 无时间字段时）
            if (createdAt === undefined || updatedAt === undefined) {
                try {
                    const fileStat = await stat(fullPath);
                    if (createdAt === undefined) createdAt = fileStat.birthtime?.getTime();
                    if (updatedAt === undefined) updatedAt = fileStat.mtime?.getTime();
                } catch {
                    // Ignore stat errors
                }
            }

            const item: FileSystemItem = {
                id: fullPath,
                name: entry.name,
                path: fullPath,
                type: entry.isDirectory ? 'folder' : 'file',
                title: cached?.title,
                createdAt,
                updatedAt,
                // Children will be loaded lazily or recursively depending on need
            };

            items.push(item);
        }

        // Note: Sorting is now handled by sortUtils in the store
        return items;
    }

    async createFile(path: string, content: string = ''): Promise<void> {
        await writeTextFile(path, content);
    }

    async createDirectory(path: string): Promise<void> {
        await mkdir(path, { recursive: true });
    }

    async delete(path: string): Promise<void> {
        // Check if it's a directory
        const s = await stat(path);
        if (s.isDirectory) {
            await remove(path, { recursive: true });
        } else {
            await remove(path);
        }
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        await fsRename(oldPath, newPath);
    }

    async watch(path: string, callback: (event: any) => void): Promise<() => void> {
        // Watch recursively
        return await watch(path, callback, { recursive: true });
    }

    async revealInSystem(path: string): Promise<void> {
        // Assuming backend command exists or we use opener on parent
        // Let's try to use a command 'show_in_folder'
        await invoke('show_in_folder', { path });
    }

    async duplicateFile(path: string): Promise<void> {
        // Simple duplicate implementation
        // Construct new path
        const extIndex = path.lastIndexOf('.');
        const ext = extIndex !== -1 ? path.substring(extIndex) : '';
        const base = extIndex !== -1 ? path.substring(0, extIndex) : path;

        let copyPath = `${base} copy${ext}`;
        let counter = 1;

        // Ensure unique name
        while (await exists(copyPath)) {
            counter++;
            copyPath = `${base} copy ${counter}${ext}`;
        }

        await copyFile(path, copyPath);
    }
}

export const fileSystemService = new FileSystemService();
