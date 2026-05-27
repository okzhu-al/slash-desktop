/**
 * NoteContext - Centralized Note Path Management
 * 
 * Provides unified access to current note's path and title across all components.
 * Uses both state (for re-renders) and ref (for async callbacks/event listeners).
 * 
 * This solves the closure capture problem where event listeners would use
 * stale noteId values after smart_rename.
 */

import React, { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from 'react';

export interface NoteContextValue {
    // State values - trigger re-renders when changed
    noteId: string | null;
    title: string;

    // Ref values - always current, safe for async callbacks
    noteIdRef: React.RefObject<string | null>;
    titleRef: React.RefObject<string>;

    // Update functions
    setNote: (noteId: string, title: string) => void;
    clearNote: () => void;
}

export const NoteContext = createContext<NoteContextValue | null>(null);

interface NoteContextProviderProps {
    children: ReactNode;
    initialNoteId?: string | null;
    initialTitle?: string;
}

export function NoteContextProvider({
    children,
    initialNoteId = null,
    initialTitle = ''
}: NoteContextProviderProps) {
    const [noteId, setNoteId] = useState<string | null>(initialNoteId);
    const [title, setTitle] = useState<string>(initialTitle);

    // Refs that always point to current values
    const noteIdRef = useRef<string | null>(initialNoteId);
    const titleRef = useRef<string>(initialTitle);

    // Keep refs in sync with state
    noteIdRef.current = noteId;
    titleRef.current = title;

    const setNote = useCallback((newNoteId: string, newTitle: string) => {
        console.log('📍 [NoteContext] setNote:', newNoteId, newTitle);
        // Update refs FIRST for immediate effect on async callbacks
        noteIdRef.current = newNoteId;
        titleRef.current = newTitle;
        // Then update state for re-renders
        setNoteId(newNoteId);
        setTitle(newTitle);
    }, []);

    const clearNote = useCallback(() => {
        console.log('📍 [NoteContext] clearNote');
        noteIdRef.current = null;
        titleRef.current = '';
        setNoteId(null);
        setTitle('');
    }, []);

    // Respond to prop changes (rename without remount):
    // When selectedNote.id or title changes, NoteContextProvider stays mounted
    // but receives new props → update context state/refs
    useEffect(() => {
        if (initialNoteId !== noteId || initialTitle !== title) {
            noteIdRef.current = initialNoteId;
            titleRef.current = initialTitle ?? '';
            setNoteId(initialNoteId);
            setTitle(initialTitle ?? '');
        }
    }, [initialNoteId, initialTitle]);

    const value: NoteContextValue = {
        noteId,
        title,
        noteIdRef,
        titleRef,
        setNote,
        clearNote,
    };

    return (
        <NoteContext.Provider value={value}>
            {children}
        </NoteContext.Provider>
    );
}

/**
 * Hook to access NoteContext
 * 
 * @throws Error if used outside of NoteContextProvider
 */
export function useNoteContext(): NoteContextValue {
    const context = useContext(NoteContext);
    if (!context) {
        throw new Error('useNoteContext must be used within a NoteContextProvider');
    }
    return context;
}

/**
 * Optional hook that returns null if context is not available
 * Useful for components that may or may not be within the provider
 */
export function useNoteContextOptional(): NoteContextValue | null {
    return useContext(NoteContext);
}
