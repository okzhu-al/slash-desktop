/**
 * RightSidebar - Reusable container component for right-side panels
 * 
 * Provides:
 * - Resizable width with drag handle
 * - Consistent styling (border, background, padding)
 * - Open/close state management
 * 
 * Usage:
 * <RightSidebar isOpen={panelOpen} width={panelWidth} onWidthChange={setWidth}>
 *     <YourPanelContent />
 * </RightSidebar>
 */

import React from 'react';

interface RightSidebarProps {
    children: React.ReactNode;
    isOpen: boolean;
    width?: number;
    onWidthChange?: (width: number) => void;
    onResizeStart?: () => void;
    onResizeEnd?: () => void;
}

export const RightSidebar = ({
    children,
    isOpen,
    width = 320,
    onWidthChange,
    onResizeStart,
    onResizeEnd
}: RightSidebarProps) => {

    if (!isOpen) {
        return null;
    }

    // Handle resize drag
    const handleResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        onResizeStart?.();
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const startX = e.clientX;
        const startWidth = width;

        const handleMouseMove = (e: MouseEvent) => {
            // Dragging left edge means we're going left = increasing width
            const delta = startX - e.clientX;
            const newWidth = Math.max(200, Math.min(600, startWidth + delta));
            onWidthChange?.(newWidth);
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
            onResizeEnd?.();
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    return (
        <div
            className="shrink-0 h-full border-l border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex flex-col pt-8 relative group min-h-0 overflow-hidden"
            style={{ width }}
        >
            {/* Resize Handle (left edge) — 1px line + w-1 drag zone */}
            <div
                className="absolute left-0 top-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/50 active:bg-indigo-500 transition-colors z-50"
                onMouseDown={handleResizeStart}
            />

            {/* Panel Content */}
            {children}
        </div>
    );
};
