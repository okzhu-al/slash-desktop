import { useEffect, useState, useRef, useCallback, Suspense, lazy } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useGhostLinkManager } from "@/hooks/useGhostLinkManager";
import { useAppEventListeners } from "@/hooks/useAppEventListeners";
const Sidebar = lazy(() => import("@/features/sidebar").then(m => ({ default: m.Sidebar })));
const Editor = lazy(() => import("@/features/editor").then(m => ({ default: m.Editor })));
const SettingsModal = lazy(() => import("@/features/settings/SettingsModal").then(m => ({ default: m.SettingsModal })));
const TeamManagePage = lazy(() => import("@/features/team/TeamManagePage").then(m => ({ default: m.TeamManagePage })));
const TeamReadOnlyGuard = lazy(() => import("@/features/team/TeamReadOnlyGuard").then(m => ({ default: m.TeamReadOnlyGuard })));

import { TitleBar, RightPanelMode } from "@/shared/ui/layout/TitleBar";
import { metadataService } from "@/core/metadata/MetadataService";
import { FileSystemNoteRepository } from "@/core/storage/FileSystemNoteRepository";
const WelcomeScreen = lazy(() => import("@/features/onboarding/WelcomeScreen").then(m => ({ default: m.WelcomeScreen })));
const MediaPreview = lazy(() => import("@/features/editor/components/MediaPreview").then(m => ({ default: m.MediaPreview })));
import { Toaster, toast } from 'sonner';

const GhostLinkPanel = lazy(() => import("@/features/graph/GhostLinkPanel").then(m => ({ default: m.GhostLinkPanel })));
import type { GhostLink } from "@/features/graph/types";
const KnowledgeGraphPage = lazy(() => import("@/features/graph/KnowledgeGraphPage").then(m => ({ default: m.KnowledgeGraphPage })));
const LocalGraphPanel = lazy(() => import("@/features/graph/LocalGraphPanel").then(m => ({ default: m.LocalGraphPanel })));
const RightSidebar = lazy(() => import("@/shared/ui/layout/RightSidebar").then(m => ({ default: m.RightSidebar })));
import { loadAssetIndex } from "@/core/media/AssetCleanupService";
import { useTabsStore } from "@/core/tabs/TabsStore";
import { ensureParaStructure } from "@/core/para/ParaService";
import { useVaultConnection } from "@/hooks/useVaultConnection";
import { useNoteNavigation } from "@/hooks/useNoteNavigation";
import { useNoteOperations } from "@/hooks/useNoteOperations";
import { NoteContextProvider } from "@/contexts";
const FolderPage = lazy(() => import("@/features/folder/FolderPage").then(m => ({ default: m.FolderPage })));
const NoteTaskPanel = lazy(() => import("@/features/tasks/NoteTaskPanel").then(m => ({ default: m.NoteTaskPanel })));
const ClassificationPanel = lazy(() => import("@/features/classification/ClassificationPanel").then(m => ({ default: m.ClassificationPanel })));
const ActivityTimeline = lazy(() => import("@/features/collaboration/ActivityTimeline").then(m => ({ default: m.ActivityTimeline })));
const VersionTimeline = lazy(() => import("@/features/collaboration/VersionTimeline").then(m => ({ default: m.VersionTimeline })));
import { OutlinePanel } from "@/features/sidebar/components/OutlinePanel";
import { useIsTeamNote } from '@/hooks/useIsTeamNote';
const SearchPanel = lazy(() => import("@/features/search").then(m => ({ default: m.SearchPanel })));
import { autoSyncManager } from "@/services/AutoSyncManager";
import { syncService, type DeletedFileInfo } from "@/services/SyncService";
import { useSessionStore, migrateFromLegacyLocalStorage } from '@/stores/useSessionStore';
import { getBasename, getParentPath, normalizePath, getRelativePath } from '@/shared/utils/pathUtils';
import { historyCache } from '@/features/editor/utils/historyCache';
import { buildLegacyTeamNoteId, buildStableTeamNoteId, parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';
import { isDeletedTeamNote, markDeletedTeamNotes, matchesDeletedTeamPath } from '@/shared/utils/deletedTeamNoteGuard';
function App() {

  
  useEffect(() => {

  }, []);

  // 一次性迁移：将旧 localStorage 散落 key 迁入 useSessionStore
  migrateFromLegacyLocalStorage();

  const { t } = useTranslation();

  // Vault & Repo State
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [repo, setRepo] = useState<FileSystemNoteRepository | null>(null);

  // Note Navigation State (extracted to hook)
  const {
    selectedNote, setSelectedNote,
    content, setContent,
    viewMode, setViewMode,
    isNewNote, setIsNewNote,
    shouldFocusBody, setShouldFocusBody,
    noteSelectionKey,
    selectNote,
    handleTabClick,
  } = useNoteNavigation({ repo, vaultPath });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'ai' | 'general' | 'sync' | undefined>(undefined);
  const [graphPanelOpen, setGraphPanelOpen] = useState(true);
  const [showGlobalGraph, setShowGlobalGraph] = useState(false);
  const [showTeamManage, setShowTeamManage] = useState(false);
  const tabsSnapshot = useTabsStore(state => state.tabs);
  const activeTabIdSnapshot = useTabsStore(state => state.activeTabId);
  const selectedNoteRef = useRef(selectedNote);
  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);

  const clearOrphanTeamEditor = useCallback((source: string) => {
    const currentSelected = selectedNoteRef.current;
    if (!currentSelected?.id) return false;

    const tabsStore = useTabsStore.getState();
    const parsedSelected = parseTeamNoteId(currentSelected.id);
    const selectedFileId = (currentSelected.metadata?.slash_id as string | undefined) || parsedSelected.fileId;
    const selectedTeamPath = currentSelected.metadata?.team_path as string | undefined;
    const selectedPath = normalizePath(selectedTeamPath || parsedSelected.filePath || currentSelected.id)
      .replace(/^__team__\//, '')
      .toLowerCase();
    const hasMatchingTab = tabsStore.tabs.some(tab => {
      const parsedTab = parseTeamNoteId(tab.id);
      const tabFileId = tab.fileId || parsedTab.fileId || null;
      const tabPath = normalizePath(tab.teamPath || parsedTab.filePath || tab.id)
        .replace(/^__team__\//, '')
        .toLowerCase();
      return tab.id === currentSelected.id
        || normalizePath(tab.id) === normalizePath(currentSelected.id)
        || Boolean(selectedFileId && tabFileId === selectedFileId)
        || Boolean(selectedPath && tabPath === selectedPath);
    });

    if (hasMatchingTab) return false;

    console.warn('[TeamDeleteClose] clearing orphan selected note without tab', {
      source,
      selectedId: currentSelected.id,
      selectedFileId,
      selectedPath,
      activeTabId: tabsStore.activeTabId,
      tabs: tabsStore.tabs.map(tab => ({
        id: tab.id,
        fileId: tab.fileId,
        teamPath: tab.teamPath,
      })),
    });
    setSelectedNote(null);
    setContent('');
    setIsNewNote(false);
    autoSyncManager.setEditingPath(null);
    return true;
  }, [setSelectedNote, setContent, setIsNewNote]);

  const closeDeletedNotes = useCallback((deletedFiles: DeletedFileInfo[] | undefined) => {
    if (!deletedFiles?.length) return false;

    markDeletedTeamNotes(deletedFiles);
    const deletedIds = new Set(deletedFiles.map(file => file.file_id).filter(Boolean) as string[]);
    const deletedPaths = deletedFiles.map(file => normalizePath(file.path).replace(/^__team__\//, '').toLowerCase());
    const tabsStore = useTabsStore.getState();
    const activeTabIdBeforeClose = tabsStore.activeTabId;
    let closedActive = false;
    const closedTabIds = new Set<string>();
    const closedFileIds = new Set<string>();
    const closedPaths = new Set<string>();
    const tabsToClose: typeof tabsStore.tabs = [];

    for (const tab of tabsStore.tabs) {
      const parsed = parseTeamNoteId(tab.id);
      const tabPath = normalizePath(tab.teamPath || parsed.filePath || tab.id).replace(/^__team__\//, '').toLowerCase();
      const fileId = tab.fileId || parsed.fileId || null;
      const matchedPaths = deletedPaths.filter(path => matchesDeletedTeamPath(tabPath, path));
      const shouldClose = Boolean(fileId && deletedIds.has(fileId))
        || matchedPaths.length > 0;

      if (shouldClose) {
        const activeMatchesTab = activeTabIdBeforeClose === tab.id
          || normalizePath(activeTabIdBeforeClose || '') === normalizePath(tab.id);
        if (activeMatchesTab) closedActive = true;
        closedTabIds.add(tab.id);
        if (fileId) closedFileIds.add(fileId);
        closedPaths.add(tabPath);
        tabsToClose.push(tab);
      }
    }

    const selectedTeamPath = selectedNote?.id?.startsWith('__team__/')
      ? (selectedNote.metadata?.team_path as string | undefined)
      : undefined;
    const selectedPath = normalizePath(selectedTeamPath || selectedNote?.id || '').replace(/^__team__\//, '').toLowerCase();
    const selectedFileId = (selectedNote?.metadata?.slash_id as string | undefined) || parseTeamNoteId(selectedNote?.id || '').fileId;
    const remainingTabs = tabsStore.tabs.filter(tab => !closedTabIds.has(tab.id));
    const selectedStillHasTab = selectedNote
      ? remainingTabs.some(tab => {
        const parsed = parseTeamNoteId(tab.id);
        const tabFileId = tab.fileId || parsed.fileId || null;
        const tabPath = normalizePath(tab.teamPath || parsed.filePath || tab.id).replace(/^__team__\//, '').toLowerCase();
        return tab.id === selectedNote.id
          || Boolean(selectedFileId && tabFileId === selectedFileId)
          || Boolean(selectedPath && tabPath === selectedPath);
      })
      : true;
    const selectedDeleted = Boolean(selectedFileId && deletedIds.has(selectedFileId))
      || Boolean(selectedFileId && closedFileIds.has(selectedFileId))
      || Boolean(selectedNote?.id && closedTabIds.has(selectedNote.id))
      || (closedTabIds.size > 0 && selectedNote && !selectedStillHasTab)
      || closedPaths.has(selectedPath)
      || Array.from(closedPaths).some(path => matchesDeletedTeamPath(selectedPath, path))
      || deletedPaths.some(path => matchesDeletedTeamPath(selectedPath, path));

    for (const tab of tabsToClose) {
      tabsStore.closeTab(tab.id);
    }

    if (closedActive || selectedDeleted) {
      setSelectedNote(null);
      setContent('');
      setIsNewNote(false);
      autoSyncManager.setEditingPath(null);
      toast.info(t('sync.remote_file_deleted', '当前笔记已被团队成员删除，已关闭标签。'));
      return true;
    }
    return false;
  }, [selectedNote, setSelectedNote, setContent, setIsNewNote, t]);

  useEffect(() => {
    void activeTabIdSnapshot;
    void tabsSnapshot;
    clearOrphanTeamEditor('tabs-snapshot');
  }, [tabsSnapshot, activeTabIdSnapshot, clearOrphanTeamEditor]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const runAfterRefresh = (source: string) => {
      window.setTimeout(() => clearOrphanTeamEditor(source), 0);
      window.setTimeout(() => clearOrphanTeamEditor(`${source}:delayed`), 300);
    };
    const handleWindowVaultRefresh = () => runAfterRefresh('window-vault-refresh');

    listen('vault:refresh', () => runAfterRefresh('tauri-vault-refresh')).then(cleanup => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    }).catch(err => console.warn('[TeamDeleteClose] failed to listen vault:refresh', err));

    window.addEventListener('vault:refresh', handleWindowVaultRefresh);
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener('vault:refresh', handleWindowVaultRefresh);
    };
  }, [clearOrphanTeamEditor]);

  // ── GhostLink 管理（委托至独立 hook）──
  const {
    ghostLinksData, setGhostLinksData,
    ghostLinkReasons,
    triggerReasoning,
  } = useGhostLinkManager({
    selectedNote,
    vaultPath,
    setSelectedNote,
    setContent,
    setIsNewNote,
  });

  const [ghostLinkActive, setGhostLinkActive] = useState(false);
  const isTeamNote = useIsTeamNote(selectedNote?.id);
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('outline');
  const cameFromGraphRef = useRef(false);
  const [graphPanelWidth, setGraphPanelWidth] = useState(() => {
    const saved = localStorage.getItem('graph_panel_width');
    return saved ? parseInt(saved, 10) : 256;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar_width');
    return saved ? parseInt(saved, 10) : 256;
  });

  const [isResizing, setIsResizing] = useState(false);
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);

  // Globally listen for filesystem tree refresh events to sync the knowledge graph
  useEffect(() => {
    const triggerGraphRefresh = () => setGraphRefreshKey(k => k + 1);
    window.addEventListener('slash:graph-refresh', triggerGraphRefresh);
    return () => window.removeEventListener('slash:graph-refresh', triggerGraphRefresh);
  }, []);

  useEffect(() => {
    const handleCloseRightSidebar = () => {
      setGraphPanelOpen(false);
    };
    window.addEventListener('slash:close-right-sidebar', handleCloseRightSidebar);
    return () => window.removeEventListener('slash:close-right-sidebar', handleCloseRightSidebar);
  }, []);

  const [isSearchOpen, setIsSearchOpen] = useState(false);

  /** 通用笔记导航：将 path 转为完整 Note 对象并选中 */
  const navigateToNotePath = useCallback((notePath: string) => {
    if (!vaultPath && !notePath.startsWith('__team__/')) return;
    const normalizedInput = normalizePath(notePath);
    const normalizedVault = normalizePath(vaultPath || '');
    const isAbsolute = normalizedInput.startsWith('/') || /^[a-z]:\//i.test(normalizedInput);
    const relativePath = isAbsolute ? getRelativePath(normalizedInput, normalizedVault) : normalizedInput;
    const pathWithExtension = relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`;
    const fullPath = normalizedInput.startsWith('__team__/') ? normalizedInput
      : isAbsolute && relativePath === normalizedInput ? normalizedInput
      : `${normalizedVault}/${pathWithExtension}`;
    const noteTitle = getBasename(notePath).replace(/\.md$/, '') || notePath;
    selectNote({
      id: fullPath, title: noteTitle, content: '', path: fullPath,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  }, [vaultPath, selectNote]);

  // Project Kanban State
  const [selectedFolder, setSelectedFolder] = useState<{ path: string; name: string; mode?: 'personal' | 'team'; teamDirPath?: string } | null>(null);

  // Note Operations Hook - handles save, title update, delete, tab close
  const { handleSave, handleTitleUpdate, handleNoteDeleted, handleTabClose } = useNoteOperations({
    repo,
    vaultPath,
    selectedNote,
    setSelectedNote,
    setContent,
    setViewMode,
    setIsNewNote,
    setShouldFocusBody,
    onAfterSave: (linksChanged) => {
      if (linksChanged) {
        setGraphRefreshKey(k => k + 1);
      }
    },
  });

  // Vault Connection Hook - manages database lifecycle
  const { isDbReady: _isDbReady, isScanning, error: dbError, scanStats: _scanStats } = useVaultConnection(vaultPath);

  // Restore last opened vault on app startup
  const hasAttemptedRestore = useRef(false);
  const [isRestoring, setIsRestoring] = useState(() => {
    return !!localStorage.getItem('slash-last-vault');
  });

  useEffect(() => {
    if (hasAttemptedRestore.current) return;
    hasAttemptedRestore.current = true;

    const lastVault = localStorage.getItem('slash-last-vault');
    if (lastVault && !vaultPath) {
      import('@tauri-apps/plugin-fs').then(async ({ stat }) => {
        try {
          await stat(lastVault);

          handleVaultOpened(lastVault);
        } catch {
          console.log('[App] Last vault no longer exists, clearing:', lastVault);
          localStorage.removeItem('slash-last-vault');
          setIsRestoring(false);
        }
      });
    } else {
      setIsRestoring(false);
    }
  }, []);

  // Editor container ref for scroll reset
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Reset scroll position when switching notes
  useEffect(() => {
    if (editorContainerRef.current && selectedNote) {
      // 🚀 CRITICAL FIX: 检查该笔记是否有已缓存或已存储的滚动高度（如果是，不强制重置为 0）
      // 这能 100% 拆除切换笔记瞬间因 100ms 延迟无脑重置 scrollTop 为 0 导致的位置恢复被强制覆盖的时序“暗雷”！
      const storedPos = historyCache.getStoredPosition(selectedNote.id);
      const cached = historyCache.getCached(selectedNote.id);
      const hasSavedScroll = (cached && typeof cached.scrollTop === 'number') || !!storedPos;

      if (!hasSavedScroll) {
        editorContainerRef.current.scrollTop = 0;
        const timer = setTimeout(() => {
          if (editorContainerRef.current) {
            editorContainerRef.current.scrollTop = 0;
          }
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [selectedNote?.id]);

  // Stable ref for currentNotePath — used by collab event listener
  const currentNotePathRef = useRef<string | undefined>(selectedNote?.id);
  useEffect(() => { currentNotePathRef.current = selectedNote?.id; }, [selectedNote?.id]);

  // ── 全局事件监听（Tldraw fix, AI降级, 语言, 缩放, 协作通知）──
  useAppEventListeners({
    currentNotePathRef,
    setIsSearchOpen,
    setRightPanelMode,
    vaultPath,
  });

  const handleSidebarResize = (width: number) => {
    setSidebarWidth(width);
  };

  const handleSidebarResizeStart = () => {
    setIsResizing(true);
  };

  const handleSidebarResizeEnd = (width: number) => {
    setIsResizing(false);
    localStorage.setItem('sidebar_width', width.toString());
  };

  // Restore active tab content when app starts (repo ready, no note selected yet)
  useEffect(() => {
    if (repo && !selectedNote && vaultPath) {
      const activeTabId = useTabsStore.getState().activeTabId;
      if (activeTabId) {
        handleTabClick(activeTabId);
      }
    }
  }, [repo]);

  // Track currently editing note path for auto-sync safety
  useEffect(() => {
    autoSyncManager.setEditingPath(selectedNote?.path ?? null);
  }, [selectedNote?.path]);

  // UUID-first metadata hydration:
  // 本地文件树打开团队目录内文件时，只能读到磁盘 YAML；如果 YAML 缺 editor/doc_status，
  // 必须用 file_id 从 Server file_states 回填内存 metadata，避免误判为 solo_missing_editor。
  useEffect(() => {
    if (!selectedNote || !isTeamNote) return;

    const currentMetadata = selectedNote.metadata || {};
    if (currentMetadata.editor && currentMetadata.doc_status) return;

    const parsedTeamNote = parseTeamNoteId(selectedNote.id);
    const fileId = (currentMetadata.slash_id as string | undefined) || parsedTeamNote.fileId;
    const teamVaultId =
      (currentMetadata.team_vault_id as string | undefined)
      || parsedTeamNote.teamVaultId
      || useSessionStore.getState().teamVaultId;

    if (!fileId || !teamVaultId) return;

    let cancelled = false;

    syncService.getVaultFileById(teamVaultId, fileId)
      .then(({ filePath, docStatus, editorId, editorName }) => {
        if (cancelled) return;
        setSelectedNote(prev => {
          if (!prev || prev.id !== selectedNote.id) return prev;

          const metadata = { ...(prev.metadata || {}) };
          let changed = false;

          if (docStatus && !metadata.doc_status) {
            metadata.doc_status = docStatus;
            changed = true;
          }
          if (editorId && !metadata.editor_id) {
            metadata.editor_id = editorId;
            changed = true;
          }
          if (editorName && !metadata.editor) {
            metadata.editor = editorName;
            changed = true;
          }
          if (filePath && !metadata.team_path) {
            metadata.team_path = filePath;
            changed = true;
          }
          if (teamVaultId && !metadata.team_vault_id) {
            metadata.team_vault_id = teamVaultId;
            changed = true;
          }

          return changed ? { ...prev, metadata } : prev;
        });
      })
      .catch(err => console.warn('[App] Failed to hydrate team note metadata:', err));

    return () => { cancelled = true; };
  }, [
    selectedNote?.id,
    selectedNote?.metadata?.slash_id,
    selectedNote?.metadata?.editor,
    selectedNote?.metadata?.doc_status,
    isTeamNote,
    setSelectedNote,
  ]);

  // Listen for sync:pulled event to refresh selected note's metadata
  useEffect(() => {
    const handleSyncPulled = async (e: Event) => {
      const customEvent = e as CustomEvent;
      if (closeDeletedNotes(customEvent.detail?.server_deleted)) {
        return;
      }
      const paths = (customEvent.detail?.actually_pulled_paths || customEvent.detail?.pulled_paths) as string[] | undefined;
      const selectedTeamPath = selectedNote?.id?.startsWith('__team__/')
        ? (selectedNote.metadata?.team_path as string | undefined)
        : undefined;
      const selectedId = selectedTeamPath
        ? normalizePath(selectedTeamPath)
        : selectedNote?.id ? normalizePath(selectedNote.id).replace(/^__team__\//, '') : '';
      // If we don't have paths, or the active note's path is in the pulled_paths
      const shouldRefresh = !paths || (selectedId && paths.some((p: string) => {
        const pulled = normalizePath(p).replace(/^__team__\//, '');
        return selectedId === pulled || selectedId.endsWith(`/${pulled}`) || pulled.endsWith(`/${selectedId}`);
      }));
      
      if (shouldRefresh && selectedNote?.id && repo) {
        try {
          const freshNote = await repo.getNote(selectedNote.id);
          if (freshNote && !isDeletedTeamNote(freshNote)) {
            setSelectedNote(freshNote);
            setContent(freshNote.content);
          }
        } catch (err) {
          console.error('[App] Failed to reload note after sync:', err);
        }
      }
    };
    window.addEventListener('sync:pulled', handleSyncPulled);
    return () => window.removeEventListener('sync:pulled', handleSyncPulled);
  }, [selectedNote?.id, repo, setSelectedNote, closeDeletedNotes]);

  // Save tabs state when app closes (beforeunload)
  useEffect(() => {
    if (!vaultPath) return;

    const handleBeforeUnload = () => {
      useTabsStore.getState().saveForVault(vaultPath);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [vaultPath]);

  // 全局监听会话失效事件，触发状态熔断与 UI 强退阻断
  useEffect(() => {
    const handleAuthExpired = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      const message = reason === 'admin_revoked'
        ? t('sync.session_admin_revoked', '您已被管理员强制下线，请重新登录。')
        : reason === 'forbidden'
            ? t('sync.session_forbidden', '登录状态已失效，或当前账号不再拥有该团队空间权限，请重新登录。')
            : t('sync.auth_expired', '登录已过期，请重新连接');

      toast.error(`⚠️ ${message}`, {
        duration: 8000,
        position: 'top-center',
      });

      setShowTeamManage(false);
      setSelectedFolder(null);
      setSelectedNote(null);
      setContent('');
      setIsNewNote(false);
    };

    window.addEventListener('sync:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('sync:auth-expired', handleAuthExpired);
  }, [setSelectedNote, setContent, setIsNewNote]);

  // 🚨 全局监听物理断联事件，触发状态提示
  useEffect(() => {
    let lastToastTime = 0;
    const handlePhysicalDisconnected = () => {
      const now = Date.now();
      if (now - lastToastTime > 15000) { // 15秒防重防刷屏
        lastToastTime = now;
        toast.error(`⚠️ ${t('sync.physical_disconnected', '网络或服务暂不可用，恢复后会自动重试')}`, {
          duration: 8000,
          position: 'top-center',
        });
      }
    };

    window.addEventListener('sync:physical-disconnected', handlePhysicalDisconnected);
    return () => window.removeEventListener('sync:physical-disconnected', handlePhysicalDisconnected);
  }, []);

  // 批注 mark 随 rightPanelMode 显隐由 ActivityTimeline 自行管理，App 不需要单独处理

  const performTabSwitch = useCallback((tabId: string) => {
    if (tabId === '__team_manage__') {
      setSelectedNote(null); setContent('');
      setShowTeamManage(true); setSelectedFolder(null); setShowGlobalGraph(false);
    } else if (tabId.startsWith('__folder__:')) {
      // Restore folder page from tab click
      const folderPath = tabId.replace('__folder__:', '');
      const folderName = getBasename(folderPath) || folderPath;
      setSelectedNote(null); setContent('');
      // 检查是否为团队目录标签（通过标签名或路径判断）
      const tab = useTabsStore.getState().tabs.find(t => t.id === tabId);
      const isTeamDir = tab?.title?.startsWith('📁 ');
      if (isTeamDir) {
        setSelectedFolder({ path: folderPath, name: folderName, mode: 'team', teamDirPath: folderPath });
      } else {
        setSelectedFolder({ path: folderPath, name: folderName, mode: 'personal' });
      }
      setShowTeamManage(false); setShowGlobalGraph(false);
    } else if (tabId.startsWith('__team__/')) {
      // 团队笔记标签：从服务端重新加载内容
      setSelectedFolder(null); setShowTeamManage(false); setShowGlobalGraph(false);
      const parsedTeamNote = parseTeamNoteId(tabId);
      const teamVaultId = parsedTeamNote.teamVaultId || useSessionStore.getState().teamVaultId;
      if (teamVaultId) {
        const loader = parsedTeamNote.fileId
          ? syncService.getVaultFileById(teamVaultId, parsedTeamNote.fileId)
          : syncService.getVaultFile(teamVaultId, parsedTeamNote.filePath || '').then(content => ({
              content,
              filePath: parsedTeamNote.filePath || '',
              fileId: '',
              docStatus: undefined,
              editorId: undefined,
              editorName: undefined,
            }));
        loader
          .then(({ content, filePath, fileId, docStatus, editorId, editorName }) => {
            const fileName = getBasename(filePath).replace(/\.md$/, '') || filePath;
            const { metadata, content: parsedContent } = metadataService.parse(filePath, content);
            if (fileId && !metadata.slash_id) metadata.slash_id = fileId;
            if (docStatus && !metadata.doc_status) metadata.doc_status = docStatus;
            if (editorId && !metadata.editor_id) metadata.editor_id = editorId;
            if (editorName && !metadata.editor) metadata.editor = editorName;
            metadata.team_path = filePath;
            metadata.team_vault_id = teamVaultId;
            const noteId = fileId
              ? buildStableTeamNoteId(teamVaultId, fileId)
              : buildLegacyTeamNoteId(filePath);
            selectNote({
              id: noteId,
              path: noteId,
              title: metadata.title || fileName,
              content: parsedContent,
              metadata,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          })
          .catch(err => console.error('[Tab] Failed to load team note:', err));
      }
    } else {
      setShowTeamManage(false); setSelectedFolder(null);
      handleTabClick(tabId);
    }
  }, [handleTabClick, selectNote]);

  const handleVaultOpened = async (path: string | null) => {
    const tabsStore = useTabsStore.getState();

    // 🛡️ 跨 Vault 切换强制登出（零信任防线）
    // 若当前已在某个 Vault，并且要切换离开（跳回引导页或另一个 Vault），强制清空全部全局凭证。
    // 这保证了 vault_binding.json 的 '1 Vault = 1 Team' 不会被内存中的幽灵凭证绕过。
    if (vaultPath && vaultPath !== path) {
      console.log('[App] Explicit vault switch detected. Enforcing total logout to prevent session crossover.');
      useSessionStore.getState().clearAll();
      syncService.clearConfig();
    }

    // Save current vault's tabs before switching (if we have a vault)
    if (vaultPath) {
      tabsStore.saveForVault(vaultPath);
    }

    // Clear note state when returning to welcome screen
    if (!path) {
      autoSyncManager.stop();
      syncService.setActiveVault(null);
      tabsStore.closeAllTabs();
      setSelectedNote(null);
      setContent(null);
      setVaultPath(null);
      setRepo(null);
      setIsSettingsOpen(false);
      setSettingsInitialTab(undefined);
      setIsRestoring(false); // 确保不会显示"恢复中"
      return;
    }

    // Clear current note state before loading new vault
    setSelectedNote(null);
    setContent(null);

    // CRITICAL: Clear FileSystem store root immediately to prevent ImageComponent
    // from resolving assets using stale vault path during the transition
    const { clearRoot } = await import('@/core/fs/store').then(m => m.useFileSystemStore.getState());
    clearRoot();

    // Load target vault's tabs
    tabsStore.loadForVault(path);

    setVaultPath(path);

    // Ensure PARA folder structure exists
    await ensureParaStructure(path).catch(console.error);

    // Initialize repository
    const newRepo = new FileSystemNoteRepository(path);
    await newRepo.initialize();
    setRepo(newRepo);

    // Load asset index for O(1) deduplication lookups
    loadAssetIndex().catch(console.error);

    // Start auto sync
    syncService.setActiveVault(path);
    autoSyncManager.start(path).catch(console.error);

    // 从服务端恢复红点状态（清 localStorage 后重登录也能正确重建）
    const teamVaultId = useSessionStore.getState().teamVaultId;
    if (teamVaultId) {
        import('@/stores/useCollabNotifyStore').then(({ useCollabNotifyStore }) => {
            useCollabNotifyStore.getState().refreshUnread(teamVaultId);
        });
    }

    // Persist last opened vault for next app launch
    localStorage.setItem('slash-last-vault', path);

    // Tab restoration will be handled by the useEffect that watches [repo]
  };

  // 🛡️ Layer 2/3: 响应 Vault 身份冲突或断开引导的强制关闭
  useEffect(() => {
    const handleForceClose = () => handleVaultOpened(null);
    window.addEventListener('vault:force-close', handleForceClose);
    return () => window.removeEventListener('vault:force-close', handleForceClose);
  }, []);

  // 监听全局打开设置的事件
  useEffect(() => {
    const handleOpenSettings = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.tab) {
        setSettingsInitialTab(customEvent.detail.tab);
      }
      setIsSettingsOpen(true);
    };
    window.addEventListener('app:open-settings', handleOpenSettings);
    return () => window.removeEventListener('app:open-settings', handleOpenSettings);
  }, []);

  // Show loading transition while restoring last vault (prevents WelcomeScreen flash)
  if (isRestoring && !vaultPath) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-900">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-500 dark:border-t-blue-400" />
          <span className="text-sm text-zinc-400">恢复中...</span>
        </div>
      </div>
    );
  }

  if (!vaultPath || !repo) {
    return <Suspense fallback={<div className="h-screen w-screen bg-white dark:bg-[#161616]" />}><WelcomeScreen onVaultOpened={handleVaultOpened} /></Suspense>;
  }

  // 右面板权限计算
  const isProjectsFolder = selectedFolder && /(?:^|[\/\\])(01_)?projects([\/\\]|$)/i.test(selectedFolder.path);
  const isNoteView = !!selectedNote && !showTeamManage && !selectedFolder;
  // 第一性原理：仅在具体笔记编辑视图时允许打开右侧侧边栏，目录管理页不展示且不允许打开右侧侧边栏
  const rightPanelAllowed = isNoteView;
  const allowedModes: RightPanelMode[] | undefined = undefined;
  const effectivelyGraphPanelOpen = graphPanelOpen && rightPanelAllowed;

  return (
    <div className="flex h-screen w-screen font-sans overflow-hidden">
      <Toaster
        position="top-center"
        duration={2500}
        offset={80}
        toastOptions={{
          style: {
            background: 'rgba(255, 255, 255, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(99, 102, 241, 0.15)',
            borderLeft: '3px solid #6366f1',
            borderRadius: '10px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(99, 102, 241, 0.06)',
            color: '#374151',
            fontSize: '13px',
            fontWeight: '500',
            padding: '12px 16px',
          },
          className: 'dark:!bg-zinc-900/90 dark:!border-blue-400/25 dark:!border-l-blue-400 dark:!text-zinc-200 dark:!shadow-[0_8px_32px_rgba(0,0,0,0.3),0_2px_8px_rgba(99,102,241,0.1)]',
        }}
      />
      <Suspense fallback={<div className="h-full border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-black/20 shrink-0" style={{ width: sidebarWidth, display: sidebarOpen ? 'block' : 'none' }} />}>
        <Sidebar
        onSelectNote={(note) => {
          setShowGlobalGraph(false);  // Close global graph when selecting a note
          setSelectedFolder(null);   // Close folder page when selecting a note
          setShowTeamManage(false);  // Close team manage page when selecting a note
          selectNote(note);
          // Auto-switch away from classification view if note is not in Inbox
          const isInInbox = note.id.includes('/00_Inbox/') || note.id.startsWith('00_Inbox/');
          if (rightPanelMode === 'classification' && !isInInbox) {
            setRightPanelMode('ghostlink');
          }
          // Auto-switch away from ghostlink and localgraph for team notes
          if ((rightPanelMode === 'ghostlink' || rightPanelMode === 'localgraph') && note.id.startsWith('__team__/')) {
            setRightPanelMode('outline');
          }
        }}
        selectedNoteId={selectedNote?.id}
        activeFolderPath={selectedFolder?.path}
        activeFolderMode={selectedFolder?.mode as 'personal' | 'team' | undefined}
        activeTeamNotePath={selectedNote?.id?.startsWith('__team__/') ? selectedNote.id : undefined}
        activeTeamNoteFileId={selectedNote?.id?.startsWith('__team__/') ? (selectedNote.metadata?.slash_id as string | undefined) : undefined}
        isOpen={sidebarOpen}
        onSettingsClick={() => setIsSettingsOpen(true)}
        onOpenSyncSettings={() => { setSettingsInitialTab('sync'); setIsSettingsOpen(true); }}
        onOpenTeamManage={() => { setShowTeamManage(true); setSelectedFolder(null); setShowGlobalGraph(false); setGraphPanelOpen(false); useTabsStore.getState().openTab('__team_manage__', '团队管理'); }}
        
        onFolderDeleted={(folderPath) => {
          if (selectedFolder?.path === folderPath || selectedFolder?.path.startsWith(folderPath + '/')) {
            const parentPath = getParentPath(folderPath);
            const isTeam = selectedFolder.mode === 'team';

            if (parentPath && vaultPath && parentPath.length > vaultPath.length) {
                // Navigate forcefully to the parent directory view
                const parentName = getBasename(parentPath) || '';
                const newTabId = '__folder__:' + parentPath;
                const title = isTeam ? '📁 ' + parentName : parentName;
                
                useTabsStore.getState().openTab(newTabId, title);
                performTabSwitch(newTabId);
            } else {
                // Cannot safely navigate to parent (e.g. at workspace root), fallback to adjacent
                setSelectedFolder(null);
                const { activeTabId } = useTabsStore.getState();
                if (activeTabId) {
                    performTabSwitch(activeTabId);
                } else {
                    setSelectedNote(null);
                    setContent('');
                    setShowTeamManage(false);
                }
            }
          }
          // Notify graph that folder structure was modified
          setGraphRefreshKey(k => k + 1);
        }}
        onNoteDeleted={(path) => {
            handleNoteDeleted(path);
            setGraphRefreshKey(k => k + 1);
        }}
        onNoteRenamed={async (oldPath, newPath) => {
          // If the renamed note is currently open, reload it with new path
          if (selectedNote?.id === oldPath && repo) {
            const reloadedNote = await repo.getNote(newPath);
            if (reloadedNote) {
              setSelectedNote(reloadedNote);
              setContent(reloadedNote.content);
            }
          }
          // Trigger graph refresh
          setGraphRefreshKey(k => k + 1);
        }}
        repository={repo}
        onSwitchVault={handleVaultOpened}
        width={sidebarWidth}
        onWidthChange={handleSidebarResize}
        onResizeStart={handleSidebarResizeStart}
        onResizeEnd={handleSidebarResizeEnd}
        onSelectProjectFolder={(folderPath, folderName) => {
          setSelectedNote(null); setContent('');
          setSelectedFolder({ path: folderPath, name: folderName, mode: 'personal' });
          setShowTeamManage(false);
          setShowGlobalGraph(false);
          setGraphPanelOpen(false);
          // Projects 目录自动切到 tasks 面板
          const isProjects = /(?:^|[\/\\])(01_)?projects([\/\\]|$)/i.test(folderPath);
          if (isProjects) {
            setRightPanelMode('tasks');
          }
          useTabsStore.getState().openTab('__folder__:' + folderPath, folderName);
        }}
        onSelectTeamDir={(dirPath, dirName) => {
          setSelectedNote(null); setContent('');
          setSelectedFolder({ path: dirPath, name: dirName, mode: 'team', teamDirPath: dirPath });
          setShowTeamManage(false);
          setShowGlobalGraph(false);
          setGraphPanelOpen(false);
          // 团队 Projects 目录也自动切到 tasks 面板
          const isProjects = /(?:^|[\/\\])(01_)?projects([\/\\]|$)/i.test(dirPath);
          if (isProjects) {
            setRightPanelMode('tasks');
          }
          useTabsStore.getState().openTab('__folder__:' + dirPath, '📁 ' + dirName);
        }}
        onOpenGlobalGraph={() => {
          setShowGlobalGraph(prev => !prev);
          if (!showGlobalGraph) setGraphPanelOpen(false);  // Close right panel when opening graph
        }}
      />
      </Suspense>

      {isSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={true}
            onClose={() => { setIsSettingsOpen(false); setSettingsInitialTab(undefined); }}
            onSwitchVault={handleVaultOpened}
            initialTab={settingsInitialTab}
            vaultPath={vaultPath || undefined}
          />
        </Suspense>
      )}

      {/* Main Content Area (editor + right sidebar) - relative container for global graph */}
      {/* z-[60] ensures tooltips and popovers render above Sidebar (z-50) */}
      <div className="flex-1 min-w-0 flex h-full relative z-60">
        <main className="flex-1 min-w-0 flex flex-col h-full transition-all duration-300 pt-8 relative">
          <TitleBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            sidebarWidth={sidebarWidth}
            isResizing={isResizing}
            onTabClick={performTabSwitch}
            onTabClose={(tabId) => {
              if (tabId === '__team_manage__') {
                setShowTeamManage(false);
              } else if (tabId.startsWith('__folder__:')) {
                setSelectedFolder(null);
              }
              handleTabClose(tabId);
            }}
            graphPanelOpen={effectivelyGraphPanelOpen}
            onToggleGraphPanel={rightPanelAllowed ? () => setGraphPanelOpen(!graphPanelOpen) : undefined}
            graphPanelWidth={graphPanelWidth}

            ghostLinkActive={selectedNote?.id?.startsWith('__team__/') ? false : ghostLinkActive}
            onToggleGhostLink={() => {
              if (selectedNote?.id?.startsWith('__team__/')) return;
              setGhostLinkActive(!ghostLinkActive);
            }}
            rightPanelMode={rightPanelMode}
            onSetRightPanelMode={setRightPanelMode}
            allowedRightPanelModes={allowedModes}
            isInboxNote={selectedNote?.id?.includes('/00_Inbox/') || selectedNote?.id?.startsWith('00_Inbox/')}
            onOpenSettings={() => { setSettingsInitialTab('ai'); setIsSettingsOpen(true); }}
            currentNotePath={selectedNote?.id || (selectedFolder?.path ? `${selectedFolder.path}/.dummy` : undefined)}
          />

          {/* Scanning Indicator Bar */}
          {isScanning && (
            <div className="h-1 bg-indigo-100 dark:bg-indigo-900/30 overflow-hidden">
              <div className="h-full bg-indigo-500 animate-pulse" style={{ width: '100%' }} />
            </div>
          )}

          {/* Database Error Banner */}
          {dbError && (
            <div className="px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
              ⚠️ {dbError}
            </div>
          )}

          {/* Main Editor / Preview Area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Editor Content */}
            <div ref={editorContainerRef} className={`slash-editor-zoom-area flex-1 overflow-y-scroll overflow-x-auto ${selectedNote?.id?.startsWith('__team__/') ? 'bg-[#E6A23C]/10 dark:bg-[#002FA7]/15' : ''}`}>
              {/* Team Manage View */}
              {showTeamManage ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-400">{t("common.loading", "Loading...")}</div>}>
                  <TeamManagePage onClose={() => { setShowTeamManage(false); useTabsStore.getState().closeTab('__team_manage__'); }} />
                </Suspense>
              ) : selectedFolder && vaultPath ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-400">{t("common.loading", "Loading...")}</div>}>
                  <FolderPage
                  folderPath={selectedFolder.path}
                  folderName={selectedFolder.name}
                  vaultPath={vaultPath}
                  mode={selectedFolder.mode || 'personal'}
                  teamDirPath={selectedFolder.teamDirPath}
                  onClose={() => {
                    setSelectedFolder(null);
                    // Close any __folder__: tab
                    useTabsStore.getState().closeTab('__folder__:' + selectedFolder.path);
                    if (cameFromGraphRef.current) {
                      cameFromGraphRef.current = false;
                      setShowGlobalGraph(true);
                    }
                  }}
                  onNavigateToNote={(notePath) => {
                    setSelectedFolder(null);
                    navigateToNotePath(notePath);
                  }}
                  />
                </Suspense>
              ) : selectedNote ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center h-full text-zinc-400">{t("common.loading", "Loading...")}</div>}>
                  {viewMode === 'media' ? (
                  <MediaPreview
                    key={noteSelectionKey}
                    path={selectedNote.id}
                    filename={selectedNote.title || selectedNote.id.split(/[\\/]/).pop() || ''}
                  />
                ) : (
                  content !== null ? (
                    <NoteContextProvider
                      key={noteSelectionKey}
                      initialNoteId={selectedNote.id}
                      initialTitle={selectedNote.title}
                    >
                      {selectedNote.id.startsWith('__team__/') ? (
                        <TeamReadOnlyGuard
                          content={content}
                          metadata={selectedNote.metadata}
                          noteId={selectedNote.id}
                        />
                      ) : (
                        <Editor
                          initialContent={content}
                          initialMetadata={selectedNote.metadata}
                          onSave={handleSave}
                          onTitleChange={handleTitleUpdate}
                          onNoteRenamed={async (oldPath, newPath) => {
                            // Update selectedNote with new path when title is changed via Editor
                            if (selectedNote?.id === oldPath && repo) {
                              const reloadedNote = await repo.getNote(newPath);
                              if (reloadedNote) {
                                setSelectedNote(reloadedNote);
                                setContent(reloadedNote.content);
                              }
                            }
                            setGraphRefreshKey(k => k + 1);
                          }}
                          isNewNote={isNewNote}
                          shouldFocusBody={shouldFocusBody}
                          onNavigateToNote={navigateToNotePath}
                          activeNoteId={selectedNote.id}
                        />
                      )}
                    </NoteContextProvider>
                  ) : (
                    <div className="flex-1 flex items-center justify-center h-full text-zinc-400">
                      {t("common.loading")}
                    </div>
                  )
                )}
                </Suspense>
              ) : (
                <div className="flex-1 flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 bg-black/10 dark:bg-white/10 rounded-xl flex items-center justify-center mb-2">
                      <span className="text-2xl">📄</span>
                    </div>
                    <p>{t("common.select_page")}</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Global Graph Overlay - only covers editor area */}
          {showGlobalGraph && vaultPath && (
            <Suspense fallback={null}>
              <KnowledgeGraphPage
              isGlobal={true}
              vaultPath={vaultPath}
              onClose={() => setShowGlobalGraph(false)}
              vaultName={vaultPath ? getBasename(vaultPath) : ''}
              refreshKey={graphRefreshKey}
              onNavigate={navigateToNotePath}
              onFolderClick={(folderPath, folderName) => {
                const relativePath = folderPath.startsWith(vaultPath + '/')
                  ? folderPath.slice(vaultPath!.length + 1)
                  : folderPath;
                if (relativePath.length > 0) {
                  const absPath = folderPath.startsWith('/') ? folderPath : `${vaultPath}/${folderPath}`;
                  cameFromGraphRef.current = true;
                  setSelectedFolder({ path: absPath, name: folderName });
                  useTabsStore.getState().openTab('__folder__:' + absPath, folderName);
                }
              }}
            />
            </Suspense>
          )}
        </main>

        {/* Right Sidebar - Graph Panel (same level as main) */}
        <Suspense fallback={effectivelyGraphPanelOpen ? <div className="h-full border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-black/20 shrink-0" style={{ width: graphPanelWidth }} /> : null}>
          <RightSidebar
          isOpen={effectivelyGraphPanelOpen}
          width={graphPanelWidth}
          onWidthChange={(width: number) => {
            setGraphPanelWidth(width);
            localStorage.setItem('graph_panel_width', width.toString());
          }}
          onResizeStart={() => setIsResizing(true)}
          onResizeEnd={() => setIsResizing(false)}
        >
          <Suspense fallback={<div className="p-4 flex items-center justify-center h-full"><div className="w-5 h-5 border-2 border-indigo-500/30 dark:border-blue-400/25 border-t-indigo-500 dark:border-t-blue-400 rounded-full animate-spin" /></div>}>
            {rightPanelMode === 'outline' ? (
            <OutlinePanel />
          ) : rightPanelMode === 'tasks' ? (
              <NoteTaskPanel
                notePath={selectedNote?.id || null}
                markdownContent={selectedNote?.id?.startsWith('__team__/') ? (selectedNote?.content ?? null) : null}
                projectPath={selectedFolder && isProjectsFolder ? getRelativePath(selectedFolder.path, vaultPath) : null}
              />
          ) : rightPanelMode === 'ghostlink' ? (
              <GhostLinkPanel
                notePath={selectedNote?.id || null}
                onNavigate={navigateToNotePath}
                onConfirmLink={async (relation, targetTitle, targetPath) => {
                  console.log('🔗 [App] Confirm link:', relation, '->', targetTitle, 'path:', targetPath);
                  if (!selectedNote?.id) return;

                  try {
                    // Call Tauri command to update YAML frontmatter (bidirectional)
                    await invoke('add_note_relation', {
                      notePath: selectedNote.id,
                      relationType: relation,
                      targetTitle: targetTitle,
                      targetPath: targetPath
                    });
                    console.log('✅ [App] Bidirectional relation added:', `${relation}: ${targetTitle}`);

                    // Dispatch events to expand properties panel and reload note content
                    window.dispatchEvent(new CustomEvent('slash:expand-properties'));
                    window.dispatchEvent(new CustomEvent('slash:reload-note'));
                    window.dispatchEvent(new CustomEvent('slash:graph-refresh'));
                  } catch (e) {
                    console.error('Failed to add relation:', e);
                  }
                }}
                initialGhostLinks={ghostLinksData}
                reasoningResults={ghostLinkReasons}
                onRefresh={async (thresholdValue?: number) => {
                  if (!selectedNote?.id) return;
                  try {
                    const result = await invoke<{ notes: GhostLink[] }>('get_ghost_links', { notePath: selectedNote.id, threshold: thresholdValue ?? null });
                    if (result.notes.length > 0) {
                      setGhostLinksData(result.notes);
                      triggerReasoning(selectedNote.id, result.notes);
                    } else {
                      setGhostLinksData([]);
                    }
                  } catch (e) {
                    console.error('[App] Ghost link refresh failed:', e);
                  }
                }}
              />
          ) : rightPanelMode === 'activity' ? (
            isTeamNote 
              ? <ActivityTimeline notePath={selectedNote?.id || null} docStatus={(selectedNote?.metadata?.doc_status as any) || 'solo'} vaultPath={vaultPath} readOnly={!!selectedNote?.id?.startsWith('__team__/')} />
              : <VersionTimeline notePath={selectedNote?.id || null} />
          ) : rightPanelMode === 'classification' ? (
            // Only show classification panel for notes in 00_Inbox
            (() => {
              const isInInbox = selectedNote?.id?.includes('/00_Inbox/') || selectedNote?.id?.startsWith('00_Inbox/');
              if (!isInInbox) {
                // Switch to ghostlink mode for non-Inbox notes
                setTimeout(() => setRightPanelMode('ghostlink'), 0);
                return null;
              }
              return (
                <ClassificationPanel
                  notePath={selectedNote?.id || ''}
                  noteTitle={selectedNote?.title || ''}
                  noteContent={content || ''}
                  vaultPath={vaultPath}
                  onClose={() => setRightPanelMode('ghostlink')}
                  onMoved={async (newPath) => {
                    console.log('✅ [Classification] Note moved to:', newPath);
                    // Directly refresh the file tree store
                    const { useFileSystemStore } = await import('@/core/fs/store');
                    await useFileSystemStore.getState().refreshTree();
                  }}
                />
              );
            })()
          ) : rightPanelMode === 'localgraph' ? (
            <LocalGraphPanel
              notePath={selectedNote?.id && vaultPath ? getRelativePath(selectedNote.id, vaultPath) : null}
              onNavigate={navigateToNotePath}
              refreshKey={graphRefreshKey}
            />
          ) : null}
          </Suspense>
        </RightSidebar>
        </Suspense>
      </div>

      {/* Search Panel */}
      {isSearchOpen && (
        <Suspense fallback={null}>
          <SearchPanel
            isOpen={true}
            onClose={() => setIsSearchOpen(false)}
            onSelectNote={(notePath: string, lineNumber?: number) => {
              navigateToNotePath(notePath);
              // Emit event to scroll to line after editor loads
              if (lineNumber !== undefined) {
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('scroll-to-line', { detail: { lineNumber } }));
                }, 300); // Wait for editor to load content
              }
            }}
            vaultPath={vaultPath}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
