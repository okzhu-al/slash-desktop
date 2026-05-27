/**
 * useAppEventListeners — 全局事件监听器集合
 *
 * 从 App.tsx 抽取的独立 hook，集中管理：
 * - Tldraw popover 点击修复（capture-phase pointerup）
 * - AI 降级事件监听（ai:degraded → toast warning）
 * - 语言切换同步 document.lang
 * - Cmd+K 搜索快捷键 + Cmd+= / Cmd+- / Cmd+0 / Ctrl+Wheel 缩放
 * - collab:new-events 监听 → 写 store + 自动切换协作面板
 * - 笔记切换时未读检测 → 自动打开协作面板
 * - 全局 toast bridge（__slashToast）
 * - V1 安全会话迁移（一次性）
 */
import { useEffect, MutableRefObject } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { syncService } from '@/services/SyncService';
import { useCollabNotifyStore } from '@/stores/useCollabNotifyStore';
import { getBasename } from '@/shared/utils/pathUtils';
import type { RightPanelMode } from '@/shared/ui/layout/TitleBar';

interface UseAppEventListenersOptions {
  /** 当前笔记路径的 stable ref */
  currentNotePathRef: MutableRefObject<string | undefined>;
  /** 当前选中笔记 ID */
  selectedNoteId: string | undefined;
  /** 打开搜索面板回调 */
  setIsSearchOpen: (open: boolean) => void;
  /** 设置右面板模式回调 */
  setRightPanelMode: (mode: RightPanelMode) => void;
  /** 设置右面板展开回调 */
  setGraphPanelOpen: (open: boolean) => void;
  /** vault 路径（用于同步 window 全局状态） */
  vaultPath: string | null;
}

export function useAppEventListeners({
  currentNotePathRef,
  selectedNoteId,
  setIsSearchOpen,
  setRightPanelMode,
  setGraphPanelOpen,
  vaultPath,
}: UseAppEventListenersOptions) {
  const { t, i18n } = useTranslation();
  const { markUnreadFromEvents } = useCollabNotifyStore();

  // Sync vaultPath to global window
  useEffect(() => {
    (window as any).__slashVaultPath = vaultPath;
  }, [vaultPath]);

  // Global toast bridge
  useEffect(() => {
    (window as any).__slashToast = (type: 'error' | 'success', titleKey: string, descKey?: string) => {
      if (type === 'error') {
        toast.error(t(titleKey as any), descKey ? { description: t(descKey as any) } : undefined);
      } else {
        toast.success(t(titleKey as any), descKey ? { description: t(descKey as any) } : undefined);
      }
    };
    return () => {
      delete (window as any).__slashToast;
    };
  }, [t]);

  // Startup Migration: Enforce V1 Secure Session Keyring transition
  useEffect(() => {
    const migrated = localStorage.getItem('slash_session_migrated_v1');
    if (!migrated) {
      console.log('[App] Migrating to V1 secure sessions. Wiping old tokens...');
      syncService.clearConfig();
      localStorage.setItem('slash_session_migrated_v1', 'true');
    }
  }, []);

  // FIX: Workaround for Tldraw menu button clicks not working
  useEffect(() => {
    const handlePointerUp = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const popover = target.closest('.tlui-popover__content');

      if (popover) {
        const button = target.closest('button') as HTMLButtonElement | null;
        if (button && !button.disabled) {
          const propsKey = Object.keys(button).find(k => k.startsWith('__reactProps'));
          if (propsKey) {
            const props = (button as any)[propsKey];
            if (props && typeof props.onClick === 'function') {
              const syntheticEvent = {
                type: 'click',
                target: button,
                currentTarget: button,
                preventDefault: () => { },
                stopPropagation: () => { },
                nativeEvent: e,
              };

              setTimeout(() => {
                props.onClick(syntheticEvent);
              }, 0);
            }
          }
        }
      }
    };

    document.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      document.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, []);

  // Listen for AI Fallback events
  useEffect(() => {
    let unlisten: UnlistenFn;
    let cancelled = false;
    const setupListener = async () => {
      const cleanup = await listen('ai:degraded', (event: any) => {
        toast.warning(
          t('settings.ai_provider_degraded', { defaultValue: event.payload?.message }) as string,
          { id: 'ai-fallback-warning' }
        );
      });
      if (cancelled) cleanup();
      else unlisten = cleanup;
    };
    setupListener();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [t]);

  // Initialize Language
  useEffect(() => {
    const handleLangChange = (lng: string) => {
      if (lng.startsWith('zh')) {
        document.documentElement.lang = 'zh-CN';
      } else {
        document.documentElement.lang = 'en';
      }
    };
    handleLangChange(i18n.language);
    i18n.on('languageChanged', handleLangChange);
    return () => {
      i18n.off('languageChanged', handleLangChange);
    };
  }, [i18n]);

  // Global keyboard shortcuts and zoom handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          import('../stores/useEditorZoomStore').then(m => m.useEditorZoomStore.getState().zoomIn());
        } else if (e.key === '-') {
          e.preventDefault();
          import('../stores/useEditorZoomStore').then(m => m.useEditorZoomStore.getState().zoomOut());
        } else if (e.key === '0') {
          e.preventDefault();
          import('../stores/useEditorZoomStore').then(m => m.useEditorZoomStore.getState().resetZoom());
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (!(e.target as Element)?.closest('.slash-editor-zoom-area')) {
          return;
        }
        e.preventDefault();
        import('../stores/useEditorZoomStore').then(m => {
          m.useEditorZoomStore.getState().zoomBy(e.deltaY * -0.005);
        });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // ── 开启和关闭画板时：重置/还原编辑器 zoom 缩放 ──
  useEffect(() => {
    let savedZoomLevel = 1.0;

    const handleResetZoom = () => {
      import('../stores/useEditorZoomStore').then(m => {
        const store = m.useEditorZoomStore.getState();
        savedZoomLevel = store.zoomLevel;
        console.log('[Drawing-ZoomSync] Saving current zoom level:', savedZoomLevel, 'and resetting to 1.0');
        store.resetZoom();
      });
    };

    const handleRestoreZoom = () => {
      import('../stores/useEditorZoomStore').then(m => {
        const store = m.useEditorZoomStore.getState();
        console.log('[Drawing-ZoomSync] Restoring zoom level to:', savedZoomLevel);
        store.setZoomLevel(savedZoomLevel);
      });
    };

    window.addEventListener('slash:reset-editor-zoom', handleResetZoom);
    window.addEventListener('slash:restore-editor-zoom', handleRestoreZoom);
    return () => {
      window.removeEventListener('slash:reset-editor-zoom', handleResetZoom);
      window.removeEventListener('slash:restore-editor-zoom', handleRestoreZoom);
    };
  }, []);

  // ── 协作事件提示：监听 collab:new-events ──
  useEffect(() => {
    const handleCollabEvents = (e: Event) => {
      const { events } = (e as CustomEvent).detail as { events: import('@/services/CollabService').CollabEvent[] };
      if (!events?.length) return;
      markUnreadFromEvents(events);
      // 若当前打开的笔记恰好有新事件，立即切换到协作面板
      const currentPath = currentNotePathRef.current;
      if (currentPath) {
        const normCurrent = currentPath.replace(/^__team__\//, '').replace(/^\/|^\.\//g, '');
        const hit = events.some(ev => normCurrent.endsWith(ev.file_path) || ev.file_path.endsWith(getBasename(normCurrent) || ''));
        if (hit) {
          setRightPanelMode('activity');
        }
      }
    };
    window.addEventListener('collab:new-events', handleCollabEvents);
    return () => window.removeEventListener('collab:new-events', handleCollabEvents);
  }, [markUnreadFromEvents]);

  // ── 笔记切换时：有未读事件 → 自动打开协作面板 ──
  useEffect(() => {
    if (!selectedNoteId) return;
    const relPath = selectedNoteId.replace(/^__team__\//, '').replace(/^\/|^\.\//g, '');
    const basename = getBasename(selectedNoteId) ?? '';
    const { unreadFiles } = useCollabNotifyStore.getState();
    const hasUnread = unreadFiles.has(relPath) ||
      (basename.endsWith('.md') && [...unreadFiles.keys()].some(p => p === basename || p.endsWith('/' + basename)));
    if (hasUnread) {
      setRightPanelMode('activity');
      setGraphPanelOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId]);
}
