/**
 * Markdown Bridge - Unified serialization configuration
 * Integrates all custom serializers with tiptap-markdown
 */

import { Markdown } from 'tiptap-markdown';
import { defaultMarkdownSerializer } from 'prosemirror-markdown';
import {
    wikiLinkSerializer,
} from '@slash/editor-core';




/**
 * Create configured Markdown extension with all serializers
 * 
 * Note: math, video, audio, image, mermaid have serializers defined in their
 * respective extensions via addStorage().
 * 
 * Chip nodes (dateChip, userChip, priorityChip) have their own serializers
 * and parse.setup methods defined in their respective extensions.
 */
export function createMarkdownExtension() {
    return Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
        breaks: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        // IMPORTANT: Disable built-in link extension - we use CustomLink instead
        // The Markdown extension internally adds Link extension, must explicitly disable
        link: { enabled: false },

        // Register serializers
        serializers: {
            nodes: {
                // CRITICAL: paragraph must use prosemirror-markdown's serializer
                // to properly call renderInline() for inline children like Math
                paragraph: defaultMarkdownSerializer.nodes.paragraph,
                hardBreak(state: any) {
                    state.write(state.inTable ? '<br>' : '\\\n');
                },
                wikiLink: wikiLinkSerializer.serialize,
                bulletList(state: any, node: any, parent: any, index: number) {
                    const isTopLevel = !state.listDepth || state.listDepth === 0;
                    if (isTopLevel && state.lastListType && state.lastListType !== 'bulletList') {
                        state.ensureNewLine();
                        state.write('\n');
                    }
                    if (isTopLevel) {
                        state.lastListType = 'bulletList';
                    }
                    defaultMarkdownSerializer.nodes.bulletList(state, node, parent, index);
                },
                orderedList(state: any, node: any, parent: any, index: number) {
                    const isTopLevel = !state.listDepth || state.listDepth === 0;
                    if (isTopLevel && state.lastListType && state.lastListType !== 'orderedList') {
                        state.ensureNewLine();
                        state.write('\n');
                    }
                    if (isTopLevel) {
                        state.lastListType = 'orderedList';
                    }
                    defaultMarkdownSerializer.nodes.orderedList(state, node, parent, index);
                },
                listItem(state: any, node: any, parent: any, index: number) {
                    state.listDepth = (state.listDepth || 0) + 1;
                    defaultMarkdownSerializer.nodes.listItem(state, node, parent, index);
                    state.listDepth--;
                },
                taskList(state: any, node: any) {
                    const delim = '  ';
                    const nonEmptyChildren: any[] = [];
                    node.forEach((child: any) => {
                        const firstChild = child.firstChild;
                        const hasText = firstChild && firstChild.textContent.trim().length > 0;
                        const hasNestedBlocks = child.childCount > 1;
                        if (hasText || hasNestedBlocks) {
                            nonEmptyChildren.push(child);
                        }
                    });
                    nonEmptyChildren.forEach((child: any, i: number) => {
                        if (i && state.inTightList) state.flushClose(1);
                        state.wrapBlock(delim, '* ', node, () => state.render(child, node, i));
                    });
                },
                taskItem(state: any, node: any) {
                    const checked = node.attrs.checked;
                    state.write(checked ? '[x] ' : '[ ] ');
                    const firstChild = node.firstChild;
                    if (firstChild && firstChild.type.name === 'paragraph') {
                        state.renderInline(firstChild);
                    }
                    state.ensureNewLine();
                    for (let i = 1; i < node.childCount; i++) {
                        const child = node.child(i);
                        state.render(child, node, i);
                    }
                },
            },

            marks: {
                // Use default code mark serializer from prosemirror-markdown
                code: defaultMarkdownSerializer.marks.code,
                // CJK punctuation fix: disable expelEnclosingWhitespace for bold/italic/highlight
                // tiptap-markdown's CommonMark flanking rules don't work well with CJK punctuation
                bold: { open: '**', close: '**', mixable: true },
                strong: { open: '**', close: '**', mixable: true },
                italic: { open: '*', close: '*', mixable: true },
                em: { open: '*', close: '*', mixable: true },
                highlight: { open: '==', close: '==' },
            },
        },
    } as any);
}
