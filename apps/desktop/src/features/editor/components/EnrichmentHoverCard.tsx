import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';

interface Props {
    content: string | null;
    children: React.ReactNode;
}

export const EnrichmentHoverCard = ({ content, children }: Props) => {
    const [isVisible, setIsVisible] = useState(false);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const hoverTimeout = useRef<any>(null);
    const hideTimeout = useRef<any>(null);

    // To prevent flicker, we add a delay before showing and hiding
    const handleMouseEnter = (e: React.MouseEvent) => {
        if (!content) return;
        clearTimeout(hideTimeout.current);
        // Only update position if it's not currently visible, 
        // to avoid jumping while user is moving towards it
        if (!isVisible) {
            setMousePos({ x: e.clientX, y: e.clientY });
        }
        hoverTimeout.current = setTimeout(() => setIsVisible(true), 300);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!content) return;
        if (!isVisible) {
            // Continuously update position while waiting for delay
            setMousePos({ x: e.clientX, y: e.clientY });
        }
    };

    const handleMouseLeave = () => {
        clearTimeout(hoverTimeout.current);
        hideTimeout.current = setTimeout(() => setIsVisible(false), 250);
    };

    // Calculate fixed position taking viewport boundaries into account
    // Fixed size: 320px width, max 250px height
    const CARD_WIDTH = 320;
    const CARD_HEIGHT = 250;
    const OFFSET = 15;

    let left = mousePos.x + OFFSET;
    let top = mousePos.y + OFFSET;

    // Boundary checks
    if (typeof window !== 'undefined') {
        if (left + CARD_WIDTH > window.innerWidth - 20) {
            left = Math.max(10, mousePos.x - CARD_WIDTH - OFFSET);
        }
        if (top + CARD_HEIGHT > window.innerHeight - 20) {
            top = Math.max(10, mousePos.y - CARD_HEIGHT - OFFSET);
        }
    }

    const [copied, setCopied] = useState(false);

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (content) {
            navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            className="enrichment-hover-wrapper group/wrapper flex flex-col"
            style={{ width: '100%', height: 'fit-content', maxWidth: '100%' }}
        >
            {children}
            {isVisible && content && typeof document !== 'undefined' && createPortal(
                <div
                    onMouseEnter={() => clearTimeout(hideTimeout.current)}
                    onMouseLeave={handleMouseLeave}
                    className="fixed z-9999 w-72 max-h-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg pointer-events-auto flex flex-col group/card"
                    style={{
                        left: `${left}px`,
                        top: `${top}px`,
                        animation: 'fadeIn 0.15s ease-out forwards',
                    }}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                    }}
                >
                    {/* Header — 固定在顶部，不参与滚动 */}
                    <div className="flex justify-between items-center px-3 pt-2.5 pb-2 border-b border-zinc-100 dark:border-zinc-700/50 shrink-0 rounded-t-lg">
                        <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                            AI Description
                        </div>
                        <button
                            onClick={handleCopy}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors opacity-0 group-hover/card:opacity-100 focus:opacity-100"
                            title="Copy text"
                        >
                            {copied ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                            )}
                        </button>
                    </div>
                    {/* Content — 可滚动区域 */}
                    <div className="overflow-y-auto px-3 py-2 pr-4">
                        <div className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap wrap-break-word leading-relaxed select-text">
                            {content}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};
