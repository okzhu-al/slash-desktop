/**
 * CustomHighlight Extension
 * 
 * Extends TipTap's Highlight mark with:
 * - ==text== InputRule that works with preceding characters
 * - Backspace at right edge enters edit mode (shows ==text)
 * - No extra spaces in serialization
 * - Markdown serialization (==text==)
 */

import Highlight from '@tiptap/extension-highlight';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

// Input rule for ==text== that works with preceding characters
const highlightInputRegex = /(?:^|[^=])(==([^=]+)==)$/;

export const CustomHighlight = Highlight.extend({
    keepOnSplit: false,

    addInputRules() {
        return [
            new InputRule({
                find: highlightInputRegex,
                handler: ({ state, range, match }) => {
                    // Don't apply inside code marks
                    const $from = state.doc.resolve(range.from);
                    if ($from.marks().some(m => m.type.name === 'code')) return;

                    // Don't apply if we're inside unclosed backticks (typing code)
                    const textBefore = state.doc.textBetween($from.start(), range.to);
                    const backtickCount = (textBefore.match(/`/g) || []).length;
                    if (backtickCount % 2 === 1) return; // Odd number = unclosed backtick

                    const content = match[2]; // The text between ==
                    if (!content) return;

                    const { tr } = state;

                    // Calculate the actual range of ==text==
                    const fullMatch = match[0];
                    const hasLeadingChar = fullMatch.length > match[1].length;
                    const from = hasLeadingChar ? range.from + 1 : range.from;
                    const to = range.to;

                    // Create the highlight mark
                    const highlightMark = state.schema.marks.highlight.create();

                    // Delete the markdown syntax
                    tr.delete(from, to);

                    // Insert the formatted text
                    tr.insertText(content, from);

                    // Apply the highlight mark
                    tr.addMark(from, from + content.length, highlightMark);

                    // Position cursor at the end, outside the mark
                    const endPos = from + content.length;
                    tr.setSelection(TextSelection.create(tr.doc, endPos));

                    // Ensure the mark won't continue
                    tr.removeStoredMark(highlightMark);
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        // Note: We intentionally do NOT inherit parent shortcuts
        // Highlight is now controlled by our custom keybinding system in Editor.tsx
        return {
            // Backspace at right edge of highlight: enter edit mode
            // Shows "==text" - removes mark, adds left syntax
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Check if we're at the right edge of highlight text
                const nodeBefore = $from.nodeBefore;
                if (!nodeBefore?.isText) return false;

                const hasHighlightBefore = nodeBefore.marks.some(m => m.type.name === 'highlight');
                const nodeAfter = $from.nodeAfter;
                const hasHighlightAfter = nodeAfter?.marks?.some(m => m.type.name === 'highlight');

                // Only trigger at right edge (highlight before, no highlight after)
                if (!hasHighlightBefore || hasHighlightAfter) return false;

                // Only process the immediate nodeBefore, not all highlight marks in paragraph
                const highlightContent = nodeBefore.text || '';
                const highlightStart = $from.pos - nodeBefore.nodeSize;

                // Replace highlight mark with "==content" (edit mode)
                const tr = state.tr;
                tr.delete(highlightStart, $from.pos);
                tr.insertText('==' + highlightContent, highlightStart);

                // Position cursor at the end
                const newEndPos = highlightStart + 2 + highlightContent.length;
                tr.setSelection(TextSelection.create(tr.doc, newEndPos));

                view.dispatch(tr);

                // 🛡️ WebKit caret repaint fix: 强制重绘选区，消除残影
                queueMicrotask(() => {
                    const sel = window.getSelection();
                    if (sel && sel.rangeCount) {
                        const range = sel.getRangeAt(0).cloneRange();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                });

                return true;
            },
        };
    },

    addStorage() {
        return {
            markdown: {
                // Mark serialization uses open/close format (no spaces)
                // mixable: true allows nesting with other marks (bold, italic, etc.)
                serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: false },
                parse: {
                    setup(markdownit: any) {
                        // 防止多次 setup 调用重复注册
                        if ((markdownit as any).__highlightSetup) return;
                        (markdownit as any).__highlightSetup = true;

                        // Add highlight plugin to markdown-it
                        markdownit.use((md: any) => {
                            // 注册显式 renderer rules，确保 token 正确渲染为 HTML
                            md.renderer.rules.highlight_open = () => '<mark>';
                            md.renderer.rules.highlight_close = () => '</mark>';

                            // Match ==text==
                            md.inline.ruler.before('emphasis', 'highlight', (state: any, silent: boolean) => {
                                const start = state.pos;
                                const marker = state.src.charCodeAt(start);

                                if (marker !== 0x3D /* = */) return false;
                                if (state.src.charCodeAt(start + 1) !== 0x3D) return false;

                                const end = state.src.indexOf('==', start + 2);
                                if (end === -1) return false;

                                if (!silent) {
                                    const token = state.push('highlight_open', 'mark', 1);
                                    token.markup = '==';

                                    // 直接插入内容文本，让外层 tokenizer 处理嵌套 marks
                                    const content = state.src.slice(start + 2, end);
                                    const contentToken = state.push('text', '', 0);
                                    contentToken.content = content;

                                    const closeToken = state.push('highlight_close', 'mark', -1);
                                    closeToken.markup = '==';
                                }

                                state.pos = end + 2;
                                return true;
                            });
                        });
                    },
                },
            },
        };
    },
});
