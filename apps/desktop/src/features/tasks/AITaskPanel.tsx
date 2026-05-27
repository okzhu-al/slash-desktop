/**
 * AITaskPanel - AI-extracted task suggestions panel
 * 
 * Features:
 * - Shows AI-extracted task suggestions for the current note
 * - Accept to insert task into note, Dismiss to hide
 * - Manual extract trigger button
 * - Auto-refresh on note change
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ListChecks, Loader2, Check, X, Sparkles, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/utils/cn';

interface AITaskSuggestion {
    id: number;
    note_path: string;
    raw_text: string;
    original_text: string;
    suggested_date: string | null;
    suggested_assignee: string | null;
    suggested_priority: string | null;
    status: string;
    created_at: number | null;
}

interface AITaskPanelProps {
    notePath: string | null;
    noteContent: string;
    onInsertTask: (taskText: string, dueDate?: string, priority?: string) => void;
}

export const AITaskPanel = ({ notePath, noteContent, onInsertTask }: AITaskPanelProps) => {
    const { t } = useTranslation();
    const [suggestions, setSuggestions] = useState<AITaskSuggestion[]>([]);
    const [loading, setLoading] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const lastNotePathRef = useRef<string | null>(null);
    const extractionInProgressRef = useRef(false);

    // Fetch existing suggestions when note changes
    useEffect(() => {
        if (!notePath) {
            setSuggestions([]);
            lastNotePathRef.current = null;
            return;
        }

        // Only fetch if note changed
        if (notePath === lastNotePathRef.current) {
            return;
        }

        lastNotePathRef.current = notePath;
        setLoading(true);

        invoke<AITaskSuggestion[]>('get_ai_suggestions_for_note', { notePath })
            .then(result => {
                setSuggestions(result);
            })
            .catch(e => {
                console.error('Failed to fetch AI suggestions:', e);
                setSuggestions([]);
            })
            .finally(() => {
                setLoading(false);
            });
    }, [notePath]);

    // Manual extraction trigger
    const handleExtract = useCallback(async () => {
        if (!notePath || !noteContent || extractionInProgressRef.current) return;

        extractionInProgressRef.current = true;
        setExtracting(true);

        try {
            // Skip keyword check for manual extraction - let LLM decide
            // Extract tasks via LLM
            const extractedTasks = await invoke<{ task: string; original: string; due: string | null; assignee: string | null; priority: string | null }[]>(
                'extract_tasks_from_note',
                { notePath, content: noteContent }
            );

            console.log('📋 [AITaskPanel] Extracted', extractedTasks.length, 'tasks');

            // Refresh suggestions from DB
            const refreshed = await invoke<AITaskSuggestion[]>('get_ai_suggestions_for_note', { notePath });
            setSuggestions(refreshed);
        } catch (e) {
            console.error('Failed to extract tasks:', e);
        } finally {
            setExtracting(false);
            extractionInProgressRef.current = false;
        }
    }, [notePath, noteContent]);

    // Accept suggestion - insert into note and mark as accepted
    const handleAccept = useCallback(async (suggestion: AITaskSuggestion) => {
        if (!suggestion.id) return;

        try {
            // Mark as accepted in DB
            await invoke('update_ai_suggestion', {
                suggestionId: suggestion.id,
                status: 'accepted'
            });

            // Insert task into note
            const taskText = suggestion.suggested_date
                ? `${suggestion.raw_text} 📅 ${suggestion.suggested_date}`
                : suggestion.raw_text;

            onInsertTask(taskText, suggestion.suggested_date ?? undefined, suggestion.suggested_priority ?? undefined);

            // Remove from local state
            setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
        } catch (e) {
            console.error('Failed to accept suggestion:', e);
        }
    }, [onInsertTask]);

    // Dismiss suggestion
    const handleDismiss = useCallback(async (suggestion: AITaskSuggestion) => {
        if (!suggestion.id) return;

        try {
            await invoke('update_ai_suggestion', {
                suggestionId: suggestion.id,
                status: 'dismissed'
            });

            // Remove from local state
            setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
        } catch (e) {
            console.error('Failed to dismiss suggestion:', e);
        }
    }, []);

    // Priority badge color
    const getPriorityColor = (priority: string | null) => {
        switch (priority?.toLowerCase()) {
            case 'high': return 'bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400';
            case 'medium': return 'bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400';
            case 'low': return 'bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-400';
            default: return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
        }
    };

    if (!notePath) return null;

    return (
        <div className="flex-1 flex flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                <ListChecks size={16} className={cn(
                    suggestions.length > 0 ? "text-indigo-500" : "text-zinc-400"
                )} />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {suggestions.length > 0
                        ? t('tasks.ai_suggestions', { count: suggestions.length }) || `${suggestions.length} 个建议`
                        : t('tasks.ai_panel_title') || 'AI 任务建议'
                    }
                </span>

                {/* Extract button */}
                <button
                    onClick={handleExtract}
                    disabled={extracting || !noteContent}
                    className={cn(
                        "ml-auto flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                        extracting
                            ? "bg-zinc-100 text-zinc-400 cursor-not-allowed"
                            : "bg-indigo-100 text-indigo-600 hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-400"
                    )}
                >
                    {extracting ? (
                        <Loader2 size={12} className="animate-spin" />
                    ) : (
                        <RefreshCw size={12} />
                    )}
                    {extracting ? '提取中...' : '提取任务'}
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-2 max-h-[calc(100vh-200px)]">
                {loading ? (
                    <div className="flex items-center justify-center h-24 text-zinc-400">
                        <Loader2 size={20} className="animate-spin" />
                    </div>
                ) : suggestions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-24 text-zinc-400 text-sm">
                        <Sparkles size={24} className="mb-2 opacity-50" />
                        <span>{t('tasks.no_suggestions') || '暂无任务建议'}</span>
                        <span className="text-xs mt-1 opacity-75">
                            {t('tasks.click_extract') || '点击上方按钮提取任务'}
                        </span>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {suggestions.map((suggestion) => (
                            <div
                                key={suggestion.id}
                                className="group p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700"
                            >
                                {/* Task text */}
                                <div className="text-sm text-zinc-700 dark:text-zinc-300">
                                    {suggestion.raw_text}
                                </div>

                                {/* Original quote (collapsible) */}
                                {suggestion.original_text && suggestion.original_text !== suggestion.raw_text && (
                                    <div className="mt-1.5 text-xs text-zinc-400 italic border-l-2 border-zinc-300 dark:border-zinc-600 pl-2">
                                        "{suggestion.original_text}"
                                    </div>
                                )}

                                {/* Metadata badges */}
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {suggestion.suggested_date && (
                                        <span className="px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                                            📅 {suggestion.suggested_date}
                                        </span>
                                    )}
                                    {suggestion.suggested_priority && (
                                        <span className={cn("px-1.5 py-0.5 text-xs rounded", getPriorityColor(suggestion.suggested_priority))}>
                                            {suggestion.suggested_priority}
                                        </span>
                                    )}
                                    {suggestion.suggested_assignee && (
                                        <span className="px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-600 dark:bg-purple-900/50 dark:text-purple-400">
                                            {suggestion.suggested_assignee}
                                        </span>
                                    )}
                                </div>

                                {/* Action buttons */}
                                <div className="mt-2.5 flex items-center gap-2">
                                    <button
                                        onClick={() => handleAccept(suggestion)}
                                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs rounded-md transition-colors"
                                    >
                                        <Check size={12} />
                                        {t('tasks.insert') || '插入'}
                                    </button>
                                    <button
                                        onClick={() => handleDismiss(suggestion)}
                                        className="flex items-center justify-center gap-1 px-3 py-1.5 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 text-xs rounded-md transition-colors"
                                    >
                                        <X size={12} />
                                        {t('tasks.dismiss') || '忽略'}
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
