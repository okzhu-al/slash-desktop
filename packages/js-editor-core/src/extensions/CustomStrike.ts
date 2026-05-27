/**
 * CustomStrike Extension
 * 
 * Extends TipTap's Strike mark with:
 * - ~~text~~ InputRule that works with preceding characters
 * - Backspace at right edge enters edit mode (shows ~~text)
 * - No extra spaces in serialization
 * - Markdown serialization (~~text~~)
 */

import Strike from '@tiptap/extension-strike';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

// Input rule for ~~text~~ that works with preceding characters
// Also supports Chinese full-width: ～～text～～
const strikeInputRegex = /(?:^|[^~～])([~～][~～]([^~～]+)[~～][~～])$/;

export const CustomStrike = Strike.extend({
    keepOnSplit: false,

    addInputRules() {
        return [
            new InputRule({
                find: strikeInputRegex,
                handler: ({ state, range, match }) => {
                    // Don't apply inside code marks
                    const $from = state.doc.resolve(range.from);
                    if ($from.marks().some(m => m.type.name === 'code')) return;

                    // Don't apply if we're inside unclosed backticks (typing code)
                    const textBefore = state.doc.textBetween($from.start(), range.to);
                    const backtickCount = (textBefore.match(/`/g) || []).length;
                    if (backtickCount % 2 === 1) return; // Odd number = unclosed backtick

                    const content = match[2]; // The text between ~~
                    if (!content) return;

                    const { tr } = state;

                    // Calculate the actual range of ~~text~~
                    const fullMatch = match[0];
                    const hasLeadingChar = fullMatch.length > match[1].length;
                    const from = hasLeadingChar ? range.from + 1 : range.from;
                    const to = range.to;

                    // Create the strike mark
                    const strikeMark = state.schema.marks.strike.create();

                    // Delete the markdown syntax
                    tr.delete(from, to);

                    // Insert the formatted text
                    tr.insertText(content, from);

                    // Apply the strike mark
                    tr.addMark(from, from + content.length, strikeMark);

                    // Position cursor at the end, outside the mark
                    const endPos = from + content.length;
                    tr.setSelection(TextSelection.create(tr.doc, endPos));

                    // Ensure the mark won't continue
                    tr.removeStoredMark(strikeMark);
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        // Note: We intentionally do NOT inherit parent shortcuts
        // Strike is now controlled by our custom keybinding system in Editor.tsx
        return {
            // Backspace at right edge of strike: enter edit mode
            // Shows "~~text" - removes mark, adds left syntax
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Check if we're at the right edge of strike text
                const nodeBefore = $from.nodeBefore;
                if (!nodeBefore?.isText) return false;

                const hasStrikeBefore = nodeBefore.marks.some(m => m.type.name === 'strike');
                const nodeAfter = $from.nodeAfter;
                const hasStrikeAfter = nodeAfter?.marks?.some(m => m.type.name === 'strike');

                // Only trigger at right edge (strike before, no strike after)
                if (!hasStrikeBefore || hasStrikeAfter) return false;

                // Only process the immediate nodeBefore, not all strike marks in paragraph
                const strikeContent = nodeBefore.text || '';
                const strikeStart = $from.pos - nodeBefore.nodeSize;

                // Replace strike mark with "~~content" (edit mode)
                const tr = state.tr;
                tr.delete(strikeStart, $from.pos);
                tr.insertText('~~' + strikeContent, strikeStart);

                // Position cursor at the end
                const newEndPos = strikeStart + 2 + strikeContent.length;
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
                serialize: { open: '~~', close: '~~', expelEnclosingWhitespace: true },
                parse: {
                    // Default strikethrough parsing should work
                },
            },
        };
    },
});
