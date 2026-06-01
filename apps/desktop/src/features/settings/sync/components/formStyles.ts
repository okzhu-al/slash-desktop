export const syncLabelClass =
    'text-[11px] font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-1.5 block';

export const syncInputBaseClass =
    'w-full px-3.5 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-800 dark:text-zinc-200 focus:outline-none transition-all hover:border-zinc-300 dark:hover:border-zinc-500 shadow-sm placeholder:text-[#C8C8C8] dark:placeholder:text-[#545454]';

export const syncInputFocusClass = {
    blue: 'focus:border-[#002FA7]/60 dark:focus:border-blue-400/60 focus:ring-2 focus:ring-[#002FA7]/10 dark:focus:ring-blue-400/15',
    green: 'focus:border-[#006540]/60 dark:focus:border-emerald-400/60 focus:ring-2 focus:ring-[#006540]/10 dark:focus:ring-emerald-400/15',
    amber: 'focus:border-amber-500/60 dark:focus:border-amber-400/60 focus:ring-2 focus:ring-amber-500/15 dark:focus:ring-amber-400/15',
} as const;

export const syncCombinedInputFocusClass = {
    blue: 'focus-within:border-[#002FA7]/60 dark:focus-within:border-blue-400/60 focus-within:ring-2 focus-within:ring-[#002FA7]/10 dark:focus-within:ring-blue-400/15',
    green: 'focus-within:border-[#006540]/60 dark:focus-within:border-emerald-400/60 focus-within:ring-2 focus-within:ring-[#006540]/10 dark:focus-within:ring-emerald-400/15',
    amber: 'focus-within:border-amber-500/60 dark:focus-within:border-amber-400/60 focus-within:ring-2 focus-within:ring-amber-500/15 dark:focus-within:ring-amber-400/15',
} as const;

export const syncInputClass = (theme: keyof typeof syncInputFocusClass = 'blue') =>
    `${syncInputBaseClass} ${syncInputFocusClass[theme]}`;

export const syncCombinedInputClass = (theme: keyof typeof syncInputFocusClass = 'blue') =>
    `flex w-full rounded-lg border border-zinc-200 dark:border-zinc-600/60 bg-zinc-50 dark:bg-zinc-800/50 ${syncCombinedInputFocusClass[theme]} transition-all hover:border-zinc-300 dark:hover:border-zinc-500 overflow-hidden text-[13px] shadow-sm`;
