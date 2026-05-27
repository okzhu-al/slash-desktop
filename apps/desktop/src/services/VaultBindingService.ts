/**
 * VaultBindingService — Vault 身份绑定服务（三层防御 Layer 1）
 *
 * 在 .slash/vault_binding.json 中持久化 Vault 与同步身份的绑定关系，
 * 防止跨用户/跨团队的 Vault 污染。
 *
 * v2: 支持多团队绑定（1 个 Personal Vault ↔ N 个 Team Vault）
 *
 * 三元组校验：
 *   Team 模式:     (serverUrl, userId, teamVaultId)
 *   Personal 模式: (serverUrl, userId, mode)
 */
import { readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';

// ── 类型 ──

export interface VaultBinding {
    /** 同步模式 */
    mode: 'team' | 'personal';
    /** 服务器地址（规范化后） */
    serverUrl: string;
    /** 用户 ID（Personal 模式下可能为 __personal__） */
    userId: string;
    /** 团队 Vault ID（仅 team 模式） */
    teamVaultId?: string;
    /** 团队名称（用于冲突对话框展示） */
    teamVaultName?: string;
    /** 绑定时间 */
    boundAt: string;
    /** 显示名（用于冲突对话框展示） */
    displayName?: string;
    /** 绑定的精确登录用户名（由于早期版本缺陷未保存，设定为可选） */
    username?: string;
}

/** v2 多团队绑定容器 */
export interface VaultBindings {
    version: 2;
    bindings: VaultBinding[];
}

// ── 常量 ──

const SLASH_DIR = '.slash';
const BINDING_FILE = 'vault_binding.json';

function bindingPath(vaultPath: string): string {
    return `${vaultPath}/${SLASH_DIR}/${BINDING_FILE}`;
}

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '').toLowerCase();
}

// ── 核心读写 ──

/** 读取 Vault 绑定信息（v1 自动迁移到 v2） */
export async function readVaultBindings(vaultPath: string): Promise<VaultBindings> {
    try {
        const raw = await readTextFile(bindingPath(vaultPath));
        const parsed = JSON.parse(raw);
        // v1 迁移：单对象（无 version 字段） → v2 数组
        if (!parsed.version) {
            return { version: 2, bindings: [parsed as VaultBinding] };
        }
        return parsed as VaultBindings;
    } catch {
        return { version: 2, bindings: [] };
    }
}

/** 向后兼容：读取单一绑定（取第一个匹配的 team 绑定，或第一个 personal 绑定） */
export async function readVaultBinding(vaultPath: string): Promise<VaultBinding | null> {
    const { bindings } = await readVaultBindings(vaultPath);
    return bindings[0] || null;
}

/** 写入完整的 bindings 数组 */
export async function writeVaultBindings(vaultPath: string, data: VaultBindings): Promise<void> {
    try {
        await mkdir(`${vaultPath}/${SLASH_DIR}`, { recursive: true }).catch(() => {});
        await writeTextFile(bindingPath(vaultPath), JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn('[VaultBinding] Failed to write bindings:', e);
    }
}

/** 向后兼容：写入单一绑定（覆盖写入） */
export async function writeVaultBinding(vaultPath: string, binding: VaultBinding): Promise<void> {
    const existing = await readVaultBindings(vaultPath);
    const idx = existing.bindings.findIndex(b =>
        b.mode === binding.mode &&
        normalizeUrl(b.serverUrl) === normalizeUrl(binding.serverUrl) &&
        (binding.mode === 'personal' || b.teamVaultId === binding.teamVaultId)
    );
    if (idx >= 0) {
        existing.bindings[idx] = binding;
    } else {
        existing.bindings.push(binding);
    }
    await writeVaultBindings(vaultPath, existing);
}

// ── 多团队校验 ──

/**
 * 查找与 incoming 不兼容的绑定（跨用户、跨服务器、跨模式）
 * 这些冲突应该阻止绑定，不允许追加
 */
export function findConflictingBinding(
    bindings: VaultBinding[],
    incoming: VaultBinding,
): VaultBinding | null {
    return bindings.find(b => {
        // Team 模式硬隔离：如果已有团队绑定且试图绑定另一个团队，视为冲突 (Shutdown Multi-Team)
        if (b.mode === 'team' && incoming.mode === 'team' && b.teamVaultId !== incoming.teamVaultId) {
            return true;
        }
        
        // 服务器不同 → 冲突
        if (normalizeUrl(b.serverUrl) !== normalizeUrl(incoming.serverUrl)) return true;
        // 用户不同 → 冲突
        if (b.userId !== incoming.userId) {
            return true;
        }
        return false;
    }) || null;
}

/**
 * 查找是否已绑定过该 teamVaultId
 */
export function findExistingTeamBinding(
    bindings: VaultBinding[],
    teamVaultId: string,
): VaultBinding | null {
    return bindings.find(b => b.mode === 'team' && b.teamVaultId === teamVaultId) || null;
}

/**
 * 查找同服务器上已绑定的其他团队（用于追加绑定提示）
 */
export function findOtherTeamBindings(
    bindings: VaultBinding[],
    serverUrl: string,
    excludeTeamVaultId?: string,
): VaultBinding[] {
    const norm = normalizeUrl(serverUrl);
    return bindings.filter(b =>
        b.mode === 'team' &&
        normalizeUrl(b.serverUrl) === norm &&
        b.teamVaultId !== excludeTeamVaultId
    );
}

// ── 旧版兼容（保留供外部未迁移代码使用） ──

/**
 * 判断新绑定是否与现有绑定冲突（旧版 API，向后兼容）
 */
export function isBindingConflict(existing: VaultBinding, incoming: VaultBinding): boolean {
    // 服务器不同 → 冲突
    if (normalizeUrl(existing.serverUrl) !== normalizeUrl(incoming.serverUrl)) return true;
    // 用户不同 → 冲突
    if (existing.userId !== incoming.userId) return true;
    // 模式不同 → 冲突
    if (existing.mode !== incoming.mode) return true;
    // Team 模式下单空间硬隔离：已经有了一个 team 绑定，如果 incoming 的 teamVaultId 不等于现有的，视为冲突！(V3 防御规则)
    if (existing.mode === 'team' && incoming.mode === 'team' && existing.teamVaultId !== incoming.teamVaultId) {
        return true;
    }
    return false;
}

/**
 * 生成人可读的冲突描述（用于对话框）
 */
export function describeConflict(existing: VaultBinding, incoming: VaultBinding, t?: any): string {
    const lines: string[] = [];
    
    const lblMode = t ? t('sync.conflict_mode', 'Mode:') : '模式:';
    const lblServer = t ? t('sync.conflict_server', 'Server:') : '服务器:';
    const lblUser = t ? t('sync.conflict_user', 'User:') : '用户:';
    
    if (existing.mode !== incoming.mode) {
        const modeLabel = (m: string) => {
            if (t) return m === 'team' ? t('sync.tab_team', 'Team') : t('sync.tab_personal', 'Personal');
            return m === 'team' ? '团队同步' : '个人同步';
        };
        lines.push(`${lblMode} ${modeLabel(existing.mode)} → ${modeLabel(incoming.mode)}`);
    }
    if (normalizeUrl(existing.serverUrl) !== normalizeUrl(incoming.serverUrl)) {
        lines.push(`${lblServer} ${existing.serverUrl} → ${incoming.serverUrl}`);
    }
    if (existing.userId !== incoming.userId) {
        const nameA = existing.displayName || existing.userId;
        const nameB = incoming.displayName || incoming.userId;
        lines.push(`${lblUser} ${nameA} → ${nameB}`);
    }
    return lines.join('\n');
}
