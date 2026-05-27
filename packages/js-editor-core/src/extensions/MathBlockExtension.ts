import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { MathBlockNodeView } from '../components/MathBlockNodeView';

export const MathBlockExtension = Node.create({
    name: 'mathBlock',

    group: 'block',
    content: '',
    inline: false,
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
        return [{ tag: 'div[data-type="mathBlock"]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mathBlock' })];
    },

    addNodeView() {
        return ReactNodeViewRenderer(MathBlockNodeView);
    },

    addInputRules() {
        return [
            // Match $$ followed by a space at the start of a block
            new InputRule({
                find: /^\$\$\s$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .insertContent({ type: 'mathBlock', attrs: { latex: '' } })
                        .run();
                },
            }),
            // Match $$ $$ at the start of a block
            new InputRule({
                find: /^\$\$\s\$\$$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .insertContent({ type: 'mathBlock', attrs: { latex: '' } })
                        .run();
                },
            }),
        ];
    },

    // Markdown serialization and parsing for tiptap-markdown
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const latex = node.attrs.latex || '';
                    state.write('$$\n' + latex + '\n$$');
                    state.closeBlock(node);
                },
                parse: {
                    setup(markdownit: any) {
                        // Register block math ruler before fence
                        markdownit.block.ruler.before('fence', 'math_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
                            let pos = state.bMarks[startLine] + state.tShift[startLine];
                            let max = state.eMarks[startLine];

                            // Must start with $$
                            if (pos + 2 > max) return false;
                            if (state.src.slice(pos, pos + 2) !== '$$') return false;

                            if (silent) return true;

                            // Find closing $$
                            let nextLine = startLine;
                            let found = false;
                            let content = '';

                            // Case 1: Single line block formula like $$latex$$
                            const firstLineText = state.src.slice(pos + 2, max);
                            if (firstLineText.endsWith('$$') && firstLineText.length >= 2) {
                                content = firstLineText.slice(0, -2);
                                found = true;
                            } else {
                                // Case 2: Multi-line block formula
                                while (nextLine < endLine) {
                                    nextLine++;
                                    if (nextLine >= endLine) break;
                                    pos = state.bMarks[nextLine] + state.tShift[nextLine];
                                    max = state.eMarks[nextLine];
                                    
                                    const lineText = state.src.slice(pos, max).trim();
                                    if (lineText === '$$') {
                                        found = true;
                                        break;
                                    }
                                }
                            }

                            if (!found) return false;

                            // Extract content between startLine and nextLine
                            if (nextLine > startLine) {
                                const startPos = state.bMarks[startLine] + state.tShift[startLine] + 2; // skip $$
                                const endPos = state.bMarks[nextLine] + state.tShift[nextLine];
                                content = state.src.slice(startPos, endPos).trim();
                            }

                            state.line = nextLine + 1;

                            const token = state.push('math_block', 'div', 0);
                            token.block = true;
                            token.content = content;
                            token.markup = '$$';
                            token.map = [startLine, state.line];
                            token.attrSet('data-type', 'mathBlock');
                            token.attrSet('data-latex', content);

                            return true;
                        });

                        // Render mathBlock tokens
                        markdownit.renderer.rules.math_block = (tokens: any[], idx: number) => {
                            const token = tokens[idx];
                            const latex = token.content;
                            return `<div data-type="mathBlock" data-latex="${latex}"></div>`;
                        };
                    },
                },
            },
        };
    },

    // Backspace to edit: convert MathBlock node to a paragraph containing $$latex$$
    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Get node before cursor
                const nodeBefore = $from.nodeBefore;

                if (nodeBefore?.type.name !== 'mathBlock') {
                    return false;
                }

                const { latex } = nodeBefore.attrs;
                const text = `$$${latex}$$`;
                const nodePos = $from.pos - nodeBefore.nodeSize;

                // Replace mathBlock node with a normal paragraph containing $$latex$$
                const newParagraph = state.schema.nodes.paragraph.create(
                    null,
                    state.schema.text(text)
                );

                const tr = state.tr.replaceWith(nodePos, $from.pos, newParagraph);
                
                // Position cursor at the end of the text, inside the paragraph
                // nodePos is the start of paragraph. 
                // nodePos + 1 skips paragraph opening token.
                // We add the text length to reach the end of the text.
                tr.setSelection(TextSelection.create(tr.doc, nodePos + 1 + text.length));

                view.dispatch(tr);
                return true;
            },
        };
    },
});
