import React, { useEffect } from 'react';
import { Editor } from '@tiptap/react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Trash2, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useTranslation } from 'react-i18next';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        textAlign: {
            setTextAlign: (alignment: 'left' | 'center' | 'right' | 'justify') => ReturnType;
        }
    }
}

interface TableMenuProps {
    editor: Editor;
    isOpen: boolean;
    position: { x: number; y: number };
    context: 'row' | 'column' | 'cell';
    index?: number; // ✅ 新增：接收当前操作的索引
    onClose: () => void;
    // ✅ 新增：接收父组件的选择方法，用于“强制锁定”
    onSelectRow?: (index: number) => void;
    onSelectColumn?: (index: number) => void;
}

interface MenuItem {
    icon: React.ReactNode;
    label: string;
    action: () => void;
    danger?: boolean;
    divider?: boolean;
}

export const TableMenu: React.FC<TableMenuProps> = ({
    editor,
    isOpen,
    position,
    context,
    index,
    onClose,
    onSelectRow,
    onSelectColumn
}) => {
    const { t } = useTranslation();
    // ✅ Hooks must be called before any early returns
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = () => onClose();
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        // 使用 mousedown 而不是 click，反应更快，防止焦点丢失
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    // 辅助函数：安全执行命令
    const runCommand = (fn: () => void) => {
        fn();
        onClose();
    };

    const getMenuItems = (): MenuItem[] => {
        const items: MenuItem[] = [];

        if (context === 'column') {
            items.push(
                {
                    icon: <ArrowLeft size={14} />,
                    label: t('editor.table.insertColumnBefore'),
                    action: () => runCommand(() => {
                        // 插入前先选中，确保插入位置正确
                        if (typeof index === 'number' && onSelectColumn) onSelectColumn(index);
                        editor.chain().focus().addColumnBefore().run();
                    }),
                },
                {
                    icon: <ArrowRight size={14} />,
                    label: t('editor.table.insertColumnAfter'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectColumn) onSelectColumn(index);
                        editor.chain().focus().addColumnAfter().run();
                    }),
                },
                {
                    icon: <Trash2 size={14} />,
                    label: t('editor.table.deleteColumn'),
                    action: () => runCommand(() => {
                        // 🎯 核心修复：删除前强制再次选中该列！
                        if (typeof index === 'number' && onSelectColumn) {
                            onSelectColumn(index);
                        }

                        // 先捕获当前表格状态（在 requestAnimationFrame 之前）
                        const { state: currentState, view } = editor;
                        // 找到表格节点 - 可能在不同深度
                        let currentTable = currentState.selection.$anchor.node(-1);
                        if (currentTable?.type.name === 'tableRow') {
                            currentTable = currentState.selection.$anchor.node(-2);
                        }
                        console.log('[TableMenu] Delete column - table:', currentTable?.type.name, 'firstRow childCount:', currentTable?.firstChild?.childCount);
                        const isLastColumn = currentTable?.type.name === 'table' &&
                            currentTable.firstChild && currentTable.firstChild.childCount <= 1;
                        console.log('[TableMenu] isLastColumn:', isLastColumn);

                        // 稍微给一点 React 渲染间隙，确保选区生效
                        requestAnimationFrame(() => {
                            if (isLastColumn) {
                                // 重新获取最新状态来删除表格
                                const { state } = editor;
                                // 找到表格节点
                                let table = state.selection.$anchor.node(-1);
                                let depth = -1;
                                if (table?.type.name === 'tableRow') {
                                    table = state.selection.$anchor.node(-2);
                                    depth = -2;
                                }
                                if (table?.type.name === 'table') {
                                    const tableStart = state.selection.$anchor.start(depth);
                                    const tablePos = tableStart - 1;
                                    const tr = state.tr.delete(tablePos, tablePos + table.nodeSize);
                                    view.dispatch(tr);
                                    return;
                                }
                            }
                            editor.chain().focus().deleteColumn().run();
                        });
                    }),
                    danger: true,
                    divider: true,
                },
                {
                    icon: <AlignLeft size={14} />,
                    label: t('editor.table.alignLeft'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectColumn) onSelectColumn(index);
                        editor.chain().focus().setTextAlign('left').run();
                    }),
                },
                {
                    icon: <AlignCenter size={14} />,
                    label: t('editor.table.alignCenter'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectColumn) onSelectColumn(index);
                        editor.chain().focus().setTextAlign('center').run();
                    }),
                },
                {
                    icon: <AlignRight size={14} />,
                    label: t('editor.table.alignRight'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectColumn) onSelectColumn(index);
                        editor.chain().focus().setTextAlign('right').run();
                    }),
                }
            );
        }

        if (context === 'row') {
            items.push(
                {
                    icon: <ArrowUp size={14} />,
                    label: t('editor.table.insertRowBefore'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectRow) onSelectRow(index);
                        editor.chain().focus().addRowBefore().run();
                    }),
                },
                {
                    icon: <ArrowDown size={14} />,
                    label: t('editor.table.insertRowAfter'),
                    action: () => runCommand(() => {
                        if (typeof index === 'number' && onSelectRow) onSelectRow(index);
                        editor.chain().focus().addRowAfter().run();
                    }),
                },
                {
                    icon: <Trash2 size={14} />,
                    label: t('editor.table.deleteRow'),
                    action: () => runCommand(() => {
                        // 🎯 核心修复：删除前强制再次选中该行！
                        if (typeof index === 'number' && onSelectRow) {
                            onSelectRow(index);
                        }

                        // 先捕获当前表格状态（在 requestAnimationFrame 之前）
                        const { state: currentState, view } = editor;
                        // 找到表格节点 - 可能在不同深度
                        let currentTable = currentState.selection.$anchor.node(-1);
                        if (currentTable?.type.name === 'tableRow') {
                            currentTable = currentState.selection.$anchor.node(-2);
                        }
                        const isLastRow = currentTable?.type.name === 'table' && currentTable.childCount <= 1;

                        requestAnimationFrame(() => {
                            if (isLastRow) {
                                // 重新获取最新状态来删除表格
                                const { state } = editor;
                                // 找到表格节点
                                let table = state.selection.$anchor.node(-1);
                                let depth = -1;
                                if (table?.type.name === 'tableRow') {
                                    table = state.selection.$anchor.node(-2);
                                    depth = -2;
                                }
                                if (table?.type.name === 'table') {
                                    const tableStart = state.selection.$anchor.start(depth);
                                    const tablePos = tableStart - 1;
                                    const tr = state.tr.delete(tablePos, tablePos + table.nodeSize);
                                    view.dispatch(tr);
                                    return;
                                }
                            }
                            editor.chain().focus().deleteRow().run();
                        });
                    }),
                    danger: true,
                }
            );
        }

        // Cell 菜单保持不变，逻辑简单
        if (context === 'cell') {
            items.push(
                {
                    icon: <ArrowUp size={14} />,
                    label: t('editor.table.insertRowBefore'),
                    action: () => runCommand(() => editor.chain().focus().addRowBefore().run()),
                },
                {
                    icon: <ArrowDown size={14} />,
                    label: t('editor.table.insertRowAfter'),
                    action: () => runCommand(() => editor.chain().focus().addRowAfter().run()),
                },
                {
                    icon: <ArrowLeft size={14} />,
                    label: t('editor.table.insertColumnBefore'),
                    action: () => runCommand(() => editor.chain().focus().addColumnBefore().run()),
                    divider: true,
                },
                {
                    icon: <ArrowRight size={14} />,
                    label: t('editor.table.insertColumnAfter'),
                    action: () => runCommand(() => editor.chain().focus().addColumnAfter().run()),
                },
                {
                    icon: <Trash2 size={14} />,
                    label: t('editor.table.deleteTable'),
                    action: () => runCommand(() => editor.chain().focus().deleteTable().run()),
                    danger: true,
                    divider: true,
                }
            );
        }

        return items;
    };

    return (
        <div
            className={cn(
                "fixed z-50 min-w-[160px] py-1 rounded-lg shadow-lg",
                "bg-white dark:bg-zinc-900",
                "border border-zinc-200 dark:border-zinc-700",
                "animate-in fade-in-0 zoom-in-95"
            )}
            style={{
                left: position.x,
                top: position.y,
            }}
            onMouseDown={(e) => e.stopPropagation()} // 防止点击菜单本身触发 close
            onClick={(e) => e.stopPropagation()}
        >
            {getMenuItems().map((item, index) => (
                <React.Fragment key={index}>
                    {item.divider && index > 0 && (
                        <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            item.action();
                        }}
                        className={cn(
                            "w-full px-3 py-1.5 flex items-center gap-2 text-sm text-left",
                            "transition-colors",
                            item.danger
                                ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        )}
                    >
                        {item.icon}
                        <span>{item.label}</span>
                    </button>
                </React.Fragment>
            ))}
        </div>
    );
};