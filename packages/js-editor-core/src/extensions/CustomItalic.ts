/**
 * CustomItalic Extension
 * 
 * Extends TipTap's Italic with:
 * - InputRule that works with preceding characters (*text*)
 * - Backspace at right edge enters edit mode (shows *text)
 * - No extra spaces in serialization
 */

import Italic from '@tiptap/extension-italic';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

// Input rule for *text* that works even with preceding characters
// Must not match ** which is for bold
const italicInputRegex = /(?:^|[^*])(\*([^*]+)\*)$/;

export const CustomItalic = Italic.extend({
    keepOnSplit: false,

    addInputRules() {
        return [
            new InputRule({
                find: italicInputRegex,
                handler: ({ state, range, match }) => {
                    // Don't apply inside code marks
                    const $from = state.doc.resolve(range.from);
                    if ($from.marks().some(m => m.type.name === 'code')) return;

                    // Don't apply if we're inside unclosed backticks (typing code)
                    const textBefore = state.doc.textBetween($from.start(), range.to);
                    const backtickCount = (textBefore.match(/`/g) || []).length;
                    if (backtickCount % 2 === 1) return; // Odd number = unclosed backtick

                    const content = match[2]; // The text between *
                    if (!content) return;

                    const { tr } = state;

                    // Calculate the actual range of *text*
                    const fullMatch = match[0];
                    const hasLeadingChar = fullMatch.length > match[1].length;
                    const from = hasLeadingChar ? range.from + 1 : range.from;
                    const to = range.to;

                    // Create the italic mark
                    const italicMark = state.schema.marks.italic.create();

                    // Delete the markdown syntax
                    tr.delete(from, to);

                    // Insert the formatted text
                    tr.insertText(content, from);

                    // Apply the italic mark
                    tr.addMark(from, from + content.length, italicMark);

                    // Position cursor at the end, outside the mark
                    const endPos = from + content.length;
                    tr.setSelection(TextSelection.create(tr.doc, endPos));

                    // Ensure the mark won't continue
                    tr.removeStoredMark(italicMark);
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        // Note: We intentionally do NOT inherit parent shortcuts (Mod-i)
        // Italic is now controlled by our custom keybinding system in Editor.tsx
        return {
            // Backspace at right edge of italic: enter edit mode
            // Shows "*text" - removes mark, adds left syntax
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Check if we're at the right edge of italic text
                const nodeBefore = $from.nodeBefore;
                if (!nodeBefore?.isText) return false;

                const hasItalicBefore = nodeBefore.marks.some(m => m.type.name === 'italic');
                const nodeAfter = $from.nodeAfter;
                const hasItalicAfter = nodeAfter?.marks?.some(m => m.type.name === 'italic');

                // Only trigger at right edge (italic before, no italic after)
                if (!hasItalicBefore || hasItalicAfter) return false;

                // Only process the immediate nodeBefore, not all italic marks in paragraph
                const italicContent = nodeBefore.text || '';
                const italicStart = $from.pos - nodeBefore.nodeSize;

                // Replace italic mark with "*content" (edit mode)
                const tr = state.tr;
                tr.delete(italicStart, $from.pos);
                tr.insertText('*' + italicContent, italicStart);

                // Position cursor at the end
                const newEndPos = italicStart + 1 + italicContent.length;
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
                serialize: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: false },
            },
        };
    },
});
