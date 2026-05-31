import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { exists } from '@tauri-apps/plugin-fs';
import { useTabsStore } from '@/core/tabs/TabsStore';

// Helper function to clean up tabs for deleted notes
const cleanupDeletedTabs = async () => {
    const { tabs, closeTab } = useTabsStore.getState();

    for (const tab of tabs) {
        const tabPath = tab.id;

        // 跳过虚拟 Tab（团队管理、图谱、设置等没有对应磁盘文件的 Tab）
        if (!tabPath.endsWith('.md')) continue;

        // Check if file still exists
        try {
            const fileExists = await exists(tabPath);
            if (!fileExists) {

                closeTab(tabPath);
            }
        } catch {
            // exists() 对真实路径失败，静默跳过（极少发生）
        }
    }
};
export interface VaultScanStats {
    notesScanned: number;
    linksFound: number;
}

export interface VaultConnectionState {
    /** True when init_db succeeds, safe to start querying */
    isDbReady: boolean;
    /** True while scan_vault is running */
    isScanning: boolean;

    /** Scan results */
    scanStats: VaultScanStats | null;
    /** Any initialization errors */
    error: string | null;
    /** Manually trigger a rescan */
    rescan: () => Promise<void>;
}

/**
 * Custom hook to manage database lifecycle and sync process when opening a vault.
 * 
 * Flow:
 * 1. init_db(vaultPath) - Initialize SQLite database
 * 2. start_watcher(vaultPath) - Start file system watcher
 * 3. start_embedding_worker(vaultPath) - Start background embedding worker
 * 4. scan_vault(vaultPath) - Run a background DB refresh after UI is usable
 */
export function useVaultConnection(vaultPath: string | null): VaultConnectionState {
    const [isDbReady, setIsDbReady] = useState(false);
    const [isScanning, setIsScanning] = useState(false);

    const [scanStats, setScanStats] = useState<VaultScanStats | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Scan vault function
    const scanVault = useCallback(async (path: string) => {
        setIsScanning(true);
        setError(null);

        try {
            await invoke<number>('scan_vault', { vaultPath: path });

            // Get notes and links count
            const notes = await invoke<any[]>('get_notes');
            const links = await invoke<any[]>('get_links');

            setScanStats({
                notesScanned: notes.length,
                linksFound: links.length,
            });


        } catch (e) {
            console.error('❌ [VaultConnection] Scan failed:', e);
            setError(`Scan failed: ${e}`);
        } finally {
            setIsScanning(false);
        }
    }, []);

    // Lightweight refresh function (just updates stats, no full scan)
    const refreshStats = useCallback(async () => {
        try {
            const notes = await invoke<any[]>('get_notes');
            const links = await invoke<any[]>('get_links');
            setScanStats({
                notesScanned: notes.length,
                linksFound: links.length,
            });

        } catch (e) {
            console.error('⚠️ [VaultConnection] Refresh failed:', e);
        }
    }, []);

    // Main initialization effect
    useEffect(() => {
        if (!vaultPath) {
            // Reset state when vault is closed
            setIsDbReady(false);
            setIsScanning(false);

            setScanStats(null);
            setError(null);
            return;
        }

        let unlistenRefresh: UnlistenFn | null = null;
        let scanTimer: ReturnType<typeof setTimeout> | null = null;

        const initializeVault = async () => {


            // Step A: Connect to database
            try {
                await invoke<string>('init_db', { vaultPath });

                // 恢复已保存的 AI Provider 配置（online API key 等）
                try {
                    await invoke('restore_ai_config');
                } catch (e) {
                    console.warn('⚠️ [VaultConnection] AI config restore skipped:', e);
                }

                setIsDbReady(true);
                setError(null);
                refreshStats();
            } catch (e) {
                console.error('❌ [VaultConnection] DB init failed:', e);
                setError(`Database initialization failed: ${e}`);
                return;
            }

            // Step B: Start file watcher before the heavier scan so UI can become usable first.
            try {
                await invoke<string>('start_watcher', { vaultPath });

            } catch (e) {
                console.warn('⚠️ [VaultConnection] File watcher error:', e);
                // Non-fatal, continue without watcher
            }

            // Step C: Start embedding background worker
            try {
                await invoke<string>('start_embedding_worker', { vaultPath });
            } catch (e) {
                console.warn('⚠️ [VaultConnection] Embedding worker error:', e);
                // Non-fatal, continue without worker
            }

            // Step D: Listen for vault:refresh events from watcher
            const cleanupRefresh = await listen('vault:refresh', async () => {
                refreshStats();

                // Clean up tabs for deleted notes
                await cleanupDeletedTabs();
            });
            if (cancelled) {
                try {
                    const p = cleanupRefresh() as any;
                    if (p && p.catch) p.catch(() => {});
                } catch { }
            } else {
                unlistenRefresh = cleanupRefresh;
            }

            if (cancelled) return;

            // Step E: Heavy vault scan runs after the workspace is visible and interactive.
            scanTimer = setTimeout(() => {
                if (!cancelled) {
                    scanVault(vaultPath);
                }
            }, 500);
        };

        let cancelled = false;
        initializeVault();

        // Cleanup: close database and unlisten when vault changes
        return () => {
            cancelled = true;
            if (unlistenRefresh) {
                try {
                    const p = unlistenRefresh() as any;
                    if (p && p.catch) p.catch(() => {});
                } catch (e) {}
            }
            if (scanTimer) {
                clearTimeout(scanTimer);
                scanTimer = null;
            }
            invoke('close_db').catch(() => {
                // Ignore close errors
            });
        };
    }, [vaultPath, scanVault, refreshStats]);

    // Rescan function for manual trigger
    const rescan = useCallback(async () => {
        if (vaultPath && isDbReady) {
            await scanVault(vaultPath);
        }
    }, [vaultPath, isDbReady, scanVault]);

    return {
        isDbReady,
        isScanning,

        scanStats,
        error,
        rescan,
    };
}
