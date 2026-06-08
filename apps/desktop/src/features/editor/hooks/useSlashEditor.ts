/**
 * useSlashEditor - Tiptap Editor Instance Factory
 *
 * Encapsulates all editor configuration:
 * - Extensions setup
 * - editorProps (handleDrop, handlePaste)
 * - Lifecycle callbacks (onUpdate, onTransaction, onCreate, onFocus, onBlur)
 *
 * Uses Ref Passthrough Pattern to decouple from business logic
 */

import { useEffect, useRef } from 'react';
import { useEditor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { createEditorExtensions } from '../config/extensions';
import { headingCompositionState } from '@slash/editor-core';
import { TextSelection } from '@tiptap/pm/state';
import { CodeBlockComponent } from '@/components/CodeBlockComponent';
import { createEditorDropHandler, createEditorPasteHandler } from '../utils/clipboardHandlers';
import { historyCache } from '../utils/historyCache';
import { executeTaskBypass } from '@/services/TaskBypassDetector';

export function getScrollContainer(viewDOM: HTMLElement | null): HTMLElement | null {
    if (!viewDOM) return null;
    let parent = viewDOM.parentElement;
    while (parent && parent !== document.body) {
        if (parent.classList.contains('slash-editor-zoom-area')) {
            return parent;
        }
        const style = window.getComputedStyle(parent);
        const overflowY = style.overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
            return parent;
        }
        parent = parent.parentElement;
    }
    return viewDOM.closest('.ProseMirror')?.parentElement || null;
}

interface UseSlashEditorOptions {
    noteId: string;
    initialContent: string; // raw file content for cache hash check
    // Ref passthrough - avoids circular dependencies
    isLoadingContentRef: React.MutableRefObject<boolean>;
    hasUserEditedRef: React.MutableRefObject<boolean>;
    editorRef: React.MutableRefObject<any>;
    // Callbacks
    onContentUpdate: (contentThunk: () => string) => void;
    onEmptyChange: (isEmpty: boolean) => void;
    onFocusChange: (focused: boolean) => void;
    // Injected Dependencies
    customSkillService?: any;
    SlashCommandList?: any;
    readOnly?: boolean;
}

interface EditorTaskSnapshot {
    id: number;
    note_path: string;
    line_number: number;
    raw_text: string;
    is_completed: boolean;
    due_date: string | null;
    assignee: string | null;
    priority: string | null;
    created_at: number;
    updated_at: number;
}

function getTextPositionLine(doc: any, pos: number): number {
    let line = 1;
    doc.descendants((_node: any, nodePos: number) => {
        if (nodePos >= pos) return false;
        if (_node.isTextblock) line++;
        return true;
    });
    return line;
}

function getTaskContentNode(taskItemNode: any) {
    let contentNode: any = null;

    taskItemNode.forEach((child: any) => {
        if (!contentNode && child.type.name === 'paragraph') {
            contentNode = child;
        }
    });

    return contentNode;
}

function extractTaskMetadata(node: any) {
    let dueDate: string | null = node.attrs?.dueDate ?? null;
    let assignee: string | null = node.attrs?.assignee ?? null;
    let priority: string | null = node.attrs?.priority ?? null;

    node.descendants((child: any) => {
        if (child.type.name === 'dateChip' && child.attrs?.date) {
            dueDate = child.attrs.date;
        }
        if (child.type.name === 'userChip' && child.attrs?.username) {
            assignee = child.attrs.username;
        }
        if (child.type.name === 'priorityChip' && child.attrs?.priority) {
            priority = child.attrs.priority;
        }
        return true;
    });

    return { dueDate, assignee, priority };
}

function extractTaskSnapshotFromDoc(doc: any, notePath: string): EditorTaskSnapshot[] {
    const now = Date.now();
    const tasks: EditorTaskSnapshot[] = [];

    doc.descendants((node: any, pos: number) => {
        if (node.type.name !== 'taskItem') return true;

        const contentNode = getTaskContentNode(node);
        const rawText = (contentNode?.textContent ?? '').trim();
        if (!rawText) return true;

        const { dueDate, assignee, priority } = extractTaskMetadata(contentNode ?? node);
        tasks.push({
            id: -((pos + 1) * 1000 + tasks.length),
            note_path: notePath,
            line_number: getTextPositionLine(doc, pos),
            raw_text: rawText,
            is_completed: node.attrs?.checked === true,
            due_date: dueDate,
            assignee,
            priority,
            created_at: now,
            updated_at: now,
        });

        return true;
    });

    return tasks;
}

function keepHeadingScrollLocked(scrollEl: HTMLElement | null, savedScroll: number, trailingMs = 0) {
    if (!scrollEl) return;
    headingCompositionState._scrollEl = scrollEl;
    headingCompositionState._savedScroll = savedScroll;
    headingCompositionState._scrollLockUntil = Math.max(
        headingCompositionState._scrollLockUntil,
        performance.now() + trailingMs,
    );

    if (headingCompositionState._scrollLockRaf) {
        scrollEl.scrollTop = savedScroll;
        return;
    }

    const tick = () => {
        const active = headingCompositionState._scrollLockActive
            || performance.now() < headingCompositionState._scrollLockUntil;
        const currentScrollEl = headingCompositionState._scrollEl;
        if (active && currentScrollEl) {
            currentScrollEl.scrollTop = headingCompositionState._savedScroll;
            headingCompositionState._scrollLockRaf = requestAnimationFrame(tick);
            return;
        }

        if (currentScrollEl) {
            currentScrollEl.scrollTop = headingCompositionState._savedScroll;
        }
        headingCompositionState._scrollLockRaf = 0;
    };

    scrollEl.scrollTop = savedScroll;
    headingCompositionState._scrollLockRaf = requestAnimationFrame(tick);
}

export function useSlashEditor({
    noteId,
    isLoadingContentRef,
    hasUserEditedRef,
    editorRef,
    onContentUpdate,
    onEmptyChange,
    onFocusChange,
    customSkillService,
    SlashCommandList,
    readOnly,
}: UseSlashEditorOptions) {
    const { t } = useTranslation();

    const noteIdRef = useRef(noteId);

    // Track last saved markdown snapshot to skip no-op saves
    const lastSavedSnapshotRef = useRef<string>('');

    // 🛡️ IME composition guard: 防止 IME 输入期间保存未确认的拼音
    const isComposingRef = useRef(false);

    // ⏱ 编辑器创建计时（只在 mount 时记录，不随 re-render 更新）

    useEffect(() => {
        noteIdRef.current = noteId;
    }, [noteId]);

    const emitTaskSnapshot = (sourceEditor: any) => {
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId || typeof window === 'undefined') return;
        if (!sourceEditor || sourceEditor.isDestroyed) return;

        const tasks = extractTaskSnapshotFromDoc(sourceEditor.state.doc, currentNoteId);
        window.dispatchEvent(new CustomEvent('slash:editor-tasks-updated', {
            detail: {
                notePath: currentNoteId,
                tasks,
            },
        }));
    };

    const editor = useEditor({
        extensions: createEditorExtensions({
            placeholder: t('editor.placeholder'),
            SlashCommandList,
            CodeBlockComponent,
            customSkillService,
        }),
        editable: !readOnly,
        content: '',
        immediatelyRender: false,

        editorProps: {
            attributes: {
                class: 'prose prose-lg max-w-none focus:outline-none min-h-[500px] pb-40 dark:prose-invert',
            },
            scrollMargin: { top: 80, bottom: 150, left: 0, right: 0 },
            scrollThreshold: { top: 80, bottom: 150, left: 0, right: 0 },
            handleDOMEvents: {
                compositionstart: (view) => {
                    isComposingRef.current = true;
                    const { $from } = view.state.selection;
                    const inHeading = $from.parent.type.name === 'heading';
                    headingCompositionState._inHeading = inHeading;
                    if (inHeading) {
                        // 保存 heading 快照：用于 compositionend(empty) 恢复
                        headingCompositionState._headingPos = $from.before();
                        headingCompositionState._headingContentSize = $from.parent.content.size;

                        let scrollEl: HTMLElement | null = view.dom.parentElement;
                        while (scrollEl) {
                            const ov = getComputedStyle(scrollEl).overflowY;
                            if (ov === 'auto' || ov === 'scroll') break;
                            scrollEl = scrollEl.parentElement;
                        }
                        headingCompositionState._scrollEl = scrollEl;
                        headingCompositionState._savedScroll = scrollEl?.scrollTop ?? 0;
                        headingCompositionState._scrollLockActive = true;
                        keepHeadingScrollLocked(scrollEl, headingCompositionState._savedScroll);
                    }
                    return false;
                },
                compositionend: (view, event) => {
                    // 🛡️ 延迟解锁到下一个 microtask：
                    // compositionend 触发后，ProseMirror 在同一 JS tick 内提交 IME 内容
                    // 并触发 onUpdate。若此处立即置 false，onUpdate 的 composing 检查失效。
                    // queueMicrotask 确保 onUpdate 先执行（并被跳过），再解锁。
                    queueMicrotask(() => {
                        isComposingRef.current = false;
                        // 🛡️ 补发 onContentUpdate：
                        if (!isLoadingContentRef.current && hasUserEditedRef.current) {
                            emitTaskSnapshot(editorRef.current);
                            // By deferring the getMarkdown to the Thunk, we ensure confirming IME words does NOT freeze the UI!
                            onContentUpdate(() => {
                                let snap = (editorRef.current?.storage as any)?.markdown?.getMarkdown() || '';
                                snap = snap.replace(/^- \[ \]\s*$/gm, '');
                                snap = snap.replace(/\\\n\s+\d+\.\s*$/gm, '');
                                snap = snap.replace(/^\s+\d+\.\s*$/gm, '');
                                snap = snap.replace(/\\\n\s+[-*+]\s*$/gm, '');
                                snap = snap.replace(/^\s+[-*+]\s*$/gm, '');
                                if (snap && snap !== lastSavedSnapshotRef.current) {
                                    lastSavedSnapshotRef.current = snap;
                                }
                                return snap;
                            });
                        }
                    });
                    if (!headingCompositionState._inHeading) return false;
                    headingCompositionState._inHeading = false;
                    headingCompositionState._scrollLockActive = false;
                    const composedText = (event as CompositionEvent).data;

                    // IME 被退格取消：compositionend data 为空
                    // ProseMirror reconciliation 可能将 IME 字符保留为真实内容
                    // 用 compositionstart 时的快照恢复 heading 状态
                    if (!composedText || composedText.length === 0) {
                        const savedPos = headingCompositionState._headingPos;
                        const savedContentSize = headingCompositionState._headingContentSize;
                        const scrollEl = headingCompositionState._scrollEl;
                        const savedScroll = headingCompositionState._savedScroll;

                        // 立即锁定滚动位置：防止 ProseMirror reconciliation 导致可见跳动
                        const scrollLock = () => { if (scrollEl) scrollEl.scrollTop = savedScroll; };
                        scrollEl?.addEventListener('scroll', scrollLock);
                        keepHeadingScrollLocked(scrollEl, savedScroll, 180);

                        setTimeout(() => {
                            try {
                                const state = view.state;
                                if (savedPos < 0 || savedPos >= state.doc.content.size) {
                                    scrollEl?.removeEventListener('scroll', scrollLock);
                                    return;
                                }
                                const headingNode = state.doc.nodeAt(savedPos);
                                if (!headingNode || headingNode.type.name !== 'heading') {
                                    scrollEl?.removeEventListener('scroll', scrollLock);
                                    return;
                                }

                                const currentContentSize = headingNode.content.size;
                                if (currentContentSize > savedContentSize) {
                                    const deleteFrom = savedPos + 1 + savedContentSize;
                                    const deleteTo = savedPos + 1 + currentContentSize;
                                    // 🛡️ 每次 dispatch 前重新读取 view.state，防止 stale transaction
                                    const freshState = view.state;
                                    const tr = freshState.tr.delete(deleteFrom, deleteTo);
                                    const cursorPos = savedPos + 1 + savedContentSize;
                                    tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                                    view.dispatch(tr);
                                }

                                // 检查 heading 后面泄漏的段落
                                {
                                    const freshState2 = view.state;
                                    if (savedPos >= freshState2.doc.content.size) {
                                        scrollEl?.removeEventListener('scroll', scrollLock);
                                        scrollLock();
                                        return;
                                    }
                                    const $pos = freshState2.doc.resolve(savedPos);
                                    const headingIndex = $pos.index($pos.depth);
                                    const parent = $pos.parent;
                                    if (headingIndex + 1 < parent.childCount) {
                                        const newHeading = freshState2.doc.nodeAt(savedPos);
                                        if (newHeading) {
                                            const nextOffset = savedPos + newHeading.nodeSize;
                                            const nextNode = freshState2.doc.nodeAt(nextOffset);
                                            if (nextNode && nextNode.type.name === 'paragraph' && nextNode.textContent.length <= 1) {
                                                view.dispatch(freshState2.tr.delete(nextOffset, nextOffset + nextNode.nodeSize));
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                // 🛡️ 防御：compositionend 延时回调中 state 可能因 blur/focus 等事件变化
                                console.warn('[Heading composition fix] Skipped stale transaction:', e);
                            }

                            // 解除滚动锁定
                            scrollEl?.removeEventListener('scroll', scrollLock);
                            scrollLock();
                        }, 20);
                        return false;
                    }

                    // 延迟执行：给浏览器时间完成操作
                    const scrollEl = headingCompositionState._scrollEl;
                    const savedScroll = headingCompositionState._savedScroll;

                    // 立即锁定滚动位置：防止 ProseMirror reconciliation 导致可见跳动
                    const scrollLock = () => { if (scrollEl) scrollEl.scrollTop = savedScroll; };
                    scrollEl?.addEventListener('scroll', scrollLock);
                    keepHeadingScrollLocked(scrollEl, savedScroll, 220);

                    setTimeout(() => {
                        try {
                            // 检查当前文档状态：heading 后面是否有包含 composedText 的段落
                            const currentState = view.state;
                            let needsFix = false;
                            currentState.doc.forEach((node: any, _offset: number, index: number) => {
                                if (needsFix) return;
                                if (node.type.name !== 'heading') return;
                                if (index + 1 >= currentState.doc.childCount) return;
                                const nextNode = currentState.doc.child(index + 1);
                                if (nextNode.type.name === 'paragraph' && nextNode.textContent === composedText) {
                                    needsFix = true;
                                }
                            });

                            if (needsFix) {
                                headingCompositionState.fixData = composedText;
                                view.dispatch(view.state.tr);
                            }
                        } catch (e) {
                            console.warn('[Heading composition fix] Skipped stale transaction:', e);
                        }

                        // 解除滚动锁定
                        scrollEl?.removeEventListener('scroll', scrollLock);
                        scrollLock();
                    }, 50);
                    return false;
                },
                // 🛡️ WebKit caret repaint fix: 强制 WebKit 在代码块 Enter 后同步重绘光标。
                // 使用 queueMicrotask 确保在当前帧渲染前（而非下一帧）执行修复。
                keydown: (view, event) => {
                    if (event.key !== 'Enter') return false;
                    const { $from } = view.state.selection;
                    if ($from.parent.type.name !== 'codeBlock') return false;

                    // queueMicrotask 在 ProseMirror 处理完 Enter 后、浏览器渲染前执行
                    queueMicrotask(() => {
                        // Step 1: 强制同步布局，刷新 <pre> 的几何尺寸
                        const preEl = view.dom.querySelector('pre');
                        if (preEl) void preEl.offsetHeight;

                        // Step 2: 重置浏览器原生 Selection，强制 WebKit 重新计算光标位置
                        const sel = window.getSelection();
                        if (sel && sel.rangeCount) {
                            const range = sel.getRangeAt(0).cloneRange();
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    });

                    return false;
                },
            },
            handleDrop: createEditorDropHandler(),
            handlePaste: createEditorPasteHandler(editorRef),
            // 🛡️ Code copy fix: when selection is inside a codeBlock or inline code,
            // return raw text to prevent tiptap-markdown from wrapping in ```/` markers.
            // editorProps have higher priority than plugin props in ProseMirror.
            clipboardTextSerializer: (slice, view) => {
                const { state } = view;
                const { $from, $to } = state.selection;
                // Case 1: Both ends inside a codeBlock → raw text (no ``` fences)
                if ($from.parent.type.name === 'codeBlock' && $to.parent.type.name === 'codeBlock') {
                    return slice.content.textBetween(0, slice.content.size, '\n');
                }
                // Case 2: Entire selection has inline `code` mark → raw text (no backticks)
                const codeMark = state.schema.marks.code;
                if (codeMark) {
                    let allCode = true;
                    let hasText = false;
                    slice.content.descendants((node) => {
                        if (!allCode) return false; // stop traversal early
                        if (node.isText) {
                            hasText = true;
                            if (!codeMark.isInSet(node.marks)) {
                                allCode = false;
                            }
                        }
                    });
                    if (allCode && hasText) {
                        return slice.content.textBetween(0, slice.content.size, '\n');
                    }
                }

                // Case 3: If copying a table (or selection contains table/row/cell), customize the text representation.
                // We serialize table cell by cell, columns separated by '\t', rows by '\n', without markdown markers.
                let hasTableNode = false;
                slice.content.descendants((node) => {
                    if (node.type.name === 'table' || node.type.name === 'tableRow' || node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                        hasTableNode = true;
                    }
                });
                if (hasTableNode) {
                    const lines: string[] = [];
                    const serializeNode = (node: any) => {
                        if (node.type.name === 'table') {
                            node.content.forEach((row: any) => {
                                const rowCells: string[] = [];
                                row.content.forEach((cell: any) => {
                                    let cellText = '';
                                    cell.content.descendants((textNode: any) => {
                                        if (textNode.isText) {
                                            cellText += textNode.text;
                                        } else if (textNode.type.name === 'hardBreak') {
                                            cellText += '\n';
                                        }
                                    });
                                    rowCells.push(cellText);
                                });
                                lines.push(rowCells.join('\t'));
                            });
                        } else if (node.type.name === 'tableRow') {
                            const rowCells: string[] = [];
                            node.content.forEach((cell: any) => {
                                let cellText = '';
                                cell.content.descendants((textNode: any) => {
                                    if (textNode.isText) cellText += textNode.text;
                                    else if (textNode.type.name === 'hardBreak') cellText += '\n';
                                });
                                rowCells.push(cellText);
                            });
                            lines.push(rowCells.join('\t'));
                        } else if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                            let cellText = '';
                            node.content.descendants((textNode: any) => {
                                if (textNode.isText) cellText += textNode.text;
                                else if (textNode.type.name === 'hardBreak') cellText += '\n';
                            });
                            lines.push(cellText);
                        } else if (node.type.name === 'paragraph') {
                            lines.push(node.textContent);
                        } else if (node.isText) {
                            lines.push(node.text);
                        } else {
                            node.content.forEach((child: any) => serializeNode(child));
                        }
                    };

                    slice.content.forEach((node) => serializeNode(node));
                    return lines.join('\n');
                }

                // Fall through to tiptap-markdown's serializer
                return null as any;
            },
        },

        onUpdate: ({ editor }) => {
            // Block saves during content loading;
            if (isLoadingContentRef.current) {

                return;
            }

            // 🛡️ IME composition 期间跳过保存，并且绝对不要在 IME 时跑极耗性能的 getMarkdown！
            if (isComposingRef.current) {
                return;
            }

            // 用户未编辑过则不触发 save（阻止 TipTap 内部 normalize 触发写盘）
            if (!hasUserEditedRef.current) {
                console.log('⏭️ [onUpdate] No user edits yet, capturing snapshot only');
                return;
            }

            // /////// THUNK DEFERRAL ////////// //
            // We NO LONGER compute `getMarkdown()` here synchronously!
            // This prevents freezing the main thread while typing English or Backspacing.
            // We pass a Thunk (() => string) to let `useContentPersistence` run it 500ms LATER on the debounce timer.

            onEmptyChange(editor.isEmpty);
            emitTaskSnapshot(editor);

            onContentUpdate(() => {
                let contentSnapshot = (editor.storage as any)?.markdown?.getMarkdown() || '';

                // Clean up empty list items that can't reliably round-trip through Markdown
                contentSnapshot = contentSnapshot.replace(/^- \[ \]\s*$/gm, '');
                contentSnapshot = contentSnapshot.replace(/\\\n\s+\d+\.\s*$/gm, '');
                contentSnapshot = contentSnapshot.replace(/^\s+\d+\.\s*$/gm, '');
                contentSnapshot = contentSnapshot.replace(/\\\n\s+[-*+]\s*$/gm, '');
                contentSnapshot = contentSnapshot.replace(/^\s+[-*+]\s*$/gm, '');

                // Skip save if content hasn't changed since last save (avoids I/O on redundant updates)
                if (contentSnapshot === lastSavedSnapshotRef.current) {
                    return ''; // Use empty string to signal no update to downstream
                }

                // Detect real content state
                const isContentEmpty = contentSnapshot.trim() === '' || contentSnapshot.trim() === '\n';

                let actualNodeCount = 0;
                editor.state.doc.descendants((node: any) => {
                    if (node.type.name !== 'paragraph' && node.type.name !== 'text') {
                        actualNodeCount++;
                    } else if (node.type.name === 'text' && node.text?.trim()) {
                        actualNodeCount++;
                    }
                });
                const hasActualNodes = actualNodeCount > 0;

                // Defensive check: serialization mismatch
                if (isContentEmpty && hasActualNodes) {
                    console.log(`⚠️ [onUpdate] Serialization mismatch - ${actualNodeCount} nodes but empty markdown, skipping save`);
                    return ''; // Skip
                }

                lastSavedSnapshotRef.current = contentSnapshot;
                return contentSnapshot;
            });
        },

        onTransaction: ({ transaction }) => {
            if (isLoadingContentRef.current) return;
            // 排除 addToHistory=false 的内部 cleanup transaction（如 \u200B 清除）
            if (transaction.getMeta('addToHistory') === false) return;
            if (transaction.docChanged && transaction.steps.length > 0) {
                hasUserEditedRef.current = true;
                (window as any).__slashEditorDirty = true;
            }
        },

        onCreate: ({ editor }) => {
            onEmptyChange(editor.isEmpty);
            editorRef.current = editor;
            // Expose editor to window for debugging
            (window as any).editor = editor;
        },

        onFocus: () => onFocusChange(true),

        onBlur: () => {
            onFocusChange(false);
        },
    }, []);

    useEffect(() => {
        if (!editor) return;

        const handleTaskSnapshotRequest = () => {
            emitTaskSnapshot(editor);
        };

        const handleTaskCheckboxIntent = (event: Event) => {
            const detail = (event as CustomEvent<{
                lineNumber?: number;
                originalLine?: string;
                checked?: boolean;
            }>).detail;
            if (!noteIdRef.current || !detail) {
                return;
            }
            if (typeof detail.lineNumber !== 'number') {
                return;
            }
            if (typeof detail.originalLine !== 'string') {
                return;
            }
            if (typeof detail.checked !== 'boolean') {
                return;
            }

            executeTaskBypass(noteIdRef.current, [{
                lineNumber: detail.lineNumber,
                originalLine: detail.originalLine,
                checked: detail.checked,
            }]).catch(err => {
                console.warn('[useSlashEditor] Task checkbox bypass failed:', err);
            });
        };

        window.addEventListener('slash:request-editor-tasks', handleTaskSnapshotRequest);
        window.addEventListener('slash:task-checkbox-intent', handleTaskCheckboxIntent);
        return () => {
            window.removeEventListener('slash:request-editor-tasks', handleTaskSnapshotRequest);
            window.removeEventListener('slash:task-checkbox-intent', handleTaskCheckboxIntent);
        };
    }, [editor]);

    // Live snapshot: 每次文档变化、选区变化及视口滚动时实时更新缓存并持久化状态（撤销栈、选区、滚动高度）
    useEffect(() => {
        if (!editor || !noteId) return;

        const handler = () => {
            if (isLoadingContentRef.current) return;
            try {
                const doc = editor.state.doc;
                if (doc.content.childCount > 0) {
                    // 1. 读取当前选区 (Selection)
                    const { anchor, head } = editor.state.selection;

                    // 2. 读取编辑区域滚动高度 (ScrollTop)
                    const scrollContainer = getScrollContainer(editor.view.dom);
                    const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

                    historyCache.saveDoc(
                        noteId,
                        doc.toJSON(),
                        { anchor, head },
                        scrollTop
                    );
                }
            } catch(e) { /* ignore */ }
        };

        editor.on('update', handler);
        editor.on('selectionUpdate', handler); // 💡 联合监听选区变化，光标一动即刻捕获

        // 💡 联动监听真正的视口滚动事件 (Scroll Event Listener)
        let scrollContainer: HTMLElement | null = null;
        const handleScroll = () => {
            if (editor.isDestroyed || isLoadingContentRef.current) return;
            try {
                const doc = editor.state.doc;
                if (doc.content.childCount > 0) {
                    const st = scrollContainer ? scrollContainer.scrollTop : 0;
                    const { anchor, head } = editor.state.selection;
                    const cached = historyCache.getCached(noteId);

                    // 用当前光标选区和最实时的滚动高度更新缓存，docJSON 优先继承已缓存结构
                    historyCache.saveDoc(
                        noteId,
                        cached?.docJSON || doc.toJSON(),
                        { anchor, head },
                        st
                    );
                }
            } catch (e) { /* ignore */ }
        };

        // 延迟 100ms 等待 Tiptap DOM 正式渲染挂载后提取父容器绑定事件
        const scrollTimer = setTimeout(() => {
            if (!editor.isDestroyed) {
                scrollContainer = getScrollContainer(editor.view.dom);
                if (scrollContainer) {
                    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
                }
            }
        }, 100);

        return () => {
            clearTimeout(scrollTimer);
            editor.off('update', handler);
            editor.off('selectionUpdate', handler);
            if (scrollContainer) {
                scrollContainer.removeEventListener('scroll', handleScroll);
            }
        };
    }, [noteId, editor]);

    // 🛡️ CRITICAL FIX: Sync readOnly dynamically! Tiptap useEditor ignores subsequent prop changes for `editable`.
    // We defer setEditable using setTimeout to avoid "flushSync was called from inside a lifecycle method" error
    // when ReactRenderer mounts NodeViews synchronously during the commit phase.
    useEffect(() => {
        if (editor && typeof readOnly !== 'undefined') {
            setTimeout(() => {
                if (!editor.isDestroyed) {
                    editor.setEditable(!readOnly, false); // false avoids focus stealing
                }
            }, 0);
        }
    }, [editor, readOnly]);

    return { editor };
}
