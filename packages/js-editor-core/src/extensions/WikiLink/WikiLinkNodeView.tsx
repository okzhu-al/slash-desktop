/**
 * WikiLinkNodeView - React component for rendering WikiLink nodes
 * 
 * Features:
 * - Async check if link target exists
 * - Unresolved link indicator (dashed style)
 * - Hover preview with LinkPreviewCard + relation badge
 * - AI-powered relation inference on hover
 * - Click to navigate
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import { createPortal } from 'react-dom';
import { useEditorServices } from '../../EditorDI';

const HOVER_DELAY = 400;  // ms before showing preview
const LEAVE_DELAY = 300;  // ms grace period when moving to portal
const INFER_TIMEOUT = 15000; // ms before giving up on inference

export const WikiLinkNodeView = ({ node, extension }: NodeViewProps) => {
    const { href, section, label } = node.attrs;
    const [exists, setExists] = useState<boolean | null>(null);
    const [showPreview, setShowPreview] = useState(false);
    const [previewPosition, setPreviewPosition] = useState({ top: 0, left: 0 });
    const [relation, setRelation] = useState<string | null>(null);
    const [relationLoading, setRelationLoading] = useState(false);
    const spanRef = useRef<HTMLSpanElement>(null);
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { fileSystemStore, NoteContext, LinkPreviewCard, noteService } = useEditorServices();
    const vaultPath = fileSystemStore.root?.path;
    // Safely use NoteContext if provided, fallback to undefined
    const noteCtx = NoteContext ? React.useContext(NoteContext) : undefined;

    const onNavigate = extension.options?.onNavigate as ((path: string, section?: string) => void) | undefined;

    // Check if link target exists
    useEffect(() => {
        if (!href || !vaultPath) {
            setExists(false);
            return;
        }
        const checkExists = async () => {
            try {
                const result = await noteService.checkNoteExists(href);
                setExists(result);
            } catch (e) {
                console.warn('[WikiLink] Failed to check existence:', e);
                setExists(false);
            }
        };
        checkExists();
    }, [href, vaultPath]);

    // Listen for relation inference results
    // Backend emits: { source_path, target_path, relation, reason }
    useEffect(() => {
        if (!href || !noteCtx?.noteId) return;

        const unlisten = noteService.onRelationResult(
            (payload) => {
                const { target_path: tp, relation: rel } = payload;
                if (!tp || !rel) return;
                // Match by target name (case-insensitive)
                if (tp.toLowerCase().includes(href.toLowerCase()) || href.toLowerCase().includes(tp.toLowerCase())) {
                    setRelation(rel);
                    setRelationLoading(false);
                    if (inferTimeoutRef.current) {
                        clearTimeout(inferTimeoutRef.current);
                        inferTimeoutRef.current = null;
                    }
                }
            }
        );

        return () => { unlisten.then((fn) => fn()); };
    }, [href, noteCtx?.noteId]);

    // Cleanup timeouts on unmount
    useEffect(() => {
        return () => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
            if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
            if (inferTimeoutRef.current) clearTimeout(inferTimeoutRef.current);
        };
    }, []);

    // --- Hover enter: show preview after delay ---
    const handleMouseEnter = useCallback(() => {
        if (!href) return;

        // Cancel any pending leave
        if (leaveTimeoutRef.current) {
            clearTimeout(leaveTimeoutRef.current);
            leaveTimeoutRef.current = null;
        }

        hoverTimeoutRef.current = setTimeout(() => {
            if (spanRef.current) {
                const rect = spanRef.current.getBoundingClientRect();
                setPreviewPosition({
                    top: rect.bottom + 8,
                    left: Math.max(8, rect.left),
                });
                setShowPreview(true);

                // Trigger relation inference if needed
                if (!relation && !relationLoading && exists && noteCtx?.noteId) {
                    setRelationLoading(true);
                    noteService.inferRelation(
                        noteCtx.noteId,
                        href,
                    ).catch((e: any) => {
                        console.warn('[WikiLink] Relation inference failed:', e);
                        setRelationLoading(false);
                    });
                    // Safety timeout: stop loading after INFER_TIMEOUT
                    inferTimeoutRef.current = setTimeout(() => {
                        setRelationLoading(false);
                    }, INFER_TIMEOUT);
                }
            }
        }, HOVER_DELAY);
    }, [href, relation, relationLoading, exists, noteCtx?.noteId]);

    // --- Hover leave: delayed close with grace period ---
    const handleMouseLeave = useCallback(() => {
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current);
            hoverTimeoutRef.current = null;
        }
        // Grace period: allow mouse to move to portal
        leaveTimeoutRef.current = setTimeout(() => {
            setShowPreview(false);
        }, LEAVE_DELAY);
    }, []);

    // --- Portal enter: cancel pending leave ---
    const handlePortalEnter = useCallback(() => {
        if (leaveTimeoutRef.current) {
            clearTimeout(leaveTimeoutRef.current);
            leaveTimeoutRef.current = null;
        }
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current);
        }
    }, []);

    // --- Click: navigate to linked note ---
    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowPreview(false);
        if (onNavigate && href) {
            onNavigate(href, section || undefined);
        }
    };

    const handlePreviewClose = useCallback(() => {
        setShowPreview(false);
    }, []);

    const handleRelationChange = useCallback(async (newRelation: string) => {
        if (!noteCtx?.noteId || !href) return;
        setRelation(newRelation);
        try {
            await noteService.addRelation(
                noteCtx.noteId,
                href, // targetPath
                href, // targetTitle
                newRelation,
            );
            window.dispatchEvent(new CustomEvent('slash:graph-refresh'));
        } catch (e) {
            console.error('[WikiLink] Failed to save relation:', e);
        }
    }, [noteCtx?.noteId, href]);

    const className = exists === false
        ? 'wiki-link wiki-link-unresolved'
        : 'wiki-link';

    const title = showPreview
        ? undefined
        : exists === false
            ? `笔记 "${href}" 不存在`
            : section
                ? `${href} → ${section}`
                : href;

    return (
        <NodeViewWrapper as="span" className="inline">
            <span
                ref={spanRef}
                className={className}
                onClick={handleClick}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                title={title}
                data-href={href}
                data-section={section}
                contentEditable={false}
            >
                {label}
            </span>

            {/* Hover Preview Portal */}
            {showPreview && createPortal(
                <div
                    style={{
                        position: 'fixed',
                        top: previewPosition.top,
                        left: previewPosition.left,
                        zIndex: 9999,
                    }}
                    onMouseEnter={handlePortalEnter}
                    onMouseLeave={handleMouseLeave}
                >
                    <LinkPreviewCard
                        noteName={href}
                        section={section}
                        onNavigate={onNavigate}
                        onClose={handlePreviewClose}
                        relation={relation}
                        relationLoading={relationLoading}
                        onRelationChange={handleRelationChange}
                    />
                </div>,
                document.body
            )}
        </NodeViewWrapper>
    );
};
