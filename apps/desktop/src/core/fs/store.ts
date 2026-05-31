import { create } from 'zustand';
import { fileSystemService } from './FileSystemService';
import { cacheService } from '@/core/cache/CacheService';
import { fileTreeSnapshotService } from './FileTreeSnapshotService';
import { FileSystemItem } from './types';
import { SortConfig, SortField, SortDirection, sortFileTree } from './sortUtils';
import { getBasename, getParentPath, getRelativePath, normalizePath } from '@/shared/utils/pathUtils';
// Storage key for persisted expansion state
const EXPANDED_PATHS_KEY = 'sidebar:expandedPaths';
const SORT_CONFIG_KEY = 'sidebar:sortConfig';

// PARA folder prefixes that should always be expanded
const PARA_PREFIXES = ['00_', '01_', '02_', '03_', '04_', 'assets'];

// Default sort config
const DEFAULT_SORT_CONFIG: SortConfig = {
    field: 'name',
    direction: 'asc',
};

interface FileSystemState {
    root: FileSystemItem | null;
    expandedPaths: Set<string>;
    sortConfig: SortConfig;

    clearRoot: () => void;
    loadRoot: (path: string) => Promise<void>;
    toggleFolder: (path: string, isOpen: boolean) => Promise<void>;
    refreshNode: (path: string) => Promise<void>;
    removeNode: (path: string) => void;
    renameNode: (oldPath: string, newPath: string) => void;
    updateNodeMetadata: (path: string, metadata: { title?: string, tags?: string[] }) => void;
    expandToPath: (filePath: string) => Promise<void>;
    refreshTree: () => Promise<void>;
    setSortConfig: (field: SortField, direction: SortDirection) => void;
}

// Helper to recursively update the tree
const updateTree = (
    node: FileSystemItem,
    targetPath: string,
    updater: (n: FileSystemItem) => FileSystemItem
): FileSystemItem => {
    if (node.path === targetPath) {
        return updater(node);
    }
    if (node.children) {
        return {
            ...node,
            children: node.children.map(child => updateTree(child, targetPath, updater))
        };
    }
    return node;
};

// Load persisted expansion state from localStorage
const loadExpandedPaths = (): Set<string> => {
    try {
        const stored = localStorage.getItem(EXPANDED_PATHS_KEY);
        if (stored) {
            return new Set(JSON.parse(stored));
        }
    } catch (e) {
        console.warn('[FileSystemStore] Failed to load expanded paths:', e);
    }
    return new Set();
};

// Save expansion state to localStorage
const saveExpandedPaths = (paths: Set<string>) => {
    try {
        localStorage.setItem(EXPANDED_PATHS_KEY, JSON.stringify([...paths]));
    } catch (e) {
        console.warn('[FileSystemStore] Failed to save expanded paths:', e);
    }
};

// Load sort config from localStorage
const loadSortConfig = (): SortConfig => {
    try {
        const stored = localStorage.getItem(SORT_CONFIG_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('[FileSystemStore] Failed to load sort config:', e);
    }
    return DEFAULT_SORT_CONFIG;
};

// Save sort config to localStorage
const saveSortConfig = (config: SortConfig) => {
    try {
        localStorage.setItem(SORT_CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
        console.warn('[FileSystemStore] Failed to save sort config:', e);
    }
};

// Check if folder is a PARA root folder (should always be expanded)
const isPARAFolder = (folderName: string): boolean => {
    return PARA_PREFIXES.some(prefix => folderName.startsWith(prefix));
};

const persistTreeSnapshot = (root: FileSystemItem) => {
    fileTreeSnapshotService.save(root.path, root).catch(console.error);
};

// Recursively process folder and its children, applying expansion state
const processFolder = async (
    folder: FileSystemItem,
    expandedPaths: Set<string>,
    isRootLevel: boolean = false
): Promise<FileSystemItem> => {
    const folderName = folder.name;
    // PARA folders (at root level) always expanded, others check persisted state
    const shouldBeOpen = (isRootLevel && isPARAFolder(folderName)) || expandedPaths.has(folder.path);

    if (!shouldBeOpen) {
        return { ...folder, isOpen: false };
    }

    try {
        const children = await fileSystemService.getDirectoryContents(folder.path);
        // Recursively process child folders
        const processedChildren = await Promise.all(
            children.map(async (child) => {
                if (child.type === 'folder') {
                    return processFolder(child, expandedPaths, false);
                }
                return child;
            })
        );
        return { ...folder, isOpen: true, children: processedChildren };
    } catch {
        return { ...folder, isOpen: shouldBeOpen };
    }
};
export const useFileSystemStore = create<FileSystemState>((set, get) => ({
    root: null,
    expandedPaths: loadExpandedPaths(),
    sortConfig: loadSortConfig(),

    // Clear root immediately - used during vault switching to prevent stale data
    clearRoot: () => {
        set({ root: null });
    },

    loadRoot: async (path: string) => {
        // Initialize cache
        await cacheService.initialize(path);

        const { expandedPaths } = get();
        const cachedTree = await fileTreeSnapshotService.load(path);
        if (cachedTree) {
            const { sortConfig } = get();
            set({ root: sortFileTree(cachedTree, sortConfig, true) });
        }

        try {
            const children = await fileSystemService.getDirectoryContents(path);
            const name = getBasename(path) || path;
            // Process all children recursively, applying expansion state at any depth
            const expandedChildren = await Promise.all(
                children.map(async (child) => {
                    if (child.type === 'folder') {
                        return processFolder(child, expandedPaths, true); // isRootLevel = true
                    }
                    return child;
                })
            );

            const rootItem: FileSystemItem = {
                id: path,
                name,
                path,
                type: 'folder',
                isOpen: true,
                children: expandedChildren
            };

            // Apply sorting before setting root
            const { sortConfig } = get();
            const sortedRoot = sortFileTree(rootItem, sortConfig, true);
            set({ root: sortedRoot });
            persistTreeSnapshot(sortedRoot);
        } catch (error) {
            console.error("Failed to load root:", error);
        }
    },

    toggleFolder: async (path: string, isOpen: boolean) => {
        const { root, expandedPaths, sortConfig } = get();
        if (!root) return;

        // Update persisted state for all folders so manual toggle is respected
        const newExpandedPaths = new Set(expandedPaths);
        if (isOpen) {
            newExpandedPaths.add(path);
        } else {
            newExpandedPaths.delete(path);
        }
        set({ expandedPaths: newExpandedPaths });
        saveExpandedPaths(newExpandedPaths);

        if (!isOpen) {
            const newRoot = updateTree(root, path, (node) => ({ ...node, isOpen: false }));
            set({ root: newRoot });
            persistTreeSnapshot(newRoot);
            return;
        }

        try {
            const children = await fileSystemService.getDirectoryContents(path);

            // Apply persisted expansion state to loaded children - recursively process expanded subfolders
            const processedChildren = await Promise.all(
                children.map(async (child) => {
                    if (child.type === 'folder') {
                        // Recursively process subfolder if it should be expanded
                        return processFolder(child, expandedPaths, false);
                    }
                    return child;
                })
            );

            const newRoot = updateTree(root, path, (node) => ({
                ...node,
                isOpen: true,
                children: processedChildren
            }));
            // Re-sort tree to maintain correct order after loading children
            const sortedRoot = sortFileTree(newRoot, sortConfig, true);
            set({ root: sortedRoot });
            persistTreeSnapshot(sortedRoot);
        } catch (error) {
            // If folder doesn't exist (deleted externally), remove it from the tree
            const errorMsg = String(error);
            if (errorMsg.includes('No such file or directory') || errorMsg.includes('os error 2')) {

                get().removeNode(path);
            } else {
                console.error("Failed to expand folder:", error);
            }
        }
    },

    refreshNode: async (path: string) => {
        const { root, expandedPaths, sortConfig } = get();
        if (!root) return;

        try {
            const children = await fileSystemService.getDirectoryContents(path);

            const isRefreshingRoot = path === root.path;

            // Recursively restore expansion state of children (including nested subfolders)
            const processedChildren = await Promise.all(
                children.map(async (child) => {
                    if (child.type === 'folder') {
                        // Use processFolder to recursively restore nested expanded folders
                        return processFolder(child, expandedPaths, isRefreshingRoot);
                    }
                    return child;
                })
            );

            const newRoot = updateTree(root, path, (node) => ({
                ...node,
                children: processedChildren
            }));
            // Re-sort entire tree to maintain correct order
            const sortedRoot = sortFileTree(newRoot, sortConfig, true);
            set({ root: sortedRoot });
            persistTreeSnapshot(sortedRoot);
        } catch (error) {
            // If folder doesn't exist (deleted externally), remove it from the tree
            const errorMsg = String(error);
            if (errorMsg.includes('No such file or directory') || errorMsg.includes('os error 2')) {

                get().removeNode(path);
            } else {
                console.error("Failed to refresh node:", error);
            }
        }
        // 🛡️ BUG-D07: 移除原有 finally 中的无条件 slash:graph-refresh。
        // refreshNode 被 file watcher 在每次文件写盘后调用（含普通编辑保存），
        // 无条件刷新图谱会导致布局重算 → 视觉跳动。
        // 图谱刷新现在由 onAfterSave(linksChanged) 精确控制（仅链接变化时触发）。
    },

    // New: Refresh entire tree while preserving expansion state
    refreshTree: async () => {
        const { root } = get();
        if (!root) return;

        // Re-load from root path, which now respects expandedPaths
        await get().loadRoot(root.path);
        // The backend `db` will update via the watcher, which might take 100-200ms depending on I/O.
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('slash:graph-refresh'));
        }, 800);
    },

    removeNode: (path: string) => {
        const { root, expandedPaths } = get();
        if (!root) {

            return;
        }



        // Helper: case-insensitive path comparison (macOS is case-insensitive)
        const pathsMatch = (a: string, b: string): boolean => {
            return a.toLowerCase() === b.toLowerCase();
        };

        // Helper function to recursively filter out the target node
        const removeNodeFromTree = (node: FileSystemItem, target: string): FileSystemItem | null => {
            // If this node is the target (case-insensitive), return null to signal removal
            if (pathsMatch(node.path, target)) {

                return null;
            }

            if (node.children) {
                const originalLength = node.children.length;
                // Filter out the target from children and recursively process remaining
                const newChildren = node.children
                    .map(c => removeNodeFromTree(c, target))
                    .filter((c): c is FileSystemItem => c !== null);

                if (newChildren.length !== originalLength) {

                }

                return {
                    ...node,
                    children: newChildren
                };
            }
            return node;
        };

        const newRoot = removeNodeFromTree(root, path);

        if (newRoot) {

            set({ root: newRoot });
            persistTreeSnapshot(newRoot);
        } else {

        }

        // Also remove from persisted expansion state (case-insensitive check)
        const pathLower = path.toLowerCase();
        const matchingExpandedPath = Array.from(expandedPaths).find(p => p.toLowerCase() === pathLower);
        if (matchingExpandedPath) {
            const newExpandedPaths = new Set(expandedPaths);
            newExpandedPaths.delete(matchingExpandedPath);
            set({ expandedPaths: newExpandedPaths });
            saveExpandedPaths(newExpandedPaths);
        }

        // Notify graph to refresh (SQLite backend needs time to process the mv event)
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('slash:graph-refresh'));
        }, 800);

        // --- 核心防漏：当节点从树上被永久拔除时（含同步删除），无条件清洗残余的红点事件凭证 ---
        let relPath = path;
        const rootPath = root?.path;
        if (rootPath && path.startsWith(rootPath)) {
            relPath = getRelativePath(path, rootPath).replace(/\\/g, '/');
        }

        import('@tauri-apps/plugin-fs').then(async ({ readTextFile }) => {
            const pathsToClear = new Set<string>();
            pathsToClear.add(relPath);

            if (rootPath) {
                try {
                    const raw = await readTextFile(`${rootPath}/.slash/team_path_mappings.json`);
                    const data = JSON.parse(raw);
                    
                    let mappings: Record<string, string> = {};
                    if (data.teams) {
                        for (const teamId of Object.keys(data.teams)) {
                            Object.assign(mappings, data.teams[teamId]);
                        }
                    } else if (data.mappings) {
                        mappings = data.mappings as Record<string, string>;
                    } else {
                        mappings = data as Record<string, string>;
                    }
                    for (const [src, tgt] of Object.entries(mappings)) {
                        const srcNorm = src.replace(/\\/g, '/');
                        if (relPath === srcNorm) {
                            pathsToClear.add(tgt);
                        } else if (relPath.startsWith(srcNorm + '/')) {
                            const sub = relPath.slice(srcNorm.length);
                            pathsToClear.add(tgt + sub);
                        }
                    }
                } catch { /* 映射文件可能不存在，忽略即可 */ }
            }

            import('@/stores/useCollabNotifyStore').then(({ useCollabNotifyStore }) => {
                for (const p of pathsToClear) {
                    useCollabNotifyStore.getState().clearUnreadForDeletedPath(p);
                }
            });
        }).catch(err => console.warn('[FileSystemStore] Failed to parse mappings for unread cleanup:', err));
    },

    renameNode: (oldPath: string, newPath: string) => {
        const { root, expandedPaths, sortConfig } = get();
        if (!root) return;

        const newName = getBasename(newPath) || '';

        let found = false;
        const newRoot = updateTree(root, oldPath, (node) => {
            found = true;
            return {
                ...node,
                path: newPath,
                id: newPath,
                name: newName
            };
        });

        if (found) {
            // Re-sort tree after rename to maintain correct sort order
            const sortedRoot = sortFileTree(newRoot, sortConfig, true);
            set({ root: sortedRoot });
            persistTreeSnapshot(sortedRoot);

            // Update persisted expansion state if folder was renamed
            if (expandedPaths.has(oldPath)) {
                const newExpandedPaths = new Set(expandedPaths);
                newExpandedPaths.delete(oldPath);
                newExpandedPaths.add(newPath);
                set({ expandedPaths: newExpandedPaths });
                saveExpandedPaths(newExpandedPaths);
            }
            
            if (typeof window !== 'undefined') {
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('slash:graph-refresh'));
                }, 500);
            }
        }
    },

    updateNodeMetadata: (path: string, metadata: { title?: string, tags?: string[] }) => {
        const { root } = get();
        if (!root) return;

        const newRoot = updateTree(root, path, (node) => ({
            ...node,
            ...metadata
        }));

        set({ root: newRoot });
        persistTreeSnapshot(newRoot);
    },

    expandToPath: async (filePath: string) => {
        const { root, toggleFolder } = get();
        if (!root || !filePath) return;

        // Get the parent folder path of the file
        const parentPath = getParentPath(filePath);
        if (!parentPath || parentPath === normalizePath(root.path)) return;

        // Helper to check if a path is open in the actual tree
        const isPathOpenInTree = (nodePath: string): boolean => {
            const findNode = (node: FileSystemItem): FileSystemItem | null => {
                if (node.path === nodePath) return node;
                if (node.children) {
                    for (const child of node.children) {
                        const found = findNode(child);
                        if (found) return found;
                    }
                }
                return null;
            };
            const node = findNode(root);
            return node?.isOpen === true;
        };

        // Build list of all parent paths that need to be expanded
        const pathsToExpand: string[] = [];
        let currentPath = parentPath;

        while (currentPath && currentPath !== root.path && currentPath.startsWith(root.path)) {
            // Check if the folder is actually open in the tree, not just in expandedPaths
            if (!isPathOpenInTree(currentPath)) {
                pathsToExpand.unshift(currentPath);
            }
            currentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        }

        // Expand each folder in order (from root to deepest)
        for (const path of pathsToExpand) {
            await toggleFolder(path, true);
        }
    },

    setSortConfig: (field: SortField, direction: SortDirection) => {
        const newConfig: SortConfig = { field, direction };
        saveSortConfig(newConfig);

        const { root } = get();
        if (root) {
            // Re-sort the entire tree with new config
            const sortedRoot = sortFileTree(root, newConfig, true);
            set({ sortConfig: newConfig, root: sortedRoot });
            persistTreeSnapshot(sortedRoot);
        } else {
            set({ sortConfig: newConfig });
        }
    }
}));
