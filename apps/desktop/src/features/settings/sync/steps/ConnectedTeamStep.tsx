/**
 * ConnectedTeamStep — 团队已连接状态（双栏布局）
 */
import { FolderOpen, Users, Link } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { syncService } from '@/services/SyncService';
import { ConnectionBanner } from '../components/ConnectionBanner';

import { SyncButton, SyncResult, DisconnectButton } from './ConnectedPersonalStep';
import type { SyncFlowContext } from '../useSyncFlow';

export const ConnectedTeamStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();

    // 从 token 提取用户名
    const tokenUsername = (() => {
        const config = syncService.getConfig();
        if (!config?.accessToken) return '';
        try {
            const parts = config.accessToken.split('.');
            if (parts.length === 3) return JSON.parse(atob(parts[1])).username || '';
        } catch { /* ignore */ }
        return '';
    })();

    return (
        <div className="space-y-4">
            <ConnectionBanner />

            {/* 双栏 */}
            <div className="grid grid-cols-2 gap-3">
                {/* 个人空间 */}
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                        <FolderOpen size={16} className="text-[#002FA7]" />
                        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('sync.personal_vault')}</span>
                    </div>
                    <div className="space-y-1.5 text-xs text-[#545454] dark:text-[#C8C8C8]">
                        <p>📂 {ctx.localVaultName || ctx.personalVault?.name || '—'}</p>
                        <p>📄 {ctx.personalVault ? t('sync.file_count_label', { count: ctx.personalVault.file_count }) : t('sync.not_synced')}</p>
                        {ctx.lastSyncTime && <p>🕐 {new Date(ctx.lastSyncTime).toLocaleString()}</p>}
                    </div>
                    <SyncButton ctx={ctx} />
                </div>

                {/* 团队空间 */}
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                        <Users size={16} className="text-[#002FA7]" />
                        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('sync.team_vault')}</span>
                    </div>
                    {ctx.teamVault ? (
                        <div className="space-y-1.5 text-xs text-[#545454] dark:text-[#C8C8C8]">
                            <p>👥 {ctx.teamVault.name}</p>
                            <p>📄 {t('sync.file_count_label', { count: ctx.teamVault.file_count })}</p>
                            <div className="flex items-center gap-1 text-[#002FA7] dark:text-blue-400">
                                <Link size={10} /><span>{t('sync.binding', { name: ctx.localVaultName })}</span>
                            </div>
                            {tokenUsername && tokenUsername !== '__personal__' && (
                                <div className="flex items-center gap-1.5 pt-1">
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#006540]/10 text-[#006540] dark:bg-[#006540]/20 dark:text-[#006540]">{tokenUsername}</span>
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="text-xs text-[#545454]">{t('sync.not_synced')}</p>
                    )}
                </div>
            </div>



            <SyncResult ctx={ctx} />
            <DisconnectButton ctx={ctx} />
        </div>
    );
};

