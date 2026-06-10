import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Note } from '@/core/storage/types';
import { FileSystemNoteRepository } from '@/core/storage/FileSystemNoteRepository';
import { useFileSystemStore } from '@/core/fs/store';
import { useTabsStore } from '@/core/tabs/TabsStore';
import { getTeamNoteDisplayPath, isTeamNoteId } from '@/shared/utils/teamNoteIdentity';
import { isDeletedTeamNote } from '@/shared/utils/deletedTeamNoteGuard';

/**
 * Note navigation state and actions
 */
export interface NoteNavigationState {
    /** Currently selected note */
    selectedNote: Note | null;
    /** Current note content (markdown body) */
    content: string | null;
    /** View mode: editor or media preview */
    viewMode: 'editor' | 'media';
    /** Flag for newly created notes (triggers title selection) */
    isNewNote: boolean;
    /** Flag to focus editor body after title edit */
    shouldFocusBody: boolean;
}

export interface NoteNavigationActions {
    /** Stable key for Editor mount — only changes on note SWITCH, NOT on rename */
    noteSelectionKey: number;
    /** Select and load a note */
    selectNote: (note: Note) => Promise<void>;
    /** Handle tab click - load note by ID */
    handleTabClick: (tabId: string) => Promise<void>;
    /** Update state setters exposed for App.tsx integration */
    setSelectedNote: React.Dispatch<React.SetStateAction<Note | null>>;
    setContent: React.Dispatch<React.SetStateAction<string | null>>;
    setViewMode: React.Dispatch<React.SetStateAction<'editor' | 'media'>>;
    setIsNewNote: React.Dispatch<React.SetStateAction<boolean>>;
    setShouldFocusBody: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UseNoteNavigationOptions {
    /** Repository for note operations */
    repo: FileSystemNoteRepository | null;
    /** Current vault path */
    vaultPath: string | null;
}

/** Media file extensions that should open in preview mode */
const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'mp4', 'webm', 'mov', 'mkv'];

function basenameWithoutExtension(pathLike?: string | null): string {
    if (!pathLike) return '';
    const normalized = pathLike.replace(/\\/g, '/');
    const base = normalized.split('/').pop() || normalized;
    return base.replace(/\.[^/.]+$/, '');
}

function resolveNoteTabTitle(note: Note): string {
    const directTitle = typeof note.title === 'string' ? note.title.trim() : '';
    if (directTitle) return directTitle;

    const metadataTitle = typeof note.metadata?.title === 'string' ? note.metadata.title.trim() : '';
    if (metadataTitle) return metadataTitle;

    const teamPath = typeof note.metadata?.team_path === 'string' ? note.metadata.team_path : null;
    const derivedTeamTitle = basenameWithoutExtension(getTeamNoteDisplayPath(note.id, teamPath));
    if (derivedTeamTitle) return derivedTeamTitle;

    const notePathTitle = basenameWithoutExtension(note.path);
    if (notePathTitle) return notePathTitle;

    return basenameWithoutExtension(note.id) || note.id;
}

/**
 * Hook for managing note navigation state and actions.
 * Extracted from App.tsx to improve modularity.
 */
export function useNoteNavigation(
    options: UseNoteNavigationOptions
): NoteNavigationState & NoteNavigationActions {
    const { repo, vaultPath } = options;

    // State
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [content, setContent] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<'editor' | 'media'>('editor');
    const [isNewNote, setIsNewNote] = useState(false);
    const [shouldFocusBody, setShouldFocusBody] = useState(false);
    // Stable mount key for NoteContextProvider/Editor:
    // only increments on intentional note SWITCH, NOT on rename.
    const [noteSelectionKey, setNoteSelectionKey] = useState(0);

    // Tabs Store
    const { openTab, saveForVault } = useTabsStore();

    /**
     * Select and load a note (moved from App.tsx handleSelectNote)
     */
    const selectNote = useCallback(async (note: Note) => {
        if (!repo) return;
        if (isDeletedTeamNote(note)) return;

        const tabTitle = resolveNoteTabTitle(note);

        // Open/activate tab
        openTab(
            note.id,
            tabTitle,
            note.metadata?.slash_id as string | undefined,
            note.metadata?.team_path as string | undefined,
        );

        // Immediately persist tab state to vault-specific localStorage
        // This ensures the correct note is restored on next app launch
        if (vaultPath) {
            saveForVault(vaultPath);
        }

        // 团队文件（来自云端 API）— 直接使用预填 content，不读磁盘
        if (note.id.startsWith('__team__/')) {
            if (isDeletedTeamNote(note)) return;
            setViewMode('editor');
            setIsNewNote(false);
            setShouldFocusBody(false);
            setNoteSelectionKey(k => k + 1);  // force Editor remount for team notes
            setSelectedNote(note);
            setContent(note.content || '');
            return;
        }

        // Auto-expand parent folder in sidebar

        useFileSystemStore.getState().expandToPath(note.id);

        // Check file extension for media types
        const ext = note.id.split('.').pop()?.toLowerCase() || '';

        if (MEDIA_EXTENSIONS.includes(ext)) {
            setViewMode('media');
            setSelectedNote(note);
            setContent(null);

            return;
        }

        // Default: Editor Mode
        setViewMode('editor');
        setContent(null);

        // Track if this is a new note (for title selection)
        const isNew = (note as any).isNewNote === true;
        setIsNewNote(isNew);

        // Reset shouldFocusBody when creating a new note - title should stay focused
        if (isNew) {
            setShouldFocusBody(false);
        }

        // Force Editor remount for every intentional note switch
        setNoteSelectionKey(k => k + 1);
        setSelectedNote(note); // Optimistic select with partial data

        // For NEW notes, skip the getNote reload to avoid race condition:
        // createNote writes file, but getNote might read stale content before flush
        if (isNew) {

            setContent(note.content || '');
            return;
        }

        try {
            const fullNote = await repo.getNote(note.id);
            if (fullNote && !isDeletedTeamNote(fullNote)) {

                setSelectedNote(fullNote); // REFRESH with full content and metadata
                setContent(fullNote.content);
            } else {
                setContent('');
            }
        } catch (e) {
            console.error("Failed to load note full data", e);
            setContent('');
        }
    }, [repo, openTab, saveForVault, vaultPath]);

    /**
     * Handle tab click - load note by ID (moved from App.tsx)
     */
    const handleTabClick = useCallback(async (tabId: string) => {
        if (!repo) return;

        // Auto-expand parent folder in sidebar (with retry for startup scenario)
        const tryExpandToPath = async (retries = 5) => {
            const { root } = useFileSystemStore.getState();
            if (root) {
                useFileSystemStore.getState().expandToPath(tabId);
            } else if (retries > 0) {
                // Root not loaded yet, retry after delay
                setTimeout(() => tryExpandToPath(retries - 1), 200);
            }
        };
        tryExpandToPath();

        // Find the note by tabId (which is the note.id)
        try {
            const note = await repo.getNote(tabId);
            if (note && !isDeletedTeamNote(note)) {
                useTabsStore.getState().updateTabTitle(tabId, resolveNoteTabTitle(note));
                const ext = tabId.split('.').pop()?.toLowerCase() || '';

                if (MEDIA_EXTENSIONS.includes(ext)) {
                    setViewMode('media');
                    setNoteSelectionKey(k => k + 1);
                    setSelectedNote(note);
                    setContent(null);
                } else {
                    setViewMode('editor');
                    setNoteSelectionKey(k => k + 1);
                    setSelectedNote(note);
                    setContent(note.content);
                }
            } else if (!isTeamNoteId(tabId)) {
                const tabsStore = useTabsStore.getState();
                const wasActive = tabsStore.activeTabId === tabId;
                tabsStore.closeTab(tabId);
                if (wasActive) {
                    setSelectedNote(null);
                    setContent(null);
                    setIsNewNote(false);
                }
                if (vaultPath) {
                    useTabsStore.getState().saveForVault(vaultPath);
                }
            }
        } catch (e) {
            console.error("Failed to load note from tab", e);
        }
    }, [repo]);

    /**
     * WikiLink navigation event handler (moved from App.tsx)
     * Listens for 'slash:navigate-note' custom events and navigates to the target note
     */
    useEffect(() => {
        const handleWikiLinkNav = async (e: CustomEvent<{ path: string; section?: string }>) => {
            const notePath = e.detail.path;
            const section = e.detail.section;


            if (!repo || !vaultPath) return;

            try {
                // The path could be either:
                // 1. Full relative path: "01_Projects/Slash/AI能力" (from suggestion)
                // 2. Just title: "AI能力" (from markdown [[AI能力]])

                let relativePath = notePath;
                if (!relativePath.endsWith('.md')) {
                    relativePath = `${relativePath}.md`;
                }

                // First try: direct path construction (may fail for title-only links)
                const absolutePath = `${vaultPath}/${relativePath}`;


                let note = null;
                try {
                    note = await repo.getNote(absolutePath);
                } catch {
                    // Expected - direct path might not exist for title-only links
                }

                // Second try: if not found, search by title in database
                if (!note) {

                    const titleToFind = notePath.replace(/\.md$/, '');

                    // Search in database for note with matching title
                    const allNotes = await invoke<Array<{ id: number; path: string; title: string }>>('get_notes');
                    const matchedNote = allNotes.find(n =>
                        n.title === titleToFind ||
                        n.path.endsWith(`/${titleToFind}.md`) ||
                        n.path === `${titleToFind}.md`
                    );

                    if (matchedNote) {
                        const foundPath = `${vaultPath}/${matchedNote.path}`;

                        note = await repo.getNote(foundPath);
                    }
                }

                if (note) {
                    selectNote(note);

                    // If section specified, scroll to it after content loads
                    if (section) {
                        setTimeout(() => {
                            // Try multiple selectors for heading matching
                            const heading = document.getElementById(section) ||
                                document.querySelector(`[id="${section}"]`) ||
                                // Search all headings for matching text content
                                Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).find(
                                    el => el.textContent?.trim().toLowerCase() === section.toLowerCase() ||
                                        el.textContent?.trim() === section
                                );

                            if (heading) {
                                heading.scrollIntoView({ behavior: 'smooth', block: 'start' });

                            } else {
                                console.warn('🔗 [WikiLink] Section not found:', section);
                            }
                        }, 300); // Wait for content to render
                    }
                } else {
                    // 笔记不存在 — 自动在 00_Inbox 创建

                    const titleToCreate = notePath.replace(/\.md$/, '');
                    try {
                        const inboxPath = `${vaultPath}/00_Inbox`;
                        const newNote = await repo.createNote(titleToCreate, inboxPath);
                        if (newNote) {
                            (newNote as any).isNewNote = true;
                            selectNote(newNote);

                        }
                    } catch (createErr) {
                        console.error('❌ [WikiLink] Failed to create note:', createErr);
                    }
                }
            } catch (err) {
                console.error('❌ [WikiLink] Navigation error:', err);
            }
        };

        window.addEventListener('slash:navigate-note', handleWikiLinkNav as unknown as EventListener);
        return () => {
            window.removeEventListener('slash:navigate-note', handleWikiLinkNav as unknown as EventListener);
        };
    }, [repo, vaultPath, selectNote]);


    return {
        // State
        selectedNote,
        content,
        viewMode,
        isNewNote,
        shouldFocusBody,
        noteSelectionKey,
        // Actions
        selectNote,
        handleTabClick,
        // Setters (for gradual migration)
        setSelectedNote,
        setContent,
        setViewMode,
        setIsNewNote,
        setShouldFocusBody,
    };
}
