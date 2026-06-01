/**
 * PasswordInput — 密码输入框 + 显隐切换
 */
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import { syncInputBaseClass, syncInputFocusClass } from './formStyles';

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
    focusTheme?: 'green' | 'blue' | 'amber';
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
                    syncInputBaseClass,
                    syncInputFocusClass[focusTheme],
                    "pr-9",
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
