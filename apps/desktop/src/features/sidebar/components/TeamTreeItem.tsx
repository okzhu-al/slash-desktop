import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Folder, ChevronRight, FileText, Edit2, Trash2 } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { cn } from "@/shared/utils/cn";
import type { TeamTreeNode } from '@/services/SyncService';

export interface TeamTreeItemProps {
    node: TeamTreeNode;
    depth: number;
    expandedDirs: Set<string>;
    onToggleDir: (path: string) => void;
    onFileClick: (path: string, editorName?: string, fileId?: string | null) => void;
    onDirClick?: (path: string, name: string) => void;
    activeDirPath?: string;
    activeNotePath?: string;
    activeNoteFileId?: string | null;
    isAdmin?: boolean;
    isMaintenanceMode?: boolean;
    onDeleteDir?: (path: string, name: string) => void;
    onDeleteFile?: (path: string, name: string) => void;
    onRenameDir?: (path: string, name: string, newName?: string) => void;
    onRenameFile?: (path: string, name: string, newName?: string) => void;
}

export function TeamTreeItem({ 
    node, 
    depth, 
    expandedDirs, 
    onToggleDir, 
    onFileClick, 
    onDirClick, 
    activeDirPath, 
    activeNotePath, 
    activeNoteFileId,
    isAdmin, 
    isMaintenanceMode,
    onDeleteDir, 
    onDeleteFile, 
    onRenameDir,
    onRenameFile
}: TeamTreeItemProps) {
    const { t } = useTranslation();
    const isExpanded = expandedDirs.has(node.path);
    const paddingLeft = 8 + depth * 16;

    // PARA 根目录（01_PROJECTS, 02_AREAS 等）不可拖拽
    const isParaRoot = depth === 0 && /^(01_PROJECTS|02_AREAS|03_RESOURCE|04_ARCHIVE)$/i.test(node.name);

    // Admin DnD hooks
    const {
        attributes: dragAttributes,
        listeners: dragListeners,
        setNodeRef: setDragRef,
        isDragging,
    } = useDraggable({
        id: `team-${node.path}`,
        data: { teamNode: node },
        disabled: !isAdmin || isParaRoot,
    });
    const {
        setNodeRef: setDropRef,
        isOver,
    } = useDroppable({
        id: `team-drop-${node.path}`,
        data: { teamNode: node },
        disabled: !node.is_dir,
    });

    // combine refs
    const combinedRef = useCallback((el: HTMLElement | null) => {
        setDragRef(el);
        if (node.is_dir) setDropRef(el);
    }, [setDragRef, setDropRef, node.is_dir]);

    if (node.is_dir) {
        const hasChildren = node.children && node.children.length > 0;
        const isDirActive = activeDirPath === node.path;

        const dirContent = (
            <div
                ref={combinedRef}
                {...((isAdmin && !isParaRoot) ? dragListeners : {})}
                {...((isAdmin && !isParaRoot) ? dragAttributes : {})}
                data-droppable-id={`team-drop-${node.path}`}
                className={cn(
                    'w-full flex items-center gap-1 py-[5px] px-2 text-sm rounded-sm transition-colors duration-150 select-none',
                    'text-zinc-600 dark:text-zinc-400',
                    isDirActive
                        ? 'bg-black/10 dark:bg-white/10 text-zinc-900 dark:text-zinc-100'
                        : 'hover:bg-black/5 dark:hover:bg-white/5',
                    isOver && 'ring-2 ring-inset ring-indigo-500',
                    isDragging && 'opacity-40',
                )}
                style={{ paddingLeft }}
            >
                {/* 箭头区：展开/折叠 */}
                <div
                    className="w-4 flex items-center justify-center shrink-0 cursor-pointer text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors duration-150"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleDir(node.path);
                    }}
                >
                    <ChevronRight
                        size={14}
                        strokeWidth={1}
                        className={cn('shrink-0 transition-transform', isExpanded && 'rotate-90')}
                    />
                </div>
                {/* 图标+名称区：仅打开管理页面 */}
                <div
                    className="flex items-center gap-1 flex-1 min-w-0 cursor-pointer transition-colors duration-150"
                    onClick={(e) => {
                        e.stopPropagation();
                        onDirClick?.(node.path, node.name);
                    }}
                >
                    <div className="w-4 flex items-center justify-center shrink-0">
                        <Folder size={16} strokeWidth={1} className="text-[#002FA7]/70 dark:text-blue-400/80 shrink-0" />
                    </div>
                    <span className="truncate">{node.name}</span>
                </div>
            </div>
        );

        return (
            <div>
                {isAdmin && !isParaRoot ? (
                    <ContextMenu>
                        <ContextMenuTrigger className="block">
                            {dirContent}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                            <ContextMenuItem onClick={() => onRenameDir?.(node.path, node.name)}>
                                <Edit2 size={14} className="mr-2" />{t('team.admin_rename')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            {isMaintenanceMode ? (
                                <ContextMenuItem 
                                    onClick={() => onRenameDir?.(node.path, node.name, node.name + t('team.admin_pre_delete_suffix', { defaultValue: '(预删除)'}))} 
                                    className="text-amber-600 focus:text-amber-600 focus:bg-amber-50 dark:focus:bg-amber-950/50"
                                >
                                    <Trash2 size={14} className="mr-2" />
                                    {t('team.admin_pre_delete')}
                                </ContextMenuItem>
                            ) : (
                                <ContextMenuItem 
                                    onClick={() => onDeleteDir?.(node.path, node.name)} 
                                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50"
                                >
                                    <Trash2 size={14} className="mr-2" />
                                    {t('team.admin_delete_dir')}
                                </ContextMenuItem>
                            )}
                        </ContextMenuContent>
                    </ContextMenu>
                ) : dirContent}
                {isExpanded && node.children && (
                    <div className="relative">
                        {/* Indent guide line */}
                        <div
                            className="absolute border-l border-zinc-200 dark:border-zinc-700/50 h-full"
                            style={{ left: `${depth * 16 + 16}px`, top: 0 }}
                        />
                        {node.children.map(child => (
                            <TeamTreeItem
                                key={child.path}
                                node={child}
                                depth={depth + 1}
                                expandedDirs={expandedDirs}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                                onDirClick={onDirClick}
                                activeDirPath={activeDirPath}
                                activeNotePath={activeNotePath}
                                activeNoteFileId={activeNoteFileId}
                                isAdmin={isAdmin}
                                isMaintenanceMode={isMaintenanceMode}
                                onDeleteDir={onDeleteDir}
                                onDeleteFile={onDeleteFile}
                                onRenameDir={onRenameDir}
                                onRenameFile={onRenameFile}
                            />
                        ))}
                        {!hasChildren && (
                            <div style={{ paddingLeft: paddingLeft + 16 }} className="py-1 text-[10px] text-zinc-400 dark:text-zinc-500 italic">
                                {t('team.dir_empty')}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    // 文件节点
    const isFileActive = activeNotePath === `__team__/${node.path}`
        || Boolean(activeNoteFileId && node.file_id && activeNoteFileId === node.file_id);

    const fileContent = (
        <button
            ref={isAdmin ? setDragRef : undefined}
            {...(isAdmin ? dragListeners : {})}
            {...(isAdmin ? dragAttributes : {})}
            onClick={() => onFileClick(node.path, node.editor_display_name || node.editor_username || undefined, node.file_id)}
            className={cn(
                'w-full flex items-center gap-1 py-[5px] px-2 text-sm rounded-sm transition-colors duration-150 select-none',
                'text-zinc-600 dark:text-zinc-400',
                isFileActive
                    ? 'bg-black/10 dark:bg-white/10 text-zinc-900 dark:text-zinc-100'
                    : 'hover:bg-black/5 dark:hover:bg-white/5',
                isDragging && 'opacity-40',
            )}
            style={{ paddingLeft: paddingLeft + 20 }}
        >
            <FileText size={16} strokeWidth={1} className={cn("shrink-0", isFileActive ? "text-[#002FA7]/70" : "text-zinc-500 dark:text-zinc-400")} />
            <span className="truncate flex-1 text-left">{node.name}</span>
        </button>
    );

    if (isAdmin) {
        return (
            <ContextMenu>
                <ContextMenuTrigger className="block">
                    {fileContent}
                </ContextMenuTrigger>
                <ContextMenuContent>
                    {isMaintenanceMode ? (
                        <ContextMenuItem 
                            onClick={() => onRenameFile?.(node.path, node.name, node.name.replace(/\.md$/, '') + t('team.admin_pre_delete_suffix', { defaultValue: '(预删除)'}) + '.md')} 
                            className="text-amber-600 focus:text-amber-600 focus:bg-amber-50 dark:focus:bg-amber-950/50"
                        >
                            <Trash2 size={14} className="mr-2" />
                            {t('team.admin_pre_delete')}
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem 
                            onClick={() => onDeleteFile?.(node.path, node.name)} 
                            className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50"
                        >
                            <Trash2 size={14} className="mr-2" />{t('team.admin_delete_file')}
                        </ContextMenuItem>
                    )}
                </ContextMenuContent>
            </ContextMenu>
        );
    }

    return fileContent;
}
