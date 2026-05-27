/**
 * NoteNode — Custom ReactFlow node for note entries in knowledge graph.
 *
 * LOD-responsive rendering:
 * L0: Colored dot (6px)
 * L1: Minimal pill label
 * L2: Full label card + hover summary
 * L3: Full detail card + tags + summary
 */

import { memo, useState, useCallback } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import type { KnowledgeNodeData } from '../types';
import { CATEGORY_COLORS, EDGE_TIER_COLORS, EDGE_TIER_COLORS_DARK, NODE_TIERS_LIGHT, NODE_TIERS_DARK, truncateLabel } from '../constants';
import { useLOD } from '../hooks/useLOD';
import { Plus } from 'lucide-react';
import { useTheme } from '@/core/theme/ThemeProvider';

// RGB interpolation for active/center node energy (White glow in dark mode, Dark matter core in light mode)
const blendWithContrast = (hex: string, intensityPct: number, isDark: boolean) => {
    if (!hex?.startsWith('#') || hex.length !== 7) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const ratio = intensityPct / 100;
    
    if (isDark) {
        // Blend towards pure white for Dark Mode energy
        return `rgb(${Math.round(r + (255 - r) * ratio)}, ${Math.round(g + (255 - g) * ratio)}, ${Math.round(b + (255 - b) * ratio)})`;
    } else {
        // Blend towards near-black (#18181b / zinc-900) for Light Mode contrast energy
        return `rgb(${Math.round(r + (24 - r) * ratio)}, ${Math.round(g + (24 - g) * ratio)}, ${Math.round(b + (27 - b) * ratio)})`;
    }
};

function NoteNodeComponent({ data }: NodeProps & { data: KnowledgeNodeData }) {
    const {
        label, tags, category, exists, isCenter, isNew, summary, notePath
    } = data;


    const lod = useLOD();
    const zoom = useStore((s) => s.transform[2]);
    const isGhost = !exists;
    const hopTier = (data.hopTier ?? 1) as number;  // 1=bright, 2=medium, 3=dim
    const tierIdx = Math.max(0, Math.min(2, hopTier - 1));  // 0-indexed

    // Reactive dark mode detection
    const { theme } = useTheme();
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const nodeTier = isDark ? NODE_TIERS_DARK[tierIdx] : NODE_TIERS_LIGHT[tierIdx];
    const edgeTiers = isDark ? (EDGE_TIER_COLORS_DARK[category] || EDGE_TIER_COLORS_DARK.resource) : (EDGE_TIER_COLORS[category] || EDGE_TIER_COLORS.resource);
    const barColor = edgeTiers[tierIdx];
    const { t } = useTranslation();

    const [hovered, setHovered] = useState(false);

    const handlePointerEnter = useCallback(() => {
        setHovered(true);
        window.dispatchEvent(new CustomEvent('graph:node-hover', {
            detail: { nodeId: notePath, hovered: true }
        }));
    }, [notePath]);

    const handlePointerLeave = useCallback(() => {
        setHovered(false);
        window.dispatchEvent(new CustomEvent('graph:node-hover', {
            detail: { nodeId: notePath, hovered: false }
        }));
    }, [notePath]);

    const handleAddChild = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('graph:add-child-node', {
            detail: { nodeId: notePath, isFolder: false, screenX: e.clientX, screenY: e.clientY },
        }));
    }, [notePath]);

    // =========================================================================
    // L0: Ultra-far — tiny dot
    // =========================================================================
    if (lod === 0) {
        // Color scale for L0 to L1 zoom range boundary
        const colorScale = Math.max(0, Math.min(1, (zoom - 0.4) / 0.2));
        const whitePct = (1 - colorScale) * 100;
        
        const baseColor = isGhost ? (isDark ? '#333333' : '#dddddd') : CATEGORY_COLORS[category] || barColor;
        return (
            <div
                style={{
                    width: 16, height: 16,
                    borderRadius: '50%',
                    backgroundColor: isCenter ? blendWithContrast(baseColor, whitePct, isDark) : baseColor,
                    ...(isCenter ? {
                        boxShadow: isDark ? `0 0 ${10 - colorScale * 2}px rgba(255,255,255,0.9)` : `0 0 ${14 - colorScale * 2}px ${baseColor}`,
                        transform: `scale(${1.3 - colorScale * 0.25})`,
                        zIndex: 50
                    } : hopTier === 1 ? {
                        filter: `drop-shadow(0 0 6px ${barColor}80)`,
                        transform: 'scale(1.1)',
                        zIndex: 40
                    } : hopTier === 2 ? {
                        zIndex: 10
                    } : {
                        zIndex: 1
                    })
                }}
            >
                <Handle type="target" position={Position.Top} isConnectable={false} className="w-0! h-0! border-none! bg-transparent! opacity-0!" />
                <Handle type="source" position={Position.Bottom} isConnectable={false} className="w-0! h-0! border-none! bg-transparent! opacity-0!" />
            </div>
        );
    }

    // =========================================================================
    // L1: Minimal pill
    // =========================================================================
    if (lod === 1) {
        return (
            <div
                className={`
                    flex items-center px-2 py-0.5 rounded-md text-[9px] font-medium
                    ${isGhost 
                        ? 'border border-dashed border-zinc-400 dark:border-zinc-600 bg-transparent text-zinc-500 dark:text-zinc-400' 
                        : ''
                    }
                `}
                style={{
                    borderLeft: isGhost ? undefined : `4px solid ${barColor}`,
                    maxWidth: 100,
                    ...(!isGhost ? { backgroundColor: nodeTier.bg, color: nodeTier.text, boxShadow: nodeTier.shadow } : {}),
                }}
            >
                <span className="truncate">{truncateLabel(label)}</span>
                <Handle type="target" position={Position.Top} isConnectable={false} className="w-0! h-0! border-none! bg-transparent! opacity-0!" />
                <Handle type="source" position={Position.Bottom} isConnectable={false} className="w-0! h-0! border-none! bg-transparent! opacity-0!" />
            </div>
        );
    }

    // =========================================================================
    // L2–L3: Full card
    // =========================================================================
    const showTags = lod >= 2 && tags && tags.length > 0;
    const showHoverDetail = hovered && lod >= 2 && (summary || (tags && tags.length > 0));

    return (
        <div
            className="relative group"
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
        >
            {/* Main card */}
            <div
                className={`
                    rounded-md transition-all duration-400 ease-out h-[56px]
                    ${isGhost
                        ? 'border border-dashed border-zinc-400 dark:border-zinc-600 bg-transparent text-zinc-400'
                        : ''
                    }
                    ${isGhost ? 'opacity-50' : ''}
                `}
                style={{
                    minWidth: 100,
                    maxWidth: 200,
                    backfaceVisibility: 'hidden',
                    ...(!isGhost ? { backgroundColor: nodeTier.bg } : {}),
                    // Pro-Max Active Selection Styling (ONLY for L0/L1)
                    ...(lod <= 1 ? (isCenter 
                        ? (() => {
                            const colorScale = Math.max(0, Math.min(1, (zoom - 0.4) / 0.2));
                            const whitePct = (1 - colorScale) * 100;
                            return { 
                                backgroundColor: blendWithContrast(nodeTier.bg, whitePct, isDark),
                                filter: `drop-shadow(0 0 ${10 - colorScale * 2}px rgba(255,255,255,0.9))`,
                                transform: `translateZ(0) scale(${1.05 + (1-colorScale)*0.25})`,
                                zIndex: 50 
                            };
                          })() 
                        : hopTier === 1 ? {
                            boxShadow: nodeTier.shadow,
                            transform: 'translateZ(0)',
                            zIndex: 40
                        } : hopTier === 2 ? {
                            boxShadow: nodeTier.shadow,
                            transform: 'translateZ(0)',
                            zIndex: 10
                        } : { 
                            boxShadow: nodeTier.shadow,
                            transform: 'translateZ(0)',
                            zIndex: 1
                          }
                    ) : {
                        boxShadow: nodeTier.shadow,
                        transform: 'translateZ(0)',
                        opacity: isGhost ? 0.5 : 1
                    }),
                }}
            >
                {/* PARA color accent bar */}
                <div
                    className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md"
                    style={{ backgroundColor: barColor }}
                />

                {/* Content */}
                <div className={`pl-3.5 pr-3 py-2 flex flex-col h-full ${showTags ? 'justify-between' : 'justify-center'}`}>
                    {/* Title */}
                    <div className="flex items-center gap-1.5">
                        {isNew && <Plus size={12} className="text-emerald-500 shrink-0" />}
                        <span
                            className={`
                                text-[12px] font-semibold leading-tight truncate
                                ${isGhost ? 'text-zinc-400 italic' : ''}
                            `}
                            style={!isGhost ? { color: nodeTier.text } : undefined}
                            title={label}
                        >
                            {label}
                        </span>
                    </div>

                    {/* Tags (L2/L3) */}
                    {showTags && (
                        <div className="mt-1 flex gap-1 flex-nowrap overflow-hidden pointer-events-none justify-start w-full">
                            {Array.isArray(tags) && tags.slice(0, 3).map(tag => (
                                <span
                                    key={tag}
                                    className="text-[9.5px] px-1.5 py-[1px] rounded-full border shadow-sm font-medium whitespace-nowrap backdrop-blur-sm truncate max-w-[70px]"
                                    style={{
                                        backgroundColor: isDark ? `${barColor}1A` : `${barColor}10`,
                                        color: barColor,
                                        borderColor: isDark ? `${barColor}40` : `${barColor}30`,
                                    }}
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Hover detail tooltip */}
            {showHoverDetail && (
                <div className="absolute top-0 left-full ml-2
                                bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700
                                rounded-lg shadow-xl px-3 py-2 z-50 min-w-[160px] max-w-[240px]"
                >
                    <div className="text-[11px] font-bold text-zinc-800 dark:text-zinc-100 truncate mb-1">{label}</div>
                    
                    {/* User Tags in Hover Card */}
                    {tags && tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                            {tags.map(tag => (
                                <span key={tag} className="text-[8.5px] px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-700/50 text-zinc-500 dark:text-zinc-400 font-medium">
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                    
                    {/* User Summary in Hover Card */}
                    {summary && (
                        <div className="text-[10px] text-zinc-600 dark:text-zinc-300 line-clamp-3 leading-relaxed">
                            {summary}
                        </div>
                    )}
                </div>
            )}

            {/* Add child button (L3+, non-ghost) */}
            {!isGhost && lod >= 3 && (
                <button
                    onClick={handleAddChild}
                    className="absolute -bottom-3 left-1/2 -translate-x-1/2
                               w-5 h-5 rounded-full
                               bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md border border-zinc-200/50 dark:border-zinc-700/50
                               text-zinc-400 hover:text-blue-500 hover:border-blue-300 dark:hover:border-blue-500/50 hover:scale-110
                               hover:shadow-lg
                               flex items-center justify-center
                               opacity-0 group-hover:opacity-100 transition-all duration-200
                               shadow-md z-10"
                    title={t('graph.add_related_note', '添加关联笔记')}
                >
                    <Plus size={12} strokeWidth={2.5} />
                </button>
            )}

            {/* Handles - Hidden and edge-bound by default */}
            <Handle type="target" position={Position.Top} isConnectable={false} className="w-0! h-0! border-none! opacity-0!" />
            <Handle type="source" position={Position.Bottom} isConnectable={false} className="w-0! h-0! border-none! opacity-0!" />
            <Handle type="target" position={Position.Left} id="left" isConnectable={false} className="w-0! h-0! border-none! opacity-0!" />
            <Handle type="source" position={Position.Right} id="right" isConnectable={false} className="w-0! h-0! border-none! opacity-0!" />
        </div>
    );
}

export const NoteNode = memo(NoteNodeComponent);
