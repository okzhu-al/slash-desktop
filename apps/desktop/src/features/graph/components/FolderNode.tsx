/**
 * FolderNode — Custom ReactFlow node for folder entries in the knowledge graph.
 *
 * Two sub-forms based on PARA category:
 * - Project folders: Progress ring (SVG arc showing task completion)
 * - Other folders:   Compact hub dot with count badge
 *
 * Both forms respond to LOD levels for progressive detail disclosure.
 */

import { memo, useState, useCallback } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import type { KnowledgeNodeData } from '../types';
import { CATEGORY_COLORS, EDGE_TIER_COLORS, EDGE_TIER_COLORS_DARK } from '../constants';
import { useLOD } from '../hooks/useLOD';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Plus } from 'lucide-react';

// SVG ring geometry

const RING_STROKE = 5;

// Hub dot geometry
const HUB_RADIUS_BY_LOD = [6, 12, 18, 22];

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

function FolderNodeComponent({ id, data }: NodeProps & { data: KnowledgeNodeData }) {
    const { label, category, noteCount, taskProgress } = data;
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.resource;
    const lod = useLOD();
    const zoom = useStore((s) => s.transform[2]);
    const isProject = category === 'project';
    const { t } = useTranslation();

    const [hovered, setHovered] = useState(false);

    const handlePointerEnter = useCallback(() => {
        setHovered(true);
        window.dispatchEvent(new CustomEvent('graph:node-hover', {
            detail: { nodeId: id, hovered: true }
        }));
    }, [id]);

    const handlePointerLeave = useCallback(() => {
        setHovered(false);
        window.dispatchEvent(new CustomEvent('graph:node-hover', {
            detail: { nodeId: id, hovered: false }
        }));
    }, [id]);

    const hopTier = (data.hopTier ?? 1) as number;
    const tierIdx = Math.max(0, Math.min(2, hopTier - 1));
    const isCenter = !!data.isCenter;
    const { theme } = useTheme();
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const tierPalette = isDark ? EDGE_TIER_COLORS_DARK : EDGE_TIER_COLORS;
    const tierColor = (tierPalette[category] || tierPalette.resource)[tierIdx];

    // Glow config
    const isDimmed = false;
    const baseGlowSize = 8;
    const activeGlowSize = baseGlowSize + (zoom < 0.5 ? (0.5 - zoom) * 20 : 0) + (hovered ? 6 : 0);
    const glowColor = isCenter
        ? (isDark ? 'rgba(255,255,255,0.3)' : `${color}40`)
        : (hovered ? `${color}60` : 'transparent');
    const baseEnergyColor = color;

    const handleAddChild = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const event = new CustomEvent('graph:add-child-node', {
            detail: {
                nodeId: id,
                isFolder: true,
                screenX: e.clientX,
                screenY: e.clientY,
            }
        });
        window.dispatchEvent(event);
    }, [id]);

    // =========================================================================
    // L0/L1: Ultra-far / Mid-far — tiny dot, no text
    // =========================================================================
    if (lod <= 1) {
        // Linear transition from zoom 0.4 (L0) to 0.6 (L2 boundary)
        const colorScale = Math.max(0, Math.min(1, (zoom - 0.4) / 0.2));
        const whitePct = (1 - colorScale) * 100;

        return (
            <div
                style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: isCenter ? blendWithContrast(tierColor, whitePct, isDark) : (CATEGORY_COLORS[category] || tierColor),
                    ...(isCenter ? {
                        boxShadow: isDark ? `0 0 ${8 + (1 - colorScale) * 4}px rgba(255,255,255,0.9)` : `0 0 ${12 + (1 - colorScale) * 4}px ${tierColor}`,
                        transform: `scale(${1.15 + (1 - colorScale) * 0.15})`,
                        zIndex: 50
                    } : hopTier === 1 ? {
                        filter: `drop-shadow(0 0 8px ${tierColor}80)`,
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
    // Project Ring (L1–L3)
    // =========================================================================
    if (isProject) {
        const done = taskProgress?.done ?? 0;
        const total = taskProgress?.total ?? Math.max(noteCount, 1);
        const progress = total > 0 ? done / total : 0;

        // Dynamic sizing based on depth and count
        const depth = Math.max(1, (id.match(/\//g) || []).length + 1);
        const baseRingR = Math.max(16, 28 - (depth - 1) * 3);
        const ringBonus = Math.min(12, Math.log10(Math.max(1, total)) * 5);
        const ringRadius = Math.round(baseRingR + ringBonus);
        const ringCircumference = 2 * Math.PI * ringRadius;
        const dashOffset = ringCircumference * (1 - progress);

        const showLabel = lod >= 2;
        const showHover = hovered && lod >= 2;
        const ringScale = lod === 1 ? 0.65 : 1;
        const svgSize = (ringRadius + RING_STROKE) * 2 + 4;

        return (
            <div
                className="relative group flex flex-col items-center transition-all duration-300 ease-out will-change-transform"
                onPointerEnter={handlePointerEnter}
                onPointerLeave={handlePointerLeave}
                style={{
                    zIndex: isCenter ? 50 : hopTier === 1 ? 40 : hopTier === 2 ? 10 : 1,
                    opacity: 1
                }}
            >
                {/* Ring SVG */}
                <svg
                    width={svgSize * ringScale}
                    height={svgSize * ringScale}
                    viewBox={`0 0 ${svgSize} ${svgSize}`}
                    style={{ overflow: 'visible', filter: isCenter ? (isDark ? 'drop-shadow(0 0 10px rgba(255,255,255,0.8))' : `drop-shadow(0 4px 12px ${color}80)`) : hopTier === 1 ? `drop-shadow(0 0 6px ${color}80)` : 'drop-shadow(0 2px 6px rgba(0,0,0,0.12))' }}
                >
                    {/* Inner Glass Backdrop */}
                    <circle
                        cx={svgSize / 2} cy={svgSize / 2} r={ringRadius}
                        fill={isDark ? '#18181b' : '#ffffff'}
                        fillOpacity={isDark ? 0.6 : 0.8}
                        stroke="none"
                    />
                    {/* Empty Track Ring */}
                    <circle
                        cx={svgSize / 2} cy={svgSize / 2} r={ringRadius}
                        fill="none"
                        stroke={tierColor}
                        strokeWidth={RING_STROKE}
                        strokeOpacity={0.15}
                    />
                    {/* Progress arc */}
                    <circle
                        cx={svgSize / 2} cy={svgSize / 2} r={ringRadius}
                        fill="none"
                        stroke={color}
                        strokeWidth={RING_STROKE}
                        strokeLinecap="round"
                        strokeDasharray={ringCircumference}
                        strokeDashoffset={dashOffset}
                        transform={`rotate(-90 ${svgSize / 2} ${svgSize / 2})`}
                        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                    />
                    {/* Center count */}
                    <text
                        x={svgSize / 2} y={svgSize / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={lod >= 2 ? (progress === 1 ? 12 : 11) : 11}
                        fontWeight={800}
                        fill={isDark ? '#f4f4f5' : '#27272a'}
                    >
                        {lod >= 2 ? `${Math.round(progress * 100)}%` : noteCount}
                    </text>
                </svg>

                {/* Always-on Label at L3 */}
                {showLabel && (
                    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 flex flex-col items-center">
                        <div className="px-2 py-0.5 rounded-full bg-white/90 dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 shadow-sm backdrop-blur-md">
                            <span className="text-[12px] font-bold text-zinc-800 dark:text-zinc-100 whitespace-nowrap">
                                {label}
                            </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 px-2">
                            <span className="text-[10px] font-medium text-zinc-500 whitespace-nowrap">
                                {t('notes_count', { count: noteCount })}
                            </span>
                            <span className="text-[8px] text-zinc-400">•</span>
                            <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: color }}>
                                {done}/{total}
                            </span>
                        </div>
                    </div>
                )}

                {/* Tooltips and Handles below */}

                {/* Hover tooltip */}
                {showHover && (
                    <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full
                                    bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700
                                    rounded-lg shadow-xl px-3 py-2 z-50 min-w-[140px]"
                    >
                        <div className="text-[12px] font-bold text-zinc-800 dark:text-zinc-100 truncate">{label}</div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {t('notes_count', { count: noteCount })}
                        </div>
                        <div className="text-[11px] mt-0.5 font-medium" style={{ color }}>
                            {t('graph.tasks')} {done}/{total}
                        </div>
                        {/* Progress bar */}
                        <div className="mt-1 h-1.5 bg-zinc-100 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${progress * 100}%`, backgroundColor: color }} />
                        </div>
                    </div>
                )}

                {/* Add child button (L3+) */}
                {lod >= 3 && (
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
                        title={t('graph.create_in_dir')}
                    >
                        <Plus size={12} strokeWidth={2.5} />
                    </button>
                )}

                {/* Handles */}
                <Handle type="target" position={Position.Top} isConnectable={false} className="w-0! h-0! border-none! opacity-0" />
                <Handle type="source" position={Position.Bottom} isConnectable={false} className="w-0! h-0! border-none! opacity-0" />
            </div>
        );
    }

    // =========================================================================
    // Normal Folder (Compact Hub Dot)
    // =========================================================================

    // Calculate size dynamically
    const depth = Math.max(1, (id.match(/\//g) || []).length + 1);
    const baseRadius = HUB_RADIUS_BY_LOD[lod] || 16;
    const sizeBonus = Math.min(6, Math.log10(Math.max(1, noteCount)) * 3);
    const radius = Math.max(4, baseRadius - (depth - 1) * 2 + sizeBonus);

    const showLabel = lod >= 2;
    const showHover = hovered && lod >= 1;
    const dotSize = radius * 2;

    return (
        <div
            className="flex flex-col items-center group relative transition-all duration-300 ease-out will-change-transform"
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            style={{
                zIndex: isCenter ? 50 : hopTier === 1 ? 40 : hopTier === 2 ? 10 : 1,
                opacity: 1
            }}
        >
            <div
                className="relative rounded-full flex items-center justify-center text-white font-bold transition-all duration-300 ease-out"
                style={{
                    width: dotSize,
                    height: dotSize,
                    backgroundColor: isDimmed ? (isDark ? '#3f3f46' : '#e4e4e7') : baseEnergyColor,
                    transform: isCenter ? 'scale(1.2)' : hovered ? 'scale(1.15)' : 'scale(1)',
                    boxShadow: !isDimmed
                        ? `0 0 ${activeGlowSize}px ${glowColor}, inset 0 0 4px rgba(255,255,255,0.4)`
                        : 'inset 0 0 2px rgba(0,0,0,0.1)',
                }}
            >
            </div>

            {/* Always-on Label at L3 */}
            {showLabel && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 flex flex-col items-center">
                    <div className="px-2 py-0.5 rounded-full bg-white/90 dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 shadow-sm backdrop-blur-md">
                        <span className="text-[12px] font-bold text-zinc-800 dark:text-zinc-100 whitespace-nowrap">
                            {label}
                        </span>
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-zinc-500 whitespace-nowrap">
                        {t('notes_count', { count: noteCount })}
                    </div>
                </div>
            )}

            {/* Hover tooltip structure */}
            {showHover && (
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full
                                bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700
                                rounded-lg shadow-xl px-3 py-2 z-50 min-w-[120px]"
                >
                    <div className="text-[12px] font-bold text-zinc-800 dark:text-zinc-100 truncate">{label}</div>
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        {t('notes_count', { count: noteCount })}
                    </div>
                </div>
            )}

            {/* Add child button (L3+) */}
            {lod >= 3 && (
                <button
                    onClick={handleAddChild}
                    className="absolute -bottom-4 left-1/2 -translate-x-1/2
                               w-5 h-5 rounded-full
                               bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md border border-zinc-200/50 dark:border-zinc-700/50
                               text-zinc-400 hover:text-blue-500 hover:border-blue-300 dark:hover:border-blue-500/50 hover:scale-110
                               hover:shadow-lg
                               flex items-center justify-center
                               opacity-0 group-hover:opacity-100 transition-all duration-200
                               shadow-md z-10"
                    title={t('graph.create_in_dir')}
                >
                    <Plus size={12} strokeWidth={2.5} />
                </button>
            )}

            <Handle type="target" position={Position.Top} isConnectable={false} className="w-0! h-0! border-none! opacity-0" />
            <Handle type="source" position={Position.Bottom} isConnectable={false} className="w-0! h-0! border-none! opacity-0" />
        </div>
    );
}

export const FolderNode = memo(FolderNodeComponent);
