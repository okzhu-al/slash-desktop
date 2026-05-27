/**
 * useNoteContent - Content Loading and Synchronization
 *
 * Handles:
 * - Initial content loading from props
 * - External sync when file changes
 * - Frontmatter initialization
 *
 * Uses the Sanitize-Parse-Lock Pattern for safe content loading
 */

import { useEffect, useRef } from 'react';
import matter from 'gray-matter';
import { sanitizeMarkdown } from '@/shared/utils/markdownUtils';
import { metadataService } from '@/core/metadata/MetadataService';
import { historyCache } from '../utils/historyCache';
import { getScrollContainer } from './useSlashEditor';
import { EditorState, TextSelection } from '@tiptap/pm/state';


interface UseNoteContentOptions {
    noteId: string;
    initialContent: string;
    initialMetadata: any;
    editor: any;
    // Refs for state management
    isLoadingContentRef: React.MutableRefObject<boolean>;
    hasUserEditedRef: React.MutableRefObject<boolean>;
    frontmatterRef: React.MutableRefObject<string>;
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    // Callbacks
    setFrontmatter: (fm: string) => void;
    /** Called when content is loaded into editor (for triggering on_open) */
    onContentLoaded?: (content: string) => void;
}

export function useNoteContent({
    noteId,
    initialContent,
    initialMetadata,
    editor,
    isLoadingContentRef,
    hasUserEditedRef,
    frontmatterRef,
    timerRef,
    setFrontmatter,
    onContentLoaded,
}: UseNoteContentOptions) {
    // Track last initialized noteId to detect note switches
    const lastInitializedNoteId = useRef<string | null>(null);
    const lastLoadedRawContent = useRef<string>('');

    useEffect(() => {
        if (!editor) return;

        // 🔒 立即设置加载锁（同步，在任何 setTimeout 之前）
        // 防止 ProseMirror doc_status selector 在 render 期间触发 handleMetadataChange
        // 原来只在 loadContent 内部设置，有 10ms 时序窗口会被穿透
        isLoadingContentRef.current = true;

        // Helper: Load content into editor with sanitization and state locking
        const loadContent = (rawBody: string, clearHistory = false) => {


            // 1. Lock already set at effect start; re-confirm here for safety
            isLoadingContentRef.current = true;

            // 2. Sanitize content
            const cleanContent = sanitizeMarkdown(rawBody);

            // 3. Set content - if clearing history, use chain to prevent undo recording
            if (clearHistory) {
                // Use chain command to set content without adding to undo history
                // This prevents Ctrl+Z from reverting to previous note's state
                editor.chain()
                    .setMeta('addToHistory', false)
                    .setContent(cleanContent, false)
                    .run();
                const tr = editor.view.state.tr;
                tr.setMeta('addToHistory', false);
                tr.setMeta('resetHistory', true);
                editor.view.dispatch(tr);

            } else {
                // Case 2: external sync — load new content, preserve undo history
                // ⚠️ emitUpdate MUST be false (boolean), NOT { emitUpdate: false } (object/truthy)
                // Passing an object makes TipTap treat emitUpdate as true → onUpdate fires
                // → scheduleSave → saveNote → watcher → Case 2 again → infinite loop!
                editor.commands.setContent(cleanContent, false);
            }

            // 4. Unlock - use setTimeout to ensure rendering completes
            setTimeout(() => {
                isLoadingContentRef.current = false;
            }, 10);

            return cleanContent;
        };

        const initTimer = setTimeout(() => {
            const rawContent = initialContent || '';

            // Safely parse frontmatter - handle files without proper YAML structure
            let cleanBody = rawContent;
            let parsedFmData: Record<string, any> = {};
            try {
                const parsed = matter(rawContent);
                cleanBody = parsed.content;
                parsedFmData = parsed.data || {};
            } catch (e) {
                // If gray-matter fails (e.g., content starts with list that looks like YAML),
                // treat the entire content as body with no frontmatter
                console.warn('[useNoteContent] Failed to parse frontmatter, using raw content:', e);
            }



            // 优先使用 initialMetadata；若为空则回退到从 content 中解析的 frontmatter
            const effectiveMetadata = (initialMetadata && Object.keys(initialMetadata).length > 0)
                ? initialMetadata
                : parsedFmData;
            const normalizedPropFm = metadataService.cleanFrontmatter(effectiveMetadata || {});

            // Case 1: Switching to a different note
            if (noteId !== lastInitializedNoteId.current) {

                hasUserEditedRef.current = false; // Reset edit tracking for new note
                (window as any).__slashEditorDirty = false;
                setFrontmatter(normalizedPropFm);
                frontmatterRef.current = normalizedPropFm;
                lastInitializedNoteId.current = noteId;
                lastLoadedRawContent.current = rawContent;

                let loadedContent = cleanBody;

                // 🚀 Cache path: 尝试从缓存获取包含 doc、撤销栈及位置状态的对象，跳过 markdown 解析
                const cached = historyCache.retrieveDoc(noteId, initialContent || '');

                if (cached) {

                    try {
                        const { state, view } = editor;
                        const node = state.schema.nodeFromJSON(cached.docJSON);
                        
                        // 1. 计算安全的选区
                        let safeSelection = undefined;
                        if (cached.selection) {
                            const maxPos = node.content.size;
                            const safeAnchor = Math.min(cached.selection.anchor, maxPos);
                            const safeHead = Math.min(cached.selection.head, maxPos);
                            try {
                                const $anchor = node.resolve(safeAnchor);
                                const $head = node.resolve(safeHead);
                                safeSelection = new TextSelection($anchor, $head);
                            } catch (e) {
                                console.warn('[useNoteContent] Failed to resolve selection positions:', e);
                            }
                        }

                        // 2. 🚀 创世状态重置：创建一个干净、无任何历史包袱、撤销栈天然为 0 的新 state
                        const tempState = EditorState.create({
                            doc: node,
                            selection: safeSelection,
                            plugins: state.plugins,
                        });

                        // 3. 一键套回编辑器，完成极速秒开、光标复位与撤销历史无痛清零！
                        view.updateState(tempState);
                        
                    } catch (err) {
                        console.error('[useNoteContent] Failed to restore document with pure state reset:', err);
                        // 兜底回退
                        editor.commands.setContent(cached.docJSON, false);
                    }

                    // Step 3: 恢复上一次的滚动高度 (ScrollTop)
                    if (typeof cached.scrollTop === 'number') {
                        setTimeout(() => {
                            if (!editor.isDestroyed) {
                                const scrollContainer = getScrollContainer(editor.view.dom);
                                if (scrollContainer) {
                                    scrollContainer.scrollTop = cached.scrollTop!;
                                }
                            }
                        }, 20);
                    }

                    setTimeout(() => {
                        isLoadingContentRef.current = false;
                        window.dispatchEvent(new CustomEvent('slash:editor-content-loaded', { detail: { noteId } }));
                    }, 10);
                } else {
                    // Regular fresh parsing path
                    loadedContent = loadContent(cleanBody, true);

                    // 💾 LocalStorage 跨会话阅读位置自动记忆恢复（首次冷启动路径）
                    const storedPos = historyCache.getStoredPosition(noteId);
                    if (storedPos) {
                        setTimeout(() => {
                            try {
                                if (!editor.isDestroyed) {
                                    const maxPos = editor.state.doc.content.size;
                                    const safeAnchor = Math.min(storedPos.anchor, maxPos);
                                    const safeHead = Math.min(storedPos.head, maxPos);
                                    editor.commands.setTextSelection({ from: safeAnchor, to: safeHead });

                                    const scrollContainer = getScrollContainer(editor.view.dom);
                                    if (scrollContainer && typeof storedPos.scrollTop === 'number') {
                                        scrollContainer.scrollTop = storedPos.scrollTop;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }, 50); // 给 Tiptap/ProseMirror 渲染及 DOM 绘制留出 50ms 缓冲时钟
                    }
                    // 🚀 仅在冷启动全新解析路径下，才需要记录本次加载的内容 hash 并初始化缓存
                    historyCache.recordLoadHash(noteId, rawContent);
                    try {
                        if (editor.state.doc.content.childCount > 0) {
                            historyCache.saveDoc(noteId, editor.state.doc.toJSON());
                        }
                    } catch(e) { /* ignore */ }
                }

                // Trigger on_open AFTER first paint settled — 不与渲染争夺主线程
                setTimeout(() => {
                    onContentLoaded?.(loadedContent);
                    window.dispatchEvent(new CustomEvent('slash:editor-content-loaded', { detail: { noteId } }));
                }, 100);
                return;
            }


            // Frontmatter sync
            if (normalizedPropFm !== frontmatterRef.current && !timerRef.current) {
                setFrontmatter(normalizedPropFm);
                frontmatterRef.current = normalizedPropFm;
            }

            // Case 2: Same note, but parent content changed after sync/pull.
            // Previously this branch only refreshed frontmatter, so the editor body kept
            // showing the stale ProseMirror document until a full remount happened.
            if (rawContent !== lastLoadedRawContent.current) {
                if (hasUserEditedRef.current || (window as any).__slashEditorDirty || timerRef.current) {
                    isLoadingContentRef.current = false;
                    return;
                }

                setFrontmatter(normalizedPropFm);
                frontmatterRef.current = normalizedPropFm;
                const loadedContent = loadContent(cleanBody, false);
                hasUserEditedRef.current = false;
                (window as any).__slashEditorDirty = false;
                lastLoadedRawContent.current = rawContent;
                historyCache.recordLoadHash(noteId, rawContent);

                try {
                    if (editor.state.doc.content.childCount > 0) {
                        historyCache.saveDoc(noteId, editor.state.doc.toJSON());
                    }
                } catch(e) { /* ignore */ }

                setTimeout(() => {
                    onContentLoaded?.(loadedContent);
                    window.dispatchEvent(new CustomEvent('slash:editor-content-loaded', { detail: { noteId } }));
                }, 100);
                return;
            }

        }, 10);

        // 如果没有触发 loadContent（即没走 Case 1 也没走 Case 2 的 force/sync）
        // 这里必须兜底释放锁，否则因为 re-render 导致的前置加锁会永久锁死编辑器输入
        const unlockTimer = setTimeout(() => {
            isLoadingContentRef.current = false;
        }, 50); // 留出一点缓冲时间让 loadContent 的 10ms timer 先跑完

        return () => {
            clearTimeout(initTimer);
            clearTimeout(unlockTimer);
            // 卸载时如果不处于加载状态中，确保释放锁
            isLoadingContentRef.current = false;
        };

    }, [noteId, initialContent, initialMetadata, editor]);
}
