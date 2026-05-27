/**
 * ConnectionBanner — 已连接状态栏
 */
import { Cloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { syncService } from '@/services/SyncService';

export const ConnectionBanner = () => {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border border-[#006540]/30 dark:border-[#006540]/50 bg-[#006540]/10 dark:bg-[#006540]/20 p-3">
            <div className="flex items-center gap-2">
                <Cloud size={16} className="text-[#006540] dark:text-[#006540]" />
                <span className="text-sm font-medium text-[#006540] dark:text-[#006540]">
                    {t('sync.connected')}
                </span>
                <span className="text-xs text-[#C8C8C8] ml-auto">
                    {syncService.getConfig()?.serverUrl}
                </span>
            </div>
        </div>
    );
};
