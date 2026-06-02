/**
 * LinkPreviewCard - Hover preview card for WikiLinks
 * 
 * Shows note title, relation badge (editable), summary, and allows click to navigate
 */

import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystemStore } from '@/core/fs/store';
import { useTranslation } from 'react-i18next';
import { type RelationSlug } from '@/shared/constants/relations';
import { RelationSelectorPopup } from '@/shared/components/RelationSelectorPopup';

interface NotePreview {
    exists: boolean;
    title: string;
    path: string | null;
    summary: string | null;
    content_preview: string | null;
}

interface LinkPreviewCardProps {
    noteName: string;
    section?: string;
    onNavigate?: (path: string, section?: string) => void;
    onClose?: () => void;
    /** Current relation type (from YAML frontmatter) */
    relation?: string | null;
    /** Callback when user changes relation */
    onRelationChange?: (relation: string) => void;
    /** Whether relation inference is loading */
    relationLoading?: boolean;
}

export const LinkPreviewCard = ({
    noteName,
    section,
    onNavigate,
    onClose,
    relation,
    onRelationChange,
    relationLoading,
}: LinkPreviewCardProps) => {
    const { t } = useTranslation();
    const [preview, setPreview] = useState<NotePreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [showRelationPicker, setShowRelationPicker] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);
    const vaultPath = useFileSystemStore(state => state.root?.path);

    useEffect(() => {
        if (!noteName || !vaultPath) {
            setLoading(false);
            return;
        }

        const fetchPreview = async () => {
            try {
                const result = await invoke<NotePreview>('get_note_preview', {
                    vaultPath,
                    noteName,
                });
                setPreview(result);
            } catch (e) {
                console.warn('[LinkPreviewCard] Failed to fetch preview:', e);
                setPreview(null);
            } finally {
                setLoading(false);
            }
        };

        fetchPreview();
    }, [noteName, vaultPath]);

    // Close picker on click outside
    useEffect(() => {
        if (!showRelationPicker) return;
        const handler = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setShowRelationPicker(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showRelationPicker]);

    const handleClick = () => {
        if (onNavigate && preview?.exists) {
            onNavigate(noteName, section || undefined);
            onClose?.();
        }
    };

    const handleRelationSelect = (slug: RelationSlug) => {
        onRelationChange?.(slug);
        setShowRelationPicker(false);
    };

    if (loading) {
        return (
            <div className="w-72 p-3 rounded-lg border bg-white dark:bg-zinc-800 shadow-lg">
                <div className="animate-pulse">
                    <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-3/4 mb-2"></div>
                    <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded w-full mb-1"></div>
                    <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded w-5/6"></div>
                </div>
            </div>
        );
    }

    if (!preview?.exists) {
        const handleCreateClick = () => {
            if (onNavigate) {
                onNavigate(noteName, section || undefined);
                onClose?.();
            }
        };

        return (
            <div
                className="w-72 p-3 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 shadow-lg cursor-pointer hover:border-indigo-300 dark:hover:border-blue-400/60 transition-colors"
                onClick={handleCreateClick}
            >
                <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span className="text-sm">{t('wikilink.notFound', '笔记不存在')}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                    {t('wikilink.clickToCreate', '点击可创建')}：{noteName}
                </p>
            </div>
        );
    }

    const displayContent = preview.summary || preview.content_preview;

    return (
        <div
            className="w-72 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg cursor-pointer hover:border-indigo-300 dark:hover:border-blue-400/60 transition-colors"
            onClick={handleClick}
        >
            {/* Title */}
            <h4 className="font-medium text-zinc-900 dark:text-zinc-100 mb-1 line-clamp-1">
                {preview.title}
                {section && (
                    <span className="text-indigo-500 dark:text-blue-400 ml-1">
                        #{section}
                    </span>
                )}
            </h4>

            {/* Relation Badge — show when loading or has AI-inferred relation */}
            {relationLoading ? (
                <div className="mb-2">
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-700 text-zinc-400 animate-pulse">
                        🔍 {t('relation.inferring', '推理中…')}
                    </span>
                </div>
            ) : relation ? (
                <div className="relative mb-2" ref={pickerRef}>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (onRelationChange) setShowRelationPicker(!showRelationPicker);
                        }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-blue-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/60 transition-colors"
                        title={t('relation.clickToChange', '点击修改关系')}
                    >
                        📎 {t(`relation.${relation}`, relation)}
                    </button>

                            {/* Relation Picker Dropdown */}
                            {showRelationPicker && (
                                <div className="absolute top-full left-0 mt-1 z-50">
                                    <RelationSelectorPopup
                                        initialRelation={relation as RelationSlug}
                                        onSelect={(rel) => {
                                            handleRelationSelect(rel as RelationSlug);
                                            setShowRelationPicker(false);
                                        }}
                                        onCancel={() => setShowRelationPicker(false)}
                                    />
                                </div>
                            )}
                        </div>
                    ) : null}

            {/* Content preview */}
            {displayContent ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-3">
                    {displayContent}
                </p>
            ) : (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">
                    {t('wikilink.noContent', '无内容预览')}
                </p>
            )}

            {/* Footer hint */}
            <div className="mt-2 text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                {t('wikilink.clickToOpen', '点击打开')}
            </div>
        </div>
    );
};

