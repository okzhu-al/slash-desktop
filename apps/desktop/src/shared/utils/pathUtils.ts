/**
 * Cross-platform path utilities
 * Works with both Windows (backslash) and Unix (forward slash) paths
 */

/**
 * Normalize path separators to forward slashes (Tauri convention)
 */
export const normalizePath = (path: string): string => {
    let normalized = path.replace(/\\/g, '/');
    // Normalize Windows drive letters to lowercase (e.g. C:/ -> c:/)
    if (/^[a-zA-Z]:\//.test(normalized)) {
        normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
    }
    return normalized;
};

/**
 * Get relative path from a base path
 * Handles both slash types for Windows compatibility
 */
export const getRelativePath = (fullPath: string, basePath: string): string => {
    const normalizedFull = normalizePath(fullPath);
    const normalizedBase = normalizePath(basePath);

    // Remove trailing slash from base if present
    const cleanBase = normalizedBase.endsWith('/')
        ? normalizedBase
        : normalizedBase + '/';

    if (normalizedFull.startsWith(cleanBase)) {
        return normalizedFull.slice(cleanBase.length);
    }

    return normalizedFull;
};

/**
 * Get parent directory path
 */
export const getParentPath = (path: string): string => {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '';
};

/**
 * Get file/folder name from path
 */
export const getBasename = (path: string): string => {
    const normalized = normalizePath(path);
    return normalized.split('/').pop() || path;
};

/**
 * Check if a path starts with another path (parent check)
 */
export const isChildPath = (childPath: string, parentPath: string): boolean => {
    const normalizedChild = normalizePath(childPath);
    const normalizedParent = normalizePath(parentPath);
    const cleanParent = normalizedParent.endsWith('/')
        ? normalizedParent
        : normalizedParent + '/';
    return normalizedChild.startsWith(cleanParent);
};
