/**
 * PropertiesSection - Collapsible properties panel with Magic Wand AI trigger
 * 
 * UX v2: AI skills are user-initiated via the magic wand button.
 * The wand glows when idle (60s) to hint that AI analysis is available.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Wand2, Loader2, Check } from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import { PropertiesPanel } from './PropertiesPanel';

interface PropertiesSectionProps {
    showProperties: boolean;
    onToggle: () => void;
    hasSummaryUpdate?: boolean;
    hasSummarySuggestion?: boolean;
    frontmatter: string;
    onMetadataChange: (changes: any) => void;
    noteId: string;
    aiTags: string[];
    aiSummary?: string;
    onAIDataChange: () => void;
    noteContent: string;
    isAIRunning?: boolean;
    onRunAI?: () => void;
}

export function PropertiesSection({
    showProperties,
    onToggle,
    hasSummaryUpdate,
    hasSummarySuggestion,
    frontmatter,
    onMetadataChange,
    noteId,
    aiTags,
    aiSummary,
    onAIDataChange,
    noteContent,
    isAIRunning = false,
    onRunAI,
}: PropertiesSectionProps) {
    const { t } = useTranslation();
    const [showDone, setShowDone] = useState(false);
    const [wasRunning, setWasRunning] = useState(false);

    // Show checkmark briefly after AI completes
    useEffect(() => {
        if (wasRunning && !isAIRunning) {
            setShowDone(true);
            const timer = setTimeout(() => setShowDone(false), 2000);
            return () => clearTimeout(timer);
        }
        setWasRunning(isAIRunning);
    }, [isAIRunning, wasRunning]);

    return (
        <div className="mb-8">
            <div className="flex items-center gap-2">
                <button
                    onClick={onToggle}
                    className="relative flex items-center group text-md font-semibold transition-colors focus:outline-none"
                >
                    <ChevronRight
                        size={16}
                        className={cn(
                            "transition-all duration-200 text-[#002FA7]",
                            "absolute -left-5",
                            showProperties ? "opacity-0 group-hover:opacity-100 " : "opacity-100",
                            showProperties && "rotate-90"
                        )}
                    />
                    <span className={cn(
                        "text-zinc-900 dark:text-zinc-100",
                        isAIRunning && "title-shimmer"
                    )}>
                        {t("editor.properties")}
                    </span>
                </button>

                {/* Magic Wand Button - always visible with subtle breathing */}
                {onRunAI && (
                    <button
                        onClick={onRunAI}
                        disabled={isAIRunning}
                        title={isAIRunning ? "AI 分析中..." : "AI 分析"}
                        className={cn(
                            "relative flex items-center justify-center w-7 h-7 rounded-md transition-all duration-300",
                            "focus:outline-none focus:ring-2 focus:ring-[#002FA7]/30",
                            // Running: spinner
                            isAIRunning && [
                                "text-[#002FA7] dark:text-[#002FA7]",
                                "bg-[#002FA7]/5 dark:bg-[#002FA7]/10",
                                "cursor-wait",
                            ],
                            // Done: checkmark
                            showDone && !isAIRunning && [
                                "text-emerald-500 dark:text-emerald-400",
                                "bg-emerald-50 dark:bg-emerald-900/20",
                            ],
                            // Default: brand color with breathing
                            !isAIRunning && !showDone && [
                                "text-[#002FA7] dark:text-[#002FA7]",
                                "magic-wand-breathe",
                            ],
                        )}
                    >
                        {isAIRunning ? (
                            <Loader2 size={15} className="animate-spin" />
                        ) : showDone ? (
                            <Check size={15} className="animate-in fade-in zoom-in duration-300" />
                        ) : (
                            <Wand2 size={15} strokeWidth={1.8} />
                        )}
                    </button>
                )}
            </div>
            <div className="mt-2">
                {showProperties && (
                    <PropertiesPanel
                        frontmatter={frontmatter}
                        onMetadataChange={onMetadataChange}
                        notePath={noteId}
                        aiTags={aiTags}
                        aiSummary={aiSummary}
                        hasSummaryUpdate={hasSummaryUpdate}
                        hasSummarySuggestion={hasSummarySuggestion}
                        onAIDataChange={onAIDataChange}
                        noteContent={noteContent}
                        modelName={undefined}
                    />
                )}
            </div>
        </div>
    );
}
