/**
 * Custom Paragraph extension that preserves empty paragraphs in markdown serialization
 * 
 * The default tiptap-markdown serializer drops empty paragraphs, causing data loss
 * when round-tripping content. This extension adds custom markdown serialization
 * to preserve empty paragraphs by rendering them as blank lines.
 */

import Paragraph from '@tiptap/extension-paragraph';

export const CustomParagraph = Paragraph.extend({
    addStorage() {
        return {
            /**
             * Custom markdown serializer that preserves empty paragraphs
             */
            markdown: {
                serialize(state: any, node: any) {
                    // Check if paragraph has any child nodes
                    // IMPORTANT: Don't use textContent - inline nodes like Math have no text
                    // but should still be serialized
                    const hasContent = node.childCount > 0;

                    if (!hasContent) {
                        // For truly empty paragraphs, add a blank line
                        state.write('\n');
                    } else {
                        // Serialize children normally - this calls render() for each child
                        // including inline nodes like Math
                        state.renderInline(node);
                        state.closeBlock(node);
                    }
                },
                parse: {
                    // Keep default parsing - empty lines should create paragraphs
                }
            }
        };
    },
});

export default CustomParagraph;
