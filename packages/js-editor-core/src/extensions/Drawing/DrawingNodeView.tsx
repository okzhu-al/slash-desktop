/**
 * DrawingNodeView - Dual-mode React component for Drawing extension
 * 
 * View Mode: Displays static PNG image (high performance)
 * Edit Mode: Loads Tldraw editor (lazy loaded)
 */

import React, { useState, useCallback, useEffect, Suspense, useRef } from 'react';
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import { DrawingPreview } from './DrawingPreview';
import './DrawingStyles.css';

// Lazy load Tldraw editor with built-in auto-retry on network/Vite cold compile delay
const TldrawEditor = React.lazy<React.ComponentType<any>>(() => {
    const importFunc = () => import('./TldrawEditor');
    return new Promise<{ default: React.ComponentType<any> }>((resolve, reject) => {
        const tryImport = (retriesLeft = 2, delay = 800) => {
            importFunc()
                .then(resolve)
                .catch((error) => {
                    if (retriesLeft === 0) {
                        console.error('[Drawing] Failed to lazy load TldrawEditor after retries:', error);
                        reject(error);
                        return;
                    }
                    console.warn(`[Drawing] TldrawEditor import failed, retrying in ${delay}ms... (${retriesLeft} retries left)`);
                    setTimeout(() => {
                        tryImport(retriesLeft - 1, delay);
                    }, delay);
                });
        };
        tryImport();
    });
});

export const DrawingNodeView: React.FC<NodeViewProps> = ({
    node,
    updateAttributes,
    deleteNode,
    editor,
    selected,
}) => {
    const { src, json, height, isEditing, alt } = node.attrs;
    const [localEditing, setLocalEditing] = useState(isEditing || !src);
    const [_isResizing, setIsResizing] = useState(false); // Tracked for cursor state
    const [cacheBuster, setCacheBuster] = useState(0); // Force image reload after overwrite save
    const containerRef = useRef<HTMLDivElement>(null);
    const startHeightRef = useRef(0);
    const startYRef = useRef(0);
    const scrollLockRef = useRef<{
        locked: boolean;
        positions: Map<Element | Window, { top: number; left: number }>;
    }>({
        locked: false,
        positions: new Map(),
    });

    const lockScrolling = useCallback(() => {
        if (!containerRef.current) return;
        const positions = new Map<Element | Window, { top: number; left: number }>();
        
        let parent = containerRef.current.parentElement;
        while (parent) {
            if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
                positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
            }
            parent = parent.parentElement;
        }
        positions.set(window, { top: window.scrollY || document.documentElement.scrollTop, left: window.scrollX || document.documentElement.scrollLeft });
        positions.set(document.documentElement, { top: document.documentElement.scrollTop, left: document.documentElement.scrollLeft });
        positions.set(document.body, { top: document.body.scrollTop, left: document.body.scrollLeft });

        scrollLockRef.current.positions = positions;
        scrollLockRef.current.locked = true;
    }, []);

    const unlockScrolling = useCallback(() => {
        // 延迟 250ms 释放，平稳度过释放瞬间的焦点元素移出与重置期
        setTimeout(() => {
            scrollLockRef.current.locked = false;
            scrollLockRef.current.positions.clear();
        }, 250);
    }, []);

    const checkIsInteractive = useCallback((el: Node | null): boolean => {
        if (!el) return false;
        if (el.nodeType !== 1) return false;
        
        const element = el as HTMLElement;
        const tagName = element.tagName?.toLowerCase();
        const classStr = element.getAttribute?.('class') || '';
        const role = element.getAttribute?.('role') || '';

        // 明确排除手柄类高危节点
        if (classStr.includes('tl-resize-handle') || classStr.includes('tl-rotate-handle')) {
            return false;
        }

        if (
            tagName === 'button' ||
            tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            tagName === 'svg' ||
            tagName === 'path' ||
            tagName === 'g' ||
            classStr.includes('tlui') ||
            classStr.includes('menu') ||
            classStr.includes('popover') ||
            role.includes('button') ||
            role.includes('menu')
        ) {
            return true;
        }

        if (element.parentNode) {
            return checkIsInteractive(element.parentNode);
        }

        return false;
    }, []);

    // Sync isEditing attr with local state
    useEffect(() => {
        if (isEditing && !localEditing) {
            setLocalEditing(true);
        }
    }, [isEditing, localEditing]);

    // Blur ProseMirror when drawing enters edit mode,
    // so the text cursor doesn't show outside the canvas
    useEffect(() => {
        if (localEditing && editor) {
            editor.commands.blur();
        }
    }, [localEditing, editor]);

    // Toggle ProseMirror contenteditable, close right sidebar, and disable auto scroll during editing
    useEffect(() => {
        if (!editor || !editor.view || !editor.view.dom) return;
        const proseMirrorDom = editor.view.dom;
        
        if (localEditing) {
            proseMirrorDom.setAttribute('contenteditable', 'false');
            
            // 🛡️ 终极滚动拦截守卫：在画板编辑期间，完全禁用 ProseMirror 自动将选区滚入视口的行为，
            // 物理根治由于节点变动导致 ProseMirror 自动重置焦点和滚动而引发的抖动
            // 同时在 ProseMirror 层级直接拦截所有来自画板内部的鼠标和指针事件，但不阻止它们向原生 DOM 冒泡，
            // 彻底杜绝 ProseMirror 强夺焦点更新选区的副作用，保障 Radix UI 状态机完整
            editor.view.setProps({
                handleScrollToSelection: () => true,
                handleDOMEvents: {
                    mousedown: (_, event) => {
                        const target = event.target as HTMLElement;
                        const isTldraw = !!(target && (target.closest && (target.closest('.tl-container') || target.closest('[class*="tlui"]'))));
                        if (isTldraw) {
                            const isInteractive = checkIsInteractive(target);
                            if (!isInteractive) return true; // 仅拦截 Canvas 背景/手柄等高危无交互节点
                        }
                        return false;
                    },
                    pointerdown: (_, event) => {
                        const target = event.target as HTMLElement;
                        const isTldraw = !!(target && (target.closest && (target.closest('.tl-container') || target.closest('[class*="tlui"]'))));
                        if (isTldraw) {
                            const isInteractive = checkIsInteractive(target);
                            if (!isInteractive) return true; // 仅拦截 Canvas 背景/手柄等高危无交互节点
                        }
                        return false;
                    },

                    click: (_, event) => {
                        const target = event.target as HTMLElement;
                        const isTldraw = !!(target && (target.closest && (target.closest('.tl-container') || target.closest('[class*="tlui"]'))));
                        if (isTldraw) {
                            return true; // 彻底拦截 click 事件冒泡到 ProseMirror 触发夺焦
                        }
                        return false;
                    },
                    dblclick: (_, event) => {
                        const target = event.target as HTMLElement;
                        const isTldraw = !!(target && (target.closest && (target.closest('.tl-container') || target.closest('[class*="tlui"]'))));
                        if (isTldraw) {
                            return true; // 彻底拦截 dblclick 事件冒泡到 ProseMirror
                        }
                        return false;
                    },
                    contextmenu: (_, event) => {
                        const target = event.target as HTMLElement;
                        const isTldraw = !!(target && (target.closest && (target.closest('.tl-container') || target.closest('[class*="tlui"]'))));
                        if (isTldraw) {
                            return true; // 彻底拦截 contextmenu 事件冒泡到 ProseMirror
                        }
                        return false;
                    }
                }
            });
            
            // Dispatch custom event to close the right sidebar
            const event = new CustomEvent('slash:close-right-sidebar');
            window.dispatchEvent(event);
            
            // Dispatch custom event to reset the editor zoom level to 1.0 during active drawing session
            window.dispatchEvent(new CustomEvent('slash:reset-editor-zoom'));
        } else {
            proseMirrorDom.setAttribute('contenteditable', 'true');
            editor.view.setProps({
                handleScrollToSelection: undefined as any,
                handleDOMEvents: undefined as any
            });
            
            // Dispatch custom event to restore the editor zoom level back to user's preference
            window.dispatchEvent(new CustomEvent('slash:restore-editor-zoom'));
        }

        return () => {
            proseMirrorDom.setAttribute('contenteditable', 'true');
            if (editor && editor.view) {
                editor.view.setProps({
                    handleScrollToSelection: undefined as any,
                    handleDOMEvents: undefined as any
                });
            }
            if (localEditing) {
                window.dispatchEvent(new CustomEvent('slash:restore-editor-zoom'));
            }
        };
    }, [localEditing, editor]);

    // Globally handle mouseup/pointerup and scroll events during active drawing edit session.
    useEffect(() => {
        if (!localEditing) return;

        const handleFocusChange = (_: FocusEvent) => {
            // Focus debug removed
        };

        const handleGlobalCapture = (e: Event) => {
            const target = e.target as HTMLElement;
            if (!target) return;

            const isRemoved = !document.contains(target);
            const tlContainerClosest = target.closest?.('.tl-container');
            const tluiClosest = target.closest?.('[class*="tlui"]');
            
            const isTldrawEvent = isRemoved || !!tlContainerClosest || !!tluiClosest;

            if (isTldrawEvent) {
                // 1. 识别是否为交互式控件（如按钮、下拉选项、弹出菜单，或任何 Tldraw UI 元素）
                const isInteractive = checkIsInteractive(target);

                // 2. WebKit 异步焦点守卫：仅对非按钮类的高危被销毁节点（手柄/Canvas背景）进行焦点转移，
                // 如果是正常的交互式按钮点击，绝对不能移走焦点，以允许下拉 Popover 常驻
                if (!isInteractive) {
                    requestAnimationFrame(() => {
                        if (containerRef.current) {
                            containerRef.current.focus({ preventScroll: true });
                        }
                    });
                }

                // 3. 无论何种事件，点击释放后都必须启动延迟解锁，恢复滚动
                unlockScrolling();
            }
        };

        // 强行纠正滚动偏差，锁死 scrollTop
        const handleScroll = (e: Event) => {
            if (scrollLockRef.current.locked) {
                const target = e.target;
                if (!target) return;
                const pos = scrollLockRef.current.positions.get(target as any) || scrollLockRef.current.positions.get(window);
                if (pos) {
                    if (target === document || target === window) {
                        window.scrollTo({ top: pos.top, left: pos.left });
                    } else {
                        const element = target as HTMLElement;
                        if (typeof element.scrollTop === 'number') {
                            element.scrollTop = pos.top;
                            element.scrollLeft = pos.left;
                        }
                    }
                }
            }
        };

        document.addEventListener('mouseup', handleGlobalCapture, true);
        document.addEventListener('pointerup', handleGlobalCapture, true);
        document.addEventListener('focus', handleFocusChange, true);
        
        // 全局捕获阶段监听 scroll 事件以执行强行拉回
        window.addEventListener('scroll', handleScroll, true);

        return () => {
            document.removeEventListener('mouseup', handleGlobalCapture, true);
            document.removeEventListener('pointerup', handleGlobalCapture, true);
            document.removeEventListener('focus', handleFocusChange, true);
            window.removeEventListener('scroll', handleScroll, true);
        };
    }, [localEditing, unlockScrolling, checkIsInteractive]);

    // Enter edit mode on double click
    const handleDoubleClick = useCallback(() => {
        if (!editor.isEditable) return;
        setLocalEditing(true);
        updateAttributes({ isEditing: true });
        
        // FIX: Rip away the native DOM selection that Prosemirror created over the NodeView.
        // Otherwise, the transparent Selection Range will envelop the newly mounted Tldraw UI,
        // causing all text node children inside the Canvas to become highlighted in blue.
        window.getSelection()?.removeAllRanges();
    }, [editor.isEditable, updateAttributes]);

    // Prevent mouse events from bubbling up to ProseMirror during active drawing edit session,
    // which otherwise triggers NodeSelection and steals text editor caret focus.
    const handleEditingMouseDown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // 物理阻断事件冒泡到 ProseMirror，防止抢夺焦点
        const target = e.target as HTMLElement;
        if (checkIsInteractive(target)) {
            return;
        }
        lockScrolling();
    }, [lockScrolling, checkIsInteractive]);

    const handleEditingPointerDown = useCallback((e: React.PointerEvent) => {
        e.stopPropagation(); // 物理阻断事件冒泡到 ProseMirror，防止抢夺焦点
        const target = e.target as HTMLElement;
        if (checkIsInteractive(target)) {
            return;
        }
        lockScrolling();
    }, [lockScrolling, checkIsInteractive]);



    const handleEditingClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // 物理阻断事件冒泡到 ProseMirror，防止 click 抢夺焦点
    }, []);

    const handleEditingDoubleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // 物理阻断事件冒泡到 ProseMirror
    }, []);

    const handleEditingContextMenu = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // 物理阻断事件冒泡到 ProseMirror
    }, []);



    // Handle save from Tldraw editor
    const handleSave = useCallback(
        async (data: { png: Blob; json: string; width: number; height: number }) => {
            const onSave = editor.extensionManager.extensions.find(
                ext => ext.name === 'drawing'
            )?.options.onSave;

            if (onSave) {
                try {
                    // Pass existing paths to enable overwrite instead of creating new files
                    const { pngPath, jsonPath } = await onSave(data, src || undefined, json || undefined);
                    updateAttributes({
                        src: pngPath,
                        json: jsonPath,
                        isEditing: false,
                    });
                    setLocalEditing(false);
                    setCacheBuster(Date.now()); // Bust browser cache for overwritten PNG
                } catch (error) {
                    console.error('[Drawing] Save failed:', error);
                }
            }
        },
        [editor.extensionManager.extensions, updateAttributes, src, json]
    );

    // Handle cancel (exit edit mode without saving)
    const handleCancel = useCallback(() => {
        // If no src (new drawing never saved), delete the node
        if (!src) {
            deleteNode();
        } else {
            updateAttributes({ isEditing: false });
            setLocalEditing(false);
        }
    }, [src, deleteNode, updateAttributes]);

    // Handle blur (auto-save on focus loss)
    const handleBlur = useCallback(() => {
        // Will be connected to TldrawEditor's onBlur
        // For now, just delegate to handleCancel for empty drawings
        if (!src) {
            // Don't delete on blur, only on explicit cancel
            return;
        }
    }, [src]);

    // 🛡️ 模式切换/选中校准：当进入编辑态或选中状态改变时，延迟 150ms 触发一次全局 resize 事件
    // 强制 Tldraw 重新刷新视口和校准选择框位置，消灭因 DOM 渲染位置微调导致的边框分离与偏移
    useEffect(() => {
        if (localEditing || selected) {
            const timer = setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 150);
            return () => clearTimeout(timer);
        }
    }, [localEditing, selected]);

    // Height resize handlers
    const handleResizeStart = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsResizing(true);
            startHeightRef.current = height;
            startYRef.current = e.clientY;

            const handleMouseMove = (moveEvent: MouseEvent) => {
                const delta = moveEvent.clientY - startYRef.current;
                const newHeight = Math.max(200, Math.min(1200, startHeightRef.current + delta));
                updateAttributes({ height: newHeight });
            };

            const handleMouseUp = () => {
                setIsResizing(false);
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [height, updateAttributes]
    );



    return (
        <NodeViewWrapper
            as="div"
            className={`not-prose drawing-container ${selected ? 'is-selected' : ''} ${localEditing ? 'is-editing' : ''}`}
            ref={containerRef}
            contentEditable={false}
            tabIndex={-1}
            style={{ outline: 'none' }}
        >
            <div
                className="drawing-content"
                style={{ height: `${height}px` }}
                onDoubleClick={localEditing ? handleEditingDoubleClick : handleDoubleClick}
                onMouseDown={localEditing ? handleEditingMouseDown : undefined}
                onPointerDown={localEditing ? handleEditingPointerDown : undefined}
                onClick={localEditing ? handleEditingClick : undefined}
                onContextMenu={localEditing ? handleEditingContextMenu : undefined}
            >
                {localEditing ? (
                    <Suspense
                        fallback={
                            <div className="drawing-loading">
                                <div className="drawing-loading-spinner" />
                                <span>加载画板...</span>
                            </div>
                        }
                    >
                        <TldrawEditor
                            jsonPath={json}
                            height={height}
                            onSave={handleSave}
                            onCancel={handleCancel}
                            onBlur={handleBlur}
                            onLoad={
                                editor.extensionManager.extensions.find(
                                    ext => ext.name === 'drawing'
                                )?.options.onLoad
                            }
                        />
                    </Suspense>
                ) : (
                    <DrawingPreview
                        src={src}
                        alt={alt}
                        height={height}
                        selected={selected}
                        cacheBuster={cacheBuster}
                    />
                )}
            </div>

            {/* Resize handle */}
            {!localEditing && (
                <div
                    className="drawing-resize-handle"
                    onMouseDown={handleResizeStart}
                    title="拖拽调整高度"
                >
                    <div className="drawing-resize-grip" />
                </div>
            )}
        </NodeViewWrapper>
    );
};
