/**
 * PriorityChip Extension - Inline node for priorities
 * 
 * Renders: 🚩High / 🚩Med / 🚩Low
 * Serializes to: #High / #Medium / #Low
 * Parsed from: #High, #Medium, #Low pattern in text using updateDOM
 */

import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PriorityPopup } from './ui/PriorityPopup';

const PRIORITY_STYLES: Record<string, string> = {
    high: 'priority-high',
    medium: 'priority-medium',
    low: 'priority-low',
};

// React component for PriorityChip
const PriorityChipView: React.FC<NodeViewProps> = ({ node, updateAttributes, editor, deleteNode, getPos }) => {
    const { priority, isDraft } = node.attrs;
    const { t } = useTranslation();
    const [showMenu, setShowMenu] = useState(isDraft === true);
    const [containerEl, setContainerEl] = useState<HTMLSpanElement | null>(null);

    const getPriorityLabel = (p: string) => {
        const createLabel = (icon: string, text: string) => (
            <>
                <span className="priority-icon">{icon}</span>
                <span>{text}</span>
            </>
        );

        switch (p) {
            case 'high': return createLabel('🔴', t('task.priorityHigh', 'High'));
            case 'medium': return createLabel('🟡', t('task.priorityMedium', 'Medium'));
            case 'low': return createLabel('🟢', t('task.priorityLow', 'Low'));
            default: return p || ' ';
        }
    };

    const handleSelect = useCallback((newPriority: string | null) => {
        if (newPriority) {
            updateAttributes({ priority: newPriority, isDraft: false });
            setShowMenu(false);
            editor.commands.focus();
        } else {
            deleteNode();
            editor.commands.focus();
        }
    }, [updateAttributes, deleteNode, editor]);

    const handleClose = useCallback(() => {
        setShowMenu(false);
        if (isDraft) {
            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof pos === 'number') {
                // Return to literal text
                editor.chain()
                    .deleteRange({ from: pos, to: pos + node.nodeSize })
                    .insertContentAt(pos, '! ')
                    .setTextSelection(pos + 2)
                    .focus()
                    .run();
                return;
            }
            deleteNode();
        }
        editor.commands.focus();
    }, [isDraft, deleteNode, editor, getPos, node.nodeSize]);

    // 🛡️ `!` + 空格 = 输入字面 `! `，取消 draft chip
    useEffect(() => {
        if (!isDraft || !showMenu) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === ' ') {
                e.preventDefault();
                handleClose();
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [isDraft, showMenu, handleClose]);

    return (
        <NodeViewWrapper as="span" className="priority-chip-wrapper" ref={setContainerEl}>
            {isDraft ? (
                <span className="task-metadata-draft-trigger">!&nbsp;</span>
            ) : (
                <button
                    className={`task-capsule task-priority ${PRIORITY_STYLES[priority] || ''}`}
                    onClick={() => editor.isEditable && setShowMenu(true)}
                    contentEditable={false}
                >
                    {getPriorityLabel(priority)}
                </button>
            )}
            {showMenu && (
                <PriorityPopup
                    anchorEl={containerEl}
                    onSelect={handleSelect}
                    onClose={handleClose}
                />
            )}
        </NodeViewWrapper>
    );
};

export const PriorityChip = Node.create({
    name: 'priorityChip',
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
        return {
            priority: {
                default: 'medium',
                parseHTML: element => element.getAttribute('data-priority'),
                renderHTML: attributes => ({
                    'data-priority': attributes.priority,
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
                tag: 'span[data-type="priorityChip"]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-type': 'priorityChip' }, HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(PriorityChipView);
    },

    // InputRule: convert #priority patterns in real-time
    addInputRules() {
        return [
            // Legacy match: #High, #Medium, #Low followed by space
            new InputRule({
                find: /#(High|Medium|Med|Low)\s$/i,
                handler: ({ state, range, match }) => {
                    let priority = match[1].toLowerCase();
                    if (priority === 'med') priority = 'medium';
                    const { tr } = state;

                    tr.replaceWith(range.from, range.to, [
                        this.type.create({ priority, isDraft: false }),
                        state.schema.text(' '),
                    ]);
                },
            }),
            // `!` 直接触发优先级选择器；`! `（加空格）输入字面 !
            new InputRule({
                find: /(?:!|！)$/,
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
                        state.write(`! `);
                    } else {
                        const p = node.attrs.priority;
                        const normalized = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
                        state.write(`#${normalized} `);
                    }
                },
                parse: {
                    // Use updateDOM to transform the HTML after markdown-it renders
                    updateDOM(element: HTMLElement) {
                        // Walk through all text nodes and replace #Priority patterns
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
                            // Match #High, #Medium, #Low, #Med (case insensitive, not followed by alphanumeric)
                            const regex = /#(High|Medium|Low|Med)(?![a-zA-Z0-9])/gi;
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
                                let priority = match[1].toLowerCase();
                                if (priority === 'med') priority = 'medium';

                                const idx = remaining.indexOf(fullMatch);

                                if (idx > 0) {
                                    fragment.appendChild(document.createTextNode(remaining.slice(0, idx)));
                                }

                                const span = document.createElement('span');
                                span.setAttribute('data-type', 'priorityChip');
                                span.setAttribute('data-priority', priority);
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
