import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { MathNodeView } from '../components/MathNodeView';

const escapeHtmlAttr = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const MathExtension = Node.create({
    name: 'math',

    group: 'inline',
    inline: true,
    selectable: true,
    atom: true,

    addAttributes() {
        return {
            latex: {
                default: '',
                parseHTML: element => element.getAttribute('data-latex'),
                renderHTML: attributes => ({ 'data-latex': attributes.latex }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-type="math"]' }];
    },

    renderHTML({ HTMLAttributes }) {
        // Note: atom nodes (atom: true) cannot use content hole (0)
        // HTMLAttributes already contains 'data-latex' from addAttributes().renderHTML
        // We only need to add data-type for parseHTML matching
        return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'math' })];
    },

    addNodeView() {
        return ReactNodeViewRenderer(MathNodeView);
    },

    addInputRules() {
        return [
            new InputRule({
                // Match $content$ preceded by any character except $
                find: /(?:^|[^$])\$([^$]+)\$/,
                handler: ({ state, range, match }) => {
                    const { tr } = state;
                    const fullMatch = match[0];
                    const content = match[1];
                    if (content) {
                        // Check if there's a leading char before the first $
                        // match[0] = "x$content$" or "$content$"
                        // match[1] = "content"
                        const hasLeadingChar = fullMatch.length > content.length + 2; // 2 = $$

                        // Start from after the leading char if present
                        const start = hasLeadingChar ? range.from + 1 : range.from;

                        tr.replaceWith(start, range.to, this.type.create({ latex: content }));
                    }
                },
            }),
        ];
    },

    // Markdown serialization for tiptap-markdown
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const latex = node.attrs.latex || '';
                    state.write('$' + latex + '$');
                },
                parse: {
                    setup(markdownit: any) {
                        // Add inline math parsing to markdown-it
                        markdownit.inline.ruler.before('emphasis', 'math_inline', (state: any, silent: boolean) => {
                            const start = state.pos;
                            const marker = state.src.charCodeAt(start);

                            // Only match single $ (not $$)
                            if (marker !== 0x24 /* $ */) return false;
                            if (state.src.charCodeAt(start + 1) === 0x24) return false;

                            // Find closing $
                            let end = start + 1;
                            while (end < state.src.length) {
                                if (state.src.charCodeAt(end) === 0x24) {
                                    break;
                                }
                                end++;
                            }

                            if (end >= state.src.length) return false;

                            const content = state.src.slice(start + 1, end);
                            if (!content) return false;

                            if (!silent) {
                                const token = state.push('math_inline', 'span', 0);
                                token.content = content;
                                token.markup = '$';
                                token.attrSet('data-type', 'math');
                                token.attrSet('data-latex', content);
                            }

                            state.pos = end + 1;
                            return true;
                        });

                        // Render the math token as a span with data attributes
                        markdownit.renderer.rules.math_inline = (tokens: any, idx: any) => {
                            const token = tokens[idx];
                            const latex = token.content;
                            return `<span data-type="math" data-latex="${escapeHtmlAttr(latex)}"></span>`;
                        };
                    },
                },
            },
        };
    },

    // Backspace to edit: convert Math node to $latex text (without closing $)
    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                // Only handle when cursor is at a position (no selection)
                if (!empty) return false;

                // Get the node directly before the cursor position
                const nodeBefore = $from.nodeBefore;

                // Only handle if the node before cursor is a math node
                if (nodeBefore?.type.name !== 'math') {
                    return false;
                }

                // Get the Math attributes
                const { latex } = nodeBefore.attrs;

                // Build the text representation WITHOUT closing $
                // This allows editing without triggering the InputRule
                const text = `$${latex}`;

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
});
