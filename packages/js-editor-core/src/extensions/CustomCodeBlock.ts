/**
 * Custom CodeBlock extension with React NodeView and Backspace handling
 * - Limited language options
 */

import { ReactNodeViewRenderer } from '@tiptap/react';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
// Using EditorDI component injection for CodeBlockComponent
import { TextSelection } from '@tiptap/pm/state';

// Essential frontend/backend languages only
export const SUPPORTED_LANGUAGES = [
    'javascript',
    'typescript',
    'html',
    'css',
    'json',
    'python',
    'rust',
    'go',
    'java',
    'swift',
    'c',
    'php',
    'ruby',
    'sql',
    'shell',
    'yaml',
    'mermaid',
];

import { CodeBlockLowlightOptions } from '@tiptap/extension-code-block-lowlight';

export interface CustomCodeBlockOptions extends Partial<CodeBlockLowlightOptions> {
    CodeBlockComponent?: any;
}

export const CustomCodeBlock = CodeBlockLowlight.extend<CustomCodeBlockOptions>({
    addOptions() {
        return {
            ...this.parent?.(),
            CodeBlockComponent: null, // to be injected via editor setup
        }
    },

    addNodeView() {
        return ReactNodeViewRenderer(this.options.CodeBlockComponent, {
            className: 'code-block-wrapper my-4 relative',
        });
    },
    // Use default InputRules from CodeBlockLowlight
    // (```language + Enter creates code block)

    addKeyboardShortcuts() {
        return {
            ...this.parent?.(),

            // Backspace at position 0 of a completely empty code block → convert to paragraph
            // This only handles the "created a code block by accident" case.
            // Normal Backspace behavior (deleting empty lines, etc.) is handled by ProseMirror defaults.
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                const node = $from.parent;
                if (node.type.name !== 'codeBlock') return false;

                const isAtStart = $from.parentOffset === 0;
                if (!isAtStart) return false;

                // Only convert when the entire code block is empty
                if (node.textContent.length !== 0) return false;

                const codeBlockPos = $from.before($from.depth);
                const tr = state.tr.replaceWith(
                    codeBlockPos,
                    codeBlockPos + node.nodeSize,
                    state.schema.nodes.paragraph.create()
                );
                tr.setSelection(TextSelection.create(tr.doc, codeBlockPos + 1));
                view.dispatch(tr);
                return true;
            },
        };
    },
});
