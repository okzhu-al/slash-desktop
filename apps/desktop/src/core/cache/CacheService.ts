import { exists, readTextFile, writeTextFile, stat, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { metadataService } from '@/core/metadata/MetadataService';

interface CacheEntry {
    mtime: number;
    title?: string;
    tags?: string[];
    created?: number;  // Slash frontmatter created timestamp
    updated?: number;  // Slash frontmatter updated timestamp
}

interface CacheIndex {
    [filePath: string]: CacheEntry;
}

const CACHE_FILE = 'cache.json';
const CACHE_DIR_NAME = '.slash';

class CacheService {
    private cache: CacheIndex = {};
    private isLoaded = false;
    private saveTimeout: NodeJS.Timeout | null = null;
    private rootDir: string = '';

    // Initialize with a root directory to store .slash folder
    async initialize(baseDir: string) {
        if (this.rootDir !== baseDir) {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
                if (this.rootDir) {
                    await this.persist();
                }
            }
            this.cache = {};
            this.isLoaded = false;
        }
        this.rootDir = baseDir;
        await this.load();
    }

    private async getCachePath(): Promise<string> {
        return await join(this.rootDir, CACHE_DIR_NAME, CACHE_FILE);
    }

    private async load() {
        if (this.isLoaded) return;
        try {
            const cachePath = await this.getCachePath();
            if (await exists(cachePath)) {
                const content = await readTextFile(cachePath);
                this.cache = JSON.parse(content);
            }
        } catch (e) {
            console.warn('Failed to load cache', e);
            this.cache = {};
        }
        this.isLoaded = true;
    }

    private async scheduleSave() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.persist(), 5000);
    }

    public async persist() {
        try {
            const folderPath = await join(this.rootDir, CACHE_DIR_NAME);
            if (!await exists(folderPath)) {
                await mkdir(folderPath, { recursive: true });
            }
            const cachePath = await join(folderPath, CACHE_FILE);
            await writeTextFile(cachePath, JSON.stringify(this.cache, null, 2));
        } catch (e) {
            console.error('Failed to save cache', e);
        }
    }

    delete(path: string) {
        delete this.cache[path];
        this.scheduleSave();
    }

    rename(oldPath: string, newPath: string) {
        if (this.cache[oldPath]) {
            this.cache[newPath] = this.cache[oldPath];
            delete this.cache[oldPath];
            this.scheduleSave();
        }
    }

    get(path: string): CacheEntry | undefined {
        return this.cache[path];
    }

    set(path: string, data: CacheEntry) {
        this.cache[path] = data;
        this.scheduleSave();
    }

    async reconcile(path: string): Promise<CacheEntry | null> {
        try {
            const stats = await stat(path);
            const mtime = stats.mtime?.getTime() || 0;
            const cached = this.cache[path];

            // Clean?
            if (cached && cached.mtime === mtime) {
                return cached;
            }

            // Dirty: parse file
            const content = await readTextFile(path);
            const { metadata } = metadataService.parse(path, content);

            const entry: CacheEntry = {
                mtime,
                title: metadata.title,
                tags: metadata.tags,
                created: metadata.created,
                updated: metadata.updated,
            };

            this.set(path, entry);
            return entry;
        } catch (e) {
            console.warn(`Failed to reconcile cache for ${path}`, e);
            return null;
        }
    }
}

export const cacheService = new CacheService();
