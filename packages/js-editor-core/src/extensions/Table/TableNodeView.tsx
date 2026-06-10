import React, { useRef, useState, useCallback, useEffect } from 'react';
import { NodeViewWrapper, NodeViewContent, NodeViewProps } from '@tiptap/react';
import { Plus, GripVertical } from 'lucide-react';
import { cn } from '../../utils/cn';
import { TableMenu } from './TableMenu';
import { useTranslation } from 'react-i18next';
import { CellSelection, TableMap, moveTableColumn, moveTableRow } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import './TableStyles.css';

interface MenuState {
    isOpen: boolean;
    position: { x: number; y: number };
    context: 'row' | 'column' | 'cell';
    index?: number;
}

interface HandlePosition {
    index: number;
    offset: number; // visual local offset
    size: number;
    coord: number; // absolute screen coordinate for collision
}

interface TableRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface CellCoords {
    rowIndex: number;
    colIndex: number;
}

interface SelectionRegion {
    left: number;
    right: number;
    top: number;
    bottom: number;
}



// TBody 组件用于 NodeViewContent
// 添加 suppressContentEditableWarning 和 IME 事件处理以修复中文输入问题
const TBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
    (props, ref) => (
        <tbody
            ref={ref}
            {...props}
            suppressContentEditableWarning={true}
        />
    )
);
TBody.displayName = 'TBody';

export const TableNodeView: React.FC<NodeViewProps> = ({
    node,
    editor,
    getPos,
    // selected - removed, was only used for blue ring which is now disabled
}) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<HTMLTableElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();
    const isEditable = editor?.isEditable !== false;

    // 🔍 获取当前 zoom 级别（从最近的祖先 style.zoom 读取）
    const getZoomLevel = useCallback((): number => {
        const el = wrapperRef.current?.closest('[style*="zoom"]') as HTMLElement | null;
        return el ? parseFloat(el.style.zoom) || 1 : 1;
    }, []);

    const [tableRect, setTableRect] = useState<TableRect>({ left: 0, top: 0, width: 0, height: 0 });
    const [columnHandles, setColumnHandles] = useState<HandlePosition[]>([]);
    const [rowHandles, setRowHandles] = useState<HandlePosition[]>([]);
    const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
    const [hoveredRow, setHoveredRow] = useState<number | null>(null);
    const [selectionRegion, setSelectionRegion] = useState<SelectionRegion | null>(null);
    const [menu, setMenu] = useState<MenuState>({
        isOpen: false,
        position: { x: 0, y: 0 },
        context: 'cell',
    });

    // Drag and Drop state
    const dragCtxRef = useRef<{ type: 'row' | 'column', index: number } | null>(null);
    const dropTargetRef = useRef<number | null>(null);
    const [draggingContext, setDraggingContext] = useState<{ type: 'row' | 'column', index: number } | null>(null);
    const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

    // Refs to store latest coordinates for mouse events
    const columnHandlesRef = useRef<HandlePosition[]>([]);
    const rowHandlesRef = useRef<HandlePosition[]>([]);
    const cellDragStateRef = useRef<{
        start: CellCoords;
        current: CellCoords;
        selecting: boolean;
    } | null>(null);

    // Sync state with refs for Native DOM listeners
    const updateDraggingContext = (val: { type: 'row' | 'column', index: number } | null) => {
        dragCtxRef.current = val;
        setDraggingContext(val);
    };
    const updateDropTargetIndex = (val: number | null) => {
        dropTargetRef.current = val;
        setDropTargetIndex(val);
    };

    // =========================================================
    //  计算手柄位置
    // =========================================================
    const updateHandlePositions = useCallback(() => {
        if (!tableRef.current || !wrapperRef.current) {
            return;
        }

        const table = tableRef.current;
        const wrapper = wrapperRef.current;
        const wrapperRect = wrapper.getBoundingClientRect();
        const tableRectAbs = table.getBoundingClientRect();

        // 🔍 CSS zoom 修正：getBoundingClientRect 返回物理像素，
        // 但 CSS left/top/width/height 在 zoom 容器内按逻辑像素解释
        const zoom = getZoomLevel();

        const rows = Array.from(table.querySelectorAll('tr')) as HTMLElement[];
        if (rows.length === 0) return;

        // 计算列 - 用 getBoundingClientRect 来获取绝对位置
        const firstRowCellsArr = Array.from(rows[0].children) as HTMLElement[];
        let colAcc = 0;
        const cols: HandlePosition[] = firstRowCellsArr.map((cell, index) => {
            const rect = cell.getBoundingClientRect();
            const logicalWidth = rect.width / zoom; // ÷ zoom → 逻辑像素
            const offset = colAcc;
            colAcc += logicalWidth;
            return {
                index,
                offset,
                size: logicalWidth,
                coord: rect.left, // 保持物理像素（拖拽碰撞检测用）
            };
        });
        setColumnHandles(cols);
        columnHandlesRef.current = cols;

        // ✅ 关键修复：使用列宽总和 + 边框作为可靠的表格宽度
        const reliableWidth = colAcc > 0 ? colAcc + 1 : tableRectAbs.width / zoom;

        const rect: TableRect = {
            left: (tableRectAbs.left - wrapperRect.left) / zoom + wrapper.scrollLeft,
            top: (tableRectAbs.top - wrapperRect.top) / zoom + wrapper.scrollTop,
            width: reliableWidth,
            height: tableRectAbs.height / zoom,
        };

        setTableRect(rect);

        // 计算行
        let rowAcc = 0;
        const rowPositions: HandlePosition[] = rows.map((row, index) => {
            const cell = row.firstElementChild as HTMLElement;
            const target = cell || row;
            const targetRect = target.getBoundingClientRect();
            const logicalHeight = targetRect.height / zoom; // ÷ zoom → 逻辑像素

            const offset = rowAcc;
            rowAcc += logicalHeight;

            return {
                index,
                offset,
                size: logicalHeight,
                coord: targetRect.top // 保持物理像素（拖拽碰撞检测用）
            };
        });
        setRowHandles(rowPositions);
        rowHandlesRef.current = rowPositions;
    }, [getZoomLevel]);

    useEffect(() => {
        // 延迟计算确保 DOM 稳定
        setTimeout(updateHandlePositions, 50);
        setTimeout(updateHandlePositions, 200);

        const resizeObserver = new ResizeObserver(() => updateHandlePositions());
        if (tableRef.current) resizeObserver.observe(tableRef.current);
        if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);

        const scrollContainer = scrollContainerRef.current;
        if (scrollContainer) scrollContainer.addEventListener('scroll', updateHandlePositions);
        // 全局窗口 resize 也要监听
        window.addEventListener('resize', updateHandlePositions);

        // 🔍 监听 zoom 变化：当祖先元素的 style.zoom 改变时重新计算手柄
        const zoomAncestor = wrapperRef.current?.closest('[style*="zoom"]') as HTMLElement | null;
        let mutationObs: MutationObserver | null = null;
        if (zoomAncestor) {
            mutationObs = new MutationObserver(() => updateHandlePositions());
            mutationObs.observe(zoomAncestor, { attributes: true, attributeFilter: ['style'] });
        }

        return () => {
            resizeObserver.disconnect();
            mutationObs?.disconnect();
            if (scrollContainer) scrollContainer.removeEventListener('scroll', updateHandlePositions);
            window.removeEventListener('resize', updateHandlePositions);
        };
    }, [updateHandlePositions, node]);


    // ... 选中逻辑 (保持不变) ...
    const getSafeCellPos = useCallback((doc: any, startPos: number, cellPos: number) => {
        let absPos = startPos + 1 + cellPos;
        let $pos = doc.resolve(absPos);
        // Fallback robust resolution: CellSelection expects $anchorCell.node(-1) to be the table.
        // If it isn't (e.g. it is tableRow due to off-by-one or text node resolving), we walk back
        // until its node(-1) is a table.
        while ($pos.node(-1) && $pos.node(-1).type.spec.tableRole !== 'table' && $pos.depth > 0) {
            $pos = doc.resolve($pos.before());
        }
        return $pos;
    }, []);

    const getCellCoordsFromElement = useCallback((target: EventTarget | Element | null): CellCoords | null => {
        const table = tableRef.current;
        if (!table || !(target instanceof Element)) return null;

        const cell = target.closest('td,th') as HTMLTableCellElement | null;
        if (!cell || !table.contains(cell)) return null;

        const row = cell.parentElement as HTMLTableRowElement | null;
        if (!row) return null;

        const rows = Array.from(table.querySelectorAll('tr'));
        const rowIndex = rows.indexOf(row);
        const colIndex = Array.from(row.children).indexOf(cell);
        if (rowIndex < 0 || colIndex < 0) return null;

        return { rowIndex, colIndex };
    }, []);

    const applyCellSelection = useCallback((anchor: CellCoords, head: CellCoords) => {
        if (!isEditable || !editor || typeof getPos !== 'function') return false;
        const startPos = getPos();
        if (startPos === undefined) return false;

        const { state, view } = editor;
        const { doc } = state;
        const currentTableNode = doc.nodeAt(startPos);
        const table = currentTableNode && currentTableNode.type.name === 'table' ? currentTableNode : node;
        const map = TableMap.get(table);

        const anchorRow = Math.max(0, Math.min(anchor.rowIndex, map.height - 1));
        const anchorCol = Math.max(0, Math.min(anchor.colIndex, map.width - 1));
        const headRow = Math.max(0, Math.min(head.rowIndex, map.height - 1));
        const headCol = Math.max(0, Math.min(head.colIndex, map.width - 1));

        try {
            const anchorCellPos = map.positionAt(anchorRow, anchorCol, table);
            const headCellPos = map.positionAt(headRow, headCol, table);
            const $anchor = getSafeCellPos(doc, startPos, anchorCellPos);
            const $head = getSafeCellPos(doc, startPos, headCellPos);
            const selection = new CellSelection($anchor, $head);
            view.dispatch(view.state.tr.setSelection(selection));
            view.focus();
            return true;
        } catch (e) {
            console.error('[TableNodeView] Failed to apply dragged CellSelection:', e);
            return false;
        }
    }, [editor, getPos, getSafeCellPos, isEditable, node]);

    const updateSelectionRegion = useCallback(() => {
        if (!editor || typeof getPos !== 'function') {
            setSelectionRegion(null);
            return;
        }

        const startPos = getPos();
        if (startPos === undefined) {
            setSelectionRegion(null);
            return;
        }

        const { selection, doc } = editor.state;
        if (!(selection instanceof CellSelection)) {
            setSelectionRegion(null);
            return;
        }

        const currentTableNode = doc.nodeAt(startPos);
        const table = currentTableNode && currentTableNode.type.name === 'table' ? currentTableNode : node;
        const tablePos = startPos;

        if (selection.$anchorCell.start(-1) - 1 !== tablePos) {
            setSelectionRegion(null);
            return;
        }

        const tableStart = selection.$anchorCell.start(-1);
        const map = TableMap.get(table);
        const rect = map.rectBetween(
            selection.$anchorCell.pos - tableStart,
            selection.$headCell.pos - tableStart
        );

        setSelectionRegion({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
        });
    }, [editor, getPos, node]);

    const selectColumn = useCallback((colIndex: number) => {
        if (!isEditable || !editor || typeof getPos !== 'function') return;
        const startPos = getPos();
        if (startPos === undefined) return;
        const { state, view } = editor;
        const { doc } = state;
        
        // 🎯 动态拉取最新的 table 节点以防止 RangeError
        const currentTableNode = doc.nodeAt(startPos);
        const table = currentTableNode && currentTableNode.type.name === 'table' ? currentTableNode : node;
        
        const map = TableMap.get(table);
        // 保证 colIndex 在有效范围内
        if (colIndex < 0 || colIndex >= map.width) return;

        const startCellPos = map.positionAt(0, colIndex, table);
        const endCellPos = map.positionAt(table.childCount - 1, colIndex, table);
        
        const $anchor = getSafeCellPos(doc, startPos, startCellPos);
        const $head = getSafeCellPos(doc, startPos, endCellPos);
        
        try {
            const selection = new CellSelection($anchor, $head);
            view.dispatch(view.state.tr.setSelection(selection));
            view.focus();
        } catch (e) {
            console.error('[TableNodeView] Failed to create CellSelection for column:', e);
        }
    }, [editor, getPos, isEditable, node, getSafeCellPos]);

    const selectRow = useCallback((rowIndex: number) => {
        if (!isEditable || !editor || typeof getPos !== 'function') return;
        const startPos = getPos();
        if (startPos === undefined) return;
        const { state, view } = editor;
        const { doc } = state;
        
        // 🎯 动态拉取最新的 table 节点以防止 RangeError
        const currentTableNode = doc.nodeAt(startPos);
        const table = currentTableNode && currentTableNode.type.name === 'table' ? currentTableNode : node;
        
        const map = TableMap.get(table);
        // 保证 rowIndex 在有效范围内
        if (rowIndex < 0 || rowIndex >= map.height) return;
        
        let startCellPos = map.positionAt(rowIndex, 0, table);
        let endCellPos = map.positionAt(rowIndex, map.width - 1, table);
        
        const $anchor = getSafeCellPos(doc, startPos, startCellPos);
        const $head = getSafeCellPos(doc, startPos, endCellPos);
        
        try {
            const selection = new CellSelection($anchor, $head);
            view.dispatch(view.state.tr.setSelection(selection));
            view.focus();
        } catch (e) {
            console.error('[TableNodeView] Failed to create CellSelection for row:', e);
        }
    }, [editor, getPos, isEditable, node, getSafeCellPos]);

    const handleColumnClick = useCallback((colIndex: number, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isEditable) return;
        selectColumn(colIndex);
    }, [isEditable, selectColumn]);

    const handleRowClick = useCallback((rowIndex: number, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isEditable) return;
        selectRow(rowIndex);
    }, [isEditable, selectRow]);

    const handleContextMenu = useCallback((e: React.MouseEvent, context: 'row' | 'column' | 'cell', index?: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isEditable) return;
        if (context === 'column' && typeof index === 'number') selectColumn(index);
        if (context === 'row' && typeof index === 'number') selectRow(index);
        setMenu({ isOpen: true, position: { x: e.clientX, y: e.clientY }, context, index });
    }, [isEditable, selectColumn, selectRow]);

    const closeMenu = useCallback(() => {
        setMenu(prev => ({ ...prev, isOpen: false }));
    }, []);

    const handleTableMouseDownCapture = useCallback((e: React.MouseEvent<HTMLTableElement>) => {
        if (!isEditable || e.button !== 0) return;
        const coords = getCellCoordsFromElement(e.target);
        if (!coords) return;
        cellDragStateRef.current = {
            start: coords,
            current: coords,
            selecting: false,
        };
    }, [getCellCoordsFromElement, isEditable]);

    useEffect(() => {
        if (!isEditable) return;

        const handleMouseMove = (event: MouseEvent) => {
            const dragState = cellDragStateRef.current;
            if (!dragState) return;

            const target = document.elementFromPoint(event.clientX, event.clientY);
            const coords = getCellCoordsFromElement(target);
            if (!coords) return;

            const movedAcrossCells = coords.rowIndex !== dragState.start.rowIndex || coords.colIndex !== dragState.start.colIndex;
            if (!movedAcrossCells) return;

            dragState.current = coords;
            dragState.selecting = true;
            window.getSelection()?.removeAllRanges();
            event.preventDefault();
            applyCellSelection(dragState.start, coords);
        };

        const handleMouseUp = () => {
            cellDragStateRef.current = null;
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [applyCellSelection, getCellCoordsFromElement, isEditable]);

    useEffect(() => {
        if (!editor) return;

        updateSelectionRegion();
        editor.on('selectionUpdate', updateSelectionRegion);
        editor.on('transaction', updateSelectionRegion);
        return () => {
            editor.off('selectionUpdate', updateSelectionRegion);
            editor.off('transaction', updateSelectionRegion);
        };
    }, [editor, updateSelectionRegion]);

    // =========================================================
    //  PURE MOUSE DRAG LOGIC (Bypass HTML5 Curses)
    // =========================================================
    const handleHandleMouseDown = useCallback((e: React.MouseEvent, type: 'row' | 'column', index: number) => {
        if (!isEditable) return;
        if (e.button !== 0) return; // Only left-click
        e.preventDefault();
        e.stopPropagation();

        // 强制将 ProseMirror 的 Selection 设置到当前行/列
        // 否则 @tiptap/pm/tables 的 moveTableRow 等内部命令会因为 selection.$from 跑到了表格外（或者其他块）而静默失败
        if (type === 'row') {
            selectRow(index);
        } else {
            selectColumn(index);
        }

        console.log(`[Mouse Drag] Mousedown initiated for ${type} ${index}. Building phantom drag loop.`);
        updateDraggingContext({ type, index });

        const onMouseMove = (moveEv: MouseEvent) => {
            const dragCtx = dragCtxRef.current;
            if (!dragCtx) return;
            
            const mouseX = moveEv.clientX;
            const mouseY = moveEv.clientY;

            // Get live absolute bounds for the table in case of scrolling during drag
            const wrapper = wrapperRef.current;
            const table = wrapper?.querySelector('table');
            if (!table) return;
            const liveTableRect = table.getBoundingClientRect();
            // 🔍 鼠标坐标是物理像素，offset 是逻辑像素 → 转换为逻辑坐标
            const zoom = getZoomLevel();
            const relX = (mouseX - liveTableRect.left) / zoom;
            const relY = (mouseY - liveTableRect.top) / zoom;
            
            if (dragCtx.type === 'column') {
                const arr = columnHandlesRef.current;
                let closestIndex = arr[0]?.index || 0;
                let minDistance = Infinity;

                for (const col of arr) {
                    const center = col.offset + (col.size / 2);
                    const dist = Math.abs(relX - center);
                    if (dist < minDistance) {
                        minDistance = dist;
                        closestIndex = col.index;
                    }
                }
                if (dropTargetRef.current !== closestIndex) updateDropTargetIndex(closestIndex);
            } else {
                const arr = rowHandlesRef.current;
                let closestIndex = arr[0]?.index || 0;
                let minDistance = Infinity;

                for (const row of arr) {
                    const center = row.offset + (row.size / 2);
                    const dist = Math.abs(relY - center);
                    if (dist < minDistance) {
                        minDistance = dist;
                        closestIndex = row.index;
                    }
                }
                if (dropTargetRef.current !== closestIndex) updateDropTargetIndex(closestIndex);
            }
        };

        const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);

            const dragCtx = dragCtxRef.current;
            const targetIdx = dropTargetRef.current;
            
            console.log(`[Mouse Drag] Drag end detected. Final Target: ${targetIdx}`);

            if (dragCtx && targetIdx !== null && dragCtx.index !== targetIdx) {
                const sourceIndex = dragCtx.index;
                // Dispatch PM Transaction
                if (editor && typeof getPos === 'function') {
                    const startPos = getPos();
                    if (startPos !== undefined) {
                        const { state, view } = editor;
                        if (dragCtx.type === 'column') {
                            const cmd = moveTableColumn({ from: sourceIndex, to: targetIdx, select: true, pos: startPos + 1 });
                            const success = cmd(state, view.dispatch, view);
                            if (!success) console.error("PM Command moveTableColumn failed");
                        } else {
                            const cmd = moveTableRow({ from: sourceIndex, to: targetIdx, select: true, pos: startPos + 1 });
                            const success = cmd(state, view.dispatch, view);
                            if (!success) console.error("PM Command moveTableRow failed");
                        }
                        view.focus();
                    }
                }
            }

            updateDraggingContext(null);
            updateDropTargetIndex(null);
            dragCtxRef.current = null;
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, [editor, getPos, getZoomLevel, isEditable, selectColumn, selectRow]);

    // ✅ 核心修复：强制光标移到最后再执行添加
    const triggerCommand = useCallback((command: 'addColumnAfter' | 'addRowAfter') => {
        if (!isEditable || !editor || typeof getPos !== 'function') return;
        const startPos = getPos();
        if (startPos === undefined) return;

        const map = TableMap.get(node);

        // 1. 找到右下角最后一个单元格的位置
        const lastCellPos = map.positionAt(map.height - 1, map.width - 1, node);

        // 2. 计算绝对坐标：Table起始 + 1(Table标签) + 单元格偏移 + 1(进入单元格内部)
        const targetPos = startPos + 1 + lastCellPos + 1;

        // 3. 链式调用 - 动态执行命令
        const chain = editor.chain()
            .focus()
            .command(({ tr, dispatch }) => {
                if (dispatch) {
                    // 强制设置光标到最后一个单元格
                    const $pos = tr.doc.resolve(targetPos);
                    const selection = TextSelection.near($pos);
                    tr.setSelection(selection);
                }
                return true;
            });

        // 动态调用 addColumnAfter 或 addRowAfter
        (chain[command] as () => typeof chain)().run();
    }, [editor, getPos, isEditable, node]);

    // 使用新的触发器
    const addColumnAfter = useCallback(() => triggerCommand('addColumnAfter'), [triggerCommand]);
    const addRowAfter = useCallback(() => triggerCommand('addRowAfter'), [triggerCommand]);

    // 常量定义
    const HANDLE_SIZE = 16;
    const HANDLE_GAP = 4; // 手柄与表格的间隙 (Visual Gap)

    // 计算当前需要渲染覆盖层（边框）的目标上下文
    const overlayType = draggingContext ? draggingContext.type : (menu.isOpen ? menu.context : null);
    const overlayIndex = draggingContext ? dropTargetIndex : (menu.isOpen ? menu.index : null);
    const selectionOverlayStyle = selectionRegion
        ? {
              left: tableRect.left + (columnHandles[selectionRegion.left]?.offset ?? 0),
              top: tableRect.top + (rowHandles[selectionRegion.top]?.offset ?? 0),
              width:
                  selectionRegion.right > selectionRegion.left
                      ? (columnHandles
                            .slice(selectionRegion.left, selectionRegion.right)
                            .reduce((sum, col) => sum + col.size, 0) ?? 0)
                      : 0,
              height:
                  selectionRegion.bottom > selectionRegion.top
                      ? (rowHandles
                            .slice(selectionRegion.top, selectionRegion.bottom)
                            .reduce((sum, row) => sum + row.size, 0) ?? 0)
                      : 0,
          }
        : null;

    return (
        <NodeViewWrapper
            ref={wrapperRef}
            className={cn(
                "relative my-6 group block"  // Ensure block to capture sizing
            )}
        >
            {/* ====== 1. 列手柄区域 (Top) ====== */}
            {isEditable && <div
                className={cn(
                    "absolute z-10 flex",
                    "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
                    (menu.isOpen || draggingContext) && "opacity-100" // Keep visible while menu is open or dragging
                )}
                style={{
                    left: tableRect.left,
                    top: tableRect.top - HANDLE_SIZE - HANDLE_GAP,
                    width: tableRect.width,
                    height: HANDLE_SIZE
                }}
            >
                <div className="relative w-full h-full" contentEditable={false}>
                    {columnHandles.map((col) => {
                        const isActive = hoveredColumn === col.index || 
                                       (overlayType === 'column' && overlayIndex === col.index) ||
                                       (draggingContext?.type === 'column' && draggingContext.index === col.index);

                        return (
                            <div
                                key={col.index}
                                onMouseDown={(e) => { e.stopPropagation(); handleHandleMouseDown(e, 'column', col.index); }}
                                onClick={(e) => handleColumnClick(col.index, e)}
                                className={cn(
                                    "absolute top-0.5 h-full flex items-center justify-center cursor-grab active:cursor-grabbing rounded-md mx-px",
                                    "transition-all duration-200 box-border",
                                    isActive
                                        ? "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400"
                                        : "bg-transparent"
                                )}
                                style={{ 
                                    left: col.offset, 
                                    width: col.size - 2,
                                    border: isActive ? "2px solid #3b82f6" : "2px solid transparent"
                                }}
                                onMouseEnter={() => setHoveredColumn(col.index)}
                                onMouseLeave={() => setHoveredColumn(null)}
                                onContextMenu={(e) => handleContextMenu(e, 'column', col.index)}
                            >
                                <GripVertical size={12} className={cn(
                                    "text-current rotate-90 transition-opacity duration-200",
                                    isActive ? "opacity-100" : "opacity-0"
                                )} />
                            </div>
                        );
                    })}
                </div>
            </div>}

            {/* ====== 2. 行手柄区域 (Left) ====== */}
            {isEditable && <div
                className={cn(
                    "absolute z-10",
                    "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
                    (menu.isOpen || draggingContext) && "opacity-100" // Keep visible while menu is open or dragging
                )}
                contentEditable={false}
                style={{
                    left: tableRect.left - HANDLE_SIZE - HANDLE_GAP,
                    top: tableRect.top,
                    width: HANDLE_SIZE,
                    height: tableRect.height
                }}
            >
                {rowHandles.map((row) => {
                    const isActive = hoveredRow === row.index || 
                                   (overlayType === 'row' && overlayIndex === row.index) ||
                                   (draggingContext?.type === 'row' && draggingContext.index === row.index);

                    return (
                        <div
                            key={row.index}
                            onMouseDown={(e) => { e.stopPropagation(); handleHandleMouseDown(e, 'row', row.index); }}
                            onClick={(e) => handleRowClick(row.index, e)}
                            className={cn(
                                "absolute left-0.5 w-full flex items-center justify-center cursor-grab active:cursor-grabbing rounded-md my-px",
                                "transition-all duration-200 box-border",
                                isActive
                                    ? "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400"
                                    : "bg-transparent"
                            )}
                            style={{ 
                                top: row.offset, 
                                height: row.size - 2,
                                border: isActive ? "2px solid #3b82f6" : "2px solid transparent" 
                            }}
                            onMouseEnter={() => setHoveredRow(row.index)}
                            onMouseLeave={() => setHoveredRow(null)}
                            onContextMenu={(e) => handleContextMenu(e, 'row', row.index)}
                        >
                            <GripVertical size={12} className={cn(
                                "text-current transition-opacity duration-200",
                                isActive ? "opacity-100" : "opacity-0"
                            )} />
                        </div>
                    );
                })}
            </div>}

            {/* ====== Unified Selection & Drop Indicator Overlay ====== */}
            {isEditable && overlayType && overlayIndex !== null && overlayIndex !== undefined && (
                <div
                    className="absolute z-20 pointer-events-none bg-blue-100/30 dark:bg-blue-900/20 rounded-sm transition-all duration-100 box-border"
                    style={
                        overlayType === 'column'
                            ? {
                                  left: tableRect.left + (columnHandles.find(c => c.index === overlayIndex)?.offset ?? 0),
                                  top: tableRect.top,
                                  width: (columnHandles.find(c => c.index === overlayIndex)?.size ?? 0),
                                  height: tableRect.height,
                                  border: "2px solid #3b82f6"
                              }
                            : {
                                  left: tableRect.left,
                                  top: tableRect.top + (rowHandles.find(r => r.index === overlayIndex)?.offset ?? 0),
                                  width: tableRect.width,
                                  height: (rowHandles.find(r => r.index === overlayIndex)?.size ?? 0),
                                  border: "2px solid #3b82f6"
                              }
                    }
                />
            )}

            {isEditable && selectionOverlayStyle && selectionOverlayStyle.width > 0 && selectionOverlayStyle.height > 0 && (
                <div
                    className="absolute pointer-events-none rounded-sm box-border"
                    style={{
                        ...selectionOverlayStyle,
                        zIndex: 15,
                        background: 'rgba(59, 130, 246, 0.14)',
                        border: '2px solid #3b82f6',
                    }}
                />
            )}

            {/* ====== 3. 真实表格渲染 ====== */}
            <div ref={scrollContainerRef} className="overflow-x-auto pb-1 tiptap-scroll-container">
                {/* Removed overly-verbose full-screen ghost indicators that caused stray white lines */}
                
                <table
                    ref={tableRef}
                    className="tiptap-table-wrapper"
                    onMouseDownCapture={handleTableMouseDownCapture}
                    style={{
                        borderCollapse: 'collapse',
                    }}
                >
                    <NodeViewContent as={TBody as any} />
                </table>
            </div>

            {/* ====== 底部添加行条 (Ghost Row) ====== */}
            {isEditable && <div
                className={cn(
                    "absolute flex items-center justify-center cursor-pointer",
                    "box-border border-2 border-transparent rounded-md my-px mx-px",
                    "bg-transparent hover:bg-blue-100 dark:hover:bg-blue-900/40",
                    "text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300",
                    "transition-all duration-200 z-20",
                    "opacity-0 group-hover:opacity-100"
                )}
                style={{
                    top: tableRect.top + tableRect.height + HANDLE_GAP,
                    left: tableRect.left,
                    width: tableRect.width - 2,
                    height: HANDLE_SIZE
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = 'transparent'}
                onClick={addRowAfter}
                title={t('editor.table.clickToAddRow') || '点击添加一行'}
            >
                <Plus size={12} />
            </div>}

            {/* ====== 5. 右侧添加列条 (Ghost Column) ====== */}
            {isEditable && <div
                className={cn(
                    "absolute flex items-center justify-center cursor-pointer",
                    "box-border border-2 border-transparent rounded-md mx-px my-px",
                    "bg-transparent hover:bg-blue-100 dark:hover:bg-blue-900/40",
                    "text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300",
                    "transition-all duration-200 z-20",
                    "opacity-0 group-hover:opacity-100"
                )}
                style={{
                    left: tableRect.left + tableRect.width + HANDLE_GAP,
                    top: tableRect.top,
                    width: HANDLE_SIZE,
                    height: tableRect.height - 2
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = 'transparent'}
                onClick={addColumnAfter}
                title={t('editor.table.clickToAddColumn') || '点击添加一列'}
            >
                <Plus size={12} />
            </div>}

            {editor && isEditable && (
                <TableMenu
                    editor={editor}
                    isOpen={menu.isOpen}
                    position={menu.position}
                    context={menu.context}
                    index={menu.index} // ✅ 1. 传递索引
                    onClose={closeMenu}
                    // ✅ 2. 传递选中方法，让菜单可以“远程遥控”
                    onSelectRow={selectRow}
                    onSelectColumn={selectColumn}
                />
            )}
        </NodeViewWrapper>
    );
};
