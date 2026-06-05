import { useState, useMemo, useCallback } from 'react';
import { useOutlineStore } from '@/stores/useOutlineStore';
import { useTranslation } from 'react-i18next';
import { List, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/utils/cn';

/**
 * 判断每个 heading 是否拥有子级（即后面紧跟着 level 更大的 heading）
 * 返回一个 Set，包含所有"有子级"的 heading 索引
 */
function computeParentIndices(headings: { level: number }[]): Set<number> {
    const parents = new Set<number>();
    for (let i = 0; i < headings.length - 1; i++) {
        if (headings[i + 1].level > headings[i].level) {
            parents.add(i);
        }
    }
    return parents;
}

/**
 * 根据折叠状态计算可见的 heading 索引列表
 * 被折叠的父级的所有子孙级（level 更大的后续连续 heading）都应隐藏
 */
function computeVisibleIndices(
    headings: { level: number }[],
    collapsed: Set<number>
): number[] {
    const visible: number[] = [];
    let i = 0;
    while (i < headings.length) {
        visible.push(i);
        if (collapsed.has(i)) {
            // 跳过所有 level 更大的后续 heading（即子孙级）
            const parentLevel = headings[i].level;
            i++;
            while (i < headings.length && headings[i].level > parentLevel) {
                i++;
            }
        } else {
            i++;
        }
    }
    return visible;
}

export const OutlinePanel = () => {
    const { t } = useTranslation();
    const headings = useOutlineStore(state => state.headings);
    const activeIndex = useOutlineStore(state => state.activeIndex);
    // 折叠状态：存储被折叠的 heading 原始索引
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

    const parentIndices = useMemo(() => computeParentIndices(headings), [headings]);
    const visibleIndices = useMemo(() => computeVisibleIndices(headings, collapsed), [headings, collapsed]);

    const toggleCollapse = useCallback((index: number) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    if (headings.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 p-6 text-center space-y-3">
                <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                    <List size={18} className="text-zinc-400" />
                </div>
                <div>
                    <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                        {t('outline.empty_title', '暂无大纲')}
                    </h3>
                    <p className="text-xs text-zinc-500 mt-1">
                        {t('outline.empty_desc', '在笔记中使用标题即可自动生成大纲')}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-zinc-50/50 dark:bg-zinc-900/50">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-200/50 dark:border-zinc-800/50">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-500 dark:text-blue-400">
                        <List size={14} />
                    </div>
                    <span className="text-xs font-semibold tracking-wide text-zinc-700 dark:text-zinc-300">
                        {t('outline.panel_title', '笔记大纲')}
                    </span>
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
                {visibleIndices.map((idx) => {
                    const h = headings[idx];
                    const isParent = parentIndices.has(idx);
                    const isCollapsed = collapsed.has(idx);

                    const isActive = activeIndex === idx;

                    return (
                        <div
                            key={`${h.id}-${idx}`}
                            className={cn(
                                "group flex items-center py-1.5 px-2 rounded-md cursor-pointer",
                                "transition-colors duration-150",
                                isActive
                                    ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-blue-300"
                                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/80"
                            )}
                            style={{
                                paddingLeft: `${Math.max(0, h.level - 1) * 12 + 8}px`
                            }}
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('slash:scroll-to-pos', { 
                                    detail: { pos: h.pos, noteId: h.noteId } 
                                }));
                            }}
                        >
                            {/* 折叠箭头 / 圆点指示器 */}
                            {isParent ? (
                                <button
                                    className={cn(
                                        "w-4 h-4 shrink-0 mr-1.5 flex items-center justify-center rounded",
                                        "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200",
                                        "hover:bg-zinc-300/50 dark:hover:bg-zinc-700/50",
                                        "transition-all duration-150"
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation(); // 阻止冒泡到外层的滚动事件
                                        toggleCollapse(idx);
                                    }}
                                >
                                    <ChevronRight
                                        size={12}
                                        className={cn(
                                            "transition-transform duration-150",
                                            !isCollapsed && "rotate-90"
                                        )}
                                    />
                                </button>
                            ) : (
                                <span className={cn(
                                    "w-4 shrink-0 mr-1.5 flex items-center justify-center"
                                )}>
                                    <span className={cn(
                                        "w-1 h-1 rounded-full transition-colors",
                                        isActive
                                            ? "bg-indigo-500 dark:bg-indigo-400"
                                            : h.level === 1 ? "bg-indigo-500 dark:bg-indigo-400" :
                                              h.level === 2 ? "bg-emerald-500 dark:bg-emerald-400" :
                                              "bg-zinc-300 dark:bg-zinc-600 group-hover:bg-zinc-400 dark:group-hover:bg-zinc-500"
                                    )} />
                                </span>
                            )}
                            <span className={cn(
                                "text-sm truncate select-none transition-colors",
                                h.level === 1 ? "font-semibold" :
                                h.level === 2 ? "font-medium" : "font-normal text-xs"
                            )}>
                                {h.text}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
