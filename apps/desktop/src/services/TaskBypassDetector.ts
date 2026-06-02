/**
 * TaskBypassDetector — Checkbox 变更检测与旁路同步
 *
 * 比较文件修改前后的内容，判断是否为纯 checkbox 翻转：
 * - `- [ ]` / `* [ ]` / `+ [ ]` ↔ checked variants
 *
 * 如果变更仅包含 checkbox 翻转，则通过 taskBypass API 直接同步，
 * 绕过常规 Push/PR 流程，实现即时协同。
 */
import { syncService } from './SyncService';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileSystemStore } from '@/core/fs/store';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';
import { invoke } from '@tauri-apps/api/core';

// ============================================================
// Types
// ============================================================

export interface CheckboxChange {
    /** 0-indexed 行号 */
    lineNumber: number;
    /** 变更前该行的原始内容 */
    originalLine: string;
    /** 目标 checked 状态 */
    checked: boolean;
}

export interface BypassDetectResult {
    /** 是否为纯 checkbox 变更（可走旁路） */
    isBypassable: boolean;
    /** 检测到的 checkbox 变更列表 */
    changes: CheckboxChange[];
    /** 是否存在非 checkbox 的文本修改（混合变更） */
    hasTextChanges: boolean;
}

// ============================================================
// 检测逻辑
// ============================================================

const UNCHECKED_PATTERN = /^(\s*)[-*+]\s\[ \]\s/;
const CHECKED_PATTERN = /^(\s*)[-*+]\s\[x\]\s/i;

/**
 * 比较两个文件内容，检测是否为纯 checkbox 变更。
 */
export function detectCheckboxChanges(
    oldContent: string,
    newContent: string,
): BypassDetectResult {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const changes: CheckboxChange[] = [];
    let hasTextChanges = false;

    // 行数不同 → 有结构性变更，不是纯 checkbox
    if (oldLines.length !== newLines.length) {
        return { isBypassable: false, changes: [], hasTextChanges: true };
    }

    for (let i = 0; i < oldLines.length; i++) {
        if (oldLines[i] === newLines[i]) continue;

        // 检查是否为 checkbox 翻转
        const isCheckboxToggle = isCheckboxFlip(oldLines[i], newLines[i]);

        if (isCheckboxToggle) {
            const checked = CHECKED_PATTERN.test(newLines[i]);
            changes.push({
                lineNumber: i,
                originalLine: oldLines[i],
                checked,
            });
        } else {
            hasTextChanges = true;
        }
    }

    return {
        isBypassable: changes.length > 0 && !hasTextChanges,
        changes,
        hasTextChanges,
    };
}

/**
 * 判断两行文本是否仅为 checkbox `[ ]` ↔ `[x]` 的翻转。
 */
function isCheckboxFlip(oldLine: string, newLine: string): boolean {
    // 方向1: unchecked → checked
    if (UNCHECKED_PATTERN.test(oldLine) && CHECKED_PATTERN.test(newLine)) {
        const normalizedOld = oldLine.replace(/([-*+]\s)\[ \]/, '$1[x]');
        return normalizedOld === newLine;
    }
    // 方向2: checked → unchecked
    if (CHECKED_PATTERN.test(oldLine) && UNCHECKED_PATTERN.test(newLine)) {
        const normalizedOld = oldLine.replace(/([-*+]\s)\[x\]/i, '$1[ ]');
        return normalizedOld === newLine;
    }
    return false;
}

// ============================================================
// SHA-256 前 16 位 — 与 slash-core calculate_content_hash 对齐
// ============================================================

/**
 * 计算内容的 SHA-256 hash 前 16 hex 字符。
 * 与 Rust 端 `slash_core::calculate_content_hash` 保持一致。
 */
export async function calculateContentHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, 16);
}

function normalizeDrive(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return /^[a-zA-Z]:\//.test(normalized)
        ? normalized.charAt(0).toLowerCase() + normalized.slice(1)
        : normalized;
}

function isAbsolutePath(path: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/');
}

export function normalizeVaultRelativePath(filePath: string): string {
    if (filePath.startsWith('__team__/')) {
        return filePath.slice('__team__/'.length).replace(/^\/|^\.\//g, '');
    }

    const vaultRoot = useFileSystemStore.getState().root?.path;
    const normalizedPath = normalizeDrive(filePath);
    const normalizedVault = vaultRoot ? normalizeDrive(vaultRoot).replace(/\/$/, '') : '';

    if (normalizedVault && normalizedPath.startsWith(`${normalizedVault}/`)) {
        return normalizedPath.slice(normalizedVault.length + 1);
    }

    return normalizedPath.replace(/^\/|^\.\//g, '');
}

function extractTaskTextFromLine(line: string): string {
    return line.replace(/^\s*[-*+]\s\[[ xX]\]\s*/, '').trim();
}

export function resolveLocalReadPath(filePath: string): string | null {
    if (filePath.startsWith('__team__/')) return null;

    const vaultRoot = useFileSystemStore.getState().root?.path;
    if (isAbsolutePath(filePath)) {
        return filePath.replace(/\\/g, '/');
    }
    if (!vaultRoot) return null;

    return `${vaultRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${normalizeVaultRelativePath(filePath)}`;
}

async function resolveLocalFileId(filePath: string): Promise<string | null> {
    const parsedTeamNote = parseTeamNoteId(filePath);
    if (parsedTeamNote.fileId) {
        return parsedTeamNote.fileId;
    }

    const localPath = resolveLocalReadPath(filePath);
    const relativePath = normalizeVaultRelativePath(filePath);

    if (localPath) {
        try {
            const content = await readTextFile(localPath);
            const match = content.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
            const frontmatter = match?.[1] ?? '';
            const idMatch = frontmatter.match(/^slash_id:\s*['"]?([0-9a-fA-F-]{36})['"]?\s*$/m);
            if (idMatch?.[1]) return idMatch[1];
        } catch {
            // Fall through to the sync-state index. Pulled team files may be
            // temporarily missing frontmatter while the UUID is already known.
        }
    }

    return resolveLocalFileIdFromSyncState(relativePath);
}

async function resolveLocalFileIdFromSyncState(relativePath: string): Promise<string | null> {
    const vaultRoot = useFileSystemStore.getState().root?.path;
    if (!vaultRoot) {
        return null;
    }

    try {
        const statePath = `${vaultRoot.replace(/\\/g, '/').replace(/\/$/, '')}/.slash/unified_sync_state.json`;
        const raw = await readTextFile(statePath);
        const state = JSON.parse(raw) as Record<string, { file_id?: string | null } | undefined>;
        const normalizedTarget = normalizeDrive(relativePath).replace(/^\/|^\.\//g, '').toLowerCase();

        for (const [path, entry] of Object.entries(state)) {
            const normalizedPath = normalizeDrive(path).replace(/^\/|^\.\//g, '').toLowerCase();
            if (normalizedPath === normalizedTarget && entry?.file_id) {
                return entry.file_id;
            }
        }
    } catch {
        // Sync state is optional during first-run and migration windows.
    }

    return null;
}

async function resolveTaskBypassTarget(filePath: string): Promise<{ filePath: string; fileId: string | null }> {
    const parsedTeamNote = parseTeamNoteId(filePath);
    if (parsedTeamNote.fileId) {
        const teamVaultId = parsedTeamNote.teamVaultId || useSessionStore.getState().teamVaultId;
        if (teamVaultId) {
            try {
                const file = await syncService.getVaultFileById(teamVaultId, parsedTeamNote.fileId);
                return { filePath: file.filePath, fileId: file.fileId };
            } catch {
                return { filePath: parsedTeamNote.filePath ?? '', fileId: parsedTeamNote.fileId };
            }
        }
    }

    return {
        filePath: normalizeVaultRelativePath(filePath),
        fileId: await resolveLocalFileId(filePath),
    };
}

// ============================================================
// 执行旁路同步
// ============================================================

/**
 * 对检测到的 checkbox 变更执行旁路同步。
 *
 * @param filePath 文件相对路径
 * @param changes 检测到的 checkbox 变更
 * @returns 成功同步的变更数
 */
export async function executeTaskBypass(
    filePath: string,
    changes: CheckboxChange[],
): Promise<number> {
    const teamVaultId = useSessionStore.getState().teamVaultId;
    if (!teamVaultId) return 0;

    // 从 JWT 中提取 user_id
    const config = syncService.getConfig();
    if (!config?.accessToken) return 0;

    let userId = '';
    try {
        const parts = config.accessToken.split('.');
        if (parts.length === 3) {
            userId = JSON.parse(atob(parts[1])).sub || '';
        }
    } catch { /* ignore */ }

    let successCount = 0;
    const target = await resolveTaskBypassTarget(filePath);
    if (!target.fileId) {
        console.warn('[TaskBypass] Skipped: stable file_id is required for task checkbox sync', {
            filePath,
            resolvedPath: target.filePath,
        });
        return 0;
    }

    for (const change of changes) {
        try {
            const lineHash = await calculateContentHash(change.originalLine);
            const payload = {
                vault_id: teamVaultId,
                file_path: target.filePath,
                file_id: target.fileId,
                line_number: change.lineNumber,
                line_content_hash: lineHash,
                checked: change.checked,
                toggled_by: userId,
            };
            const result = await syncService.taskBypass({
                ...payload,
            });
            if (result.success) {
                successCount++;
                const taskText = extractTaskTextFromLine(change.originalLine);
                if (taskText) {
                    try {
                        await invoke('update_task_completion_state', {
                            notePath: target.filePath,
                            taskText,
                            isCompleted: change.checked,
                        });
                    } catch (error) {
                        console.warn('[TaskBypass] Failed to update local task cache:', error);
                    }
                }
            }
        } catch (e) {
            console.warn(`[TaskBypass] Failed for line ${change.lineNumber}:`, e);
        }
    }

    return successCount;
}
