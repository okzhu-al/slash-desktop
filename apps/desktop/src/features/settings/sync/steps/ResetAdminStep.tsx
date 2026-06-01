/**
 * ResetAdminStep — 管理员通过配对码重置凭据
 */
import { KeyRound, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { PasswordInput } from '../components/PasswordInput';
import { syncInputClass } from '../components/formStyles';
import type { SyncFlowContext } from '../useSyncFlow';

export const ResetAdminStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    const canSubmit = ctx.username.trim() && ctx.password.trim()
        && ctx.passwordConfirm.trim() && ctx.password === ctx.passwordConfirm;

    return (
        <div className="space-y-4">
            <BackButton to="welcome" onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <KeyRound size={16} className="text-amber-500" /> {t('sync.reset_admin_title')}
                </h4>
                <p className="text-[11px] text-[#545454] dark:text-[#C8C8C8]">{t('sync.reset_admin_desc')}</p>
                <div>
                    <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8] mb-1 block">{t('sync.username_label')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.username} onChange={(e) => ctx.setUsername(e.target.value)} placeholder={t('sync.username_placeholder')}
                        className={syncInputClass('amber')} />
                </div>
                <div>
                    <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8] mb-1 block">{t('sync.display_name_label')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.displayName} onChange={(e) => ctx.setDisplayName(e.target.value)} placeholder={t('sync.display_name_placeholder')}
                        className={syncInputClass('amber')} />
                </div>
                <PasswordInput label={t('sync.new_password_label')} value={ctx.password} onChange={ctx.setPassword}
                    placeholder={t('sync.password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                    focusTheme="amber" />
                <PasswordInput label={t('sync.confirm_password_label')} value={ctx.passwordConfirm} onChange={ctx.setPasswordConfirm}
                    placeholder={t('sync.confirm_password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && canSubmit && ctx.handleAdminReset()}
                    focusTheme="amber" />
                {ctx.passwordConfirm && ctx.password !== ctx.passwordConfirm && <p className="text-[11px] text-[#A42227]">{t('sync.password_mismatch')}</p>}
                {ctx.error && <p className="text-xs text-[#A42227] whitespace-pre-line">{ctx.error}</p>}
                <button onClick={ctx.handleAdminReset}
                    disabled={ctx.loading || !canSubmit}
                    className={cn('w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors',
                        ctx.loading || !canSubmit ? 'bg-amber-400 text-white cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600 text-white')}>
                    {ctx.loading ? <><Loader2 size={14} className="animate-spin" /> {t('sync.resetting_btn')}</> : t('sync.reset_admin_btn')}
                </button>
            </div>
        </div>
    );
};
