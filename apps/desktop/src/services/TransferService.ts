/**
 * Phase 6: Transfer Service — Tauri 命令层封装
 * 
 * 前端调用 Rust TransferManager 的桥接层
 */

import { invoke } from '@tauri-apps/api/core';

export interface TransferTask {
    id: number;
    vault_id: string;
    hash: string;
    asset_path: string;
    direction: 'upload' | 'download';
    status: 'pending' | 'active' | 'paused' | 'completed' | 'failed';
    upload_id: string | null;
    total_bytes: number;
    transferred_bytes: number;
    chunk_size: number;
    retry_count: number;
    max_retries: number;
    error_message: string | null;
}

export class TransferService {
    /** 获取当前传输队列（非终态任务） */
    static async getQueue(): Promise<TransferTask[]> {
        return invoke<TransferTask[]>('transfer_get_queue');
    }

    /** 入队上传任务 */
    static async enqueueUpload(
        vaultId: string,
        hash: string,
        assetPath: string,
        totalBytes: number,
    ): Promise<number> {
        return invoke<number>('transfer_enqueue_upload', {
            vaultId, hash, assetPath, totalBytes,
        });
    }

    /** 入队下载任务 */
    static async enqueueDownload(
        vaultId: string,
        hash: string,
        assetPath: string,
        totalBytes: number,
    ): Promise<number> {
        return invoke<number>('transfer_enqueue_download', {
            vaultId, hash, assetPath, totalBytes,
        });
    }

    /** 重试失败任务 */
    static async retryTask(id: number): Promise<boolean> {
        return invoke<boolean>('transfer_retry_task', { id });
    }

    /** 清除已完成任务 */
    static async clearCompleted(): Promise<number> {
        return invoke<number>('transfer_clear_completed');
    }
}
