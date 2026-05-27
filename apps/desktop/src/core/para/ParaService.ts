import { invoke } from '@tauri-apps/api/core';

/**
 * PARA Method folders that will be created:
 * - 00_Inbox: Quick capture, unsorted items
 * - 01_Projects: Active projects with deadlines
 * - 02_Areas: Ongoing responsibilities
 * - 03_Resources: Reference materials
 * - 04_Archives: Completed or inactive items
 * - assets: Media files (images, videos, etc.)
 */

/**
 * Ensures the PARA directory structure exists in the vault.
 * Creates folders if they don't exist, does NOT overwrite existing content.
 * @param vaultPath The path to the vault
 * @returns Array of folder names that were created (empty if all existed)
 */
export async function ensureParaStructure(vaultPath: string): Promise<string[]> {
    try {
        const createdFolders = await invoke<string[]>('ensure_para_structure', {
            vaultPath
        });

        if (createdFolders.length > 0) {
            console.log('📁 [PARA] Created folders:', createdFolders);
        } else {

        }

        return createdFolders;
    } catch (error) {
        console.error('❌ [PARA] Failed to ensure structure:', error);
        throw error;
    }
}
