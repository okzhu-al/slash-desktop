/**
 * TldrawEditor - Lazily loaded Tldraw canvas wrapper
 * 
 * Provides the full Tldraw editing experience with:
 * - Dark mode sync with Slash theme
 * - Icon-based toolbar (matching Tldraw style)
 * - Fullscreen mode (app-level, not system)
 * - JSON state persistence
 * - TipTap keyboard lock during editing
 */

import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { Tldraw, Editor, getSnapshot, loadSnapshot, createTLUser, TLUserPreferences, Box } from 'tldraw';
import 'tldraw/tldraw.css';


// useTheme will be injected or mocked since it's an app-specific context usually.
// Or we can rely on a generic 'theme' prop passed to the editor.
// For now, let's use EditorDI to inject theme if possible, or fallback to 'light'.
import { useEditorServices } from '../../EditorDI';
import { useTranslation } from 'react-i18next';
import { atom } from '@tldraw/state';
// CustomTextShapeUtil import removed - using native Tldraw text rendering

// Custom asset URLs for Tldraw - MUST be defined outside component to prevent re-renders
// Replace tldraw_draw font with LXGW WenKai for CJK support (WOFF2: 7.9MB vs TTF: 24MB)
const customAssetUrls = {
    fonts: {
        tldraw_draw: '/fonts/LXGWWenKai-Regular.woff2',
    }
};

interface TldrawEditorProps {
    jsonPath: string | null;
    height: number;
    onSave: (data: { png: Blob; json: string; width: number; height: number }) => Promise<void>;
    onCancel: () => void;
    onBlur?: () => void;
    onLoad?: (jsonPath: string) => Promise<string>;
}

// SVG Icons matching Tldraw style (simple, minimal, 18x18)
const IconX = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const IconCheck = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const IconMaximize = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
);

const IconMinimize = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 14 10 14 10 20" />
        <polyline points="20 10 14 10 14 4" />
        <line x1="14" y1="10" x2="21" y2="3" />
        <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
);
const TldrawEditor: React.FC<TldrawEditorProps> = ({
    jsonPath,
    height,
    onSave,
    onCancel,
    onBlur: _onBlur, // Reserved for future blur-save
    onLoad,
}) => {
    const { t, i18n } = useTranslation();
    const editorRef = useRef<Editor | null>(null);
    const [isLoading, setIsLoading] = useState(!!jsonPath);
    const [_hasChanges, setHasChanges] = useState(false); // Tracked for future auto-save
    // Hover and dark mode variables removed

    // Attempt to get theme from DI if available, otherwise default to context or 'light'
    const { EditorThemeType } = useEditorServices();
    const ctxTheme = EditorThemeType ? React.useContext(EditorThemeType)?.theme : 'light';
    // Dark mode state mapped directly in colorScheme
    const [isFullscreen, setIsFullscreen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Synchronize viewport screen bounds with explicit DOM measurements to solve WebKit misalignment
    const syncViewportBounds = useCallback((force = false) => {
        const container = containerRef.current?.querySelector('.tl-container') || containerRef.current;
        const rect = container?.getBoundingClientRect();
        if (rect && editorRef.current) {
            if (force) {
                // 💡 仅在挂载排版稳定期强制写入精密 bounds，在鼠标交互时保持不干预，平抑 WebKit 初始 DPI 偏差
                editorRef.current.updateViewportScreenBounds(new Box(rect.left, rect.top, rect.width, rect.height));
            }
        }
    }, []);

    // Internal clipboard to work around Tauri WebView clipboard permission issues
    // Tldraw's async copy operation loses the "user gesture" context required by WKWebView
    const internalClipboardRef = useRef<unknown>(null);

    // Determine platform for shortcut display
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const saveShortcut = isMac ? '⌘+Enter' : 'Ctrl+Enter';
    const cancelShortcut = 'Esc';

    // Map i18n language to Tldraw locale
    // Tldraw uses 'zh-cn' for Simplified Chinese, i18n uses 'zh' or 'zh-CN'
    const tldrawLocale = useMemo(() => {
        const lang = i18n.language;
        if (lang.startsWith('zh')) return 'zh-cn';
        return 'en'; // Default to English
    }, [i18n.language]);

    // Create Tldraw user with current locale
    const tldrawUser = useMemo(() => {
        const preferences: TLUserPreferences = {
            id: 'slash-user',
            locale: tldrawLocale,
            colorScheme: ctxTheme === 'dark' ? 'dark' : 'light',
        };
        return createTLUser({
            userPreferences: atom('userPreferences', preferences),
        });
    }, [tldrawLocale, ctxTheme]);

    // Load existing drawing from JSON
    useEffect(() => {
        const loadDrawing = async () => {
            if (!jsonPath || !onLoad || !editorRef.current) return;

            try {
                const jsonContent = await onLoad(jsonPath);
                const snapshot = JSON.parse(jsonContent);
                loadSnapshot(editorRef.current.store, snapshot);
                setIsLoading(false);
            } catch (error) {
                console.error('[TldrawEditor] Failed to load drawing:', error);
                setIsLoading(false);
            }
        };

        if (editorRef.current && jsonPath) {
            loadDrawing();
        }
    }, [jsonPath, onLoad]);

    // Handle editor mount
    const handleMount = useCallback((editor: Editor) => {
        editorRef.current = editor;

        // If we have a jsonPath, load it
        if (jsonPath && onLoad) {
            setIsLoading(true);
            onLoad(jsonPath)
                .then(jsonContent => {
                    const snapshot = JSON.parse(jsonContent);
                    loadSnapshot(editor.store, snapshot);
                    setIsLoading(false);
                })
                .catch(error => {
                    console.error('[TldrawEditor] Failed to load:', error);
                    setIsLoading(false);
                });
        }

        // Track changes for future auto-save
        const unsubscribe = editor.store.listen(() => {
            setHasChanges(true);
        }, { scope: 'document' });

        // 🛡️ 关键视口校准：挂载后延迟 200ms 全局触发一次 resize 事件，
        // 强制 Tldraw 重新测量其 Canvas 的绝对屏幕坐标，消灭由于加载前后 DOM 细微位移导致的选择框/手柄坐标分离错位
        // 💡 加固：在挂载后 50ms, 150ms, 300ms 梯级强制执行同步 bounds 校准，平抑 DOM 入场重排偏差
        const timers = [50, 150, 300].map(delay => 
            setTimeout(() => {
                syncViewportBounds(true); // 💡 稳定期进行强制 bounds DPI 基准锁定
            }, delay)
        );

        const resizeTimer = setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 200);

        return () => {
            unsubscribe();
            timers.forEach(clearTimeout);
            clearTimeout(resizeTimer);
        };
    }, [jsonPath, onLoad, syncViewportBounds]);

    // Handle save
    const handleSave = useCallback(async () => {
        const editor = editorRef.current;
        if (!editor) return;

        try {
            const shapeIds = editor.getCurrentPageShapeIds();

            if (shapeIds.size === 0) {
                // Empty canvas - treat as cancel (auto-delete)
                onCancel();
                return;
            }

            // Clear selection before export to avoid capturing selection handles
            editor.selectNone();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Wait for all fonts to be loaded before export
            await document.fonts.ready;

            const shapes = Array.from(shapeIds).map(id => editor.getShape(id)!);

            // Export PNG via official Tldraw API
            const pixelRatio = 2;
            const { blob, width, height: imgHeight } = await editor.toImage(shapes, {
                format: 'png',
                background: true,
                padding: 32,
                pixelRatio,
            });

            // Get snapshot for JSON persistence
            const snapshot = getSnapshot(editor.store);
            const jsonString = JSON.stringify(snapshot);

            if (isFullscreen) {
                setIsFullscreen(false);
            }

            // Save via callback (divide by pixelRatio to get CSS pixels)
            await onSave({
                png: blob,
                json: jsonString,
                width: width / pixelRatio,
                height: imgHeight / pixelRatio,
            });

        } catch (error) {
            console.error('[TldrawEditor] Export failed:', error);
        }
    }, [onSave, onCancel, isFullscreen]);

    // Handle cancel with fullscreen exit
    const handleCancel = useCallback(() => {
        if (isFullscreen) {
            setIsFullscreen(false);
        }
        onCancel();
    }, [onCancel, isFullscreen]);

    // Toggle fullscreen (app-level, not system-level)
    const toggleFullscreen = useCallback(() => {
        setIsFullscreen(prev => !prev);
    }, []);

    // Prevent WebKit from triggering auto-activation on Radix RadioGroup/ToggleGroup during mouse hover focus
    useEffect(() => {
        // Track pointerdown state globally on document level to differentiate true physical click clicks vs WebKit hover focus
        const handlePointerDown = () => {
            (window as any).__slashIsPointerDown = true;
        };
        const handlePointerUp = () => {
            (window as any).__slashIsPointerDown = false;
        };

        const handleFocusCapture = (e: FocusEvent) => {
            const target = e.target as HTMLElement;
            if (target && target.closest && (target.closest('[class*="tlui"]') || target.closest('[class*="tl-"]'))) {
                const isClickFocus = (window as any).__slashIsPointerDown;
                if (!isClickFocus) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }
            }
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('mousedown', handlePointerDown, true);
        document.addEventListener('pointerup', handlePointerUp, true);
        document.addEventListener('mouseup', handlePointerUp, true);
        document.addEventListener('focus', handleFocusCapture, true);
        document.addEventListener('focusin', handleFocusCapture, true);

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('mousedown', handlePointerDown, true);
            document.removeEventListener('pointerup', handlePointerUp, true);
            document.removeEventListener('mouseup', handlePointerUp, true);
            document.removeEventListener('focus', handleFocusCapture, true);
            document.removeEventListener('focusin', handleFocusCapture, true);
        };
    }, []);



    // Handle click outside to auto-save and exit editing mode
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const container = containerRef.current;
            const target = e.target as HTMLElement;
            
            if (!target) return;
            if (!container) return;

            // Check if click is inside the container
            const isInsideContainer = container.contains(target as Node);

            // Portals (menus, tooltips) are rendered in document.body
            // but are logically part of Tldraw. We shouldn't auto-save if clicking them.
            const tluiClosest = target.closest?.('[class*="tlui"]');
            const tlClosest = target.closest?.('[class*="tl-"]');
            const radixPopperClosest = target.closest?.('[data-radix-popper-content-wrapper]');
            const radixDialogClosest = target.closest?.('[data-radix-dialog-content]');

            const isInsidePortal = !!(tluiClosest || tlClosest || radixPopperClosest || radixDialogClosest);

            const editorInstance = editorRef.current;
            if (editorInstance) {
                const isDragging = editorInstance.inputs.isDragging;
                const currentTool = editorInstance.getCurrentToolId();
                const isEditingText = editorInstance.isIn('select.editingShape');
                
                // 🛡️ 关键安全拦截：如果当前正在进行拖拽 (isDragging)、处于裁剪工具状态 (crop) 或者文字输入聚焦状态 (editingShape)，
                // 鼠标移出画布边界绝不能触发自动保存/销毁，防范意外保存引发选区重排及页面跳顶
                if (isDragging || currentTool === 'crop' || isEditingText) {
                    return;
                }
            }

            if (!isInsideContainer && !isInsidePortal) {
                // Don't trigger for fullscreen mode
                if (isFullscreen) return;

                // Auto-save and exit
                handleSave();
            }
        };

        // Use mousedown to catch clicks before they propagate
        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [handleSave, isFullscreen]);

    // Global interceptor for '#' anchor links to prevent page jumping to top in WKWebView
    useEffect(() => {
        const handleGlobalHashClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const anchor = target.closest('a');
            if (anchor) {
                const href = anchor.getAttribute('href');
                if (href === '#' || href === '') {
                    e.preventDefault();
                }
            }
        };
        // Use capture phase to intercept and stop default action before anyone else
        document.addEventListener('click', handleGlobalHashClick, true);
        return () => {
            document.removeEventListener('click', handleGlobalHashClick, true);
        };
    }, []);


    // Handle keyboard events - MUST be at document level to intercept before TipTap
    useEffect(() => {
        // Mark for identifying events we've re-dispatched
        const TLDRAW_DISPATCHED = '__tldraw_dispatched__';

        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip events that we've re-dispatched to avoid infinite loop
            if ((e as any)[TLDRAW_DISPATCHED]) {
                return;
            }

            const target = e.target as HTMLElement;

            // Check if we're in editing mode by looking for our container
            const drawingContainer = document.querySelector('.drawing-container.is-editing');
            if (!drawingContainer) {
                return; // Not in editing mode, let TipTap handle it
            }

            // isProseMirrorTarget check reserved for future use
            // Check if the event is related to drawing
            const isTldrawTarget =
                target.closest('.tl-container') ||
                target.closest('.tldraw') ||
                target.closest('[data-type="drawing"]') ||
                target.closest('.tldraw-editor-container') ||
                target.closest('.drawing-container.is-editing');

            // CRITICAL: If target is inside tl-container, we need to intercept clipboard operations
            // because Tldraw's async operations lose the "user gesture" context in Tauri WebView
            if (target.closest('.tl-container')) {
                const isClipboardKey = (e.metaKey || e.ctrlKey) && ['c', 'v', 'x'].includes(e.key.toLowerCase());

                if (isClipboardKey && editorRef.current) {
                    const editor = editorRef.current;
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();

                    if (e.key.toLowerCase() === 'c') {
                        // Copy: Store content in internal clipboard
                        const selectedIds = editor.getSelectedShapeIds();
                        if (selectedIds.length > 0) {
                            const content = editor.getContentFromCurrentPage(selectedIds);
                            internalClipboardRef.current = content;
                            console.log('[TldrawEditor] Copied to internal clipboard:', selectedIds.length, 'shapes');
                        }
                    } else if (e.key.toLowerCase() === 'x') {
                        // Cut: Copy then delete
                        const selectedIds = editor.getSelectedShapeIds();
                        if (selectedIds.length > 0) {
                            const content = editor.getContentFromCurrentPage(selectedIds);
                            internalClipboardRef.current = content;
                            editor.markHistoryStoppingPoint('cut');
                            editor.deleteShapes(selectedIds);
                            console.log('[TldrawEditor] Cut to internal clipboard:', selectedIds.length, 'shapes');
                        }
                    } else if (e.key.toLowerCase() === 'v') {
                        // Paste: Restore content from internal clipboard
                        const clipboardContent = internalClipboardRef.current;
                        console.log('[TldrawEditor] Trying to paste, clipboard content:', clipboardContent);

                        if (clipboardContent) {
                            try {
                                editor.markHistoryStoppingPoint('paste');
                                const content = clipboardContent as Parameters<typeof editor.putContentOntoCurrentPage>[0];
                                console.log('[TldrawEditor] Paste content shapes:', content?.shapes?.length, 'rootShapeIds:', content?.rootShapeIds);

                                // Get the center of the viewport as the paste point
                                // This ensures pasted content appears in the visible area with an offset
                                const viewportPageBounds = editor.getViewportPageBounds();
                                const pastePoint = {
                                    x: viewportPageBounds.center.x + 20,  // Small offset to show it's a new copy
                                    y: viewportPageBounds.center.y + 20
                                };

                                editor.putContentOntoCurrentPage(content, {
                                    select: true,
                                    point: pastePoint
                                });
                                console.log('[TldrawEditor] Paste completed successfully at', pastePoint);
                            } catch (err) {
                                console.error('[TldrawEditor] Paste failed:', err);
                            }
                        } else {
                            console.log('[TldrawEditor] No content in internal clipboard');
                        }
                    }
                    return;
                }

                // For non-clipboard keys, let Tldraw handle natively
                return;
            }
            if (!isTldrawTarget) {
                return;
            }

            // Escape to cancel (or exit fullscreen first)
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (isFullscreen) {
                    setIsFullscreen(false);
                } else {
                    handleCancel();
                }
                return;
            }

            // Cmd/Ctrl+Enter to save
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
                return;
            }
        };

        // Add at document level with capture phase to intercept BEFORE TipTap
        document.addEventListener('keydown', handleKeyDown, true);

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [handleCancel, handleSave, isFullscreen]);

    // Calculate container height (fullscreen needs to account for 32px TitleBar)
    const containerHeight = isFullscreen ? 'calc(100vh - 32px)' : `${height}px`;
    // Header is absolute-positioned (doesn't take space), canvas fills entire container
    const canvasHeight = '100%';

    return (
        <div
            className={`tldraw-editor-container ${isFullscreen ? 'is-fullscreen' : ''}`}
            ref={containerRef}
            style={{ height: containerHeight }}
            // FIX: Empty onClick handler helps React properly delegate events
            onClick={() => { }}
        >

            {/* Header / Toolbar overlay */}
            <div className="tldraw-header">
                <button
                    className="tldraw-icon-btn tldraw-icon-btn-cancel"
                    onClick={handleCancel}
                    title={`${t('drawing.cancel')} (${cancelShortcut})`}
                >
                    <IconX />
                </button>

                <div className="tldraw-toolbar-spacer" />

                <span className="tldraw-toolbar-hint">
                    {t('drawing.shortcut_hint', { save: saveShortcut, cancel: cancelShortcut })}
                </span>

                <div className="tldraw-toolbar-spacer" />

                <button
                    className="tldraw-icon-btn"
                    onClick={toggleFullscreen}
                    title={isFullscreen ? t('drawing.exit_fullscreen') : t('drawing.fullscreen')}
                >
                    {isFullscreen ? <IconMinimize /> : <IconMaximize />}
                </button>

                <button
                    className="tldraw-icon-btn tldraw-icon-btn-save"
                    onClick={handleSave}
                    title={`${t('drawing.save')} (${saveShortcut})`}
                >
                    <IconCheck />
                </button>
            </div>

            {/* Tldraw Canvas */}
            <div className="tldraw-canvas" style={{ height: canvasHeight }}>
                {isLoading && (
                    <div className="tldraw-loading-overlay">
                        <div className="drawing-loading-spinner" />
                        <span>{t('drawing.loading')}</span>
                    </div>
                )}
                <Tldraw
                    onMount={handleMount}
                    user={tldrawUser}
                    forceMobile={false}
                    assetUrls={customAssetUrls}
                    // shapeUtils={[CustomTextShapeUtil]} // Disabled - native SVG text positioning is inaccurate
                    components={{
                        // Hide menus that don't work properly in embedded mode
                        MainMenu: null,         // Hamburger menu ☰ - hidden in embedded mode
                        PageMenu: null,         // Page navigation "Page 1" (single page per drawing)
                        // Keep: QuickActions, ActionsMenu, Toolbar, StylePanel, etc.
                    }}
                />
            </div>
        </div>
    );
};

export default TldrawEditor;
