/**
 * NoteHeader - Title input with auto-sizing, backlink badge, and AI smart rename wand
 * 
 * Extracted from Editor.tsx for component modularity
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Wand2, Loader2 } from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import { BacklinkBadge } from './BacklinkBadge';

interface BacklinkItem {
    source_path: string;
    source_title: string;
    target_anchor: string;
}

interface NoteHeaderProps {
    title: string;
    titleInputRef: React.RefObject<HTMLInputElement | null>;
    onTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onTitleBlur: () => void;
    onTitleKeyDown: (e: React.KeyboardEvent) => void;
    titleBacklinks: BacklinkItem[];
    onNavigateToNote?: (path: string) => void;
    /** Trigger AI smart rename */
    onSmartRename?: () => void;
    /** Whether AI is currently running (wand spins) */
    isAIRunning?: boolean;
}

export function NoteHeader({
    title,
    titleInputRef,
    onTitleChange,
    onTitleBlur,
    onTitleKeyDown,
    titleBacklinks,
    onNavigateToNote,
    onSmartRename,
    isAIRunning = false,
}: NoteHeaderProps) {
    const { t } = useTranslation();

    return (
        <div className="inline-flex items-center mb-6 group/header">
            <div className="inline-grid relative overflow-visible">
                {/* Hidden span for auto-sizing - same typography as input */}
                <span
                    className="invisible whitespace-pre col-start-1 row-start-1 text-4xl font-bold pb-1"
                    aria-hidden="true"
                >
                    {title || t("editor.untitled")}
                </span>
                <input
                    ref={titleInputRef}
                    className={cn(
                        "col-start-1 row-start-1 min-w-0 text-4xl font-bold placeholder:text-zinc-300 dark:placeholder:text-zinc-700 border-none focus:ring-0 p-0 bg-transparent leading-normal outline-none",
                        isAIRunning && "opacity-0 pointer-events-none"
                    )}
                    value={title}
                    onChange={onTitleChange}
                    onBlur={onTitleBlur}
                    onKeyDown={onTitleKeyDown}
                    placeholder={t("editor.untitled")}
                    readOnly={isAIRunning}
                />
                {/* Shimmer text while AI is generating — replaces input visually */}
                {isAIRunning && (
                    <span className="title-shimmer absolute inset-0 col-start-1 row-start-1 text-4xl font-bold leading-normal pointer-events-none truncate">
                        {title || t("editor.untitled")}
                    </span>
                )}
            </div>

            {/* AI Smart Rename Wand */}
            {onSmartRename && (
                <button
                    onClick={onSmartRename}
                    disabled={isAIRunning}
                    title={t('ai.smart_rename') || 'AI 智能命名'}
                    className={cn(
                        "ml-2 p-1.5 rounded-md transition-all duration-300",
                        isAIRunning
                            ? "text-[#002FA7] dark:text-[#002FA7] cursor-wait"
                            : [
                                "text-[#002FA7] dark:text-[#002FA7]",
                                "magic-wand-breathe",
                            ]
                    )}
                >
                    {isAIRunning ? (
                        <Loader2 size={18} className="animate-spin" />
                    ) : (
                        <Wand2 size={18} />
                    )}
                </button>
            )}

            {titleBacklinks.length > 0 && (
                <BacklinkBadge
                    count={titleBacklinks.length}
                    backlinks={titleBacklinks}
                    onNavigate={(path) => {
                        if (onNavigateToNote) {
                            onNavigateToNote(path);
                        }
                    }}
                    className="title-backlink-badge ml-4"
                />
            )}
        </div>
    );
}
