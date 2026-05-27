/**
 * UserChip Extension - Inline node for assignees
 * 
 * Renders: @username with styled capsule
 * Serializes to: @username
 * Parsed from: @username pattern in text using updateDOM
 */

import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { UserPopup } from './ui/UserPopup';

// React component for UserChip
const UserChipView: React.FC<NodeViewProps> = ({ node, updateAttributes, editor, deleteNode, getPos }) => {
    const { username, isDraft } = node.attrs;
    const [showPopup, setShowPopup] = useState(isDraft === true);
    const [containerEl, setContainerEl] = useState<HTMLSpanElement | null>(null);
    


    const handleSelect = useCallback((selectedUsername: string) => {
        updateAttributes({ username: selectedUsername, isDraft: false });
        setShowPopup(false);
        editor.commands.focus();
    }, [updateAttributes, editor]);

    const handleClose = useCallback(() => {
        setShowPopup(false);
        if (isDraft) {
            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof pos === 'number') {
                // Return to literal text
                setTimeout(() => {
                    if (!editor.isDestroyed) {
                        editor.chain()
                            .deleteRange({ from: pos, to: pos + node.nodeSize })
                            .insertContentAt(pos, '@ ')
                            .setTextSelection(pos + 2)
                            .focus()
                            .run();
                    }
                }, 0);
                return;
            }
            setTimeout(() => {
                deleteNode();
            }, 0);
        } else {
            setTimeout(() => {
                if (!editor.isDestroyed) {
                    editor.commands.focus();
                }
            }, 0);
        }
    }, [isDraft, deleteNode, editor, getPos, node.nodeSize]);

    // 🛡️ `@` + 空格/Escape = 取消 draft chip 并还原为字面量文本
    useEffect(() => {
        if (!isDraft || !showPopup) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === ' ' || e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleClose();
            }
        };
        // 使用 capture 确保在 popup 组件和编辑器响应之前拦截
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [isDraft, showPopup, handleClose]);

    // Look up display name from team members if available
    const displayUsername = useMemo(() => {
        if (!username) return '';
        const teamMembers = (window as any).__slashTeamMembers || [];
        const member = teamMembers.find((m: any) => m.username === username);
        if (member?.display_name) {
            return member.display_name;
        }
        return username.replace(/_/g, ' ');
    }, [username]);

    return (
        <NodeViewWrapper as="span" className="user-chip-wrapper" ref={setContainerEl} contentEditable={false}>
            {isDraft ? (
                <span className="task-metadata-draft-trigger">@&nbsp;</span>
            ) : (
                <button
                    className="task-capsule task-assignee"
                    onClick={() => {
                        if (editor.isEditable) {
                            setShowPopup(true);
                        }
                    }}
                    contentEditable={false}
                >
                    @{displayUsername}
                </button>
            )}
            {showPopup && (
                <UserPopup
                    anchorEl={containerEl}
                    onSelect={handleSelect}
                    onClose={handleClose}
                />
            )}
        </NodeViewWrapper>
    );
};

export const UserChip = Node.create({
    name: 'userChip',
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
        return {
            username: {
                default: '',
                parseHTML: element => element.getAttribute('data-username'),
                renderHTML: attributes => ({
                    'data-username': attributes.username,
                }),
            },
            isDraft: {
                default: false,
                // Do not serialize draft state to HTML/Markdown
                parseHTML: () => false,
                renderHTML: () => ({}),
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-type="userChip"]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-type': 'userChip' }, HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(UserChipView);
    },

    addInputRules() {
        return [
            // Legacy match: @username followed by space (仅行首或空格后)
            new InputRule({
                find: /@([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5_]*)\s$/,
                handler: ({ state, range, match }) => {
                    const teamMembers = (window as any).__slashTeamMembers || [];
                    if (teamMembers.length === 0) return null;

                    // 仅在行首或空格后触发，防止邮箱地址误触发
                    if (range.from > 0) {
                        const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, '\0');
                        if (before && !/\s/.test(before)) return null;
                    }
                    const username = match[1];
                    const { from, to } = range;
                    
                    // 💡 异步精确抹除与插入：避开打字 DOM 变化周期，在下一 Tick 宏任务中安全原地执行
                    setTimeout(() => {
                        if (!this.editor.isDestroyed) {
                            this.editor.chain()
                                .deleteRange({ from, to }) // 🛡️ 精准抹去写进文档中的这段 @username 普通字符
                                .insertContentAt(from, [
                                    { type: this.name, attrs: { username, isDraft: false } },
                                    { type: 'text', text: ' ' }
                                ])
                                .run();
                        }
                    }, 0);
                    return null; // 隐式放行，交给 setTimeout 去删除与插入，完美解决 flushSync 冲突
                },
            }),
            // `@` 直接触发人员选择器（仅行首或空格后）；`@ `（加空格）输入字面 @
            new InputRule({
                find: /(?:@|＠)$/,
                handler: ({ state, range }) => {
                    const teamMembers = (window as any).__slashTeamMembers || [];
                    if (teamMembers.length === 0) return null;

                    // 防止邮箱地址 user@domain 误触发
                    if (range.from > 0) {
                        const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, '\0');
                        if (before && !/\s/.test(before)) return null;
                    }
                    const { from } = range;
                    
                    // 💡 异步精确抹除与插入：避开打字 DOM 变化周期，在下一 Tick 宏任务中安全原地执行
                    setTimeout(() => {
                        if (!this.editor.isDestroyed) {
                            this.editor.chain()
                                .deleteRange({ from, to: from + 1 }) // 🛡️ 精准抹去刚刚写进去的长度为 1 的那个黑色普通 @ 字符！
                                .insertContentAt(from, { type: this.name, attrs: { isDraft: true } })
                                .run();
                        }
                    }, 0);
                    return null; // 隐式放行，交给 setTimeout 去删除与插入，完美解决 flushSync 冲突
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
                        state.write(`@ `); // Serialize draft back as text just in case
                    } else {
                        state.write(`@${node.attrs.username} `);
                    }
                },
                parse: {
                    updateDOM(element: HTMLElement) {
                        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
                        const nodesToReplace: { node: Text; matches: RegExpMatchArray[] }[] = [];
                        let textNode: Text | null;

                        while ((textNode = walker.nextNode() as Text | null)) {
                            if (textNode.parentElement?.closest('pre, code')) continue;

                            const text = textNode.textContent || '';
                            const regex = /@([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5_]*)/g;
                            const matches: RegExpMatchArray[] = [];
                            let match;

                            while ((match = regex.exec(text)) !== null) {
                                matches.push([...match] as unknown as RegExpMatchArray);
                            }

                            if (matches.length > 0) {
                                nodesToReplace.push({ node: textNode, matches });
                            }
                        }

                        for (const { node, matches } of nodesToReplace) {
                            const parent = node.parentNode;
                            if (!parent) continue;

                            let remaining = node.textContent || '';
                            const fragment = document.createDocumentFragment();

                            for (const match of matches) {
                                const fullMatch = match[0];
                                const username = match[1];
                                const idx = remaining.indexOf(fullMatch);

                                if (idx > 0) {
                                    fragment.appendChild(document.createTextNode(remaining.slice(0, idx)));
                                }

                                const span = document.createElement('span');
                                span.setAttribute('data-type', 'userChip');
                                span.setAttribute('data-username', username);
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
