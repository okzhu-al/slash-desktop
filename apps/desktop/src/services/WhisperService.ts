/**
 * WhisperService — Whisper 语音模型管理服务
 *
 * 直接调用 sidecar HTTP API 管理 Whisper 模型的下载/切换/状态查询。
 */

import { invoke } from '@tauri-apps/api/core';

// ── 类型定义 ──

export interface WhisperModel {
    name: string;
    size_mb: number;
    description: string;
    downloaded: boolean;
    active: boolean;
    download_status: 'downloading' | 'done' | 'error' | null;
    download_progress: number;
    download_error: string | null;
}

export interface WhisperModelsResponse {
    models: WhisperModel[];
    active_model: string;
}

// ── 辅助 ──

async function getSidecarUrl(): Promise<string> {
    try {
        return await invoke<string>('get_sidecar_url');
    } catch {
        return 'http://localhost:3722';
    }
}

// ── API ──

/**
 * 获取所有可用 Whisper 模型及其状态
 */
export async function getWhisperModels(): Promise<WhisperModelsResponse> {
    const url = await getSidecarUrl();
    const resp = await fetch(`${url}/whisper/models`);
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.statusText}`);
    return resp.json();
}

/**
 * 触发后台下载指定模型
 */
export async function downloadWhisperModel(modelName: string): Promise<{ status: string; model: string }> {
    const url = await getSidecarUrl();
    const resp = await fetch(`${url}/whisper/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: modelName }),
    });
    if (!resp.ok) throw new Error(`Download request failed: ${resp.statusText}`);
    return resp.json();
}

/**
 * 切换活跃模型
 */
export async function activateWhisperModel(modelName: string): Promise<{ status: string; model: string }> {
    const url = await getSidecarUrl();
    const resp = await fetch(`${url}/whisper/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: modelName }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || resp.statusText);
    }
    return resp.json();
}
