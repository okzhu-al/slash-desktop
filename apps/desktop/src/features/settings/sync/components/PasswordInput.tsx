/**
 * PasswordInput — 密码输入框 + 显隐切换
 */
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/shared/utils/cn';

interface PasswordInputProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    showPassword: boolean;
    onToggleShow: () => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    wrapperClassName?: string;
    inputClassName?: string;
    labelClassName?: string;
    focusTheme?: 'green' | 'blue';
}

export const PasswordInput = ({
    label,
    value,
    onChange,
    placeholder,
    showPassword,
    onToggleShow,
    onKeyDown,
    wrapperClassName = "mb-1 block",
    inputClassName = "px-3 py-2",
    labelClassName = "text-xs font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block",
    focusTheme = 'blue'
}: PasswordInputProps) => (
    <div className={wrapperClassName}>
        <label className={labelClassName}>
            {label}
        </label>
        <div className="relative">
            <input
                autoCapitalize="off"
                autoCorrect="off"
                type={showPassword ? 'text' : 'password'}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                onKeyDown={onKeyDown}
                className={cn(
                    "w-full pr-9 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none transition-all hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]",
                    focusTheme === 'green'
                        ? "focus:border-[#006540]/60 focus:ring-2 focus:ring-[#006540]/10"
                        : "focus:border-[#002FA7]/60 focus:ring-2 focus:ring-[#002FA7]/10",
                    inputClassName
                )}
            />
            <button
                type="button"
                onClick={onToggleShow}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                tabIndex={-1}
            >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
        </div>
    </div>
);
