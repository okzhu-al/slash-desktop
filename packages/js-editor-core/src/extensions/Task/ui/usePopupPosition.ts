import { useCallback, useState, useLayoutEffect } from 'react';

export const usePopupPosition = (anchorEl?: HTMLElement | null, providedRect?: DOMRect | null) => {
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(providedRect || null);
    const [isReady, setIsReady] = useState(!!providedRect);

    useLayoutEffect(() => {
        if (providedRect) {
            setAnchorRect(providedRect);
            setPosition({
                x: providedRect.left,
                y: providedRect.bottom + 4,
            });
            setIsReady(true);
            return;
        }

        if (!anchorEl) return;
        
        let attempts = 0;
        const updatePos = () => {
             attempts++;
             const rect = anchorEl.getBoundingClientRect();
             // Ensure it's not a detached node and has a valid coordinate
             if ((rect.x === 0 && rect.y === 0) || !document.body.contains(anchorEl)) {
                 if (attempts < 50) {
                     frame2 = requestAnimationFrame(updatePos);
                 }
                 return;
             }
             setAnchorRect(rect);
             setPosition({
                 x: rect.left,
                 y: rect.bottom + 4,
             });
             setIsReady(true);
        };
        
        let frame1 = requestAnimationFrame(() => {
            frame2 = requestAnimationFrame(updatePos);
        });
        let frame2: number;

        return () => {
            cancelAnimationFrame(frame1);
            if (frame2) cancelAnimationFrame(frame2);
        };
    }, [anchorEl, providedRect]);

    const popupPositionRef = useCallback((node: HTMLDivElement | null) => {
        if (!node || !anchorRect) return;
        const rect = node.getBoundingClientRect();
        
        let newX = anchorRect.left;
        let newY = anchorRect.bottom + 4;

        // X collision: If it goes off the right screen edge
        if (rect.right > window.innerWidth - 10) {
            newX = window.innerWidth - rect.width - 10;
            // Additional check: if newX < 10, screen is too tight, just stick to left edge
            if (newX < 10) newX = 10;
        }
        
        // Y collision: If it goes off the bottom screen edge
        if (rect.bottom > window.innerHeight - 10) {
            // Flip it ABOVE the line!
            newY = Math.max(10, anchorRect.top - rect.height - 4);
        }

        // Only override if we changed the math (to prevent continuous thrashing)
        if (newX !== position.x || newY !== position.y) {
            node.style.left = `${newX}px`;
            node.style.top = `${newY}px`;
        }
    }, [anchorRect, position.x, position.y]);

    return { position, popupPositionRef, isReady };
};
