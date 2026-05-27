/**
 * CustomBold Extension
 * 
 * Extends TipTap's Bold with:
 * - InputRule that works with preceding characters (**text**)
 * - Backspace at right edge enters edit mode (shows **text)
 * - No extra spaces in serialization
 */

import Bold from '@tiptap/extension-bold';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

// Input rule for **text** that works even with preceding characters
const boldInputRegex = /(?:^|[^*])(\*\*([^*]+)\*\*)$/;

export const CustomBold = Bold.extend({
    keepOnSplit: false,

    addInputRules() {
        return [
            new InputRule({
                find: boldInputRegex,
                handler: ({ state, range, match }) => {
                    // Don't apply inside code marks
                    const $from = state.doc.resolve(range.from);
                    if ($from.marks().some(m => m.type.name === 'code')) return;

                    // Don't apply if we're inside unclosed backticks (typing code)
                    const textBefore = state.doc.textBetween($from.start(), range.to);
                    const backtickCount = (textBefore.match(/`/g) || []).length;
                    if (backtickCount % 2 === 1) return; // Odd number = unclosed backtick

                    const content = match[2]; // The text between **
                    if (!content) return;

                    const { tr } = state;

                    // Calculate the actual range of **text**
                    const fullMatch = match[0];
                    const hasLeadingChar = fullMatch.length > match[1].length;
                    const from = hasLeadingChar ? range.from + 1 : range.from;
                    const to = range.to;

                    // Create the bold mark
                    const boldMark = state.schema.marks.bold.create();

                    // Delete the markdown syntax
                    tr.delete(from, to);

                    // Insert the formatted text
                    tr.insertText(content, from);

                    // Apply the bold mark
                    tr.addMark(from, from + content.length, boldMark);

                    // Position cursor at the end, outside the mark
                    const endPos = from + content.length;
                    tr.setSelection(TextSelection.create(tr.doc, endPos));

                    // Ensure the mark won't continue
                    tr.removeStoredMark(boldMark);
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        // Note: We intentionally do NOT inherit parent shortcuts (Mod-b)
        // Bold is now controlled by our custom keybinding system in Editor.tsx
        return {
            // Backspace at right edge of bold: enter edit mode
            // Shows "**text" - removes mark, adds left syntax
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Check if we're at the right edge of bold text
                const nodeBefore = $from.nodeBefore;
                if (!nodeBefore?.isText) return false;

                const hasBoldBefore = nodeBefore.marks.some(m => m.type.name === 'bold');
                const nodeAfter = $from.nodeAfter;
                const hasBoldAfter = nodeAfter?.marks?.some(m => m.type.name === 'bold');

                // Only trigger at right edge (bold before, no bold after)
                if (!hasBoldBefore || hasBoldAfter) return false;

                // Only process the immediate nodeBefore, not all bold marks in paragraph
                const boldContent = nodeBefore.text || '';
                const boldStart = $from.pos - nodeBefore.nodeSize;

                // Replace bold mark with "**content" (edit mode)
                const tr = state.tr;
                tr.delete(boldStart, $from.pos);
                tr.insertText('**' + boldContent, boldStart);

                // Position cursor at the end
                const newEndPos = boldStart + 2 + boldContent.length;
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

    // Override serialization to disable expelEnclosingWhitespace
    // tiptap-markdown's CommonMark flanking rules don't work with CJK punctuation
    addStorage() {
        return {
            markdown: {
                serialize: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: false },
            },
        };
    },
});
