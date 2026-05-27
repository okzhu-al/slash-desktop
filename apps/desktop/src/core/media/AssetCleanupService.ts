import { invoke } from '@tauri-apps/api/core';
import { useFileSystemStore } from '@/core/fs/store';

export interface CleanupResult {
    moved_count: number;
    space_saved_bytes: number;
}

/**
 * Format bytes to human-readable string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Clean unused assets in the vault by moving them to .trash folder
 * @returns Cleanup result with count and space saved
 */
export async function cleanUnusedAssets(): Promise<CleanupResult> {
    const rootItem = useFileSystemStore.getState().root;
    if (!rootItem) {
        throw new Error("No active workspace found");
    }

    const result = await invoke<CleanupResult>('clean_unused_assets', {
        vaultPath: rootItem.path,
    });

    return result;
}

export interface RebuildIndexResult {
    files_indexed: number;
}

/**
 * Rebuild the asset index by scanning all files in assets/
 * Use when files were modified outside the app
 */
export async function rebuildAssetIndex(): Promise<RebuildIndexResult> {
    const rootItem = useFileSystemStore.getState().root;
    if (!rootItem) {
        throw new Error("No active workspace found");
    }

    const result = await invoke<RebuildIndexResult>('rebuild_asset_index', {
        vaultPath: rootItem.path,
    });

    return result;
}

/**
 * Load asset index for current vault (call on vault open)
 */
export async function loadAssetIndex(): Promise<number> {
    const rootItem = useFileSystemStore.getState().root;
    if (!rootItem) {
        return 0;
    }

    return invoke<number>('load_asset_index', {
        vaultPath: rootItem.path,
    });
}
