import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePopupPosition } from './usePopupPosition';

export interface PriorityPopupProps {
    anchorEl?: HTMLElement | null;
    anchorRect?: DOMRect | null;
    onSelect: (priority: string | null) => void;
    onClose: () => void;
}

export const PriorityPopup: React.FC<PriorityPopupProps> = ({ anchorEl, anchorRect, onSelect, onClose }) => {
    const { t } = useTranslation();
    const { position, popupPositionRef, isReady } = usePopupPosition(anchorEl, anchorRect);

    if (!anchorEl && !anchorRect) return null;

    return createPortal(
        <div
            ref={popupPositionRef}
            className="task-priority-popup"
            style={{
                position: 'fixed',
                left: position.x,
                top: position.y,
                zIndex: 1000,
                opacity: isReady ? 1 : 0,
                pointerEvents: isReady ? 'auto' : 'none'
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="task-metadata-backdrop" onClick={onClose} />
            <div className="priority-menu-content">
                <button
                    className="priority-option high"
                    onClick={() => onSelect('high')}
                >
                    🔴 {t('task.priorityHigh', 'High')}
                </button>
                <button
                    className="priority-option medium"
                    onClick={() => onSelect('medium')}
                >
                    🟡 {t('task.priorityMedium', 'Medium')}
                </button>
                <button
                    className="priority-option low"
                    onClick={() => onSelect('low')}
                >
                    🟢 {t('task.priorityLow', 'Low')}
                </button>
            </div>
        </div>,
        document.body
    );
};
