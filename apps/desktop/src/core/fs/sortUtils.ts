import { FileSystemItem } from './types';

// PARA root folders - always pinned at top in this order
const PARA_ORDER = ['00_Inbox', '01_Projects', '02_Areas', '03_Resources', '04_Archives'];

// Sort options
export type SortField = 'name' | 'created' | 'modified';
export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
    field: SortField;
    direction: SortDirection;
}

// Natural sort collator for locale-aware sorting (handles "笔记2" vs "笔记10" correctly)
const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

/**
 * Check if a folder is a PARA root folder
 */
export const isPARAFolder = (name: string): boolean => {
    return PARA_ORDER.includes(name);
};

/**
 * Get PARA folder order (0-4), or -1 if not a PARA folder
 */
export const getPARAOrder = (name: string): number => {
    return PARA_ORDER.indexOf(name);
};

/**
 * Sort file system items with the following rules:
 * 1. PARA folders always at top (00_Inbox, 01_Projects, etc.) in fixed order
 * 2. Folders before files (within non-PARA items)
 * 3. Natural sort using Intl.Collator for name, or timestamp for time-based sorts
 */
export const sortFileSystemItems = (
    items: FileSystemItem[],
    config: SortConfig,
    isRootLevel: boolean = false
): FileSystemItem[] => {
    return [...items].sort((a, b) => {
        // Rule 1: PARA folders at root level are always pinned at top
        if (isRootLevel) {
            const aParaOrder = getPARAOrder(a.name);
            const bParaOrder = getPARAOrder(b.name);

            // Both are PARA folders - sort by PARA order
            if (aParaOrder !== -1 && bParaOrder !== -1) {
                return aParaOrder - bParaOrder;
            }
            // Only a is PARA - a comes first
            if (aParaOrder !== -1) return -1;
            // Only b is PARA - b comes first
            if (bParaOrder !== -1) return 1;
        }

        // Rule 2: Folders before files
        if (a.type !== b.type) {
            return a.type === 'folder' ? -1 : 1;
        }

        // Rule 3: Sort by field
        let comparison = 0;

        switch (config.field) {
            case 'name':
                comparison = collator.compare(a.name, b.name);
                break;
            case 'created':
                // Use createdAt timestamp if available, fallback to 0
                const aCreated = a.createdAt || 0;
                const bCreated = b.createdAt || 0;
                comparison = aCreated - bCreated;
                break;
            case 'modified':
                // Use updatedAt timestamp if available, fallback to 0
                const aModified = a.updatedAt || 0;
                const bModified = b.updatedAt || 0;
                comparison = aModified - bModified;
                break;
        }

        // Apply direction
        return config.direction === 'asc' ? comparison : -comparison;
    });
};

/**
 * Recursively sort a file tree
 */
export const sortFileTree = (
    item: FileSystemItem,
    config: SortConfig,
    isRoot: boolean = true
): FileSystemItem => {
    if (!item.children) return item;

    const sortedChildren = sortFileSystemItems(item.children, config, isRoot).map(
        (child) => sortFileTree(child, config, false)
    );

    return { ...item, children: sortedChildren };
};
