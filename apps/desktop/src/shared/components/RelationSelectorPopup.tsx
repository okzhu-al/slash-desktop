import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RELATION_GROUPS } from '@/shared/constants/relations';

export interface RelationSelectorPopupProps {
    position?: { x: number; y: number };
    initialRelation?: string;
    onSelect: (relation: string) => void;
    onCancel: () => void;
}

export function RelationSelectorPopup({ position, initialRelation = '', onSelect, onCancel }: RelationSelectorPopupProps) {
    const { t } = useTranslation();
    const [relation, setRelation] = useState(initialRelation);
    const [isOpen, setIsOpen] = useState(false);
    const [activeGroup, setActiveGroup] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && relation.trim()) {
            onSelect(relation.trim());
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    return (
        <>
            {position && (
                <div
                    className="fixed inset-0 z-90"
                    onClick={(e) => { e.stopPropagation(); onCancel(); }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}
                />
            )}
            <div
                className={`${position ? 'fixed z-100' : 'absolute top-full left-0 mt-1 z-100'} w-64 bg-white/95 dark:bg-zinc-800/95 backdrop-blur-xl 
                           border border-zinc-200/50 dark:border-zinc-700/50 rounded-xl shadow-2xl p-3.5 
                           animate-in fade-in zoom-in-95 font-sans`}
                style={position ? { left: position.x, top: position.y } : undefined}
                onContextMenu={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="text-[10px] font-semibold tracking-wider text-zinc-400 dark:text-zinc-500 uppercase mb-3 px-0.5">
                    {t('graph.edit_relation', '修改连线关系')}
                </div>

                <input
                    ref={inputRef}
                    type="text"
                    value={relation}
                    onChange={e => setRelation(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('graph.relation_placeholder', '输入关系名称...')}
                    className="w-full px-2 py-1.5 text-[13px] border-b border-zinc-300 dark:border-zinc-600
                               bg-transparent focus:outline-none focus:border-blue-500 
                               text-zinc-800 dark:text-zinc-200 mb-4 transition-colors font-medium placeholder:font-normal"
                />

                <div className="relative mb-3">
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIsOpen(!isOpen); }}
                        className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs bg-zinc-100/50 dark:bg-zinc-700/50 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200/50 dark:border-zinc-600/50 rounded-md text-zinc-700 dark:text-zinc-300 transition-colors"
                    >
                        <div className="flex items-center gap-2 truncate">
                            <span className="text-[10px] bg-zinc-200/50 dark:bg-zinc-800 rounded px-1 text-zinc-500">Link</span>
                            <span className="truncate">{relation ? t(`relations.${relation}`, relation) : t('graph.select_relation', '选择预设关系...')}</span>
                        </div>
                        <span className="text-zinc-400 text-[10px]">▼</span>
                    </button>

                    {isOpen && (
                        <div className="absolute top-full left-0 mt-1 w-full max-h-[160px] overflow-y-auto bg-white/95 dark:bg-zinc-800/95 backdrop-blur-xl border border-zinc-200/50 dark:border-zinc-700/50 shadow-xl rounded-lg z-50 p-1 animate-in fade-in zoom-in-95 custom-scrollbar">
                            {activeGroup === null ? (
                                <div className="flex flex-col gap-0.5">
                                    {RELATION_GROUPS.map(g => (
                                        <div key={g.labelKey} className="flex items-stretch w-full rounded-md transition-colors text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700">
                                            <button
                                                type="button"
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveGroup(g.labelKey); }}
                                                className="flex-1 flex items-center px-2 py-1.5 text-left text-xs min-w-0"
                                            >
                                                <span className="mr-1.5 text-[10px] w-3 flex justify-center"></span>
                                                <span className="truncate">{t(g.labelKey, g.label)}</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveGroup(g.labelKey); }}
                                                className="px-1.5 flex items-center text-[9px] opacity-70 hover:opacity-100 hover:bg-zinc-200 dark:hover:bg-zinc-600 rounded-r-md transition-colors"
                                            >
                                                ❯
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveGroup(null); }}
                                        className="flex shrink-0 items-center w-full px-2 py-1.5 text-left text-xs rounded-md text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors mb-0.5 sticky top-0 z-10 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md"
                                    >
                                        <span className="mr-1 mt-px">‹</span>
                                        <span className="truncate flex-1">{t('common.back_to_group', '返回 分组')} / {t(RELATION_GROUPS.find(g => g.labelKey === activeGroup)?.labelKey || '', RELATION_GROUPS.find(g => g.labelKey === activeGroup)?.label || '')}</span>
                                    </button>
                                    <div className="overflow-y-auto flex-1 flex flex-col gap-0.5">
                                        {RELATION_GROUPS.find(g => g.labelKey === activeGroup)?.keys.map(r => (
                                            <button
                                                key={r}
                                                type="button"
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRelation(r); setIsOpen(false); setActiveGroup(null); }}
                                                className={`flex items-center w-full px-2 py-1.5 text-left text-xs rounded-md transition-colors ${r === relation ? 'bg-blue-500 text-white dark:bg-blue-600' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'}`}
                                            >
                                                <span className="mr-1.5 text-[10px] w-3 flex justify-center">{r === relation ? '✓' : ''}</span>
                                                <span className="truncate flex-1">{t(`relations.${r}`, r)}</span>
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex gap-2 mt-1">
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); relation.trim() && onSelect(relation.trim()); }}
                        className="flex-1 px-3 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600 shadow-sm transition-colors"
                    >
                        {t('common.save', '保存')}
                    </button>
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}
                        className="flex-1 px-3 py-1.5 text-xs font-medium bg-zinc-100 dark:bg-zinc-700 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 transition-colors"
                    >
                        {t('common.cancel', '取消')}
                    </button>
                </div>
            </div>
        </>
    );
}
