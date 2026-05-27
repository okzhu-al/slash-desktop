/**
 * CustomInlineCode Extension
 * 
 * Fixes several issues with TipTap's default Code mark:
 * 1. Character before code being "eaten" - fixed with proper InputRule
 * 2. Cursor stays inside after completion - fixed by moving cursor out
 * 3. Click behavior - fixed with handleClick plugin
 * 4. Residual formatting - fixed with inclusive: false
 * 5. Mark boundary cursor - fixed with handleClick adjusting position
 */

import Code from '@tiptap/extension-code';
import { InputRule } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

export const CustomInlineCode = Code.extend({
    // Ensure code mark doesn't extend when typing at edges
    inclusive: false,

    // Prevent code from combining with other marks
    excludes: '_',

    // Markdown serialization for tiptap-markdown
    // Must match the format used by tiptap-markdown's internal code extension
    addStorage() {
        return {
            markdown: {
                serialize: {
                    open: '`',
                    close: '`',
                    escape: false,
                },
                parse: {
                    // handled by markdown-it
                },
            },
        };
    },

    addInputRules() {
        return [
            new InputRule({
                find: /(?:^|[^`])`([^`]+)`$/,
                handler: ({ state, range, match, chain }) => {
                    const content = match[1];
                    if (!content) return;

                    const hasLeadingChar = match[0].length > content.length + 2;
                    const from = hasLeadingChar ? range.from + 1 : range.from;
                    const to = range.to;

                    // Check if there's already a space before the backtick
                    const charBefore = from > 0 ? state.doc.textBetween(from - 1, from) : '';
                    const needsSpaceBefore = charBefore !== '' && charBefore !== ' ' && charBefore !== '\n';

                    const contentToInsert = [];

                    // Add space before code if needed (for cursor positioning)
                    if (needsSpaceBefore) {
                        contentToInsert.push({
                            type: 'text',
                            text: ' ',
                        });
                    }

                    // The code content with mark
                    contentToInsert.push({
                        type: 'text',
                        text: content,
                        marks: [{ type: 'code' }],
                    });

                    // Space after code (for cursor exit)
                    contentToInsert.push({
                        type: 'text',
                        text: ' ',
                    });

                    chain()
                        .deleteRange({ from, to })
                        .insertContent(contentToInsert)
                        .run();
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        // Note: We intentionally do NOT inherit parent shortcuts (Mod-e)
        // Inline code is now controlled by our custom keybinding system in Editor.tsx
        return {
            // Backspace at right edge of code mark: convert to `code text
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                const nodeBefore = $from.nodeBefore;
                if (!nodeBefore?.isText) return false;

                const hasCodeBefore = nodeBefore.marks.some(m => m.type.name === 'code');
                const nodeAfter = $from.nodeAfter;
                const hasCodeAfter = nodeAfter?.marks?.some(m => m.type.name === 'code');

                // Case 1: Right at end of code mark - only process the immediate nodeBefore
                if (hasCodeBefore && !hasCodeAfter) {
                    // Only process the immediate nodeBefore, not all code marks in paragraph
                    const codeContent = nodeBefore.text || '';
                    const codeStart = $from.pos - nodeBefore.nodeSize;

                    const tr = state.tr;
                    tr.delete(codeStart, $from.pos);
                    tr.insertText('`' + codeContent, codeStart);

                    // 🎯 显式设置光标位置到新文本末尾
                    const newEndPos = codeStart + 1 + codeContent.length;
                    tr.setSelection(TextSelection.create(tr.doc, newEndPos));
                    
                    // 🎯 移除 storedMark 防止新输入的文字继承 code 格式
                    tr.removeStoredMark(state.schema.marks.code);

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
                }

                // Case 2: Deleting space after code - convert immediately to `code
                if (!hasCodeBefore && nodeBefore.text === ' ') {
                    const posBeforeSpace = $from.pos - 1;
                    if (posBeforeSpace > $from.start()) {
                        const $posBeforeSpace = state.doc.resolve(posBeforeSpace);
                        const nodeBeforeSpace = $posBeforeSpace.nodeBefore;

                        if (nodeBeforeSpace?.isText && nodeBeforeSpace.marks.some(m => m.type.name === 'code')) {
                            const codeContent = nodeBeforeSpace.text || '';
                            const codeStart = posBeforeSpace - nodeBeforeSpace.nodeSize;

                            const tr = state.tr;
                            // 删除从 codeStart 到当前光标位置的全部内容（即包含代码节点和空格）
                            tr.delete(codeStart, $from.pos);
                            // 插入带有反引号的普通文本
                            tr.insertText('`' + codeContent, codeStart);

                            // 🎯 显式设置光标位置到新文本末尾
                            const newEndPos = codeStart + 1 + codeContent.length;
                            tr.setSelection(TextSelection.create(tr.doc, newEndPos));
                            
                            // 🎯 移除 storedMark 防止新输入的文字继承 code 格式
                            tr.removeStoredMark(state.schema.marks.code);
                            
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
                        }
                    }
                }

                return false;
            },
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('customInlineCodeClick'),
                props: {
                    // Handle clicks to ensure cursor is positioned correctly at mark boundaries
                    handleClick: (view, pos, event) => {
                        const { state } = view;
                        const $pos = state.doc.resolve(pos);

                        // Get marks at current position and adjacent positions
                        const nodeBefore = $pos.nodeBefore;
                        const nodeAfter = $pos.nodeAfter;

                        const hasCodeBefore = nodeBefore?.isText && nodeBefore.marks.some(m => m.type.name === 'code');
                        const hasCodeAfter = nodeAfter?.isText && nodeAfter.marks.some(m => m.type.name === 'code');

                        // At code mark boundary - check if we're at left or right edge
                        if (hasCodeBefore !== hasCodeAfter) {
                            // Get click coordinates relative to the code element
                            const target = event.target as HTMLElement;
                            const codeElement = target.closest('code');

                            if (codeElement) {
                                const rect = codeElement.getBoundingClientRect();
                                const clickX = event.clientX;
                                const midPoint = rect.left + rect.width / 2;

                                // Determine if click is closer to left or right edge
                                const clickedLeftHalf = clickX < midPoint;

                                if (hasCodeAfter && clickedLeftHalf) {
                                    // Clicked left side of code, should be BEFORE code
                                    // Position is already correct (before code)
                                    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos));
                                    tr.removeStoredMark(state.schema.marks.code);
                                    view.dispatch(tr);
                                    return true;
                                } else if (hasCodeBefore && !clickedLeftHalf) {
                                    // Clicked right side of code, should be AFTER code
                                    // Position is already correct (after code)
                                    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos));
                                    tr.removeStoredMark(state.schema.marks.code);
                                    view.dispatch(tr);
                                    return true;
                                }
                            }
                        }

                        return false;
                    },
                },
            }),
        ];
    },
});
