/**
 * useEditorState - Unified Editor State Management (v3.0 - UX v2)
 * 
 * Simplified three-state model:
 * - Open: noteId changes or first load
 * - Active: Content changing, reset 60s timer
 * - Idle: No changes for 60 seconds → triggers embedding only + notifies UI
 * 
 * Blur NO LONGER triggers AI. Users control visible AI via magic wand button.
 * Only Embedding runs automatically (invisible background work).
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useNoteContext } from '@/contexts';

export type EditorState = 'open' | 'active' | 'idle';

const IDLE_TIMEOUT_MS = 60_000; // 60 seconds - triggers embedding + magic wand glow

interface UseEditorStateProps {
    editor: any | null;
    getContent: () => string;
    onStateChange?: (state: EditorState) => void;
    onIdleReady?: () => void; // Called when idle timer fires, UI should show magic wand animation
}

export function useEditorState({
    editor,
    getContent,
    onStateChange,
    onIdleReady,
}: UseEditorStateProps) {
    // Get noteId and noteIdRef from context
    const { noteId, noteIdRef } = useNoteContext();
    const [state, setState] = useState<EditorState>('open');
    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastNoteIdRef = useRef<string | null>(null);
    const isProcessingRef = useRef(false);

    // Use refs for callbacks to prevent useEffect re-execution
    const getContentRef = useRef(getContent);
    const onStateChangeRef = useRef(onStateChange);
    const onIdleReadyRef = useRef(onIdleReady);

    // Keep refs updated
    getContentRef.current = getContent;
    onStateChangeRef.current = onStateChange;
    onIdleReadyRef.current = onIdleReady;

    // Helper: trigger AI orchestrator (embedding only for non-button triggers)
    const triggerOrchestrator = (triggerType: string) => {
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId || isProcessingRef.current) return;

        const content = getContentRef.current();

        isProcessingRef.current = true;


        invoke('trigger_ai_orchestrated', {
            triggerType,
            notePath: currentNoteId,
            content,
        }).catch(e => {
            console.error(`🤖 [EditorState] ${triggerType} failed:`, e);
        }).finally(() => {
            isProcessingRef.current = false;
        });
    };

    // Helper: update state and notify
    const updateState = (newState: EditorState) => {
        setState(prev => {
            if (prev !== newState) {

                onStateChangeRef.current?.(newState);
            }
            return newState;
        });
    };

    // Helper: clear idle timer
    const clearIdleTimer = () => {
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
        }
    };

    // 1. Open: noteId changes - just track state
    useEffect(() => {
        if (!noteId) return;

        if (noteId !== lastNoteIdRef.current) {
            lastNoteIdRef.current = noteId;
            clearIdleTimer();
            updateState('open');
        }
    }, [noteId]);

    // 2. Active + Idle: listen to editor onUpdate
    useEffect(() => {
        if (!editor || !noteId) return;

        const handleUpdate = () => {
            // Transition to Active
            updateState('active');

            // Reset idle timer (60s)
            clearIdleTimer();
            idleTimerRef.current = setTimeout(() => {

                updateState('idle');
                // Only trigger embedding (no LLM skills)
                triggerOrchestrator('on_idle_embedding');
                // Notify UI to show magic wand animation
                onIdleReadyRef.current?.();
            }, IDLE_TIMEOUT_MS);
        };

        editor.on('update', handleUpdate);

        return () => {
            editor.off('update', handleUpdate);
            clearIdleTimer();
        };
    }, [editor, noteId]);

    // NOTE: Blur listener REMOVED in UX v2
    // Users switching to browser and back should NOT trigger any AI processing.
    // All visible AI changes are now user-initiated via the magic wand button.

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearIdleTimer();
        };
    }, []);

    return {
        state,
    };
}
