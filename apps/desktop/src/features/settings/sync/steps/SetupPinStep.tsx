/**
 * SetupPinStep — PIN 设置 / PIN 重置
 */
import { Check, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { BackButton } from '../components/BackButton';
import { syncInputClass } from '../components/formStyles';
import type { SyncFlowContext } from '../useSyncFlow';

export const SetupPinStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();

    // 如果已有 PIN 且不是重置流程，直接显示完成状态
    if ((ctx.serverInfo?.has_pin || ctx.pinSet) && !ctx.pinResetMode) {
        return (
            <div className="space-y-4">
                <div className="rounded-lg border border-[#006540] dark:border-[#006540] bg-[#006540] dark:bg-[#006540]/20 p-4 text-center space-y-2">
                    <Check size={24} className="mx-auto text-[#006540]" />
                    <p className="text-sm text-[#006540] dark:text-[#006540]">{t('sync.pin_already_set')}</p>
                    <button onClick={ctx.handlePinComplete}
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-[#002FA7] hover:bg-[#002FA7] text-white transition-colors">
                        {t('sync.pin_start_sync')}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <BackButton to="choose_mode" onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-3">
                <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                    <KeyRound size={16} className="text-amber-500" /> {t('sync.setup_pin_title')}
                </h4>
                <p className="text-xs text-[#545454] dark:text-[#C8C8C8]">{t('sync.setup_pin_desc')}</p>
                <input autoCapitalize="off" autoCorrect="off" type="text" value={ctx.newPin} onChange={(e) => ctx.setNewPin(e.target.value)}
                    placeholder={t('sync.pin_placeholder')} maxLength={8} onKeyDown={(e) => e.key === 'Enter' && ctx.newPin.trim().length >= 4 && handlePinAndComplete()}
                    className={cn(syncInputClass('blue'), 'font-mono tracking-widest')} />
                {ctx.error && <p className="text-xs text-[#A42227]">{ctx.error}</p>}
                <button onClick={handlePinAndComplete}
                    disabled={ctx.newPin.trim().length < 4}
                    className={cn('w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors',
                        ctx.newPin.trim().length < 4 ? 'bg-[#002FA7] text-white cursor-not-allowed' : 'bg-[#002FA7] hover:bg-[#002FA7] text-white')}>
                    {t('sync.pin_save_btn')}
                </button>
            </div>
        </div>
    );

    async function handlePinAndComplete() {
        await ctx.handleSetPin();
        if (ctx.newPin.trim().length >= 4) {
            ctx.handlePinComplete();
        }
    }
};
