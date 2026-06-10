/**
 * useContentPersistence - Unified content saving and title rename management
 * 
 * Consolidates:
 * 1. saveContent - with frontmatter merging and AttributeLink extraction
 * 2. Debounced auto-save (500ms)
 * 3. Title rename with force-save-before-rename pattern
 */

import { useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getBasename, getRelativePath } from '@/shared/utils/pathUtils';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import matter from 'gray-matter';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileSystemStore } from '@/core/fs/store';
import { historyCache } from '../utils/historyCache';

interface ContentPersistenceProps {
    title: string;
    initialTitle: string;
    editorRef: React.MutableRefObject<any>;
    frontmatterRef: React.MutableRefObject<string>;
    isMountedRef: React.MutableRefObject<boolean>;
    isSavingRef: React.MutableRefObject<boolean>;
    isRenamingRef: React.MutableRefObject<boolean>;
    /** 用户是否真正编辑了内容（onTransaction 设置）*/
    hasUserEditedRef: React.MutableRefObject<boolean>;
    getMarkdown: () => string;
    /** 当前 Editor 实例对应的笔记路径 ref（来自 NoteContext，Editor 生命周期内稳定） */
    noteIdRef: React.RefObject<string | null>;
    onSave: (targetNotePath: string, targetFileId: string | null, body: string, metadata: any, options?: { allowRename?: boolean }) => void | Promise<void>;
    onTitleChange?: (newTitle: string) => void;
    setTitle: (title: string) => void;
    t: (key: string, params?: any) => string;
    isTeamNote?: boolean;
}

interface PersistenceResult {
    saveContent: (body: string, fm: string, options?: { allowRename?: boolean }) => Promise<void>;
    scheduleSave: (contentProvider: () => string) => void;
    handleTitleBlur: () => Promise<void>;
    cancelPendingSave: () => void;
    /** 绕开 onSave/selectedNoteRef，直接将 pending content 写入固定路径（笔记切换 cleanup 专用）*/
    flushPendingSave: (absoluteNotePath: string) => Promise<void>;
}

export function useContentPersistence({
    title,
    initialTitle,
    editorRef,
    frontmatterRef,
    isMountedRef,
    isSavingRef,
    isRenamingRef,
    hasUserEditedRef,
    noteIdRef,
    getMarkdown,
    onSave,
    onTitleChange,
    setTitle,
    t,
    isTeamNote,
}: ContentPersistenceProps): PersistenceResult {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 记录最新 pending content provider（scheduleSave 时更新），供 flushPendingSave 使用
    const pendingContentProviderRef = useRef<(() => string) | null>(null);
    const pendingFmRef = useRef<string | null>(null);

    // CRITICAL: Track isTeamNote using ref because it is populated asynchronously
    // Using it directly inside saveContent closure causes it to be locked to initial `false`
    const isTeamNoteRef = useRef(isTeamNote);
    isTeamNoteRef.current = isTeamNote;

    const getConfirmedTitle = useCallback((safeMeta: Record<string, any>) => {
        if (typeof safeMeta.title === 'string' && safeMeta.title.trim()) {
            return safeMeta.title;
        }
        return initialTitle;
    }, [initialTitle]);

    /**
     * Core save function with frontmatter parsing
     * Note: AttributeLink relations extraction is now handled by Rust backend
     */
    const saveContent = useCallback(async (
        body: string,
        fm: string,
        options: { allowRename?: boolean } = {}
    ) => {
        if (isRenamingRef.current || isSavingRef.current) return;

        let currentMeta: any = {};
        try {
            const wrapped = `---\n${fm || ''}\n---`;
            currentMeta = matter(wrapped).data;
        } catch (e) {
            console.warn("Failed to parse frontmatter during save", e);
        }

        // 🛡️ Empty Markdown Shield: Prevent catastrophic data loss during race conditions
        // If Tiptap or the sync engine passes completely empty strings for both body and frontmatter,
        // it indicates a pipeline failure. We must block this write.
        if (!body?.trim() && !fm?.trim() && !Object.keys(currentMeta || {}).length) {
            console.error('🛡️ [useContentPersistence] DATA LOSS PREVENTION: Attempted to save completely empty document (0 bytes body and frontmatter). Aborting save!');
            isSavingRef.current = false;
            return;
        }

        const safeMeta = (currentMeta && typeof currentMeta === 'object') ? currentMeta : {};

        // Keep autosave on the last confirmed title. The live input value may still be unconfirmed.
        const mergedMeta = {
            ...safeMeta,
            title: getConfirmedTitle(safeMeta),
        };

        // 🛡️ contributor 写入门控：仅用户真正编辑时才加入（防止 B 打开笔记即改变 frontmatter hash）
        const displayName = useSessionStore.getState().displayName;
        if (displayName && hasUserEditedRef.current) {
            // 🛡️ BUG21-v2: 双重信号判定 — 异步 isTeamNote + 同步 doc_status 兜底
            // doc_status 仅存在于团队文件（solo/collab），个人文件无此字段
            const effectiveIsTeamNote = isTeamNoteRef.current || !!mergedMeta.doc_status;
            if (!effectiveIsTeamNote) {
                // Personal Space Note: Automatically claim ownership to avoid lockout
                mergedMeta.editor = displayName;
            } else {
                // Team Note: Only add to contributors for collab mode
                // 🛡️ Solo mode: NEVER overwrite editor — Solo lock is enforced server-side
                if (mergedMeta.doc_status !== 'solo' && mergedMeta.editor !== displayName) {
                    const existing: string[] = Array.isArray(mergedMeta.contributors)
                        ? mergedMeta.contributors
                        : [];
                    if (!existing.includes(displayName)) {
                        mergedMeta.contributors = [...existing, displayName];
                    }
                }
            }
        }

        try {
            if (!isMountedRef.current) return;

            isSavingRef.current = true;

            // 📍 Capture stable identity at call time, not at async execution time
            const capturedNotePath = noteIdRef.current;
            const capturedFileId = mergedMeta?.slash_id || null;


            await onSave(capturedNotePath!, capturedFileId, body, mergedMeta, options);

            // AI is now triggered by editor state transitions (Open/Active/Idle/Blur)

            // Update history cache to prevent cache invalidation due to our own saves
            try {
                // 🚀 CRITICAL FIX: 统一以剥离了 Frontmatter 的 body 纯正文作为 Hash 校验的唯一权威媒介！
                // 这能 100% 避免因物理文件头部带有 Frontmatter 导致与 initialContent 的 Hash 发生 mismatch 从而删除缓存
                historyCache.updateHash(capturedNotePath!, body);
                // Also update the current editor's docJSON in the cache so it's fresh
                if (editorRef.current && !editorRef.current.isDestroyed) {
                    historyCache.saveDoc(capturedNotePath!, editorRef.current.state.doc.toJSON());
                }
            } catch (err) {
                console.warn('[useContentPersistence] Failed to update history cache hash:', err);
            }

            // Delay resetting isSaving to prevent watcher race condition
            setTimeout(() => { isSavingRef.current = false; }, 300);
            (window as any).__slashEditorDirty = false;
        } catch (e) {
            isSavingRef.current = false;
            if (isMountedRef.current) {
                console.error('[useContentPersistence] Save failed:', e);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editorRef, frontmatterRef, getConfirmedTitle, isMountedRef, isSavingRef, isRenamingRef, noteIdRef, onSave]);

    /**
     * Schedule a debounced save (500ms delay)
     */
    const scheduleSave = useCallback((contentProvider: () => string) => {
        if (timerRef.current) clearTimeout(timerRef.current);

        // 记录最新 pending content provider
        pendingContentProviderRef.current = contentProvider;
        pendingFmRef.current = frontmatterRef.current;

        timerRef.current = setTimeout(() => {

            if (pendingContentProviderRef.current) {
                const contentSnapshot = pendingContentProviderRef.current();
                // 🛡️ BUG-D06: thunk 返回空字符串表示 "内容未变化，跳过保存"
                // 之前未检查返回值，导致空字符串被当作有效 body 写入磁盘，
                // 清空整个文件 + 触发 orphan cleanup 删除所有资产
                if (!contentSnapshot) {

                    pendingContentProviderRef.current = null;
                    pendingFmRef.current = null;
                    return;
                }
                saveContent(contentSnapshot, frontmatterRef.current, { allowRename: false });
                pendingContentProviderRef.current = null;
            }
            pendingFmRef.current = null;
        }, 5000); // 🚀 拉长至 5000ms，确保只有彻底停手时才执行 Markdown 序列化与写盘
    }, [saveContent, frontmatterRef]);

    /**
     * 紧急 flush：笔记切换时在 cleanup 里调用，直接写入固定路径
     * 不走 onSave → handeSave → selectedNoteRef 这条危险路由
     * absoluteNotePath 来自 Editor props（实例生命周期内固定不变）
     */
    const flushPendingSave = useCallback(async (absoluteNotePath: string) => {
        const provider = pendingContentProviderRef.current;
        const fm = pendingFmRef.current ?? frontmatterRef.current;
        if (!provider) return; // 没有 pending provider，不需要 flush
        const body = provider();
        if (!body) return; // 空数据防御

        pendingContentProviderRef.current = null;
        pendingFmRef.current = null;

        try {
            let currentMeta: any = {};
            try {
                const wrapped = `---\n${fm || ''}\n---`;
                currentMeta = matter(wrapped).data;
            } catch { }

            const safeMeta = (currentMeta && typeof currentMeta === 'object') ? currentMeta : {};
            const mergedMeta = { ...safeMeta, title: getConfirmedTitle(safeMeta) };

            // 使用 metadataService 序列化：直接 import stringify 构建文件内容
            // 为避免引入额外依赖，用 gray-matter stringify
            const stringified = matter.stringify(body, mergedMeta);

            // 比较现有内容，避免无意义写盘
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            try {
                const existing = await readTextFile(absoluteNotePath);
                if (existing.trimEnd() === stringified.trimEnd()) return;
            } catch { /* 文件不存在 → 继续写入 */ }

            await writeTextFile(absoluteNotePath, stringified);
            console.log('💾 [flushPendingSave] Flushed on note switch:', getBasename(absoluteNotePath));
            // 🚀 CRITICAL FIX: 在切换笔记紧急写盘后，同步更新缓存里的 Hash，确保切回来时 100% 能够匹配成功！
            historyCache.updateHash(absoluteNotePath, body);

            // 更新 SQLite（fire-and-forget）
            const rootDir = useFileSystemStore.getState().root?.path;
            if (rootDir) {
                const relativePath = getRelativePath(absoluteNotePath, rootDir);
                invoke('scan_single_file', { vaultPath: rootDir, relativePath }).catch(() => {});
            }
        } catch (e) {
            console.warn('[flushPendingSave] Failed:', e);
        }
    }, [frontmatterRef, getConfirmedTitle]);

    /**
     * Cancel any pending debounced save
     */
    const cancelPendingSave = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    /**
     * Handle title blur with force-save-before-rename pattern
     * 
     * Critical: Must save current content BEFORE triggering rename,
     * otherwise noteId changes and unsaved content is lost.
     */
    const handleTitleBlur = useCallback(async () => {
        const cleanTitle = title.trim();

        if (cleanTitle !== initialTitle && cleanTitle !== "") {
            // Check for duplicate title across entire vault
            try {
                const exists = await invoke<boolean>('check_note_exists', {
                    noteName: cleanTitle,
                    excludePath: noteIdRef.current,
                });
                if (exists) {
                    // Show prominent warning using Tauri dialog
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    await message(
                        t('sidebar.duplicate_name_warning', { name: cleanTitle }),
                        {
                            title: t('sidebar.duplicate_name_title'),
                            kind: 'warning'
                        }
                    );
                    // Revert to original title
                    setTitle(initialTitle);
                    return;
                }
            } catch (e) {
                console.warn('[useContentPersistence] Failed to check duplicate name:', e);
            }

            // 🔒 CRITICAL: Save current editor content BEFORE rename
            // Otherwise, rename changes noteId, Editor reloads, and unsaved content is lost
            const editor = editorRef.current;
            if (editor && !editor.isDestroyed && editor.view) {
                const currentBody = getMarkdown();
                await saveContent(currentBody, frontmatterRef.current, { allowRename: false });
            }

            // Cancel any pending debounced save
            cancelPendingSave();

            if (!isMountedRef.current) return;
            onTitleChange?.(cleanTitle);
        } else if (cleanTitle === "") {
            setTitle(initialTitle);
        }
    }, [title, initialTitle, editorRef, frontmatterRef, isMountedRef, getMarkdown, saveContent, cancelPendingSave, onTitleChange, setTitle, t]);

    return {
        saveContent,
        scheduleSave,
        handleTitleBlur: handleTitleBlur as () => Promise<void>,
        cancelPendingSave,
        flushPendingSave,
    };
}
