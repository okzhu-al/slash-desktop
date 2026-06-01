import { FileSystemItem } from "@/core/fs/types";
import { ChevronRight, ChevronDown, Folder, FileText, Trash2, FolderPlus, FilePlus, Copy, Edit2, ArrowUpRight, FolderInput, Users } from "lucide-react";
import { cn } from "@/shared/utils/cn";
import { useFileSystemStore } from "@/core/fs/store";
import { useCollabNotifyStore } from "@/stores/useCollabNotifyStore";
import { getBasename, normalizePath } from "@/shared/utils/pathUtils";
import { useTranslation } from "react-i18next";
import { useState, useRef, useEffect } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    ContextMenuSub,
    ContextMenuSubTrigger,
    ContextMenuSubContent,
} from "@/shared/ui/context-menu";
import { FileSystemActions } from "./types";

// Folders hidden from sidebar
const HIDDEN_FOLDERS = ['assets', '.slash'];

// PARA root folders that cannot be renamed or deleted
const PARA_ROOT_FOLDERS = ['00_Inbox', '01_Projects', '02_Areas', '03_Resources', '04_Archives'];

interface FileTreeItemProps {
    item: FileSystemItem;
    level: number;
    onSelect: (item: FileSystemItem) => void;
    activeId?: string;
    actions?: FileSystemActions;
}

export const FileTreeItem = ({ item, level, onSelect, activeId, actions }: FileTreeItemProps) => {
    const { t } = useTranslation();
    const { toggleFolder } = useFileSystemStore();
    const isFolder = item.type === 'folder';
    const isOpen = item.isOpen;
    const isActive = activeId === item.id;

    // 🛡️ Windows 兼容：统一正斜杠，与 useTeamDirectoryMapping 输出的 key 对齐
    const normItemPath = item.path.replace(/\\/g, '/');

    // T-4: 判断当前项是否在目前处于活动状态的团队管理内
    const isTeamRoot = actions?.teamRoots?.has(normItemPath) ?? false;

    // Check if this is a protected PARA root folder (level 0 = vault root)
    const isProtectedParaFolder = isFolder && level === 0 && PARA_ROOT_FOLDERS.includes(item.name);

    // T-4: 判断当前项是否在活动团队的目录内
    const isTeamItem: boolean = (() => {
        if (isProtectedParaFolder) return false;
        const roots = actions?.teamRoots;
        if (!roots || roots.size === 0) return false;
        if (roots.has(normItemPath)) return true;
        for (const root of roots) {
            if (normItemPath.startsWith(root + '/')) return true;
        }
        return false;
    })();
    
    // 协作未读标识：文件夹能够透传子孙节点的红点
    const unreadFiles = useCollabNotifyStore(s => s.unreadFiles);
    const unreadFolders = useCollabNotifyStore(s => s.unreadFolders);

    // 协作映射信息提取：统合 Local Mapping 和 Team Native 结构
    const teamMapping = (() => {
        if (item.path.startsWith('__team__/')) {
            const parts = normalizePath(item.path).split('/');
            if (parts.length >= 3) {
                return { vaultId: parts[1], remotePath: parts.slice(2).join('/') };
            }
            return null;
        }

        const dirs = actions?.teamDirectories;
        if (!dirs || dirs.size === 0) return null;

        // 🛡️ Windows 兼容：使用 normItemPath 和已 normalize 的 key 对比
        if (dirs.has(normItemPath)) return dirs.get(normItemPath);

        for (const [dirPath, info] of dirs) {
            if (normItemPath.startsWith(dirPath + '/')) {
                const subPath = normItemPath.slice(dirPath.length); // starts with '/'
                return { vaultId: info.vaultId, remotePath: info.remotePath + subPath };
            }
        }
        return null;
    })();

    const teamRelPath = isProtectedParaFolder ? '' : (teamMapping?.remotePath || '');

    const hasFolderJoinedBadge = isFolder && Boolean(teamRelPath) && unreadFolders.has(teamRelPath);

    const hasCollabUnread = !isProtectedParaFolder && unreadFiles.size > 0 && (() => {
        const itemLower = item.name.toLowerCase();

        if (!teamRelPath) {
            if (!isFolder && item.name.endsWith('.md')) {
                return [...unreadFiles.keys()].some(p => {
                    const pLower = p.toLowerCase();
                    return pLower === itemLower || pLower.endsWith('/' + itemLower);
                });
            }
            if (isFolder) {
                return [...unreadFiles.keys()].some(p => p.toLowerCase().includes('/' + itemLower + '/'));
            }
            return false;
        }

        const teamRelLower = teamRelPath.toLowerCase();

        if (!isFolder) {
            // [DEBUG] 追踪遗失的红点匹配过程
            if (item.name.includes('b2') || item.name.includes("A'note")) {
                console.log(`[DEBUG-REDDOT] 正在渲染: ${item.name}`);
                console.log(`[DEBUG-REDDOT]   -> 计算出的 teamRelPath: "${teamRelPath}"`);
                console.log(`[DEBUG-REDDOT]   -> 当前内存中的 unreadFiles:`, [...unreadFiles.keys()]);
            }

            // 文件级节点：强化匹配
            if (unreadFiles.has(teamRelPath)) return true;
            
            // 暴力兜底：忽略大小写、剥除全半角瑕疵、以及潜在丢失 .md 的兼容匹配
            const baseTarget = teamRelLower.endsWith('.md') ? teamRelLower.slice(0, -3) : teamRelLower;
            const fallbackTarget = getBasename(baseTarget)?.trim(); // 叶子纯名
            
            return [...unreadFiles.keys()].some(k => {
                const kLower = k.toLowerCase();
                if (kLower === teamRelLower) return true;
                const kBase = kLower.endsWith('.md') ? kLower.slice(0, -3) : kLower;
                if (kBase === baseTarget) return true;
                if (fallbackTarget && kBase.endsWith('/' + fallbackTarget)) return true;
                return false;
            });
        } else {
            // 目录级节点
            const keys = [...unreadFiles.keys()];
            return keys.some(p => p.toLowerCase().startsWith(teamRelLower + '/'));
        }
    })();


    // Inline editing state (centralized in Sidebar via actions)
    const isEditing = actions?.editingPath === item.path;
    const [editValue, setEditValue] = useState(item.name);
    const inputRef = useRef<HTMLInputElement>(null);
    const hasFocusedRef = useRef(false); // Track if we've successfully focused
    const focusTimeRef = useRef(0); // Track when focus was established

    // 🆕 Drag and Drop hooks
    const {
        attributes: dragAttributes,
        listeners: dragListeners,
        setNodeRef: setDragRef,
        isDragging,
    } = useDraggable({
        id: item.path,
        data: { item },
        disabled: isEditing || isProtectedParaFolder, // Don't drag while editing or protected folders
    });

    const {
        setNodeRef: setDropRef,
        isOver,
    } = useDroppable({
        id: `drop-${item.path}`,
        data: { item },
        disabled: !isFolder, // Only folders can be drop targets
    });

    // 🆕 External file drop state (from desktop/finder)
    // Visual feedback only - actual drop handling is in Sidebar via Tauri events
    const [isExternalDragOver, setIsExternalDragOver] = useState(false);

    const handleExternalDragOver = (e: React.DragEvent) => {
        if (!isFolder) return;
        // Check if this is an external drag (has files)
        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            setIsExternalDragOver(true);
            // Store the current folder path globally for Tauri drop handler
            (window as any).__slashDropTargetFolder = item.path;
            console.log(`📂 [DragOver] Target folder set: ${item.path}`);
        }
    };

    const handleExternalDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsExternalDragOver(false);
        // Don't clear __slashDropTargetFolder here - Tauri event fires after this
        // Sidebar's Tauri listener will clear it after processing
    };

    const handleExternalDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsExternalDragOver(false);
        // Note: The actual file copy is handled by Tauri native events in Sidebar
        // Don't clear __slashDropTargetFolder here - Tauri event is async
    };

    // Focus and select input when editing starts
    useEffect(() => {
        if (isEditing && inputRef.current) {
            hasFocusedRef.current = false; // Reset on edit start
            focusTimeRef.current = 0;
            // Use longer setTimeout to ensure ContextMenu is fully closed before focusing
            const timer = setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                    hasFocusedRef.current = true; // Mark as focused
                    focusTimeRef.current = Date.now(); // Record focus time
                    // Select only the filename without .md extension for notes
                    const name = item.name;
                    const extIndex = name.lastIndexOf('.md');
                    if (extIndex > 0 && item.type === 'file') {
                        inputRef.current.setSelectionRange(0, extIndex);
                    } else {
                        inputRef.current.select();
                    }
                }
            }, 50); // 50ms delay to ensure ContextMenu is fully closed
            return () => clearTimeout(timer);
        } else {
            hasFocusedRef.current = false; // Reset when not editing
            focusTimeRef.current = 0;
        }
    }, [isEditing, item.name, item.type]);

    // Reset edit value when editing starts
    useEffect(() => {
        if (isEditing) {
            setEditValue(item.name);
        }
    }, [isEditing, item.name]);

    const clearFolderBadgeIfAny = () => {
        if (hasFolderJoinedBadge && teamMapping && teamRelPath) {
            useCollabNotifyStore.getState().markFolderBadgeRead(teamRelPath, teamMapping.vaultId);
        }
    };

    const handleChevronClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isFolder) {
            toggleFolder(item.path, !isOpen);
            clearFolderBadgeIfAny();
        }
    };

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isEditing) return;

        if (isFolder) {
            actions?.onSelectProjectFolder?.(item);
            clearFolderBadgeIfAny();
        } else {
            onSelect(item);
        }
    };

    const startRename = () => {
        setEditValue(item.name);
        actions?.onStartEditing(item.path);
    };

    const confirmEdit = async () => {
        // Only confirm if we've actually focused AND focus has been stable for at least 100ms
        // This prevents blur from firing immediately after focus due to ContextMenu closing
        const elapsed = Date.now() - focusTimeRef.current;
        if (!hasFocusedRef.current || elapsed < 100) {
            return;
        }
        if (editValue.trim() && editValue !== item.name) {
            await actions?.onConfirmRename(item, editValue);
        }
        actions?.onStopEditing();
    };

    const cancelEdit = () => {
        setEditValue(item.name);
        actions?.onStopEditing();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    };

    // Filter children to hide system folders (assets, .slash)
    const visibleChildren = item.children?.filter(child =>
        !HIDDEN_FOLDERS.includes(child.name)
    );

    return (
        <div
            onDragOver={handleExternalDragOver}
            onDragLeave={handleExternalDragLeave}
            onDrop={handleExternalDrop}
            data-folder-path={isFolder ? item.path : undefined}
            className="select-none"
        >
            <ContextMenu>
                <ContextMenuTrigger>
                    <div
                        ref={(node) => { setDragRef(node); setDropRef(node); }}
                        {...dragListeners}
                        {...dragAttributes}
                        data-droppable-id={isFolder ? `drop-${item.path}` : undefined}
                        className={cn(
                            "group flex items-center gap-1 py-[5px] px-2 rounded-sm cursor-pointer transition-colors duration-150 text-sm",
                            "text-zinc-600 dark:text-zinc-400",
                            (isOver || isExternalDragOver) && isFolder && "ring-1 ring-zinc-400 dark:ring-zinc-500 bg-zinc-100 dark:bg-zinc-800",
                            (() => {
                                const hasPending = !isFolder && actions?.pendingTitlePaths && Array.from(actions.pendingTitlePaths).some(
                                    (pending) => item.path.endsWith('/' + pending) || item.path.endsWith('\\' + pending)
                                );
                                if (hasPending) {
                                    return "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400";
                                }
                                return isActive
                                    ? "bg-black/10 dark:bg-white/10 text-zinc-900 dark:text-zinc-100"
                                    : "hover:bg-black/5 dark:hover:bg-white/5";
                            })(),
                            isDragging && "opacity-40"
                        )}
                        style={{ paddingLeft: `${level * 16 + 8}px` }}
                        onClick={handleClick}
                        title={(() => {
                            const hasPending = !isFolder && actions?.pendingTitlePaths && Array.from(actions.pendingTitlePaths).some(
                                (pending) => item.path.endsWith('/' + pending) || item.path.endsWith('\\' + pending)
                            );
                            return hasPending ? "AI 已建议新标题" : undefined;
                        })()}
                    >
                        {/* Chevron — 淡灰极简箭头 */}
                        <div
                            className={cn(
                                "w-4 flex items-center justify-center shrink-0 text-zinc-400 dark:text-zinc-500",
                                isFolder && "cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors duration-150"
                            )}
                            onClick={isFolder ? handleChevronClick : undefined}
                        >
                            {isFolder && (
                                isOpen ? <ChevronDown size={14} strokeWidth={1} /> : <ChevronRight size={14} strokeWidth={1} />
                            )}
                        </div>

                        {/* Icon — 个人=灰, 团队=淡靛蓝 */}
                        <div className="w-4 flex items-center justify-center shrink-0">
                            {isFolder ? (
                                <Folder size={16} strokeWidth={1} className={cn(
                                    isTeamItem
                                        ? 'text-[#002FA7]/70 dark:text-blue-400/80'
                                        : 'text-zinc-500 dark:text-zinc-400'
                                )} />
                            ) : (
                                <FileText size={16} strokeWidth={1} className={cn(
                                    isTeamItem
                                        ? 'text-[#002FA7]/70 dark:text-blue-400/80'
                                        : 'text-zinc-500 dark:text-zinc-400'
                                )} />
                            )}
                        </div>

                        {/* Name */}
                        {isEditing ? (
                            <input
                                ref={inputRef}
                                type="text"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onBlur={confirmEdit}
                                onClick={(e) => e.stopPropagation()}
                                className="flex-1 px-1 py-0 text-sm bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm outline-none text-zinc-900 dark:text-zinc-100 focus:border-zinc-400 dark:focus:border-zinc-500"
                            />
                        ) : (
                            <span className="truncate flex-1">
                                {item.name.replace(/\.md$/, '')}
                            </span>
                        )}

                        {/* 团队根徽章 — 仅限非顶层根目录显示（避免跟 PARA 根目录混淆） */}
                        {isTeamRoot && !isProtectedParaFolder && (
                            <div className="ml-auto shrink-0 opacity-0 group-hover:opacity-60 transition-opacity duration-200">
                                <Users size={13} strokeWidth={1} className="text-zinc-500 dark:text-zinc-400" />
                            </div>
                        )}

                        {/* 通知标记 — 始终可见 */}
                        {hasFolderJoinedBadge ? (
                            <span className="ml-auto shrink-0 px-1 py-px text-[8px] font-semibold tracking-wider text-white bg-indigo-500 dark:bg-indigo-600 rounded uppercase antialiased">
                                NEW
                            </span>
                        ) : hasCollabUnread ? (
                            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                        ) : null}
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    {isFolder ? (
                        <>
                            <ContextMenuItem onClick={() => actions?.onNewNote(item)}>
                                <FilePlus className="mr-2 h-4 w-4" />
                                {t('sidebar.new_note')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => actions?.onNewFolder(item)}>
                                <FolderPlus className="mr-2 h-4 w-4" />
                                {t('sidebar.new_folder')}
                            </ContextMenuItem>
                            {actions?.onPromoteToTeam && !isProtectedParaFolder && !isTeamRoot && !actions.teamDirectories?.has(item.path) && (() => {
                                // Build tree from flat directory paths
                                type DirNode = { name: string; path: string; children: DirNode[] };
                                const dirs = actions.teamDirectoryOptions || ['01_PROJECTS', '02_AREAS', '03_RESOURCE', '04_ARCHIVE'];
                                const rootNodes: DirNode[] = [];
                                const nodeMap = new Map<string, DirNode>();

                                // Sort to ensure parent dirs come first
                                const sortedDirs = [...dirs].sort();
                                for (const dirPath of sortedDirs) {
                                    const parts = normalizePath(dirPath).split('/');
                                    const node: DirNode = { name: parts[parts.length - 1], path: dirPath, children: [] };
                                    nodeMap.set(dirPath, node);
                                    const parentPath = parts.slice(0, -1).join('/');
                                    const parentNode = parentPath ? nodeMap.get(parentPath) : null;
                                    if (parentNode) {
                                        parentNode.children.push(node);
                                    } else {
                                        rootNodes.push(node);
                                    }
                                }

                                const rootPath = useFileSystemStore.getState().root?.path || '';
                                const normRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
                                const relPath = normItemPath.startsWith(normRoot + '/')
                                    ? normItemPath.slice(normRoot.length + 1)
                                    : normItemPath;
                                const sourceParaRoot = normalizePath(relPath).split('/')[0];
                                const sourcePrefix = sourceParaRoot.split('_')[0];

                                const TeamDirMenuItem = ({ node }: { node: DirNode }) => {
                                    const nodePrefix = normalizePath(node.path).split('/')[0].split('_')[0];
                                    const isMatch = sourcePrefix === nodePrefix;
                                    // 若不匹配前缀或处于整体大盘维护模式，则全部强制 Disabled
                                    const isDisabled = !isMatch || !!actions.isMaintenanceMode;

                                    if (node.children.length > 0 && !isDisabled) {
                                        return (
                                            <div key={node.path} title={actions.isMaintenanceMode ? t('team.maintenance_promote_hint') : undefined}>
                                                <ContextMenuSub>
                                                    <ContextMenuSubTrigger disabled={!!actions.isMaintenanceMode}>
                                                        <Folder className="mr-2 h-4 w-4" />
                                                        {node.name}
                                                    </ContextMenuSubTrigger>
                                                    <ContextMenuSubContent>
                                                        <ContextMenuItem onClick={() => actions.onPromoteToTeam!(item, node.path)}>
                                                            <FolderInput className="mr-2 h-4 w-4" />
                                                            {node.name}
                                                        </ContextMenuItem>
                                                        <ContextMenuSeparator />
                                                        {node.children.map(child => (
                                                            <TeamDirMenuItem key={child.path} node={child} />
                                                        ))}
                                                    </ContextMenuSubContent>
                                                </ContextMenuSub>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div key={node.path} title={actions.isMaintenanceMode ? t('team.maintenance_promote_hint') : undefined}>
                                            <ContextMenuItem disabled={isDisabled} onClick={() => actions.onPromoteToTeam!(item, node.path)}>
                                                <FolderInput className={cn("mr-2 h-4 w-4", isDisabled && "opacity-50")} />
                                                {node.name}
                                            </ContextMenuItem>
                                        </div>
                                    );
                                };

                                return (
                                    <>
                                        <ContextMenuSeparator />
                                        <ContextMenuSub>
                                            <ContextMenuSubTrigger disabled={isTeamRoot}>
                                                <Users className="mr-2 h-4 w-4" />
                                                {actions.teamDirectories?.has(item.path) || isTeamRoot ? t('team.sync_to_team', 'Sync to Team') : t('team.promote_to_team')}
                                            </ContextMenuSubTrigger>
                                            <ContextMenuSubContent>
                                                {rootNodes.map(node => (
                                                    <TeamDirMenuItem key={node.path} node={node} />
                                                ))}
                                            </ContextMenuSubContent>
                                        </ContextMenuSub>
                                    </>
                                );
                            })()}
                            <ContextMenuSeparator />
                        </>
                    ) : null}

                    {/* Rename - disabled for PARA root folders */}
                    {!isProtectedParaFolder && (
                        <ContextMenuItem onClick={startRename}>
                            <Edit2 className="mr-2 h-4 w-4" />
                            {t('common.rename')}
                        </ContextMenuItem>
                    )}

                    {!isFolder && (
                        <ContextMenuItem onClick={() => actions?.onDuplicate(item)}>
                            <Copy className="mr-2 h-4 w-4" />
                            {t('common.duplicate')}
                        </ContextMenuItem>
                    )}

                    {/* Move to - for files only */}
                    {!isFolder && (() => {
                        const { root } = useFileSystemStore.getState();
                        const currentFolder = item.path.substring(0, item.path.lastIndexOf('/'));

                        // Recursive component to render folder with subfolders
                        const FolderMenuItem = ({ folder }: { folder: FileSystemItem }) => {
                            const subfolders = folder.children?.filter(
                                child => child.type === 'folder' && !HIDDEN_FOLDERS.includes(child.name)
                            ) || [];

                            const isSameFolder = folder.path === currentFolder;

                            if (subfolders.length > 0) {
                                return (
                                    <ContextMenuSub key={folder.path}>
                                        <ContextMenuSubTrigger disabled={isSameFolder}>
                                            <Folder className="mr-2 h-4 w-4" />
                                            {folder.name}
                                        </ContextMenuSubTrigger>
                                        <ContextMenuSubContent>
                                            {/* Option to move to this folder directly */}
                                            {!isSameFolder && (
                                                <ContextMenuItem
                                                    onClick={() => actions?.onMoveFile(item.path, folder.path)}
                                                >
                                                    <FolderInput className="mr-2 h-4 w-4" />
                                                    {folder.name}
                                                </ContextMenuItem>
                                            )}
                                            {!isSameFolder && subfolders.length > 0 && <ContextMenuSeparator />}
                                            {subfolders.map(sub => (
                                                <FolderMenuItem key={sub.path} folder={sub} />
                                            ))}
                                        </ContextMenuSubContent>
                                    </ContextMenuSub>
                                );
                            }

                            return (
                                <ContextMenuItem
                                    key={folder.path}
                                    onClick={() => actions?.onMoveFile(item.path, folder.path)}
                                    disabled={isSameFolder}
                                >
                                    <Folder className="mr-2 h-4 w-4" />
                                    {folder.name}
                                </ContextMenuItem>
                            );
                        };

                        const topFolders = root?.children?.filter(
                            child => child.type === 'folder' && !HIDDEN_FOLDERS.includes(child.name)
                        ) || [];

                        return (
                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <FolderInput className="mr-2 h-4 w-4" />
                                    {t('common.move_to')}
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent>
                                    {topFolders.map(folder => (
                                        <FolderMenuItem key={folder.path} folder={folder} />
                                    ))}
                                </ContextMenuSubContent>
                            </ContextMenuSub>
                        );
                    })()}

                    <ContextMenuItem onClick={() => actions?.onReveal(item)}>
                        <ArrowUpRight className="mr-2 h-4 w-4" />
                        {t('common.reveal_in_finder')}
                    </ContextMenuItem>

                    {/* Delete - disabled for PARA root folders */}
                    {!isProtectedParaFolder && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => actions?.onDelete(item)} className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50">
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t('common.delete')}
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>

            {/* Children - filtered to hide system folders */}
            {isFolder && isOpen && visibleChildren && (
                <div className="relative">
                    {visibleChildren.map((child) => (
                        <FileTreeItem
                            key={child.id}
                            item={child}
                            level={level + 1}
                            onSelect={onSelect}
                            activeId={activeId}
                            actions={actions}
                        />
                    ))}
                    {visibleChildren.length === 0 && (
                        <div
                            className="text-xs text-zinc-400 py-1 pl-8 italic"
                            style={{ paddingLeft: `${(level + 1) * 12 + 28}px` }}
                        >
                            {t("sidebar.folder_empty")}
                        </div>
                    )}
                    {/* Indent guide line (rendered after contents with z-10 so backgrounds don't mask it) */}
                    <div
                        className="absolute pointer-events-none border-l border-zinc-200 dark:border-zinc-700/50 h-full"
                        style={{ left: `${level * 16 + 16}px`, top: 0, zIndex: 10 }}
                    />
                </div>
            )}
        </div>
    );
};
