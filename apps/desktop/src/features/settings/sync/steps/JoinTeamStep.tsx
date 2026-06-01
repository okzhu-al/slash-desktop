/**
 * JoinTeamStep — 加入团队（邀请码 + 注册）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { PasswordInput } from '../components/PasswordInput';
import { syncInputClass, syncLabelClass } from '../components/formStyles';
import type { SyncFlowContext } from '../useSyncFlow';

export const JoinTeamStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    const canSubmit = ctx.serverUrl.trim() && ctx.inviteCode.trim() && ctx.username.trim() && ctx.displayName.trim()
        && ctx.password.trim() && ctx.passwordConfirm.trim() && ctx.password === ctx.passwordConfirm;

    const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
    const probedRef = useRef('');

    const probe = useCallback(async (url: string) => {
        const baseUrl = url.replace(/\/+$/, '');
        if (!baseUrl || probedRef.current === baseUrl) return;
        probedRef.current = baseUrl;

        ctx.setError('');
        try {
            const resp = await fetch(`${baseUrl}/api/server/info`);
            if (!resp.ok) {
                probedRef.current = '';
                return;
            }
            const info = await resp.json();
            if (info.teams && info.teams.length > 0) {
                setTeams(info.teams);
            } else if (info.has_team && info.team_name) {
                setTeams([{ id: info.team_vault_id || '', name: info.team_name }]);
            } else {
                setTeams([]);
            }
        } catch {
            probedRef.current = '';
        }
    }, [ctx]);

    useEffect(() => {
        const url = ctx.serverUrl.trim();
        if (!url || !url.startsWith('http')) return;

        const timer = setTimeout(() => {
            probe(url);
        }, 500);

        return () => clearTimeout(timer);
    }, [ctx.serverUrl, probe]);

    useEffect(() => {
        if (teams.length > 1 && !ctx.selectedTeamId) {
            ctx.setSelectedTeamId(teams[0].id);
        } else if (teams.length === 1) {
            ctx.setSelectedTeamId(teams[0].id);
        }
    }, [teams, ctx]);

    const handleUrlBlur = () => {
        const url = ctx.serverUrl.trim();
        if (url) {
            probedRef.current = '';
            probe(ctx.serverUrl);
        }
    };

    return (
        <div className="space-y-3">
            <BackButton to={ctx.personalVault ? 'choose_mode' : 'welcome'} onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/30 p-4 shadow-sm space-y-3">

                <h4 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5 pb-1">
                    <span className="text-base leading-none filter grayscale opacity-80">🎫</span> {t('sync.join_team_title')}
                </h4>

                <div className="space-y-3.5">

                    <div className="space-y-1">
                        <label className={syncLabelClass}>{t('sync.server_url')}</label>
                        <div className="flex w-full gap-2 text-[13px]">
                            <input autoCapitalize="off" autoCorrect="off" type="text"
                                value={ctx.serverUrl}
                                onChange={(e) => { ctx.setServerUrl(e.target.value); ctx.setError(''); }}
                                onBlur={handleUrlBlur}
                                onKeyDown={(e) => { if (e.key === 'Enter' && ctx.serverUrl.trim()) { (e.target as HTMLInputElement).blur(); } }}
                                placeholder="http://your-server:3721"
                                className={cn(syncInputClass('blue'), 'min-w-0 flex-1 font-mono')}
                            />

                            <div className={cn(
                                "shrink-0 min-w-[120px] flex items-center relative rounded-lg border border-zinc-200 dark:border-zinc-600/60 transition-colors duration-300 shadow-sm overflow-hidden",
                                teams.length > 1
                                    ? "bg-[#002FA7] dark:bg-blue-500/15 hover:bg-[#002FA7] dark:hover:bg-blue-500/20"
                                    : "bg-zinc-100/60 dark:bg-zinc-700/30"
                            )}>
                                {teams.length > 1 ? (
                                    <>
                                        <select
                                            value={ctx.selectedTeamId}
                                            onChange={(e) => ctx.setSelectedTeamId(e.target.value)}
                                            className="w-full h-full pl-3 pr-8 py-2 bg-transparent text-white dark:text-blue-300 focus:outline-none appearance-none cursor-pointer truncate font-medium z-10"
                                        >
                                            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                        </select>
                                        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-white dark:text-blue-300 z-0">
                                            <ChevronDown size={14} />
                                        </div>
                                    </>
                                ) : (
                                    <div className="w-full h-full px-3 py-2 text-[#545454] dark:text-[#C8C8C8] flex items-center cursor-not-allowed select-none truncate">
                                        {teams.length === 1 ? teams[0].name : t('sync.default_team_placeholder')}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-1">
                        <label className={syncLabelClass}>{t('sync.invite_code_label', 'Invite Code')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.inviteCode} onChange={(e) => ctx.setInviteCode(e.target.value)} placeholder={t('sync.invite_code_placeholder')}
                            className={cn(syncInputClass('blue'), 'font-mono tracking-widest')} />
                    </div>

                    <div className="border-t border-zinc-100 dark:border-zinc-700/40 my-2" />

                    <div className="space-y-1">
                        <label className={syncLabelClass}>{t('sync.username_label')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.username} onChange={(e) => ctx.setUsername(e.target.value)} placeholder={t('sync.username_placeholder')}
                            className={syncInputClass('blue')} />
                    </div>

                    <div className="space-y-1">
                        <PasswordInput label={t('sync.password_label')} value={ctx.password} onChange={ctx.setPassword}
                            placeholder={t('sync.password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                            wrapperClassName=""
                            labelClassName={syncLabelClass}
                            inputClassName="font-mono"
                            focusTheme="blue" />
                    </div>

                    <div className="space-y-1">
                        <PasswordInput label={t('sync.confirm_password_label', 'Confirm Password')} value={ctx.passwordConfirm} onChange={ctx.setPasswordConfirm}
                            placeholder={t('sync.confirm_password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                            wrapperClassName=""
                            labelClassName={syncLabelClass}
                            inputClassName="font-mono"
                            focusTheme="blue"
                        />
                    </div>

                    <div className="space-y-1">
                        <label className={syncLabelClass}>{t('sync.team_display_name_label', 'Team Display Name')}</label>
                        <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.displayName} onChange={(e) => ctx.setDisplayName(e.target.value)} placeholder={t('sync.display_name_placeholder')}
                            onKeyDown={(e) => e.key === 'Enter' && canSubmit && ctx.handleTeamJoin()}
                            className={syncInputClass('blue')} />
                    </div>
                </div>

                {ctx.passwordConfirm && ctx.password !== ctx.passwordConfirm && <p className="text-[11px] text-[#A42227] font-medium">{t('sync.password_mismatch')}</p>}
                {ctx.error && <p className="text-[11px] text-[#A42227] font-semibold bg-white dark:bg-[#A42227]/10 p-3 rounded-xl border border-[#A42227]/30 dark:border-[#A42227]/20 shadow-xs leading-relaxed">{ctx.error}</p>}

                <button onClick={() => ctx.handleTeamJoin()}
                    disabled={ctx.loading || !canSubmit}
                    className={cn(
                        "w-full flex items-center justify-center gap-2 px-4 py-2 mt-1 text-sm font-semibold rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-[#002FA7]/50 focus:ring-offset-1 focus:ring-offset-white dark:focus:ring-offset-zinc-900",
                        ctx.loading || !canSubmit
                            ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed border border-transparent shadow-none"
                            : "bg-[#002FA7] hover:bg-[#002FA7] text-white border border-transparent hover:shadow min-h-[40px]"
                    )}>
                    {ctx.loading ? <><Loader2 size={16} className="animate-spin" /> {t('sync.joining_team_btn')}</> : t('sync.join_team_btn')}
                </button>
            </div>
        </div>
    );
};
