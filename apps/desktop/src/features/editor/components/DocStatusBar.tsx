/**
 * DocStatusBar.tsx
 *
 * Solo / Collab 双模式文档状态标签（Phase 3.3）
 * Solo（单人）: 仅 Editor 可编辑，他人只读/评论/批注
 * Collab（协作）: 目录内所有 team member 均可编辑
 *
 * 状态切换权：仅 Editor 和 vault Owner 可操作
 * 仅在团队文档时显示。
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Users, ChevronDown, CheckCircle } from 'lucide-react';

export type DocStatus = 'solo' | 'collab';

interface StatusConfig {
    label: string;
    icon: React.ReactNode;
    pill: string;
    ring: string;
    hint: string;
}

function useStatusConfig(t: (k: string, fallback: string) => string): Record<DocStatus, StatusConfig> {
    return {
        solo: {
            label: t('docStatus.solo', '单人'),
            icon: <User size={11} />,
            pill: 'bg-[#E6A23C]/10 text-[#E6A23C]',
            ring: 'ring-[#E6A23C]/30',
            hint: t('docStatus.hint.solo', '仅你可编辑，其他成员只读与评论'),
        },
        collab: {
            label: t('docStatus.collab', '协作'),
            icon: <Users size={11} />,
            pill: 'bg-[#A42227]/10 text-[#A42227]',
            ring: 'ring-[#A42227]/30',
            hint: t('docStatus.hint.collab', '团队成员均可编辑此文档'),
        },
    };
}

const STATUS_ORDER: DocStatus[] = ['solo', 'collab'];

interface DocStatusBarProps {
    status: DocStatus;
    onChange: (newStatus: DocStatus) => void;
    /** 是否可切换（仅 Editor 和 vault Owner 为 false） */
    canSwitch?: boolean;
}

export function DocStatusBar({ status, onChange, canSwitch = false }: DocStatusBarProps) {
    const { t } = useTranslation();
    const configs = useStatusConfig(t);
    const [open, setOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const current = configs[status] ?? configs.solo;

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (
                !popoverRef.current?.contains(e.target as Node) &&
                !triggerRef.current?.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div className="relative inline-flex items-center">
            <button
                ref={triggerRef}
                onClick={() => canSwitch && setOpen(!open)}
                className={[
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                    'ring-1 transition-all duration-150',
                    current.pill,
                    current.ring,
                    canSwitch ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
                ].join(' ')}
                title={canSwitch ? t('docStatus.change', '点击切换模式') : current.hint}
            >
                {current.icon}
                {current.label}
                {canSwitch && <ChevronDown size={9} className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
            </button>

            {open && canSwitch && (
                <div
                    ref={popoverRef}
                    className={[
                        'absolute top-full left-0 mt-1.5 z-50',
                        'w-44 py-1 rounded-lg border',
                        'bg-white dark:bg-zinc-800',
                        'border-zinc-200 dark:border-zinc-700',
                        'shadow-lg shadow-black/10 dark:shadow-black/30',
                        'animate-in fade-in slide-in-from-top-1 duration-100',
                    ].join(' ')}
                >
                    {STATUS_ORDER.map((s) => {
                        const cfg = configs[s];
                        const isActive = s === status;
                        return (
                            <button
                                key={s}
                                onClick={() => { onChange(s); setOpen(false); }}
                                className={[
                                    'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left',
                                    'transition-colors duration-100',
                                    isActive
                                        ? 'bg-zinc-100 dark:bg-zinc-700 font-medium'
                                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/60',
                                    'text-zinc-700 dark:text-zinc-200',
                                ].join(' ')}
                            >
                                <span className={[
                                    'inline-flex items-center justify-center w-4 h-4 rounded-full',
                                    cfg.pill,
                                ].join(' ')}>
                                    {cfg.icon}
                                </span>
                                {cfg.label}
                                {isActive && (
                                    <CheckCircle size={11} className="ml-auto text-emerald-500 shrink-0" />
                                )}
                            </button>
                        );
                    })}
                    <div className="mt-1 pt-1 border-t border-zinc-100 dark:border-zinc-700 px-3 pb-1">
                        <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
                            {current.hint}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
