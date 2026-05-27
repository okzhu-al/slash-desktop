import { memo } from 'react';
import { NodeProps } from '@xyflow/react';

function VaultCenterNodeComponent({ data }: NodeProps) {
    const title = data.label as string;

    return (
        <div
            className="flex items-center justify-center rounded-3xl border-2 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#18181b] shadow-xl"
            style={{ width: 280, height: 80, zIndex: 0 }}
        >
            <div className="absolute -inset-[2px] rounded-3xl bg-linear-to-r from-pink-500/20 via-purple-500/20 to-indigo-500/20 blur-md opacity-50 z-[-1]" />
            <h1 className="text-[18px] font-bold tracking-widest text-zinc-800 dark:text-zinc-200 uppercase">
                {title}
            </h1>
        </div>
    );
}

export const VaultCenterNode = memo(VaultCenterNodeComponent);
