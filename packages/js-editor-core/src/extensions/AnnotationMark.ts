/**
 * AnnotationMark — 批注装饰性 Mark
 * 
 * 纯视觉标记：高亮被批注的文本，不参与 Markdown 序列化。
 * 由 AnnotationPanel 通过 editor.commands 动态添加/移除。
 */

import { Mark, mergeAttributes } from '@tiptap/core';

export const AnnotationMark = Mark.create({
    name: 'annotation',

    // 不自动扩展到相邻文本
    inclusive: false,

    addAttributes() {
        return {
            annotationId: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-annotation-id'),
                renderHTML: (attributes: Record<string, string>) => {
                    if (!attributes.annotationId) return {};
                    return { 'data-annotation-id': attributes.annotationId };
                },
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-annotation-id]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ class: 'annotation-mark' }, HTMLAttributes), 0];
    },
});
