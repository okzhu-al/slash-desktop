import { useState, useEffect } from 'react';
import { Cloud, KeyRound, Loader2, Users, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyncFlowContext } from '../useSyncFlow';
import { cn } from '../../../../shared/utils/cn';
import { VaultBinding, readVaultBindings } from '../../../../services/VaultBindingService';
import { syncService } from '@/services/SyncService';
export const AuthGatewayStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    const [bindings, setBindings] = useState<VaultBinding[]>([]);
    const [highestBinding, setHighestBinding] = useState<VaultBinding | null>(null);

    useEffect(() => {
        const fetchHistory = async () => {
            if (ctx.vaultPath) {
                try {
                    const { bindings } = await readVaultBindings(ctx.vaultPath);
                    if (bindings.length > 0) {
                        setBindings(bindings);
                        // Default logic: Team mode takes priority.
                        const teamBinding = bindings.find(b => b.mode === 'team');
                        const personalBinding = bindings.find(b => b.mode === 'personal');

                        const selectedBinding = teamBinding || personalBinding || null;

                        if (selectedBinding) {
                            if (!selectedBinding.teamVaultName && selectedBinding.mode === 'team') {
                                try {
                                    const resp = await fetch(`${selectedBinding.serverUrl.replace(/\/+$/, '')}/api/server/info`);
                                    if (resp.ok) {
                                        const info = await resp.json();
                                        const tNode = (info.teams || []).find((t: any) => t.id === selectedBinding.teamVaultId);
                                        if (tNode) selectedBinding.teamVaultName = tNode.name;
                                        else if (info.team_name) selectedBinding.teamVaultName = info.team_name;
                                    }
                                } catch { /* ignore */ }
                            }

                            setHighestBinding(selectedBinding);
                            ctx.setServerUrl(selectedBinding.serverUrl);

                            if (selectedBinding.mode === 'team') {
                                ctx.setSelectedTeamId(selectedBinding.teamVaultId || '');
                                const savedGlobal = localStorage.getItem('slash_remember_me_username');
                                if (savedGlobal) {
                                    ctx.setUsername(savedGlobal);
                                } else if ((selectedBinding as any).username) {
                                    ctx.setUsername((selectedBinding as any).username);
                                } else if (selectedBinding.displayName) {
                                    ctx.setUsername(selectedBinding.displayName);
                                }
                            }
                        }
                    }
                } catch {
                    // ignore
                }
            }
        };
        fetchHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx.vaultPath]);

    const isTeam = highestBinding?.mode === 'team';
    const isPersonal = highestBinding?.mode === 'personal';
    const hasTeamBinding = bindings.some(b => b.mode === 'team');
    const hasPersonalBinding = bindings.some(b => b.mode === 'personal');

    const handleUnifiedLogin = () => {
        if (isTeam) {
            ctx.handleLogin();
        } else if (isPersonal) {
            // 已有绑定的个人 Vault，逻辑取决于服务器当前是否设有 PIN
            if (ctx.serverInfo?.has_pin) {
                ctx.handleConnectPersonal();
            } else {
                // 如果服务器没有 PIN (可能被重置或升级)，使用配对码 (access_code) 重新确权
                ctx.handlePair();
            }
        }
    };

    const isInputDisabled = ctx.loading || !ctx.serverUrl.trim() ||
        (isTeam ? (!ctx.username.trim() || !ctx.password.trim()) : !ctx.accessCode.trim());

    return (
        <div className="space-y-6 relative w-full pb-2 z-10 font-sans">
            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes orb-float {
                    0% { transform: translate(0, 0) scale(1); opacity: 0.15; }
                    33% { transform: translate(30px, -50px) scale(1.1); opacity: 0.25; }
                    66% { transform: translate(-20px, 20px) scale(0.9); opacity: 0.2; }
                    100% { transform: translate(0, 0) scale(1); opacity: 0.15; }
                }
                @keyframes orb-float-reverse {
                    0% { transform: translate(0, 0) scale(1); opacity: 0.15; }
                    33% { transform: translate(-30px, 40px) scale(1.2); opacity: 0.2; }
                    66% { transform: translate(40px, -30px) scale(0.8); opacity: 0.25; }
                    100% { transform: translate(0, 0) scale(1); opacity: 0.15; }
                }
                .orb-1 { animation: orb-float 15s ease-in-out infinite; }
                .orb-2 { animation: orb-float-reverse 18s ease-in-out infinite; }
                .glass-panel {
                    background: rgba(255, 255, 255, 0.7);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.5);
                    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.04);
                }
                .dark .glass-panel {
                    background: transform;
                    background: rgba(24, 24, 27, 0.45);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
                    backdrop-filter: blur(24px);
                    -webkit-backdrop-filter: blur(24px);
                }
                .glass-input {
                    background: rgba(244, 244, 245, 0.6);
                    border: 1px solid rgba(228, 228, 231, 0.8);
                }
                .dark .glass-input {
                    background: rgba(39, 39, 42, 0.4);
                    border: 1px solid rgba(63, 63, 70, 0.5);
                }
                .glass-input:focus {
                    background: #ffffff;
                }
                .dark .glass-input:focus {
                    background: rgba(39, 39, 42, 0.8);
                }
            `}} />

            {/* Background Atmosphere Orbs */}
            <div className="absolute top-0 right-5 w-56 h-56 bg-[#002FA7]/40 dark:bg-[#002FA7]/30 rounded-full blur-[60px] orb-1 pointer-events-none -z-10" />
            <div className="absolute bottom-10 left-5 w-64 h-64 bg-[#002FA7]/30 dark:bg-[#006540]/20 rounded-full blur-[60px] orb-2 pointer-events-none -z-10" />

            {highestBinding ? (
                <div className="glass-panel p-6 rounded-2xl relative overflow-hidden space-y-5">
                    {/* Inner highlight for 3D edge effect */}
                    <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/40 dark:via-white/5 to-transparent shadow-[0_1px_8px_rgba(255,255,255,0.2)] dark:shadow-none" />

                    {/* 状态展示区 */}
                    <div className="mb-2">
                        <div className="flex items-center gap-3.5 pb-4 border-b border-zinc-200/50 dark:border-zinc-700/50">
                            <div className={cn(
                                "shrink-0 w-11 h-11 rounded-full flex items-center justify-center shadow-sm border",
                                isTeam ? "bg-[#002FA7]/10 dark:bg-[#002FA7]/20 text-[#002FA7] dark:text-blue-400 border-[#002FA7]/30 dark:border-blue-500/30"
                                    : "bg-[#002FA7]/10 dark:bg-[#002FA7]/20 text-[#002FA7] dark:text-blue-400 border-[#002FA7]/30 dark:border-blue-500/30"
                            )}>
                                {isTeam ? <Users size={20} strokeWidth={2} /> : <KeyRound size={20} strokeWidth={2} />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate tracking-tight">
                                    {isTeam ? (
                                        highestBinding.teamVaultName || t('sync.unknown_team', 'Team Workspace')
                                    ) : t('sync.tab_personal', 'Personal Workspace')}
                                </h4>
                                <p className="text-[12px] font-medium text-[#545454] dark:text-[#C8C8C8] truncate mt-0.5 flex items-center">
                                    <span className="opacity-80 font-mono tracking-tight">{highestBinding.serverUrl.replace('https://', '').replace('http://', '')}</span>
                                    {isTeam && ctx.username && <span className="ml-2 px-2 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-100/80 dark:bg-zinc-800 text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8]">{ctx.username}</span>}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* 密码/PIN 输入区 */}
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[#545454] dark:text-[#C8C8C8] tracking-wider uppercase ml-1">
                                {isTeam
                                    ? t('sync.password_label', '请输入密码')
                                    : (ctx.serverInfo?.has_pin ? t('sync.enter_pin', '请输入 PIN') : t('sync.pair_code', '请输入配对码'))}
                            </label>
                            {isTeam ? (
                                <div className="space-y-3">
                                    <input
                                        type="password"
                                        value={ctx.password} onChange={(e) => ctx.setPassword(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && !isInputDisabled && handleUnifiedLogin()}
                                        placeholder={t('sync.password_placeholder')}
                                        className="glass-input w-full px-3.5 py-2.5 text-[14px] font-medium rounded-xl text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-[#002FA7]/50 dark:focus:border-blue-400/50 focus:ring-4 focus:ring-[#002FA7]/10 dark:focus:ring-blue-400/15 transition-all shadow-inner"
                                    />
                                    <label className="flex items-center gap-2.5 px-1 cursor-pointer w-max group">
                                        <div className="relative flex items-center justify-center">
                                            <input type="checkbox" checked={ctx.rememberMe} onChange={(e) => ctx.setRememberMe(e.target.checked)} className="sr-only" />
                                            <div className={cn(
                                                "w-4 h-4 rounded-[4px] border transition-colors flex items-center justify-center shadow-sm",
                                                ctx.rememberMe
                                                    ? "bg-[#002FA7] border-[#002FA7]"
                                                    : "border-zinc-300 dark:border-zinc-600 bg-white/50 dark:bg-zinc-800/50"
                                            )}>
                                                <svg className={cn(
                                                    "w-3 h-3 text-white transition-all duration-200",
                                                    ctx.rememberMe ? "opacity-100 scale-100" : "opacity-0 scale-50"
                                                )} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
                                            </div>
                                        </div>
                                        <span className="text-[12px] font-medium text-[#545454] dark:text-[#C8C8C8] group-hover:text-zinc-700 dark:group-hover:text-zinc-200 transition-colors">{t('sync.remember_credentials', '记住凭据')}</span>
                                    </label>
                                </div>
                            ) : (
                                <input
                                    type="password"
                                    value={ctx.accessCode} onChange={(e) => ctx.setAccessCode(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && !isInputDisabled && handleUnifiedLogin()}
                                    placeholder={ctx.serverInfo?.has_pin ? t('sync.pin_input_placeholder') : t('sync.pair_code_placeholder', '服务器已重置，请输入配对码重新连接')}
                                    className="glass-input w-full px-3.5 py-2.5 text-[14px] font-mono tracking-widest rounded-xl text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-[#002FA7]/50 dark:focus:border-blue-400/50 focus:ring-4 focus:ring-[#002FA7]/10 dark:focus:ring-blue-400/15 transition-all shadow-inner"
                                />
                            )}
                        </div>

                        {ctx.error && (
                            <div className="text-left bg-white dark:bg-[#A42227]/10 p-3 rounded-xl border border-[#A42227]/30 dark:border-[#A42227]/20 shadow-xs">
                                <p className="text-[12px] text-[#A42227] dark:text-[#A42227] font-semibold break-all leading-relaxed">{ctx.error.split('\n')[0]}</p>
                            </div>
                        )}

                        <button
                            onClick={handleUnifiedLogin}
                            disabled={isInputDisabled}
                            className={cn(
                                "relative overflow-hidden w-full flex items-center justify-center gap-2 mt-2 px-4 py-3 text-sm font-bold rounded-xl transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 border border-transparent min-h-[44px] group shadow-md hover:shadow-lg",
                                isInputDisabled
                                    ? "bg-zinc-200/60 dark:bg-zinc-800/60 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed shadow-none"
                                    : isTeam
                                        ? "bg-[#002FA7] hover:bg-[#002FA7] text-white focus:ring-[#002FA7]/50 hover:-translate-y-0.5"
                                        : "bg-[#002FA7] hover:bg-[#002FA7] text-white focus:ring-[#002FA7]/50 hover:-translate-y-0.5"
                            )}
                        >
                            {!isInputDisabled && <div className="absolute inset-0 w-full h-full bg-linear-to-t from-black/10 to-transparent pointer-events-none" />}
                            <span className="relative z-10 flex items-center justify-center pointer-events-none">
                                {ctx.loading && <Loader2 size={18} className="animate-spin mr-2" />}
                                <span>{ctx.loading ? t('sync.connecting_btn') : t('sync.connect_btn')}</span>
                            </span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="glass-panel flex flex-col items-center justify-center py-10 px-6 text-center rounded-2xl mb-6 shadow-sm">
                    <div className="relative mb-6 flex items-center justify-center group cursor-default">
                        <div className="absolute w-44 h-44 opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all duration-700 pointer-events-none mix-blend-multiply dark:mix-blend-lighten" style={{ background: 'radial-gradient(circle, rgba(0,47,167,0.18) 0%, rgba(0,47,167,0) 65%)' }} />
                        <div className="relative w-20 h-20 rounded-3xl bg-linear-to-br from-white to-[#002FA7]/5 dark:from-zinc-800 dark:to-[#002FA7]/20 shadow-xl dark:shadow-md border border-white dark:border-blue-500/30 flex items-center justify-center transform transition-all duration-500 group-hover:-translate-y-1.5 ring-4 ring-[#002FA7]/10 dark:ring-blue-400/20 backdrop-blur-md">
                            <Cloud className="text-[#002FA7] dark:text-blue-400 transition-transform duration-500 group-hover:scale-110" size={34} strokeWidth={1.5} />
                        </div>
                    </div>
                    <h3 className="text-[18px] font-extrabold text-zinc-900 dark:text-white mb-2.5 tracking-tight">
                        {t('sync.welcome_title', '开启云端之旅')}
                    </h3>
                    <p className="text-[13px] font-medium text-[#545454] dark:text-[#C8C8C8] px-4 leading-relaxed max-w-[340px]">
                        {t('sync.no_remote_workspace', '检测到当前仓库尚未关联任何云空间，您可以选择以下任何一种方式来开启您的云端之旅')}
                    </p>
                </div>
            )}

            {/* 三大入口区 - 特化卡片 */}
            <div className={cn("grid gap-3", hasTeamBinding ? "grid-cols-2" : "grid-cols-3")}>
                <button
                    onClick={async () => {
                        ctx.setError('');
                        if (hasTeamBinding) {
                            const { confirm } = await import('@tauri-apps/plugin-dialog');
                            const shouldClose = await confirm(
                                t('sync.already_bound_new_vault_prompt', '当前 Vault 已绑定团队，如需创建/加入新团队需建立新的本地 Vault。是否立刻返回仓库引导页？'),
                                { title: 'Slash', kind: 'warning' }
                            );
                            if (shouldClose) {
                                window.dispatchEvent(new CustomEvent('vault:force-close'));
                                // Prevent reload since React will re-render WelcomeScreen naturally.
                            }
                            return;
                        }
                        if (hasPersonalBinding && !hasTeamBinding) {
                            if (!syncService.getConfig()?.accessToken) {
                                // 架构修复：强阻断“无授权状态机器越权”。记录意图并让用户先输入密码解锁
                                ctx.setPostLoginRedirect('create_team');
                                ctx.setError(t('sync.upgrade_requires_login', '请输入 PIN 码连接您的个人云空间后升级'));
                                return;
                            }
                        }
                        ctx.setStep('create_team');
                    }}
                    className="glass-panel group relative flex flex-col items-center justify-center gap-2.5 px-2 py-5 rounded-xl transition-all duration-300 hover:shadow-[0_8px_20px_rgba(16,185,129,0.12)] hover:-translate-y-1 border-transparent hover:border-[#006540]/60 dark:hover:border-[#006540]/40 overflow-hidden"
                >
                    <div className="absolute inset-0 bg-linear-to-br from-[#006540]/0 to-[#006540]/0 group-hover:from-[#006540]/5 dark:group-hover:from-[#006540]/10 transition-colors duration-300" />
                    <div className="w-10 h-10 rounded-full bg-[#006540]/10 dark:bg-[#006540]/20 flex items-center justify-center group-hover:-translate-y-0.5 transition-transform duration-300 shadow-sm border border-[#006540]/30 dark:border-[#006540]/30">
                        <UserPlus size={18} className="text-[#006540] dark:text-[#006540] group-hover:scale-110 transition-transform duration-300" />
                    </div>
                    <span className="text-[12px] font-bold text-[#545454] dark:text-[#C8C8C8] group-hover:text-[#006540] dark:group-hover:text-[#006540] transition-colors text-center tracking-wide leading-tight">
                        {hasPersonalBinding && !hasTeamBinding ? t('sync.upgrade_to_team_space', '升级为团队空间') : t('sync.create_team_space', '创建团队空间')}
                    </span>
                </button>

                <button
                    onClick={async () => {
                        ctx.setError('');
                        if (hasTeamBinding) {
                            const { confirm } = await import('@tauri-apps/plugin-dialog');
                            const shouldClose = await confirm(
                                t('sync.already_bound_new_vault_prompt', '当前 Vault 已绑定团队，如需创建/加入新团队需建立新的本地 Vault。是否立刻返回仓库引导页？'),
                                { title: 'Slash', kind: 'warning' }
                            );
                            if (shouldClose) {
                                window.dispatchEvent(new CustomEvent('vault:force-close'));
                                // Prevent reload since React will re-render WelcomeScreen naturally.
                            }
                            return;
                        }
                        ctx.setStep('join_team');
                    }}
                    className="glass-panel group relative flex flex-col items-center justify-center gap-2.5 px-2 py-5 rounded-xl transition-all duration-300 hover:shadow-[0_8px_20px_rgba(139,92,246,0.12)] hover:-translate-y-1 border-transparent hover:border-[#002FA7]/60 dark:hover:border-blue-400/45 overflow-hidden"
                >
                    <div className="absolute inset-0 bg-linear-to-br from-[#002FA7]/0 to-[#002FA7]/0 group-hover:from-[#002FA7]/5 dark:group-hover:from-[#002FA7]/10 transition-colors duration-300" />
                    <div className="w-10 h-10 rounded-full bg-[#002FA7]/10 dark:bg-[#002FA7]/20 flex items-center justify-center group-hover:-translate-y-0.5 transition-transform duration-300 shadow-sm border border-[#002FA7]/30 dark:border-blue-500/30">
                        <Users size={18} className="text-[#002FA7] dark:text-blue-400 group-hover:scale-110 transition-transform duration-300" />
                    </div>
                    <span className="text-[12px] font-bold text-[#545454] dark:text-[#C8C8C8] group-hover:text-[#002FA7] dark:group-hover:text-blue-300 transition-colors text-center tracking-wide leading-tight">
                        {t('sync.join_team_entry_short', '加入团队空间')}
                    </span>
                </button>

                {!hasTeamBinding && (
                    <button
                        onClick={() => { ctx.setServerUrl(''); ctx.setAccessCode(''); ctx.setError(''); ctx.setStep('pair_input'); }}
                        className="glass-panel group relative flex flex-col items-center justify-center gap-2.5 px-2 py-5 rounded-xl transition-all duration-300 hover:shadow-[0_8px_20px_rgba(84,84,84,0.12)] hover:-translate-y-1 border-transparent hover:border-[#C8C8C8]/60 dark:hover:border-[#545454]/40 overflow-hidden"
                    >
                        <div className="absolute inset-0 bg-linear-to-br from-[#C8C8C8]/0 to-[#C8C8C8]/0 group-hover:from-[#C8C8C8]/10 dark:group-hover:from-[#545454]/10 transition-colors duration-300" />
                        <div className="w-10 h-10 rounded-full bg-[#C8C8C8]/20 dark:bg-[#545454]/20 flex items-center justify-center group-hover:-translate-y-0.5 transition-transform duration-300 shadow-sm border border-[#C8C8C8]/50 dark:border-[#545454]/50">
                            <Cloud size={18} className="text-[#545454] dark:text-[#C8C8C8] group-hover:scale-110 transition-transform duration-300" />
                        </div>
                        <span className="text-[12px] font-bold text-[#545454] dark:text-[#C8C8C8] group-hover:text-zinc-900 dark:group-hover:text-zinc-100 transition-colors text-center tracking-wide leading-tight">
                            {t('sync.create_personal_space', '个人云空间')}
                        </span>
                    </button>
                )}
            </div>
        </div>
    );
};
