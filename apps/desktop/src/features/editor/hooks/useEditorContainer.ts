import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import matter from 'gray-matter';
import { TextSelection } from '@tiptap/pm/state';

import { useKeybindingContext } from '@/modules/keybindings/KeybindingProvider';
import { metadataService } from '@/core/metadata/MetadataService';
import { setHeadingBacklinks } from '@slash/editor-core';
import { useFileSystemStore } from '@/core/fs/store';
import * as customSkillService from '@/services/CustomSkillService';

import {
    useSlashEditor,
    useNoteContent,
    useNoteData,
    useEditorEvents,
    useEditorState,
    useFileDrop,
    useContentPersistence,
    useEditorCollaboration,
    useEditorScrollToLine,
    useEditorAIEvents,
    useEditorKeybindings,
} from './index';
import { useNoteContext } from '@/contexts/NoteContext';
import { autoSyncManager } from '@/services/AutoSyncManager';
import { useIsTeamNote } from '@/hooks/useIsTeamNote';

import type { EditorProps } from '../components/Editor';
import { SlashCommandList } from '../components/SlashCommandList';
import type { NoteMetadata } from '../components/PropertiesPanel';

export const useEditorContainer = ({
    initialContent,
    initialMetadata,
    onSave,
    onTitleChange,
    onNoteRenamed: _onNoteRenamed,
    isNewNote,
    shouldFocusBody,
    onNavigateToNote,
    readOnly,
    activeNoteId,
}: EditorProps) => {
    const { t } = useTranslation();
    const { setScope } = useKeybindingContext();
    const fileSystemStore = useFileSystemStore();

    // Get noteId and title from context
    const { noteId, noteIdRef, title: initialTitle } = useNoteContext();
    const isTeamNote = useIsTeamNote(noteId);
    const isVirtualTeamNote = noteId?.startsWith('__team__/') ?? false;

    // ========== State ==========
    const [title, setTitle] = useState(initialTitle);
    const [showProperties, setShowProperties] = useState(false);
    const [frontmatter, setFrontmatter] = useState('');
    const [_isEmpty, setIsEmpty] = useState(false);
    const [showFindBar, setShowFindBar] = useState(false);

    // Compute liveDocStatus from frontmatter, fallback to initialMetadata
    const liveDocStatus = useMemo(() => {
        if (!frontmatter) return (initialMetadata as any)?.doc_status ?? 'solo';
        try {
            const parsed = matter(`---\n${frontmatter}\n---\n`);
            return parsed.data?.doc_status ?? 'solo';
        } catch {
            return (initialMetadata as any)?.doc_status ?? 'solo';
        }
    }, [frontmatter, initialMetadata]);

    const fileId = initialMetadata?.slash_id ?? null;
    const canRequestCollabLock = isTeamNote && liveDocStatus === 'collab' && !readOnly && !isVirtualTeamNote;

    // ── Solo/Collab 模式：在所有 hooks 之前计算有效只读状态 ──
    const {
        isNoteEditor,
        isVaultOwner,
        noteDocStatus,
        effectiveReadOnly,
        readOnlyReason,
        collabLockState,
        collabLockedByName,
        localUser,
        isCollabOffline,
        reportActivity,
    } = useEditorCollaboration(initialMetadata, readOnly, noteId, isTeamNote, liveDocStatus, fileId);

    // Map desktop FS store to editor-core FS store interface
    const coreFsStore = useMemo(() => ({
        ...fileSystemStore,
        isTeamSpace: isTeamNote,
        root: fileSystemStore.root ? { path: fileSystemStore.root.path } : undefined,
    }), [fileSystemStore, isTeamNote]);

    // ========== Refs ==========
    const titleInputRef = useRef<HTMLInputElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const frontmatterRef = useRef('');
    const isMounted = useRef(true);
    const isRenamingLocal = useRef(false);
    const isSaving = useRef(false);
    const hasUserEdited = useRef(false);
    const isLoadingContent = useRef(false);
    const isDeletedRef = useRef(false);
    const editorRef = useRef<any>(null);
    const effectiveReadOnlyRef = useRef(effectiveReadOnly);

    // ========== Hooks ==========

    // 📊 Note Data (AI tags, backlinks, title suggestion)
    const {
        aiTags, aiSummary, hasSummaryUpdate, hasSummarySuggestion,
        refetchAI: fetchAIData,
        titleBacklinks, allBacklinks,
    } = useNoteData();

    const {
        isPropertiesAIRunning,
        setIsPropertiesAIRunning,
        isTitleAIRunning,
        setIsTitleAIRunning,
    } = useEditorAIEvents({ noteId, noteIdRef, setTitle, t });

    // 🎯 Unified Event Handling
    const handleAIDataUpdate = useCallback((_tags: string[] | null, _summary: string | null) => fetchAIData(), [fetchAIData]);
    const handleFrontmatterUpdate = useCallback((fm: string) => {
        setFrontmatter(fm);
        frontmatterRef.current = fm;
    }, []);
    const handleExpandProperties = useCallback(() => setShowProperties(true), []);

    useEditorEvents({
        editorRef,
        isSavingRef: isSaving,
        isLoadingContentRef: isLoadingContent,
        hasUserEditedRef: hasUserEdited,
        onAIDataUpdate: handleAIDataUpdate,
        onFrontmatterUpdate: handleFrontmatterUpdate,
        onExpandProperties: handleExpandProperties,
    });

    // 💾 Content Persistence
    const { saveContent, scheduleSave, handleTitleBlur: baseTitleBlur, cancelPendingSave, flushPendingSave } = useContentPersistence({
        title,
        initialTitle,
        editorRef,
        frontmatterRef,
        isMountedRef: isMounted,
        isSavingRef: isSaving,
        isRenamingRef: isRenamingLocal,
        hasUserEditedRef: hasUserEdited,
        noteIdRef,
        getMarkdown: () => (editorRef.current?.storage as any)?.markdown?.getMarkdown() || '',
        onSave,
        onTitleChange,
        setTitle,
        t,
    });

    const handleTitleBlur = useCallback(async () => {
        if (effectiveReadOnly) return;
        await baseTitleBlur();
    }, [baseTitleBlur, effectiveReadOnly]);

    const activeNotePathRef = useRef(activeNoteId || noteId || '');
    useEffect(() => {
        const currentPath = activeNoteId || noteId || '';
        activeNotePathRef.current = currentPath;

        if (currentPath) {
            invoke('register_active_note_ai', { notePath: currentPath }).catch((err) => {
                console.warn('[Abort] Failed to register active note:', err);
            });
        }

        return () => {
            if (currentPath) {
                invoke('abort_note_ai_jobs', { notePath: currentPath }).catch((err) => {
                    console.warn('[Abort] Failed to abort active note jobs:', err);
                });
            }
        };
    }, [activeNoteId, noteId]);

    const dynamicCustomSkillService = useMemo(() => ({
        ...customSkillService,
        executeCustomSkill: (id: string, content: string) => 
            customSkillService.executeCustomSkill(id, content, activeNotePathRef.current)
    }), []);

    const { editor } = useSlashEditor({
        noteId: noteId!,
        initialContent,
        isLoadingContentRef: isLoadingContent,
        hasUserEditedRef: hasUserEdited,
        editorRef,
        onContentUpdate: scheduleSave,
        onEmptyChange: setIsEmpty,
        onFocusChange: (focused) => setScope('editor', focused),
        customSkillService: dynamicCustomSkillService,
        SlashCommandList,
        readOnly: effectiveReadOnly,
    });

    useEffect(() => {
        effectiveReadOnlyRef.current = effectiveReadOnly;
        if (effectiveReadOnly) {
            cancelPendingSave();
            hasUserEdited.current = false;
            (window as any).__slashEditorDirty = false;
            autoSyncManager.setEditingPath(null);
        } else {
            autoSyncManager.setEditingPath(activeNoteId || noteId || null);
        }
    }, [activeNoteId, cancelPendingSave, effectiveReadOnly, noteId]);

    // 🛡️ CRITICAL FIX: Always keep editorRef up to date across dependency-triggered respawns.
    // Tiptap's onCreate doesn't always refire reliably on dependency array changes when reusing the hook,
    // leaving event listeners holding a ref to a destroyed editor instance (`isDestroyed: true`).
    useEffect(() => {
        if (editor) {
            editorRef.current = editor;
        }
    }, [editor]);

    // 🔧 Tauri native file drops
    useFileDrop({ editor });

    // 📝 Content Loading
    const handleContentLoaded = useCallback((content: string) => {
        if (effectiveReadOnly) return;
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId) return;

        invoke('trigger_ai_orchestrated', {
            triggerType: 'on_open',
            notePath: currentNoteId,
            content,
        }).catch(e => console.error('🤖 [Editor] on_open failed:', e));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveReadOnly]);

    useNoteContent({
        noteId: noteId!,
        initialContent,
        initialMetadata,
        editor,
        isLoadingContentRef: isLoadingContent,
        hasUserEditedRef: hasUserEdited,
        frontmatterRef,
        timerRef,
        setFrontmatter,
        onContentLoaded: handleContentLoaded,
    });

    const getEditorContent = useCallback(() =>
        (editor?.storage as any)?.markdown?.getMarkdown() || '', [editor]);
    useEditorState({
        editor,
        getContent: getEditorContent,
        onStateChange: (_newState) => {},
        onIdleReady: () => fetchAIData(),
    });

    // ========== Effects ==========
    useEffect(() => {
        isMounted.current = true;
        isRenamingLocal.current = false;
        isSaving.current = false;
        isDeletedRef.current = false;
        // 🛡️ 切换笔记时重置脏标记，防止上一篇笔记的残留脏状态阻塞 sync:pulled 热刷新
        (window as any).__slashEditorDirty = false;

        const handleDeletedFlag = (e: Event) => {
            const deletedPath = (e as CustomEvent).detail.path;
            if (noteIdRef.current && (noteIdRef.current === deletedPath || noteIdRef.current.endsWith(deletedPath))) {
                isDeletedRef.current = true;
            }
        };
        window.addEventListener('slash:note-deleted', handleDeletedFlag);

        autoSyncManager.setBeforeSyncHook(async () => {
            const editor = editorRef.current;
            if (!editor || editor.isDestroyed) return;
            if (effectiveReadOnlyRef.current) {
                cancelPendingSave();
                hasUserEdited.current = false;
                (window as any).__slashEditorDirty = false;
                autoSyncManager.setEditingPath(null);
                return;
            }
            if (!hasUserEdited.current) {
                autoSyncManager.setEditingPath(null);
                return;
            }
            cancelPendingSave();
            const markdown = (editor.storage as any)?.markdown?.getMarkdown() || '';
            if (markdown && markdown.trim()) {
                await saveContent(markdown, frontmatterRef.current, { allowRename: false });
            }
        });

        return () => {
            window.removeEventListener('slash:note-deleted', handleDeletedFlag);
            cancelPendingSave();
            const latestNoteId = noteIdRef.current;
            if (latestNoteId && !isDeletedRef.current && !effectiveReadOnlyRef.current) {
                flushPendingSave(latestNoteId);
            }
            isMounted.current = false;
            autoSyncManager.setBeforeSyncHook(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { setTitle(initialTitle); }, [noteId, initialTitle]);

    // 🛡️ 同步离线状态到全局，供 App.tsx 右侧面板读取
    useEffect(() => {
        (window as any).__slashCollabOffline = isCollabOffline;
    }, [isCollabOffline]);

    useEffect(() => {
        if (editor) {
            const timer = setTimeout(() => setHeadingBacklinks(editor, allBacklinks, onNavigateToNote), 100);
            return () => clearTimeout(timer);
        }
    }, [allBacklinks, editor, onNavigateToNote]);

    useEffect(() => {
        if (isNewNote) {
            const timer = setTimeout(() => {
                if (titleInputRef.current) {
                    titleInputRef.current.focus();
                    titleInputRef.current.select();
                }
            }, 150);
            return () => clearTimeout(timer);
        }
    }, [isNewNote]);

    useEffect(() => {
        if (shouldFocusBody && editor && !editor.isDestroyed) {
            setTimeout(() => {
                try { editor.commands.focus('start', { scrollIntoView: false }); } catch { }
            }, 100);
        }
    }, [shouldFocusBody, editor]);

    const handleForceSave = useCallback(async () => {
        if (effectiveReadOnly || !editor || editor.isDestroyed) return;
        cancelPendingSave();
        const markdown = (editor.storage as any)?.markdown?.getMarkdown() || '';
        if (markdown && markdown.trim()) {
            await saveContent(markdown, frontmatterRef.current, { allowRename: false });
        }
    }, [editor, effectiveReadOnly, cancelPendingSave, saveContent]);

    useEditorScrollToLine(editorRef);
    useEditorKeybindings({ editor, setShowFindBar, onForceSave: handleForceSave });

    // ========== Handlers ==========
    const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value);
    const handleTitleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            // Ignore Enter if the user is currently using an IME (e.g., Pinyin composition)
            if (e.nativeEvent.isComposing || e.keyCode === 229) {
                return;
            }
            e.preventDefault();
            titleInputRef.current?.blur();
            setTimeout(() => {
                try { if (editor && !editor.isDestroyed) editor.commands.focus('start', { scrollIntoView: false }); } catch { }
            }, 200);
        }
    };
    
    const handleMetadataChange = (changes: Partial<NoteMetadata>) => {
        if (isLoadingContent.current || effectiveReadOnly) return;
        let currentMeta: any = {};
        try {
            const parsed = matter(`---\n${frontmatterRef.current || ''}\n---`);
            currentMeta = parsed.data;
        } catch { }
        const safeMeta = currentMeta && typeof currentMeta === 'object' ? currentMeta : {};
        const merged = { ...safeMeta, ...changes };
        const fmString = metadataService.cleanFrontmatter(merged);
        setFrontmatter(fmString);
        frontmatterRef.current = fmString;
        hasUserEdited.current = true;
        (window as any).__slashEditorDirty = true;
        if (editor) scheduleSave(() => (editor.storage as any)?.markdown?.getMarkdown() || '');
        if ('doc_status' in changes) {
            autoSyncManager.forceSync('doc_status_changed');
        }
    };

    const handleRunSmartRename = async () => {
        if (!noteId || isTitleAIRunning) return;
        setIsTitleAIRunning(true);
        setIsPropertiesAIRunning(true);
        try {
            const content = (editor?.storage as any)?.markdown?.getMarkdown() || '';
            const { runSkillChain } = await import('@/features/ai/orchestrator');
            await runSkillChain(noteId, content, 'rename');
        } catch (e) {
            console.error('🤖 [Editor] Smart rename failed:', e);
            setIsTitleAIRunning(false);
            setIsPropertiesAIRunning(false);
        }
    };

    const handleRunPropertiesAI = async () => {
        if (!noteId || isPropertiesAIRunning) return;
        setIsPropertiesAIRunning(true);
        try {
            const content = (editor?.storage as any)?.markdown?.getMarkdown() || '';
            const { runSkillChain } = await import('@/features/ai/orchestrator');
            await runSkillChain(noteId, content, 'properties');
            setIsPropertiesAIRunning(false);
        } catch (e) {
            console.error('🤖 [Editor] Magic wand failed:', e);
            setIsPropertiesAIRunning(false);
        }
    };

    const handleEditorClick = useCallback((event?: ReactMouseEvent<HTMLDivElement>) => {
        if (!editor || editor.isDestroyed) return;
        const doc = editor.state.doc;
        const hasOnlyEmptyParagraph = doc.childCount === 1
            && doc.firstChild?.type.name === 'paragraph'
            && doc.firstChild.content.size === 0;

        if (hasOnlyEmptyParagraph) {
            editor.commands.focus('start', { scrollIntoView: false });
            return;
        }

        const target = event?.target as HTMLElement | null;
        if (!target || target.closest('table')) return;

        const { state, view } = editor;
        const { selection, schema } = state;
        const paragraphType = schema.nodes.paragraph;
        if (!paragraphType) return;

        let isInsideTable = false;
        for (let depth = selection.$from.depth; depth > 0; depth--) {
            if (selection.$from.node(depth).type.name === 'table') {
                isInsideTable = true;
                break;
            }
        }

        if (!isInsideTable || state.doc.lastChild?.type.name !== 'table') return;

        const insertPos = state.doc.content.size;
        const tr = state.tr.insert(insertPos, paragraphType.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
        view.dispatch(tr);
        view.focus();
    }, [editor]);

    return {
        // UI State
        title,
        showProperties,
        setShowProperties,
        frontmatter,
        showFindBar,
        setShowFindBar,
        
        // Refs
        titleInputRef,
        
        // Hooks & Context data
        editor,
        aiTags,
        aiSummary,
        hasSummaryUpdate,
        hasSummarySuggestion,
        titleBacklinks,
        isPropertiesAIRunning,
        isTitleAIRunning,
        
        // Computed Info
        noteId,
        activeNoteId,
        effectiveReadOnly,
        readOnlyReason,
        isTeamNote,
        isNoteEditor,
        isVaultOwner,
        noteDocStatus,
        collabLockState,
        collabLockedByName,
        localUser,
        isCollabOffline,
        canRequestCollabLock,
        reportActivity,
        
        // Injected Services
        coreFsStore,
        dynamicCustomSkillService,
        onNavigateToNote,

        // Handlers
        fetchAIData,
        handleTitleChange,
        handleTitleKeyDown,
        handleTitleBlur,
        handleMetadataChange,
        handleRunSmartRename,
        handleRunPropertiesAI,
        handleEditorClick,
    };
};

export type EditorContainerState = ReturnType<typeof useEditorContainer>;
