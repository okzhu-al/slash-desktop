/**
 * CreateTeamStep — 创建团队空间
 * BUG-A01: 新增配对码字段（仅在无预存 token 时显示）
 * BUG-A04: 表单分组重排：连接信息 → 团队名称 → 管理员账户
 */
import { Users, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { PasswordInput } from '../components/PasswordInput';
import { syncService } from '@/services/SyncService';
import type { SyncFlowContext } from '../useSyncFlow';

export const CreateTeamStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    const hasToken = !!syncService.getConfig()?.accessToken;

    const canSubmit = ctx.serverUrl.trim() && ctx.teamName.trim() && ctx.username.trim() && ctx.displayName.trim()
        && ctx.password.trim() && ctx.passwordConfirm.trim() && ctx.password === ctx.passwordConfirm
        && (hasToken || ctx.accessCode.trim()); // 无 token 时需要配对码

    return (
        <div className="space-y-2">
            <BackButton to={ctx.personalVault ? 'choose_mode' : 'welcome'} onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/30 p-5 shadow-sm space-y-4">
                <h4 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5 pb-1">
                    <Users size={16} className="text-[#006540]" /> {t('sync.create_team_title')}
                </h4>

                <div className="space-y-3.5">
                    {/* 1. Server URL */}
                    <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block">{t('sync.server_url')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.serverUrl} onChange={(e) => ctx.setServerUrl(e.target.value)} placeholder="http://server:3721"
                            className="w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10 transition-all font-mono hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]" />
                    </div>

                    {/* 2. Pairing Code — 仅在无预存 token 时显示 */}
                    {!hasToken && (
                        <div className="space-y-1">
                            <label className="text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block">{t('sync.pair_code')}</label>
                            <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.accessCode} onChange={(e) => ctx.setAccessCode(e.target.value)} placeholder={t('sync.pair_code_placeholder')}
                                className="w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10 transition-all font-mono tracking-widest hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]" />
                            <div className="flex items-center justify-between pt-0.5">
                                <p className="text-[10px] text-[#545454] dark:text-[#C8C8C8] tracking-wide">{t('sync.pair_code_hint_create')}</p>
                                <div className="flex items-center gap-2">
                                    <button type="button" onClick={ctx.handleRequestNewCode}
                                        className="text-[10px] font-medium text-[#006540] dark:text-[#006540] hover:text-[#006540] dark:hover:text-[#006540] transition-colors whitespace-nowrap">
                                        {t('sync.pair_code_expired')}
                                    </button>
                                </div>
                            </div>
                            {ctx.pairCodeMessage && (
                                <p className={cn("text-[11px] font-medium mt-1.5 transition-all text-right", ctx.pairCodeMessage.isError ? "text-[#A42227]" : "text-[#006540]")}>
                                    {ctx.pairCodeMessage.msg}
                                </p>
                            )}
                        </div>
                    )}

                    <div className="border-t border-zinc-200/60 dark:border-zinc-700/60" />

                    {/* 3. Team Name */}
                    <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block">{t('sync.team_name_label')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.teamName} onChange={(e) => ctx.setTeamName(e.target.value)} placeholder={t('sync.team_name_placeholder')}
                            className="w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10 transition-all font-mono tracking-widest hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]" />
                    </div>

                    <div className="border-t border-zinc-200/60 dark:border-zinc-700/60" />

                    {/* 4. Username */}
                    <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block truncate">{t('sync.admin_username_label')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.username} onChange={(e) => ctx.setUsername(e.target.value)} placeholder={t('sync.username_placeholder')}
                            className="w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10 transition-all hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]" />
                    </div>

                    {/* 5. Password + Confirm */}
                    <div className="grid grid-cols-2 gap-3 pb-1">
                        <div className="space-y-1">
                            <PasswordInput label={t('sync.password_label')} value={ctx.password} onChange={ctx.setPassword}
                                placeholder={t('sync.password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                                focusTheme="green" />
                        </div>
                        <div className="space-y-1">
                            <PasswordInput label={t('sync.confirm_password_label')} value={ctx.passwordConfirm} onChange={ctx.setPasswordConfirm}
                                placeholder={t('sync.confirm_password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                                focusTheme="green" />
                        </div>
                    </div>



                    <div className="border-t border-zinc-200/60 dark:border-zinc-700/60" />

                    {/* 6. Display Name */}
                    <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block truncate">{t('sync.team_display_name_label')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.displayName} onChange={(e) => ctx.setDisplayName(e.target.value)} placeholder={t('sync.display_name_placeholder')}
                            onKeyDown={(e) => e.key === 'Enter' && canSubmit && ctx.handleCreateTeam()}
                            className="w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10 transition-all hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]" />
                    </div>
                </div>

                {ctx.passwordConfirm && ctx.password !== ctx.passwordConfirm && <p className="text-[11px] text-[#A42227] font-medium pt-1">{t('sync.password_mismatch')}</p>}
                {ctx.syncResult && !ctx.error && <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium bg-amber-50 dark:bg-amber-500/10 p-2.5 rounded-md border border-amber-100 dark:border-amber-500/20">{ctx.syncResult}</p>}
                
                {ctx.error && (
                    <div className="text-left bg-white dark:bg-[#A42227]/10 p-3 rounded-xl border border-[#A42227]/30 dark:border-[#A42227]/20 shadow-xs">
                        <p className="text-[12px] text-[#A42227] dark:text-[#A42227] font-semibold break-all leading-relaxed">{ctx.error}</p>
                    </div>
                )}
                
                <div className="pt-2">
                    <button onClick={ctx.handleCreateTeam}
                        disabled={ctx.loading || !canSubmit}
                        className={cn(
                            "w-full flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-semibold rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:ring-offset-1 focus:ring-offset-white dark:focus:ring-offset-zinc-900 shadow-sm",
                            ctx.loading || !canSubmit 
                                ? "bg-zinc-100 dark:bg-zinc-800/50 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed border border-zinc-200/50 dark:border-zinc-700/50 shadow-none" 
                                : "bg-[#006540] hover:bg-[#006540] text-white border border-transparent hover:shadow min-h-[42px]"
                        )}>
                        {ctx.loading ? <><Loader2 size={16} className="animate-spin" /> {t('sync.creating_team_btn')}</> : t('sync.create_team_btn')}
                    </button>
                </div>
            </div>
        </div>
    );
};
