import { memo } from 'react';
import {
    BaseEdge,
    EdgeLabelRenderer,
    getSmoothStepPath,
    Position,
    useInternalNode,
    useStore,
    type EdgeProps,
} from '@xyflow/react';
import type { KnowledgeEdgeData } from '../types';
import { CATEGORY_COLORS, EDGE_TIER_COLORS, EDGE_TIER_COLORS_DARK } from '../constants';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useTranslation } from 'react-i18next';

function generateArc(id: string, sx: number, sy: number, tx: number, ty: number, arcType: 'structural' | 'relational' | 'archive_structural' = 'relational') {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
    }
    // Random bend factor
    const rand = (Math.abs(hash) % 100) / 100;
    
    // Determine bend multiplier based on layout type
    let bendMultiplier = 0.6; // Core neural jump
    if (arcType === 'structural') bendMultiplier = 0.15; // Elegant sweep
    if (arcType === 'archive_structural') bendMultiplier = 0; // Straight line (spoke mode)
    
    let bend = (rand - 0.5) * bendMultiplier; 
    
    // Ensure minimum curvature only if we intend to bend at all
    if (bendMultiplier !== 0) {
        if (Math.abs(bend) < 0.05) bend = bend < 0 ? -0.05 : 0.05; 
    }

    // Midpoint
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    // Difference
    const dx = tx - sx;
    const dy = ty - sy;

    // Perpendicular vector (normal)
    const nx = -dy;
    const ny = dx;

    // Control point offset from midpoint
    const cx = mx + nx * bend;
    const cy = my + ny * bend;

    const path = `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`;

    // Quadratic Bezier at t=0.5
    const labelX = 0.25 * sx + 0.5 * cx + 0.25 * tx;
    const labelY = 0.25 * sy + 0.5 * cy + 0.25 * ty;

    return [path, labelX, labelY] as const;
}

function RelationEdgeComponent({
    id,
    source, target,
    sourceX, sourceY,
    targetX, targetY,
    data,
    markerEnd,
}: EdgeProps & { data?: KnowledgeEdgeData }) {
    // DIAGNOSTIC: verify this component renders
    // Removed render log
    // Read zoom (for inverse-scale logic)
    const zoom = useStore((s) => s.transform[2]);
    const sourceNode = useInternalNode(source);
    const targetNode = useInternalNode(target);
    const { t } = useTranslation();
    
    const label = data?.label || null;
    const linkType = data?.linkType || 'explicit';
    const isStructural = linkType === 'structural';
    const isSourceFolder = sourceNode?.data?.nodeType === 'folder';
    const isTargetFolder = targetNode?.data?.nodeType === 'folder';
    const isFolderToFolder = isStructural && isSourceFolder && isTargetFolder;
    
    const hopTier = (data?.hopTier ?? 1) as number;
    const flowReversed = !!data?.flowReversed;
    const tierIdx = Math.max(0, Math.min(2, hopTier - 1));


    const { theme } = useTheme();
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const sourceCategory = sourceNode?.data?.category as string | undefined;
    const tierPalette = isDark ? EDGE_TIER_COLORS_DARK : EDGE_TIER_COLORS;
    const categoryTiers = sourceCategory ? (tierPalette[sourceCategory] || tierPalette.resource) : tierPalette.resource;
    
    // Structural: Neutral dim background color, no glowing drop-shadow
    // Relational: Brand tier color of the source node. When ultra-zoomed (LOD 0), use the pure solid category color 
    // so lines don't appear washed out entirely. (Because the user complained the color is too dim/pastel).
    const edgeStrokeColor = (zoom < 0.4) ? (CATEGORY_COLORS[sourceCategory || 'resource'] || categoryTiers[tierIdx]) : categoryTiers[tierIdx];

    // Maintain a max visual thickness when zoomed in past 100% (so lines don't become massive tubes)
    // At zoom < 1, lines scale down naturally to save clutter. At zoom > 1, they stop getting thicker!
    const inverseZoomScale = zoom > 1 ? (1 / zoom) : 1;
    
    // Scale down all lines to make L3 strictly sleeker and more "Apple-like"
    const baseWidth = isStructural ? (isFolderToFolder ? 2 : 1.5) : 1;
    const edgeStrokeWidth = baseWidth * inverseZoomScale;

    // Compute node centers directly from absolute position + measured size
    const sPos = sourceNode?.internals?.positionAbsolute;
    const sW = sourceNode?.measured?.width || 0;
    const sH = sourceNode?.measured?.height || 0;
    const sx = sPos ? sPos.x + sW / 2 : sourceX;
    const sy = sPos ? sPos.y + sH / 2 : sourceY;

    const tPos = targetNode?.internals?.positionAbsolute;
    const tW = targetNode?.measured?.width || 0;
    const tH = targetNode?.measured?.height || 0;
    const tx = tPos ? tPos.x + tW / 2 : targetX;
    const ty = tPos ? tPos.y + tH / 2 : targetY;

    let edgePath, labelX, labelY;
    if (isStructural) {
        if (sourceCategory === 'project') {
            const pathData = getSmoothStepPath({
                sourceX: sourceX,
                sourceY: sourceY,
                targetX: targetX,
                targetY: targetY,
                sourcePosition: Position.Bottom,
                targetPosition: Position.Top,
                borderRadius: 16,
            });
            edgePath = pathData[0];
            labelX = pathData[1];
            labelY = pathData[2];
        } else {
            const arcType = sourceCategory === 'archive' ? 'archive_structural' : 'structural';
            const pathData = generateArc(id, sx, sy, tx, ty, arcType);
            edgePath = pathData[0];
            labelX = pathData[1];
            labelY = pathData[2];
        }
    } else {
        const pathData = generateArc(id, sx, sy, tx, ty, 'relational');
        edgePath = pathData[0];
        labelX = pathData[1];
        labelY = pathData[2];
    }
    // Apply Inversion of Contrast principle
    const glowColor = isDark ? '#ffffff' : '#18181b';
    const flowOpacity = hopTier === 1 ? (isDark ? 0.35 : 0.45) : (isDark ? 0.25 : 0.25);
    const animationClass = flowReversed ? 'edge-liquid-reverse' : 'edge-liquid-forward';

    return (
        <>
            {/* Base Edge — hover styling handled by CSS (.edge-relational:hover) */}
            <BaseEdge
                id={id}
                path={edgePath}
                interactionWidth={20}
                style={{
                    stroke: edgeStrokeColor,
                    strokeWidth: edgeStrokeWidth,
                    filter: !isStructural && hopTier === 1 ? `drop-shadow(0 0 6px ${edgeStrokeColor}80)` : undefined,
                    strokeDasharray: isStructural ? undefined : (linkType === 'ghost' ? '2 4' : '4 6'),
                    opacity: hopTier === 1 ? (isStructural ? 0.8 : 1) : hopTier === 2 ? 0.8 : 0.6,
                    transition: 'stroke 0.2s ease, stroke-width 0.2s ease, filter 0.2s ease',
                }}
                markerEnd={isStructural ? undefined : markerEnd}
            />
            
            {/* Liquid Flow Stream (Silent, Premium, Blurry Pulse) - Only for Relational jumps */}
            {!isStructural && (hopTier === 1 || hopTier === 2) && (
                <path
                    d={edgePath}
                    className={`react-flow__edge-path pointer-events-none ${animationClass}`}
                    style={{
                        stroke: glowColor,
                        strokeWidth: edgeStrokeWidth * 1.5,
                        strokeLinecap: 'round',
                        strokeDasharray: '30 90',
                        opacity: flowOpacity,
                        filter: 'blur(2px)',
                    }}
                    pathLength={100}
                />
            )}
            {label && !isStructural && (
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                            pointerEvents: 'all',
                        }}
                        className="nodrag nopan"
                    >
                        <span
                            className="edge-relation-pill text-[10px] px-2.5 py-[3px] rounded-full whitespace-nowrap cursor-pointer
                                       border transition-all duration-150 hover:scale-105 hover:bg-blue-500 hover:text-white"
                            style={{
                                background: isDark ? 'rgba(24, 24, 27, 0.75)' : 'rgba(255, 255, 255, 0.85)',
                                backdropFilter: 'blur(8px)',
                                WebkitBackdropFilter: 'blur(8px)',
                                color: edgeStrokeColor,
                                fontWeight: 700,
                                borderColor: `${edgeStrokeColor}40`,
                                boxShadow: `0 4px 12px rgba(0,0,0, ${isDark ? 0.3 : 0.05})`,
                            }}
                            data-edge-id={id}
                        >
                            {linkType === 'ghost' ? t('graph.ai_inferred', '✨ AI Inferred') : t(`relations.${label}`, label)}
                        </span>
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

export const RelationEdge = memo(RelationEdgeComponent);

