import { Node, mergeAttributes } from '@tiptap/core';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import Suggestion, { SuggestionOptions } from '@tiptap/suggestion';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { WikiLinkNodeView } from './WikiLinkNodeView';

export interface WikiLinkOptions {
    HTMLAttributes: Record<string, any>;
    suggestion: Omit<SuggestionOptions, 'editor'>;
    onNavigate?: (path: string, section?: string) => void;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        wikiLink: {
            insertWikiLink: (attrs: { href: string; label: string; section?: string }) => ReturnType;
        };
    }
}

export const WikiLink = Node.create<WikiLinkOptions>({
    name: 'wikiLink',

    group: 'inline',

    inline: true,

    atom: true,

    addOptions() {
        return {
            HTMLAttributes: {
                'data-type': 'wiki-link',
            },
            suggestion: {
                char: '[[',
                pluginKey: undefined as any,
                command: ({ editor, range, props }) => {
                    // 检测是否在选择章节（props.path 是章节名，props.title 包含 # 前缀）
                    const isSection = props.title.startsWith('#') || props.title.startsWith('## ') ||
                        props.title.startsWith('### ') || props.title.startsWith('#### ');

                    if (isSection) {
                        // 章节选择模式：获取当前 [[NoteName# 的文本，追加章节名
                        // props.path 是纯章节文本（不含 # 前缀）
                        editor
                            .chain()
                            .focus()
                            .deleteRange(range)
                            .insertContent(props.path) // 直接替换为章节名
                            .run();
                    } else {
                        // 笔记选择模式：插入 [[NoteName，不自动闭合
                        editor
                            .chain()
                            .focus()
                            .deleteRange(range)
                            .insertContent(`[[${props.title}`)
                            .run();
                    }
                },
            },
            onNavigate: undefined,
        };
    },

    addAttributes() {
        return {
            href: {
                default: null,
                parseHTML: (element) => element.getAttribute('data-href'),
                renderHTML: (attributes) => ({
                    'data-href': attributes.href,
                }),
            },
            section: {
                default: null,
                parseHTML: (element) => element.getAttribute('data-section'),
                renderHTML: (attributes) => ({
                    'data-section': attributes.section,
                }),
            },
            label: {
                default: null,
                parseHTML: (element) => element.textContent,
                renderHTML: () => ({}),
            },
        };
    },

    // Configure how tiptap-markdown serializes this node
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const { href, section, label } = node.attrs;
                    // Build target: "note" or "note#section"
                    const target = section ? `${href}#${section}` : href;
                    // Check if label is custom (different from target)
                    const hasCustomLabel = label && label !== href && label !== target;

                    if (hasCustomLabel) {
                        state.write(`[[${target}|${label}]]`);
                    } else {
                        state.write(`[[${target}]]`);
                    }
                },
                parse: {
                    // Setup markdown-it to parse [[...]] as wikiLink nodes
                    setup(markdownit: any) {
                        // Add inline wikilink rule AFTER backticks rule
                        // This ensures backticks are processed first and code spans are marked
                        markdownit.inline.ruler.after('backticks', 'wikilink', (state: any, silent: boolean) => {
                            const start = state.pos;
                            const max = state.posMax;

                            // Must start with [[
                            if (state.src.charCodeAt(start) !== 0x5B /* [ */ ||
                                state.src.charCodeAt(start + 1) !== 0x5B /* [ */) {
                                return false;
                            }



                            // Check if we're inside a fenced code block
                            // state.env may contain context from block parsing
                            if (state.env && state.env.insideFencedCode) {
                                return false;
                            }

                            // Additional check: if state has tokens from parent, check for fence
                            if (state.tokens && state.tokens.length > 0) {
                                const lastToken = state.tokens[state.tokens.length - 1];
                                if (lastToken && (lastToken.type === 'fence' || lastToken.tag === 'code')) {
                                    return false;
                                }
                            }

                            // Check if we're inside inline code by counting unmatched backticks
                            // in the current scan range (from beginning of current inline parsing)
                            const textBeforeInLine = state.src.slice(0, start);

                            // Simple approach: count backticks and check if odd (inside code)
                            // This handles cases like `code` text [[link]] more `code`
                            let backtickCount = 0;
                            let i = 0;
                            while (i < textBeforeInLine.length) {
                                if (textBeforeInLine[i] === '`') {
                                    // Count consecutive backticks
                                    let count = 0;
                                    while (i < textBeforeInLine.length && textBeforeInLine[i] === '`') {
                                        count++;
                                        i++;
                                    }
                                    backtickCount += count;
                                } else {
                                    i++;
                                }
                            }

                            // Also check text after to see if there's a matching closing backtick
                            // If odd backticks before AND there's a backtick after, we're in code
                            if (backtickCount % 2 === 1) {
                                const textAfter = state.src.slice(start);
                                if (textAfter.includes('`')) {
                                    // Inside inline code - skip WikiLink parsing
                                    return false;
                                }
                            }

                            // Find closing ]]
                            let end = start + 2;
                            while (end < max - 1) {
                                if (state.src.charCodeAt(end) === 0x5D /* ] */ &&
                                    state.src.charCodeAt(end + 1) === 0x5D /* ] */) {
                                    break;
                                }
                                end++;
                            }

                            // No closing ]] found
                            if (end >= max - 1) return false;

                            if (!silent) {
                                const content = state.src.slice(start + 2, end);

                                // Parse content: "target" or "target|label"
                                const pipeIndex = content.indexOf('|');
                                let fullTarget: string;
                                let label: string;

                                if (pipeIndex !== -1) {
                                    fullTarget = content.slice(0, pipeIndex);
                                    label = content.slice(pipeIndex + 1);
                                } else {
                                    fullTarget = content;
                                    label = content;
                                }

                                // Parse target: "note" or "note#section"
                                let href = fullTarget;
                                let section: string | null = null;
                                const hashIndex = fullTarget.indexOf('#');
                                if (hashIndex !== -1) {
                                    href = fullTarget.slice(0, hashIndex);
                                    section = fullTarget.slice(hashIndex + 1);
                                }

                                const token = state.push('wikilink', 'span', 0);
                                token.attrs = [
                                    ['data-type', 'wikiLink'],
                                    ['data-href', href],
                                    ['data-section', section || ''],
                                    ['data-label', label],
                                ];
                                token.content = label;
                            }

                            state.pos = end + 2;
                            return true;
                        });

                        // Render wikilink tokens to HTML
                        // IMPORTANT: Include label as text content so parseHTML can extract it
                        markdownit.renderer.rules.wikilink = (tokens: any[], idx: number) => {
                            const token = tokens[idx];
                            const href = token.attrs.find((a: string[]) => a[0] === 'data-href')?.[1] || '';
                            const section = token.attrs.find((a: string[]) => a[0] === 'data-section')?.[1] || '';
                            const label = token.attrs.find((a: string[]) => a[0] === 'data-label')?.[1] || href;
                            // Include label as inner text for parseHTML to extract via textContent
                            return `<span data-type="wikiLink" data-href="${href}" data-section="${section}" data-label="${label}">${label}</span>`;
                        };
                    },
                },
            },
        };
    },

    parseHTML() {
        return [
            {
                // Match markdown-it rendered spans (camelCase)
                tag: 'span[data-type="wikiLink"]',
                getAttrs: (element) => ({
                    href: (element as HTMLElement).getAttribute('data-href') || '',
                    section: (element as HTMLElement).getAttribute('data-section') || null,
                    label: (element as HTMLElement).getAttribute('data-label') ||
                        (element as HTMLElement).getAttribute('data-href') || '',
                }),
            },
            {
                // Match editor-rendered spans (kebab-case)
                tag: 'span[data-type="wiki-link"]',
                getAttrs: (element) => ({
                    href: (element as HTMLElement).getAttribute('data-href') || '',
                    section: (element as HTMLElement).getAttribute('data-section') || null,
                    label: (element as HTMLElement).textContent ||
                        (element as HTMLElement).getAttribute('data-href') || '',
                }),
            },
            {
                tag: 'a[data-wiki]',
                getAttrs: (element) => ({
                    href: (element as HTMLElement).getAttribute('href'),
                    label: (element as HTMLElement).textContent,
                }),
            },
        ];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                class: 'wiki-link text-indigo-600 dark:text-indigo-400 cursor-pointer hover:underline',
            }),
            node.attrs.label, // Display without brackets
        ];
    },

    addCommands() {
        return {
            insertWikiLink:
                (attrs) =>
                    ({ commands }) => {
                        return commands.insertContent({
                            type: this.name,
                            attrs,
                        });
                    },
        };
    },

    addInputRules() {
        // Helper to check if cursor is inside code or math context
        const isInsideCodeOrMath = (state: any, pos: number): boolean => {
            const $pos = state.doc.resolve(pos);
            // Check parent node type
            const parentNode = $pos.parent;
            if (parentNode.type.name === 'codeBlock' || parentNode.type.name === 'math') {
                return true;
            }
            // Check for inline code mark
            const marks = $pos.marks();
            if (marks.some((mark: any) => mark.type.name === 'code')) {
                return true;
            }

            // Check for unclosed inline code/math in the text before cursor
            const textBefore = parentNode.textBetween(0, $pos.parentOffset, '\0', ' ');

            // Count backticks - odd count means we're inside inline code
            const backtickCount = (textBefore.match(/`/g) || []).length;
            if (backtickCount % 2 === 1) {
                return true;
            }

            // Count $ for inline math - odd count means we're inside math
            const dollarMatches = textBefore.match(/\$/g) || [];
            const doubleDollarMatches = textBefore.match(/\$\$/g) || [];
            const singleDollarCount = dollarMatches.length - (doubleDollarMatches.length * 2);
            if (singleDollarCount % 2 === 1) {
                return true;
            }

            return false;
        };

        return [
            // Chinese bracket auto-correct: 【【 → [[
            new InputRule({
                find: /【【$/,
                handler: ({ range, chain, state }) => {
                    // Skip inside code/math
                    if (isInsideCodeOrMath(state, range.from)) return;
                    try {
                        chain()
                            .deleteRange(range)
                            .insertContent('[[')
                            .run();
                    } catch (e) {
                        console.warn('[WikiLink] InputRule error:', e);
                    }
                },
            }),
            // 当用户输入 ]] 或 】】时，将 [[...]] 转换为 WikiLink 节点
            // 支持格式: [[note]], [[note#section]], [[note|label]], [[note#section|label]]
            // 同时支持中文全角字符：】】 和 ｜
            new InputRule({
                find: /\[\[([^\]|｜】]+)(?:[|｜]([^\]】]+))?[\]】][\]】]$/,
                handler: ({ range, match, chain, state }) => {
                    // Skip inside code/math
                    if (isInsideCodeOrMath(state, range.from)) {
                        return;
                    }
                    try {
                        const fullTarget = match[1]; // "note" or "note#section"
                        const customLabel = match[2]; // optional custom label

                        // Parse target into href and section
                        let href = fullTarget;
                        let section: string | null = null;
                        const hashIndex = fullTarget.indexOf('#');
                        if (hashIndex !== -1) {
                            href = fullTarget.substring(0, hashIndex);
                            section = fullTarget.substring(hashIndex + 1);
                        }

                        // Label defaults to href if not custom
                        const label = customLabel || href;

                        chain()
                            .deleteRange(range)
                            .insertContent({
                                type: 'wikiLink',
                                attrs: { href, section, label }
                            })
                            .run();
                    } catch (e) {
                        console.warn('[WikiLink] InputRule ]] error:', e);
                    }
                },
            }),
        ];
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                ...this.options.suggestion,
            }),
        ];
    },

    addKeyboardShortcuts() {
        return {
            // When cursor is right after a WikiLink and Backspace is pressed,
            // convert the node to editable text WITHOUT closing ]]
            // This avoids triggering the InputRule that would re-create the node
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                // Only handle when cursor is at a position (no selection)
                if (!empty) return false;

                // Get the node directly before the cursor position
                const nodeBefore = $from.nodeBefore;

                // Only handle if the node before cursor is a wikiLink
                if (nodeBefore?.type.name !== 'wikiLink') {
                    return false;
                }

                // Get the WikiLink attributes
                const { href, section, label } = nodeBefore.attrs;

                // Build the text representation WITHOUT closing ]]
                // This allows editing without triggering the InputRule
                let text = `[[${href}`;
                if (section) text += `#${section}`;
                if (label && label !== href && label !== (section ? `${href}#${section}` : href)) {
                    text += `|${label}`;
                }
                // Note: NO closing ]] - user can continue editing

                // Calculate the node position (cursor pos - node size)
                const nodePos = $from.pos - nodeBefore.nodeSize;

                // Replace the node with text
                const tr = state.tr.replaceWith(
                    nodePos,
                    $from.pos,
                    state.schema.text(text)
                );

                // Move cursor to the end of the text
                tr.setSelection(TextSelection.create(tr.doc, nodePos + text.length));

                view.dispatch(tr);
                return true;
            },
        };
    },

    addNodeView() {
        return ReactNodeViewRenderer(WikiLinkNodeView);
    },
});
