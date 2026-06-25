import { Table } from '@tiptap/extension-table';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TableNodeView } from './TableNodeView';
import { CellSelection, TableMap, goToNextCell } from '@tiptap/pm/tables';
import { TextSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { InputRule } from '@tiptap/core';

/**
 * SuperTable Extension
 * 使用 ReactNodeViewRenderer 渲染自定义表格 UI
 */
export const SuperTableExtension = Table.extend({
    name: 'table',

    addOptions() {
        return {
            ...this.parent?.(),
            HTMLAttributes: {
                class: 'tiptap-table-wrapper',
            },
            // 禁用列宽调整 - Markdown 不支持列宽
            resizable: false,
            cellMinWidth: 50,
            allowTableNodeSelection: true,
        } as any;
    },

    // 使用 React NodeView 渲染
    addNodeView() {
        return ReactNodeViewRenderer(TableNodeView);
    },

    // ✅ 智能退格键：选中行/列时，有内容先清空，空了再删除
    // ✅ Tab/Shift+Tab: 单元格导航
    addKeyboardShortcuts() {
        const findCellInfo = ($pos: any) => {
            for (let depth = $pos.depth; depth > 0; depth--) {
                const node = $pos.node(depth);
                if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                    let tableDepth = depth - 1;
                    while (tableDepth > 0 && $pos.node(tableDepth).type.name !== 'table') {
                        tableDepth--;
                    }
                    if (tableDepth <= 0 || $pos.node(tableDepth).type.name !== 'table') {
                        return null;
                    }
                    return {
                        cellDepth: depth,
                        tableDepth,
                        cellPos: $pos.before(depth),
                        tableNode: $pos.node(tableDepth),
                        tablePos: $pos.before(tableDepth),
                    };
                }
            }
            return null;
        };

        const normalizeToCellSelection = (selection: any) => {
            if (selection instanceof CellSelection) {
                return selection;
            }

            if (selection.empty) {
                return null;
            }

            const anchorInfo = findCellInfo(selection.$from);
            const headInfo = findCellInfo(selection.$to);
            if (!anchorInfo || !headInfo) {
                return null;
            }

            if (anchorInfo.tablePos !== headInfo.tablePos || anchorInfo.cellPos === headInfo.cellPos) {
                return null;
            }

            try {
                const $anchor = this.editor.state.doc.resolve(anchorInfo.cellPos);
                const $head = this.editor.state.doc.resolve(headInfo.cellPos);
                return new CellSelection($anchor, $head);
            } catch {
                return null;
            }
        };

        const handleStructuredCellDeletion = () => {
            const { state, view } = this.editor;
            const cellSelection = normalizeToCellSelection(state.selection);
            if (!cellSelection) {
                return false;
            }
            const table = cellSelection.$anchorCell.node(-1);
            const tableStart = cellSelection.$anchorCell.start(-1);
            const tablePos = tableStart - 1;
            const map = TableMap.get(table);
            const rect = map.rectBetween(
                cellSelection.$anchorCell.pos - tableStart,
                cellSelection.$headCell.pos - tableStart
            );

            const rowSpan = rect.bottom - rect.top;
            const colSpan = rect.right - rect.left;
            const isFullRowSelection = rect.left === 0 && rect.right === map.width;
            const isFullColumnSelection = rect.top === 0 && rect.bottom === map.height;
            const isFullTableSelection = isFullRowSelection && isFullColumnSelection;

            const deleteEntireTable = () => {
                const tr = state.tr.delete(tablePos, tablePos + table.nodeSize);
                view.dispatch(tr);
                return true;
            };

            // 结构删除优先：只要选中的是完整行/列/表格，就删除结构，而不是清空单元格内容。
            if (isFullTableSelection) {
                return deleteEntireTable();
            }

            if (isFullRowSelection && rowSpan >= 1) {
                if (rowSpan >= map.height) {
                    return deleteEntireTable();
                }
                return this.editor.commands.deleteRow();
            }

            if (isFullColumnSelection && colSpan >= 1) {
                if (colSpan >= map.width) {
                    return deleteEntireTable();
                }
                return this.editor.commands.deleteColumn();
            }

            // 其余矩形选区保留“清空单元格内容”的行为。
            const ranges: { from: number; to: number }[] = [];
            cellSelection.forEachCell((cell, pos) => {
                const cellStart = pos + 1;
                const cellEnd = pos + cell.nodeSize - 1;
                if (cellEnd > cellStart) {
                    ranges.push({ from: cellStart, to: cellEnd });
                }
            });

            if (ranges.length === 0) {
                return false;
            }

            ranges.sort((a, b) => b.from - a.from);
            const tr = state.tr;
            for (const range of ranges) {
                tr.delete(range.from, range.to);
            }
            view.dispatch(tr);
            return true;
        };

        return {
            // Tab: 移动到下一个单元格
            Tab: () => {
                // 检查是否在表格内
                if (!this.editor.isActive('table')) {
                    return false;
                }

                // 使用 ProseMirror 的 goToNextCell 命令
                const command = goToNextCell(1);
                return command(this.editor.state, this.editor.view.dispatch);
            },

            // Shift+Tab: 移动到上一个单元格
            'Shift-Tab': () => {
                // 检查是否在表格内
                if (!this.editor.isActive('table')) {
                    return false;
                }

                // 使用 goToNextCell(-1) 向后移动
                const command = goToNextCell(-1);
                return command(this.editor.state, this.editor.view.dispatch);
            },

            Backspace: () => {
                return handleStructuredCellDeletion();
            },

            Delete: () => handleStructuredCellDeletion(),
        };
    },

    // Markdown 序列化配置
    // @ts-ignore
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const rows = node.content.content;
                    if (!rows || rows.length === 0) return;

                    // 标记进入表格模式（某些 tiptap-markdown 版本需要）
                    const wasInTable = state.inTable;
                    state.inTable = true;

                    rows.forEach((row: any, rowIndex: number) => {
                        const cells = row.content?.content || [];

                        state.write('|');
                        cells.forEach((cell: any) => {
                            state.write(' ');
                            const serializableChildren = (cell.content?.content || []).filter((childNode: any) => {
                                if (childNode.type.name !== 'paragraph') return true;
                                if (childNode.childCount > 0) return true;
                                return (childNode.textContent || '').trim().length > 0;
                            });

                            // ✅ 关键修复：使用 renderInline 正确序列化单元格内容（保留 marks）
                            // 先保存当前输出位置
                            const startLen = state.out.length;

                            // 渲染单元格内容（包含 bold, italic, code 等 marks）
                            if (serializableChildren.length > 0) {
                                serializableChildren.forEach((childNode: any, idx: number) => {
                                    // 处理段落节点 - 渲染其 inline 内容
                                    if (childNode.type.name === 'paragraph') {
                                        state.renderInline(childNode);
                                    } else if (childNode.isText) {
                                        state.text(childNode.text || '', false);
                                    } else {
                                        // Image/video/audio may be block nodes in cells; render the node itself.
                                        state.render(childNode, cell, idx);
                                    }

                                    // 多个段落之间用 <br> 分隔（Markdown 表格不支持真正换行）
                                    if (idx < serializableChildren.length - 1) {
                                        state.write('<br>');
                                    }
                                });
                            }

                            // 获取渲染后的内容并处理
                            let cellContent = state.out.slice(startLen).replace(/\n+$/, '');
                            // 移除刚添加的内容，我们需要做后处理
                            state.out = state.out.slice(0, startLen);

                            // 处理 pipe 字符转义（表格分隔符）
                            cellContent = cellContent.replace(/\|/g, '\\|');
                            // 移除首尾空白和换行
                            cellContent = cellContent.replace(/\n/g, '<br>').trim();

                            state.write(cellContent);
                            state.write(' |');
                        });
                        state.write('\n');

                        // 第一行后添加分隔符
                        if (rowIndex === 0) {
                            state.write('|');
                            cells.forEach((cell: any) => {
                                const align = cell.attrs?.textAlign || 'left';
                                const separator = align === 'center' ? ':---:'
                                    : align === 'right' ? '---:'
                                        : '---';
                                state.write(` ${separator} |`);
                            });
                            state.write('\n');
                        }
                    });

                    state.write('\n');
                    state.inTable = wasInTable;
                },
            },
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('superTableBrFix'),
                appendTransaction(transactions, _oldState, newState) {
                    if (!transactions.some(tr => tr.docChanged)) {
                        return null;
                    }

                    const replacements: { pos: number; size: number; text: string; marks: any }[] = [];
                    newState.doc.descendants((node, pos) => {
                        if (node.isText && node.text && /<br\s*\/?>/i.test(node.text)) {
                            const $pos = newState.doc.resolve(pos);
                            let isInTableCell = false;
                            for (let d = $pos.depth; d > 0; d--) {
                                const parentName = $pos.node(d).type.name;
                                if (parentName === 'tableCell' || parentName === 'tableHeader') {
                                    isInTableCell = true;
                                    break;
                                }
                            }
                            if (isInTableCell) {
                                replacements.push({
                                    pos,
                                    size: node.nodeSize,
                                    text: node.text,
                                    marks: node.marks
                                });
                            }
                        }
                        return true;
                    });

                    if (replacements.length === 0) {
                        return null;
                    }

                    replacements.sort((a, b) => b.pos - a.pos);

                    const tr = newState.tr;
                    replacements.forEach(({ pos, size, text, marks }) => {
                        const parts = text.split(/(<br\s*\/?>)/i);
                        const nodes: any[] = [];
                        parts.forEach(part => {
                            if (/<br\s*\/?>/i.test(part)) {
                                if (newState.schema.nodes.hardBreak) {
                                    nodes.push(newState.schema.nodes.hardBreak.create());
                                }
                            } else if (part.length > 0) {
                                nodes.push(newState.schema.text(part, marks));
                            }
                        });
                        if (nodes.length > 0) {
                            tr.replaceWith(pos, pos + size, nodes);
                        }
                    });

                    return tr.docChanged ? tr : null;
                }
            })
        ];
    },

    addInputRules() {
        return [
            new InputRule({
                find: /^\|\|\s$/,
                handler: ({ state, range }) => {
                    const { tr } = state;
                    const start = range.from;
                    const end = range.to;

                    // 删除匹配的内容（即 "|| "）
                    tr.delete(start, end);

                    const tableType = state.schema.nodes.table;
                    const rowType = state.schema.nodes.tableRow;
                    const cellType = state.schema.nodes.tableCell;
                    const headerType = state.schema.nodes.tableHeader || state.schema.nodes.tableCell;
                    const pType = state.schema.nodes.paragraph;

                    if (!tableType || !rowType || !cellType || !pType) {
                        return null;
                    }

                    const rows: any[] = [];
                    for (let r = 0; r < 3; r++) {
                        const cells: any[] = [];
                        for (let c = 0; c < 3; c++) {
                            const cType = (r === 0 && headerType) ? headerType : cellType;
                            cells.push(
                                cType.create(null, pType.create())
                             );
                        }
                        rows.push(rowType.create(null, cells));
                    }

                    const tableNode = tableType.create(null, rows);
                    tr.insert(start, tableNode);

                    // 定位到第一个单元格中的段落
                    const firstCellPos = start + 4; // table (1) + row (1) + cell (1) + paragraph (1)
                    const resolvedPos = tr.doc.resolve(firstCellPos);
                    tr.setSelection(TextSelection.near(resolvedPos));
                },
            }),
            new InputRule({
                find: /^\|((?:[^|]*\|)+)\s$/,
                handler: ({ state, range, match }) => {
                    const { tr } = state;
                    const start = range.from;
                    const end = range.to;

                    const rawLine = match[0].trim();
                    const inner = rawLine.slice(1, -1);
                    const cols = inner.split('|').map(s => s.trim());

                    if (cols.length === 0 || (cols.length === 1 && cols[0] === '')) {
                        return null;
                    }

                    const tableType = state.schema.nodes.table;
                    const rowType = state.schema.nodes.tableRow;
                    const cellType = state.schema.nodes.tableCell;
                    const headerType = state.schema.nodes.tableHeader || state.schema.nodes.tableCell;
                    const pType = state.schema.nodes.paragraph;

                    if (!tableType || !rowType || !cellType || !pType) {
                        return null;
                    }

                    tr.delete(start, end);

                    const rows: any[] = [];
                    const headerCells: any[] = [];
                    for (let c = 0; c < cols.length; c++) {
                        const cellText = cols[c];
                        const contentNode = cellText ? pType.create(null, state.schema.text(cellText)) : pType.create();
                        headerCells.push(headerType.create(null, contentNode));
                    }
                    rows.push(rowType.create(null, headerCells));

                    const dataCells: any[] = [];
                    for (let c = 0; c < cols.length; c++) {
                        dataCells.push(cellType.create(null, pType.create()));
                    }
                    rows.push(rowType.create(null, dataCells));

                    const tableNode = tableType.create(null, rows);
                    tr.insert(start, tableNode);

                    const firstCellPos = start + 4;
                    const resolvedPos = tr.doc.resolve(firstCellPos);
                    tr.setSelection(TextSelection.near(resolvedPos));
                },
            }),
        ];
    },
});

export { TableRow } from '@tiptap/extension-table-row';
export { TableHeader } from '@tiptap/extension-table-header';
export { TableCell } from '@tiptap/extension-table-cell';
