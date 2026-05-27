/**
 * WikiLink node serializer
 * Handles [[target]] and [[target|label]] formats
 */

import type { NodeSerializer, MarkdownSerializerState } from './types';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Serialize wikiLink node to [[target]] or [[target|label]] format
 */
function serialize(state: MarkdownSerializerState, node: ProseMirrorNode): void {
    const href = node.attrs.href || '';
    const section = node.attrs.section;
    const label = node.attrs.label;

    // Build target: "note" or "note#section"
    const target = section ? `${href}#${section}` : href;

    // Check if label is custom (different from target and href)
    const hasCustomLabel = label && label !== href && label !== target;

    if (hasCustomLabel) {
        state.write(`[[${target}|${label}]]`);
    } else {
        state.write(`[[${target}]]`);
    }
}

/**
 * Setup markdown-it to parse [[...]] as wikiLink nodes
 */
function setupParser(markdownit: any): void {
    // Add inline wikilink rule
    markdownit.inline.ruler.before('link', 'wikilink', (state: any, silent: boolean) => {
        const start = state.pos;
        const max = state.posMax;

        // Must start with [[
        if (state.src.charCodeAt(start) !== 0x5B /* [ */ ||
            state.src.charCodeAt(start + 1) !== 0x5B /* [ */) {
            return false;
        }

        // Check if we're inside inline code (odd number of backticks before current position)
        const textBefore = state.src.slice(0, start);
        const backtickCount = (textBefore.match(/`/g) || []).length;
        if (backtickCount % 2 === 1) {
            // Inside inline code - skip WikiLink parsing
            return false;
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

    // Render wikilink tokens
    markdownit.renderer.rules.wikilink = (tokens: any[], idx: number) => {
        const token = tokens[idx];
        const href = token.attrs.find((a: string[]) => a[0] === 'data-href')?.[1] || '';
        const section = token.attrs.find((a: string[]) => a[0] === 'data-section')?.[1] || '';
        const label = token.attrs.find((a: string[]) => a[0] === 'data-label')?.[1] || '';
        return `<span data-type="wikiLink" data-href="${href}" data-section="${section}" data-label="${label}"></span>`;
    };
}

export const wikiLinkSerializer: NodeSerializer = {
    name: 'wikiLink',
    serialize,
    parse: {
        setup: setupParser,
    },
};
