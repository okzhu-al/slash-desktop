import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from "react-i18next";
import { FileSystemNoteRepository } from "@/core/storage/FileSystemNoteRepository";
import { Note } from "@/core/storage/types";
import { FilePlus, FolderPlus, Globe, Users, FileText, Folder, MoreHorizontal, User } from "lucide-react";
import { syncService, type TeamTreeNode } from '@/services/SyncService';
import { useTeamDirectoryMapping } from './hooks/useTeamDirectoryMapping';
import { useFileWatcher } from './hooks/useFileWatcher';
import { useFileTreeActions } from './hooks/useFileTreeActions';
import { useTeamAdminActions } from './hooks/useTeamAdminActions';
import { useSidebarDragDrop } from './hooks/useSidebarDragDrop';
import { toast } from 'sonner';
import { ImportButton } from "./components/ImportButton";
import { cn } from "@/shared/utils/cn";
import { useCommand } from "@/modules/keybindings/useCommand";
import { useFileSystemStore } from "@/core/fs/store";
import { FileTree } from "./components/FileTree";
import { FileSystemItem } from "@/core/fs/types";
import { FileSystemActions } from "./components/types";
import { SortDropdown } from "./components/SortDropdown";
import { SplitPane } from "./components/SplitPane";
import { SidebarFooter } from "./components/SidebarFooter";
import { TeamTreeItem } from "./components/TeamTreeItem";

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { useSessionStore } from '@/stores/useSessionStore';
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { buildLegacyTeamNoteId, buildStableTeamNoteId } from "@/shared/utils/teamNoteIdentity";

export interface SidebarProps {
    onSelectNote: (note: Note) => void;
    selectedNoteId?: string;
    isOpen?: boolean;
    onSettingsClick?: () => void;
    onNoteDeleted?: (id: string) => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
    repository: FileSystemNoteRepository;
    onSwitchVault: (path: string | null) => void;
    width?: number;
    onWidthChange?: (width: number) => void;
    onResizeEnd?: (width: number) => void;
    onResizeStart?: () => void;
    onSelectProjectFolder?: (folderPath: string, folderName: string) => void;
    onOpenGlobalGraph?: () => void;
    onOpenSyncSettings?: () => void;
    onOpenTeamManage?: () => void;
    onSelectTeamDir?: (dirPath: string, dirName: string) => void;
    activeFolderPath?: string;
    activeFolderMode?: 'personal' | 'team';
    activeTeamNotePath?: string;
    activeTeamNoteFileId?: string | null;
    onFolderDeleted?: (folderPath: string) => void;
}

export const Sidebar = ({
    onSelectNote,
    selectedNoteId,
    isOpen = true,
    onSettingsClick,
    onNoteDeleted,
    onNoteRenamed,
    repository: repo,
    onSwitchVault,
    width = 256,
    onWidthChange,
    onResizeEnd,
    onResizeStart,
    onSelectProjectFolder,
    onOpenGlobalGraph,
    onOpenSyncSettings,
    onOpenTeamManage,
    onSelectTeamDir,
    activeFolderPath,
    activeFolderMode,
    activeTeamNotePath,
    activeTeamNoteFileId,
    onFolderDeleted,
}: SidebarProps) => {
    const { t } = useTranslation();
    const { root, refreshTree } = useFileSystemStore();
    const [isResizing, setIsResizing] = useState(false);

    // Centralized editing state
    const [editingPath, setEditingPath] = useState<string | null>(null);

    // Notes with pending AI title suggestions
    const [pendingTitlePaths, setPendingTitlePaths] = useState<Set<string>>(new Set());

    // 双栏文件树状态
    const [activeSpace, setActiveSpace] = useState<'personal' | 'team'>('personal');
    const [personalCollapsed, setPersonalCollapsed] = useState(false);
    const [teamCollapsed, setTeamCollapsed] = useState(true);

    const teamVaultId = useSessionStore(s => s.teamVaultId);
    const teamVaultName = useSessionStore(s => s.teamVaultName);
    const hasTeamVault = !!teamVaultId && !!teamVaultName && syncService.getConfig() !== null;

    const [teamDirectoryOptions, setTeamDirectoryOptions] = useState<string[]>([]);
    const [teamTree, setTeamTree] = useState<TeamTreeNode[]>([]);
    const [teamExpandedDirs, setTeamExpandedDirs] = useState<Set<string>>(new Set());
    const lastTeamRefreshAtRef = useRef(0);

    const teamRole = useSessionStore(s => s.teamRole);
    const isAdminManageMode = useSessionStore(s => s.isAdminManageMode);
    const isGlobalAdmin = teamRole === 'admin';
    const isTeamAdmin = isGlobalAdmin && isAdminManageMode;

    const { teamDirectories, teamRoots, activeMappings, removeMapping } = useTeamDirectoryMapping({
        rootDir: repo?.rootDir,
        hasTeamVault,
        teamTree,
    });

    const refreshTeamData = useCallback((vaultId: string) => {
        syncService.listVaultDirectories(vaultId).then(setTeamDirectoryOptions).catch(() => { });
        syncService.getVaultTree(vaultId).then(tree => {
            setTeamTree(tree);
            setTeamExpandedDirs(prev => {
                const next = new Set(prev);
                tree.forEach(node => { if (node.is_dir) next.add(node.path); });
                return next;
            });
        }).catch(() => { });
    }, []);

    const { handleAdminDeleteFile, handleAdminDeleteDir, handleAdminRenameDir, handleAdminRenameFile, handleTeamDragEnd } = useTeamAdminActions({
        refreshTeamData,
        activeMappings,
        removeMapping,
        rootDir: repo?.rootDir,
        onNoteDeleted,
        onNoteRenamed
    });

    const [activeTeamDragNode, setActiveTeamDragNode] = useState<TeamTreeNode | null>(null);

    const { sensors, activeDragItem, noopCollision, handleDragStart, handleDragEnd } = useSidebarDragDrop({
        rootDir: repo?.rootDir,
        hasTeamVault,
        teamDirectories,
        refreshTree,
        onNoteRenamed
    });

    const {
        handleDelete, confirmRename, handleCreateNote, handleCreateFolder,
        handleRename, handleDuplicate, handleReveal, handleMoveFile, handlePromoteToTeam,
    } = useFileTreeActions({
        repo,
        hasTeamVault,
        teamDirectories,
        activeMappings,
        removeMapping,
        refreshTeamData,
        setEditingPath,
        onSelectNote,
        onNoteDeleted,
        onNoteRenamed,
        onFolderDeleted,
    });

    useCommand("app.new_note", () => handleCreateNote());
    useCommand("app.new_folder", () => handleCreateFolder());

    useFileWatcher({ repo, onNoteDeleted, onNoteRenamed });

    const startResizing = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
        if (onResizeStart) onResizeStart();
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing) return;
            const newWidth = Math.max(200, Math.min(480, e.clientX));
            if (onWidthChange) onWidthChange(newWidth);
        };
        const handleMouseUp = () => {
            if (isResizing) {
                setIsResizing(false);
                if (onResizeEnd) onResizeEnd(width);
                document.body.style.cursor = 'default';
            }
        };
        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
        }
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing, onWidthChange, onResizeEnd, width]);

    const fetchPendingTitles = useCallback(async () => {
        try {
            const paths = await invoke<string[]>('get_notes_with_pending_title');
            setPendingTitlePaths(new Set(paths));
        } catch (e) {
            console.warn('[Sidebar] Failed to fetch pending titles:', e);
        }
    }, []);

    useEffect(() => {
        fetchPendingTitles();
        let unlistenRename: (() => void) | undefined;
        let unlistenConfirm: (() => void) | undefined;
        const setupListener = async () => {
            const { listen } = await import('@tauri-apps/api/event');
            unlistenRename = await listen('smart-rename:completed', fetchPendingTitles);
            unlistenConfirm = await listen('title-confirmed', fetchPendingTitles);
        };
        setupListener();
        return () => {
            unlistenRename?.();
            unlistenConfirm?.();
        };
    }, [fetchPendingTitles]);

    useEffect(() => {
        if (root) fetchPendingTitles();
    }, [root, fetchPendingTitles]);

    // ── Timer for Admin Maintenance Mode Expiry ──
    useSessionStore(s => s.adminManageModeExpiry);
    const [timeLeftStr, setTimeLeftStr] = useState<string>('');
    useEffect(() => {
        if (!isAdminManageMode) {
            setTimeLeftStr('');
            return;
        }

        const tick = () => {
            const currentExpiry = useSessionStore.getState().adminManageModeExpiry;
            if (!currentExpiry) return;
            const diff = currentExpiry - Date.now();
            if (diff <= 0) {
                useSessionStore.getState().setAdminManageMode(false);
                setTimeLeftStr('');
                toast.info(t('team.maintenance_expired'));
            } else {
                const m = Math.floor(diff / 60000).toString().padStart(2, '0');
                const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                setTimeLeftStr(`${m}:${s}`);
            }
        };

        tick();
        const intervalId = setInterval(tick, 1000);
        return () => clearInterval(intervalId);
    }, [isAdminManageMode, t]);

    // Team Metadata
    useEffect(() => {
        if (!hasTeamVault || !teamVaultId) return;
        refreshTeamData(teamVaultId);

        (async () => {
            try {
                const config = syncService.getConfig();
                if (!config) return;
                const { teamService } = await import('@/services/TeamService');
                const result = await teamService.listMembers(config.serverUrl, config.accessToken, teamVaultId);
                (window as any).__slashTeamMembers = result.members.map(m => ({
                    username: m.username,
                    display_name: m.display_name,
                }));
                const userId = useSessionStore.getState().userId;
                const me = result.members.find(m => m.user_id === userId);
                if (me) {
                    useSessionStore.getState().setTeamInfo({
                        teamVaultId,
                        teamRole: me.global_role.toLowerCase(),
                    });
                }
            } catch (e) {
                console.warn('[Sidebar] Failed to load team members:', e);
            }
        })();

        const handleTeamRefresh = () => {
            const now = Date.now();
            if (now - lastTeamRefreshAtRef.current < 2000) return;
            lastTeamRefreshAtRef.current = now;
            refreshTeamData(teamVaultId);
        };
        window.addEventListener('team:tree-refresh', handleTeamRefresh);
        return () => {
            window.removeEventListener('team:tree-refresh', handleTeamRefresh);
            (window as any).__slashTeamMembers = [];
        };
    }, [hasTeamVault, teamVaultId, refreshTeamData]);

    const actions: FileSystemActions = {
        onRename: handleRename,
        onConfirmRename: confirmRename,
        onDelete: handleDelete,
        onDuplicate: handleDuplicate,
        onReveal: handleReveal,
        onNewNote: (parent: FileSystemItem) => handleCreateNote(parent.path),
        onNewFolder: (parent: FileSystemItem) => handleCreateFolder(parent.path),
        onMoveFile: handleMoveFile,
        editingPath,
        onStartEditing: (path: string) => setEditingPath(path),
        onStopEditing: () => setEditingPath(null),
        pendingTitlePaths,
        onSelectProjectFolder: (item: FileSystemItem) => {
            onSelectProjectFolder?.(item.path, item.name);
        },
        onPromoteToTeam: hasTeamVault ? handlePromoteToTeam : undefined,
        teamDirectories,
        teamRoots,
        teamDirectoryOptions: teamDirectoryOptions.length > 0 ? teamDirectoryOptions : undefined,
        teamTree: teamTree.length > 0 ? teamTree : undefined,
        isMaintenanceMode: isAdminManageMode,
    };

    return (
        <aside
            style={{ width: isOpen ? width : 0 }}
            className={cn(
                "pt-8 h-full bg-zinc-50 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-700 flex flex-col transition-all duration-300 ease-in-out relative group overflow-hidden shrink-0",
                isOpen ? "opacity-100" : "opacity-0",
                isResizing ? "transition-none" : ""
            )}
        >
            {isResizing && (
                <div className="fixed inset-0 z-99999 cursor-col-resize" />
            )}
            <div
                className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/50 active:bg-indigo-500 transition-colors z-50 opacity-0 group-hover:opacity-100"
                onMouseDown={startResizing}
            />
            <div className="w-full h-full flex flex-col" style={{ width: width }}>
                {/* Actions Header */}
                <div className="px-3 py-1 flex items-center gap-1.5 shrink-0 border-b border-zinc-200 dark:border-zinc-700">
                    <button
                        onClick={() => handleCreateNote()}
                        className="w-7 h-7 flex items-center justify-center px-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                        title={t("sidebar.new_note")}
                    >
                        <FilePlus size={18} strokeWidth={1.5} />
                    </button>
                    <button
                        onClick={() => handleCreateFolder()}
                        className="w-7 h-7 flex items-center justify-center px-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                        title={t("sidebar.new_folder")}
                    >
                        <FolderPlus size={18} strokeWidth={1.5} />
                    </button>
                    <SortDropdown />
                    {onOpenGlobalGraph && (
                        <button
                            onClick={onOpenGlobalGraph}
                            className="w-7 h-7 flex items-center justify-center px-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                            title={t('graph.globalTitle', '全局知识图谱')}
                        >
                            <Globe size={18} strokeWidth={1.5} />
                        </button>
                    )}
                    <ImportButton
                        vaultPath={repo?.rootDir}
                        onNoteImported={(notePath) => {
                            const title = notePath.split('/').pop()?.replace(/\.md$/, '') || 'Imported';
                            onSelectNote({
                                id: notePath,
                                title,
                                path: notePath,
                                content: '',
                                createdAt: Date.now(),
                                updatedAt: Date.now(),
                            });
                        }}
                    />
                </div>

                {/* Split Pane Trees */}
                <SplitPane
                    topCollapsed={personalCollapsed}
                    bottomCollapsed={teamCollapsed}
                    showBottomPane={hasTeamVault}
                    initialRatio={parseFloat(localStorage.getItem('slash_sidebar_split_ratio') || '0.55')}
                    onRatioChange={(r) => localStorage.setItem('slash_sidebar_split_ratio', String(r))}
                    topContent={
                        <>
                            <div className="flex items-center shrink-0 w-full min-w-0">
                                <button
                                    onClick={() => {
                                        const nextCollapsed = !personalCollapsed;
                                        setPersonalCollapsed(nextCollapsed);
                                        if (nextCollapsed && hasTeamVault) {
                                            setActiveSpace('team');
                                            setTeamCollapsed(false);
                                        } else if (!nextCollapsed) {
                                            setActiveSpace('personal');
                                        }
                                    }}
                                    className={cn(
                                        'flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-sm font-semibold tracking-wider transition-colors select-none',
                                        !personalCollapsed ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                                    )}
                                >
                                    <User size={16} strokeWidth={2} className="shrink-0" />
                                    <span className="flex-1 min-w-0 truncate text-left">{root?.name || t('sidebar.personal_space', '个人空间')}</span>
                                </button>
                            </div>
                            {!personalCollapsed && (
                                <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
                                    <DndContext
                                        sensors={sensors}
                                        collisionDetection={noopCollision}
                                        onDragStart={handleDragStart}
                                        onDragEnd={handleDragEnd}
                                        autoScroll={false}
                                    >
                                        <ContextMenu>
                                            <ContextMenuTrigger className="block">
                                                <FileTree
                                                    root={root}
                                                    activeId={selectedNoteId || (activeFolderMode === 'personal' ? activeFolderPath : undefined)}
                                                    actions={actions}
                                                    onSelect={(item: FileSystemItem) => {
                                                        setEditingPath(null);
                                                        setActiveSpace('personal');
                                                        onSelectNote({
                                                            id: item.path,
                                                            title: item.name.replace(/\.md$/, ''),
                                                            path: item.path,
                                                            content: '',
                                                            createdAt: 0,
                                                            updatedAt: 0
                                                        });
                                                    }}
                                                />
                                            </ContextMenuTrigger>
                                            <ContextMenuContent>
                                                <ContextMenuItem onClick={() => handleCreateNote()}>
                                                    <FilePlus className="mr-2 h-4 w-4" />{t('sidebar.new_note')}
                                                </ContextMenuItem>
                                                <ContextMenuItem onClick={() => handleCreateFolder()}>
                                                    <FolderPlus className="mr-2 h-4 w-4" />{t('sidebar.new_folder')}
                                                </ContextMenuItem>
                                            </ContextMenuContent>
                                        </ContextMenu>
                                        <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
                                            {activeDragItem && (
                                                <div className="flex items-center gap-1.5 py-1 px-3 bg-white dark:bg-zinc-800 shadow-lg border rounded opacity-40 pointer-events-none">
                                                    {activeDragItem.type === 'folder' ? <Folder size={14} className="text-indigo-500" /> : <FileText size={14} className="text-zinc-400" />}
                                                    <span className="truncate max-w-[160px]">{activeDragItem.name}</span>
                                                </div>
                                            )}
                                        </DragOverlay>
                                    </DndContext>
                                </div>
                            )}
                        </>
                    }
                    bottomContent={
                        <>
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                    const nextCollapsed = !teamCollapsed;
                                    setTeamCollapsed(nextCollapsed);
                                    if (nextCollapsed) {
                                        setActiveSpace('personal');
                                        setPersonalCollapsed(false);
                                    } else if (!nextCollapsed) {
                                        setActiveSpace('team');
                                    }
                                }}
                                className={cn(
                                    'w-full min-w-0 flex items-center gap-2 px-3 py-2 text-sm font-semibold tracking-wider transition-colors select-none shrink-0 border-t border-zinc-200 dark:border-zinc-700',
                                    !teamCollapsed ? 'text-amber-900 dark:text-blue-200' : 'text-zinc-500 hover:bg-black/5 dark:text-zinc-400'
                                )}
                            >
                                <Users size={16} strokeWidth={2} className="shrink-0" />
                                <span className="flex-1 min-w-0 truncate tracking-tight">{teamVaultName!}</span>
                                {isAdminManageMode && (
                                    <span className="flex flex-none items-center gap-1.5 rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-700 uppercase dark:bg-amber-500/20 dark:text-amber-400 border border-amber-200/50 dark:border-amber-500/30">
                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-[pulse_1.5s_ease-in-out_infinite] shadow-[0_0_8px_rgba(245,158,11,0.6)]" />
                                        <span>{t('team.maintenance_badge')}</span>
                                        {timeLeftStr && <span className="text-amber-600/90 dark:text-amber-500/90 tabular-nums ml-0.5 font-mono">{timeLeftStr}</span>}
                                    </span>
                                )}
                                <span
                                    role="button"
                                    tabIndex={-1}
                                    onClick={(e) => { e.stopPropagation(); onOpenTeamManage?.(); }}
                                    className="p-1 rounded-md hover:bg-zinc-200/60 transition-colors flex items-center justify-center"
                                    title="团队管理"
                                >
                                    <MoreHorizontal size={14} className="text-zinc-400 hover:text-indigo-500 transition-colors" />
                                </span>
                            </div>
                            {!teamCollapsed && (
                                <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar py-1">
                                    <DndContext
                                        sensors={sensors}
                                        collisionDetection={closestCenter}
                                        onDragStart={(e) => setActiveTeamDragNode(e.active.data.current?.teamNode as TeamTreeNode | null)}
                                        onDragEnd={(e) => handleTeamDragEnd(e, setActiveTeamDragNode)}
                                        autoScroll={false}
                                    >
                                        {teamTree.length > 0 ? (
                                            <div className="px-1">
                                                {teamTree.map(node => (
                                                    <TeamTreeItem
                                                        key={node.path}
                                                        node={node}
                                                        depth={0}
                                                        expandedDirs={teamExpandedDirs}
                                                        onToggleDir={(path) => setTeamExpandedDirs(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(path)) next.delete(path); else next.add(path);
                                                            return next;
                                                        })}
                                                        onDirClick={onSelectTeamDir}
                                                        activeDirPath={activeFolderMode === 'team' ? activeFolderPath : undefined}
                                                        activeNotePath={activeTeamNotePath}
                                                        activeNoteFileId={activeTeamNoteFileId}
                                                        isAdmin={isTeamAdmin}
                                                        isMaintenanceMode={isAdminManageMode}
                                                        onDeleteDir={handleAdminDeleteDir}
                                                        onDeleteFile={handleAdminDeleteFile}
                                                        onRenameDir={handleAdminRenameDir}
                                                        onRenameFile={handleAdminRenameFile}
                                                        onFileClick={(filePath, editorName, fileId) => {
                                                            const teamVaultId = useSessionStore.getState().teamVaultId;
                                                            if (!teamVaultId) return;
                                                            syncService.getVaultFile(teamVaultId, filePath)
                                                                .then(async content => {
                                                                    const fileName = filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;
                                                                    const { metadataService } = await import('@/core/metadata/MetadataService');
                                                                    const { metadata, content: parsedContent } = metadataService.parse(filePath, content);
                                                                    if (fileId && !metadata.slash_id) metadata.slash_id = fileId;
                                                                    if (editorName) metadata.editor = editorName;
                                                                    metadata.team_path = filePath;
                                                                    metadata.team_vault_id = teamVaultId;
                                                                    const noteId = fileId
                                                                        ? buildStableTeamNoteId(teamVaultId, fileId)
                                                                        : buildLegacyTeamNoteId(filePath);
                                                                    onSelectNote({
                                                                        id: noteId,
                                                                        path: noteId,
                                                                        title: metadata.title || fileName,
                                                                        content: parsedContent,
                                                                        metadata,
                                                                        createdAt: Date.now(),
                                                                        updatedAt: Date.now(),
                                                                    });
                                                                }).catch(err => toast.error(t('team.load_failed', { error: err })));
                                                        }}
                                                    />
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="px-4 py-4 text-center space-y-1">
                                                <Users size={20} className="mx-auto text-zinc-300 dark:text-zinc-600" />
                                                <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('team.sidebar_team_empty')}</p>
                                            </div>
                                        )}
                                        <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
                                            {activeTeamDragNode && (
                                                <div className="flex items-center gap-1.5 py-1 px-3 bg-white shadow-lg border rounded opacity-40 pointer-events-none">
                                                    {activeTeamDragNode.is_dir ? <Folder size={14} className="text-indigo-500" /> : <FileText size={14} className="text-zinc-400" />}
                                                    <span className="truncate max-w-[160px]">{activeTeamDragNode.name}</span>
                                                </div>
                                            )}
                                        </DragOverlay>
                                    </DndContext>
                                </div>
                            )}
                        </>
                    }
                />

                <SidebarFooter
                    rootDir={repo?.rootDir}
                    vaultName={root?.name}
                    teamVaultName={teamVaultName ?? undefined}
                    activeSpace={activeSpace}
                    hasTeamVault={hasTeamVault}
                    onSwitchVault={onSwitchVault}
                    onOpenSyncSettings={onOpenSyncSettings}
                    onSettingsClick={onSettingsClick}
                />
            </div>
        </aside>
    );
};
