import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopupPosition } from './usePopupPosition';

export interface UserPopupProps {
    anchorEl?: HTMLElement | null;
    anchorRect?: DOMRect | null;
    onSelect: (username: string) => void;
    onClose: () => void;
}

export const UserPopup: React.FC<UserPopupProps> = ({ anchorEl, anchorRect, onSelect, onClose }) => {
    const { position, popupPositionRef, isReady } = usePopupPosition(anchorEl, anchorRect);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    
    // Read team members from host app (injected via window global)
    const teamMembers: any[] = useMemo(() => {
        return (window as any).__slashTeamMembers || [];
    }, []);

    const filteredMembers = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return teamMembers;
        return teamMembers.filter((member: any) => {
            const username = String(member.username || '').toLowerCase();
            const displayName = String(member.display_name || '').toLowerCase();
            return username.includes(keyword) || displayName.includes(keyword);
        });
    }, [query, teamMembers]);

    const handleMemberSelect = (member: any) => {
        onSelect(member.username);
    };

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const handleConfirmSelection = () => {
        if (filteredMembers.length === 0) return;

        const normalizedQuery = query.trim().toLowerCase();
        const exactMatch = normalizedQuery
            ? filteredMembers.find((member: any) => {
                const username = String(member.username || '').toLowerCase();
                const displayName = String(member.display_name || '').toLowerCase();
                return username === normalizedQuery || displayName === normalizedQuery;
            })
            : null;

        const member = exactMatch ?? filteredMembers[Math.min(activeIndex, filteredMembers.length - 1)];
        if (member) handleMemberSelect(member);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((prev) => Math.min(prev + 1, Math.max(filteredMembers.length - 1, 0)));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((prev) => Math.max(prev - 1, 0));
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            handleConfirmSelection();
            return;
        }
        if (event.key === 'Tab') {
            if (filteredMembers.length > 0) {
                event.preventDefault();
                handleConfirmSelection();
            }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
        }
    };

    if (!anchorEl && !anchorRect) return null;

    return createPortal(
        <div
            ref={popupPositionRef}
            className="task-user-input-popup"
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
            <input
                ref={inputRef}
                className="task-user-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search member or press Enter"
                onMouseDown={(event) => event.stopPropagation()}
            />
            {filteredMembers.length > 0 ? (
                <div className="task-member-list">
                    {filteredMembers.map((member: any, index: number) => (
                        <button
                            key={member.username}
                            className={`task-member-option${index === activeIndex ? ' is-active' : ''}`}
                            onClick={() => handleMemberSelect(member)}
                            onMouseEnter={() => setActiveIndex(index)}
                        >
                            <span className="task-member-avatar">
                                {(member.display_name || member.username).charAt(0).toUpperCase()}
                            </span>
                            <span className="task-member-info">
                                <span className="task-member-name">
                                    {member.display_name || member.username}
                                </span>
                                <span className="task-member-username">
                                    @{member.username}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            ) : (
                <div className="task-member-empty">No matching members</div>
            )}
        </div>,
        document.body
    );
};
