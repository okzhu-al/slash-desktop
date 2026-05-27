import React, { useRef, useState, useEffect } from 'react';
import { cn } from '@/shared/utils/cn';

interface SplitPaneProps {
    topContent: React.ReactNode;
    bottomContent: React.ReactNode;

    topCollapsed: boolean;
    bottomCollapsed: boolean;

    showBottomPane: boolean;

    initialRatio?: number;
    onRatioChange?: (ratio: number) => void;
    className?: string;
}

export function SplitPane({
    topContent,
    bottomContent,
    topCollapsed,
    bottomCollapsed,
    showBottomPane,
    initialRatio = 0.55,
    onRatioChange,
    className
}: SplitPaneProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [splitRatio, setSplitRatio] = useState(initialRatio);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        if (!isDragging) return;
        const onMouseMove = (e: MouseEvent) => {
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const ratio = Math.max(0.2, Math.min(0.8, y / rect.height));
            setSplitRatio(ratio);
        };
        const onMouseUp = () => {
            setIsDragging(false);
            onRatioChange?.(splitRatio);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    }, [isDragging, splitRatio, onRatioChange]);

    return (
        <div ref={containerRef} className={cn("flex-1 flex flex-col min-h-0 overflow-hidden", className)}>
            {/* Top Pane */}
            <div
                className="flex flex-col min-h-0 overflow-hidden relative"
                style={
                    !topCollapsed && !bottomCollapsed && showBottomPane
                        ? { height: `${splitRatio * 100}%`, flexShrink: 0 }
                        : !topCollapsed
                            ? { flexGrow: 1, flexShrink: 0, flexBasis: '0%' }
                            : undefined
                }
            >
                {topContent}
            </div>

            {/* Bottom Pane */}
            {showBottomPane && (
                <div
                    className="flex flex-col min-h-0 relative overflow-hidden bg-[#E6A23C]/10 dark:bg-[#002FA7]/15"
                    style={
                        !topCollapsed && !bottomCollapsed
                            ? { height: `${(1 - splitRatio) * 100}%`, flexShrink: 0 }
                            : !bottomCollapsed
                                ? { flexGrow: 1, flexShrink: 0, flexBasis: '0%' }
                                : undefined
                    }
                >
                    {/* Resizer Handle */}
                    {!topCollapsed && !bottomCollapsed && (
                        <div
                            className={cn(
                                'absolute top-0 left-0 w-full h-1 cursor-row-resize z-20 bg-transparent hover:bg-indigo-500/50 active:bg-indigo-500 transition-colors',
                                isDragging && 'bg-indigo-500'
                            )}
                            onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
                        />
                    )}
                    {isDragging && (
                        <div className="fixed inset-0 z-99999 cursor-row-resize" />
                    )}
                    {bottomContent}
                </div>
            )}
        </div>
    );
}
