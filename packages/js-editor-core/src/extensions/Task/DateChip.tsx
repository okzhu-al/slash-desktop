/**
 * DateChip Extension - Inline node for due dates
 * 
 * Renders: 📅M月D日
 * Serializes to: 📅YYYY-MM-DD
 * Parsed from: 📅YYYY-MM-DD pattern in text using updateDOM
 */

import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import React, { useState, useCallback, useEffect } from 'react';
import { DatePickerPopup } from './ui/DatePickerPopup';

// React component for DateChip
const DateChipView: React.FC<NodeViewProps> = ({ node, updateAttributes, editor, deleteNode, getPos }) => {
    const { date, isDraft } = node.attrs;
    const [showPicker, setShowPicker] = useState(isDraft === true);
    const [containerEl, setContainerEl] = useState<HTMLSpanElement | null>(null);

    const handleDateChange = useCallback((newDate: string | null) => {
        if (newDate) {
            updateAttributes({ date: newDate, isDraft: false });
            setShowPicker(false);

            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof pos === 'number') {
                let needsSpaceBefore = false;
                try {
                    if (pos > 1) {
                        const beforeText = editor.state.doc.textBetween(pos - 1, pos);
                        if (beforeText !== ' ' && beforeText !== '\n') {
                            needsSpaceBefore = true;
                        }
                    }
                } catch (e) {
                    console.error('Failed to check text before chip:', e);
                }

                if (needsSpaceBefore) {
                    editor.chain()
                        .insertContentAt(pos, ' ')
                        .setTextSelection(pos + 2)
                        .focus()
                        .run();
                } else {
                    editor.chain()
                        .setTextSelection(pos + 1)
                        .focus()
                        .run();
                }
            } else {
                editor.commands.focus();
            }
        }
    }, [updateAttributes, editor, getPos]);

    const handleClose = useCallback(() => {
        setShowPicker(false);
        if (isDraft) {
            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof pos === 'number') {
                // Return to literal text
                editor.chain()
                    .deleteRange({ from: pos, to: pos + node.nodeSize })
                    .insertContentAt(pos, '& ')
                    .setTextSelection(pos + 2)
                    .focus()
                    .run();
                return;
            }
            deleteNode();
        }
        editor.commands.focus();
    }, [isDraft, deleteNode, editor, getPos, node.nodeSize]);

    // 🛡️ `&` + 空格 = 输入字面 `& `，取消 draft chip
    useEffect(() => {
        if (!isDraft || !showPicker) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === ' ') {
                e.preventDefault();
                handleClose();
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [isDraft, showPicker, handleClose]);

    const formatDate = (dateStr: string) => {
        if (!dateStr) return '📅';
        const d = new Date(dateStr);
        return `📅${d.getMonth() + 1}月${d.getDate()}日`;
    };

    const isOverdue = date && new Date(date) < new Date();

    return (
        <NodeViewWrapper as="span" className="date-chip-wrapper" ref={setContainerEl}>
            {isDraft ? (
                <span className="task-metadata-draft-trigger">&amp;&nbsp;</span>
            ) : (
                <button
                    className={`task-capsule task-date ${isOverdue ? 'is-overdue' : ''}`}
                    onClick={() => editor.isEditable && setShowPicker(true)}
                    contentEditable={false}
                >
                    {formatDate(date)}
                </button>
            )}
            {showPicker && (
                <DatePickerPopup
                    anchorEl={containerEl}
                    value={date}
                    onChange={handleDateChange}
                    onClose={handleClose}
                />
            )}
        </NodeViewWrapper>
    );
};

export const DateChip = Node.create({
    name: 'dateChip',
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
        return {
            date: {
                default: null,
                parseHTML: element => element.getAttribute('data-date'),
                renderHTML: attributes => ({
                    'data-date': attributes.date,
                }),
            },
            isDraft: {
                default: false,
                parseHTML: () => false,
                renderHTML: () => ({}),
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-type="dateChip"]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-type': 'dateChip' }, HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(DateChipView);
    },

    addInputRules() {
        return [
            // `&` 直接触发日期选择器；`& `（加空格）输入字面 &
            new InputRule({
                find: /(?:&|＆)$/,
                handler: ({ state, range }) => {
                    const { tr } = state;
                    tr.replaceWith(range.from, range.to, this.type.create({ isDraft: true }));
                },
            }),
        ];
    },

    // Markdown serialization and parsing
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    if (node.attrs.isDraft) {
                        state.write(`& `);
                    } else {
                        state.write(`📅${node.attrs.date} `);
                    }
                },
                parse: {
                    // Use updateDOM to transform the HTML after markdown-it renders
                    // This is more reliable than inline rules
                    updateDOM(element: HTMLElement) {
                        // Walk through all text nodes and replace 📅YYYY-MM-DD patterns
                        const walker = document.createTreeWalker(
                            element,
                            NodeFilter.SHOW_TEXT,
                            null
                        );

                        const nodesToReplace: { node: Text; matches: RegExpMatchArray[] }[] = [];
                        let textNode: Text | null;

                        while ((textNode = walker.nextNode() as Text | null)) {
                            // 跳过代码块内的文本节点
                            if (textNode.parentElement?.closest('pre, code')) continue;

                            const text = textNode.textContent || '';
                            const regex = /📅(\d{4}-\d{2}-\d{2})/g;
                            const matches: RegExpMatchArray[] = [];
                            let match;

                            while ((match = regex.exec(text)) !== null) {
                                matches.push([...match] as unknown as RegExpMatchArray);
                            }

                            if (matches.length > 0) {
                                nodesToReplace.push({ node: textNode, matches });
                            }
                        }

                        // Replace text nodes with spans
                        for (const { node, matches } of nodesToReplace) {
                            const parent = node.parentNode;
                            if (!parent) continue;

                            let remaining = node.textContent || '';
                            const fragment = document.createDocumentFragment();

                            for (const match of matches) {
                                const fullMatch = match[0];
                                const date = match[1];
                                const idx = remaining.indexOf(fullMatch);

                                if (idx > 0) {
                                    fragment.appendChild(document.createTextNode(remaining.slice(0, idx)));
                                }

                                const span = document.createElement('span');
                                span.setAttribute('data-type', 'dateChip');
                                span.setAttribute('data-date', date);
                                fragment.appendChild(span);

                                remaining = remaining.slice(idx + fullMatch.length);
                            }

                            if (remaining) {
                                fragment.appendChild(document.createTextNode(remaining));
                            }

                            parent.replaceChild(fragment, node);
                        }
                    },
                },
            },
        };
    },
});
