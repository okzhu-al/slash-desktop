/**
 * ImportButton — 侧边栏文件导入按钮
 *
 * 点击后弹出综合的导入中枢（文件、连接及 AI 选择）。
 */
import { useState, useCallback } from 'react';
import { Cpu, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { importService } from '@/services/ImportService';
import { ImportHubModal } from './ImportHubModal';

interface ImportButtonProps {
    vaultPath?: string;
    onNoteImported?: (notePath: string) => void;
}

export const ImportButton = ({ vaultPath, onNoteImported }: ImportButtonProps) => {
    const { t } = useTranslation();
    const [isHubOpen, setIsHubOpen] = useState(false);
    const [isChecking, setIsChecking] = useState(false);

    const handleImportClick = useCallback(async () => {
        if (!vaultPath || isChecking) return;

        setIsChecking(true);
        try {
            // 1. 检查 Sidecar 是否可用
            const available = await importService.checkAvailable();
            if (!available) {
                const { toast } = await import('sonner');
                toast.error(t('import.sidecar_unavailable'));
                return;
            }
            
            setIsHubOpen(true);
        } finally {
            setIsChecking(false);
        }
    }, [vaultPath, isChecking, t]);

    return (
        <>
            <button
                onClick={handleImportClick}
                disabled={isChecking || !vaultPath}
                className={cn(
                    'w-7 h-7 flex items-center justify-center rounded-md transition-colors',
                    'text-[#E6A23C] dark:text-[#E6A23C] hover:bg-[#E6A23C]/10 dark:hover:bg-[#E6A23C]/20',
                    'disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent'
                )}
                title={t('import.button_title', 'AI 智能导入')}
            >
                {isChecking
                    ? <Loader2 size={18} strokeWidth={1.5} className="animate-spin" />
                    : <Cpu size={18} strokeWidth={1.5} />
                }
            </button>
            
            {/* 综合导入中枢 */}
            {isHubOpen && vaultPath && (
                <ImportHubModal
                    vaultPath={vaultPath}
                    onClose={() => setIsHubOpen(false)}
                    onImported={onNoteImported}
                />
            )}
        </>
    );
};
