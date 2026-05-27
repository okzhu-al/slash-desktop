import { useTranslation } from 'react-i18next';

export interface TagBadgeProps {
    tag: string;
    isAI?: boolean;
    onAccept?: () => void;
    onReject?: () => void;
    onDelete?: () => void;
    onClick?: () => void;
}

/**
 * Tag badge component with differentiated styles for User vs AI tags.
 * 
 * User Tags: Solid dark background (confirmed by user)
 * AI Tags: Hollow/outline style with ✨ icon (AI suggestion)
 */
export const TagBadge = ({
    tag,
    isAI = false,
    onAccept,
    onReject,
    onDelete,
    onClick
}: TagBadgeProps) => {
    const { t } = useTranslation();

    const handleTagClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isAI && onAccept) {
            onAccept();
        } else if (onClick) {
            onClick();
        }
    };

    const handleRemove = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isAI && onReject) {
            onReject();
        } else if (onDelete) {
            onDelete();
        }
    };

    return (
        <span
            className={`tag-badge ${isAI ? 'tag-badge--ai' : 'tag-badge--user'}`}
            onClick={handleTagClick}
            title={isAI ? t('editor.tag_ai_hint') : undefined}
        >
            {isAI && <span className="tag-badge__icon">✨</span>}
            <span className="tag-badge__text">{tag}</span>
            <button
                className="tag-badge__remove"
                onClick={handleRemove}
                aria-label={isAI ? t('common.reject') : t('common.delete')}
            >
                ×
            </button>
        </span>
    );
};

export default TagBadge;
