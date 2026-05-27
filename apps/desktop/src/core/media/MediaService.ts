import { join, extname } from '@tauri-apps/api/path';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { useFileSystemStore } from '@/core/fs/store';
import { normalizePath } from '@/shared/utils/pathUtils';

interface SaveAssetResult {
    relative_path: string;
    is_duplicate: boolean;
}

class MediaService {
    /**
     * Get the vault path (workspace root)
     */
    private getVaultPath(): string {
        const rootItem = useFileSystemStore.getState().root;
        if (!rootItem) {
            throw new Error("No active workspace found");
        }
        return rootItem.path;
    }

    /**
     * Get enriched content for a media asset by its hash
     */
    async getEnrichedContent(hash: string): Promise<string | null> {
        try {
            return await invoke<string | null>('get_enriched_content', { assetHash: hash });
        } catch (e) {
            console.error(`[MediaService] Failed to fetch enriched content for ${hash}`, e);
            return null;
        }
    }

    /**
     * Save a file object to the local assets directory with hash-based deduplication
     * @param file The file to save
     * @param isFromClipboard True if pasted from clipboard (generates timestamp name), false if dragged (uses original name)
     * @returns The relative path to be stored in Markdown (e.g., "assets/image.png")
     */
    async saveAsset(file: File, isFromClipboard: boolean = false): Promise<string> {
        const vaultPath = this.getVaultPath();
        const extension = await this.getExtension(file);

        // 大文件保护：> 10MB 时避免 Array.from(uint8Array) 的内存爆炸
        // Array.from 会将每个 byte 转为 JS Number 对象（~16字节），134MB → ~2GB OOM
        const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB

        if (file.size > LARGE_FILE_THRESHOLD) {
            // 🛡️ 大文件保护：优先走路径模式，完全绕过 JS 内存
            // Tauri 环境下拖拽/粘贴的 File 对象有 .path 属性
            const filePath = (file as any).path as string | undefined;
            if (filePath) {
                console.log(`💾 [MediaService] Large file (${(file.size / 1024 / 1024).toFixed(1)}MB) — using path mode: ${filePath}`);
                return this.saveAssetFromPath(filePath);
            }

            // Fallback：纯 Blob（无 path），必须经过 JS 内存
            // 使用 Readable stream 分块写入临时文件，避免单次 arrayBuffer 阻塞主线程
            console.log(`💾 [MediaService] Large file (${(file.size / 1024 / 1024).toFixed(1)}MB) — no path, writing to temp file...`);
            const { writeFile, remove } = await import('@tauri-apps/plugin-fs');
            const { tempDir, join } = await import('@tauri-apps/api/path');

            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            const tmpDir = await tempDir();
            const tmpFileName = `slash_paste_${Date.now()}.${extension}`;
            const tmpPath = await join(tmpDir, tmpFileName);

            try {
                await writeFile(tmpPath, uint8Array);
                const result = await this.saveAssetFromPath(tmpPath);
                return result;
            } finally {
                try { await remove(tmpPath); } catch { /* ignore */ }
            }
        }

        // 小文件（截图等 < 10MB）：保持原有快速路径
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const result = await invoke<SaveAssetResult>('save_asset', {
            vaultPath,
            fileData: Array.from(uint8Array),
            originalName: isFromClipboard ? null : (file.name || null),
            extension,
        });

        if (result.is_duplicate) {
            console.log('📦 [MediaService] Duplicate detected, using existing:', result.relative_path);
        } else {
            console.log('💾 [MediaService] New file saved:', result.relative_path);
        }

        return result.relative_path;
    }

    /**
     * Save a file from its absolute path (Zero-copy transfer)
     * @param absolutePath The absolute path of the source file
     * @returns The relative path to be stored in Markdown
     */
    async saveAssetFromPath(absolutePath: string): Promise<string> {
        const vaultPath = this.getVaultPath();
        const shortPath = normalizePath(absolutePath).split('/').slice(-2).join('/');
        console.log(`⏱️ [MediaService] saveAssetFromPath start: ${shortPath}`);
        const startMs = performance.now();

        // Always copy file to assets/ via Rust (uses efficient std::fs::copy)
        const result = await invoke<SaveAssetResult>('save_asset_from_path', {
            vaultPath,
            sourcePath: absolutePath,
        });

        const elapsed = Math.round(performance.now() - startMs);

        if (result.is_duplicate) {
            console.log(`⏱️ [MediaService] saveAssetFromPath done: ${elapsed}ms (CAS dedup) → ${result.relative_path}`);
        } else {
            console.log(`⏱️ [MediaService] saveAssetFromPath done: ${elapsed}ms (new file) → ${result.relative_path}`);
        }

        return result.relative_path;
    }

    /**
     * Get file extension from File object
     */
    private async getExtension(file: File): Promise<string> {
        if (file.name) {
            const ext = await extname(file.name);
            if (ext) return ext;
        }
        // Fallback to MIME type
        const mimeType = file.type;
        if (mimeType) {
            const parts = mimeType.split('/');
            if (parts.length > 1) return parts[1];
        }
        return 'bin';
    }

    /**
     * Save asset from raw bytes (for file picker scenarios)
     * @param data The file bytes
     * @param originalName Original filename (used for naming and extension)
     * @param _fallbackExt Fallback extension (unused, kept for API compatibility)
     * @returns The relative path to the saved asset
     */
    async saveAssetFromBytes(data: Uint8Array, originalName: string, _fallbackExt: string): Promise<string> {
        // Create a File object from the bytes
        const extension = originalName.split('.').pop() || 'bin';
        const mimeType = this.inferMimeType(extension);
        const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType });
        const file = new File([blob], originalName, { type: mimeType });

        // Use saveAsset with isFromClipboard=false since this is from file picker
        return this.saveAsset(file, false);
    }

    /**
     * Infer MIME type from extension
     */
    private inferMimeType(ext: string): string {
        const e = ext.toLowerCase();
        switch (e) {
            case 'png': return 'image/png';
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'webp': return 'image/webp';
            case 'svg': return 'image/svg+xml';
            case 'mp4': return 'video/mp4';
            case 'webm': return 'video/webm';
            case 'mov': return 'video/quicktime';
            case 'mp3': return 'audio/mpeg';
            case 'wav': return 'audio/wav';
            default: return 'application/octet-stream';
        }
    }

    /**
     * Convert a relative asset path (assets/foo.png) to a Tauri asset URL for display
     */
    async getAssetUrl(relativePath: string, rootPath?: string): Promise<string> {
        // Early exit: if rootPath was provided but differs from current vault, skip entirely
        // This prevents stale requests from old ImageComponent instances during vault switching
        const currentVault = useFileSystemStore.getState().root?.path;
        if (rootPath && currentVault && rootPath !== currentVault) {
            return relativePath;
        }

        // If it's already an external URL, return as is
        if (relativePath.startsWith('http') || relativePath.startsWith('asset:')) return relativePath;

        // Decode path (markdown stores encoded URLs)
        const decodedPath = decodeURIComponent(relativePath);

        // Check if path is absolute (Mac/Linux starts with /, Windows starts with X:)
        const isAbsolute = decodedPath.startsWith('/') || /^[a-zA-Z]:/.test(decodedPath);

        let absolutePath: string;

        if (isAbsolute) {
            absolutePath = decodedPath;
        } else {
            // Only force rootItem check for relative paths
            const effectiveRoot = rootPath || useFileSystemStore.getState().root?.path;

            if (!effectiveRoot) {
                console.warn(`[MediaService] ❌ No root path available for resolving relative path: ${relativePath}`);
                return relativePath;
            }
            absolutePath = await join(effectiveRoot, decodedPath);
        }

        // Safety check: Skip loading if absolutePath doesn't belong to the requested vault
        // This prevents 500 errors when switching vaults while images are still loading
        // Use the passed rootPath (if provided) as the authoritative source, falling back to store
        const expectedRoot = rootPath || useFileSystemStore.getState().root?.path;
        if (expectedRoot && !absolutePath.startsWith(expectedRoot)) {
            console.warn(`[MediaService] ⚠️ Skipping asset from different vault: ${absolutePath} (expected: ${expectedRoot})`);
            return relativePath; // Return original path, won't be rendered
        }

        const ext = decodedPath.split('.').pop()?.toLowerCase() || '';

        // Determine if this is a video/audio file - these should ALWAYS use asset:// protocol
        // because Blob URLs are unreliable on cold start in WKWebView (WebKitBlobResource error 1)
        const mediaExtensions = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'ogg', 'flac'];
        const isMediaFile = mediaExtensions.includes(ext);

        if (isMediaFile) {
            // For video/audio: ALWAYS use asset:// protocol for reliability
            const url = convertFileSrc(absolutePath);
            return url;
        }

        // For images and all other files: Use Tauri asset URL (Zero-copy stream)
        // Use the official convertFileSrc API for correct platform-specific URL format
        // We bypass Blob generation entirely due to WebKitBlobResource error 1 on macOS
        const url = convertFileSrc(absolutePath);
        return url;
    }

    /**
     * Open an asset in the system's default application
     */
    async openAsset(path: string): Promise<void> {
        try {
            if (path.startsWith('http://') || path.startsWith('https://')) {
                console.log(`🚀 [MediaService] Opening URL in browser: ${path}`);
                await invoke('plugin:opener|open_url', { url: path });
                return;
            }

            const rootItem = useFileSystemStore.getState().root;
            if (!rootItem) return;

            const decodedPath = decodeURIComponent(path);
            let absolutePath = decodedPath;
            const { join, normalize } = await import('@tauri-apps/api/path');

            // Resolve relative paths
            if (!decodedPath.startsWith('/') && !/^[a-zA-Z]:/.test(decodedPath)) {
                absolutePath = await join(rootItem.path, decodedPath);
            }
            
            // Normalize path to fix OS compatibility (Windows backslashes vs macOS forward slashes)
            absolutePath = await normalize(absolutePath);

            console.log(`🚀 [MediaService] Opening file in default app: ${absolutePath}`);
            // Use invoke directly to avoid import issues with @tauri-apps/plugin-opener
            await invoke('plugin:opener|open_path', { path: absolutePath });
        } catch (e) {
            console.error("❌ [MediaService] Failed to open file:", path, e);
        }
    }

    /**
     * 恢复缺失的本地 asset（前端 404 时调用）
     * @returns action string: "created" | "revived" | "skipped_local_valid" | "skipped_inflight" | error
     */
    async recoverMissingAsset(assetPath: string): Promise<string> {
        return invoke<string>('transfer_recover_missing_asset', { assetPath });
    }

    /**
     * 监听 transfer:download-completed 事件
     * @returns 取消监听函数
     */
    async onTransferDownloadCompleted(
        callback: (payload: { asset_path: string; vault_id: string }) => void
    ): Promise<() => void> {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<{ asset_path: string; vault_id: string }>(
            'transfer:download-completed',
            (event) => callback(event.payload)
        );
        return unlisten;
    }

}

export const mediaService = new MediaService();
