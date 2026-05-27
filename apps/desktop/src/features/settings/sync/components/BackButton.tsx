/**
 * BackButton — Steps 间的返回导航
 */
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyncFlowStep } from '../useSyncFlow';

interface BackButtonProps {
    to: SyncFlowStep;
    label?: string;
    onNavigate: (step: SyncFlowStep) => void;
    onClearError: () => void;
}

export const BackButton = ({ to, label, onNavigate, onClearError }: BackButtonProps) => {
    const { t } = useTranslation();
    return (
        <button
            onClick={() => { onNavigate(to); onClearError(); }}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors mb-3"
        >
            <ArrowLeft size={14} /> {label || t('common.back', '返回')}
        </button>
    );
};
