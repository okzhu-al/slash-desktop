/**
 * useSyncFlow — SyncTab 的状态管理 Hook
 *
 * 将所有 state 和 handler 从 SyncTab.tsx 提取到此 Hook 中，
 * SyncTab.tsx 仅负责布局和路由到对应 Step 组件。
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { syncService, SyncStatusType } from '@/services/SyncService';
import { autoSyncManager } from '@/services/AutoSyncManager';
import { teamService } from '@/services/TeamService';
import { resolveVaultId, batchUpdateEditorName } from './syncUtils';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useSessionStore } from '@/stores/useSessionStore';
import {
    readVaultBindings, writeVaultBinding,
    findConflictingBinding, findExistingTeamBinding,
    describeConflict,
    type VaultBinding,
} from '@/services/VaultBindingService';

// ── 类型导出 ──

export interface VaultInfo {
    id: string;
    name: string;
    space_type: string;
    file_count: number;
    created_at: string;
}

export type SyncFlowStep =
    | 'welcome'
    | 'pair_input'
    | 'choose_mode'
    | 'setup_pin'
    | 'create_team'
    | 'join_team'
    | 'reconnect_personal'
    | 'reconnect_team'
    | 'connected_personal'
    | 'connected_team'
    | 'reset_admin';

export interface ServerInfo {
    has_team: boolean;
    team_name: string | null;
    team_vault_id: string | null;
    has_pin: boolean;
    teams?: { id: string; name: string }[];
}

// ── 初始状态 ──

function getInitialStep(): SyncFlowStep {
    if (syncService.isConfigured()) {
        const userType = useSessionStore.getState().userType;
        return userType === 'team' ? 'connected_team' : 'connected_personal';
    }
    return 'welcome';
}

// ── Hook ──

export function useSyncFlow(vaultPath?: string, onBlockClose?: (blocked: boolean) => void) {
    const { t } = useTranslation();

    // ── 状态机 ──
    const [step, setStep] = useState<SyncFlowStep>(getInitialStep);

    // ── 配对连接 ──
    const [serverUrl, setServerUrl] = useState(() => {
        const config = syncService.getConfig();
        if (config) return config.serverUrl;
        const saved = syncService.getSavedConnection();
        return saved?.serverUrl || '';
    });
    const [accessCode, setAccessCode] = useState(() => {
        const config = syncService.getConfig();
        if (config) return config.accessCode || '';
        const saved = syncService.getSavedConnection();
        return saved?.accessCode || '';
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [codeResetMode, setCodeResetMode] = useState(false);
    const [pinResetMode, setPinResetMode] = useState(false);
    const [adminResetMode, setAdminResetMode] = useState(false);
    const [postLoginRedirect, setPostLoginRedirect] = useState<SyncFlowStep | null>(null);

    const isConnected = step === 'connected_personal' || step === 'connected_team';

    // ── 🛡️ Layer 2: Vault 身份绑定三元组校验 ──

    /** 直接从 serverUrl 获取 teams 列表，不依赖 serverInfo state */
    const fetchTeamVaultId = async (url: string): Promise<string | undefined> => {
        try {
            const resp = await fetch(`${url.replace(/\/+$/, '')}/api/server/info`);
            if (resp.ok) {
                const info = await resp.json();
                return info.team_vault_id || undefined;
            }
        } catch { /* ignore */ }
        return undefined;
    };

    /** 从 serverUrl 获取团队名称 */
    const fetchTeamName = async (url: string, teamVaultId: string): Promise<string> => {
        try {
            const resp = await fetch(`${url.replace(/\/+$/, '')}/api/server/info`);
            if (resp.ok) {
                const info = await resp.json();
                const team = (info.teams || []).find((t: { id: string }) => t.id === teamVaultId);
                if (team) return team.name;
                // 向后兼容：旧服务器没有 teams 数组
                if (info.team_name) return info.team_name;
            }
        } catch { /* ignore */ }
        return t('sync.unknown_team');
    };

    /**
     * 校验当前 Vault 的身份绑定（v2 多团队支持）。
     * - 已绑定同团队 → 更新时间戳，直接通过
     * - 跨用户 / 跨服务器 → 阻止（弹出冲突对话框）
     * - 同服务器其他团队 → 弹出追加绑定确认
     * - 全新绑定 → 直接写入
     * 返回 true = 可继续，false = 已拦截。
     */
    const verifyVaultBinding = async (
        mode: 'team' | 'personal',
        connServerUrl: string,
        connUserId: string,
        connTeamVaultId?: string,
        connDisplayName?: string,
        connTeamVaultName?: string,
        connUsername?: string
    ): Promise<boolean> => {
        if (!vaultPath) return true;

        const incoming: VaultBinding = {
            mode,
            serverUrl: connServerUrl.replace(/\/+$/, ''),
            userId: connUserId,
            teamVaultId: connTeamVaultId,
            teamVaultName: connTeamVaultName,
            boundAt: new Date().toISOString(),
            displayName: connDisplayName,
            username: connUsername,
        };

        const { bindings } = await readVaultBindings(vaultPath);

        // 空绑定 → 直接写入
        if (bindings.length === 0) {
            await writeVaultBinding(vaultPath, incoming);
            return true;
        }

        // Team 模式：检查是否已绑定同一个 teamVaultId
        if (mode === 'team' && connTeamVaultId) {
            const existingTeam = findExistingTeamBinding(bindings, connTeamVaultId);
            if (existingTeam) {
                // 已绑定，更新时间戳，升级显示名和团队名称（如果之前缺失）
                incoming.teamVaultName = incoming.teamVaultName || existingTeam.teamVaultName;
                incoming.displayName = incoming.displayName || existingTeam.displayName;
                incoming.username = incoming.username || existingTeam.username;
                await writeVaultBinding(vaultPath, incoming);
                return true;
            }
        }

        const hasTeamBinding = bindings.some(b => b.mode === 'team');

        // 跨用户 / 跨服务器冲突检查
        const conflict = findConflictingBinding(bindings, incoming);
        
        if (conflict) {
            // 特殊放行规则：如果当前是“由个人空间升级为团队空间”且本地还从未绑定过任何团队，则直接放行，无需弹窗
            const isPersonalToTeamUpgrade = mode === 'team' && !hasTeamBinding;
            
            if (isPersonalToTeamUpgrade) {
                // 放行：不提示冲突，直接执行后续写入逻辑
            } else {
                // 真正的身份冲突（如 Team A -> Team B，或跨服务器/跨用户重叠）
                const detail = describeConflict(conflict, incoming, t);
                const shouldSwitch = await confirm(
                    t('sync.vault_conflict_body', { detail }),
                    { title: t('sync.vault_conflict_title'), kind: 'warning' }
                );
                if (shouldSwitch) {
                    window.dispatchEvent(new CustomEvent('vault:force-close'));
                }
                return false;
            }
        }

        // 彻底关停 1 账户多团队逻辑：如果本地已有了团队绑定，不再允许静默追加或提示追加
        if (mode === 'team' && hasTeamBinding) {
            // 注意：同 teamVaultId 的更新已在上方 handle，能走到这里的说明是 Team A -> Team B
            const detail = t('sync.vault_multi_team_forbidden', '此仓库已绑定到一个团队空间，无法同时绑定多个团队。');
            setError(detail);
            return false;
        }

        // 无冲突，写入（追加或更新）
        // 同时写入 teamVaultName 以便后续展示
        if (mode === 'team' && connTeamVaultId) {
            incoming.teamVaultName = await fetchTeamName(connServerUrl, connTeamVaultId);
        }
        await writeVaultBinding(vaultPath, incoming);
        return true;
    };

    // PIN 设置
    const [, setShowSetPin] = useState(false);
    const [newPin, setNewPin] = useState('');
    const [pinSet, setPinSet] = useState(false);
    const [syncStatus, setSyncStatus] = useState<SyncStatusType>('idle');
    const [syncResult, setSyncResult] = useState('');

    // 服务器信息
    const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
    const [pairCodeMessage, setPairCodeMessage] = useState<{msg: string, isError: boolean} | null>(null);

    // 团队认证
    const [username, setUsername] = useState('');
    const setSafeUsername = useCallback((value: string) => {
        setUsername(value.replace(/[^A-Za-z0-9_.-]/g, ''));
    }, []);
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [teamName, setTeamName] = useState('');
    const [selectedTeamId, setSelectedTeamId] = useState('');
    const [rememberMe, setRememberMe] = useState(() => {
        return localStorage.getItem('slash_remember_me') !== 'false';
    });

    // 云端信息
    const [personalVault, setPersonalVault] = useState<VaultInfo | null>(null);
    const [teamVault, setTeamVault] = useState<VaultInfo | null>(null);

    const localVaultName = vaultPath?.split('/').pop() || '';
    const lastSyncTime = syncService.getLastSyncTime();

    // ── 连接后刷新云端信息 ──
    const refreshCloudInfo = useCallback(async () => {
        const config = syncService.getConfig();
        if (!config) return;

        try {
            const resp = await fetch(`${config.serverUrl}/api/sync/vaults`, {
                headers: { 'Authorization': `Bearer ${config.accessToken}` },
            });
            if (!resp.ok) return;

            const vaults: VaultInfo[] = await resp.json();
            const personal = vaults.find(v => v.space_type !== 'team');
            
            // Fix: read bound team from vault bindings so we don't blindly pick the first team returned
            const activeTeamVaultId = useSessionStore.getState().teamVaultId;
            let targetTeamVaultId: string | undefined = activeTeamVaultId || undefined;
            if (!targetTeamVaultId && vaultPath) {
                const { bindings } = await readVaultBindings(vaultPath);
                const normServer = config.serverUrl.replace(/\/+$/, '').toLowerCase();
                const tb = bindings.find(b => b.mode === 'team' && b.serverUrl.replace(/\/+$/, '').toLowerCase() === normServer);
                if (tb) {
                    targetTeamVaultId = tb.teamVaultId;
                }
            }
            const team = targetTeamVaultId 
                ? vaults.find(v => v.id === targetTeamVaultId) 
                : vaults.find(v => v.space_type === 'team');

            setPersonalVault(personal || null);
            setTeamVault(team || null);

            if (team) {
                useSessionStore.getState().setTeamInfo({ teamVaultId: team.id, teamVaultName: team.name });
                // 确保本地 team_sync_state.json 存在（被邀成员首次同步必需）
                const vaultRoot = localStorage.getItem('slash_vault_path');
                if (vaultRoot && team.id) {
                    invoke('ensure_team_sync_state', { 
                        vaultPath: vaultRoot, 
                        teamVaultId: team.id 
                    }).catch(e => console.warn('[SyncFlow] ensure_team_sync_state failed:', e));
                }
                // 获取当前用户角色
                try {
                    const membersResp = await teamService.listMembers(config.serverUrl, config.accessToken, team.id);
                    const userId = useSessionStore.getState().userId;
                    const me = membersResp.members.find(m => m.user_id === userId);
                    if (me) {
                        useSessionStore.getState().setTeamInfo({
                            teamVaultId: team.id,
                            teamRole: me.global_role.toLowerCase(),
                        });
                        // 确保本地 team_sync_state.json 存在（被邀成员首次同步必需）
                        const vaultRoot = localStorage.getItem('slash_vault_path');
                        if (vaultRoot && team.id) {
                            invoke('ensure_team_sync_state', { 
                                vaultPath: vaultRoot, 
                                teamVaultId: team.id 
                            }).catch(e => console.warn('[SyncFlow] ensure_team_sync_state failed:', e));
                        }
                    }
                } catch (e) {
                    console.warn('[SyncTab] Failed to fetch team role:', e);
                }
        }
    } catch (e) {
        console.warn('[SyncTab] refreshCloudInfo failed:', e);
    }
    }, []);

    const fetchServerInfo = useCallback(async () => {
        const targetUrl = serverUrl || syncService.getConfig()?.serverUrl;
        if (!targetUrl) return;
        try {
            const baseUrl = targetUrl.replace(new RegExp('/+$'), '');
            const resp = await fetch(`${baseUrl}/api/server/info`);
            if (resp.ok) {
                const info = await resp.json();
                setServerInfo(info);
            }
        } catch (e) {
            console.warn('[SyncTab] fetchServerInfo failed:', e);
        }
    }, [serverUrl]); // Dependency on serverUrl to ensure latest

    // Auto-fetch server info when serverUrl is available, even before connection is established
    useEffect(() => {
        if (serverUrl) {
            fetchServerInfo();
        }
    }, [serverUrl, fetchServerInfo]);

    // Auto-fill username when landing on welcome
    useEffect(() => {
        if (step === 'welcome') {
            // Deprecation: we no longer use global slash_remember_me_username, rely purely on vault binding
        }
    }, [step]);

    // Fetch password from keychain when serverUrl/username combo matches
    useEffect(() => {
        const u = username.trim();
        const s = serverUrl.replace(/\/+$/, '');
        
        // Don't auto-fill if missing fields or already connected. If not remembering, also don't attempt autofill mapping.
        if (!u || !s || !rememberMe || isConnected) return;

        let active = true;
        invoke<string>('get_login_credential', { serverUrl: s, username: u })
            .then(pwd => {
                // If we got a password and haven't unmounted/changed inputs, set it using functional update to avoid overwriting typed chars
                if (active && pwd) {
                    setPassword(prev => prev ? prev : pwd);
                }
            })
            .catch(() => {
                // No saved password found, ignore silently
            });

        return () => { active = false; };
    }, [serverUrl, username, rememberMe, isConnected]); // DO NOT include password in dependencies to avoid blocking deletion

    // 阻止关闭：仅个人空间用户需要设 PIN
    useEffect(() => {
        const userType = useSessionStore.getState().userType;
        const shouldBlock = isConnected && userType === 'personal' && serverInfo !== null && !serverInfo.has_pin && !pinSet;
        onBlockClose?.(shouldBlock);
    }, [isConnected, serverInfo, pinSet, onBlockClose]);

    // 连接后自动刷新
    useEffect(() => {
        if (isConnected) {
            refreshCloudInfo();
            fetchServerInfo();
        }
    }, [isConnected, refreshCloudInfo, fetchServerInfo]);

    // 同步完成事件监听
    useEffect(() => {
        const handler = () => refreshCloudInfo();
        window.addEventListener('sync:completed', handler);
        return () => window.removeEventListener('sync:completed', handler);
    }, [refreshCloudInfo]);

    // 监听全局 Auth 过期事件、配置变动事件以及物理断联事件，实现 0ms 瞬间退登与离线自愈
    useEffect(() => {
        const handleAuthReset = () => {
            setStep('welcome');
            setError('');
            setAccessCode('');
            setPassword('');
        };
        
        const handleConfigChanged = () => {
            if (!syncService.isConfigured()) {
                handleAuthReset();
            }
        };

        const handlePhysicalDisconnected = () => {
            if (syncService.isConfigured()) {
                setStep('welcome');
                setError(t('sync.physical_disconnected', '网络或服务暂不可用，恢复后会自动重试'));
            }
        };

        // 挂载时如果检测到已经是离线或错误状态，直接置为 welcome 并注入物理断开提示
        if (syncService.isConfigured()) {
            const status = autoSyncManager.getStatus();
            if (status === 'offline' || !navigator.onLine) {
                setStep('welcome');
                setError(t('sync.physical_disconnected', '网络或服务暂不可用，恢复后会自动重试'));
            }
        }

        window.addEventListener('sync:auth-expired', handleAuthReset);
        window.addEventListener('sync:config-changed', handleConfigChanged);
        window.addEventListener('sync:physical-disconnected', handlePhysicalDisconnected);
        return () => {
            window.removeEventListener('sync:auth-expired', handleAuthReset);
            window.removeEventListener('sync:config-changed', handleConfigChanged);
            window.removeEventListener('sync:physical-disconnected', handlePhysicalDisconnected);
        };
    }, [t]);

    // ── 配对连接 ──
    // ── 配对连接（开荒：使用配对码） ──
    const handlePair = async () => {
        if (!serverUrl.trim() || !accessCode.trim()) {
            setError(t('sync.fill_server_and_code'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            const baseUrl = serverUrl.replace(/\/+$/, '');

            // 开荒模式下强制发送 access_code
            const resp = await fetch(`${baseUrl}/api/auth/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_code: accessCode.trim() }),
            });

            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.pair_code_error');
                try {
                    const err = JSON.parse(body);
                    if (err.error?.includes('already used')) msg = t('sync.pair_code_used');
                    else if (err.error) msg = err.error;
                } catch { /* ignore */ }
                throw new Error(msg);
            }

            const data = await resp.json();
            const token = data.access_token;
            const refreshToken = data.refresh_token;
            const vaultId = await resolveVaultId(vaultPath);
            const userIdToken = data.user?.id || '__personal__';

            if (token && refreshToken) {
                await invoke('secure_store_tokens', {
                    serverUrl: baseUrl, userId: userIdToken, accessToken: token, refreshToken: refreshToken
                }).catch(e => console.warn('[SyncTab] Failed to securely store pair token:', e));
            }

            if (userIdToken) {
                useSessionStore.getState().setUserInfo({ userId: userIdToken });
            }

            // 保存配置（遵循零持久化：不存 PIN）
            syncService.saveConfig({ serverUrl: baseUrl, accessToken: token, vaultId, userId: userIdToken });
            setAccessCode('');
            setSyncResult('');
            setError('');

            if (adminResetMode) {
                setAdminResetMode(false);
                setStep('reset_admin');
            } else {
                if (!await verifyVaultBinding('personal', baseUrl, userIdToken)) return;
                useSessionStore.getState().setUserInfo({ userType: 'personal' });
                // 开荒配对成功后，必须要引导去设置/确认 PIN 码
                setStep('setup_pin');
                if (vaultPath) autoSyncManager.start(vaultPath).then(() => refreshCloudInfo());
            }

            if (!data.has_pin) {
                setShowSetPin(true);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.pair_failed'));
        } finally {
            setLoading(false);
        }
    };

    // ── 个人连接（登录：使用 PIN） ──
    const handleConnectPersonal = async () => {
        if (!serverUrl.trim() || !accessCode.trim()) {
            setError(t('sync.enter_pin'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            const baseUrl = serverUrl.replace(/\/+$/, '');

            // 连接登录模式下强制发送 pin
            const resp = await fetch(`${baseUrl}/api/auth/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: accessCode.trim() }),
            });

            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.pin_error'); 
                try {
                    const err = JSON.parse(body);
                    if (err.error === 'Invalid PIN' || err.error === 'Invalid access code') msg = t('sync.pin_error');
                    else if (err.error) msg = err.error;
                } catch { /* ignore */ }
                throw new Error(msg);
            }

            const data = await resp.json();
            const token = data.access_token;
            const refreshToken = data.refresh_token;
            const vaultId = await resolveVaultId(vaultPath);
            const userIdToken = data.user?.id || '__personal__';

            if (token && refreshToken) {
                await invoke('secure_store_tokens', {
                    serverUrl: baseUrl, userId: userIdToken, accessToken: token, refreshToken: refreshToken
                }).catch(e => console.warn('[SyncTab] Failed to securely store login token:', e));
            }

            if (userIdToken) {
                useSessionStore.getState().setUserInfo({ userId: userIdToken });
            }

            // 保存配置（遵循零持久化：不存 PIN）
            syncService.saveConfig({ serverUrl: baseUrl, accessToken: token, vaultId, userId: userIdToken });
            setAccessCode('');
            setSyncResult('');
            setError('');

            if (!await verifyVaultBinding('personal', baseUrl, userIdToken)) return;
            useSessionStore.getState().setUserInfo({ userType: 'personal' });
            
            if (postLoginRedirect) {
                setStep(postLoginRedirect);
                setPostLoginRedirect(null);
            } else {
                setStep('connected_personal');
            }
            
            if (vaultPath) autoSyncManager.start(vaultPath).then(() => refreshCloudInfo());
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.login_failed'));
        } finally {
            setLoading(false);
        }
    };

    // ── 设置 PIN ──
    const handleSetPin = async () => {
        const pin = newPin.trim();
        if (pin.length < 4 || pin.length > 8) {
            setError(t('sync.pin_length_error'));
            return;
        }

        const config = syncService.getConfig();
        if (!config) return;

        try {
            const resp = await fetch(`${config.serverUrl}/api/server/pin`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.accessToken}`,
                },
                body: JSON.stringify({ pin }),
            });

            if (!resp.ok) {
                const body = await resp.text();
                throw new Error(body || t('sync.set_pin_failed'));
            }

            setPinSet(true);
            setPinResetMode(false);
            setShowSetPin(false);
            setNewPin('');
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.set_pin_failed'));
        }
    };

    // ── 登录（用户名+密码）──
    const handleLogin = async () => {
        if (!username.trim() || !password.trim()) {
            setError(t('sync.login_fill_fields'));
            return;
        }
        const targetUrl = serverUrl.replace(/\/+$/, '');
        if (!targetUrl) { setError(t('sync.login_fill_server')); return; }

        setLoading(true);
        setError('');
        try {
            const resp = await fetch(`${targetUrl}/api/auth/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim(), password: password.trim() }),
            });
            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.login_failed');
                try {
                    const err = JSON.parse(body);
                    if (err.error) msg = err.error;
                } catch { msg = body || msg; }
                if (msg.toLowerCase().includes('invalid username or password') || msg.toLowerCase().includes('unauthorized')) {
                    msg = t('sync.login_invalid_credentials');
                } else if (
                    msg.toLowerCase().includes('not a member') || 
                    msg.toLowerCase().includes('not a team member') || 
                    msg.toLowerCase().includes('forbidden') || 
                    msg.toLowerCase().includes('403')
                ) {
                    msg = t('sync.not_member_error', '您已被管理员移出团队，或不是该团队成员');
                }
                throw new Error(msg);
            }
            const data = await resp.json();
            const newUserId = data.user?.id || '';
            const refreshToken = data.refresh_token;

            // 🛡️ Layer 1.5: 团队权限先验验证，物理杜绝短暂登录假连接闪烁
            const actualTeamVaultId = selectedTeamId || await fetchTeamVaultId(targetUrl);
            const cloudVaultsResp = await fetch(`${targetUrl}/api/sync/vaults`, {
                headers: { 'Authorization': `Bearer ${data.access_token}` },
            });
            if (!cloudVaultsResp.ok) {
                if (cloudVaultsResp.status === 403 || cloudVaultsResp.status === 401) {
                    throw new Error(t('sync.not_member_error', '您已被管理员移出团队，或不是该团队成员'));
                }
                const body = await cloudVaultsResp.text();
                throw new Error(body || t('sync.login_failed'));
            }
            const cloudVaults: VaultInfo[] = await cloudVaultsResp.json();
            
            if (actualTeamVaultId && !cloudVaults.some(v => v.id === actualTeamVaultId)) {
                throw new Error(t('sync.not_member_error', '您已被管理员移出团队，或不是该团队成员'));
            }
            
            if (data.access_token && refreshToken) {
                await invoke('secure_store_tokens', {
                    serverUrl: targetUrl,
                    userId: newUserId,
                    accessToken: data.access_token,
                    refreshToken: refreshToken
                }).catch(e => console.warn('[SyncTab] Failed to securely store login tokens:', e));
            }

            if (rememberMe) {
                localStorage.setItem('slash_remember_me', 'true');
                await invoke('save_login_credential', {
                    serverUrl: targetUrl,
                    username: username.trim(),
                    password: password.trim()
                }).catch(e => console.warn('[SyncTab] Failed to securely save password:', e));
            } else {
                localStorage.setItem('slash_remember_me', 'false');
                await invoke('delete_login_credential', {
                    serverUrl: targetUrl,
                    username: username.trim()
                }).catch(e => console.warn('[SyncTab] Failed to securely clear password:', e));
            }
            
            const oldDisplayName = useSessionStore.getState().displayName || '';
            const newDisplayName = data.user?.display_name || username.trim();
            useSessionStore.getState().setUserInfo({ userId: newUserId || undefined, displayName: newDisplayName });

            if (vaultPath && newDisplayName) {
                batchUpdateEditorName(vaultPath, newDisplayName, oldDisplayName);
            }

            // 🛡️ Layer 2: Vault 身份绑定校验
            const actualTeamVaultName = actualTeamVaultId ? await fetchTeamName(targetUrl, actualTeamVaultId) : undefined;
            if (!await verifyVaultBinding('team', targetUrl, newUserId, actualTeamVaultId, newDisplayName, actualTeamVaultName, username.trim())) return;
            
            if (actualTeamVaultId) {
                useSessionStore.getState().setTeamInfo({ teamVaultId: actualTeamVaultId });
                // 确保本地 team_sync_state.json 存在（被邀成员首次同步必需）
                const vaultRoot = localStorage.getItem('slash_vault_path');
                if (vaultRoot && actualTeamVaultId) {
                    invoke('ensure_team_sync_state', { 
                        vaultPath: vaultRoot, 
                        teamVaultId: actualTeamVaultId 
                    }).catch(e => console.warn('[SyncFlow] ensure_team_sync_state failed:', e));
                }
            }

            const vaultId = await resolveVaultId(vaultPath);
            syncService.saveConfig({ serverUrl: targetUrl, accessToken: data.access_token, vaultId, userId: newUserId || '__personal__' });
            useSessionStore.getState().setUserInfo({ userType: 'team' });
            setStep('connected_team');
            setUsername(''); setPassword('');

            if (vaultPath) {
                autoSyncManager.start(vaultPath).then(() => refreshCloudInfo()).catch(console.error);
            }
            await refreshCloudInfo();
            await fetchServerInfo();
        } catch (err) {
            if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
                // 网络不可达
                setError(t('sync.server_unreachable'));
            } else {
                setError(err instanceof Error ? err.message : t('sync.login_failed'));
            }
        } finally {
            setLoading(false);
        }
    };

    // ── 加入团队 ──
    const handleTeamJoin = async () => {
        if (!inviteCode.trim() || !username.trim() || !password.trim() || !displayName.trim()) {
            setError(t('sync.join_fill_fields'));
            return;
        }
        if (password !== passwordConfirm) {
            setError(t('sync.password_mismatch'));
            return;
        }

        const targetUrl = syncService.getConfig()?.serverUrl || serverUrl.replace(/\/+$/, '');
        if (!targetUrl) { setError(t('sync.login_fill_server')); return; }

        setLoading(true);
        setError('');

        try {
            let oldUserId = '';
            const oldConfig = syncService.getConfig();
            if (oldConfig?.accessToken) {
                try {
                    const parts = oldConfig.accessToken.split('.');
                    if (parts.length === 3) {
                        oldUserId = JSON.parse(atob(parts[1])).sub || '';
                    }
                } catch { /* ignore */ }
            }

            const reqBody: any = {
                username: username.trim(),
                password: password.trim(),
                invite_code: inviteCode.trim(),
                display_name: displayName.trim(),
            };
            if (selectedTeamId) {
                reqBody.vault_id = selectedTeamId;
            }

            const resp = await fetch(`${targetUrl}/api/auth/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody),
            });

            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.join_failed');
                try {
                    const err = JSON.parse(body);
                    if (err.error) msg = err.error;
                } catch { msg = body || msg; }
                throw new Error(msg);
            }

            const data = await resp.json();
            const newUserId = data.user?.id || '';
            const refreshToken = data.refresh_token;

            if (data.access_token && refreshToken) {
                await invoke('secure_store_tokens', {
                    serverUrl: targetUrl,
                    userId: newUserId,
                    accessToken: data.access_token,
                    refreshToken: refreshToken
                }).catch(e => console.warn('[SyncTab] Failed to securely store join tokens:', e));
            }

            // 无论如何都在加入时默认保存凭证库（按用户策略）
            localStorage.setItem('slash_remember_me', 'true');
            setRememberMe(true);
            await invoke('save_login_credential', {
                serverUrl: targetUrl,
                username: username.trim(),
                password: password.trim()
            }).catch(e => console.warn('[SyncTab] Failed to securely save password:', e));

            const oldDisplayName = useSessionStore.getState().displayName || '';
            const joinDisplayName = displayName.trim() || username.trim();
            useSessionStore.getState().setUserInfo({ userId: newUserId || undefined, displayName: joinDisplayName });

            if (vaultPath && joinDisplayName) {
                batchUpdateEditorName(vaultPath, joinDisplayName, oldDisplayName);
            }

            // 🛡️ Layer 2: Vault 身份绑定校验
            const actualTeamVaultId = selectedTeamId || await fetchTeamVaultId(targetUrl);
            const actualTeamVaultName = actualTeamVaultId ? await fetchTeamName(targetUrl, actualTeamVaultId) : undefined;
            if (!await verifyVaultBinding('team', targetUrl, newUserId, actualTeamVaultId, joinDisplayName, actualTeamVaultName, username.trim())) return;
            const vaultId = await resolveVaultId(vaultPath);
            syncService.saveConfig({ serverUrl: targetUrl, accessToken: data.access_token, vaultId, userId: newUserId || '__personal__' });
            useSessionStore.getState().setUserInfo({ userType: 'team' });
            setStep('connected_team');

            setInviteCode(''); setUsername(''); setDisplayName('');
            setPassword(''); setPasswordConfirm('');

            if (vaultPath) {
                autoSyncManager.start(vaultPath).then(() => refreshCloudInfo()).catch(console.error);
            }

            await refreshCloudInfo();
            await fetchServerInfo();

            if (oldUserId && newUserId && oldUserId !== newUserId && vaultId) {
                try {
                    const result = await teamService.migrateIdentity(targetUrl, data.access_token, oldUserId, vaultId);
                    console.log('[SyncTab] Identity migration:', result);
                } catch (e) {
                    console.warn('[SyncTab] Identity migration failed (non-critical):', e);
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.join_failed'));
        } finally {
            setLoading(false);
        }
    };

    // ── 断开连接 ──
    const handleDisconnect = async () => {
        // Attempt secure logout (deletes Keyring and backend session)
        const config = syncService.getConfig();
        const serverUrlStr = config?.serverUrl || serverUrl.replace(/\/+$/, '');
        const userIdStr = useSessionStore.getState().userId || '';
        invoke('secure_logout', { serverUrl: serverUrlStr, userId: userIdStr }).catch(console.warn);

        // 🛡️ Layer 3: 断开后引导关闭 Vault（confirm 必须在 state reset 之前，
        // 否则 UI 会先跳到 welcome 状态，用户还没确认就看到已登出的界面）
        const shouldClose = await confirm(
            t('sync.disconnect_close_body'),
            { title: t('sync.disconnect_close_title'), kind: 'info' }
        );

        // 🛡️ FIX BUG-A06: 完整清空会话，防止 Personal Sync 上下文残留
        autoSyncManager.stop();
        // 在重置全局路径前，显式清理当前 Vault 的配置
        syncService.clearConfig();
        
        useSessionStore.getState().clearAll();
        setStep('welcome');
        setServerInfo(null);
        setPersonalVault(null);
        setTeamVault(null);
        setSyncStatus('idle');
        setSyncResult('');
        setAccessCode('');
        // Do NOT clear password here - allow system keychain/autofill to work for teams
        setCodeResetMode(false);

        if (shouldClose) {
            window.dispatchEvent(new CustomEvent('vault:force-close'));
        }
    };

    // ── 手动同步 ──
    const handleSync = async () => {
        if (!vaultPath || syncStatus === 'syncing') return;

        setSyncStatus('syncing');
        setSyncResult('');

        try {
            const result = await syncService.syncVault(vaultPath);
            setSyncStatus('success');
            if (result.files_pushed === 0 && result.files_pulled === 0) {
                setSyncResult('✅ 已是最新，无需同步');
            } else {
                setSyncResult(`${t('sync.push_count', { count: result.files_pushed })}，${t('sync.pull_count', { count: result.files_pulled })}`);
            }
            setTimeout(() => setSyncStatus('idle'), 5000);
            refreshCloudInfo();
            if (result.files_pushed > 0 || result.files_pulled > 0) {
                window.dispatchEvent(new Event('team:tree-refresh'));
            }
        } catch (err) {
            setSyncStatus('error');
            setSyncResult(String(err));
            setTimeout(() => setSyncStatus('idle'), 5000);
        }
    };

    // ── 创建团队 ──
    const handleCreateTeam = async () => {
        setError('');
        setSyncResult('');
        if (!teamName.trim() || !username.trim() || !displayName.trim() || !password.trim()) return;
        if (password !== passwordConfirm) {
            setError(t('sync.password_mismatch'));
            return;
        }

        // 确定 serverUrl 和 token
        const config = syncService.getConfig();
        const activeServerUrl = config?.serverUrl || serverUrl.replace(/\/+$/, '');
        const activeToken = config?.accessToken || '';
        const activeAccessCode = accessCode.trim();

        if (!activeServerUrl) {
            setError(t('sync.fill_server_and_code'));
            return;
        }

        // 无 JWT 且无 access_code → 报错
        if (!activeToken && !activeAccessCode) {
            setError(t('sync.fill_server_and_code'));
            return;
        }

        setLoading(true);
        setError('');
        try {
            // 直接调用 create_team，由后端处理认证（JWT 或 access_code）
            const result = await teamService.createTeam(
                activeServerUrl, activeToken,
                teamName.trim(), username.trim(), password.trim(), displayName.trim(),
                activeAccessCode || undefined,
            );
            const createDisplayName = displayName.trim() || username.trim();
            // 🛡️ Layer 2: Vault 身份绑定校验
            if (!await verifyVaultBinding('team', activeServerUrl, result.user_id || '', result.vault_id, createDisplayName, undefined, username.trim())) return;

            const vaultId = await resolveVaultId(vaultPath);
            syncService.saveConfig({
                serverUrl: activeServerUrl,
                accessToken: result.access_token,
                vaultId,
                userId: result.user_id || '__personal__'
            });

            if (result.access_token && result.refresh_token) {
                await invoke('secure_store_tokens', {
                    serverUrl: activeServerUrl,
                    userId: result.user_id || '__personal__',
                    accessToken: result.access_token,
                    refreshToken: result.refresh_token
                }).catch(e => console.warn('[SyncTab] Failed to securely store team create tokens:', e));
            }

            if (rememberMe) {
                localStorage.setItem('slash_remember_me', 'true');
                await invoke('save_login_credential', {
                    serverUrl: activeServerUrl,
                    username: username.trim(),
                    password: password.trim()
                }).catch(e => console.warn('[SyncTab] Failed to securely save password:', e));
            } else {
                localStorage.setItem('slash_remember_me', 'false');
                await invoke('delete_login_credential', {
                    serverUrl: activeServerUrl,
                    username: username.trim()
                }).catch(e => console.warn('[SyncTab] Failed to securely clear password:', e));
            }

            const oldDisplayName = useSessionStore.getState().displayName || '';
            useSessionStore.getState().setUserInfo({ userId: result.user_id || undefined, displayName: createDisplayName });
            useSessionStore.getState().setTeamInfo({ teamVaultId: result.vault_id, teamVaultName: result.name, teamRole: 'admin' });
            // 确保本地 team_sync_state.json 存在（被邀成员首次同步必需）
            const vaultRoot = localStorage.getItem('slash_vault_path');
            if (vaultRoot && result.vault_id) {
                invoke('ensure_team_sync_state', { 
                    vaultPath: vaultRoot, 
                    teamVaultId: result.vault_id 
                }).catch(e => console.warn('[SyncFlow] ensure_team_sync_state failed:', e));
            }

            if (vaultPath && createDisplayName) {
                batchUpdateEditorName(vaultPath, createDisplayName, oldDisplayName);
            }

            setTeamName('');
            setUsername(''); setDisplayName('');
            setPassword(''); setPasswordConfirm('');
            setAccessCode('');

            useSessionStore.getState().setUserInfo({ userType: 'team' });
            setStep('connected_team');

            if (vaultPath) {
                autoSyncManager.start(vaultPath).then(() => refreshCloudInfo()).catch(console.error);
            } else {
                refreshCloudInfo();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.create_team_failed'));
        } finally {
            setLoading(false);
        }
    };

    // ── 请求新配对码 ──
    const handleRequestNewCode = async () => {
        try {
            let targetUrl = serverUrl.trim().replace(/\/+$/, '');
            if (!targetUrl) {
                setPairCodeMessage({ msg: t('sync.login_fill_server'), isError: true });
                return;
            }
            if (!targetUrl.startsWith('http')) {
                targetUrl = `http://${targetUrl}`;
            }

            const resp = await fetch(`${targetUrl}/api/server/request-new-code`, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(username.trim() ? { username: username.trim() } : {})
            });
            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.pair_code_regen_fail');
                try {
                    const err = JSON.parse(body);
                    if (err.error) {
                        if (err.error.startsWith('COOLDOWN:')) {
                            const seconds = err.error.split(':')[1];
                            msg = t('sync.pair_code_cooldown', { seconds });
                        } else {
                            msg = err.error;
                        }
                    }
                } catch { /* */ }
                setPairCodeMessage({ msg, isError: true });

                // 3秒后自动清除错误提示
                setTimeout(() => setPairCodeMessage(null), 3000);
                return;
            }
            setPairCodeMessage(null);
            setAccessCode('');
            setPairCodeMessage({ msg: t('sync.pair_code_new_generated'), isError: false });
            
            setTimeout(() => setPairCodeMessage(null), 3000);
        } catch {
            setPairCodeMessage({ msg: t('sync.pair_code_regen_fail'), isError: true });
            setTimeout(() => setPairCodeMessage(null), 3000);
        }
    };

    // ── 忘记 PIN → 导航到配对码页面 ──
    const handleForgotPin = async () => {
        setCodeResetMode(false);
        setError('');
        setAccessCode('');
        setStep('pair_input');
    };

    // ── PIN 完成后进入已连接 ──
    const handlePinComplete = async () => {
        // 🛡️ Layer 2: Vault 身份绑定校验
        const pinConfig = syncService.getConfig();
        const pinUserId = useSessionStore.getState().userId || '__personal__';
        if (!await verifyVaultBinding('personal', pinConfig?.serverUrl || serverUrl, pinUserId)) return;
        useSessionStore.getState().setUserInfo({ userType: 'personal' });
        setStep('connected_personal');
        if (vaultPath) autoSyncManager.start(vaultPath).then(() => refreshCloudInfo());
    };

    // ── 管理员忘记密码 → 生成新配对码 → 跳到配对码页 ──
    const handleAdminForgotPassword = async () => {
        const targetUrl = serverUrl.replace(/\/+$/, '');
        if (!targetUrl) { setError(t('sync.login_fill_server')); return; }
        if (!username.trim()) { setError(t('sync.login_fill_fields')); return; }

        setLoading(true);
        setError('');
        try {
            const resp = await fetch(`${targetUrl}/api/server/request-new-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim() }),
            });
            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.reset_admin_failed');
                try {
                    const err = JSON.parse(body);
                    if (err.error) msg = err.error;
                } catch { msg = body || msg; }
                // 后端错误 → 友好的 i18n 提示
                if (msg.includes('not a team admin') || msg.includes('not found')) {
                    msg = t('sync.not_admin_error');
                } else if (msg.includes('Too frequent')) {
                    msg = t('sync.reset_admin_failed') + '（5分钟冷却中）';
                }
                setError(msg);
                return;
            }
            setAdminResetMode(true);
            setAccessCode('');
            setStep('pair_input');
        } catch {
            setError(t('sync.server_unreachable'));
        } finally {
            setLoading(false);
        }
    };

    // ── 管理员重置凭据 ──
    const handleAdminReset = async () => {
        if (!username.trim() || !password.trim()) {
            setError(t('sync.login_fill_fields'));
            return;
        }
        if (password !== passwordConfirm) {
            setError(t('sync.password_mismatch'));
            return;
        }

        const config = syncService.getConfig();
        if (!config) { setError(t('sync.login_fill_server')); return; }

        setLoading(true);
        setError('');
        try {
            const resp = await fetch(`${config.serverUrl}/api/auth/admin-reset`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.accessToken}`,
                },
                body: JSON.stringify({
                    username: username.trim(),
                    new_password: password.trim(),
                    display_name: displayName.trim() || undefined,
                }),
            });

            if (!resp.ok) {
                const body = await resp.text();
                let msg = t('sync.reset_admin_failed');
                try {
                    const err = JSON.parse(body);
                    if (err.error) msg = err.error;
                } catch { msg = body || msg; }
                throw new Error(msg);
            }

            const data = await resp.json();
            const newUserId = data.user?.id || '';
            const refreshToken = data.refresh_token;

            if (data.access_token && refreshToken) {
                await invoke('secure_store_tokens', {
                    serverUrl: config.serverUrl,
                    userId: newUserId,
                    accessToken: data.access_token,
                    refreshToken: refreshToken
                }).catch(e => console.warn('[SyncTab] Failed to securely store reset tokens:', e));
            }

            const oldDisplayName = useSessionStore.getState().displayName || '';
            const newDisplayName = data.user?.display_name || displayName.trim() || username.trim();
            useSessionStore.getState().setUserInfo({ userId: newUserId || undefined, displayName: newDisplayName });

            if (vaultPath && newDisplayName) {
                batchUpdateEditorName(vaultPath, newDisplayName, oldDisplayName);
            }

            // 🛡️ Layer 2: Vault 身份绑定校验
            if (!await verifyVaultBinding('team', config.serverUrl, newUserId, await fetchTeamVaultId(config.serverUrl), newDisplayName)) return;
            const vaultId = await resolveVaultId(vaultPath);
            syncService.saveConfig({ serverUrl: config.serverUrl, accessToken: data.access_token, vaultId, userId: newUserId || '__personal__' });
            useSessionStore.getState().setUserInfo({ userType: 'team' });
            setStep('connected_team');
            setUsername(''); setPassword(''); setPasswordConfirm(''); setDisplayName('');

            if (vaultPath) {
                autoSyncManager.start(vaultPath).then(() => refreshCloudInfo()).catch(console.error);
            }
            await refreshCloudInfo();
            await fetchServerInfo();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('sync.reset_admin_failed'));
        } finally {
            setLoading(false);
        }
    };

    return {
        // 状态
        step, setStep,
        serverUrl, setServerUrl,
        accessCode, setAccessCode,
        loading, error, setError,
        codeResetMode, pinResetMode,
        adminResetMode, setAdminResetMode,
        postLoginRedirect, setPostLoginRedirect,
        isConnected,
        newPin, setNewPin,
        pinSet, serverInfo,
        syncStatus, syncResult,
        pairCodeMessage, setPairCodeMessage,
        username, setUsername: setSafeUsername,
        displayName, setDisplayName,
        selectedTeamId, setSelectedTeamId,
        password, setPassword,
        passwordConfirm, setPasswordConfirm,
        inviteCode, setInviteCode,
        showPassword, setShowPassword,
        teamName, setTeamName,
        rememberMe, setRememberMe,
        personalVault, teamVault,
        localVaultName, lastSyncTime,
        vaultPath,

        // Handlers
        handlePair,
        handleConnectPersonal,
        handleSetPin,
        handleLogin,
        handleTeamJoin,
        handleDisconnect,
        handleSync,
        handleCreateTeam,
        handleRequestNewCode,
        handleForgotPin,
        handlePinComplete,
        handleAdminForgotPassword,
        handleAdminReset,
        refreshCloudInfo,
    };
}

export type SyncFlowContext = ReturnType<typeof useSyncFlow>;
