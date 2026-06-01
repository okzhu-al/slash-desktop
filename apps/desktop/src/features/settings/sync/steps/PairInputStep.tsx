/**
 * PairInputStep — 配对码输入
 */
import { Cloud, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { syncInputClass, syncLabelClass } from '../components/formStyles';
import type { SyncFlowContext } from '../useSyncFlow';

export const PairInputStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <BackButton to="welcome" onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <Cloud size={16} className="text-[#002FA7]" /> {t('sync.connect_cloud')}
                </h4>
                <div>
                    <label className={syncLabelClass}>{t('sync.server_url')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.serverUrl} onChange={(e) => ctx.setServerUrl(e.target.value)}
                        placeholder="http://your-server:3721"
                        className={cn(syncInputClass('blue'), 'font-mono')} />
                </div>
                <div>
                    <label className={syncLabelClass}>{t('sync.pair_code')}</label>
                    <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.accessCode} onChange={(e) => ctx.setAccessCode(e.target.value)}
                        placeholder={t('sync.pair_code_placeholder')} onKeyDown={(e) => e.key === 'Enter' && ctx.serverUrl.trim() && ctx.accessCode.trim() && ctx.handlePair()}
                        className={cn(syncInputClass('blue'), 'font-mono tracking-widest')} />
                </div>
                {ctx.error && (
                    <div className="space-y-2">
                        <p className="text-xs text-[#A42227]">{ctx.error}</p>
                        <button onClick={ctx.handleRequestNewCode}
                            className="text-xs text-[#002FA7] hover:text-[#002FA7] underline cursor-pointer">
                            {t('sync.pair_code_expired')}
                        </button>
                    </div>
                )}
                {ctx.syncResult && !ctx.error && <p className="text-xs text-amber-600 dark:text-amber-400">{ctx.syncResult}</p>}
                <button onClick={ctx.handlePair} disabled={ctx.loading || !ctx.serverUrl.trim() || !ctx.accessCode.trim()}
                    className={cn('w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors',
                        ctx.loading || !ctx.serverUrl.trim() || !ctx.accessCode.trim() ? 'bg-[#002FA7] text-white cursor-not-allowed' : 'bg-[#002FA7] hover:bg-[#002FA7] text-white')}>
                    {ctx.loading ? <><Loader2 size={14} className="animate-spin" /> {t('sync.connecting_btn')}</> : t('sync.connect_btn')}
                </button>
                <p className="text-[11px] text-[#545454] dark:text-[#C8C8C8] text-center">{t('sync.pair_code_hint')}</p>
            </div>
        </div>
    );
};
