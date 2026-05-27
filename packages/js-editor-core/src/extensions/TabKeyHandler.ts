import { Extension } from '@tiptap/core';

/**
 * Tab Key Extension
 *
 * Handles Tab and Shift+Tab in the editor:
 * - In non-list contexts: Insert tab character (or 2 spaces)
 * - In list contexts: Handled by MixedListKeymap (indent/outdent)
 * - Prevents browser focus navigation
 */
export const TabKeyHandler = Extension.create({
    name: 'tabKeyHandler',

    // High priority to run before other extensions that might intercept Tab
    priority: 1000,

    addKeyboardShortcuts() {
        return {
            Tab: ({ editor }) => {
                // Check if we're in a table - let table extension handle it
                if (editor.isActive('table')) {
                    return false;
                }

                // Check if we're in a list item - let list extensions handle it
                if (editor.isActive('listItem') || editor.isActive('taskItem')) {
                    return false;
                }

                const { state, view } = editor;
                const { from } = state.selection;

                // Determine what to insert
                const insertText = editor.isActive('codeBlock') ? '\t' : '  ';

                // Use ProseMirror transaction directly for reliable text insertion
                const tr = state.tr.insertText(insertText, from);
                view.dispatch(tr);

                return true;
            },

            'Shift-Tab': ({ editor }) => {
                // Check if we're in a table - let table extension handle it
                if (editor.isActive('table')) {
                    return false;
                }

                // In non-list contexts, just prevent focus jump
                if (!editor.isActive('listItem') && !editor.isActive('taskItem')) {
                    return true; // Consume the event, do nothing
                }
                // Let list handlers deal with outdent
                return false;
            },
        };
    },
});
