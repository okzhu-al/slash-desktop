/**
 * CustomHeading Extension
 * 
 * Extends TipTap's Heading with:
 * - Backspace at heading start enters edit mode (shows # prefix)
 * - Enter after # prefix renders as corresponding heading level
 * - Supports # through ###### (levels 1-6)
 * - Prevents heading creation inside table cells (which can't be serialized properly)
 */

import Heading from '@tiptap/extension-heading';
import { TextSelection, Plugin } from '@tiptap/pm/state';
import { textblockTypeInputRule } from '@tiptap/core';

/**
 * Check if a position is inside a table cell
 */
function isInTableCell($pos: any): boolean {
    for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
            return true;
        }
    }
    return false;
}

/**
 * 模块级共享状态：compositionend 设置，appendTransaction 读取
 * 避免通过 TipTap 的 view Proxy 传递（Proxy 在 mount 前会抛错）
 */
export const headingCompositionState: {
    fixData: string | null;
    _inHeading: boolean;
    _scrollEl: HTMLElement | null;
    _savedScroll: number;
    _headingPos: number;        // heading node 的文档位置
    _headingContentSize: number; // composition 前 heading 的内容长度
} = { fixData: null, _inHeading: false, _scrollEl: null, _savedScroll: 0, _headingPos: 0, _headingContentSize: 0 };

export const CustomHeading = Heading.extend({
    addInputRules() {
        // 使用单条 InputRule（与 TipTap 默认行为一致）
        const rule = textblockTypeInputRule({
            find: /^(#{1,6})\s$/,
            type: this.type,
            getAttributes: (match: RegExpMatchArray) => ({
                level: match[1].length,
            }),
        });

        // 包装 handler：(1) 阻止在表格内创建标题 (2) 防止滚动跳跃
        const originalHandler = rule.handler;
        const editorRef = this.editor;
        (rule as any).handler = (props: any) => {
            const { state, range } = props;
            const $from = state.doc.resolve(range.from);
            if (isInTableCell($from)) return null;

            // 找到实际的滚动容器（向上遍历 DOM 找 overflow-y: auto/scroll）
            let scrollEl: HTMLElement | null = editorRef?.view?.dom?.parentElement ?? null;
            while (scrollEl) {
                const ov = getComputedStyle(scrollEl).overflowY;
                if (ov === 'auto' || ov === 'scroll') break;
                scrollEl = scrollEl.parentElement;
            }
            const savedScroll = scrollEl?.scrollTop ?? 0;

            const result = originalHandler(props);

            // 恢复滚动位置
            if (scrollEl) {
                requestAnimationFrame(() => {
                    scrollEl!.scrollTop = savedScroll;
                });
            }

            return result;
        };

        return [rule];
    },

    addKeyboardShortcuts() {
        return {
            ...this.parent?.(),

            // Backspace at start of heading: enter edit mode
            // Shows "## Heading Text" - converts heading to paragraph with # prefix
            Backspace: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from, empty } = selection;

                if (!empty) return false;

                // Check if we're at the start of a heading node
                const node = $from.parent;
                if (node.type.name !== 'heading') return false;

                // Check if cursor is at the very beginning of the heading
                const isAtStart = $from.parentOffset === 0;
                if (!isAtStart) return false;

                // Get heading level and content
                const level = node.attrs.level as number;
                const headingContent = node.textContent;
                const prefix = '#'.repeat(level) + ' ';

                // Get the position of the heading node
                const headingStart = $from.before();
                const headingEnd = $from.after();

                // Replace heading with paragraph containing "# prefix + content"
                const tr = state.tr;

                // Delete the heading
                tr.delete(headingStart, headingEnd);

                // Insert paragraph with # prefix
                const paragraphNode = state.schema.nodes.paragraph.create(
                    null,
                    state.schema.text(prefix + headingContent)
                );
                tr.insert(headingStart, paragraphNode);

                // Position cursor at the end of the # prefix (before content)
                tr.setSelection(TextSelection.create(tr.doc, headingStart + 1 + prefix.length));

                view.dispatch(tr);
                return true;
            },

            // Enter: check if line starts with # and convert to heading
            Enter: () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $from } = selection;

                // Don't convert to heading inside table cells
                if (isInTableCell($from)) {
                    return false;
                }

                // Only handle in paragraphs (not in headings)
                const node = $from.parent;
                if (node.type.name !== 'paragraph') return false;

                // Get the text content
                const text = node.textContent;

                // Check if starts with # pattern
                const headingMatch = text.match(/^(#{1,6})\s+(.*)$/);
                if (!headingMatch) return false;

                const [, hashes, content] = headingMatch;
                const level = hashes.length;

                // Get paragraph position
                const paragraphStart = $from.before();
                const paragraphEnd = $from.after();

                // Replace paragraph with heading
                const tr = state.tr;
                tr.delete(paragraphStart, paragraphEnd);

                // Create heading node
                const headingNode = state.schema.nodes.heading.create(
                    { level },
                    content ? state.schema.text(content) : null
                );
                tr.insert(paragraphStart, headingNode);

                // Position cursor at end of heading
                tr.setSelection(TextSelection.create(
                    tr.doc,
                    paragraphStart + 1 + (content?.length || 0)
                ));

                view.dispatch(tr);
                return true;
            },
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                appendTransaction: (_transactions, _oldState, newState) => {
                    const composedText = headingCompositionState.fixData;
                    if (!composedText) return null;
                    headingCompositionState.fixData = null;

                    let tr: any = null;
                    newState.doc.forEach((node: any, offset: number, index: number) => {
                        if (tr) return;
                        if (node.type.name !== 'heading') return;
                        if (index + 1 >= newState.doc.childCount) return;

                        const nextNode = newState.doc.child(index + 1);
                        if (nextNode.type.name !== 'paragraph') return;
                        if (nextNode.textContent !== composedText) return;

                        tr = newState.tr;
                        const headingStart = offset + 1;
                        const headingEnd = offset + node.nodeSize - 1;
                        const paraStart = offset + node.nodeSize;
                        const paraEnd = paraStart + nextNode.nodeSize;

                        tr.delete(paraStart, paraEnd);
                        if (headingEnd > headingStart) {
                            tr.replaceWith(headingStart, headingEnd, newState.schema.text(composedText));
                        } else {
                            tr.insertText(composedText, headingStart);
                        }
                        const cursorPos = headingStart + composedText.length;
                        tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                    });

                    return tr;
                },
            }),
        ];
    },
});
