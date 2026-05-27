/**
 * DrawingPreview - View Mode static image display
 * 
 * High-performance display of saved drawing as PNG.
 * Shows placeholder for new/unsaved drawings.
 */

import React, { useEffect } from 'react';
import { useEditorServices } from '../../EditorDI';
import { useTranslation } from 'react-i18next';
// NOTE: We need to inject or invoke getAssetUrl directly if mediaService is tied to the main app apps/desktop.
// Since DrawingPreview is inside packages/js-editor-core, direct import to apps/desktop is an anti-pattern.
// Let's use DrawingService's own getAssetUrl which directly invokes Rust!
import { drawingService } from './DrawingService';

interface DrawingPreviewProps {
    src: string | null;
    alt: string;
    height: number;
    selected: boolean;
    cacheBuster?: number;
}

export const DrawingPreview: React.FC<DrawingPreviewProps> = ({
    src,
    alt,
    height,
    selected,
    cacheBuster,
}) => {
    const { t } = useTranslation();
    const { fileSystemStore } = useEditorServices();
    const root = fileSystemStore.root;
    const vaultPath = root?.path || '';
    const [imageSrc, setImageSrc] = React.useState<string | null>(null);

    // Convert relative path to absolute URL for Tauri
    useEffect(() => {
        let isMounted = true;

        async function constructUrl() {
            if (!src || !vaultPath) {
                if (isMounted) setImageSrc(null);
                return;
            }

            try {
                // Use DrawingService's robust resolution which handles decoding and relative/absolute logic
                // Ensure drawingService works correctly with the current vaultPath
                const url = await drawingService.getAssetUrl(src, vaultPath);

                if (isMounted) {
                    // Append cache buster to force reload after overwrite save
                    setImageSrc(cacheBuster ? `${url}?t=${cacheBuster}` : url);
                }
            } catch (err) {
                console.error('[DrawingPreview] Failed to resolve asset URL:', err);
                if (isMounted) setImageSrc(null);
            }
        }

        constructUrl();

        return () => {
            isMounted = false;
        };
    }, [src, vaultPath, cacheBuster]);

    if (!src) {
        // Empty placeholder for new drawing
        return (
            <div className="drawing-placeholder">
                <div className="drawing-placeholder-icon">
                    <svg
                        width="48"
                        height="48"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M12 19l7-7 3 3-7 7-3-3z" />
                        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                        <path d="M2 2l7.586 7.586" />
                        <circle cx="11" cy="11" r="2" />
                    </svg>
                </div>
                <span className="drawing-placeholder-text">{t('drawing.double_click_start')}</span>
            </div>
        );
    }

    // If imageSrc is null (vaultPath not yet loaded), show loading state
    if (!imageSrc) {
        return (
            <div className={`drawing-preview ${selected ? 'is-selected' : ''}`}>
                <div className="drawing-loading-state">
                    <div className="drawing-loading-spinner" />
                </div>
            </div>
        );
    }

    return (
        <div className={`drawing-preview ${selected ? 'is-selected' : ''}`}>
            <img
                src={imageSrc}
                alt={alt}
                style={{
                    maxWidth: '100%',
                    height: 'auto',
                    maxHeight: `${height}px`,
                    objectFit: 'contain'
                }}
                draggable={false}
                onError={(e) => {
                    console.error('[DrawingPreview] Image load failed:', imageSrc, e);
                }}
            />
            <div className="drawing-preview-overlay">
                <span>{t('drawing.double_click_edit')}</span>
            </div>
        </div>
    );
};
