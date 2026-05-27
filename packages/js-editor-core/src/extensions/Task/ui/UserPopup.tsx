import React, { useMemo } from 'react';
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
    
    // Read team members from host app (injected via window global)
    const teamMembers: any[] = useMemo(() => {
        return (window as any).__slashTeamMembers || [];
    }, []);

    const handleMemberSelect = (member: any) => {
        onSelect(member.username);
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
            {teamMembers.length > 0 && (
                <div className="task-member-list">
                    {teamMembers.map((member: any) => (
                        <button
                            key={member.username}
                            className="task-member-option"
                            onClick={() => handleMemberSelect(member)}
                        >
                            <span className="task-member-avatar">
                                {(member.display_name || member.username).charAt(0).toUpperCase()}
                            </span>
                            <span className="task-member-info">
                                <span className="task-member-name">
                                    {member.display_name || member.username}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>,
        document.body
    );
};
