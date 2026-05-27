/**
 * Serializer types for tiptap-markdown integration
 * Each custom node must implement this interface for proper roundtrip
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * MarkdownSerializerState from prosemirror-markdown
 * Used by tiptap-markdown for serialization
 */
export interface MarkdownSerializerState {
    write(content: string): void;
    text(text: string, escape?: boolean): void;
    render(node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void;
    renderContent(parent: ProseMirrorNode): void;
    renderInline(parent: ProseMirrorNode): void;
    closeBlock(node: ProseMirrorNode): void;
    ensureNewLine(): void;
}

/**
 * Node serializer configuration
 * serialize: ProseMirror node → Markdown string
 * parse: Markdown string → ProseMirror node (via markdown-it plugin)
 */
export interface NodeSerializer {
    /** Node type name (must match TipTap extension name) */
    name: string;

    /** Serialize ProseMirror node to Markdown */
    serialize: (state: MarkdownSerializerState, node: ProseMirrorNode) => void;

    /** Parse configuration for markdown-it */
    parse?: {
        /** Setup markdown-it plugin to recognize this node's syntax */
        setup: (markdownit: any) => void;
    };
}

/**
 * Collection of all node serializers
 */
export interface SerializerRegistry {
    nodes: Record<string, NodeSerializer['serialize']>;
}
