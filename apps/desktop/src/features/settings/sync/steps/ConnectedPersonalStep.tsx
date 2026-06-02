/**
 * ConnectedPersonalStep — 个人已连接状态
 */
import { FolderOpen, RefreshCw, Check, AlertCircle, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { ConnectionBanner } from '../components/ConnectionBanner';
import type { SyncFlowContext } from '../useSyncFlow';

export const ConnectedPersonalStep = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <ConnectionBanner />

            {/* 个人空间信息 */}
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4 space-y-3">
                <div className="flex items-center gap-2">
                    <FolderOpen size={16} className="text-[#002FA7] dark:text-blue-400" />
                    <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('sync.personal_vault')}</span>
                </div>
                <div className="space-y-1.5 text-xs text-[#545454] dark:text-[#C8C8C8]">
                    <p>📂 {ctx.localVaultName || ctx.personalVault?.name || '—'}</p>
                    <p>📄 {ctx.personalVault ? t('sync.file_count_label', { count: ctx.personalVault.file_count }) : t('sync.not_synced')}</p>
                    {ctx.lastSyncTime && <p>🕐 {new Date(ctx.lastSyncTime).toLocaleString()}</p>}
                </div>
                <SyncButton ctx={ctx} />
            </div>

            {/* 同步结果 */}
            <SyncResult ctx={ctx} />

            {/* 小字入口：开启团队 */}
            <div className="text-center">
                <button onClick={() => ctx.setStep('create_team')} className="text-xs text-[#545454] hover:text-[#002FA7]/80 dark:hover:text-blue-300 transition-colors">
                    {t('sync.need_team')}
                </button>
            </div>

            {/* 断开连接 */}
            <DisconnectButton ctx={ctx} />
        </div>
    );
};

// ── 共享子组件 ──

export const SyncButton = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <button onClick={ctx.handleSync} disabled={ctx.syncStatus === 'syncing' || !ctx.vaultPath}
            className={cn('w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                ctx.syncStatus === 'syncing' ? 'bg-[#002FA7] text-white cursor-wait' : 'bg-[#002FA7] hover:bg-[#002FA7] text-white', !ctx.vaultPath && 'opacity-50 cursor-not-allowed')}>
            {ctx.syncStatus === 'syncing' ? <><RefreshCw size={12} className="animate-spin" /> {t('sync.syncing')}</> :
             ctx.syncStatus === 'success' ? <><Check size={12} /> {t('sync.sync_done')}</> :
             ctx.syncStatus === 'error' ? <><AlertCircle size={12} /> {t('sync.sync_retry')}</> :
             <><RefreshCw size={12} /> {t('sync.sync_now')}</>}
        </button>
    );
};

export const SyncResult = ({ ctx }: { ctx: SyncFlowContext }) => {
    if (!ctx.syncResult) return null;
    return (
        <p className={cn('text-xs px-3 py-2 rounded-lg',
            ctx.syncStatus === 'success' ? 'text-[#006540] bg-[#006540]/10 dark:text-[#006540] dark:bg-[#006540]/20' : 'text-[#A42227] bg-[#A42227]/10 dark:text-[#A42227] dark:bg-[#A42227]/20')}>
            {ctx.syncResult}
        </p>
    );
};

export const DisconnectButton = ({ ctx }: { ctx: SyncFlowContext }) => {
    const { t } = useTranslation();
    return (
        <button onClick={ctx.handleDisconnect}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs rounded-lg transition-colors border text-[#A42227] hover:bg-[#A42227]/10 dark:hover:bg-[#A42227]/20 border-[#A42227] dark:border-[#A42227]">
            <LogOut size={14} /> {t('sync.disconnect')}
        </button>
    );
};
