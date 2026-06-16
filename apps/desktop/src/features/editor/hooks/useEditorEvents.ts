/**
 * useEditorEvents - Unified event management for Editor
 * 
 * Consolidates all Tauri/window event listeners into a single hook,
 * preventing race conditions and simplifying cleanup.
 * 
 * v2.0: Uses NoteContext to get noteIdRef, solving closure issues in event listeners.
 */

import { useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { readTextFile } from '@tauri-apps/plugin-fs';
import matter from 'gray-matter';
import { metadataService } from '@/core/metadata/MetadataService';
import { useNoteContext } from '@/contexts';
import { syncService } from '@/services/SyncService';
import { useSessionStore } from '@/stores/useSessionStore';
import { TextSelection } from '@tiptap/pm/state';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';
import { getScrollContainer } from './useSlashEditor';

interface EditorEventsProps {
    editorRef: React.MutableRefObject<any>;
    isSavingRef: React.MutableRefObject<boolean>;
    isLoadingContentRef: React.MutableRefObject<boolean>;
    hasUserEditedRef: React.MutableRefObject<boolean>;
    onAIDataUpdate: (tags: string[] | null, summary: string | null) => void;
    onFrontmatterUpdate: (frontmatter: string) => void;
    onExpandProperties: () => void;
}

interface AISkillCompleteEvent {
    path: string;
    tags: string[] | null;
    summary: string | null;
    has_embedding: boolean;
}

export function useEditorEvents({
    editorRef,
    isSavingRef,
    isLoadingContentRef,
    hasUserEditedRef,
    onAIDataUpdate,
    onFrontmatterUpdate,
    onExpandProperties,
}: EditorEventsProps) {
    // Get noteIdRef from context (always points to current value)
    const { noteId, noteIdRef } = useNoteContext();

    // Track all unlisteners for cleanup
    const unlistenersRef = useRef<Map<string, UnlistenFn | (() => void)>>(new Map());

    const matchesPulledPath = (currentNoteId: string, pulledPath: string) => {
        const parsed = parseTeamNoteId(currentNoteId);
        const current = (parsed.filePath || currentNoteId.replace(/^__team__\//, '')).replace(/\\/g, '/');
        const pulled = pulledPath.replace(/^__team__\//, '').replace(/\\/g, '/');
        return current === pulled || current.endsWith(`/${pulled}`) || pulled.endsWith(`/${current}`);
    };

    const readCurrentNoteContent = async (currentNoteId: string) => {
        if (currentNoteId.startsWith('__team__/')) {
            const parsed = parseTeamNoteId(currentNoteId);
            const teamVaultId = parsed.teamVaultId || useSessionStore.getState().teamVaultId;
            if (!teamVaultId) return null;
            if (parsed.fileId) {
                return (await syncService.getVaultFileById(teamVaultId, parsed.fileId)).content;
            }
            if (!parsed.filePath) return null;
            return syncService.getVaultFile(teamVaultId, parsed.filePath);
        }
        return readTextFile(currentNoteId);
    };

    const readCurrentFileId = async (currentNoteId: string) => {
        try {
            const content = await readCurrentNoteContent(currentNoteId);
            if (!content) return null;
            const parsed = matter(content);
            return typeof parsed.data?.slash_id === 'string' ? parsed.data.slash_id : null;
        } catch {
            return null;
        }
    };

    const replaceEditorContent = (body: string, logPrefix: string) => {
        const editor = editorRef.current;
        if (!editor || editor.isDestroyed) return;

        // 🛡️ IME composition 期间坚决禁止任何反向 setContent，防止打字期间 DOM 遭到物理破坏
        if (editor.view.composing) {
            console.log(`[useEditorEvents] ${logPrefix} — editor is composing, abort setContent`);
            return;
        }

        const currentMarkdown = (editor.storage as any)?.markdown?.getMarkdown?.() || '';
        if (currentMarkdown.trim() === body.trim()) {
            console.log(`[useEditorEvents] ${logPrefix} — content unchanged, skip reload`);
            return;
        }

        const { from, to } = editor.state.selection;
        const scrollTop = editor.view.dom.closest('.ProseMirror')?.parentElement?.scrollTop ?? 0;

        isLoadingContentRef.current = true;
        try {
            editor.commands.setContent(body, false);
            hasUserEditedRef.current = false;
            (window as any).__slashEditorDirty = false;
        } catch (contentErr) {
            console.warn(`[useEditorEvents] ${logPrefix} setContent failed, hard reset:`, contentErr);
            try { editor.commands.clearContent(false); } catch {}
            return;
        } finally {
            setTimeout(() => {
                isLoadingContentRef.current = false;
            }, 10);
        }

        const maxPos = editor.state.doc.content.size;
        const safeFrom = Math.min(from, Math.max(maxPos - 1, 0));
        const safeTo = Math.min(to, Math.max(maxPos - 1, 0));
        try {
            if (safeFrom > 0) {
                editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
            }
        } catch {
            // 位置无效时静默回退
        }

        const scrollContainer = editor.view.dom.closest('.ProseMirror')?.parentElement;
        if (scrollContainer) {
            requestAnimationFrame(() => {
                scrollContainer.scrollTop = scrollTop;
            });
        }

        console.log(`[useEditorEvents] ${logPrefix} — content reloaded, cursor restored to`, safeFrom);
    };

    useEffect(() => {
        if (!noteId) return;
        let cancelled = false;

        const addUnlistener = (key: string, unlisten: UnlistenFn) => {
            if (cancelled) {
                try {
                    const p = unlisten() as any;
                    if (p && p.catch) p.catch(() => {});
                } catch { }
                return;
            }
            unlistenersRef.current.set(key, unlisten);
        };

        const setupListeners = async () => {
            // 1. AI Skill Completion Event
            const unlistenAI = await listen<AISkillCompleteEvent>('ai:skill-complete', (event) => {

                const eventPath = event.payload.path;

                // Use ref to always get current noteId, avoiding closure stale value
                const currentNoteId = noteIdRef.current;
                if (!currentNoteId) return;

                // Only process if this is for the current note
                if (currentNoteId.endsWith(eventPath) || currentNoteId === eventPath) {
                    onAIDataUpdate(event.payload.tags, event.payload.summary);
                }
            });
            addUnlistener('ai:skill-complete', unlistenAI);

            // 2. External File Update Event (from watcher)
            const unlistenUpdate = await listen<string>('note:updated', async (event) => {
                const changedPath = event.payload;

                // Use ref to always get current noteId, avoiding closure stale value
                const currentNoteId = noteIdRef.current;
                if (!currentNoteId) return;

                // Check if this update is for our note
                if (!currentNoteId.endsWith(changedPath) && !changedPath.endsWith(currentNoteId)) {
                    return;
                }

                // Skip if we're currently saving - this is our own save
                if (isSavingRef.current) {

                    return;
                }



                try {
                    // __team__/ 是虚拟路径（只读团队笔记），不是本地文件，跳过
                    if (currentNoteId.startsWith('__team__/')) return;
                    const content = await readTextFile(currentNoteId);

                    // Safely parse frontmatter - handle files without proper YAML structure
                    let parsedData: any = {};
                    try {
                        const parsed = matter(content);
                        // newBody is intentionally not used - we only update frontmatter
                        // Why?
                        // 1. This event is usually triggered by AI writing summary to YAML
                        // 2. The editor may have unsaved changes that would be lost
                        // 3. The user's edits in editor take priority over disk content
                        
                        // 🛡️ BUG-E02: Even though we only extract frontmatter, if the user has dirty changes
                        // we should NOT do anything that might trigger a save loop. 
                        // But updating frontmatterReact state is safe.
                        parsedData = parsed.data || {};
                    } catch (parseErr) {
                        // Not a markdown file or invalid YAML - ignore
                        return;
                    }

                    const normalizedFm = metadataService.cleanFrontmatter(parsedData);
                    onFrontmatterUpdate(normalizedFm);




                } catch (e) {
                    // 🛡️ BUG-E01: rename 进行中旧路径可能不存在，静默跳过
                    if (String(e).includes('No such file') || String(e).includes('not found')) {
                        return;
                    }
                    console.error('❌ [useEditorEvents] Failed to reload:', e);
                }
            });
            addUnlistener('note:updated', unlistenUpdate);
        };

        setupListeners();

        return () => {
            cancelled = true;
            unlistenersRef.current.forEach((unlisten) => {
                try {
                    const p = unlisten() as any;
                    if (p && p.catch) p.catch(() => {});
                } catch (e) {}
            });
            unlistenersRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]); // noteIdRef is stable, callbacks are also stable via refs

    // Window events (not Tauri events)
    useEffect(() => {
        // Expand properties panel event
        const handleExpandProperties = () => {

            onExpandProperties();
        };
        window.addEventListener('slash:expand-properties', handleExpandProperties);

        // Reload note event — full content reload (body + frontmatter)
        const handleReloadNote = async () => {
            const currentNoteId = noteIdRef.current;
            if (!currentNoteId) return;

            try {
                const content = await readCurrentNoteContent(currentNoteId);
                if (content == null) return;
                const parsed = matter(content);
                const normalizedFm = metadataService.cleanFrontmatter(parsed.data || {});
                onFrontmatterUpdate(normalizedFm);
                
                // 🛡️ BUG-E02: If the user has unsaved edits, do not reload the body, otherwise they'll be lost!
                if ((window as any).__slashEditorDirty) {
                    console.log('[useEditorEvents] reload-note/sync:pulled — editor is dirty, skip body reload to protect user edits');
                    return;
                }

                replaceEditorContent(parsed.content, 'reload-note');
            } catch (e) {
                console.error('Failed to reload note:', e);
            }
        };
        window.addEventListener('slash:reload-note', handleReloadNote);

        // Sync pull event — reload full content (body + frontmatter) after cloud pull
        const handleSyncPulled = async (e: Event) => {
            const currentNoteId = noteIdRef.current;
            if (!currentNoteId) return;
            if (isSavingRef.current) return; // 编辑器正在保存，跳过

            // 🛡️ 检查是否有实际 pull 的文件（双重保护，配合 AutoSyncManager 端的条件派发）
            const detail = (e as CustomEvent)?.detail;
            if (detail && detail.files_pulled === 0) {
                return; // 无文件被 pull，跳过 reload
            }

            const actualPulledPaths = Array.isArray(detail?.actually_pulled_paths)
                ? detail.actually_pulled_paths as string[]
                : [];
            const pulledPaths = Array.isArray(detail?.pulled_paths)
                ? detail.pulled_paths as string[]
                : [];
            const matchPaths = actualPulledPaths.length > 0 ? actualPulledPaths : pulledPaths;
            const isVirtualTeamNote = currentNoteId.startsWith('__team__/');
            const currentNoteWasPulled = isVirtualTeamNote
                ? true
                : matchPaths.length === 0 || matchPaths.some(path => matchesPulledPath(currentNoteId, path));

            if (!currentNoteWasPulled) return;

            // 🛡️ 检查当前编辑文件是否在 skipped_pulls 列表中（被 editing 保护跳过的文件）
            if (detail?.skipped_pulls && Array.isArray(detail.skipped_pulls)) {
                for (const skipped of detail.skipped_pulls) {
                    if (matchesPulledPath(currentNoteId, skipped)) {
                        console.log('[useEditorEvents] sync:pulled — current note was skipped (editing), skip reload');
                        return;
                    }
                }
            }

            try {
                const content = await readCurrentNoteContent(currentNoteId);
                if (content == null) return;
                const parsed = matter(content);
                const normalizedFm = metadataService.cleanFrontmatter(parsed.data || {});
                onFrontmatterUpdate(normalizedFm);
                
                // 🛡️ BUG-E02: If the user has unsaved edits, do not reload the body, otherwise they'll be lost!
                // This prevents Ghost Pushes where the user's un-flushed edits are overwritten by the cloud pull,
                // and then suddenly flush out later.
                const currentNoteActuallyPulled = isVirtualTeamNote
                    || actualPulledPaths.length === 0
                    || actualPulledPaths.some(path => matchesPulledPath(currentNoteId, path));
                if ((window as any).__slashEditorDirty && !currentNoteActuallyPulled) {
                    console.log('[useEditorEvents] reload-note/sync:pulled — editor is dirty, skip body reload to protect user edits');
                    return;
                }

                replaceEditorContent(parsed.content, 'sync:pulled');
            } catch (e) {
                console.error('❌ [useEditorEvents] Failed to reload after sync pull:', e);
            }
        };
        window.addEventListener('sync:pulled', handleSyncPulled);

        // Visual task toggle event (From Local task panel or Remote collab event)
        const handleVisualTaskToggle = async (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail) return;
            const { notePath, fileId, lineNumber, rawText, isCompleted } = detail;
            
            // Only apply if it's the current active note
            const currentNoteId = noteIdRef.current;
            if (!currentNoteId) return;
            if (currentNoteId !== notePath) {
                if (!fileId) return;
                const currentFileId = await readCurrentFileId(currentNoteId);
                if (currentFileId !== fileId) return;
            }

            const editor = editorRef.current;
            if (!editor || editor.isDestroyed) return;

            const targetText = rawText?.trim();
            if (!targetText) return;

            let foundPos: number | null = null;
            const candidates: Array<{ pos: number; lineNumber: number; text: string }> = [];
            const getLineForPos = (targetPos: number) => {
                let line = 1;
                editor.state.doc.descendants((node: any, pos: number) => {
                    if (pos >= targetPos) return false;
                    if (node.isTextblock) line++;
                    return true;
                });
                return line;
            };

            // Traverse the document to find the matching taskItem
            editor.state.doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'taskItem') {
                    const nodeText = node.textContent.trim();
                    if (nodeText && (nodeText.includes(targetText) || targetText.includes(nodeText))) {
                        candidates.push({
                            pos,
                            lineNumber: getLineForPos(pos),
                            text: nodeText,
                        });
                    }
                }
                return true; // Continue
            });

            const targetLineNumber = typeof lineNumber === 'number' ? lineNumber : null;
            const exactLineMatch = targetLineNumber === null
                ? null
                : candidates.find(candidate => candidate.lineNumber === targetLineNumber);
            foundPos = (exactLineMatch ?? candidates[0])?.pos ?? null;

            if (foundPos !== null) {
                // Update node's 'checked' attribute directly bypassing serialization pipeline
                editor.view.dispatch(
                    editor.state.tr.setNodeMarkup(foundPos, null, {
                        ...editor.state.doc.nodeAt(foundPos)?.attrs,
                        checked: isCompleted
                    })
                );
                console.debug(`⚡️ [useEditorEvents] Visually toggled task markup: "${targetText}" -> ${isCompleted}`);
            } else {
                console.warn(`⚠️ [useEditorEvents] Could not find task node matching: "${targetText}"`);
            }
        };

        window.addEventListener('slash:toggle-task', handleVisualTaskToggle);
        window.addEventListener('slash:remote-task-toggle', handleVisualTaskToggle);

        // Scroll to specific line event (for task panel navigation)
        const handleScrollToLine = (e: Event) => {
            const customEvent = e as CustomEvent<{ lineNumber: number, rawText?: string, noteId?: string }>;
            const { lineNumber, rawText, noteId } = customEvent.detail || {};
            const currentNoteId = noteIdRef.current;
            
            // 🛡️ Ensure only the intended active editor intercepts the event
            if (noteId && noteId !== currentNoteId) return;

            const editor = editorRef.current;
            let hasValidView = false;
            try {
                if (editor && editor.view && editor.view.dom) {
                    hasValidView = document.body.contains(editor.view.dom);
                }
            } catch (tiptapError) {
                console.warn(`[useEditorEvents] Caught tiptap view accessor error:`, tiptapError);
            }

            if (!hasValidView && (!editor || editor.isDestroyed)) {
                console.warn(`[useEditorEvents] Aborting scroll: Editor has no valid attached DOM view.`);
                return;
            }

            try {
                let targetPos: number | null = null;
                
                // Primary Strategy: High-fidelity DOM/Node mapping via rawText
                if (rawText) {
                    const targetText = rawText.trim();
                    editor.state.doc.descendants((node: any, pos: number) => {
                        if (targetPos !== null) return false; // Early exit if found

                        if (node.isTextblock || node.type.name === 'taskItem') {
                            const nodeText = node.textContent.trim();
                            if (nodeText && (nodeText.includes(targetText) || targetText.includes(nodeText))) {
                                // Add offset to position cursor inside the text node.
                                // taskItem -> paragraph -> text requires +2 offset to get past node boundaries
                                const offset = node.type.name === 'taskItem' ? 2 : 1;
                                targetPos = pos + offset;
                                return false; // Stop traversal
                            }
                        }
                        return true;
                    });
                }

                // Fallback Strategy: Best-effort line calculation (inaccurate for complex Markdown)
                if (targetPos === null) {
                    const content = editor.getText();
                    const lines = content.split('\n');

                    let charPos = 0;
                    for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
                        charPos += lines[i].length + 1;
                    }
                    targetPos = Math.min(charPos + 1, editor.state.doc.content.size);
                }

                if (targetPos !== null) {
                    if (editor.isEditable) {
                        // Set selection and scroll into view
                        editor.commands.setTextSelection(targetPos);
                        editor.commands.scrollIntoView();
                        editor.commands.focus();
                    } else {
                        // ReadOnly Team space fallback: 使用原生 scrollIntoView
                        let dom = editor.view.nodeDOM(targetPos);
                        if (dom) {
                            const targetNode = (dom.nodeType === Node.TEXT_NODE ? dom.parentElement : dom) as Element;
                            if (targetNode) {
                                targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to scroll to line/task:', err);
            }
        };
        window.addEventListener('slash:scroll-to-line', handleScrollToLine);

        // Scroll to specific pos event (for outline navigation)
        const handleScrollToPos = (e: Event) => {
            const customEvent = e as CustomEvent<{ pos: number, noteId?: string }>;
            const { pos, noteId } = customEvent.detail || {};
            const currentNoteId = noteIdRef.current;
            
            // 🛡️ Ensure only the intended active editor intercepts the event to prevent background leak
            if (noteId && noteId !== currentNoteId) return;
            
            if (typeof pos !== 'number') return;

            const editor = editorRef.current;
            
            // 🔥 RELIABILITY FIX: Do not rely solely on Tiptap's isDestroyed flag during rapid remounts.
            // If the editor has a view and a DOM node attached to the document, it is functionally alive for scrolling.
            let hasValidView = false;
            try {
                if (editor && editor.view && editor.view.dom) {
                    hasValidView = document.body.contains(editor.view.dom);
                }
            } catch (tiptapError) {
                // Tiptap explicitly throws "The editor view is not available" if this.view is technically null.
                console.warn(`[useEditorEvents] Caught tiptap view accessor error:`, tiptapError);
            }
            
            if (!hasValidView && (!editor || editor.isDestroyed)) {
                console.warn(`[useEditorEvents] Aborting scroll: Editor has no valid attached DOM view.`);
                return;
            }

            try {
                if (editor.isEditable) {
                    // 🛡️ 手动构造 transaction，不带 scrollIntoView
                    // Tiptap 的 setTextSelection 内部调用 tr.scrollIntoView()，
                    // 与我们的手动滚动冲突，导致标题在两个位置之间切换
                    const { state } = editor.view;
                    const clampedPos = Math.min(pos, state.doc.content.size);
                    const tr = state.tr.setSelection(
                        TextSelection.create(state.doc, clampedPos)
                    );
                    // 不调用 tr.scrollIntoView() — 交给下面的手动滚动
                    editor.view.dispatch(tr);

                    // 使用 coordsAtPos 获取目标位置的屏幕坐标，手动滚到顶部
                    try {
                        const coords = editor.view.coordsAtPos(clampedPos);
                        const editorDom = editor.view.dom;
                        const scrollContainer = getScrollContainer(editorDom);
                        if (scrollContainer) {
                            const containerRect = scrollContainer.getBoundingClientRect();
                            const targetScrollTop = scrollContainer.scrollTop + (coords.top - containerRect.top) - 20;
                            scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
                        } else {
                            editor.commands.scrollIntoView();
                        }
                    } catch(e) {
                        editor.commands.scrollIntoView();
                    }

                    // focus 不带 scrollIntoView
                    editor.view.focus();
                } else {
                    // 只读 fallback
                    let dom = editor.view.nodeDOM(pos);
                    if (dom) {
                        const targetNode = (dom.nodeType === Node.TEXT_NODE ? dom.parentElement : dom) as Element;
                        if (targetNode) {
                            targetNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    } else {
                        console.warn(`[useEditorEvents] Could not find nodeDOM for pos`, pos);
                    }
                }
            } catch (err) {
                console.error('Failed to scroll to outline pos:', err);
            }
        };
        window.addEventListener('slash:scroll-to-pos', handleScrollToPos);

        // Prevent browser default file drop
        const preventDefaultDrag = (e: DragEvent) => e.preventDefault();
        const preventDefaultDrop = (e: DragEvent) => e.preventDefault();
        window.addEventListener('dragover', preventDefaultDrag);
        window.addEventListener('drop', preventDefaultDrop);

        return () => {
            window.removeEventListener('slash:expand-properties', handleExpandProperties);
            window.removeEventListener('slash:reload-note', handleReloadNote);
            window.removeEventListener('sync:pulled', handleSyncPulled);
            window.removeEventListener('slash:scroll-to-line', handleScrollToLine);
            window.removeEventListener('slash:scroll-to-pos', handleScrollToPos);
            window.removeEventListener('dragover', preventDefaultDrag);
            window.removeEventListener('drop', preventDefaultDrop);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onExpandProperties, onFrontmatterUpdate]); // noteIdRef is stable
}
