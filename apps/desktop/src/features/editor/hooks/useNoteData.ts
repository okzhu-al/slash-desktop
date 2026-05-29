/**
 * useNoteData - Automated data fetching for note AI data and backlinks
 * 
 * Extracts data fetching logic from Editor.tsx to enable:
 * - Auto-fetch on noteId/title change
 * - Centralized state management
 * - Independent refresh triggers
 * 
 * v2.0: Uses NoteContext to get noteId/title, solving closure issues in event listeners.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useNoteContext } from '@/contexts';

interface BacklinkItem {
    source_path: string;
    source_title: string;
    target_anchor: string;
}

interface UseNoteDataReturn {
    // AI Data
    aiTags: string[];
    aiSummary: string | undefined;
    hasUnseenAI: boolean;
    hasSummaryUpdate: boolean; // AI has newer summary than user-edited one
    hasTagsUpdate: boolean;    // AI has newer tags than user-edited ones
    hasSummarySuggestion: boolean; // AI has suggested a summary, user hasn't confirmed
    refetchAI: () => Promise<void>;

    // Title Suggestion (Intelligent Renaming)
    aiTitle: string | undefined;        // AI-generated title
    hasTitleSuggestion: boolean;        // AI has suggested a title, user hasn't confirmed
    acceptAiTitle: () => Promise<void>; // User accepts AI title
    setUserTitle: (newTitle: string) => Promise<string>; // User sets custom title, returns new path

    // Backlinks
    titleBacklinks: BacklinkItem[];
    allBacklinks: Record<string, BacklinkItem[]>;
    refetchBacklinks: () => Promise<void>;
}

export function useNoteData(): UseNoteDataReturn {
    // Get noteId and title from context (with refs for async callbacks)
    const { noteId, noteIdRef, title } = useNoteContext();
    // AI Data State
    const [aiTags, setAiTags] = useState<string[]>([]);
    const [aiSummary, setAiSummary] = useState<string | undefined>(undefined);
    const [hasUnseenAI, setHasUnseenAI] = useState(false);
    const [hasSummaryUpdate, setHasSummaryUpdate] = useState(false);
    const [hasTagsUpdate, setHasTagsUpdate] = useState(false);
    const [hasSummarySuggestion, setHasSummarySuggestion] = useState(false);
    const [aiTitle, setAiTitle] = useState<string | undefined>(undefined);
    const [hasTitleSuggestion, setHasTitleSuggestion] = useState(false);

    // Backlinks State
    const [titleBacklinks, setTitleBacklinks] = useState<BacklinkItem[]>([]);
    const [allBacklinks, setAllBacklinks] = useState<Record<string, BacklinkItem[]>>({});

    // Mount tracking
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // Fetch AI data
    const fetchAIData = useCallback(async () => {
        if (!noteId) return;


        try {
            const data = await invoke<{
                ai_tags: string[];
                ai_summary: string | null;
                has_summary_update: boolean;
                has_tags_update: boolean;
                has_summary_suggestion: boolean;
                ai_title: string | null;
                user_title: string | null;
                has_title_suggestion: boolean;
            }>('get_note_ai_data', { notePath: noteId });


            const newTags = data.ai_tags || [];
            const newSummary = data.ai_summary ?? undefined;

            // Track if AI has newer suggestions than user-edited data
            const summaryUpdate = data.has_summary_update || false;
            const tagsUpdate = data.has_tags_update || false;
            const summarySuggestion = data.has_summary_suggestion || false;

            // Animation condition (simple and clear):
            // 1. ai_tags has at least one tag (user hasn't dismissed/accepted all)
            // 2. ai_summary has pending suggestion or new update
            const hasAIData = newTags.length > 0 || summarySuggestion || summaryUpdate;


            if (isMountedRef.current) {
                // Only update state when data actually changed to prevent UI flicker
                // (refetch from idle/event listeners should not cause tags/summary to flash)
                setHasSummaryUpdate(summaryUpdate);
                setHasTagsUpdate(tagsUpdate);
                setHasUnseenAI(hasAIData);
                setHasSummarySuggestion(summarySuggestion);
                setAiTags(prev => {
                    const same = prev.length === newTags.length && prev.every((t, i) => t === newTags[i]);
                    return same ? prev : newTags;
                });
                setAiSummary(prev => prev === newSummary ? prev : newSummary);
                setAiTitle(prev => {
                    const newVal = data.ai_title ?? undefined;
                    return prev === newVal ? prev : newVal;
                });
                setHasTitleSuggestion(data.has_title_suggestion || false);
            }
        } catch (e) {
            console.warn('[useNoteData] Failed to fetch AI data:', e);
        }
    }, [noteId]);

    // Fetch backlinks
    const fetchBacklinks = useCallback(async () => {
        if (!title || !isMountedRef.current) return;

        try {
            const result = await invoke<Record<string, BacklinkItem[]>>('get_note_backlinks_by_section', { noteName: title });

            if (isMountedRef.current) {
                const wholeNoteBacklinks = result[''] || [];
                setTitleBacklinks(wholeNoteBacklinks);
                setAllBacklinks(result);
            }
        } catch (e) {
            console.warn('[useNoteData] Failed to fetch backlinks:', e);
        }
    }, [title]);



    // Auto-fetch on noteId change — 延迟到首屏稳定后，不抢 setContent 的主线程时间
    useEffect(() => {
        const timer = setTimeout(() => fetchAIData(), 100);
        return () => clearTimeout(timer);
    }, [noteId, fetchAIData]);

    // Auto-fetch backlinks on title change — 延迟到首屏稳定后
    useEffect(() => {
        const timer = setTimeout(() => fetchBacklinks(), 100);
        return () => clearTimeout(timer);
    }, [title, fetchBacklinks]);

    // ⚡ Added: Listen to content loaded custom event to immediately trigger data & backlink refetching
    useEffect(() => {
        const handleContentLoaded = () => {
            fetchAIData();
            fetchBacklinks();
        };
        window.addEventListener('slash:editor-content-loaded', handleContentLoaded);
        return () => window.removeEventListener('slash:editor-content-loaded', handleContentLoaded);
    }, [fetchAIData, fetchBacklinks]);

    // Listen for AI completion events to auto-refresh
    // Note: We only listen for ai:note-updated, not ai:generating
    // This prevents unnecessary animation when no new data is generated
    // The hasUnseenAI flag is set based on actual data comparison in fetchAIData
    useEffect(() => {
        let unlistenComplete: UnlistenFn | undefined;
        let cancelled = false;

        const setupListeners = async () => {
            // Refresh when AI completes - check for new content and potentially show animation
            const unlisten = await listen<{ path: string; status: string; skills: string[] }>(
                'ai:note-updated',
                async (event) => {
                    const currentNoteId = noteIdRef.current;
                    if (currentNoteId && currentNoteId.endsWith(event.payload.path)) {
                        if (event.payload.status === 'skipped' || event.payload.status === 'cached') {
                            toast.info('内容未变更，已跳过 AI 分析', { id: 'ai-note-skip' });
                            return;
                        }

                        await fetchAIData();
                    }
                }
            );
            if (cancelled) {
                unlisten();
            } else {
                unlistenComplete = unlisten;
            }
        };

        setupListeners();

        return () => {
            cancelled = true;
            unlistenComplete?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchAIData]); // noteIdRef is stable, no need in deps

    // Title Management Functions
    const acceptAiTitle = useCallback(async () => {
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId) return;
        try {

            await invoke('accept_ai_title', { notePath: currentNoteId });
            setHasTitleSuggestion(false);
            await fetchAIData(); // Refresh data
            // Emit event for Sidebar to refresh pending title list
            const { emit } = await import('@tauri-apps/api/event');
            await emit('title-confirmed', { path: currentNoteId });
        } catch (e) {
            console.error('[useNoteData] Failed to accept AI title:', e);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchAIData]); // noteIdRef is stable

    const setUserTitle = useCallback(async (newTitle: string): Promise<string> => {
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId) throw new Error('No note selected');
        try {

            const newPath = await invoke<string>('set_user_title', {
                oldPath: currentNoteId,
                newTitle
            });
            setHasTitleSuggestion(false);
            // Emit event for Sidebar to refresh pending title list
            const { emit } = await import('@tauri-apps/api/event');
            await emit('title-confirmed', { path: newPath });
            return newPath;
        } catch (e) {
            console.error('[useNoteData] Failed to set user title:', e);
            throw e;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // noteIdRef is stable

    return {
        aiTags,
        aiSummary,
        hasUnseenAI,
        hasSummaryUpdate,
        hasTagsUpdate,
        hasSummarySuggestion,
        refetchAI: fetchAIData,
        // Title Suggestion
        aiTitle,
        hasTitleSuggestion,
        acceptAiTitle,
        setUserTitle,
        // Backlinks
        titleBacklinks,
        allBacklinks,
        refetchBacklinks: fetchBacklinks,
    };
}
