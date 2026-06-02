/**
 * SyncStatusIndicator — 侧边栏同步状态指示器
 *
 * 集成 AutoSyncManager：
 * - 实时显示同步状态（idle/syncing/success/error）
 * - 显示上次同步时间（tooltip）
 * - 点击触发手动同步 or 打开设置
 */
import { useState, useEffect, useCallback } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { syncService } from '@/services/SyncService';
import { autoSyncManager, AutoSyncEvent, AutoSyncStatus } from '@/services/AutoSyncManager';


interface SyncStatusIndicatorProps {
    vaultPath?: string;
    onOpenSyncSettings?: () => void;
}

export const SyncStatusIndicator = ({ vaultPath, onOpenSyncSettings }: SyncStatusIndicatorProps) => {
    const { t } = useTranslation();
    const [isConfigured, setIsConfigured] = useState(() => syncService.isConfigured());
    const [status, setStatus] = useState<AutoSyncStatus>(() =>
        syncService.isConfigured() ? 'idle' : 'disabled'
    );
    const [lastConnected, setLastConnected] = useState(true);

    // 监听 sync config 变化（connect/disconnect/vault switch）
    useEffect(() => {
        const handleConfigChanged = () => {
            const configured = syncService.isConfigured();
            setIsConfigured(configured);
            if (!configured) {
                setStatus('disabled');
                setLastConnected(false);
            } else {
                setStatus('idle');
                setLastConnected(true);
            }
        };
        window.addEventListener('sync:config-changed', handleConfigChanged);

        // Token 过期事件
        const handleAuthExpired = () => {
            setStatus('error');
            setLastConnected(false);
        };
        window.addEventListener('sync:auth-expired', handleAuthExpired);

        const handlePhysicalDisconnected = () => {
            setStatus('offline');
            setLastConnected(false);
        };
        window.addEventListener('sync:physical-disconnected', handlePhysicalDisconnected);

        return () => {
            window.removeEventListener('sync:config-changed', handleConfigChanged);
            window.removeEventListener('sync:auth-expired', handleAuthExpired);
            window.removeEventListener('sync:physical-disconnected', handlePhysicalDisconnected);
        };
    }, []);

    // 订阅 AutoSyncManager 状态
    useEffect(() => {
        if (!isConfigured) return;

        const unsubscribe = autoSyncManager.onStatusChange((event: AutoSyncEvent) => {
            setStatus(event.status);
            if (event.status === 'offline' || event.status === 'error' || event.status === 'disabled') {
                setLastConnected(false);
            } else if (event.status === 'success' || event.status === 'idle') {
                setLastConnected(true);
            }
        });

        return unsubscribe;
    }, [isConfigured]);

    const handleClick = useCallback(async () => {
        // 未配置 → 打开 Settings Sync tab
        if (!isConfigured) {
            onOpenSyncSettings?.();
            return;
        }

        if (!vaultPath || status === 'syncing') return;

        // 手动触发同步
        await autoSyncManager.manualSync();
    }, [vaultPath, status, isConfigured, onOpenSyncSettings]);

    const iconProps = { size: 18, strokeWidth: 1.5 };

    // 仅在已知在线且状态也为连线时，才显示连线状态（防止离线重试时一会绿一会红的闪烁）
    const isOnline = lastConnected && ['idle', 'syncing', 'success'].includes(status);

    const config = {
        icon: isOnline ? <Cloud {...iconProps} /> : <CloudOff {...iconProps} />,
        className: isOnline 
            ? 'text-[#006540] dark:text-[#006540]/80 hover:opacity-80' 
            : 'text-[#A42227] dark:text-[#A42227]/80 hover:opacity-80',
        title: isOnline 
            ? t('sync.server_connected', '已连接服务端') 
            : t('sync.server_disconnected', '离线/未连接服务端'),
    };

    return (
        <button
            onClick={handleClick}
            disabled={status === 'syncing'}
            className={cn(
                'w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors',
                'hover:bg-black/5 dark:hover:bg-white/5',
                'disabled:cursor-wait',
                config.className,
            )}
            title={config.title}
        >
            {config.icon}
        </button>
    );
};
