/**
 * CollabLockBadge — 悲观锁状态胶囊
 *
 * 显示在 DocStatusBar 右侧，用 Lucide SVG 图标标识协作锁状态。
 * - acquired:       "[自己] 编辑中"  (Pencil 图标, 绿色)
 * - locked_by_other: "[对方] 编辑中" (Lock 图标, 琥珀色)
 * - offline:        "离线"           (WifiOff 图标, 红色)
 * - unavailable:    "暂不可用"       (WifiOff 图标, 红色)
 * - idle/loading:   不显示
 */

import { useTranslation } from 'react-i18next';
import { Pencil, Lock, WifiOff } from 'lucide-react';
import type { CollabLockState } from '../hooks/useCollabLock';

interface CollabLockBadgeProps {
    lockState: CollabLockState;
    lockedByName: string | null;
    localUser: string;
}

export function CollabLockBadge({ lockState, lockedByName, localUser }: CollabLockBadgeProps) {
    const { t } = useTranslation();

    if (lockState === 'idle' || lockState === 'loading') return null;

    let icon: React.ReactNode;
    let label: string;
    let pillClass: string;
    const pillSurfaceClass = 'border border-white/45 dark:border-white/10 shadow-[0_1px_2px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.45)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]';

    switch (lockState) {
        case 'acquired':
            icon = <Pencil size={11} />;
            label = localUser
                ? t('collabLock.editing_by', { name: localUser })
                : t('collabLock.editing');
            pillClass = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20';
            break;
        case 'locked_by_other':
            icon = <Lock size={11} />;
            label = lockedByName
                ? t('collabLock.editing_by', { name: lockedByName })
                : t('collabLock.editing');
            pillClass = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20';
            break;
        case 'offline':
            icon = <WifiOff size={11} />;
            label = t('collabLock.offline');
            pillClass = 'bg-red-500/10 text-red-500 dark:text-red-400 ring-red-500/20';
            break;
        case 'unavailable':
            icon = <WifiOff size={11} />;
            label = t('collabLock.unavailable', '暂不可用');
            pillClass = 'bg-red-500/10 text-red-500 dark:text-red-400 ring-red-500/20';
            break;
        default:
            return null;
    }

    return (
        <span
            className={[
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                'ring-1 transition-all duration-200 select-none',
                pillSurfaceClass,
                pillClass,
            ].join(' ')}
        >
            {icon}
            {label}
        </span>
    );
}
