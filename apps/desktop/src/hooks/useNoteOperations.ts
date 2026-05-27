/**
 * useNoteOperations Hook
 * 
 * Handles note CRUD operations: save, title update, delete, and tab close.
 * Extracted from App.tsx to improve code organization.
 */

import { useRef, useCallback } from 'react';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '@/core/tabs/TabsStore';
import { useFileSystemStore } from '@/core/fs/store';
import { sanitizeFilename } from '@/core/utils/sanitization';
import { getRelativePath, getBasename } from '@/shared/utils/pathUtils';
import type { FileSystemNoteRepository } from '@/core/storage/FileSystemNoteRepository';
import type { Note } from '@/core/storage/types';

export interface UseNoteOperationsProps {
    repo: FileSystemNoteRepository | null;
    vaultPath: string | null;
    selectedNote: Note | null;
    setSelectedNote: (note: Note | null) => void;
    setContent: (content: string | null) => void;
    setViewMode: (mode: 'editor' | 'media') => void;
    setIsNewNote: (isNew: boolean) => void;
    setShouldFocusBody: (focus: boolean) => void;
    onAfterSave?: (linksChanged: boolean) => void;  // Callback with link change info for smart graph refresh
}

export interface NoteOperations {
    handleSave: (targetNotePath: string, targetFileId: string | null, newBody: string, newMetadata: any, options?: { allowRename?: boolean }) => Promise<void>;
    handleTitleUpdate: (newTitle: string) => Promise<void>;
    handleNoteDeleted: (deletedNoteId: string) => void;
    handleTabClose: (closedTabId: string) => Promise<void>;
    isRenaming: React.MutableRefObject<boolean>;
}

export function useNoteOperations({
    repo,
    vaultPath,
    selectedNote,
    setSelectedNote,
    setContent,
    setViewMode,
    setIsNewNote,
    setShouldFocusBody,
    onAfterSave,
}: UseNoteOperationsProps): NoteOperations {
    const isRenaming = useRef(false);
    const operationMutex = useRef<Promise<any>>(Promise.resolve());

    // Use ref to track latest selectedNote to avoid closure issues in async callbacks
    const selectedNoteRef = useRef(selectedNote);
    selectedNoteRef.current = selectedNote;

    const handleSave = useCallback(async (
        targetNotePath: string,
        targetFileId: string | null,
        newBody: string,
        newMetadata: any,
        options?: { allowRename?: boolean }
    ) => {
        // CRITICAL: If we are currently renaming, ignore auto-save to prevent race conditions
        if (isRenaming.current) {
            return;
        }

        // Queue operation to ensure serial execution of Tauri IPC calls
        const promise = operationMutex.current.then(async () => {
            if (!targetNotePath || !repo) return;

            // 🛡️ Identity Guard: 使用 Editor 实例捕获的 targetNotePath 作为权威路径。
            // selectedNoteRef.current 可能已漂移到其他笔记（用户快速切换时），
            // 但 targetNotePath 在 Editor 生命周期内是稳定的。
            const refNote = selectedNoteRef.current;
            const currentSelectedNote = (refNote && refNote.id === targetNotePath)
                ? refNote
                : {
                    id: targetNotePath,
                    path: targetNotePath,
                    title: getBasename(targetNotePath)?.replace(/\.md$/, '') || '',
                    content: '',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

            // 🛡️ file_id 一致性校验：如果 metadata 中的 slash_id 与 Editor 捕获的不一致，以 Editor 的为准
            if (targetFileId && newMetadata?.slash_id && newMetadata.slash_id !== targetFileId) {
                console.warn(
                    `🛡️ [handleSave] slash_id drift detected! metadata.slash_id=${newMetadata.slash_id} vs captured=${targetFileId}. Using captured value.`
                );
                newMetadata.slash_id = targetFileId;
            }

            try {
                // Rehydrate title and handle potential rename from YAML
                let newTitleFromMetadata: string | undefined = undefined;
                if (newMetadata.title !== undefined && newMetadata.title !== null) {
                    newTitleFromMetadata = String(newMetadata.title);
                }

                let updatedNote = {
                    ...currentSelectedNote,
                    content: newBody,
                    metadata: newMetadata,
                    updatedAt: Date.now()
                };

                if (newTitleFromMetadata && newTitleFromMetadata !== currentSelectedNote.title) {
                    if (options?.allowRename !== false) {
                        const safeName = sanitizeFilename(newTitleFromMetadata);
                        const currentName = getBasename(currentSelectedNote.path)?.replace(/\.md$/, '') || '';

                        let newPath = currentSelectedNote.path;
                        if (safeName && safeName !== currentName) {
                            try {
                                newPath = await repo.renameNote(currentSelectedNote.id, safeName);
                                useFileSystemStore.getState().renameNode(currentSelectedNote.id, newPath);

                                // Sync SQLite database after rename
                                if (vaultPath) {
                                    const relativePath = getRelativePath(newPath, vaultPath);
                                    invoke('scan_single_file', { vaultPath, relativePath }).catch(console.error);
                                    invoke('scan_vault', { vaultPath }).catch(console.error);
                                }
                            } catch (e) {
                                console.error("Failed to rename file during YAML sync", e);
                            }
                        }

                        updatedNote.title = newTitleFromMetadata;
                        updatedNote.id = newPath;
                        updatedNote.path = newPath;
                    }
                } else {
                    // Metadata (Tags) changed but title stayed same
                    useFileSystemStore.getState().updateNodeMetadata(currentSelectedNote.id, {
                        tags: newMetadata.tags,
                        title: updatedNote.title
                    });
                }

                setSelectedNote(updatedNote);
                // CRITICAL: Immediately sync the ref so subsequent mutex jobs (e.g., handleTitleUpdate)
                // can read the latest content WITHOUT waiting for React to re-render.
                // React state updates (setSelectedNote) are async — the render that would update
                // selectedNoteRef.current = selectedNote may not have happened before Job B reads it.
                selectedNoteRef.current = updatedNote;
                
                // CRITICAL FIX: We MUST call setContent(newBody) to keep React state synchronized!
                // The original "cursor jump" concern was caused by Case 2 in useNoteContent, which has now been deleted.
                // If we don't sync this, `App.tsx` holds a stale content state. When Smart Rename 
                // changes the note ID, the Editor remounts and injects this stale state, causing data loss!
                setContent(newBody);
                
                await repo.saveNote(updatedNote);

                if (vaultPath) {
                    const relativePath = getRelativePath(updatedNote.path, vaultPath);
                    invoke('scan_single_file', { vaultPath, relativePath }).catch(console.error);
                }

                // Detect if links changed (exclude code blocks, inline code, and math)
                const extractLinks = (text: string): string[] => {
                    // Remove fenced code blocks (```...```)
                    let cleaned = text.replace(/```[\s\S]*?```/g, '');
                    // Remove inline code (`...`)
                    cleaned = cleaned.replace(/`[^`]+`/g, '');
                    // Remove block math ($$...$$)
                    cleaned = cleaned.replace(/\$\$[\s\S]*?\$\$/g, '');
                    // Remove inline math ($...$)
                    cleaned = cleaned.replace(/\$[^$]+\$/g, '');
                    // Now extract [[...]] links
                    const matches = cleaned.match(/\[\[([^\]]+)\]\]/g) || [];
                    return matches.sort();
                };
                const oldLinks = extractLinks(currentSelectedNote.content || '');
                const newLinks = extractLinks(newBody);
                const linksChanged = JSON.stringify(oldLinks) !== JSON.stringify(newLinks);

                // Trigger graph refresh only if links changed
                onAfterSave?.(linksChanged);
            } catch (e) {
                console.error("[App] Save Mutex Error:", e);
            }
        }).catch(err => {
            console.error("[App] Critical Mutex Failure:", err);
        });
        operationMutex.current = promise;
        return promise;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repo, setSelectedNote, setContent, onAfterSave, vaultPath]); // selectedNoteRef is stable

    const handleTitleUpdate = useCallback(async (newTitle: string) => {
        // Clear new note flag to prevent title re-selection on remount
        setIsNewNote(false);
        // Signal that editor body should be focused after potential remount
        setShouldFocusBody(true);

        // Queue operation to ensure serial execution
        const promise = operationMutex.current.then(async () => {
            // CRITICAL: Use ref to get the LATEST selectedNote.
            // handleSave (job A) may have run before this job in the mutex and updated
            // selectedNoteRef.current with the latest editor content. Using the stale closure
            // selectedNote would overwrite the file with old (possibly empty) content.
            const currentNote = selectedNoteRef.current;
            if (!currentNote || !repo) return;

            const sanitizedName = sanitizeFilename(newTitle);
            const safeName = sanitizedName || 'Untitled';
            const currentName = getBasename(currentNote.path)?.replace(/\.md$/, '') || '';

            let newPath = currentNote.path;
            if (safeName !== currentName) {
                isRenaming.current = true;
                try {
                    newPath = await repo.renameNote(currentNote.id, safeName);
                    useFileSystemStore.getState().renameNode(currentNote.id, newPath);

                    // Sync SQLite database: scan new path and rescan vault to remove old entry
                    if (vaultPath) {
                        const relativePath = getRelativePath(newPath, vaultPath);
                        invoke('scan_single_file', { vaultPath, relativePath }).catch(console.error);
                        invoke('scan_vault', { vaultPath }).catch(console.error);
                    }

                    // Update tab: close old path, open new path
                    const tabsStore = useTabsStore.getState();
                    tabsStore.closeTab(currentNote.id);
                    tabsStore.openTab(newPath, safeName);

                    await emit('note-renamed', {
                        oldId: currentNote.id,
                        newId: newPath,
                        newTitle: safeName,
                        newPath
                    });
                } catch (e) {
                    console.error("Failed to rename file during title sync", e);
                } finally {
                    isRenaming.current = false;
                }
            }

            const updatedNote = {
                ...currentNote,          // ← use currentNote (has latest content from handleSave)
                id: newPath,
                path: newPath,
                title: newTitle,
                metadata: {
                    ...currentNote.metadata,
                    title: newTitle
                },
                updatedAt: Date.now()
            };

            // CRITICAL ORDER: saveNote → setSelectedNote → setContent
            // repo.saveNote must run FIRST to write latest content to the new path on disk.
            // setSelectedNote triggers useNoteContent to read from disk — if disk is stale
            // (saveNote not done yet), the disk read overwrites the correct content.
            await repo.saveNote(updatedNote);

            setSelectedNote(updatedNote);

            // Sync content React state after rename.
            // Editor key={selectedNote.id} will change → Editor remounts with initialContent={content}.
            setContent(updatedNote.content);
        }).catch(err => {
            console.error("[App] Mutex TitleUpdate Error:", err);
        });
        operationMutex.current = promise;
        return promise;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repo, setSelectedNote, setContent, setIsNewNote, setShouldFocusBody, vaultPath]); // selectedNoteRef is stable

    const handleNoteDeleted = useCallback(async (deletedNoteId: string) => {
        const currentNote = selectedNoteRef.current;


        // 发送通用死亡通告，强制相关处于打开状态的编辑器立刻停止自动下盘（防鞭尸）
        window.dispatchEvent(new CustomEvent('slash:note-deleted', { detail: { path: deletedNoteId } }));

        // Close the tab for the deleted note
        useTabsStore.getState().closeTab(deletedNoteId);

        // Case-insensitive and slash-agnostic path comparison
        const normalize = (p: string) => p.toLowerCase().replace(/\\/g, '/');
        const normCurrent = currentNote?.id ? normalize(currentNote.id) : '[NONE]';
        const normDeleted = normalize(deletedNoteId);
        
        const isCurrentNote = currentNote?.id ? normCurrent === normDeleted : false;
        
        if (isCurrentNote) {


            // Try to load the new active tab's content
            const { activeTabId } = useTabsStore.getState();


            if (activeTabId && repo) {
                try {
                    const note = await repo.getNote(activeTabId);

                    if (note) {

                        setSelectedNote(note);
                        setContent(note.content);
                        setViewMode('editor');
                        // Prevent title auto-selection when switching to another note
                        setIsNewNote(false);
                    } else {

                        setSelectedNote(null);
                        setContent(null);
                        setViewMode('editor');
                    }
                } catch (e) {

                    setSelectedNote(null);
                    setContent(null);
                    setViewMode('editor');
                }
            } else {

                // No active tab, clear editor
                setSelectedNote(null);
                setContent(null);
                setViewMode('editor');
            }
        }

        // Trigger database rescan to remove deleted note from SQLite
        if (vaultPath) {
            invoke('scan_single_file', { vaultPath, filePath: deletedNoteId }).catch(() => {
                // File deleted, rescan vault to update DB
                invoke('scan_vault', { vaultPath }).catch(console.error);
            });
        }

        // Trigger graph refresh after delete (links always changed when note deleted)
        onAfterSave?.(true);
    }, [vaultPath, repo, selectedNote, setSelectedNote, setContent, setViewMode, onAfterSave]);

    const handleTabClose = useCallback(async (closedTabId: string) => {
        // If we closed the currently displayed note, we need to switch
        if (selectedNote?.id === closedTabId) {
            const { activeTabId } = useTabsStore.getState();
            if (activeTabId && repo) {
                // Switch to the new active tab
                try {
                    const note = await repo.getNote(activeTabId);
                    if (note) {
                        setSelectedNote(note);
                        setContent(note.content);
                        setViewMode('editor');
                        return;
                    }
                } catch (e) {
                    console.error("Failed to load new active tab", e);
                }
            }
            // No active tab or failed to load, clear editor
            setSelectedNote(null);
            setContent(null);
            setViewMode('editor');
        }
    }, [repo, selectedNote, setSelectedNote, setContent, setViewMode]);

    return {
        handleSave,
        handleTitleUpdate,
        handleNoteDeleted,
        handleTabClose,
        isRenaming,
    };
}
