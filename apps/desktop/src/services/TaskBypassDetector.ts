/**
 * TaskBypassDetector — Checkbox 变更检测与旁路同步
 *
 * 比较文件修改前后的内容，判断是否为纯 checkbox 翻转：
 * - `- [ ]` ↔ `- [x]`
 *
 * 如果变更仅包含 checkbox 翻转，则通过 taskBypass API 直接同步，
 * 绕过常规 Push/PR 流程，实现即时协同。
 */
import { syncService } from './SyncService';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileSystemStore } from '@/core/fs/store';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

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

const UNCHECKED_PATTERN = /^(\s*)-\s\[ \]\s/;
const CHECKED_PATTERN = /^(\s*)-\s\[x\]\s/i;

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
    // 方向1: `- [ ]` → `- [x]`
    if (UNCHECKED_PATTERN.test(oldLine) && CHECKED_PATTERN.test(newLine)) {
        const normalizedOld = oldLine.replace(/- \[ \]/, '- [x]');
        return normalizedOld === newLine;
    }
    // 方向2: `- [x]` → `- [ ]`
    if (CHECKED_PATTERN.test(oldLine) && UNCHECKED_PATTERN.test(newLine)) {
        const normalizedOld = oldLine.replace(/- \[x\]/i, '- [ ]');
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

async function resolveLocalFileId(filePath: string): Promise<string | null> {
    const parsedTeamNote = parseTeamNoteId(filePath);
    if (parsedTeamNote.fileId) return parsedTeamNote.fileId;

    const vaultRoot = useFileSystemStore.getState().root?.path;
    if (!vaultRoot) return null;

    let localPath = filePath;
    if (filePath.startsWith('__team__/')) {
        localPath = filePath.slice('__team__/'.length);
    }

    try {
        const content = await readTextFile(`${vaultRoot}/${localPath}`);
        const match = content.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
        const frontmatter = match?.[1] ?? '';
        const idMatch = frontmatter.match(/^slash_id:\s*['"]?([0-9a-fA-F-]{36})['"]?\s*$/m);
        return idMatch?.[1] ?? null;
    } catch {
        return null;
    }
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

    return { filePath, fileId: await resolveLocalFileId(filePath) };
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

    for (const change of changes) {
        try {
            const lineHash = await calculateContentHash(change.originalLine);
            const result = await syncService.taskBypass({
                vault_id: teamVaultId,
                file_path: target.filePath,
                file_id: target.fileId,
                line_number: change.lineNumber,
                line_content_hash: lineHash,
                checked: change.checked,
                toggled_by: userId,
            });
            if (result.success) successCount++;
        } catch (e) {
            console.warn(`[TaskBypass] Failed for line ${change.lineNumber}:`, e);
        }
    }

    return successCount;
}
