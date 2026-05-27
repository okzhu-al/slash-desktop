/**
 * DrawingService - Platform-agnostic drawing storage service
 * 
 * Provides save/load/delete operations for Tldraw drawings.
 * Storage backend is injected by the host application (Desktop/Mobile).
 */

import type { DrawingStorageService } from '../../EditorDI';

export interface DrawingSaveData {
    png: Blob;
    json: string;
    width: number;
    height: number;
}

export interface DrawingSaveResult {
    pngPath: string;
    jsonPath: string;
}

export class DrawingService {
    /**
     * Injected storage backend — replaces direct Tauri invoke calls
     */
    public storageBackend?: DrawingStorageService;

    /**
     * Injected function to resolve asset URLs using the host application's MediaService.
     * This avoids tightly coupling the editor-core to the desktop app's MediaService.
     */
    public resolveAssetUrlFallback?: (path: string, vaultPath: string) => Promise<string>;

    /**
     * Save a drawing (PNG + JSON) to the assets folder
     * 
     * @param data - Drawing data from Tldraw export
     * @returns Paths to saved files
     */
    async saveDrawing(
        data: DrawingSaveData,
        vaultPath: string,
        existingPngPath?: string,
        existingJsonPath?: string,
    ): Promise<DrawingSaveResult> {
        if (!this.storageBackend) {
            throw new Error('[DrawingService] storageBackend is not injected!');
        }

        // Convert Blob to ArrayBuffer then to Uint8Array for transfer
        const arrayBuffer = await data.png.arrayBuffer();
        const pngData = Array.from(new Uint8Array(arrayBuffer));

        const result = await this.storageBackend.saveDrawing(
            vaultPath,
            pngData,
            data.json,
            existingPngPath || null,
            existingJsonPath || null,
        );

        console.log('[DrawingService] Saved:', result);

        return {
            pngPath: result.png_path,
            jsonPath: result.json_path,
        };
    }

    /**
     * Load a drawing's JSON state from file
     * 
     * @param jsonPath - Relative path to JSON file (e.g., "assets/drawing.tldr")
     * @returns JSON string content
     */
    async loadDrawingJson(jsonPath: string, vaultPath: string): Promise<string> {
        if (!this.storageBackend) {
            throw new Error('[DrawingService] storageBackend is not injected!');
        }

        return await this.storageBackend.loadDrawingJson(vaultPath, jsonPath);
    }

    /**
     * Delete a drawing's files
     * 
     * @param pngPath - Relative path to PNG file
     * @param jsonPath - Relative path to JSON file
     */
    async deleteDrawing(vaultPath: string, pngPath?: string, jsonPath?: string): Promise<void> {
        if (!this.storageBackend) {
            throw new Error('[DrawingService] storageBackend is not injected!');
        }

        await this.storageBackend.deleteDrawing(
            vaultPath,
            pngPath || null,
            jsonPath || null,
        );

        console.log('[DrawingService] Deleted:', { pngPath, jsonPath });
    }

    /**
     * Resolve a relative asset path to absolute URL for display
     * We proxy this through the injected resolveAssetUrlFallback method if available.
     * 
     * @param relativePath - Relative path (e.g., "assets/drawing.png")
     * @returns Absolute file URL
     */
    async getAssetUrl(path: string, vaultPath: string): Promise<string> {
        if (this.resolveAssetUrlFallback) {
            return this.resolveAssetUrlFallback(path, vaultPath);
        }
        console.error('[DrawingService] resolveAssetUrlFallback is not injected! Falling back to raw path.');
        return path;
    }
}

// Singleton instance
export const drawingService = new DrawingService();

