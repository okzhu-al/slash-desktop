/**
 * ReconnectTeamStep — 团队用户重连（用户名+密码）
 */
import { Users, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { PasswordInput } from '../components/PasswordInput';
import type { SyncFlowContext } from '../useSyncFlow';

export const ReconnectTeamStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <BackButton to="welcome" onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Users size={16} className="text-[#002FA7]" /> {t('sync.reconnect_team_title')}
                </h4>
                <div>
                    <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8] mb-1 block">{t('sync.server_url')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.serverUrl} onChange={(e) => ctx.setServerUrl(e.target.value)} placeholder="http://your-server:3721"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/50" />
                </div>
                <div>
                    <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8] mb-1 block">{t('sync.username_label')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.username} onChange={(e) => ctx.setUsername(e.target.value)} placeholder={t('sync.username_placeholder')}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]/50" />
                </div>
                <PasswordInput label={t('sync.password_label')} value={ctx.password} onChange={ctx.setPassword}
                    placeholder={t('sync.password_placeholder')} showPassword={ctx.showPassword} onToggleShow={() => ctx.setShowPassword(v => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && ctx.username.trim() && ctx.password.trim() && ctx.handleLogin()} />
                {ctx.error && <p className="text-xs text-[#A42227] whitespace-pre-line">{ctx.error}</p>}
                <button onClick={ctx.handleLogin} disabled={ctx.loading || !ctx.serverUrl.trim() || !ctx.username.trim() || !ctx.password.trim()}
                    className={cn('w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors',
                        ctx.loading || !ctx.serverUrl.trim() || !ctx.username.trim() || !ctx.password.trim() ? 'bg-[#006540] text-white cursor-not-allowed' : 'bg-[#006540] hover:bg-[#006540] text-white')}>
                    {ctx.loading ? <><Loader2 size={14} className="animate-spin" /> {t('sync.connecting_btn')}</> : t('sync.connect_btn')}
                </button>
            </div>
        </div>
    );
};
