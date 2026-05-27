/**
 * FindInNote Component
 * 
 * Search bar UI for in-note text search
 * Displays at top of editor when Cmd+F is pressed
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronUp, ChevronDown, Search } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import type { SearchHighlightStorage } from '@slash/editor-core';

interface FindInNoteProps {
    editor: Editor | null;
    isOpen: boolean;
    onClose: () => void;
}

export function FindInNote({ editor, isOpen, onClose }: FindInNoteProps) {
    const { t } = useTranslation();
    const [searchTerm, setSearchTerm] = useState('');
    const [matchCount, setMatchCount] = useState(0);
    const [currentIndex, setCurrentIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Sync match count from storage when editor updates
    useEffect(() => {
        if (!editor) return;

        const updateMatchInfo = () => {
            const storage = (editor.storage as unknown as Record<string, SearchHighlightStorage>)?.searchHighlight;
            if (storage) {
                setMatchCount(storage.matchCount ?? 0);
                setCurrentIndex(storage.currentMatchIndex ?? 0);
            }
        };

        // Initial sync
        updateMatchInfo();

        // Listen for editor updates (transaction applied)
        editor.on('update', updateMatchInfo);
        editor.on('transaction', updateMatchInfo);

        return () => {
            editor.off('update', updateMatchInfo);
            editor.off('transaction', updateMatchInfo);
        };
    }, [editor]);

    // Focus input when opened
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isOpen]);

    // Update search when term changes
    useEffect(() => {
        if (editor && isOpen) {
            // 延迟到 microtask 避免 React commit phase 内 dispatch ProseMirror transaction
            queueMicrotask(() => {
                editor.commands.setSearchTerm(searchTerm);
            });
        }
    }, [searchTerm, editor, isOpen]);

    // Clear search when closed
    useEffect(() => {
        if (!isOpen && editor) {
            queueMicrotask(() => {
                editor.commands.clearSearch();
            });
            setSearchTerm('');
        }
    }, [isOpen, editor]);

    const handleClose = useCallback(() => {
        if (editor) {
            editor.commands.clearSearch();
        }
        setSearchTerm('');
        onClose();
        // Focus back to editor
        setTimeout(() => {
            editor?.commands.focus();
        }, 50);
    }, [editor, onClose]);

    const handleNext = useCallback(() => {
        editor?.commands.goToNextMatch();
    }, [editor]);

    const handlePrev = useCallback(() => {
        editor?.commands.goToPrevMatch();
    }, [editor]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                handlePrev();
            } else {
                handleNext();
            }
        }
    }, [handleClose, handleNext, handlePrev]);

    if (!isOpen) return null;

    return (
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-2">
            <div className="flex items-center gap-2 max-w-3xl mx-auto">
                {/* Search Icon */}
                <Search className="w-4 h-4 text-muted-foreground shrink-0" />

                {/* Search Input */}
                <input
                    ref={inputRef}
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('find.placeholder', 'Find...')}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground outline-none min-w-0"
                />

                {/* Match Count */}
                {searchTerm && (
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : t('find.no_matches', 'No matches')}
                    </span>
                )}

                {/* Navigation Buttons */}
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={handlePrev}
                        disabled={matchCount === 0}
                        className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={t('find.prev', 'Previous (Shift+Enter)')}
                    >
                        <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleNext}
                        disabled={matchCount === 0}
                        className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={t('find.next', 'Next (Enter)')}
                    >
                        <ChevronDown className="w-4 h-4" />
                    </button>
                </div>

                {/* Close Button */}
                <button
                    onClick={handleClose}
                    className="p-1 rounded hover:bg-accent transition-colors shrink-0"
                    title={t('find.close', 'Close (Esc)')}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
