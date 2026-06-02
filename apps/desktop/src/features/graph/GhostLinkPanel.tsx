/**
 * GhostLinkPanel - AI-powered similar note suggestions with reasoning
 * 
 * Two-stage processing:
 * 1. Vector search (instant) - shows candidates with similarity scores
 * 2. LLM reasoning (async) - adds relation type and explanation
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wand2, Link2, Loader2, X, ChevronDown, Ghost } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';
import { RELATION_GROUPS } from '@/shared/constants/relations';

import { thresholdCache, DEFAULT_THRESHOLD } from '@/features/graph/cache';

interface SimilarNote {
    note_path: string;
    title: string;
    similarity: number;
    mtime: number;  // For cache validation
    // Added by reasoning
    relation?: string;
    reason?: string;
    reasonLoading?: boolean;
}

// Reasoning data now received via props (App-level listener)

interface GhostLinkPanelProps {
    notePath: string | null;
    onNavigate: (notePath: string) => void;
    onConfirmLink?: (relation: string, targetTitle: string, targetPath: string) => void;
    /** Ghost links data received from App.tsx (fetched via ghostlink:refresh listener) */
    initialGhostLinks?: { note_path: string; title: string; similarity: number; mtime?: number }[];
    /** Reasoning results cached at App level (always-mounted listener) */
    reasoningResults?: Map<string, { relation: string; reason: string }>;
    /** Trigger manual ghostlink refresh (re-fetch + reasoning) */
    onRefresh?: (threshold?: number) => void;
}

export const GhostLinkPanel = ({ notePath, onNavigate, onConfirmLink, initialGhostLinks = [], reasoningResults = new Map(), onRefresh }: GhostLinkPanelProps) => {
    const { t } = useTranslation();
    const [similarNotes, setSimilarNotes] = useState<SimilarNote[]>([]);
    const [editingRelation, setEditingRelation] = useState<string | null>(null);
    const [customRelationInput, setCustomRelationInput] = useState<string>('');
    const [showCustomInput, setShowCustomInput] = useState<string | null>(null);
    const currentNotePathRef = useRef<string | null>(null);
    const [threshold, _setThreshold] = useState(() =>
        notePath ? (thresholdCache.get(notePath) ?? DEFAULT_THRESHOLD) : DEFAULT_THRESHOLD
    );
    // Wrap setter to sync cache
    const setThreshold = useCallback((value: number) => {
        _setThreshold(value);
        if (notePath) thresholdCache.set(notePath, value);
    }, [notePath]);

    // Restore cached threshold when switching notes
    useEffect(() => {
        if (notePath) {
            _setThreshold(thresholdCache.get(notePath) ?? DEFAULT_THRESHOLD);
        }
    }, [notePath]);

    // 🔄 Sync ghost links from App.tsx and apply reasoning results
    useEffect(() => {
        if (!notePath) {
            setSimilarNotes([]);
            currentNotePathRef.current = null;
            return;
        }

        // Update current note tracking
        currentNotePathRef.current = notePath;

        // Empty initial data - clear state
        if (initialGhostLinks.length === 0) {
            setSimilarNotes([]);
            return;
        }

        // Helper: find reasoning result using multiple path matching strategies
        const findReasoning = (notePath: string): { relation: string; reason: string } | undefined => {
            // 1. Direct match
            let result = reasoningResults.get(notePath);
            if (result) return result;

            // 2. Try extracting relative path from absolute (or vice versa)
            if (notePath.includes('/')) {
                const pathParts = notePath.split('/');
                for (let i = pathParts.length - 2; i >= 0 && !result; i--) {
                    const relativePath = pathParts.slice(i).join('/');
                    result = reasoningResults.get(relativePath);
                }
            }
            if (result) return result;

            // 3. BUG-07 fix: Reverse search — iterate reasoning keys and match by basename/suffix
            // Handles abs vs relative path mismatches (backend may send absolute, frontend relative or vice versa)
            const noteBasename = notePath.split('/').pop();
            if (noteBasename) {
                for (const [key, value] of reasoningResults) {
                    const keyBasename = key.split('/').pop();
                    if (keyBasename === noteBasename) {
                        // Verify not a false positive by checking more path segments if available
                        const noteParts = notePath.split('/');
                        const keyParts = key.split('/');
                        if (noteParts.length <= 1 || keyParts.length <= 1 ||
                            noteParts[noteParts.length - 2] === keyParts[keyParts.length - 2]) {
                            return value;
                        }
                    }
                }
            }

            return undefined;
        };

        const notesWithData: SimilarNote[] = initialGhostLinks.map(n => {
            const reasoning = findReasoning(n.note_path);
            return {
                note_path: n.note_path,
                title: n.title,
                similarity: n.similarity,
                mtime: n.mtime || 0,
                reasonLoading: !reasoning,
                relation: reasoning?.relation || 'related',
                reason: reasoning?.reason || ''
            };
        });

        setSimilarNotes(notesWithData);

        // No timeout needed anymore since the backend uses a guaranteed queue
    }, [notePath, initialGhostLinks, reasoningResults]);

    // 按阈值过滤
    const filteredNotes = similarNotes.filter(n => n.similarity >= threshold);

    // Handle ignore - blacklist this pair
    const handleIgnore = useCallback(async (targetPath: string) => {
        if (!notePath) return;

        try {
            await invoke('ignore_ghost_link', {
                sourcePath: notePath,
                targetPath
            });
            // Remove from list
            setSimilarNotes(prev => prev.filter(n => n.note_path !== targetPath));
        } catch (e) {
            console.error('Failed to ignore ghost link:', e);
        }
    }, [notePath]);

    // Handle confirm - add relation to YAML frontmatter (backend handles bidirectional blacklist)
    const handleConfirm = useCallback(async (note: SimilarNote) => {
        if (!onConfirmLink || !notePath) return;

        try {
            // Pass relation type, target title, and target path for bidirectional YAML update
            onConfirmLink(note.relation || 'related', note.title, note.note_path);
            console.log('🔗 [GhostLinkPanel] Confirmed link:', note.title);

            // Remove from list after confirming
            setSimilarNotes(prev => prev.filter(n => n.note_path !== note.note_path));
        } catch (e) {
            console.error('Failed to confirm ghost link:', e);
        }
    }, [onConfirmLink, notePath]);

    // Update relation type for a note
    const updateRelation = useCallback((notePath: string, newRelation: string) => {
        setSimilarNotes(prev => prev.map(note =>
            note.note_path === notePath ? { ...note, relation: newRelation } : note
        ));
        setEditingRelation(null);
    }, []);

    if (!notePath) return null;

    return (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Header - dynamic based on state */}
            <div className="flex items-center gap-2 px-4 py-3 h-12 border-b border-zinc-200 dark:border-zinc-700">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex-1 flex items-center gap-1.5">
                    <Ghost size={16} className="text-zinc-500" />
                    {filteredNotes.length > 0
                        ? t('graph.found', { count: filteredNotes.length })
                        : t('graph.ghost_links')
                    }
                </span>
                {onRefresh && (
                    <button
                        onClick={() => onRefresh(threshold)}
                        title={t('graph.refresh') || '刷新推荐'}
                        className={cn(
                            "p-1 rounded-md transition-all duration-300",
                            "text-[#002FA7] dark:text-blue-400",
                            "magic-wand-breathe"
                        )}
                    >
                        <Wand2 size={16} />
                    </button>
                )}
            </div>

            {/* Threshold slider */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-100 dark:border-zinc-800">
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
                    {t('graph.threshold_label') || '阈值'}
                </span>
                <input
                    type="range"
                    min="30"
                    max="90"
                    step="1"
                    value={Math.round(threshold * 100)}
                    onChange={e => setThreshold(parseInt(e.target.value) / 100)}
                    onPointerUp={e => {
                        const val = parseInt((e.target as HTMLInputElement).value) / 100;
                        onRefresh?.(val);
                    }}
                    className="flex-1 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full appearance-none cursor-pointer accent-indigo-500"
                />
                <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 w-8 text-right">
                    {Math.round(threshold * 100)}%
                </span>
            </div>

            {/* Content - scrollable with max height */}
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
                {filteredNotes.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center h-32 text-zinc-400">
                        <span className="text-sm">{t('graph.no_ghost_links') || '暂无推荐笔记'}</span>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredNotes.map((note) => (
                            <div
                                key={note.note_path}
                                className="group p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 transition-colors"
                            >
                                {/* Title and similarity */}
                                <div
                                    className="flex items-center gap-2 cursor-pointer hover:text-indigo-600 dark:hover:text-blue-300"
                                    onClick={() => onNavigate(note.note_path)}
                                >
                                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate flex-1">
                                        📄 {note.title}
                                    </span>
                                    <span className="text-xs text-zinc-400 shrink-0">
                                        {Math.round(note.similarity * 100)}%
                                    </span>
                                </div>

                                {/* Relation selector */}
                                <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                                    <span>{t('graph.relation') || '关系:'}</span>
                                    <div className="relative">
                                        <button
                                            onClick={() => setEditingRelation(
                                                editingRelation === note.note_path ? null : note.note_path
                                            )}
                                            className="flex items-center gap-1 px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-blue-400 rounded"
                                        >
                                            {t(`relations.${note.relation}`) || note.relation}
                                            <ChevronDown size={12} />
                                        </button>
                                        {editingRelation === note.note_path && (
                                            <div className="absolute bottom-full left-0 mb-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg py-1 min-w-[140px] max-h-[200px] overflow-y-auto">
                                                {showCustomInput === note.note_path ? (
                                                    <div className="p-2">
                                                        <input
                                                            type="text"
                                                            value={customRelationInput}
                                                            onChange={(e) => setCustomRelationInput(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' && customRelationInput.trim()) {
                                                                    updateRelation(note.note_path, customRelationInput.trim());
                                                                    setShowCustomInput(null);
                                                                    setCustomRelationInput('');
                                                                } else if (e.key === 'Escape') {
                                                                    setShowCustomInput(null);
                                                                    setCustomRelationInput('');
                                                                }
                                                            }}
                                                            placeholder="Enter relation..."
                                                            className="w-full px-2 py-1 text-xs border rounded bg-zinc-50 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600 focus:outline-none focus:border-indigo-500 dark:focus:border-blue-400"
                                                            autoFocus
                                                        />
                                                        <div className="flex gap-1 mt-1">
                                                            <button
                                                                onClick={() => {
                                                                    if (customRelationInput.trim()) {
                                                                        updateRelation(note.note_path, customRelationInput.trim());
                                                                        setShowCustomInput(null);
                                                                        setCustomRelationInput('');
                                                                    }
                                                                }}
                                                                className="flex-1 px-2 py-1 text-xs bg-indigo-500 text-white rounded hover:bg-indigo-600"
                                                            >
                                                                OK
                                                            </button>
                                                            <button
                                                                onClick={() => {
                                                                    setShowCustomInput(null);
                                                                    setCustomRelationInput('');
                                                                }}
                                                                className="flex-1 px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-600 rounded hover:bg-zinc-300 dark:hover:bg-zinc-500"
                                                            >
                                                                Cancel
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    RELATION_GROUPS.map(group => (
                                                        <div key={group.labelKey}>
                                                            <div className="px-3 py-1 text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider bg-zinc-50 dark:bg-zinc-900/50 sticky top-0">
                                                                {t(group.labelKey, group.label)}
                                                            </div>
                                                            {group.keys.map(key => (
                                                                <button
                                                                    key={key}
                                                                    onClick={() => updateRelation(note.note_path, key)}
                                                                    className={cn(
                                                                        "w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700",
                                                                        note.relation === key && "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-blue-400 font-medium"
                                                                    )}
                                                                >
                                                                    {t(`relations.${key}`, key)}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* AI Reason */}
                                <div className="mt-2 text-xs">
                                    {note.reasonLoading ? (
                                        <div className="flex items-center gap-2 text-zinc-400">
                                            <Loader2 size={12} className="animate-spin" />
                                            <span>{t('graph.analyzing')}</span>
                                        </div>
                                    ) : note.reason ? (
                                        <div className="text-zinc-500 dark:text-zinc-400">
                                            💡 {note.reason}
                                        </div>
                                    ) : null}
                                </div>

                                {/* Action buttons */}
                                <div className="mt-3 flex items-center gap-2">
                                    <button
                                        onClick={() => handleConfirm(note)}
                                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs rounded-md transition-colors"
                                    >
                                        <Link2 size={12} />
                                        {t('graph.confirm_link') || '确认连接'}
                                    </button>
                                    <button
                                        onClick={() => handleIgnore(note.note_path)}
                                        className="flex items-center justify-center gap-1 px-3 py-1.5 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 text-xs rounded-md transition-colors"
                                    >
                                        <X size={12} />
                                        {t('graph.ignore') || '忽略'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
