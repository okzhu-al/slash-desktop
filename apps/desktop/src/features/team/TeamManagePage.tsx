/**
 * TeamManagePage — 全页面团队管理视图
 *
 * 独占编辑区，提供：
 * - 顶部统计卡片（空间名称、文件数、成员数）
 * - 成员表格（角色切换、密码重置、移除）
 * - 邀请功能（生成邀请码 + 复制）
 * - 个人资料编辑（显示名称、密码修改）
 */
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Users, UserPlus, Copy, Check, Trash2, KeyRound,
    Loader2, ShieldCheck, UserCog, LogOut, Wrench, HardDrive
} from 'lucide-react';
import { StorageDashboard } from './StorageDashboard';
import { cn } from '@/shared/utils/cn';
import { syncService } from '@/services/SyncService';
import { teamService, type TeamMemberInfo, type TeamRole } from '@/services/TeamService';
import { toast } from 'sonner';
import { useSessionStore } from '@/stores/useSessionStore';

interface TeamManagePageProps {
    onClose: () => void;
}

type ManageTab = 'members' | 'storage';

export function TeamManagePage({ onClose: _onClose }: TeamManagePageProps) {
    const { t } = useTranslation();
    // ── Tab ──
    const [activeTab, setActiveTab] = useState<ManageTab>('members');
    // ── 数据 ──
    const [members, setMembers] = useState<TeamMemberInfo[]>([]);
    const [loading, setLoading] = useState(true);

    // ── 邀请 ──
    const [inviteCode, setInviteCode] = useState('');
    const [inviteLoading, setInviteLoading] = useState(false);
    const [inviteCopied, setInviteCopied] = useState(false);

    // ── 密码重置 ──
    const [resetUserId, setResetUserId] = useState<string | null>(null);
    const [newPassword, setNewPassword] = useState('');
    const [resetLoading, setResetLoading] = useState(false);

    // ── 角色变更 ──
    const [togglingRoleId, setTogglingRoleId] = useState<string | null>(null);

    // ── 个人资料编辑 ──
    const [profileEditing, setProfileEditing] = useState(false);
    const [editDisplayName, setEditDisplayName] = useState('');
    const [editCurrentPw, setEditCurrentPw] = useState('');
    const [editNewPw, setEditNewPw] = useState('');
    const [editNewPwConfirm, setEditNewPwConfirm] = useState('');
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileError, setProfileError] = useState('');

    // ── 设置 ──
    const [maxSyncFileSizeMb, setMaxSyncFileSizeMb] = useState<string>('200');
    const [settingsSaving, setSettingsSaving] = useState(false);

    const teamVaultName = useSessionStore(s => s.teamVaultName) || t('team.space_name');
    const teamVaultId = useSessionStore(s => s.teamVaultId);
    const currentDisplayName = useSessionStore(s => s.displayName) || '';
    const storedTeamUsername = useSessionStore(s => s.teamUsername);
    const currentUserId = useSessionStore(s => s.userId) || '';

    // ── 当前用户是否 Admin（从 members 列表中匹配）──
    const currentMember = members.find(m => m.user_id === currentUserId);
    const isAdmin = currentMember?.global_role === 'Admin';
    
    // 优先使用 members 接口实时返回的 username，回退到本地 session
    const currentUsername = currentMember?.username || storedTeamUsername || '';
    
    const isAdminManageMode = useSessionStore(s => s.isAdminManageMode);
    const setAdminManageMode = useSessionStore(s => s.setAdminManageMode);

    // ── 加载 ──
    const loadData = useCallback(async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setLoading(true);
        try {
            const result = await teamService.listMembers(config.serverUrl, config.accessToken, teamVaultId);
            setMembers(result.members);


            try {
                if (result.members.find(m => m.user_id === currentUserId)?.global_role === 'Admin') {
                    const settings = await teamService.getTeamSettings(config.serverUrl, config.accessToken, teamVaultId);
                    setMaxSyncFileSizeMb(String(settings.max_sync_file_size_mb));
                }
            } catch (e) { console.warn('[Settings] load failed', e); }
        } catch (err) {
            toast.error(t('team.load_failed', { error: err instanceof Error ? err.message : err }));
        } finally {
            setLoading(false);
        }
    }, [teamVaultId]);

    useEffect(() => { loadData(); }, [loadData]);

    useEffect(() => {
        const handleDirectoriesChanged = () => {
            loadData();
        };
        window.addEventListener('team:directories-changed', handleDirectoriesChanged);
        return () => window.removeEventListener('team:directories-changed', handleDirectoriesChanged);
    }, [loadData]);

    // ── 操作 ──
    const handleGenerateInvite = async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setInviteLoading(true);
        try {
            const result = await teamService.generateInvite(config.serverUrl, config.accessToken, teamVaultId);
            setInviteCode(result.code);
            setInviteCopied(false);
        } catch (err) {
            toast.error(t('team.load_failed', { error: err instanceof Error ? err.message : err }));
        } finally {
            setInviteLoading(false);
        }
    };

    const handleCopyInvite = () => {
        navigator.clipboard.writeText(inviteCode);
        setInviteCopied(true);
        toast.success(t('team.copy_success'));
        setTimeout(() => setInviteCopied(false), 2000);
    };

    const handleToggleAdmin = async (userId: string, currentRole: string) => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        const newRole: TeamRole = currentRole === 'Admin' ? 'Observer' : 'Admin';
        if (userId === currentUserId && newRole === 'Observer') {
            toast.error(t('team.self_revoke_admin_forbidden'));
            return;
        }
        setTogglingRoleId(userId);
        try {
            await teamService.updateMemberRole(config.serverUrl, config.accessToken, teamVaultId, userId, newRole);
            toast.success(newRole === 'Admin' ? t('team.grant_admin') : t('team.revoke_admin'));
            loadData();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toast.error(
                message.includes('Cannot change your own role')
                    ? t('team.self_revoke_admin_forbidden')
                    : t('team.toggle_role_failed', { error: message })
            );
        } finally {
            setTogglingRoleId(null);
        }
    };

    const handleRemoveMember = async (userId: string, displayName: string) => {
        const { confirm } = await import('@tauri-apps/plugin-dialog');
        const ok = await confirm(t('team.remove_confirm', { name: displayName }), { title: 'Slash', kind: 'warning' });
        if (!ok) return;
        
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        try {
            await teamService.removeMember(config.serverUrl, config.accessToken, teamVaultId, userId);
            toast.success(t('team.remove_member') + `: ${displayName}`);
            loadData();
        } catch (err) {
            toast.error(t('team.remove_failed', { error: err instanceof Error ? err.message : err }));
        }
    };

    const handleRevokeSessions = async (userId: string, displayName: string) => {
        const { confirm } = await import('@tauri-apps/plugin-dialog');
        const ok = await confirm(t('team.revoke_confirm', { name: displayName }), { title: 'Slash', kind: 'warning' });
        if (!ok) return;
        
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        try {
            const res = await teamService.revokeSessions(config.serverUrl, config.accessToken, teamVaultId, userId);
            toast.success(t('team.revoke_success', { count: res.sessions_deleted, name: displayName }));
        } catch (err) {
            toast.error(t('team.revoke_failed', { error: err instanceof Error ? err.message : err }));
        }
    };

    const handleResetPassword = async () => {
        if (!resetUserId || !newPassword.trim()) return;
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setResetLoading(true);
        try {
            await teamService.resetPassword(config.serverUrl, config.accessToken, teamVaultId, resetUserId, newPassword.trim());
            toast.success(t('team.reset_pw_success', { name: resetTarget?.display_name || resetTarget?.username || '' }));
            setResetUserId(null);
            setNewPassword('');
        } catch (err) {
            toast.error(`重置失败: ${err instanceof Error ? err.message : err}`);
        } finally {
            setResetLoading(false);
        }
    };

    const handleSaveSettings = async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setSettingsSaving(true);
        try {
            await teamService.updateTeamSettings(config.serverUrl, config.accessToken, teamVaultId, Number(maxSyncFileSizeMb) || 200);
            toast.success(t('team.settings_updated'));
            const { invalidateCapabilitiesCache } = await import('@/core/sync/capabilities');
            invalidateCapabilitiesCache();
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('update_local_sync_capabilities', { maxSyncFileSize: (Number(maxSyncFileSizeMb) || 200) * 1024 * 1024 });
            const { autoSyncManager } = await import('@/services/AutoSyncManager');
            autoSyncManager.manualSync();
        } catch (err) {
            toast.error(t('team.settings_update_failed', { error: err instanceof Error ? err.message : err }));
        } finally {
            setSettingsSaving(false);
        }
    };

    const handleStartProfileEdit = () => {
        setProfileEditing(true);
        setEditDisplayName(currentDisplayName);
        setEditCurrentPw('');
        setEditNewPw('');
        setEditNewPwConfirm('');
    };

    const handleSaveProfile = async () => {
        const config = syncService.getConfig();
        if (!config) return;

        setProfileError('');
        const data: { display_name?: string; current_password?: string; new_password?: string } = {};

        // 显示名称变更
        if (editDisplayName.trim() && editDisplayName.trim() !== currentDisplayName) {
            data.display_name = editDisplayName.trim();
        }

        // 密码变更
        if (editNewPw.trim()) {
            if (!editCurrentPw.trim()) {
                setProfileError(t('team.current_password'));
                return;
            }
            if (editNewPw.trim().length < 4) {
                setProfileError('新密码至少 4 个字符');
                return;
            }
            if (editNewPw !== editNewPwConfirm) {
                setProfileError(t('team.password_mismatch'));
                return;
            }
            data.current_password = editCurrentPw.trim();
            data.new_password = editNewPw.trim();
        }

        if (!data.display_name && !data.new_password) {
            toast.info('没有需要保存的修改');
            return;
        }

        setProfileSaving(true);
        try {
            const result = await teamService.updateProfile(config.serverUrl, config.accessToken, data);
            if (result.display_name) {
                useSessionStore.getState().setUserInfo({ displayName: result.display_name });

                // 批量更新 vault 内笔记的 editor 字段（rename 场景：只替换 old_name 匹配的）
                const vaultPath = localStorage.getItem('slash-last-vault');
                if (vaultPath && result.display_name) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    invoke('batch_update_editor', {
                        vaultPath,
                        newName: result.display_name,
                        oldName: currentDisplayName || null,
                        editingPath: null,
                    }).catch((e: unknown) => console.warn('[ProfileRename] batch_update_editor failed:', e));
                }
            }
            toast.success(t('team.profile_updated'));
            setProfileEditing(false);
            setProfileError('');
            loadData(); // 刷新成员列表以反映新名称
        } catch (err) {
            let msg = err instanceof Error ? err.message : String(err);
            // 统一中文提示
            if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('password') || msg.toLowerCase().includes('unauthorized')) {
                msg = '当前密码错误';
            }
            setProfileError(msg);
        } finally {
            setProfileSaving(false);
        }
    };

    const resetTarget = members.find(m => m.user_id === resetUserId);

    return (
        <div className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-900 overflow-hidden">
            {/* ── 顶栏 ── */}
            <div className="flex items-center justify-between px-8 py-5 border-b border-[#C8C8C8] dark:border-zinc-800">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#002FA7]/10 dark:bg-blue-500/10 flex items-center justify-center shrink-0">
                        <Users size={18} className="text-[#002FA7] dark:text-blue-400" />
                    </div>
                    <div className="h-9 flex flex-col justify-between py-0.5">
                        <h1 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 leading-none">{teamVaultName}</h1>
                        <p className="text-[11px] text-[#C8C8C8] leading-none">{t('team.manage_title')}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleStartProfileEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
                    >
                        <UserCog size={13} />
                        {t('team.profile_title')}
                    </button>
                    {isAdmin && (
                        <button
                            onClick={async () => {
                                if (!isAdminManageMode) {
                                    const { confirm } = await import('@tauri-apps/plugin-dialog');
                                    const ok = await confirm(
                                        t('team.maintenance_confirm_body'),
                                        { title: t('team.maintenance_confirm_title'), kind: 'warning', okLabel: t('team.maintenance_confirm_ok'), cancelLabel: t('common.cancel') }
                                    );
                                    if (!ok) return;
                                }
                                setAdminManageMode(!isAdminManageMode);
                                try {
                                    const config = syncService.getConfig();
                                    const currentTeamVaultId = useSessionStore.getState().teamVaultId;
                                    if (config && currentTeamVaultId) {
                                        const { teamService } = await import('@/services/TeamService');
                                        const resp = await teamService.toggleMaintenance(config.serverUrl, config.accessToken, currentTeamVaultId, !isAdminManageMode);
                                        // Admin 开启时：用服务端时间戳校准本地 expiry（消除时钟偏差）
                                        if (!isAdminManageMode && resp.maintenance_started_at) {
                                            const MAINTENANCE_DURATION_MS = 30 * 60 * 1000;
                                            useSessionStore.setState({
                                                adminManageModeExpiry: resp.maintenance_started_at * 1000 + MAINTENANCE_DURATION_MS,
                                            });
                                        }
                                    }
                                } catch (e) {
                                    console.warn('[Maintenance] Failed to sync status to server:', e);
                                }
                            }}
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-300 cursor-pointer border",
                                isAdminManageMode 
                                    ? "bg-[#A42227]/10 hover:bg-[#A42227]/20 text-[#A42227] border-[#A42227]/30 dark:bg-[#A42227]/20 dark:text-[#A42227] dark:border-[#A42227]/40" 
                                    : "bg-white hover:bg-[#A42227]/5 border-[#A42227]/30 text-[#A42227] shadow-sm dark:bg-zinc-800/80 dark:border-[#A42227]/50 dark:text-[#A42227] dark:hover:bg-zinc-800"
                            )}
                        >
                            <Wrench size={13} className={isAdminManageMode ? "animate-[pulse_1.5s_ease-in-out_infinite] text-[#A42227]" : "text-[#A42227]"} />
                            {isAdminManageMode ? t('team.maintenance_exit') : t('team.maintenance_enter')}
                        </button>
                    )}

                </div>
            </div>

            {/* ── Tab 切换条 ── */}
            {isAdmin && (
                <div className="flex items-center gap-1 px-8 pt-3 border-b border-[#C8C8C8] dark:border-zinc-800">
                    <button
                        onClick={() => setActiveTab('members')}
                        className={cn(
                            'px-4 py-2 text-xs font-medium rounded-t-lg transition-colors cursor-pointer flex items-center gap-1.5',
                            activeTab === 'members'
                                ? 'bg-white dark:bg-zinc-900 border border-b-0 border-[#C8C8C8] dark:border-zinc-800 text-[#002FA7] dark:text-blue-400 -mb-px'
                                : 'text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-blue-300'
                        )}
                    >
                        <Users size={13} />
                        {t('team.tab_members')}
                    </button>
                    <button
                        onClick={() => setActiveTab('storage')}
                        className={cn(
                            'px-4 py-2 text-xs font-medium rounded-t-lg transition-colors cursor-pointer flex items-center gap-1.5',
                            activeTab === 'storage'
                                ? 'bg-white dark:bg-zinc-900 border border-b-0 border-[#C8C8C8] dark:border-zinc-800 text-[#002FA7] dark:text-blue-400 -mb-px'
                                : 'text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-blue-300'
                        )}
                    >
                        <HardDrive size={13} />
                        {t('team.tab_storage')}
                    </button>
                </div>
            )}

            {/* ── 内容区 ── */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {activeTab === 'storage' && isAdmin ? (
                    <div className="max-w-3xl mx-auto px-8 py-6 space-y-6">
                        {/* ── Space Settings（置顶，方便快速修改） ── */}
                        <div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-5 space-y-4">
                            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                                <Wrench size={14} />
                                {t('team.space_settings')}
                            </p>
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-medium text-[#C8C8C8] dark:text-[#C8C8C8]">{t('team.max_file_size_limit')}</label>
                                <div className="flex items-center gap-3">
                                    <input
                                        type="number"
                                        min="1"
                                        max="10240"
                                        value={maxSyncFileSizeMb}
                                        onChange={(e) => setMaxSyncFileSizeMb(e.target.value)}
                                        className="flex-1 px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30"
                                    />
                                    <button
                                        onClick={handleSaveSettings}
                                        disabled={settingsSaving}
                                        className={cn(
                                            'px-4 py-2 text-sm rounded-lg font-medium transition-all cursor-pointer',
                                            settingsSaving
                                                ? 'bg-zinc-200 text-[#C8C8C8] cursor-not-allowed dark:bg-zinc-700 dark:text-[#C8C8C8]'
                                                : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300'
                                        )}
                                    >
                                        {settingsSaving ? <Loader2 size={14} className="animate-spin" /> : t('common.save')}
                                    </button>
                                </div>
                                <p className="text-xs text-[#C8C8C8]">{t('team.max_file_size_hint')}</p>
                            </div>
                        </div>

                        <StorageDashboard />
                    </div>
                ) : (
                <div className="max-w-3xl mx-auto px-8 py-6 space-y-6">



                    {/* ── 个人资料编辑模态框 ── */}
                    {profileEditing && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
                            <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-[#C8C8C8] dark:border-zinc-800 p-6 space-y-5 animate-in fade-in zoom-in-95 duration-200">
                                <div className="flex items-center justify-between">
                                    <p className="text-base font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                                        <UserCog size={16} className="text-[#002FA7]" />
                                        {t('team.profile_title')}
                                    </p>
                                    <button
                                        onClick={() => setProfileEditing(false)}
                                        className="text-xs text-[#545454] hover:text-zinc-900 transition-colors cursor-pointer"
                                    >
                                        {t('team.cancel')}
                                    </button>
                                </div>

                                <div className="space-y-4">
                                    {/* 用户名（只读） */}
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8]">{t('sync.username_label')}</label>
                                        <input
                                            type="text"
                                            value={currentUsername || '-'}
                                            disabled
                                            className="w-full px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                        />
                                    </div>

                                    {/* 显示名称 */}
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8]">{t('team.display_name')}</label>
                                        <input
                                            type="text"
                                            value={editDisplayName}
                                            onChange={(e) => setEditDisplayName(e.target.value)}
                                            placeholder="输入显示名称"
                                            className="w-full px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30 transition-shadow"
                                        />
                                    </div>

                                    {/* 修改密码区域 */}
                                    <div className="border-t border-[#C8C8C8] dark:border-zinc-800 pt-4 space-y-3">
                                        <p className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8]">{t('team.new_password')}</p>
                                        <input
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            type="password"
                                            value={editCurrentPw}
                                            onChange={(e) => setEditCurrentPw(e.target.value)}
                                            placeholder={t('team.current_password')}
                                            className="w-full px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30 transition-shadow"
                                        />
                                        <input
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            type="password"
                                            value={editNewPw}
                                            onChange={(e) => setEditNewPw(e.target.value)}
                                            placeholder={t('team.new_password')}
                                            className="w-full px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30 transition-shadow"
                                        />
                                        <input
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            type="password"
                                            value={editNewPwConfirm}
                                            onChange={(e) => setEditNewPwConfirm(e.target.value)}
                                            placeholder={t('team.confirm_password')}
                                            className="w-full px-3 py-2 text-sm rounded-lg border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30 transition-shadow"
                                        />
                                    </div>
                                </div>

                                {/* 内联错误提示 */}
                                {profileError && (
                                    <p className="text-xs text-[#A42227]">{profileError}</p>
                                )}

                                {/* 保存按钮 */}
                                <div className="flex justify-end pt-2">
                                    <button
                                        onClick={handleSaveProfile}
                                        disabled={profileSaving}
                                        className={cn(
                                            'px-5 py-2 text-sm rounded-lg font-medium transition-all cursor-pointer',
                                            profileSaving
                                                ? 'bg-zinc-200 text-[#C8C8C8] cursor-not-allowed dark:bg-zinc-700 dark:text-[#C8C8C8]'
                                                : 'bg-[#002FA7] hover:brightness-110 text-white shadow-sm',
                                        )}
                                    >
                                        {profileSaving ? <Loader2 size={14} className="animate-spin" /> : t('team.save_profile')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── 成员列表 ── */}
                    <div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 overflow-hidden">
                        <div className="flex items-center justify-between px-5 py-3 bg-zinc-50 dark:bg-zinc-800/50 border-b border-[#C8C8C8] dark:border-zinc-800 rounded-t-xl">
                            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                                <ShieldCheck size={14} className="text-[#C8C8C8]" />
                                {t('team.section_members')}
                                <span className="text-xs font-normal text-[#C8C8C8]">{members.length}</span>
                            </h2>
                            {isAdmin && (
                                <button
                                    onClick={handleGenerateInvite}
                                    disabled={inviteLoading}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#002FA7] hover:brightness-110 text-white transition-colors cursor-pointer disabled:opacity-50"
                                >
                                    {inviteLoading ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
                                    {t('team.generate_invite')}
                                </button>
                            )}
                        </div>

                        {loading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 size={20} className="animate-spin text-zinc-300" />
                            </div>
                        ) : members.length === 0 ? (
                            <div className="text-center py-16 text-sm text-[#C8C8C8]">{t('team.stats_unknown')}</div>
                        ) : (
                            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/50">
                                {members.map((m) => (
                                    <div
                                        key={m.user_id}
                                        className="group flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                                    >
                                        {/* 头像 */}
                                        <div className="w-8 h-8 rounded-full bg-[#002FA7]/10 dark:bg-blue-500/10 flex items-center justify-center text-xs font-bold text-[#002FA7] dark:text-blue-400 shrink-0 uppercase shadow-sm border border-[#002FA7]/30 dark:border-blue-500/30">
                                            {(m.display_name || m.username).charAt(0).toUpperCase()}
                                        </div>

                                        {/* 信息 */}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                                {m.display_name || m.username}
                                            </p>
                                        </div>

                                        {/* Admin 开关 — 仅 Admin 可见 */}
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                'text-xs font-medium',
                                                m.global_role === 'Admin' ? 'text-[#545454] dark:text-zinc-400' : 'text-[#C8C8C8]',
                                            )}>{m.global_role}</span>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => handleToggleAdmin(m.user_id, m.global_role)}
                                                    disabled={togglingRoleId === m.user_id}
                                                    className={cn(
                                                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50',
                                                        m.global_role === 'Admin'
                                                            ? 'bg-[#006540]'
                                                            : 'bg-zinc-300 dark:bg-zinc-600',
                                                    )}
                                                    title={m.global_role === 'Admin' ? t('team.revoke_admin') : t('team.grant_admin')}
                                                >
                                                    <span className={cn(
                                                        'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                                                        m.global_role === 'Admin' ? 'translate-x-[18px]' : 'translate-x-[3px]',
                                                    )} />
                                                </button>
                                            )}
                                        </div>

                                        {/* 操作按钮 — 仅 Admin 可见 */}
                                        {isAdmin && (
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => handleRevokeSessions(m.user_id, m.display_name || m.username)}
                                                    className="group/btn p-1.5 rounded-md hover:bg-[#A42227] dark:hover:bg-[#A42227] transition-colors cursor-pointer"
                                                    title={t('team.revoke_sessions')}
                                                >
                                                    <LogOut size={13} className="text-[#C8C8C8] group-hover/btn:text-white transition-colors" />
                                                </button>
                                                <button
                                                    onClick={() => { setResetUserId(m.user_id); setNewPassword(''); }}
                                                    className="group/btn p-1.5 rounded-md hover:bg-[#A42227] dark:hover:bg-[#A42227] transition-colors cursor-pointer"
                                                    title={t('team.reset_password')}
                                                >
                                                    <KeyRound size={13} className="text-[#C8C8C8] group-hover/btn:text-white transition-colors" />
                                                </button>
                                                <button
                                                    onClick={() => handleRemoveMember(m.user_id, m.display_name || m.username)}
                                                    className="group/btn p-1.5 rounded-md hover:bg-[#A42227] dark:hover:bg-[#A42227] transition-colors cursor-pointer"
                                                    title={t('team.remove_member')}
                                                >
                                                    <Trash2 size={13} className="text-[#C8C8C8] group-hover/btn:text-white transition-colors" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* ── 密码重置面板 ── */}
                    {resetUserId && resetTarget && (
                        <div className="rounded-xl border border-[#A42227] dark:border-[#A42227]/50 bg-[#A42227]/50 dark:bg-[#A42227]/10 p-5 space-y-3">
                            <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-[#A42227] dark:text-[#A42227] flex items-center gap-2">
                                    <KeyRound size={14} />
                                    {t('team.reset_pw_title', { name: resetTarget.display_name || resetTarget.username })}
                                </p>
                                <button
                                    onClick={() => { setResetUserId(null); setNewPassword(''); }}
                                    className="text-xs text-[#C8C8C8] hover:text-zinc-600 transition-colors cursor-pointer"
                                >
                                    {t('team.cancel')}
                                </button>
                            </div>
                            <div className="flex items-center gap-3">
                                <input
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    placeholder={t('team.reset_pw_placeholder')}
                                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-[#A42227] dark:border-[#A42227] bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#A42227]/30 transition-shadow"
                                    onKeyDown={(e) => e.key === 'Enter' && handleResetPassword()}
                                />
                                <button
                                    onClick={handleResetPassword}
                                    disabled={!newPassword.trim() || resetLoading}
                                    className={cn(
                                        'px-4 py-2 text-sm rounded-lg font-medium transition-all cursor-pointer',
                                        !newPassword.trim() || resetLoading
                                            ? 'bg-zinc-200 text-[#C8C8C8] cursor-not-allowed dark:bg-zinc-700 dark:text-[#C8C8C8]'
                                            : 'bg-[#A42227] hover:bg-[#A42227] text-white shadow-sm hover:shadow-md',
                                    )}
                                >
                                    {resetLoading ? <Loader2 size={14} className="animate-spin" /> : t('team.reset_pw_confirm')}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── 邀请码显示（生成后） ── */}
                    {inviteCode && (
                        <div className="rounded-xl border border-blue-200 dark:border-blue-500/25 bg-blue-50/60 dark:bg-blue-500/[0.08] p-5 space-y-2">
                            <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">{t('team.invite_title')}</p>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 px-3 py-2 text-sm font-mono bg-white dark:bg-zinc-900/80 rounded-lg border border-blue-200 dark:border-blue-500/30 text-blue-800 dark:text-blue-200 select-all truncate">
                                    {inviteCode}
                                </code>
                                <button
                                    onClick={handleCopyInvite}
                                    className="p-2 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/15 transition-colors cursor-pointer"
                                >
                                    {inviteCopied
                                        ? <Check size={16} className="text-[#006540]" />
                                        : <Copy size={16} className="text-blue-600 dark:text-blue-300" />}
                                </button>
                            </div>
                        </div>
                    )}


                </div>
                )}
            </div>
        </div>
    );
}
