import { type ReactNode } from 'react';

import { cn } from '@/shared/utils/cn';

export const STATUS_PILL_BASE_CLASS =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none select-none whitespace-nowrap transition-all duration-150';

export const STATUS_PILL_SURFACE_CLASS =
    'border border-white/45 dark:border-white/10 shadow-[0_1px_2px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.45)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]';

interface StatusPillProps {
    icon?: ReactNode;
    title?: string;
    toneClassName: string;
    className?: string;
    trailing?: ReactNode;
    children: ReactNode;
    onClick?: () => void;
}

export function StatusPill({
    icon,
    title,
    toneClassName,
    className,
    trailing,
    children,
    onClick,
}: StatusPillProps) {
    const interactive = typeof onClick === 'function';
    const sharedClassName = cn(
        STATUS_PILL_BASE_CLASS,
        STATUS_PILL_SURFACE_CLASS,
        toneClassName,
        interactive && 'cursor-pointer hover:-translate-y-px hover:brightness-[0.99] active:translate-y-0',
        className,
    );

    if (interactive) {
        return (
            <button type="button" onClick={onClick} className={sharedClassName} title={title}>
                {icon}
                {children}
                {trailing}
            </button>
        );
    }

    return (
        <span className={sharedClassName} title={title}>
            {icon}
            {children}
            {trailing}
        </span>
    );
}
