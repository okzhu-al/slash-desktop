import { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Square, X, Copy, PanelRightOpen, PanelRightClose, Sparkles, ListChecks, FolderArchive, History, List, Network } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { useTabsStore, Tab } from "@/core/tabs/TabsStore";
import { cn } from "@/shared/utils/cn";
import { useIsTeamNote } from "@/hooks/useIsTeamNote";
import { UpdateCheckerModal } from "@/features/settings/UpdateCheckerModal";
import slashLogo from '@/assets/icon.png';

export type RightPanelMode = 'ghostlink' | 'tasks' | 'classification' | 'activity' | 'outline' | 'localgraph';

interface TitleBarProps {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    sidebarWidth?: number;
    isResizing?: boolean;
    onTabClick?: (tabId: string) => void;
    onTabClose?: (tabId: string) => void;
    graphPanelOpen?: boolean;
    onToggleGraphPanel?: () => void;
    graphPanelWidth?: number;
    ghostLinkActive?: boolean;
    onToggleGhostLink?: () => void;
    // New: 3-panel mode support
    rightPanelMode?: RightPanelMode;
    onSetRightPanelMode?: (mode: RightPanelMode) => void;
    isInboxNote?: boolean;
    onOpenSettings?: () => void;
    currentNotePath?: string;
    allowedRightPanelModes?: RightPanelMode[];
}

// AI connection status type
interface AIStatus {
    connected: boolean;
    generation_model_available: boolean;
    embedding_model_available: boolean;
}

export const TitleBar = ({
    sidebarOpen,
    onToggleSidebar,
    sidebarWidth = 256,
    isResizing = false,
    onTabClick,
    onTabClose,
    graphPanelOpen = false,
    onToggleGraphPanel,
    graphPanelWidth = 320,
    rightPanelMode = 'ghostlink',
    onSetRightPanelMode,
    isInboxNote = false,
    onOpenSettings,
    currentNotePath,
    allowedRightPanelModes,
}: TitleBarProps) => {
    const { t } = useTranslation();
    const [isMac, setIsMac] = useState(false);
    const [isWindowMaximized, setIsWindowMaximized] = useState(false);
    const { tabs, activeTabId, setActiveTab, closeTab } = useTabsStore();
    const tabsContainerRef = useRef<HTMLDivElement>(null);
    const isTeamNote = useIsTeamNote(currentNotePath);

    useEffect(() => {

    }, []);

    // AI status state
    const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
    const [providerType, setProviderType] = useState<'local' | 'online'>('local');
    const [hasAvailableUpdate, setHasAvailableUpdate] = useState(false);
    const [showUpdateModal, setShowUpdateModal] = useState(false);

    useEffect(() => {
        const isMacOS = navigator.userAgent.includes("Mac");
        setIsMac(isMacOS);

        if (!isMacOS) {
            const checkMaximized = async () => {
                try {
                    const maximized = await getCurrentWindow().isMaximized();
                    setIsWindowMaximized(maximized);
                } catch (e) {
                    // Ignore errors
                }
            };
            checkMaximized();

            let unlisten: (() => void) | undefined;
            getCurrentWindow().onResized(async () => {
                checkMaximized();
            }).then(fn => {
                unlisten = fn;
            }).catch(() => {});

            return () => {
                if (unlisten) unlisten();
            };
        }
    }, []);

    // Check effective AI connection status on mount and periodically
    useEffect(() => {
        const checkAIStatus = async () => {
            try {
                const pathToCheck = currentNotePath || "";

                if (pathToCheck) {
                    const pt = await invoke<string>('get_effective_provider_type', { notePath: pathToCheck });
                    setProviderType(pt === 'online' ? 'online' : 'local');
                } else {
                    const config = await invoke<{ provider_type: string }>('get_ai_config');
                    setProviderType(config.provider_type === 'online' ? 'online' : 'local');
                }

                const status = await invoke<{ generation_model_available: boolean; embedding_model_available: boolean }>('check_effective_ai_connection', { notePath: pathToCheck });
                setAiStatus({
                    connected: status.generation_model_available,
                    generation_model_available: status.generation_model_available,
                    embedding_model_available: status.embedding_model_available,
                });
            } catch {
                setAiStatus({
                    connected: false,
                    generation_model_available: false,
                    embedding_model_available: false,
                });
            }
        };

        checkAIStatus();
        const interval = setInterval(checkAIStatus, 30000);
        window.addEventListener('ai_settings_changed', checkAIStatus);
        
        return () => {
            clearInterval(interval);
            window.removeEventListener('ai_settings_changed', checkAIStatus);
        };
    }, [currentNotePath]);

    useEffect(() => {
        let cancelled = false;
        let checking = false;
        let warmupTimer: number | undefined;
        let warmupChecks = 0;
        const maxWarmupChecks = 10;

        const checkForAvailableUpdate = async () => {
            if (checking) return;
            checking = true;
            try {
                const update = await check();
                if (!cancelled) {
                    setHasAvailableUpdate(Boolean(update));
                    if (update && warmupTimer !== undefined) {
                        window.clearInterval(warmupTimer);
                        warmupTimer = undefined;
                    }
                }
            } catch {
                // Background check stays quiet; the About panel still shows detailed update errors.
            } finally {
                checking = false;
            }
        };

        const handleUpdateAvailable = () => {
            setHasAvailableUpdate(true);
        };

        const initialTimer = window.setTimeout(checkForAvailableUpdate, 5000);
        warmupTimer = window.setInterval(() => {
            warmupChecks += 1;
            void checkForAvailableUpdate();
            if (warmupChecks >= maxWarmupChecks && warmupTimer !== undefined) {
                window.clearInterval(warmupTimer);
                warmupTimer = undefined;
            }
        }, 60 * 1000);
        const interval = window.setInterval(checkForAvailableUpdate, 6 * 60 * 60 * 1000);
        window.addEventListener('slash:update-available', handleUpdateAvailable);

        return () => {
            cancelled = true;
            window.clearTimeout(initialTimer);
            if (warmupTimer !== undefined) {
                window.clearInterval(warmupTimer);
            }
            window.clearInterval(interval);
            window.removeEventListener('slash:update-available', handleUpdateAvailable);
        };
    }, []);

    const minimize = () => getCurrentWindow().minimize();
    const maximize = async () => {
        await getCurrentWindow().toggleMaximize();
        try {
            const maximized = await getCurrentWindow().isMaximized();
            setIsWindowMaximized(maximized);
        } catch (e) {
            // Ignore
        }
    };
    const close = () => getCurrentWindow().close();

    const handleTabClick = (tabId: string) => {
        setActiveTab(tabId);
        onTabClick?.(tabId);
    };

    const handleTabClose = (e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        closeTab(tabId);
        onTabClose?.(tabId);
    };

    const handleHorizontalWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (el.scrollWidth <= el.clientWidth) return;
        const primaryDelta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (primaryDelta === 0) return;
        e.preventDefault();
        e.stopPropagation();
        el.scrollLeft += primaryDelta;
    }, []);

    const isAIReady = aiStatus?.connected && aiStatus?.generation_model_available && aiStatus?.embedding_model_available;
    const aiLabel = providerType === 'online' ? 'Online AI' : 'Local AI';

    return (
        <div data-tauri-drag-region className={`h-8 flex items-center justify-between text-sm select-none fixed top-0 left-0 right-0 z-10000 transition-colors overflow-hidden border-b border-zinc-200 dark:border-zinc-700 ${isMac ? 'pl-0' : 'pl-0'}`}>

            {/* Left Section (Top Left Sidebar Header Control) */}
            <div
                className={`flex items-center gap-2 shrink-0 h-full ease-in-out border-r border-zinc-200 dark:border-zinc-700 ${isMac ? 'pl-20' : 'pl-10'} ${isResizing ? '' : 'transition-all duration-300'}`}
                data-tauri-drag-region
                style={{
                    width: sidebarOpen ? sidebarWidth : 'auto',
                    justifyContent: isMac ? (sidebarOpen ? 'flex-end' : 'flex-start') : 'flex-end',
                    paddingRight: sidebarOpen ? '16px' : '8px'
                }}
            >
                {/* Update Capsule */}
                {hasAvailableUpdate && (
                    <button
                        onClick={() => setShowUpdateModal(true)}
                        className={cn(
                            "no-drag flex shrink-0 items-center h-5 px-2.5 rounded-full text-[11px] font-semibold leading-none whitespace-nowrap",
                            "bg-indigo-500 text-white shadow-sm shadow-indigo-500/20",
                            "hover:bg-indigo-600 active:bg-indigo-700 transition-colors cursor-pointer"
                        )}
                        title={t('settings.update_available', '发现新版本可用')}
                    >
                        {t('settings.update_badge', '更新')}
                    </button>
                )}

                {/* AI Status Indicator */}
                {aiStatus !== null && (
                    <button
                        onClick={onOpenSettings}
                        className={cn(
                            "no-drag flex shrink-0 items-center gap-1.5 h-5 px-2 rounded-md transition-all text-xs font-medium leading-none whitespace-nowrap",
                            "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                            isAIReady
                                ? "text-zinc-600 dark:text-zinc-400"
                                : "text-zinc-500 dark:text-zinc-500"
                        )}
                        title={
                            aiStatus.connected
                                ? isAIReady
                                    ? `${aiLabel} ${t('ai.status_ready', '服务就绪')}`
                                    : `${aiLabel} ${t('ai.status_partial', '部分可用')}`
                                : `${aiLabel} ${t('ai.status_offline', '服务离线')}`
                        }
                    >
                        {/* Status dot: 绿=可用, 红=不可用 */}
                        <span className="relative flex h-2 w-2">
                            {isAIReady && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#006540] opacity-75" />
                            )}
                            <span className={cn(
                                "relative inline-flex rounded-full h-2 w-2",
                                isAIReady ? "bg-[#006540]" : "bg-red-500"
                            )} />
                        </span>
                        {/* 文字: Local=绿, Online=橙 */}
                        <span className={cn(
                            providerType === 'online'
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-[#006540] dark:text-[#006540]"
                        )}>{aiLabel}</span>
                    </button>
                )}

                {showUpdateModal && (
                    <UpdateCheckerModal onClose={() => setShowUpdateModal(false)} />
                )}

                <button
                    onClick={onToggleSidebar}
                    className={cn(
                        "group transition-transform hover:scale-105 active:scale-95 focus:outline-none shrink-0",
                        !isMac ? "absolute left-3 no-drag" : ""
                    )}
                    title={sidebarOpen ? t('sidebar.close') : t('sidebar.open')}
                >
                    <img 
                        src={slashLogo} 
                        alt="Slash" 
                        className="w-5.5 h-5.5 shadow-sm shadow-indigo-900/20 select-none pointer-events-none"
                        style={{ borderRadius: '22.5%' }}
                    />
                </button>

            </div>

            <div
                ref={tabsContainerRef}
                onWheel={handleHorizontalWheel}
                className="flex-1 min-w-0 flex items-center gap-0.5 h-full overflow-x-auto [&::-webkit-scrollbar]:hidden px-2"
                data-tauri-drag-region
            >
                {tabs.map((tab: Tab) => (
                    <div
                        key={tab.id}
                        onClick={() => handleTabClick(tab.id)}
                        className={cn(
                            "group flex items-center gap-1.5 px-3 h-6 rounded-md cursor-pointer transition-all duration-150 shrink-0 max-w-[160px]",
                            tab.id === activeTabId
                                ? "bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100"
                                : "text-zinc-500 dark:text-zinc-400 hover:bg-white/50 dark:hover:bg-zinc-800/50 hover:text-zinc-700 dark:hover:text-zinc-300"
                        )}
                    >
                        {/* Dirty indicator */}
                        {tab.isDirty && (
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                        )}

                        {/* Tab title */}
                        <span className="text-xs font-medium truncate">
                            {tab.title}
                        </span>

                        {/* Close button */}
                        <button
                            onClick={(e) => handleTabClose(e, tab.id)}
                            className={cn(
                                "shrink-0 rounded-sm p-0.5 transition-colors",
                                tab.id === activeTabId
                                    ? "opacity-60 hover:opacity-100 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                                    : "opacity-0 group-hover:opacity-60 hover:opacity-100! hover:bg-zinc-200 dark:hover:bg-zinc-700"
                            )}
                        >
                            <X size={12} />
                        </button>
                    </div>
                ))}
            </div>

            {/* Panel Toggle Button (Moved outside Right Section) */}
            {onToggleGraphPanel && (
                <button
                    onClick={onToggleGraphPanel}
                    className="shrink-0 w-7 h-7 flex items-center justify-center px-1 mx-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                    title={graphPanelOpen ? t('panel.close') : t('panel.open')}
                >
                    {graphPanelOpen ? <PanelRightClose size={18} strokeWidth={1.5} /> : <PanelRightOpen size={18} strokeWidth={1.5} />}
                </button>
            )}

            <div
                className={`flex items-center gap-2 shrink-0 h-full transition-all duration-300 ${graphPanelOpen ? 'border-l border-zinc-200 dark:border-zinc-700' : 'border-l border-transparent'}`}
                data-tauri-drag-region
                style={{
                    width: graphPanelOpen ? graphPanelWidth : (isMac ? 16 : 140),
                    justifyContent: 'flex-start',
                    paddingLeft: graphPanelOpen ? '3px' : 0,
                    paddingRight: isMac ? 16 : 140,
                    opacity: graphPanelOpen ? 1 : 0,
                    overflow: 'hidden'
                }}
            >
                {/* Action buttons - only show when panel is open */}
                {graphPanelOpen && (
                <div onWheel={handleHorizontalWheel} className="flex items-center gap-1.5 pr-2 overflow-x-auto min-w-0 [&::-webkit-scrollbar]:hidden h-full">
                        {/* Outline Button */}
                        {onSetRightPanelMode && (!allowedRightPanelModes || allowedRightPanelModes.includes('outline')) && (
                            <button
                                onClick={() => onSetRightPanelMode('outline')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'outline'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={t('outline.panel_title', '笔记大纲')}
                            >
                                <List size={18} strokeWidth={1.5} />
                            </button>
                        )}
                        {/* GhostLink Button - 团队文件时隐藏 */}
                        {!currentNotePath?.startsWith('__team__/') && (!allowedRightPanelModes || allowedRightPanelModes.includes('ghostlink')) && (
                            <button
                                onClick={() => onSetRightPanelMode?.('ghostlink')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'ghostlink'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={t('graph.ghost_links', 'Related Notes')}
                            >
                                <Sparkles size={18} strokeWidth={1.5} />
                            </button>
                        )}
                        {/* Local Graph Button - 团队文件时隐藏 */}
                        {!currentNotePath?.startsWith('__team__/') && onSetRightPanelMode && (!allowedRightPanelModes || allowedRightPanelModes.includes('localgraph')) && (
                            <button
                                onClick={() => onSetRightPanelMode('localgraph')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'localgraph'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={t('graph.local_title', '关联图谱')}
                            >
                                <Network size={18} strokeWidth={1.5} />
                            </button>
                        )}
                        {/* Task Panel Button */}
                        {onSetRightPanelMode && (!allowedRightPanelModes || allowedRightPanelModes.includes('tasks')) && (
                            <button
                                onClick={() => onSetRightPanelMode('tasks')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'tasks'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={t('tasks.panel_title', 'Tasks')}
                            >
                                <ListChecks size={18} strokeWidth={1.5} />
                            </button>
                        )}
                        {/* 历史快照/协作历史 Button（版本 + 批注 + 评论 统一入口）*/}
                        {onSetRightPanelMode && (!allowedRightPanelModes || allowedRightPanelModes.includes('activity')) && (
                            <button
                                onClick={() => onSetRightPanelMode('activity')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'activity'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={isTeamNote ? t('activity.panel_title', '协作历史') : t('activity.history_title', '历史快照')}
                            >
                                <History size={18} strokeWidth={1.5} />
                            </button>
                        )}
                        {/* Classification Button - only show for Inbox notes */}
                        {onSetRightPanelMode && isInboxNote && (!allowedRightPanelModes || allowedRightPanelModes.includes('classification')) && (
                            <button
                                onClick={() => onSetRightPanelMode('classification')}
                                className={`w-7 h-7 flex items-center justify-center px-1 rounded-md transition-colors ${rightPanelMode === 'classification'
                                    ? 'text-[#002FA7] dark:text-blue-400 bg-[#002FA7]/10 dark:bg-[#002FA7]/20'
                                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                title={t('classification.title', '智能归档')}
                            >
                                <FolderArchive size={18} strokeWidth={1.5} />
                            </button>
                        )}
                    </div>
                )}

                {/* Spacer to push window controls to the right when panel is open */}
                {graphPanelOpen && isMac && <div className="flex-1" data-tauri-drag-region />}
            </div>



            {/* Window Controls (Windows only) */}
            {!isMac && (
                <div className="absolute top-0 right-0 flex text-black dark:text-white shrink-0 h-full z-50 bg-white dark:bg-[#161616]">
                    <button onClick={minimize} className="inline-flex justify-center items-center w-[42px] h-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag">
                        <Minus size={16} strokeWidth={1.5} />
                    </button>
                    <button onClick={maximize} className="inline-flex justify-center items-center w-[42px] h-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag">
                        {isWindowMaximized ? <Copy size={14} strokeWidth={1.5} /> : <Square size={14} strokeWidth={1.5} />}
                    </button>
                    <button onClick={close} className="inline-flex justify-center items-center w-[42px] h-full hover:bg-[#e81123] hover:text-white transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag" title={t('window.close')}>
                        <X size={16} strokeWidth={1.5} />
                    </button>
                </div>
            )}
        </div>
    );
};
