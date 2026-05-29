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

    const handleCheckboxToggle = useCallback(() => {
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
            className={`slash-task-item ${checked ? 'is-done' : ''}`}
            data-type="taskItem"
            data-checked={checked}
        >
            <span
                className={`task-checkbox-wrapper ${checked ? 'is-checked' : ''}`}
                contentEditable={false}
                onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCheckboxToggle();
                }}
            >
                <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    tabIndex={-1}
                    className="task-input-hidden"
                    onMouseDown={(e) => e.preventDefault()}
                />
                <span className="task-checkbox-inner">
                    {checked && <Check size={10} strokeWidth={3} />}
                </span>
            </span>

            <NodeViewContent as="div" className="task-content-wrapper" />

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
