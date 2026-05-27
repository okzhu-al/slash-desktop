import React from 'react';
import { createPortal } from 'react-dom';
import { DatePicker } from '../DatePicker';
import { usePopupPosition } from './usePopupPosition';

export interface DatePickerPopupProps {
    anchorEl?: HTMLElement | null;
    anchorRect?: DOMRect | null;
    value: string | null;
    onChange: (date: string | null) => void;
    onClose: () => void;
}

export const DatePickerPopup: React.FC<DatePickerPopupProps> = ({ anchorEl, anchorRect, value, onChange, onClose }) => {
    const { position, popupPositionRef, isReady } = usePopupPosition(anchorEl, anchorRect);

    if (!anchorEl && !anchorRect) return null;

    return createPortal(
        <div
            ref={popupPositionRef}
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
            <DatePicker
                value={value}
                onChange={onChange}
                onClose={onClose}
            />
        </div>,
        document.body
    );
};
