import { invoke } from '@tauri-apps/api/core';

export const TEAM_ASSET_MAX_SIZE_DEFAULT = 200 * 1024 * 1024; // 200MB fallback (team only)

export interface SyncCapabilities {
  max_sync_file_size: number;
}

/**
 * 获取当前缓存在客户端 Tauri 的同步能力限制
 * 直接通过 IPC 读取 Rust 侧的状态，不使用 JS 缓存以防状态不同步
 *
 * 默认值策略（与 Rust state.rs 对齐）：
 * - Rust 侧 SyncCapabilities 默认 max_sync_file_size = u64::MAX（无限制）
 * - 仅团队同步 negotiate 后，由服务端 capabilities 下发实际限额覆盖
 * - 个人空间和纯本地模式始终无限制
 * - JS fallback 使用 Number.MAX_SAFE_INTEGER 以与 u64::MAX 语义对齐
 */
export async function getMaxSyncFileSize(): Promise<number> {
  try {
    const caps = await invoke<SyncCapabilities>('get_sync_capabilities');
    return caps.max_sync_file_size;
  } catch (err) {
    console.warn('[SyncCapabilities] Failed to fetch capabilities, falling back to unlimited', err);
    return Number.MAX_SAFE_INTEGER; // 无限制（与 Rust 侧 u64::MAX 语义对齐）
  }
}

/**
 * 废弃：JS 侧不再做缓存，直接读 Tauri 状态
 */
export function invalidateCapabilitiesCache() {
  // No-op
}

/**
 * 格式化文件大小为友好的 MB/GB 字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
