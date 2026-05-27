/**
 * SelectionHighlight Extension
 * 
 * 用 CSS Custom Highlight API 替代浏览器原生 ::selection 高亮。
 * 
 * 原因：
 * 1. WebKit 的 ::selection 只画字体 metrics 高度，不覆盖 line-height。
 * 2. Decoration.inline 会插入 <span>，拆断文本节点导致 kerning/ligature 变化，
 *    引起选中时文字水平抖动。
 * 3. CSS Highlight API 不修改 DOM，零抖动，完美覆盖 line-height。
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const selectionHighlightKey = new PluginKey('selectionHighlight');
const HIGHLIGHT_NAME = 'editor-selection';

function hasHighlightAPI(): boolean {
    return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function updateHighlight(view: EditorView) {
    if (!hasHighlightAPI()) return;

    const { from, to, empty } = view.state.selection;
    const highlight = new (globalThis as any).Highlight();

    if (!empty && from !== to) {
        try {
            const startDOM = view.domAtPos(from);
            const endDOM = view.domAtPos(to);
            const range = document.createRange();
            range.setStart(startDOM.node, startDOM.offset);
            range.setEnd(endDOM.node, endDOM.offset);
            highlight.add(range);
        } catch {
            // Positions might be invalid during rapid edits
        }
    }

    (CSS as any).highlights.set(HIGHLIGHT_NAME, highlight);
}

export const SelectionHighlight = Extension.create({
    name: 'selectionHighlight',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: selectionHighlightKey,
                view(editorView) {
                    // Initial highlight
                    if (hasHighlightAPI()) {
                        (CSS as any).highlights.set(HIGHLIGHT_NAME, new (globalThis as any).Highlight());
                    }
                    updateHighlight(editorView);
                    return {
                        update(view) {
                            updateHighlight(view);
                        },
                        destroy() {
                            if (hasHighlightAPI()) {
                                (CSS as any).highlights.delete(HIGHLIGHT_NAME);
                            }
                        },
                    };
                },
            }),
        ];
    },
});
