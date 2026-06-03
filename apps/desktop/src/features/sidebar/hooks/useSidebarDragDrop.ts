import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
    useSensors,
    useSensor,
    MouseSensor,
    DragStartEvent,
    DragEndEvent,
    CollisionDetection
} from '@dnd-kit/core';
import type { FileSystemItem } from '@/core/fs/types';
import { getBasename, getParentPath } from '@/shared/utils/pathUtils';
import { moveTeamMappedItemFromLocalTree } from '../utils/teamLocalMove';
interface UseSidebarDragDropProps {
    rootDir?: string;
    hasTeamVault: boolean;
    teamDirectories: Map<string, any>;
    refreshTree: () => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
}

export function useSidebarDragDrop({
    rootDir,
    hasTeamVault,
    teamDirectories,
    refreshTree,
    onNoteRenamed
}: UseSidebarDragDropProps) {
    const { t } = useTranslation();

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 8, // Require 8px drag before activating
            },
        })
    );

    const [activeDragItem, setActiveDragItem] = useState<FileSystemItem | null>(null);
    const isDraggingRef = useRef(false);
    const lastDropTargetRef = useRef<{ path: string; item: FileSystemItem } | null>(null);

    // 拖拽高亮：手动 rect 遍历
    useEffect(() => {
        let prevHighlightRow: HTMLElement | null = null;

        const onMove = (e: MouseEvent) => {
            if (!isDraggingRef.current) return;
            const my = e.clientY;
            const mx = e.clientX;

            const droppables = document.querySelectorAll('[data-droppable-id]');
            const hit = { el: null as HTMLElement | null, id: null as string | null };
            droppables.forEach(el => {
                const rect = el.getBoundingClientRect();
                if (mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom) {
                    hit.el = el as HTMLElement;
                    hit.id = (el as HTMLElement).dataset.droppableId || null;
                }
            });

            if (prevHighlightRow && prevHighlightRow !== hit.el) {
                prevHighlightRow.style.boxShadow = '';
            }

            lastDropTargetRef.current = null;
            if (hit.el && hit.id) {
                hit.el.style.boxShadow = 'inset 0 0 0 2px rgb(99 102 241)';
                prevHighlightRow = hit.el;
                const path = hit.id.replace(/^drop-/, '');
                const name = getBasename(path) || path;
                lastDropTargetRef.current = { path, item: { id: path, name, path, type: 'folder', children: [] } };
            } else {
                prevHighlightRow = null;
            }
        };

        window.addEventListener('mousemove', onMove, true);
        return () => window.removeEventListener('mousemove', onMove, true);
    }, []);

    const noopCollision: CollisionDetection = useCallback(() => [], []);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        const item = event.active.data.current?.item as FileSystemItem | undefined;
        setActiveDragItem(item || null);
        isDraggingRef.current = true;
        lastDropTargetRef.current = null;
    }, []);

    const handleDragEnd = useCallback(async (event: DragEndEvent) => {
        isDraggingRef.current = false;
        setActiveDragItem(null);
        
        document.querySelectorAll('[data-droppable-id]').forEach(el => {
            (el as HTMLElement).style.boxShadow = '';
        });

        const draggedItem = event.active.data.current?.item as FileSystemItem | undefined;
        const dropTarget = lastDropTargetRef.current;
        lastDropTargetRef.current = null;

        if (!draggedItem || !dropTarget) return;
        if (dropTarget.item.type !== 'folder') return;

        const draggedParent = getParentPath(draggedItem.path);
        if (draggedParent === dropTarget.path) return;
        if (draggedItem.path === dropTarget.path) return;

        // 团队目录内的本地树拖拽必须走 Team API，由服务端按 Owner/editor 规则裁决。
        if (hasTeamVault && teamDirectories.size > 0) {
            const teamMoveResult = await moveTeamMappedItemFromLocalTree({
                rootDir,
                sourcePath: draggedItem.path,
                destFolder: dropTarget.path,
                isDirectory: draggedItem.type === 'folder',
                teamDirectories,
                t,
            });
            if (teamMoveResult.handled) {
                if (teamMoveResult.newPath && draggedItem.path.endsWith('.md')) {
                    onNoteRenamed?.(draggedItem.path, teamMoveResult.newPath);
                }
                refreshTree();
                return;
            }
        }

        try {

            const newPath = await invoke<string>('move_file', {
                sourcePath: draggedItem.path,
                destFolder: dropTarget.path,
                vaultPath: rootDir || '',
            });


            if (draggedItem.path.endsWith('.md')) {
                onNoteRenamed?.(draggedItem.path, newPath);
            }

            if (rootDir) {
                refreshTree();
            }
        } catch (error) {
            console.error('❌ Move failed:', error);
        }
    }, [hasTeamVault, teamDirectories, rootDir, onNoteRenamed, refreshTree, t]);

    return {
        sensors,
        activeDragItem,
        noopCollision,
        handleDragStart,
        handleDragEnd
    };
}
