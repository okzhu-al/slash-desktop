/**
 * ChooseModeStep — 选择个人/团队模式
 */
import { Cloud, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { syncService } from '@/services/SyncService';
import { BackButton } from '../components/BackButton';
import type { SyncFlowContext } from '../useSyncFlow';

export const ChooseModeStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <BackButton to="connected_personal" onNavigate={ctx.setStep} onClearError={() => ctx.setError('')} />
            
            <div className="rounded-lg border border-[#006540] dark:border-[#006540] bg-[#006540] dark:bg-[#006540]/20 p-3 mt-1">
                <div className="flex items-center gap-2">
                    <Cloud size={16} className="text-[#006540]" />
                    <span className="text-sm font-medium text-[#006540] dark:text-[#006540]">✅ {t('sync.connected_status', '已连接')}</span>
                    <span className="text-xs text-[#545454] ml-auto">{syncService.getConfig()?.serverUrl}</span>
                </div>
            </div>

            <p className="text-sm font-medium text-zinc-700 dark:text-[#C8C8C8]">{t('sync.choose_mode_title', '需要进一步的团队协作？')}</p>
            <div className="space-y-2">
                <button onClick={() => ctx.setStep('join_team')}
                    className="w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-[#002FA7] dark:hover:border-blue-400 bg-white dark:bg-zinc-800/50 hover:bg-[#002FA7]/50 dark:hover:bg-[#002FA7]/10 p-4 transition-colors group">
                    <div className="flex items-center gap-3">
                        <span className="text-xl leading-none filter grayscale opacity-80 group-hover:grayscale-0 group-hover:opacity-100 transition-all duration-300">🎫</span>
                        <div>
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('sync.join_team_entry_short', '加入已有团队')}</p>
                            <p className="text-xs text-[#545454] mt-0.5">{t('sync.join_team_desc', '使用邀请码加入，访问并同步团队共享知识')}</p>
                        </div>
                    </div>
                </button>
                <button onClick={() => ctx.setStep('create_team')}
                    className="w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-[#006540] dark:hover:border-[#006540] bg-white dark:bg-zinc-800/50 hover:bg-[#006540]/50 dark:hover:bg-[#006540]/10 p-4 transition-colors group">
                    <div className="flex items-center gap-3">
                        <Users size={20} className="text-[#006540]" />
                        <div>
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('sync.create_team_space')}</p>
                            <p className="text-xs text-[#545454] mt-0.5">{t('sync.create_team_space_desc')}</p>
                        </div>
                    </div>
                </button>
            </div>
        </div>
    );
};
