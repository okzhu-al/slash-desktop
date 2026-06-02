/**
 * GraphTooltip - Hover popup for graph nodes (v2)
 * 
 * Updated for ReactFlow — no longer needs canvas coordinate conversion.
 * Used for showing node summary on hover.
 */

import type { KnowledgeNodeData } from '../types';

interface GraphTooltipProps {
    node: KnowledgeNodeData | null;
    position: { x: number; y: number } | null;
}

export const GraphTooltip = ({ node, position }: GraphTooltipProps) => {
    if (!node || !position) return null;

    const isFolder = node.nodeType === 'folder';
    const summary = node.summary;

    return (
        <div
            className="fixed z-50 pointer-events-none"
            style={{ left: position.x + 14, top: position.y + 14 }}
        >
            <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 max-w-[260px]">
                {/* Full Name */}
                <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 leading-snug">
                    {node.label}
                </div>

                {/* Tags */}
                {node.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                        {node.tags.map(tag => (
                            <span key={tag} className="text-[9px] px-1.5 py-px rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-blue-400">
                                {tag}
                            </span>
                        ))}
                    </div>
                )}

                {/* Summary — Note only */}
                {!isFolder && summary && (
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-3">
                        {summary}
                    </div>
                )}
            </div>
        </div>
    );
};
