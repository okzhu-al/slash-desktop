/**
 * Sync 工具函数
 *
 * 提取自 SyncTab.tsx 中重复的 vault_id 持久化和 batch_update_editor 逻辑
 */
import { invoke } from '@tauri-apps/api/core';
import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { syncService } from '@/services/SyncService';

/**
 * 解析或生成 vault_id
 *
 * 优先级：磁盘文件 → localStorage → 新生成 UUID
 * 同时持久化到 .slash/sync_vault_id
 */
export async function resolveVaultId(vaultPath?: string): Promise<string> {
    let vaultId = '';

    // 1. 从磁盘文件读取
    if (vaultPath) {
        try {
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            vaultId = (await readTextFile(`${vaultPath}/.slash/sync_vault_id`)).trim();
        } catch { /* 文件不存在 */ }
    }

    // 2. 从 localStorage 读取
    if (!vaultId) {
        const savedConn = syncService.getSavedConnection();
        vaultId = savedConn?.vaultId || crypto.randomUUID();
    }

    // 3. 持久化到磁盘
    if (vaultPath) {
        try {
            const slashDir = `${vaultPath}/.slash`;
            if (!(await exists(slashDir))) {
                await mkdir(slashDir, { recursive: true });
            }
            await writeTextFile(`${slashDir}/sync_vault_id`, vaultId);
        } catch (e) {
            console.warn('[SyncUtils] failed to persist vault_id:', e);
        }
    }

    return vaultId;
}

/**
 * 批量更新 vault 内笔记的 editor 字段
 */
export async function batchUpdateEditorName(
    vaultPath: string,
    displayName: string,
    oldDisplayName: string | null | undefined,
): Promise<void> {
    try {
        await invoke('batch_update_editor', {
            vaultPath,
            newName: displayName,
            oldName: oldDisplayName || null,
            editingPath: null,
        });
    } catch (e) {
        console.warn('[SyncUtils] batch_update_editor failed:', e);
    }
}
