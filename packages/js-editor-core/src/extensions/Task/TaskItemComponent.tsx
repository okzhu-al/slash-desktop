/**
 * TaskItemComponent - React NodeView for task checkbox
 * 
 * Features:
 * - Interactive checkbox (vertically centered)
 * - Space key triggers metadata type selector (IME-aware)
 * - Keyboard shortcuts: ~=date, @=user, !=priority
 * - Inserts DateChip/UserChip/PriorityChip nodes after user input
 * - Team member selector for @ mentions (when teamMembers provided via window.__slashTeamMembers)
 * 
 * Solution for shortcut key preservation:
 * - When inserting chip after shortcut, delete the trigger character first
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DatePickerPopup } from './ui/DatePickerPopup';
import { UserPopup } from './ui/UserPopup';
import { PriorityPopup } from './ui/PriorityPopup';
import './TaskItemStyles.css';

type MenuMode = 'none' | 'main' | 'date' | 'user' | 'priority';

/**
 * 💡 WebKit 物理 DOM 选区 (Selection) 强制锚定修复
 * 使用 TreeWalker 深度优先查找最底层的物理文本节点进行锚定，
 * 如果是刚创建的空段落，则锚定在第一个子占位符的前面，这能 100% 迫使 WebKit 渲染引擎绘制光标 Caret。
 */
const safelyAnchorSelectionToDOM = (container: HTMLElement) => {
    try {
        const pEl = container.querySelector('.task-content p') || container.querySelector('.task-content') || container;
        if (!pEl) return;

        const sel = window.getSelection();
        if (!sel) return;

        const isAlreadyInside = sel.anchorNode && pEl.contains(sel.anchorNode);
        if (isAlreadyInside) return;

        const range = document.createRange();
        let textNode: Node | null = null;
        
        // 寻找段落内的第一个文本节点
        const walk = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT);
        if (walk.nextNode()) {
            textNode = walk.currentNode;
        }

        if (textNode) {
            range.setStart(textNode, 0);
            range.setEnd(textNode, 0);
        } else {
            // 如果段落中暂时没有物理文本（即刚刚回车，是空任务列表，此时可能只有一个 <br class="ProseMirror-trailingBreak">）
            if (pEl.firstChild) {
                range.setStartBefore(pEl.firstChild);
                range.setEndBefore(pEl.firstChild);
            } else {
                range.setStart(pEl, 0);
                range.setEnd(pEl, 0);
            }
        }

        sel.removeAllRanges();
        sel.addRange(range);
        console.info(`⚡ [Bug 2 Caret Telemetry] Physical DOM Selection anchored successfully.`);
    } catch (err) {
        console.warn(`[Bug 2] Failed to safely anchor Selection:`, err);
    }
};

/**
 * 💡 WebKit 强力布局 Reflow 与物理 Caret 重绘唤醒
 * 改变编辑器 DOM 的 padding-bottom，通过 Forced Synchronous Layout 读取 offsetHeight 阻断样式合并，
 * 并在 50ms 延时后静默还原，100% 强制 WebKit 在第一屏（scrollTop === 0）进行重绘，完美唤醒不可见光标。
 */
const triggerWebKitReflow = (editorDom: HTMLElement) => {
    try {
        const origPadding = editorDom.style.paddingBottom;
        const computedPadding = window.getComputedStyle(editorDom).paddingBottom;
        const parsedPadding = parseFloat(computedPadding) || 0;
        
        // 微调 0.1px 并强制重排
        editorDom.style.paddingBottom = `${parsedPadding + 0.1}px`;
        
        // 💡 物理重绘核心：直接读取 offsetHeight 强行触发同步 Layout，阻断合并优化
        editorDom.offsetHeight; 
        
        // 延时 50ms 后还原，避开浏览器的优化合并机制，确保渲染管道发生真实的重绘
        setTimeout(() => {
            if (editorDom) {
                editorDom.style.paddingBottom = origPadding;
                editorDom.offsetHeight;
            }
        }, 50);
    } catch (layoutErr) {
        console.warn(`[Bug 2] Failed to trigger WebKit Reflow:`, layoutErr);
    }
};

export const TaskItemComponent: React.FC<NodeViewProps> = ({
    node,
    updateAttributes,
    editor,
    getPos,
}) => {
    const [menuMode, setMenuMode] = useState<MenuMode>('none');
    const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
    const { checked } = node.attrs;
    const { t } = useTranslation();
    const domRef = useRef<HTMLLIElement>(null);

    const teamMembers = useMemo(() => {
        return (window as any).__slashTeamMembers || [];
    }, []);

    // Track IME composition state with cooldown
    const isComposingRef = useRef(false);
    const compositionCooldownRef = useRef(false);
    const savedPosRef = useRef<number | null>(null);
    // Track which trigger character was used (to delete it later)
    const triggerCharRef = useRef<string | null>(null);

    // Track last space key press for double-space detection
    const lastSpaceTimeRef = useRef<number>(0);

    const PseudoAnchorRect = useMemo(() => {
        if (!menuPosition.x && !menuPosition.y) return null;
        return {
            left: menuPosition.x,
            top: menuPosition.y,
            bottom: menuPosition.y,
            right: menuPosition.x,
            width: 0,
            height: 0,
            x: menuPosition.x,
            y: menuPosition.y,
            toJSON: () => {}
        } as DOMRect;
    }, [menuPosition.x, menuPosition.y]);

    // IME composition event handlers with cooldown
    useEffect(() => {
        const handleCompositionStart = () => {
            isComposingRef.current = true;
            compositionCooldownRef.current = true;
        };
        const handleCompositionEnd = () => {
            isComposingRef.current = false;
            // Keep cooldown active for 150ms after composition ends
            setTimeout(() => {
                compositionCooldownRef.current = false;
            }, 150);
        };

        document.addEventListener('compositionstart', handleCompositionStart);
        document.addEventListener('compositionend', handleCompositionEnd);
        return () => {
            document.removeEventListener('compositionstart', handleCompositionStart);
            document.removeEventListener('compositionend', handleCompositionEnd);
        };
    }, []);

    // DOM & Caret Telemetry for Bug 2 diagnosis
    useEffect(() => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        console.group(`🔍 [Bug 2 Caret Telemetry] TaskItem Component Mounted`);
        console.info(`- Node Size: ${node.nodeSize}`);
        console.info(`- Position: ${pos}`);
        console.info(`- Editor Editable: ${editor.isEditable}`);
        console.info(`- Document activeElement:`, document.activeElement);
        
        if (pos !== null && pos !== undefined) {
            const { selection } = editor.state;
            const nodeEnd = pos + node.nodeSize;
            const isCursorInside = selection.from >= pos && selection.from <= nodeEnd;
            console.info(`- Selection State: from=${selection.from}, to=${selection.to}, empty=${selection.empty}`);
            console.info(`- Is Selection Inside Current TaskItem: ${isCursorInside}`);
                      try {
                const domNode = editor.view.nodeDOM(pos);
                console.info(`- Rendered Node DOM Element:`, domNode);
                if (domNode && typeof (domNode as any).getAttribute === 'function') {
                    console.info(`- Node HTML Structure:`, (domNode as HTMLElement).outerHTML);
                    console.info(`- Content Editable status:`, (domNode as HTMLElement).getAttribute('contenteditable'));
                    const contentDOM = (domNode as HTMLElement).querySelector('.task-content');
                    console.info(`- .task-content Element:`, contentDOM);
                }
            } catch (err) {
                console.warn(`- Failed to retrieve Node DOM:`, err);
            }
        }
        console.groupEnd();
    }, [editor, getPos, node, node.nodeSize]);

    // WebKit Caret Repaint Fix: When the React NodeView mounts, if the cursor is inside it,
    // force a repaint by refocusing after the DOM is fully stable.
    // 🚀 三重焦点保活防线 (20ms, 100ms, 250ms)
    // 结合物理 DOM 选区 Range 修复与 WebKit 0.1px 布局 Reflow 唤醒，完美抵抗 React 异步协调与 WebKit 选区丢弃导致物理 Selection 悬空或自动丢焦的问题！
    useEffect(() => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos !== null && pos !== undefined) {
            const { selection } = editor.state;
            const nodeEnd = pos + node.nodeSize;
            if (selection.from >= pos && selection.from <= nodeEnd) {
                const focusTimes = [20, 100, 250];
                focusTimes.forEach(delay => {
                    setTimeout(() => {
                        if (editor && !editor.isDestroyed) {
                            const { selection: currentSel } = editor.state;
                            // 只有当光标确实依然在当前 taskItem 内部时才保活 focus，避免抢夺其它位置的焦点
                            if (currentSel.from >= pos && currentSel.from <= pos + node.nodeSize) {
                                // 🌟 强力重排唤醒
                                if (editor.view.dom) {
                                    triggerWebKitReflow(editor.view.dom);
                                }

                                // 🌟 物理 DOM 选区强力锚定
                                if (domRef.current) {
                                    safelyAnchorSelectionToDOM(domRef.current);
                                }

                                // 调度 ProseMirror 级别的 focus 并保持选区
                                const beforeFocusElement = document.activeElement;
                                editor.commands.focus(currentSel.from, { scrollIntoView: false });
                                console.info(`⚡ [Bug 2 Caret Telemetry] [Delay ${delay}ms] Refocus complete. activeElement before:`, beforeFocusElement, ` -> after:`, document.activeElement);
                            }
                        }
                    }, delay);
                });
            }
        }
    }, [editor, getPos, node.nodeSize]);

    // 🛡️ WebKit 假丢焦原生拦截卫兵 (500ms 黄金保活拦截门)
    // 专门捕获并高优先级拦截 WebKit 在 DOM 重组后抛出的假 blur，彻底消灭 Selection 悬空触发的原生丢焦
    useEffect(() => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return;

        const { selection } = editor.state;
        const nodeEnd = pos + node.nodeSize;
        if (selection.from >= pos && selection.from <= nodeEnd) {
            let isGuardActive = true;
            const guardTimer = setTimeout(() => {
                isGuardActive = false;
            }, 500);

            const handleBlurIntercept = (e: FocusEvent) => {
                if (!isGuardActive) return;

                // 校验：如果 relatedTarget 是一个外部的可聚焦元素（说明用户在切焦），我们安全放行
                if (e.relatedTarget instanceof HTMLElement) {
                    return;
                }

                // 校验：确保最新选区依然在当前 taskItem 内部
                const { selection: currentSel } = editor.state;
                if (currentSel.from >= pos && currentSel.from <= pos + node.nodeSize) {
                    e.preventDefault();
                    e.stopImmediatePropagation();

                    setTimeout(() => {
                        if (editor && !editor.isDestroyed) {
                            // 🌟 假 blur 拦截恢复时的强力重绘唤醒
                            if (editor.view.dom) {
                                triggerWebKitReflow(editor.view.dom);
                            }

                            // 🌟 物理 DOM 选区强力锚定
                            if (domRef.current) {
                                safelyAnchorSelectionToDOM(domRef.current);
                            }
                            
                            editor.commands.focus(currentSel.from, { scrollIntoView: false });
                            console.info(`🛡️ [Bug 2 Blur Guard] Successfully intercepted WebKit fake blur event and restored caret selection!`);
                        }
                    }, 0);
                }
            };

            const editorDom = editor.view.dom;
            editorDom.addEventListener('blur', handleBlurIntercept, true);

            return () => {
                clearTimeout(guardTimer);
                editorDom.removeEventListener('blur', handleBlurIntercept, true);
            };
        }
    }, [editor, getPos, node.nodeSize]);

    // Get insert position (end of paragraph inside taskItem)
    const getInsertPosition = useCallback(() => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return null;

        const resolvedPos = editor.state.doc.resolve(pos);
        const taskItemNode = resolvedPos.nodeAfter;
        if (!taskItemNode) return null;

        let insertPos = pos + 1;
        taskItemNode.forEach((child, offset) => {
            if (child.type.name === 'paragraph') {
                insertPos = pos + 1 + offset + child.nodeSize - 1;
            }
        });
        return insertPos;
    }, [editor, getPos]);

    // Handle keyboard - use input event for better detection
    useEffect(() => {
        if (menuMode !== 'main') return;

        // Use beforeinput to catch characters BEFORE they are inserted
        const handleBeforeInput = (e: InputEvent) => {
            const data = e.data;
            if (!data) return;

            // Check for trigger characters
            // Use '！' (Chinese exclamation) for date to avoid IME conflict
            if (data === '＆' || data === '&') {
                e.preventDefault();
                console.info(`[TaskItem Telemetry] Shortcut: Date '&' triggered.`);
                triggerCharRef.current = null; // No char to delete since we prevented
                setMenuMode('date');
            } else if (data === '@') {
                if (teamMembers.length > 0) {
                    e.preventDefault();
                    console.info(`[TaskItem Telemetry] Shortcut: User '@' triggered.`);
                    triggerCharRef.current = null;
                    setMenuMode('user');
                }
            } else if (data === '！' || data === '!') {
                e.preventDefault();
                console.info(`[TaskItem Telemetry] Shortcut: Priority '!' triggered.`);
                triggerCharRef.current = null;
                setMenuMode('priority');
            }
        };

        document.addEventListener('beforeinput', handleBeforeInput);
        return () => document.removeEventListener('beforeinput', handleBeforeInput);
    }, [menuMode]);

    // BUG FIX: Block ALL keyboard events from reaching the editor when a menu/popup is open.
    useEffect(() => {
        if (menuMode === 'none') return;

        // Intercept global keyboard events during menu modes
        const blockEditorKeys = (e: KeyboardEvent) => {
            // Always allow Escape to close the menu
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                setMenuMode('none');
                savedPosRef.current = null;
                triggerCharRef.current = null;
                // Restore editor focus
                editor.commands.focus();
                return;
            }

            // Outside the input field, Backspace closes the menu
            if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopImmediatePropagation();
                setMenuMode('none');
                savedPosRef.current = null;
                triggerCharRef.current = null;
                editor.commands.focus();
                return;
            }

            // For all other menus (main, date, priority), block everything
            e.preventDefault();
            e.stopImmediatePropagation();
        };

        // Use capture phase to intercept before ProseMirror's handlers
        document.addEventListener('keydown', blockEditorKeys, true);
        return () => document.removeEventListener('keydown', blockEditorKeys, true);
    }, [menuMode, editor]);

    // Handle space key to show main menu
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== ' ') return;

            if (!editor.isEditable) return;
            if (menuMode !== 'none') return;

            const pos = typeof getPos === 'function' ? getPos() : null;
            if (pos === null || pos === undefined) return;

            const { from } = editor.state.selection;
            const nodeEnd = pos + node.nodeSize;

            if (from < pos || from > nodeEnd) return;

            if (isComposingRef.current || compositionCooldownRef.current) {
                return;
            }

            const textContent = node.textContent || '';
            const cursorInNode = from - pos - 1;

            if (cursorInNode >= textContent.length - 1) {
                const now = Date.now();
                const timeSinceLastSpace = now - lastSpaceTimeRef.current;

                if (timeSinceLastSpace < 500) {
                    e.preventDefault();
                    savedPosRef.current = from;

                    editor.chain()
                        .deleteRange({ from: from - 1, to: from })
                        .run();

                    try {
                        const coords = editor.view.coordsAtPos(from - 1);
                        setMenuPosition({ x: coords.left + 5, y: coords.bottom + 5 });
                    } catch {
                        setMenuPosition({ x: 0, y: 0 });
                    }

                    setMenuMode('main');
                    lastSpaceTimeRef.current = 0;
                } else {
                    lastSpaceTimeRef.current = now;
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [editor, getPos, node, menuMode]);

    const handleCheckboxChange = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        if (!editor.isEditable) {
            const isTeamLibrary = editor.view.dom.closest('.team-readonly-guard');
            if (isTeamLibrary) {
                (window as any).__slashToast?.('error', 'sidebar.team_readonly');
            } else {
                (window as any).__slashToast?.('error', 'kanban.solo_lock', 'kanban.solo_lock_desc');
            }
            return;
        }
        updateAttributes({ checked: !checked });
    }, [checked, updateAttributes, editor.isEditable]);

    // Insert a chip at the end position
    const insertChip = useCallback((type: 'date' | 'user' | 'priority', attrs: any) => {
        const insertPos = getInsertPosition();
        if (!insertPos) return;

        const nextPos = insertPos + 2;

        editor.chain()
            .insertContentAt(insertPos, [
                { type: `${type}Chip`, attrs },
                { type: 'text', text: ' ' },
            ])
            .setTextSelection(nextPos)
            .focus()
            .run();
    }, [editor, getInsertPosition]);

    const closeMenu = useCallback(() => {
        setMenuMode('none');
        savedPosRef.current = null;
        triggerCharRef.current = null;
    }, []);

    const mainMenuPositionRef = useCallback((node: HTMLDivElement | null) => {
        if (!node || menuPosition.x === 0) return;
        const rect = node.getBoundingClientRect();
        
        let newX = menuPosition.x;
        let newY = menuPosition.y;

        if (rect.right > window.innerWidth - 10) {
            newX = window.innerWidth - rect.width - 10;
            if (newX < 10) newX = 10;
        }
        
        if (rect.bottom > window.innerHeight - 10) {
            newY = Math.max(10, menuPosition.y - rect.height - 24);
        }

        if (newX !== menuPosition.x || newY !== menuPosition.y) {
            node.style.left = `${newX}px`;
            node.style.top = `${newY}px`;
        }
    }, [menuPosition.x, menuPosition.y]);

    return (
        <NodeViewWrapper
            ref={domRef}
            as="li"
            className={`slash-task-item ${checked ? 'is-done' : ''}`}
            data-type="taskItem"
            data-checked={checked}
        >
            <label
                className={`task-checkbox ${checked ? 'is-checked' : ''}`}
                onClick={handleCheckboxChange}
            >
                {checked && <Check size={10} strokeWidth={3} />}
            </label>

            <NodeViewContent as="div" className="task-content" />

            {menuMode === 'main' && createPortal(
                <div
                    ref={mainMenuPositionRef}
                    className="task-metadata-menu"
                    style={{
                        position: 'fixed',
                        left: menuPosition.x,
                        top: menuPosition.y,
                        transform: 'none',
                        zIndex: 1000,
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="task-metadata-backdrop" onClick={closeMenu} />
                    <button
                        className="task-metadata-option"
                        onClick={() => setMenuMode('date')}
                    >
                        📅 {t('task.date')} <span className="shortcut-key">&</span>
                    </button>
                    {teamMembers.length > 0 && (
                        <button
                            className="task-metadata-option"
                            onClick={() => setMenuMode('user')}
                        >
                            👤 {t('task.user')} <span className="shortcut-key">@</span>
                        </button>
                    )}
                    <button
                        className="task-metadata-option"
                        onClick={() => setMenuMode('priority')}
                    >
                        🚩 {t('task.priority')} <span className="shortcut-key">!</span>
                    </button>
                </div>, 
                document.body
            )}

            {menuMode === 'date' && (
                <DatePickerPopup
                    anchorRect={PseudoAnchorRect}
                    value={null}
                    onChange={(date) => {
                        insertChip('date', { date });
                        closeMenu();
                    }}
                    onClose={closeMenu}
                />
            )}

            {menuMode === 'user' && (
                <UserPopup
                    anchorRect={PseudoAnchorRect}
                    onSelect={(username) => {
                        insertChip('user', { username: username.replace(/\s+/g, '_') });
                        closeMenu();
                    }}
                    onClose={closeMenu}
                />
            )}

            {menuMode === 'priority' && (
                <PriorityPopup
                    anchorRect={PseudoAnchorRect}
                    onSelect={(priority) => {
                        insertChip('priority', { priority });
                        closeMenu();
                    }}
                    onClose={closeMenu}
                />
            )}
        </NodeViewWrapper>
    );
};

export default TaskItemComponent;
