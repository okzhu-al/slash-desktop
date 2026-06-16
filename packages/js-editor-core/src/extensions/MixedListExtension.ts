import { ListItem } from '@tiptap/extension-list-item';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { TextSelection, Selection, Plugin, PluginKey } from '@tiptap/pm/state';
import { mergeAttributes, InputRule, Extension, Editor } from '@tiptap/core';
// Import task styles
import './Task/TaskItemStyles.css';

/**
 * 尝试手动提升嵌套列表项
 * 针对混合嵌套列表场景，代替 TipTap 有 Bug 的 liftListItem，
 * 实现真正的“拆分父列表项并将自身转化为对应的父同级 sibling 节点”。
 */
function safeLiftListItem(editor: Editor, itemDepth: number, itemType: string): boolean {
    const { state } = editor;
    const { tr } = state;
    const { $from } = tr.selection;

    let parentItemDepth = -1;
    for (let d = itemDepth - 1; d >= 0; d--) {
        const typeName = $from.node(d).type.name;
        if (typeName === 'listItem' || typeName === 'taskItem') {
            parentItemDepth = d;
            break;
        }
    }

    // 1. 如果已经是顶层列表，直接执行原生 liftListItem (降级为普通段落)
    if (parentItemDepth < 0) {
        return editor.commands.liftListItem(itemType);
    }

    const parentItemType = $from.node(parentItemDepth).type.name;

    // 2. 如果类型一致，直接执行原生 liftListItem
    if (parentItemType === itemType) {
        return editor.commands.liftListItem(itemType);
    }

    // 3. 异构节点转换提升：
    // 通过在同一步骤中原子替换原父项，实现高可靠性的类型转换和位置提升，从而彻底避免 Schema 冲突或 Gap 错误。
    const subListDepth = itemDepth - 1;

    return editor.chain()
        .command(({ tr: chainTr, state: chainState }) => {
            const schema = chainState.schema;
            const $pos = chainTr.doc.resolve($from.pos);
            const subListNode = $pos.node(subListDepth);
            const itemNode = $pos.node(itemDepth);
            const itemIndex = $pos.index(subListDepth);
            
            // 3.1 构建被提升后的新列表项的内容，其类型转换为 parentItemType
            const targetNodeType = schema.nodes[parentItemType];
            const newAttrs = parentItemType === 'taskItem' ? { checked: false } : null;
            
            const newContent: any[] = [];
            // 放入 itemNode 内部的非列表节点（比如它的段落，也就是第一个子节点）
            if (itemNode.firstChild) {
                newContent.push(itemNode.firstChild);
            }
            
            // 如果在它后面还有兄弟节点，将它们包装为原来的子列表类型，嵌套在新项中
            if (itemIndex < subListNode.childCount - 1) {
                const followingItems: any[] = [];
                subListNode.forEach((child, _offset, index) => {
                    if (index > itemIndex) {
                        followingItems.push(child);
                    }
                });
                const subListType = subListNode.type;
                newContent.push(subListType.create(subListNode.attrs, followingItems));
            }
            
            const newLiftedItem = targetNodeType.create(newAttrs, newContent);
            
            // 3.2 获取原父项的起始与结束位置
            const parentItemStart = $pos.before(parentItemDepth);
            const parentItemEnd = $pos.after(parentItemDepth);
            const parentItemNode = $pos.node(parentItemDepth);
            
            // 3.3 构造新的父列表项内容
            const newParentContent: any[] = [];
            newParentContent.push(parentItemNode.firstChild); // 放入父列表项原有的非列表节点（段落）
            
            // 如果前面有保留的二级项：
            if (itemIndex > 0) {
                const prevItems: any[] = [];
                subListNode.forEach((child, _offset, index) => {
                    if (index < itemIndex) {
                        prevItems.push(child);
                    }
                });
                newParentContent.push(subListNode.type.create(subListNode.attrs, prevItems));
            }
            
            const newParentItem = parentItemNode.type.create(parentItemNode.attrs, newParentContent);
            
            // 3.4 原子替换整个父列表项范围
            chainTr.replaceWith(parentItemStart, parentItemEnd, [newParentItem, newLiftedItem]);
            
            // 3.5 精确重置选区光标到新提升项的段落内部
            const newLiftedItemStart = parentItemStart + newParentItem.nodeSize;
            const $resolvedStart = chainTr.doc.resolve(newLiftedItemStart);
            chainTr.setSelection(Selection.near($resolvedStart));
            
            return true;
        })
        .run();
}

function findNearestListItemType($pos: any): 'listItem' | 'taskItem' | null {
    for (let depth = $pos.depth; depth >= 0; depth--) {
        const typeName = $pos.node(depth).type.name;
        if (typeName === 'listItem' || typeName === 'taskItem') {
            return typeName;
        }
    }
    return null;
}


/**
 * 自定义 ListItem 扩展 - 支持混合嵌套列表
 * 允许在 listItem 下嵌套 bulletList、orderedList 和 taskList
 */
export const MixedListItem = ListItem.extend({
    // 允许嵌套任意块级内容（包括所有类型的列表）
    content: 'paragraph block*',

    addKeyboardShortcuts() {
        return {
            ...this.parent?.(),
            Tab: () => {
                const { $from } = this.editor.state.selection;
                if (findNearestListItemType($from) !== this.name) return false;
                return this.editor.commands.sinkListItem(this.name);
            },
            'Shift-Tab': () => {
                const { $from } = this.editor.state.selection;
                if (findNearestListItemType($from) !== this.name) return false;
                return this.editor.commands.liftListItem(this.name);
            },
            Backspace: () => {
                const { state } = this.editor;
                const { selection } = state;
                const { empty, $from } = selection;

                // 1. 必须是光标空选状态
                if (!empty) return false;

                // 2. 找到 listItem 所在的深度
                let listItemDepth = -1;
                for (let d = $from.depth; d >= 0; d--) {
                    if ($from.node(d).type.name === this.name) {
                        listItemDepth = d;
                        break;
                    }
                }
                if (listItemDepth < 0) return false;

                // 核心安全加固：严格限制直接子节点校验，防止外层处理器拦截嵌套深层的退格事件
                if ($from.depth !== listItemDepth + 1) {
                    return false; // 放行给内层处理器或默认 keymap
                }

                const listItem = $from.node(listItemDepth);
                const paraIndex = $from.index(listItemDepth);

                const isAtLineStart = $from.parentOffset === 0;
                const isFirstChild = paraIndex === 0;
                const isParaEmpty = $from.parent.content.size === 0;

                // 3. 空段落退格
                if (isParaEmpty) {
                    // 多子节点列表项的内部空段落处理
                    if (listItem.childCount > 1) {
                        // 非首段的空段落：直接删除该段落，并将光标安全移至上一兄弟节点末尾
                        if (paraIndex > 0) {
                            const { tr } = state;
                            const paraStart = $from.before($from.depth);
                            const paraEnd = $from.after($from.depth);
                            tr.delete(paraStart, paraEnd);
                            
                            const prevEnd = paraStart;
                            tr.setSelection(TextSelection.create(tr.doc, prevEnd - 1));
                            this.editor.view.dispatch(tr);
                            return true; // 确保 dispatch 后返回 true，防止二次事件冒泡
                        }
                    }

                    // 单子节点且全空的列表项：直接安全提升
                    return safeLiftListItem(this.editor, listItemDepth, 'listItem');
                }

                // 4. 非空但光标处于行首且为首段，按 Backspace 安全提升
                if (isAtLineStart && isFirstChild) {
                    return safeLiftListItem(this.editor, listItemDepth, 'listItem');
                }

                return false;
            },
            Enter: () => {
                const { state, view } = this.editor;
                const { selection, schema } = state;
                const { $from, empty } = selection;

                // 1. 对于范围选择，先删除（避免交给默认导致 crash）
                let tr = state.tr;
                let $pos = $from;
                if (!empty) {
                    tr = tr.deleteSelection();
                    $pos = tr.selection.$from;
                }

                const paragraph = $pos.parent;
                if (paragraph.type.name !== 'paragraph') return false;

                // Find the nearest ListItem ancestor
                let listItemDepth = -1;
                for (let d = $pos.depth; d >= 0; d--) {
                    if ($pos.node(d).type.name === this.name) {
                        listItemDepth = d;
                        break;
                    }
                }
                
                // ONLY handle splitting if the paragraph is a DIRECT child of the listItem!
                // If there's a nested taskList in between, letting the child taskItem handle its own split first.
                if (listItemDepth < 0 || listItemDepth !== $pos.depth - 1) return false;

                const listItem = $pos.node(listItemDepth);

                // 如果是空列表项（且没有嵌套子块），采用手动安全提升
                if (listItem.childCount === 1 && listItem.firstChild?.content.size === 0) {
                     return safeLiftListItem(this.editor, listItemDepth, 'listItem');
                }

                // Get positions
                const listItemStart = $pos.before(listItemDepth);
                const listItemEnd = $pos.after(listItemDepth);
                const cursorOffset = $pos.parentOffset;
                const paragraphIndex = $pos.index(listItemDepth);

                const firstContent: any[] = [];
                listItem.forEach((child, _offset, index) => {
                    if (index < paragraphIndex) {
                        firstContent.push(child);
                    } else if (index === paragraphIndex) {
                        const contentBefore = child.cut(0, cursorOffset);
                        firstContent.push(schema.nodes.paragraph.create(null, contentBefore.content));
                    }
                });

                const secondContent: any[] = [];
                listItem.forEach((child, _offset, index) => {
                    if (index === paragraphIndex) {
                        const contentAfter = child.cut(cursorOffset);
                        secondContent.push(schema.nodes.paragraph.create(null, contentAfter.content));
                    } else if (index > paragraphIndex) {
                        secondContent.push(child);
                    }
                });

                const firstListItem = schema.nodes.listItem.create(
                    null,
                    firstContent.length > 0 ? firstContent : schema.nodes.paragraph.create()
                );
                const secondListItem = schema.nodes.listItem.create(
                    null,
                    secondContent.length > 0 ? secondContent : schema.nodes.paragraph.create()
                );

                tr.replaceWith(listItemStart, listItemEnd, [firstListItem, secondListItem]);

                // 定位光标到第二个列表项内部段落的开头
                const newCursorPos = tr.mapping.map(listItemStart) + firstListItem.nodeSize + 2;
                tr.setSelection(TextSelection.create(tr.doc, newCursorPos));

                view.dispatch(tr);
                return true;
            },
        };
    },
});

/**
 * 自定义 TaskList 序列化器
 * BUG-02 fix: 在 taskList 层级过滤空 taskItem，避免 renderList 为空项写入 '- ' 前缀和分隔换行
 */
export const MixedTaskList = TaskList.extend({
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    // Filter out empty taskItem children before rendering
                    // An empty taskItem has at most 1 child (paragraph) with no text and no nested blocks
                    const nonEmptyChildren: any[] = [];
                    node.forEach((child: any) => {
                        const firstChild = child.firstChild;
                        const hasText = firstChild && firstChild.textContent.trim().length > 0;
                        const hasNestedBlocks = child.childCount > 1;
                        if (hasText || hasNestedBlocks) {
                            nonEmptyChildren.push(child);
                        }
                    });

                    // Manually implement renderList with only non-empty children
                    // This avoids wrapBlock writing '* ' prefix for empty items
                    const delim = '  ';
                    nonEmptyChildren.forEach((child: any, i: number) => {
                        if (i && state.inTightList) state.flushClose(1);
                        state.wrapBlock(delim, '* ', node, () => state.render(child, node, i));
                    });
                },
            },
        };
    },
});

/**
 * 自定义 TaskItem 扩展 - 支持混合嵌套 + 内联 Chip 节点
 * 
 * 内容允许包含 DateChip, UserChip, PriorityChip 等内联节点
 * 
 * Markdown 格式:
 * - [ ] Task content 📅2026-01-24 @Junior #High
 */
export const MixedTaskItem = TaskItem.extend({
    // 允许嵌套任意块级内容（包括所有类型的列表）
    content: 'paragraph block*',

    addAttributes() {
        return {
            checked: {
                default: false,
                keepOnSplit: false,
                parseHTML: element => {
                    // Check data-checked attribute first (used by tiptap-markdown)
                    const dataChecked = element.getAttribute('data-checked');
                    if (dataChecked !== null) {
                        return dataChecked === 'true' || dataChecked === '';
                    }
                    // Fall back to checkbox checked attribute
                    const checkbox = element.querySelector('input[type="checkbox"]');
                    return checkbox?.hasAttribute('checked') ?? false;
                },
                renderHTML: attributes => ({
                    'data-checked': attributes.checked,
                }),
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'li[data-type="taskItem"]',
                priority: 100, // 高优先级确保命中
                contentElement: (element) => {
                    if (!(element instanceof HTMLElement)) return element;

                    return (
                        element.querySelector('.slash-task-content [data-node-view-content-react]') ||
                        element.querySelector('.slash-task-content') ||
                        element.querySelector('div:not([contenteditable="false"])') ||
                        element
                    );
                },
            },
        ];
    },

    // Custom markdown serialization to handle 'paragraph block*' content model
    // Serializes the first paragraph inline, then renders nested sub-lists
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    // Write checkbox marker only (no bullet - taskList handles that)
                    const checked = node.attrs.checked;
                    state.write(checked ? '[x] ' : '[ ] ');

                    // Render the inline content of the first paragraph
                    const firstChild = node.firstChild;
                    if (firstChild && firstChild.type.name === 'paragraph') {
                        state.renderInline(firstChild);
                    }

                    state.ensureNewLine();

                    // BUG-03 fix: Serialize nested sub-lists (block* content after first paragraph)
                    // Without this, nested taskList/bulletList/orderedList items are silently dropped
                    // Uses state.render() — the standard prosemirror-markdown API
                    for (let i = 1; i < node.childCount; i++) {
                        const child = node.child(i);
                        state.render(child, node, i);
                    }
                },
            },
        };
    },

    // Add support for Chinese brackets 【】 and 【x】
    addInputRules() {
        return [
            // [] or [ ] for unchecked task item
            new InputRule({
                find: /^\s*\[\s?\]\s$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .toggleTaskList()
                        .focus(null, { scrollIntoView: false })
                        .run();
                },
            }),
            // [x] or [X] for checked task item
            new InputRule({
                find: /^\s*\[[xX]\]\s$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .toggleTaskList()
                        .updateAttributes('taskItem', { checked: true })
                        .focus(null, { scrollIntoView: false })
                        .run();
                },
            }),
            // 【】 for unchecked task item (Chinese brackets)
            new InputRule({
                find: /^\s*【\s?】\s$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .toggleTaskList()
                        .focus(null, { scrollIntoView: false })
                        .run();
                },
            }),
            // 【x】 for checked task item (Chinese brackets)
            new InputRule({
                find: /^\s*【[xX]】\s$/,
                handler: ({ range, chain }) => {
                    chain()
                        .deleteRange(range)
                        .toggleTaskList()
                        .updateAttributes('taskItem', { checked: true })
                        .focus(null, { scrollIntoView: false })
                        .run();
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        return {
            ...this.parent?.(),
            Tab: () => {
                const { $from } = this.editor.state.selection;
                if (findNearestListItemType($from) !== this.name) return false;
                return this.editor.commands.sinkListItem(this.name);
            },
            'Shift-Tab': () => {
                const { $from } = this.editor.state.selection;
                if (findNearestListItemType($from) !== this.name) return false;
                return this.editor.commands.liftListItem(this.name);
            },

            // Shift+ArrowDown: 允许跨 taskItem 向下扩展选区
            // ProseMirror ReactNodeView 边界默认阻止选区扩展
            'Shift-ArrowDown': () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $head } = selection;

                // 检查是否在 taskItem 内
                let taskItemDepth = -1;
                for (let d = $head.depth; d >= 0; d--) {
                    if ($head.node(d).type.name === this.name) {
                        taskItemDepth = d;
                        break;
                    }
                }
                if (taskItemDepth < 0) return false;

                // 只在 taskItem 内容末尾才接管（让浏览器先尝试）
                const taskItemEnd = $head.after(taskItemDepth);
                const headAtEnd = $head.pos >= taskItemEnd - 2; // -2 for paragraph end + taskItem end
                if (!headAtEnd) return false;

                // 找到下一个可用位置（跨过 NodeView 边界）
                const nextPos = taskItemEnd + 2; // +1 进入下一个 taskItem, +1 进入 paragraph
                if (nextPos > state.doc.content.size) return false;

                const $anchor = state.doc.resolve(selection.anchor);
                const $nextHead = state.doc.resolve(Math.min(nextPos, state.doc.content.size));
                const newSel = TextSelection.create(state.doc, $anchor.pos, $nextHead.pos);
                view.dispatch(state.tr.setSelection(newSel));
                return true;
            },

            // Shift+ArrowUp: 允许跨 taskItem 向上扩展选区
            'Shift-ArrowUp': () => {
                const { state, view } = this.editor;
                const { selection } = state;
                const { $head } = selection;

                // 检查是否在 taskItem 内
                let taskItemDepth = -1;
                for (let d = $head.depth; d >= 0; d--) {
                    if ($head.node(d).type.name === this.name) {
                        taskItemDepth = d;
                        break;
                    }
                }
                if (taskItemDepth < 0) return false;

                // 只在 taskItem 内容开头才接管
                const taskItemStart = $head.before(taskItemDepth);
                const headAtStart = $head.pos <= taskItemStart + 2; // +2 for taskItem start + paragraph start
                if (!headAtStart) return false;

                // 找到上一个 taskItem 的末尾位置
                const prevPos = taskItemStart - 2; // -1 退出到 taskList level, -1 进入上一个 taskItem 末尾
                if (prevPos < 0) return false;

                const $anchor = state.doc.resolve(selection.anchor);
                const $prevHead = state.doc.resolve(Math.max(prevPos, 0));
                const newSel = TextSelection.create(state.doc, $anchor.pos, $prevHead.pos);
                view.dispatch(state.tr.setSelection(newSel));
                return true;
            },
            // Custom Enter handler for TaskItem - properly splits into two separate task items
            // Fixes issue where splitListItem creates nested paragraph instead of new task item
            Enter: () => {
                const { state, view } = this.editor;
                const { selection, schema } = state;
                const { $from, empty } = selection;

                // 1. 对于范围选择，先删除（避免交给默认导致 crash）
                let tr = state.tr;
                let $pos = $from;
                if (!empty) {
                    tr = tr.deleteSelection();
                    $pos = tr.selection.$from;
                }

                // Check if we're inside a TaskItem's paragraph
                const paragraph = $pos.parent;
                if (paragraph.type.name !== 'paragraph') return false;

                // Find the TaskItem ancestor
                let taskItemDepth = -1;
                for (let d = $pos.depth; d >= 0; d--) {
                    if ($pos.node(d).type.name === this.name) {
                        taskItemDepth = d;
                        break;
                    }
                }
                
                // ONLY handle splitting if the paragraph is a DIRECT child of the taskItem!
                if (taskItemDepth < 0 || taskItemDepth !== $pos.depth - 1) return false;

                const taskItem = $pos.node(taskItemDepth);
                const isChecked = taskItem.attrs.checked === true;

                // 如果是空列表项（且没有嵌套子块），调用 safeLiftListItem 将其提升到上级（外移），
                // 直到它变成普通的段落，与无序/有序列表的行为保持完全一致。
                if (taskItem.childCount === 1 && taskItem.firstChild?.content.size === 0) {
                     return safeLiftListItem(this.editor, taskItemDepth, 'taskItem');
                }

                // Get positions
                const taskItemStart = $pos.before(taskItemDepth);
                const taskItemEnd = $pos.after(taskItemDepth);

                const cursorOffset = $pos.parentOffset;
                const paragraphIndex = $pos.index(taskItemDepth); // Index of paragraph within taskItem

                // Build content for first task item:
                // All paragraphs before the current one + current paragraph content before cursor
                const firstContent: any[] = [];
                taskItem.forEach((child, _offset, index) => {
                    if (index < paragraphIndex) {
                        // Paragraphs before cursor's paragraph - keep entirely
                        firstContent.push(child);
                    } else if (index === paragraphIndex) {
                        // Current paragraph - keep content before cursor
                        const contentBefore = child.cut(0, cursorOffset);
                        firstContent.push(schema.nodes.paragraph.create(null, contentBefore.content));
                    }
                    // Skip paragraphs after current one for first item
                });

                // Build content for second task item:
                // Current paragraph content after cursor + all subsequent paragraphs
                const secondContent: any[] = [];
                taskItem.forEach((child, _offset, index) => {
                    if (index === paragraphIndex) {
                        // Current paragraph - keep content after cursor
                        const contentAfter = child.cut(cursorOffset);
                        secondContent.push(schema.nodes.paragraph.create(null, contentAfter.content));
                    } else if (index > paragraphIndex) {
                        // Paragraphs after cursor's paragraph - keep entirely
                        secondContent.push(child);
                    }
                    // Skip paragraphs before current one for second item
                });

                // Create new task items
                const firstTaskItem = schema.nodes.taskItem.create(
                    { checked: isChecked },
                    firstContent.length > 0 ? firstContent : schema.nodes.paragraph.create()
                );
                const secondTaskItem = schema.nodes.taskItem.create(
                    { checked: false },
                    secondContent.length > 0 ? secondContent : schema.nodes.paragraph.create()
                );

                // Replace the original task item with the two new ones
                tr.replaceWith(taskItemStart, taskItemEnd, [firstTaskItem, secondTaskItem]);

                // Position cursor at start of second task item's paragraph
                const newCursorPos = tr.mapping.map(taskItemStart) + firstTaskItem.nodeSize + 2;
                tr.setSelection(TextSelection.create(tr.doc, newCursorPos));

                view.dispatch(tr);
                return true;
            },
            Backspace: () => {
                const { state } = this.editor;
                const { selection } = state;
                const { empty, $from } = selection;

                // 1. 必须是光标空选状态
                if (!empty) return false;

                // 2. 找到 taskItem 所在的深度
                let taskItemDepth = -1;
                for (let d = $from.depth; d >= 0; d--) {
                    if ($from.node(d).type.name === this.name) {
                        taskItemDepth = d;
                        break;
                    }
                }
                if (taskItemDepth < 0) return false;

                // 核心安全加固：严格限制直接子节点校验，防止外层处理器拦截嵌套深层的退格事件
                if ($from.depth !== taskItemDepth + 1) {
                    return false; // 放行给内层处理器或默认 keymap
                }

                const taskItem = $from.node(taskItemDepth);
                const paraIndex = $from.index(taskItemDepth);

                const isAtLineStart = $from.parentOffset === 0;
                const isFirstChild = paraIndex === 0;
                const isParaEmpty = $from.parent.content.size === 0;

                // 3. 空段落退格
                if (isParaEmpty) {
                    // 多子节点列表项的内部空段落处理
                    if (taskItem.childCount > 1) {
                        // 非首段的空段落：直接删除该段落，并将光标安全移至上一兄弟节点末尾
                        if (paraIndex > 0) {
                            const { tr } = state;
                            const paraStart = $from.before($from.depth);
                            const paraEnd = $from.after($from.depth);
                            tr.delete(paraStart, paraEnd);
                            
                            const prevEnd = paraStart;
                            tr.setSelection(TextSelection.create(tr.doc, prevEnd - 1));
                            this.editor.view.dispatch(tr);
                            return true; // 确保 dispatch 后返回 true，防止二次事件冒泡
                        }
                    }

                    // 单子节点且全空的列表项：直接安全提升
                    return safeLiftListItem(this.editor, taskItemDepth, 'taskItem');
                }

                // 4. 非空但光标处于行首且为首段，按 Backspace 安全提升
                if (isAtLineStart && isFirstChild) {
                    return safeLiftListItem(this.editor, taskItemDepth, 'taskItem');
                }

                return false;
            },
        };
    },

    renderHTML({ HTMLAttributes }) {
        const checked = HTMLAttributes['data-checked'] === 'true' || HTMLAttributes['data-checked'] === '';
        return [
            'li',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                'data-type': 'taskItem',
                class: `slash-task-item ${checked ? 'is-done' : ''}`,
            }),
            [
                'span',
                { class: `task-checkbox-wrapper ${checked ? 'is-checked' : ''}`, contenteditable: 'false' },
                [
                    'input',
                    {
                        type: 'checkbox',
                        checked: checked ? 'checked' : null,
                        readonly: 'true',
                        tabindex: '-1',
                        class: 'task-input-hidden',
                    }
                ],
                ['span', { class: 'task-checkbox-inner' }, checked ? '✓' : '']
            ],
            ['div', { class: 'slash-task-content' }, 0]
        ];
    },

    // Keep the task item NodeView intentionally thin for IME stability.
    // ReactNodeViewRenderer adds wrapper layers around contentDOM; WebKit IME can then
    // expand deleteCompositionText from text content to the whole taskItem boundary.
    addNodeView() {
        return (props) => {
            let currentNode = props.node;

            const dom = document.createElement('li');
            const checkboxWrapper = document.createElement('span');
            const input = document.createElement('input');
            const checkboxInner = document.createElement('span');
            const contentDOM = document.createElement('div');
            let menuEl: HTMLDivElement | null = null;
            let lastSpaceTime = 0;

            const renderChecked = (checked: boolean) => {
                dom.setAttribute('data-type', 'taskItem');
                dom.setAttribute('data-checked', String(checked));
                dom.className = `slash-task-item ${checked ? 'is-done' : ''}`;
                checkboxWrapper.className = `task-checkbox-wrapper ${checked ? 'is-checked' : ''}`;
                input.checked = checked;
                checkboxInner.textContent = checked ? '✓' : '';
            };

            checkboxWrapper.setAttribute('contenteditable', 'false');
            input.type = 'checkbox';
            input.readOnly = true;
            input.tabIndex = -1;
            input.className = 'task-input-hidden';
            checkboxInner.className = 'task-checkbox-inner';
            contentDOM.className = 'slash-task-content';

            checkboxWrapper.append(input, checkboxInner);
            dom.append(checkboxWrapper, contentDOM);
            renderChecked(currentNode.attrs.checked === true);

            const closeMenu = () => {
                menuEl?.remove();
                menuEl = null;
            };

            const closeMenuRegistryKey = '__slashTaskMetadataMenuClosers';
            const getCloseMenuRegistry = (): Set<() => void> => {
                const win = window as any;
                if (!win[closeMenuRegistryKey]) {
                    win[closeMenuRegistryKey] = new Set<() => void>();
                }
                return win[closeMenuRegistryKey];
            };

            const closeOtherMenus = () => {
                getCloseMenuRegistry().forEach(close => {
                    if (close !== closeMenu) close();
                });
            };

            const insertDraftChip = (type: 'dateChip' | 'userChip' | 'priorityChip') => {
                const { state } = props.view;
                const insertPos = state.selection.from;
                closeMenu();

                // 确保 chip 前方有空格，不紧挨前面的内容
                let needsSpace = false;
                if (insertPos > 0) {
                    try {
                        const charBefore = state.doc.textBetween(insertPos - 1, insertPos, '', '\0');
                        if (charBefore !== ' ' && charBefore !== '\n') {
                            needsSpace = true;
                        }
                    } catch { /* ignore */ }
                }

                if (needsSpace) {
                    props.editor.chain()
                        .insertContentAt(insertPos, [
                            { type: 'text', text: ' ' },
                            { type, attrs: { isDraft: true } },
                        ])
                        .setTextSelection(insertPos + 2)
                        .focus()
                        .run();
                } else {
                    props.editor.chain()
                        .insertContentAt(insertPos, { type, attrs: { isDraft: true } })
                        .setTextSelection(insertPos + 1)
                        .focus()
                        .run();
                }
            };

            const createMenuButton = (label: string, shortcut: string, onClick: () => void) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'task-metadata-option';
                button.textContent = `${label} ${shortcut}`;
                button.addEventListener('mousedown', event => {
                    event.preventDefault();
                    event.stopPropagation();
                });
                button.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClick();
                });
                return button;
            };

            const openMenu = (x: number, y: number) => {
                closeOtherMenus();
                closeMenu();

                menuEl = document.createElement('div');
                menuEl.className = 'task-metadata-menu';
                menuEl.style.position = 'fixed';
                menuEl.style.left = `${x}px`;
                menuEl.style.top = `${y}px`;
                menuEl.style.transform = 'none';

                const backdrop = document.createElement('div');
                backdrop.className = 'task-metadata-backdrop';
                backdrop.addEventListener('click', closeMenu);
                menuEl.append(backdrop);

                menuEl.append(createMenuButton('📅 Date', '&', () => insertDraftChip('dateChip')));

                const teamMembers = (window as any).__slashTeamMembers || [];
                if (teamMembers.length > 0) {
                    menuEl.append(createMenuButton('👤 User', '@', () => insertDraftChip('userChip')));
                }

                menuEl.append(createMenuButton('🚩 Priority', '!', () => insertDraftChip('priorityChip')));
                document.body.append(menuEl);
            };

            const maybeOpenMetadataMenuFromSpace = (event: KeyboardEvent | InputEvent) => {
                if (!props.editor.isEditable || props.view.composing || event.isComposing) return;
                if (menuEl) return;

                const pos = typeof props.getPos === 'function' ? props.getPos() : null;
                if (typeof pos !== 'number') return;
                const liveNode = props.view.state.doc.nodeAt(pos);
                if (!liveNode || liveNode.type.name !== currentNode.type.name) return;

                const { from, empty } = props.view.state.selection;
                if (!empty || from <= pos || from >= pos + liveNode.nodeSize) return;

                const now = Date.now();
                const timeSinceLastSpace = now - lastSpaceTime;
                if (timeSinceLastSpace >= 500) {
                    lastSpaceTime = now;
                    return;
                }

                // 安全校验：确认 from-1 确实是空格字符，而非 chip 等 atom 节点
                // 当快速连按双空格时，ProseMirror 的 MutationObserver 可能尚未处理
                // 第一次空格的 DOM mutation，导致 from 仍指向 chip 后方
                const charBefore = props.view.state.doc.textBetween(from - 1, from, '', '\0');
                if (charBefore !== ' ') {
                    lastSpaceTime = now;
                    return;
                }

                event.preventDefault();
                lastSpaceTime = 0;

                let menuPos = from;
                props.editor.chain()
                    .deleteRange({ from: from - 1, to: from })
                    .setTextSelection(from - 1)
                    .focus()
                    .run();
                menuPos = from - 1;

                try {
                    const coords = props.view.coordsAtPos(menuPos);
                    openMenu(coords.left + 5, coords.bottom + 5);
                } catch {
                    const rect = dom.getBoundingClientRect();
                    openMenu(rect.left + 24, rect.bottom);
                }
            };

            const handleBeforeInput = (event: InputEvent) => {
                if (event.inputType !== 'insertText' || event.data !== ' ') return;
                maybeOpenMetadataMenuFromSpace(event);
            };

            const handleKeyDown = (event: KeyboardEvent) => {
                if (event.key !== ' ' && event.key !== 'Spacebar' && event.code !== 'Space') return;
                maybeOpenMetadataMenuFromSpace(event);
            };

            const handleGlobalMouseDown = (event: MouseEvent) => {
                if (!menuEl || menuEl.contains(event.target as Node)) return;
                closeMenu();
            };

            const handleGlobalKeyDown = (event: KeyboardEvent) => {
                if (!menuEl) return;
                if (event.key === 'Escape' || event.key === 'Backspace') {
                    event.preventDefault();
                    closeMenu();
                    props.editor.commands.focus();
                }
            };

            getCloseMenuRegistry().add(closeMenu);
            document.addEventListener('beforeinput', handleBeforeInput, true);
            document.addEventListener('keydown', handleKeyDown, true);
            document.addEventListener('mousedown', handleGlobalMouseDown, true);
            document.addEventListener('keydown', handleGlobalKeyDown, true);

            checkboxWrapper.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopPropagation();
            });

            checkboxWrapper.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                const pos = typeof props.getPos === 'function' ? props.getPos() : null;
                if (typeof pos !== 'number') return;
                const nextChecked = currentNode.attrs.checked !== true;

                try {
                    const markdown = (props.editor.storage as any)?.markdown?.getMarkdown?.() || '';
                    const taskOrdinal = (() => {
                        let count = 0;
                        props.view.state.doc.descendants((node, nodePos) => {
                            if (nodePos >= pos) return false;
                            if (node.type.name === 'taskItem') count++;
                            return true;
                        });
                        return count;
                    })();
                    const lines = markdown.split('\n');
                    let seenTasks = 0;
                    for (let i = 0; i < lines.length; i++) {
                        if (!/^\s*[-*+]\s\[[ xX]\]\s/.test(lines[i])) continue;
                        if (seenTasks === taskOrdinal) {
                            window.dispatchEvent(new CustomEvent('slash:task-checkbox-intent', {
                                detail: {
                                    lineNumber: i,
                                    originalLine: lines[i],
                                    checked: nextChecked,
                                },
                            }));
                            break;
                        }
                        seenTasks++;
                    }
                } catch { /* task bypass is best-effort; local visual toggle still applies */ }

                const tr = props.view.state.tr.setNodeMarkup(pos, undefined, {
                    ...currentNode.attrs,
                    checked: nextChecked,
                });
                props.view.dispatch(tr);
            });

            return {
                dom,
                contentDOM,
                update: (node) => {
                    if (node.type !== currentNode.type) return false;
                    currentNode = node;
                    renderChecked(currentNode.attrs.checked === true);
                    return true;
                },
                ignoreMutation: (mutation) => {
                    if ((mutation as any).type === 'selection') return false;
                    return !contentDOM.contains(mutation.target);
                },
                destroy: () => {
                    closeMenu();
                    getCloseMenuRegistry().delete(closeMenu);
                    document.removeEventListener('beforeinput', handleBeforeInput, true);
                    document.removeEventListener('keydown', handleKeyDown, true);
                    document.removeEventListener('mousedown', handleGlobalMouseDown, true);
                    document.removeEventListener('keydown', handleGlobalKeyDown, true);
                },
            };
        };
    },

    addProseMirrorPlugins() {
        let compositionStartPos: number | null = null;
        let compositionTextblockStart: number | null = null;
        let compositionTaskItemStart: number | null = null;
        let compositionPrefixText = '';
        let compositionSuffixText = '';
        let compositionStructureSignature: string | null = null;
        let recentCompositionTextblockStart: number | null = null;
        let recentCompositionTaskItemStart: number | null = null;
        let recentCompositionPrefixText = '';
        let recentCompositionSuffixText = '';
        let recentCompositionStructureSignature: string | null = null;
        let recentCompositionEndedAt = 0;
        const compositionGuardAfterEndMs = 600;
        const maxCompositionTextLength = 64;
        const compositionPreeditPattern = /[A-Za-z0-9][A-Za-z0-9\s']{0,63}$/;

        const isInsideTaskItem = ($pos: any) => {
            for (let depth = $pos.depth; depth >= 0; depth--) {
                if ($pos.node(depth).type.name === this.name) {
                    return depth;
                }
            }
            return -1;
        };

        const resetRecentComposition = () => {
            recentCompositionTextblockStart = null;
            recentCompositionTaskItemStart = null;
            recentCompositionPrefixText = '';
            recentCompositionSuffixText = '';
            recentCompositionStructureSignature = null;
        };

        const isDirectTaskParagraph = ($pos: any) => {
            const taskItemDepth = isInsideTaskItem($pos);
            return taskItemDepth >= 0
                && $pos.depth === taskItemDepth + 1
                && $pos.parent.isTextblock;
        };

        const getGuardedTaskContext = () => {
            if (compositionTaskItemStart !== null) {
                return {
                    taskItemStart: compositionTaskItemStart,
                    textblockStart: compositionTextblockStart,
                    prefixText: compositionPrefixText,
                    suffixText: compositionSuffixText,
                    structureSignature: compositionStructureSignature,
                };
            }
            if (
                recentCompositionTaskItemStart !== null
                && Date.now() - recentCompositionEndedAt <= compositionGuardAfterEndMs
            ) {
                return {
                    taskItemStart: recentCompositionTaskItemStart,
                    textblockStart: recentCompositionTextblockStart,
                    prefixText: recentCompositionPrefixText,
                    suffixText: recentCompositionSuffixText,
                    structureSignature: recentCompositionStructureSignature,
                };
            }
            resetRecentComposition();
            return null;
        };

        const getTaskStructureSignature = ($pos: any) => {
            const taskItemDepth = isInsideTaskItem($pos);
            if (taskItemDepth < 0) return null;

            const parts: string[] = [];
            for (let depth = 0; depth <= taskItemDepth; depth++) {
                const name = $pos.node(depth).type.name;
                if (name === 'taskList' || name === 'bulletList' || name === 'orderedList' || name === 'taskItem' || name === 'listItem') {
                    parts.push(name);
                }
            }
            return parts.join('/');
        };

        const getTaskStructureSignatureAt = (doc: any, pos: number | null) => {
            if (pos === null || pos < 0 || pos > doc.content.size) return null;
            try {
                return getTaskStructureSignature(doc.resolve(Math.min(pos, doc.content.size)));
            } catch {
                return null;
            }
        };

        const hasTaskItemShell = (doc: any, pos: number) => {
            if (pos < 0 || pos > doc.content.size) return false;

            const directNode = pos < doc.content.size ? doc.nodeAt(pos) : null;
            if (directNode?.type.name === this.name) return true;

            const $pos = doc.resolve(Math.min(pos, doc.content.size));
            return isInsideTaskItem($pos) >= 0;
        };

        const getTextblockTextAt = (doc: any, pos: number | null) => {
            if (pos === null || pos < 0 || pos > doc.content.size) return null;
            try {
                const $pos = doc.resolve(Math.min(pos, doc.content.size));
                if ($pos.parent?.isTextblock) return $pos.parent.textContent ?? '';
            } catch { /* guarded by null return */ }
            return null;
        };

        const getTaskImeSnapshot = (view: any, label: string, extra: Record<string, any> = {}) => {
            const { state } = view;
            const { selection } = state;
            const taskItemDepth = isInsideTaskItem(selection.$from);
            const paragraphText = selection.$from.parent?.textContent ?? '';
            const textblockStart = selection.$from.parent?.isTextblock
                ? selection.$from.start(selection.$from.depth)
                : null;
            const taskItemStart = taskItemDepth >= 0 ? selection.$from.before(taskItemDepth) : null;
            const taskNode = typeof taskItemStart === 'number' ? state.doc.nodeAt(taskItemStart) : null;
            const textBeforeCursor = textblockStart !== null
                ? state.doc.textBetween(textblockStart, selection.from, '', '\0')
                : '';
            let domText = '';
            try {
                const domAtPos = view.domAtPos(selection.from);
                const node = domAtPos.node instanceof Element
                    ? domAtPos.node
                    : domAtPos.node.parentElement;
                domText = node?.closest?.('li[data-type="taskItem"]')?.textContent ?? '';
            } catch { /* diagnostics only */ }

            return {
                label,
                selectionFrom: selection.from,
                selectionTo: selection.to,
                selectionEmpty: selection.empty,
                taskItemDepth,
                taskItemStart,
                compositionStartPos,
                compositionTextblockStart,
                compositionTaskItemStart,
                recentCompositionTaskItemStart,
                paragraphText,
                taskText: taskNode?.textContent ?? null,
                textBeforeCursor,
                domText,
                ...extra,
            };
        };

        const shouldLogTaskIme = () => {
            try {
                if (typeof window === 'undefined') return false;
                return window.localStorage?.getItem('slash_debug_task_ime') === '1'
                    || (window as any).__slashTaskImeDebug === true;
            } catch {
                return false;
            }
        };

        const logTaskIme = (label: string, view: any, extra: Record<string, any> = {}) => {
            if (!shouldLogTaskIme()) return;
            try {
                console.warn('[TaskIME]', getTaskImeSnapshot(view, label, extra));
            } catch (error) {
                console.warn('[TaskIME]', label, { error, ...extra });
            }
        };

        const findTrailingPreeditRange = (state: any, selection: any) => {
            if (!selection.empty || !isDirectTaskParagraph(selection.$from)) return null;
            if (compositionTextblockStart === null) return null;
            if (selection.$from.start(selection.$from.depth) !== compositionTextblockStart) return null;

            const to = Math.min(selection.from, selection.$from.end(selection.$from.depth));
            const textBeforeCursor = state.doc.textBetween(compositionTextblockStart, to, '', '\0');
            const match = textBeforeCursor.match(compositionPreeditPattern);
            if (!match || match.index === undefined) return null;

            const from = compositionTextblockStart + match.index;
            if (to <= from || to - from > maxCompositionTextLength) return null;

            const text = state.doc.textBetween(from, to, '', '\0');
            if (!/^[A-Za-z0-9\s']+$/.test(text)) return null;

            return { from, to };
        };

        return [
            ...(this.parent?.() ?? []),
            new Plugin({
                key: new PluginKey('taskItemImeCompositionGuard'),
                props: {
                    handleDOMEvents: {
                        compositionstart: (view, event) => {
                            const { selection } = view.state;
                            compositionStartPos = selection.from;
                            compositionTextblockStart = selection.$from.parent.isTextblock
                                ? selection.$from.start(selection.$from.depth)
                                : null;
                            compositionPrefixText = compositionTextblockStart !== null
                                ? view.state.doc.textBetween(compositionTextblockStart, selection.from, '', '\0')
                                : '';
                            compositionSuffixText = selection.$from.parent.isTextblock
                                ? selection.$from.parent.textBetween(selection.$from.parentOffset, selection.$from.parent.content.size, '', '\0')
                                : '';
                            const taskItemDepth = isInsideTaskItem(selection.$from);
                            compositionTaskItemStart = taskItemDepth >= 0
                                ? selection.$from.before(taskItemDepth)
                                : null;
                            compositionStructureSignature = getTaskStructureSignature(selection.$from);
                            resetRecentComposition();
                            if (compositionTaskItemStart !== null) {
                                logTaskIme('compositionstart', view, {
                                    eventData: (event as CompositionEvent).data || '',
                                    compositionPrefixText,
                                    compositionSuffixText,
                                    compositionStructureSignature,
                                });
                            }
                            return false;
                        },
                        beforeinput: (view, event) => {
                            const inputEvent = event as InputEvent;
                            if (
                                inputEvent.inputType !== 'deleteCompositionText'
                                && inputEvent.inputType !== 'insertFromComposition'
                            ) {
                                return false;
                            }
                            logTaskIme('beforeinput:seen', view, {
                                inputType: inputEvent.inputType,
                                data: inputEvent.data,
                            });
                            if (compositionStartPos === null || compositionTextblockStart === null) return false;

                            const { state } = view;
                            const { selection } = state;
                            const range = findTrailingPreeditRange(state, selection);
                            if (!range) {
                                logTaskIme('beforeinput:no-range', view, {
                                    inputType: inputEvent.inputType,
                                    data: inputEvent.data,
                                });
                                return false;
                            }

                            event.preventDefault();
                            const finalText = inputEvent.inputType === 'insertFromComposition'
                                ? inputEvent.data || ''
                                : '';
                            let tr = finalText
                                ? state.tr.insertText(finalText, range.from, range.to)
                                : state.tr.delete(range.from, range.to);
                            const cursorPos = range.from + finalText.length;
                            tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                            tr.setMeta('composition', true);
                            logTaskIme('beforeinput:handled', view, {
                                inputType: inputEvent.inputType,
                                data: inputEvent.data,
                                range,
                                finalText,
                                compositionPrefixText,
                                compositionSuffixText,
                                compositionStructureSignature,
                                nextText: tr.doc.textBetween(compositionTextblockStart, Math.min(cursorPos, tr.doc.content.size), '', '\0'),
                            });
                            view.dispatch(tr);
                            return true;
                        },
                        compositionend: (view, event) => {
                            if (compositionTaskItemStart !== null) {
                                logTaskIme('compositionend', view, {
                                    eventData: (event as CompositionEvent).data || '',
                                    compositionPrefixText,
                                    compositionSuffixText,
                                    compositionStructureSignature,
                                });
                            }
                            recentCompositionTextblockStart = compositionTextblockStart;
                            recentCompositionTaskItemStart = compositionTaskItemStart;
                            recentCompositionPrefixText = compositionPrefixText;
                            recentCompositionSuffixText = compositionSuffixText;
                            recentCompositionStructureSignature = compositionStructureSignature;
                            recentCompositionEndedAt = Date.now();
                            compositionStartPos = null;
                            compositionTextblockStart = null;
                            compositionTaskItemStart = null;
                            compositionPrefixText = '';
                            compositionSuffixText = '';
                            compositionStructureSignature = null;
                            return false;
                        },
                    },
                },
                filterTransaction: (tr) => {
                    if (!tr.docChanged) return true;
                    const fullDocReplace = tr.steps.some((step: any) =>
                        typeof step.from === 'number'
                        && typeof step.to === 'number'
                        && step.from === 0
                        && step.to >= tr.before.content.size
                    );
                    if (fullDocReplace) return true;

                    const guardedContext = getGuardedTaskContext();
                    if (guardedContext === null) return true;

                    const mappedTaskPos = tr.mapping.map(guardedContext.taskItemStart, -1);
                    const keep = hasTaskItemShell(tr.doc, mappedTaskPos);
                    if (!keep) {
                        if (shouldLogTaskIme()) {
                            const steps = tr.steps.map((step: any) => ({
                                from: step.from,
                                to: step.to,
                                slice: step.slice?.content?.textBetween?.(0, step.slice.content.size, '', '\0') ?? null,
                                json: typeof step.toJSON === 'function' ? step.toJSON() : null,
                            }));
                            console.warn('[TaskIME]', {
                                label: 'filterTransaction:blocked',
                                guardedTaskPos: guardedContext.taskItemStart,
                                mappedTaskPos,
                                steps,
                                beforeText: tr.before.textBetween(0, tr.before.content.size, '\n', '\0'),
                                afterText: tr.doc.textBetween(0, tr.doc.content.size, '\n', '\0'),
                            });
                        }
                    }
                    if (!keep) return false;

                    const mappedTextblockStart = guardedContext.textblockStart !== null
                        ? tr.mapping.map(guardedContext.textblockStart, -1)
                        : null;
                    const beforeStructureSignature = guardedContext.structureSignature;
                    const afterStructureSignature = getTaskStructureSignatureAt(tr.doc, mappedTextblockStart);
                    if (beforeStructureSignature && afterStructureSignature !== beforeStructureSignature) {
                        if (shouldLogTaskIme()) {
                            const steps = tr.steps.map((step: any) => ({
                                from: step.from,
                                to: step.to,
                                slice: step.slice?.content?.textBetween?.(0, step.slice.content.size, '', '\0') ?? null,
                                json: typeof step.toJSON === 'function' ? step.toJSON() : null,
                            }));
                            console.warn('[TaskIME]', {
                                label: 'filterTransaction:blocked-structure-loss',
                                beforeStructureSignature,
                                afterStructureSignature,
                                guardedTextblockStart: guardedContext.textblockStart,
                                mappedTextblockStart,
                                steps,
                            });
                        }
                        return false;
                    }

                    const prefixText = guardedContext.prefixText;
                    const suffixText = guardedContext.suffixText;
                    if (!prefixText && !suffixText) return true;

                    const beforeText = getTextblockTextAt(tr.before, guardedContext.textblockStart);
                    const afterText = getTextblockTextAt(tr.doc, mappedTextblockStart);
                    const prefixWasPresent = !prefixText || beforeText === null || beforeText.startsWith(prefixText);
                    const prefixStillPresent = !prefixText || (afterText !== null && afterText.startsWith(prefixText));
                    const suffixWasPresent = !suffixText || beforeText === null || beforeText.endsWith(suffixText);
                    const suffixStillPresent = !suffixText || (afterText !== null && afterText.endsWith(suffixText));

                    if ((prefixWasPresent && !prefixStillPresent) || (suffixWasPresent && !suffixStillPresent)) {
                        if (shouldLogTaskIme()) {
                            const steps = tr.steps.map((step: any) => ({
                                from: step.from,
                                to: step.to,
                                slice: step.slice?.content?.textBetween?.(0, step.slice.content.size, '', '\0') ?? null,
                                json: typeof step.toJSON === 'function' ? step.toJSON() : null,
                            }));
                            console.warn('[TaskIME]', {
                                label: 'filterTransaction:blocked-composition-context-loss',
                                prefixText,
                                suffixText,
                                beforeText,
                                afterText,
                                guardedTextblockStart: guardedContext.textblockStart,
                                mappedTextblockStart,
                                prefixWasPresent,
                                prefixStillPresent,
                                suffixWasPresent,
                                suffixStillPresent,
                                steps,
                            });
                        }
                        return false;
                    }

                    return true;
                },
            }),
        ];
    },
});

/** 列表类型名称集合 */
const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

/** 找到光标最近的列表祖先类型 */
function findClosestListType($pos: any): string | null {
    for (let d = $pos.depth; d >= 0; d--) {
        const name = $pos.node(d).type.name;
        if (LIST_TYPES.includes(name)) return name;
    }
    return null;
}

export const MixedListKeymap = Extension.create({
    name: 'mixedListKeymap',

    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { state } = this.editor;
                const { selection } = state;
                const { empty, $from } = selection;

                // 1. 必须是光标空选状态
                if (!empty) return false;

                // 2. 必须是顶级空段落
                if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) {
                    return false;
                }

                // 3. 检查前一个顶级兄弟节点是否为列表类型
                const doc = state.doc;
                const index = $from.index(0);
                if (index <= 0) return false;

                const prevNode = doc.child(index - 1);
                const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];
                if (!LIST_TYPES.includes(prevNode.type.name)) {
                    return false;
                }

                // 4. 寻找前驱列表中最深处的最后一个段落，并计算其文字末尾的绝对位置
                const currentParaStart = $from.before(1);
                const prevNodeStart = currentParaStart - prevNode.nodeSize;

                let targetParaPos = -1;
                prevNode.nodesBetween(0, prevNode.content.size, (node, pos) => {
                    if (node.type.name === 'paragraph') {
                        targetParaPos = prevNodeStart + 1 + pos + 1 + node.content.size;
                    }
                });

                if (targetParaPos === -1) {
                    return false;
                }

                // 5. 执行原子事务：删除当前顶级空段落并将光标精确重定位到前一个段落尾部
                return this.editor.commands.command(({ tr }) => {
                    const currentParaEnd = $from.after(1);
                    tr.delete(currentParaStart, currentParaEnd);
                    tr.setSelection(TextSelection.create(tr.doc, targetParaPos));
                    return true;
                });
            }
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('listTypeConversion'),
                props: {
                    /**
                     * 拦截空格键：当在列表项开头输入了其他类型的列表标记后按空格，
                     * 自动将当前列表转换为对应类型。
                     * 例如：在有序列表中输入 "- " → 转换为无序列表
                     */
                    handleTextInput(view, from, _to, text) {
                        if (text !== ' ') return false;

                        const { state } = view;
                        const $from = state.doc.resolve(from);
                        const textBefore = $from.parent.textBetween(0, $from.parentOffset);

                        // 只处理已在列表内的情况（不在列表内由默认 InputRules 处理）
                        const closestList = findClosestListType($from);
                        if (!closestList) return false;

                        // 识别用户输入的列表标记
                        let targetType: string | null = null;
                        let checked = false;

                        if (/^[-+*]$/.test(textBefore)) {
                            targetType = 'bulletList';
                        } else if (/^\d+\.$/.test(textBefore)) {
                            targetType = 'orderedList';
                        } else if (/^\[\s?\]$/.test(textBefore) || /^【\s?】$/.test(textBefore)) {
                            targetType = 'taskList';
                        } else if (/^\[[xX]\]$/.test(textBefore) || /^【[xX]】$/.test(textBefore)) {
                            targetType = 'taskList';
                            checked = true;
                        }

                        if (!targetType) return false;

                        // 已经是同类型列表 → 阻止 InputRule 创建嵌套列表，仅插入空格
                        if (targetType === closestList) {
                            view.dispatch(state.tr.insertText(text, from, from));
                            return true;
                        }

                        // 不同类型 → 直接修改最近列表节点的类型（精确操作，不影响父级）
                        const { schema } = state;
                        const tr = state.tr;

                        // 1. 删除标记文本
                        const markerFrom = $from.start($from.depth);
                        const markerTo = from;
                        tr.delete(markerFrom, markerTo);

                        // 2. 找到最近列表节点的位置和深度
                        let listDepth = -1;
                        for (let d = $from.depth; d >= 0; d--) {
                            if (LIST_TYPES.includes($from.node(d).type.name)) {
                                listDepth = d;
                                break;
                            }
                        }
                        if (listDepth < 0) return true;

                        const listPos = $from.before(listDepth);
                        const listEnd = $from.after(listDepth);
                        const targetNodeType = schema.nodes[targetType!];

                        // 3. 从更新后的文档读取列表节点（删除标记文本后）
                        const mappedStart = tr.mapping.map(listPos);
                        const mappedEnd = tr.mapping.map(listEnd);
                        const updatedList = tr.doc.nodeAt(mappedStart);
                        if (!updatedList) return true;

                        // 4. 构建新的列表节点（原子替换，避免中间状态 schema 错误）
                        const srcItem = updatedList.type.name === 'taskList' ? 'taskItem' : 'listItem';
                        const dstItem = targetType === 'taskList' ? 'taskItem' : 'listItem';
                        const dstItemType = schema.nodes[dstItem];

                        const newItems: any[] = [];
                        updatedList.forEach((child) => {
                            if (child.type.name === srcItem && srcItem !== dstItem) {
                                const newAttrs = dstItem === 'taskItem'
                                    ? { checked: checked }
                                    : {};
                                newItems.push(dstItemType.create(newAttrs, child.content, child.marks));
                            } else {
                                newItems.push(child.copy(child.content));
                            }
                        });

                        const newList = targetNodeType.create(null, newItems);
                        tr.replaceWith(mappedStart, mappedEnd, newList);

                        // 5. 设置光标到用户所在的列表项内
                        const itemIndex = $from.index(listDepth);
                        const insertedList = tr.doc.nodeAt(mappedStart);
                        if (insertedList) {
                            let offset = 0;
                            for (let i = 0; i < itemIndex && i < insertedList.childCount; i++) {
                                offset += insertedList.child(i).nodeSize;
                            }
                            // +1 进入 list, +offset 跳过前面的 items, +1 进入 item, +1 进入 paragraph
                            const cursorPos = mappedStart + 1 + offset + 1 + 1;
                            tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                        }

                        view.dispatch(tr);
                        return true;
                    },
                },
            }),
        ];
    },
});
