/**
 * BacklinkBadge - Inline badge showing backlink count for a section
 * 
 * Displays a small badge after section headings showing how many
 * other notes link to that section. Hover shows a popup with details.
 */

import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface BacklinkInfo {
    source_path: string;
    source_title: string;
    target_anchor: string;
}

interface BacklinkBadgeProps {
    count: number;
    backlinks: BacklinkInfo[];
    onNavigate?: (path: string) => void;
    className?: string;
}

export const BacklinkBadge = ({ count, backlinks, onNavigate, className }: BacklinkBadgeProps) => {
    const { t } = useTranslation();
    const [showPopup, setShowPopup] = useState(false);
    const [popupPosition, setPopupPosition] = useState({ top: 0, left: 0 });
    const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearHideTimeout = useCallback(() => {
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
    }, []);

    const handleMouseEnter = useCallback((e: React.MouseEvent) => {
        clearHideTimeout();
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        setPopupPosition({
            top: rect.bottom + 4,
            left: rect.left,
        });
        setShowPopup(true);
    }, [clearHideTimeout]);

    const handleMouseLeave = useCallback(() => {
        // Delay hiding to allow mouse to move to popup
        hideTimeoutRef.current = setTimeout(() => {
            setShowPopup(false);
        }, 150);
    }, []);

    const handlePopupMouseEnter = useCallback(() => {
        clearHideTimeout();
    }, [clearHideTimeout]);

    const handlePopupMouseLeave = useCallback(() => {
        setShowPopup(false);
    }, []);

    const handleLinkClick = useCallback((path: string) => {
        setShowPopup(false);
        if (onNavigate) {
            onNavigate(path);
        }
    }, [onNavigate]);

    if (count === 0) return null;

    return (
        <>
            <span
                className={`backlink-badge ${className || ''}`}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                {count}
            </span>

            {showPopup && createPortal(
                <div
                    className="backlink-popup"
                    style={{
                        position: 'fixed',
                        top: popupPosition.top,
                        left: popupPosition.left,
                        zIndex: 9999,
                    }}
                    onMouseEnter={handlePopupMouseEnter}
                    onMouseLeave={handlePopupMouseLeave}
                >
                    <div className="backlink-popup-header">
                        {t('backlinks.linkedFrom', '被以下笔记引用')}
                    </div>
                    <ul className="backlink-popup-list">
                        {backlinks.map((link, index) => (
                            <li
                                key={`${link.source_path}-${index}`}
                                className="backlink-popup-item"
                                onClick={() => handleLinkClick(link.source_path)}
                            >
                                <span className="backlink-popup-icon">📝</span>
                                <span className="backlink-popup-title">{link.source_title}</span>
                            </li>
                        ))}
                    </ul>
                </div>,
                document.body
            )}
        </>
    );
};

// CSS styles to be added to index.css
export const BacklinkBadgeStyles = `
/* Backlink Badge */
.backlink-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    margin-left: 6px;
    font-size: 11px;
    font-weight: 500;
    color: #6366f1;
    background: rgba(99, 102, 241, 0.1);
    border-radius: 9px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
}

.backlink-badge:hover {
    background: rgba(99, 102, 241, 0.2);
    color: #4f46e5;
}

/* Backlink Popup */
.backlink-popup {
    min-width: 200px;
    max-width: 300px;
    padding: 8px 0;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
}

.dark .backlink-popup {
    background: #27272a;
    border-color: #3f3f46;
}

.backlink-popup-header {
    padding: 4px 12px 8px;
    font-size: 11px;
    font-weight: 500;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.dark .backlink-popup-header {
    color: #71717a;
}

.backlink-popup-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 200px;
    overflow-y: auto;
}

.backlink-popup-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    transition: background 0.1s ease;
}

.backlink-popup-item:hover {
    background: #f3f4f6;
}

.dark .backlink-popup-item:hover {
    background: #3f3f46;
}

.backlink-popup-icon {
    font-size: 14px;
}

.backlink-popup-title {
    flex: 1;
    font-size: 13px;
    color: #374151;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dark .backlink-popup-title {
    color: #e5e7eb;
}
`;
