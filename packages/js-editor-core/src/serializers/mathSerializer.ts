/**
 * Math node serializer
 * Handles $latex$ format for inline math
 */

import type { NodeSerializer, MarkdownSerializerState } from './types';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const escapeHtmlAttr = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Serialize math node to $latex$ format
 */
function serialize(state: MarkdownSerializerState, node: ProseMirrorNode): void {
    const latex = node.attrs.latex || '';
    state.write(`$${latex}$`);
}

/**
 * Setup markdown-it to parse $...$ as math nodes
 */
function setupParser(markdownit: any): void {
    // Add inline math rule
    markdownit.inline.ruler.before('escape', 'math_inline', (state: any, silent: boolean) => {
        const start = state.pos;
        const max = state.posMax;

        // Must start with $
        if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;

        // Don't match $$ (block math)
        if (state.src.charCodeAt(start + 1) === 0x24) return false;

        // Find closing $
        let end = start + 1;
        while (end < max) {
            if (state.src.charCodeAt(end) === 0x24 /* $ */) {
                // Found closing $, but make sure it's not escaped
                if (end > start + 1 && state.src.charCodeAt(end - 1) !== 0x5C /* \ */) {
                    break;
                }
            }
            end++;
        }

        // No closing $ found
        if (end >= max) return false;

        // Empty content
        if (end === start + 1) return false;

        if (!silent) {
            const content = state.src.slice(start + 1, end);
            const token = state.push('math_inline', 'span', 0);
            token.content = content;
            token.attrs = [['data-type', 'math'], ['data-latex', content]];
        }

        state.pos = end + 1;
        return true;
    });

    // Render math_inline tokens
    markdownit.renderer.rules.math_inline = (tokens: any[], idx: number) => {
        const token = tokens[idx];
        const latex = token.content;
        return `<span data-type="math" data-latex="${escapeHtmlAttr(latex)}"></span>`;
    };
}

export const mathSerializer: NodeSerializer = {
    name: 'math',
    serialize,
    parse: {
        setup: setupParser,
    },
};
