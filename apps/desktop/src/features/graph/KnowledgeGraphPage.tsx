/**
 * KnowledgeGraphPage — Full-screen bidirectional knowledge graph
 *
 * Features:
 * - ReactFlow canvas with custom NoteNode and RelationEdge
 * - Double-click to create new note nodes
 * - Drag from handle to create edges
 * - Click node to navigate to note
 * - Node expand/collapse
 * - Dot-grid background for "knowledge network" aesthetic
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Focus } from 'lucide-react';
import { getParentPath } from '@/shared/utils/pathUtils';
import {
    ReactFlow,
    useNodesState,
    useEdgesState,
    addEdge,
    useReactFlow,
    ReactFlowProvider,

    Panel,
    useStore,
    type Node,
    type Edge,
    type NodeMouseHandler,
    type NodeChange
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';
// import { GhostLinkPanel } from './GhostLinkPanel';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';


import { useFileSystemStore } from '@/core/fs/store';
import { FileSystemNoteRepository } from '@/core/storage/FileSystemNoteRepository';
import { getRelativePath } from '@/shared/utils/pathUtils';
import { useGraphData, type MapLayout, type ZoneBounds } from './hooks/useGraphData';

import type { KnowledgeGraphPageProps, KnowledgeNodeData, KnowledgeEdgeData } from './types';
import { NoteNode } from './components/NoteNode';
import { FolderNode } from './components/FolderNode';
import { RelationSelectorPopup } from '@/shared/components/RelationSelectorPopup';
import { NewNodeInputPopup } from './components/NewNodeInputPopup';
import { RelationEdge } from './components/RelationEdge';

// CATEGORY_COLORS used by ZoneDividerNode internally

import { LODContext, zoomToLOD, useLOD } from './hooks/useLOD';
import { HoveredEdgeContext } from './hooks/useHoveredEdge';
import { taskService } from '@/features/kanban/taskService';

// Register custom node/edge types
const nodeTypes = { noteNode: NoteNode, folderNode: FolderNode };
const edgeTypes = { relationEdge: RelationEdge };

// ============================================================================
// Main Graph Component (inside ReactFlowProvider)
// ============================================================================

function ZoomDebugger() {
    const zoom = useStore((s) => s.transform[2]);
    const lod = useLOD();
    const lText = lod === 0 ? '0 (Ultra-far)' : lod === 1 ? '1 (Far)' : lod === 2 ? '2 (Mid)' : '3 (Near)';
    return (
        <div className="px-3 py-1 rounded bg-black/60 text-white text-[10px] font-mono backdrop-blur-sm pointer-events-none transition-none shadow-md border border-white/10 whitespace-pre">
            LOD: {lText}   |   Zoom: {zoom.toFixed(3)}
        </div>
    );
}

function KnowledgeGraphInner({
    onClose, onNavigate, onFolderClick, refreshKey = 0, isGlobal, notePath
}: KnowledgeGraphPageProps) {
    const { t } = useTranslation();

    const vaultPath = useFileSystemStore(state => state.root?.path);
    const { screenToFlowPosition, setCenter } = useReactFlow();

    // Reset cinematic camera to absolute Red Box center (0,0) at exactly 0.2 zoom on refresh/enter
    useEffect(() => {
        setCenter(0, 0, { zoom: 0.2, duration: 600 });
    }, [refreshKey, setCenter]);

    // Holy Grail Spatial Layout State
    const [graphLayout, setGraphLayout] = useState<MapLayout>({
        w: 4000,
        h: 3000,
        yTop: 1000,
        yBot: 2750,
        xLeft: 1300,
        xRight: 2700
    });

    // Listen to physical viewport boundaries from ReactFlow
    const vpWidth = useStore(s => s.width);
    const vpHeight = useStore(s => s.height);

    // CRITICAL: Dynamically calculate optimal layout bounds so at minZoom=0.20 the boundaries map absolutely exactly to the element edges
    useEffect(() => {
        if (vpWidth > 0 && vpHeight > 0) {
            // Because minZoom is 0.2, the logical span needed to cover the physical width is width / 0.2
            const w = vpWidth / 0.2;
            const h = vpHeight / 0.2;
            
            // To prevent micro-bouncing during resizing, we only apply if change is > 10 pixels
            if (Math.abs(graphLayout.w - w) > 10 || Math.abs(graphLayout.h - h) > 10) {
                setGraphLayout({
                    w, h,
                    yTop: h * 0.33,
                    yBot: h * 0.92,
                    xLeft: w * 0.33,
                    xRight: w * 0.66
                });
            }
        }
    }, [vpWidth, vpHeight, graphLayout.w, graphLayout.h]);

    // LOD (Level of Detail) zoom tracking
    const [lod, setLod] = useState(2);
    const lodRef = useRef(2);
    
    const handleViewportChange = useCallback(({ zoom }: { zoom: number }) => {
        const newLod = zoomToLOD(zoom);
        if (newLod !== lodRef.current) {
            // console.log removed
            lodRef.current = newLod;
            setLod(newLod);
        }
    }, []);

    // Graph data from backend
    const { nodes: initialNodes, edges: initialEdges, zoneBoundsMap, loading, errorMsg } = useGraphData({
        mode: isGlobal ? 'global' : 'local',
        vaultPath,
        notePath,
        refreshKey,
        layout: graphLayout
    });

    // ─── Content-Aware Adaptive Layout ───────────────────────────────────
    // Derives zone divider positions from actual node cluster bounding boxes
    // with padding, clamping, and smooth lerp interpolation.
    const ZONE_PAD = 150; // Breathing room around node clusters
    const MIN_ZONE_SIZE = 400; // Minimum zone dimension

    const adaptiveLayoutRef = useRef<MapLayout | null>(null);

    const adaptiveLayout = useMemo(() => {
        const L = graphLayout; // base layout (viewport-derived)
        const CX = L.w / 2;
        const CY = L.h / 2;
        const cats = ['project', 'inbox', 'resource', 'area', 'archive'] as const;
        const hasBounds = cats.some(c => zoneBoundsMap[c]);
        if (!hasBounds) return L;

        // Helper: get zone bounds in SVG space (0-based, not ReactFlow-centered)
        const toSVG = (zb: ZoneBounds) => ({
            minX: zb.minX + CX, maxX: zb.maxX + CX,
            minY: zb.minY + CY, maxY: zb.maxY + CY,
        });

        const projB = zoneBoundsMap.project ? toSVG(zoneBoundsMap.project) : null;
        const inboxB = zoneBoundsMap.inbox ? toSVG(zoneBoundsMap.inbox) : null;
        const resB = zoneBoundsMap.resource ? toSVG(zoneBoundsMap.resource) : null;
        const areaB = zoneBoundsMap.area ? toSVG(zoneBoundsMap.area) : null;
        const archB = zoneBoundsMap.archive ? toSVG(zoneBoundsMap.archive) : null;

        // yTop: bottom of projects / top of middle row
        // Take the max of (project cluster bottom + pad) and ensure middle row has min height
        const projBottom = projB ? projB.maxY + ZONE_PAD : L.h * 0.15;
        const middleTopFromRes = resB ? resB.minY - ZONE_PAD : L.h * 0.33;
        const middleTopFromArea = areaB ? areaB.minY - ZONE_PAD : L.h * 0.33;
        const middleTopFromArch = archB ? archB.minY - ZONE_PAD : L.h * 0.33;
        const middleTopMin = Math.min(middleTopFromRes, middleTopFromArea, middleTopFromArch);
        const yTop = Math.max(MIN_ZONE_SIZE, Math.min(projBottom, middleTopMin, L.h * 0.45));

        // yBot: bottom of middle row / top of inbox
        const inboxTop = inboxB ? inboxB.minY - ZONE_PAD : L.h * 0.85;
        const middleBotFromRes = resB ? resB.maxY + ZONE_PAD : L.h * 0.66;
        const middleBotFromArea = areaB ? areaB.maxY + ZONE_PAD : L.h * 0.66;
        const middleBotFromArch = archB ? archB.maxY + ZONE_PAD : L.h * 0.66;
        const middleBotMax = Math.max(middleBotFromRes, middleBotFromArea, middleBotFromArch);
        const yBot = Math.min(L.h - MIN_ZONE_SIZE, Math.max(middleBotMax, inboxTop, yTop + MIN_ZONE_SIZE));

        // xLeft: right edge of resources / left edge of area
        const resRight = resB ? resB.maxX + ZONE_PAD : L.w * 0.2;
        const areaLeft = areaB ? areaB.minX - ZONE_PAD : L.w * 0.33;
        const xLeft = Math.max(MIN_ZONE_SIZE, Math.min(resRight, areaLeft, L.w * 0.45));

        // xRight: right edge of area / left edge of archive
        const areaRight = areaB ? areaB.maxX + ZONE_PAD : L.w * 0.66;
        const archLeft = archB ? archB.minX - ZONE_PAD : L.w * 0.8;
        const xRight = Math.min(L.w - MIN_ZONE_SIZE, Math.max(areaRight, archLeft, xLeft + MIN_ZONE_SIZE));

        const target: MapLayout = { w: L.w, h: L.h, yTop, yBot, xLeft, xRight };

        // Lerp smoothing: blend previous frame toward target
        const prev = adaptiveLayoutRef.current;
        if (!prev || prev.w !== L.w || prev.h !== L.h) {
            // First frame or viewport resize — snap immediately
            adaptiveLayoutRef.current = target;
            return target;
        }

        const alpha = 0.15; // Smoothing factor (0 = no move, 1 = instant snap)
        const lerp = (a: number, b: number) => a + (b - a) * alpha;
        const smoothed: MapLayout = {
            w: L.w, h: L.h,
            yTop: lerp(prev.yTop, target.yTop),
            yBot: lerp(prev.yBot, target.yBot),
            xLeft: lerp(prev.xLeft, target.xLeft),
            xRight: lerp(prev.xRight, target.xRight),
        };
        adaptiveLayoutRef.current = smoothed;
        return smoothed;
    }, [graphLayout, zoneBoundsMap]);

    const [nodes, setNodes, onNodesChange] = useNodesState<Node<KnowledgeNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<KnowledgeEdgeData>>([]);

    // Inject task progress into Project folder nodes
    useEffect(() => {
        if (!initialNodes || initialNodes.length === 0) return;
        const projectFolders = initialNodes.filter(
            n => n.type === 'folderNode' && (n.data as KnowledgeNodeData).category === 'project'
        );
        if (projectFolders.length === 0) return;

        (async () => {
            try {
                const allTasks = await taskService.getTasks();
                setNodes(prev => prev.map(n => {
                    if (n.type !== 'folderNode' || (n.data as KnowledgeNodeData).category !== 'project') return n;
                    const folderPath = n.id;
                    const folderTasks = allTasks.filter(t => t.note_path.startsWith(folderPath));
                    const done = folderTasks.filter(t => t.is_completed).length;
                    const total = folderTasks.length;
                    return { ...n, data: { ...n.data, taskProgress: { done, total } } };
                }));
            } catch (err) {
                console.warn('Failed to load tasks for project rings', err);
            }
        })();
    }, [initialNodes, setNodes]);

    // Strict box collision interceptor for dragging
    const handleNodesChangeWithCollision = useCallback(
        (changes: NodeChange<Node<KnowledgeNodeData>>[]) => {
            const isPositionChange = changes.some(c => c.type === 'position' && c.dragging && (c.position || c.positionAbsolute));
            if (!isPositionChange) {
                onNodesChange(changes);
                return;
            }

            const GAP = 5; // Reduced visual padding

            const checkAABB = (r1: {x: number, y: number, w: number, h: number}, r2: {x: number, y: number, w: number, h: number}) => {
                return r1.x < r2.x + r2.w &&
                       r1.x + r1.w > r2.x &&
                       r1.y < r2.y + r2.h &&
                       r1.y + r1.h > r2.y;
            };

            // Setup a mutable position map for the frame to compute chain reactions
            const posMap = new Map<string, {x: number, y: number, w: number, h: number, isDragged: boolean}>();
            
            nodes.forEach(n => {
                 if (n.type === 'zoneDividerNode') return;
                 const w = n.measured?.width ?? 200;
                 const h = n.measured?.height ?? 60;
                 posMap.set(n.id, { x: n.position.x, y: n.position.y, w, h, isDragged: false });
            });

            // Apply the dragging attempts
            changes.forEach(change => {
                 if (change.type === 'position' && change.dragging && (change.position || change.positionAbsolute)) {
                      const targetX = change.position?.x ?? change.positionAbsolute?.x;
                      const targetY = change.position?.y ?? change.positionAbsolute?.y;
                      const rect = posMap.get(change.id);
                      if (rect && targetX !== undefined && targetY !== undefined) {
                           rect.x = targetX;
                           rect.y = targetY;
                           rect.isDragged = true;
                      }
                 }
            });

            // Iteratively resolve collisions (Sweep and push) for multi-body chain reactions
            const ITERATIONS = 3;
            const nodeIds = Array.from(posMap.keys());
            
            for (let iter = 0; iter < ITERATIONS; iter++) {
                 for (let i = 0; i < nodeIds.length; i++) {
                     for (let j = i + 1; j < nodeIds.length; j++) {
                          const idA = nodeIds[i];
                          const idB = nodeIds[j];
                          const rectA = posMap.get(idA)!;
                          const rectB = posMap.get(idB)!;

                          const rxA = { x: rectA.x, y: rectA.y, w: rectA.w + GAP, h: rectA.h + GAP };
                          const rxB = { x: rectB.x, y: rectB.y, w: rectB.w + GAP, h: rectB.h + GAP };

                          if (checkAABB(rxA, rxB)) {
                               const dx = (rxB.x + rxB.w / 2) - (rxA.x + rxA.w / 2);
                               const dy = (rxB.y + rxB.h / 2) - (rxA.y + rxA.h / 2);

                               const intersectX = (rxA.w / 2 + rxB.w / 2) - Math.abs(dx);
                               const intersectY = (rxA.h / 2 + rxB.h / 2) - Math.abs(dy);

                               let pushX = 0, pushY = 0;
                               if (intersectX < intersectY) {
                                   pushX = dx > 0 ? (intersectX + 1) : -(intersectX + 1); // Add +1 to fully escape float overlap
                               } else {
                                   pushY = dy > 0 ? (intersectY + 1) : -(intersectY + 1);
                               }

                               // If A is dragged and B is not, B absorbs 100% of the push.
                               // If both are not dragged, they each absorb 50%.
                               if (rectA.isDragged && !rectB.isDragged) {
                                   rectB.x += pushX;
                                   rectB.y += pushY;
                               } else if (!rectA.isDragged && rectB.isDragged) {
                                   rectA.x -= pushX;
                                   rectA.y -= pushY;
                               } else if (!rectA.isDragged && !rectB.isDragged) {
                                   rectA.x -= pushX / 2;
                                   rectA.y -= pushY / 2;
                                   rectB.x += pushX / 2;
                                   rectB.y += pushY / 2;
                               }
                          }
                     }
                 }
            }

            const safeChanges = [...changes];
            
            nodes.forEach(n => {
                 if (n.type === 'zoneDividerNode') return;
                 const resolved = posMap.get(n.id);
                 if (!resolved || resolved.isDragged) return;

                 // Only update static nodes that were pushed
                 if (Math.abs(resolved.x - n.position.x) > 0.5 || Math.abs(resolved.y - n.position.y) > 0.5) {
                      safeChanges.push({
                           type: 'position',
                           id: n.id,
                           position: { x: resolved.x, y: resolved.y }
                      } as NodeChange<Node<KnowledgeNodeData>>);
                 }
            });

            onNodesChange(safeChanges);
        },
        [nodes, onNodesChange]
    );

    // Popover states
    const [newNodeInput, setNewNodeInput] = useState<{
        position: { x: number; y: number };
        flowPosition: { x: number; y: number };
        parentNodeId?: string;  // If creating a child node
        initialFolder: string;
    } | null>(null);

    const root = useFileSystemStore(state => state.root);

    // Build list of all folders
    const folders = useMemo(() => {
        const result: string[] = ['00_Inbox'];
        if (!root) return result;
        const traverse = (node: any) => {
            if (node.type === 'folder' && node.path !== root.path) {
                const rel = getRelativePath(node.path, root.path).replace(/\\/g, '/');
                if (!result.includes(rel)) result.push(rel);
            }
            if (node.children) node.children.forEach(traverse);
        };
        root.children?.forEach(traverse);
        return result.sort((a, b) => a.localeCompare(b));
    }, [root]);
    const [relationSelector, setRelationSelector] = useState<{
        position: { x: number; y: number };
        sourceId: string;
        targetId: string;
        initialRelation?: string;
    } | null>(null);

    // Edge hover tracking (ReactFlow-level, not per-component)
    const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

    // Collapsed nodes tracking
    const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

    // Node hover tracking for high-z-index elevation
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

    useEffect(() => {
        const handler = (e: Event) => {
            const { nodeId, hovered } = (e as CustomEvent).detail;
            setHoveredNodeId(hovered ? nodeId : null);
        };
        window.addEventListener('graph:node-hover', handler);
        return () => window.removeEventListener('graph:node-hover', handler);
    }, []);

    useEffect(() => {
        setNodes(initialNodes as Node<KnowledgeNodeData>[]);
        setEdges(initialEdges);
    }, [isGlobal, initialNodes, initialEdges, setNodes, setEdges]);

    // Listen for collapse toggle events from NoteNode
    useEffect(() => {
        const handler = (e: Event) => {
            const nodeId = (e as CustomEvent).detail.nodeId;
            setCollapsedNodes(prev => {
                const next = new Set(prev);
                if (next.has(nodeId)) {
                    next.delete(nodeId);
                } else {
                    next.add(nodeId);
                }
                return next;
            });
        };
        window.addEventListener('graph:toggle-collapse', handler);
        return () => window.removeEventListener('graph:toggle-collapse', handler);
    }, []);

    // Apply collapse: hide nodes connected to collapsed parents
    const visibleNodes = useMemo(() => {
        if (collapsedNodes.size === 0) return nodes;

        // Build parent→children map from structural edges
        const childrenOf = new Map<string, Set<string>>();
        for (const edge of edges) {
            if (edge.data?.linkType === 'structural') {
                if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, new Set());
                childrenOf.get(edge.source)!.add(edge.target);
            }
        }

        // Recursively collect hidden nodes
        const hidden = new Set<string>();
        function hideChildren(parentId: string) {
            const children = childrenOf.get(parentId);
            if (!children) return;
            for (const childId of children) {
                hidden.add(childId);
                hideChildren(childId);
            }
        }
        for (const collapsedId of collapsedNodes) {
            hideChildren(collapsedId);
        }

        return nodes
            .filter(n => !hidden.has(n.id))
            .map(n => ({
                ...n,
                data: {
                    ...n.data,
                    collapsed: collapsedNodes.has(n.id),
                },
            }));
    }, [nodes, edges, collapsedNodes]);

    const visibleEdges = useMemo(() => {
        const visibleIds = new Set(visibleNodes.map(n => n.id));
        return edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
    }, [edges, visibleNodes]);

    // --- Focus Mode Interactions ---
    const focusedNodeId = useMemo(() => visibleNodes.find(n => n.selected)?.id || null, [visibleNodes]);

    const focusContext = useMemo(() => {
        if (!focusedNodeId) return null;

        const linkedNodeIds = new Set<string>();
        const twoHopNodeIds = new Set<string>();

        // Find 1-hop
        visibleEdges.forEach(e => {
            if (e.source === focusedNodeId) linkedNodeIds.add(e.target);
            if (e.target === focusedNodeId) linkedNodeIds.add(e.source);
        });

        // Find 2-hop
        visibleEdges.forEach(e => {
            if (linkedNodeIds.has(e.source) && e.target !== focusedNodeId) twoHopNodeIds.add(e.target);
            if (linkedNodeIds.has(e.target) && e.source !== focusedNodeId) twoHopNodeIds.add(e.source);
        });

        return {
            focused: focusedNodeId,
            linked: linkedNodeIds,
            twoHop: twoHopNodeIds,
        };
    }, [focusedNodeId, visibleEdges]);

    const renderedNodes = useMemo(() => {
        if (!focusContext) return visibleNodes.map(n => {
            if (n.type === 'zoneDividerNode') {
                return { ...n, data: { ...n.data, layout: adaptiveLayout } } as Node<KnowledgeNodeData>;
            }
            // No selection → all nodes at tier 3 (unselected)
            return { 
                ...n, 
                zIndex: n.id === hoveredNodeId ? 99999 : undefined,
                data: { ...n.data, hopTier: 3 } 
            } as Node<KnowledgeNodeData>;
        });

        // Performance guardrail (dynamic degrade) could be added here in the future

        return visibleNodes.map(n => {
            if (n.type === 'zoneDividerNode') {
                return { ...n, data: { ...n.data, layout: adaptiveLayout } } as Node<KnowledgeNodeData>;
            }
            const isSelf = n.id === focusContext.focused;
            const is1Hop = focusContext.linked.has(n.id);
            const is2Hop = focusContext.twoHop.has(n.id) && !is1Hop && !isSelf;

            // Tier 1: selected + 1-hop, Tier 2: 2-hop, Tier 3: beyond
            const hopTier = (isSelf || is1Hop) ? 1 : is2Hop ? 2 : 3;

            return {
                ...n,
                zIndex: n.id === hoveredNodeId ? 99999 : (isSelf ? 1000 : undefined),
                data: { ...n.data, hopTier, isCenter: isSelf },
            } as Node<KnowledgeNodeData>;
        });
    }, [visibleNodes, focusContext, hoveredNodeId]);

    const renderedEdges = useMemo(() => {
        if (!focusContext) return visibleEdges.map(e => ({
            ...e,
            className: e.data?.linkType !== 'structural' ? 'edge-relational' : undefined,
            data: { ...e.data, hopTier: 3 } as KnowledgeEdgeData,
        }));
        return visibleEdges.map(e => {
            const isConnected = e.source === focusContext.focused || e.target === focusContext.focused;
            const is1HopToFocused = isConnected;
            // 2-hop edge: at least one end is directly connected to the focused node (i.e. is on the 1-hop list)
            const is2HopConnected = focusContext.linked.has(e.source) || focusContext.linked.has(e.target);

            // Tier 1: directly connected to selected, Tier 2: connected to 1-hop nodes, Tier 3: beyond
            const hopTier = is1HopToFocused ? 1 : is2HopConnected ? 2 : 3;

            // Determine outward flow direction (from center hub outwards)
            const dSource = focusContext.focused === e.source ? 0 : focusContext.linked.has(e.source) ? 1 : 2;
            const dTarget = focusContext.focused === e.target ? 0 : focusContext.linked.has(e.target) ? 1 : 2;
            const flowReversed = dTarget < dSource;

            return {
                ...e,
                className: e.data?.linkType !== 'structural' ? 'edge-relational' : undefined,
                data: { ...e.data, hopTier, flowReversed } as KnowledgeEdgeData,
            };
        });
    }, [visibleEdges, focusContext]);

    // --- Interaction handlers ---
    const handleEdgeMouseEnter = useCallback((_event: React.MouseEvent, edge: Edge<KnowledgeEdgeData>) => {
        if (edge.data?.linkType !== 'structural') {
            setHoveredEdgeId(edge.id);
        }
    }, []);
    const handleEdgeMouseLeave = useCallback(() => {
        setHoveredEdgeId(null);
    }, []);

    const handleEdgeDoubleClick = useCallback((event: React.MouseEvent, edge: Edge<KnowledgeEdgeData>) => {
        if (edge.data?.linkType !== 'structural') {
            setRelationSelector({
                position: { x: event.clientX, y: event.clientY },
                sourceId: edge.source,
                targetId: edge.target,
                initialRelation: edge.data?.label || '',
            });
        }
    }, []);

    // Single click node → select only (no navigation)
    const handleNodeClick: NodeMouseHandler<Node<KnowledgeNodeData>> = useCallback((_event, _node) => {
        // Single click only selects the node (ReactFlow default behavior)
        // Navigation happens on double-click
    }, []);

    const handlePaneDoubleClick = useCallback((event: React.MouseEvent) => {
        // Only trigger if clicking on the pane itself (not on a node or edge)
        const target = event.target as HTMLElement;
        if (target.closest('.react-flow__node') && !target.closest('[data-id="graph-dividers"]')) return;
        if (target.closest('.react-flow__edge')) return;
        
        // Ensure the popover doesn't overflow off-screen, considering max dropdown height
        const safeX = Math.min(Math.max(20, event.clientX), window.innerWidth - 280);
        const safeY = Math.min(Math.max(20, event.clientY), window.innerHeight - 340);
        
        const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        setNewNodeInput({ position: { x: safeX, y: safeY }, flowPosition: flowPos, initialFolder: '00_Inbox' });
    }, [screenToFlowPosition]);

    // Double-click node → navigate to note
    const handleNodeDoubleClick: NodeMouseHandler<Node<KnowledgeNodeData>> = useCallback((event, node) => {
        // Prevent opening zone divider node (treat as empty canvas double-click)
        if (node.id === 'graph-dividers' || node.type === 'zoneDividerNode') {
            handlePaneDoubleClick(event as any);
            return;
        }
        if (!node.data) return;
        if (node.data.isNew) return; // Don't navigate to draft nodes
        if (node.data.nodeType === 'folder') {
            onFolderClick?.(node.id, node.data.label);
        } else {
            onNavigate?.(node.id);
        }
        onClose();
    }, [onNavigate, onFolderClick, onClose, handlePaneDoubleClick]);

    // Listen for "add child node" events from NoteNode's + button
    useEffect(() => {
        const handler = (e: Event) => {
            const { nodeId, isFolder, screenX, screenY } = (e as CustomEvent).detail;
            const flowPos = screenToFlowPosition({ x: screenX, y: screenY + 80 });

            // Default to parent node's directory, or Inbox
            let defaultFolder = '00_Inbox';
            if (isFolder) {
                defaultFolder = nodeId; // Folder node ID is the folder itself
            } else {
                const parentPath = getParentPath(nodeId);
                if (parentPath) {
                    defaultFolder = parentPath; // Note node ID needs the path component
                }
            }

            // Ensure the popover doesn't overflow off-screen, considering max dropdown height
            const safeX = Math.min(Math.max(20, screenX), window.innerWidth - 280);
            const safeY = Math.min(Math.max(20, screenY), window.innerHeight - 340);

            setNewNodeInput({
                position: { x: safeX, y: safeY },
                flowPosition: flowPos,
                parentNodeId: nodeId,
                initialFolder: defaultFolder,
            });
        };
        window.addEventListener('graph:add-child-node', handler);
        return () => window.removeEventListener('graph:add-child-node', handler);
    }, [screenToFlowPosition]);

    // Submit new node (standalone or child)
    const handleCreateNode = useCallback(async (title: string, folder: string, relation?: string) => {
        if (!newNodeInput || !vaultPath) return;
        const flowPos = newNodeInput.flowPosition;
        const parentNodeId = newNodeInput.parentNodeId;
        setNewNodeInput(null);

        try {
            // Create note using the standard repository to ensure metadata and database logic run correctly
            const repo = new FileSystemNoteRepository(vaultPath);
            const parentDirectory = folder ? `${vaultPath}/${folder}` : `${vaultPath}/00_Inbox`;
            const newNote = await repo.createNote(title, parentDirectory);

            // Compute the relative path, which is used as the node ID
            // Typically looks like "00_Inbox/New Note.md"
            const newNodeId = getRelativePath(newNote.path, vaultPath).replace(/\\/g, '/');

            // Derive category from folder name
            const catLower = folder ? folder.toLowerCase() : '';
            const category = catLower.includes('01_project') ? 'project' :
                             catLower.includes('02_area') ? 'area' :
                             catLower.includes('03_resource') ? 'resource' :
                             catLower.includes('04_archive') ? 'archive' : 'inbox';

            // Add node at click position
            const newNode: Node<KnowledgeNodeData> = {
                id: newNodeId,
                type: 'noteNode',
                position: flowPos,
                data: {
                    label: title,
                    tags: [],
                    category, // Set dynamically instead of hardcoded 'inbox'
                    exists: true,
                    isCenter: false,
                    inDegree: 0,
                    nodeType: 'note',
                    noteCount: 0,
                    summary: null,
                    isNew: false, // Node has been saved to filesystem, should render fully
                    notePath: newNodeId,
                },
            };
            setNodes(nds => [...nds, newNode]);

            // Auto-create relations and appropriate edges
            if (parentNodeId) {
                const isParentNote = parentNodeId.endsWith('.md');
                if (isParentNote) {
                    if (relation) {
                        // Parent is a Note with formal YAML relation requested
                        const newEdge: Edge<KnowledgeEdgeData> = {
                            id: `e-${parentNodeId}-${newNodeId}-child`,
                            source: parentNodeId,
                            target: newNodeId,
                            type: 'relationEdge',
                            data: { label: relation, linkType: 'yaml' },
                        };
                        setEdges(eds => addEdge(newEdge, eds));

                        // Persist YAML relation
                        try {
                            await invoke('add_note_relation', {
                                notePath: parentNodeId,
                                relationType: relation,
                                targetTitle: title,
                                targetPath: newNodeId,
                            });
                            window.dispatchEvent(new CustomEvent('slash:reload-note'));
                        } catch (e) {
                            console.error('[KnowledgeGraph] Failed to add YAML relation:', e);
                            toast.error(`${t('graph.add_link_failed', '添加连线失败')}: ${String(e)}`);
                        }
                    } else {
                        // Pure wikilink outlink without formal YAML relation (e.g. from the + button)
                        const newEdge: Edge<KnowledgeEdgeData> = {
                            id: `e-${parentNodeId}-${newNodeId}-wiki`,
                            source: parentNodeId,
                            target: newNodeId,
                            type: 'relationEdge',
                            data: { label: '', linkType: 'wiki' },
                        };
                        setEdges(eds => addEdge(newEdge, eds));

                        try {
                            const parentNote = await repo.getNote(parentNodeId);
                            if (parentNote) {
                                const body = parentNote.content;
                                const wikilink = `[[${title}]]`;
                                if (!body.includes(wikilink)) {
                                    const sep = body.trim() && !body.endsWith('\n') ? '\n\n' : '';
                                    parentNote.content = body.trimEnd() + sep + wikilink + '\n';
                                    await repo.saveNote(parentNote);
                                    window.dispatchEvent(new CustomEvent('slash:reload-note'));
                                }
                            }
                        } catch (e) {
                            console.error('[KnowledgeGraph] Failed to append wikilink:', e);
                            toast.error(`${t('graph.add_wikilink_failed', '添加 Wikilink 失败')}: ${String(e)}`);
                        }
                    }
                } else {
                    // Parent is a Folder: Structural edge
                    const newEdge: Edge<KnowledgeEdgeData> = {
                        id: `e-${parentNodeId}-${newNodeId}-struct`,
                        source: parentNodeId,
                        target: newNodeId,
                        type: 'relationEdge',
                        data: { label: '', linkType: 'structural' },
                    };
                    setEdges(eds => addEdge(newEdge, eds));
                }
            }
        } catch (e) {
            console.error('[KnowledgeGraph] Failed to create note:', e);
            toast.error(`${t('graph.create_note_failed', '创建笔记失败')}: ${String(e)}`);
        }
    }, [newNodeInput, vaultPath, setNodes, setEdges]);

    // Confirm relation for new edge (from edge double-click)
    const handleRelationSelect = useCallback(async (relation: string) => {
        if (!relationSelector || !vaultPath) return;
        const { sourceId, targetId } = relationSelector;
        setRelationSelector(null);

        // Add or Update edge in graph
        setEdges(eds => {
            const existingId = `e-${sourceId}-${targetId}`;
            const existingAltId = `e-${sourceId}-${targetId}-new`;
            const existingChildId = `e-${sourceId}-${targetId}-child`;
            const existing = eds.find(e => e.id === existingId || e.id === existingAltId || e.id === existingChildId || (e.source === sourceId && e.target === targetId));
            
            if (existing) {
                return eds.map(e => e.id === existing.id ? { ...e, data: e.data ? { ...e.data, label: relation } : { label: relation, linkType: 'yaml' } } : e);
            } else {
                const newEdge: Edge<KnowledgeEdgeData> = {
                    id: `e-${sourceId}-${targetId}-new`,
                    source: sourceId,
                    target: targetId,
                    type: 'relationEdge',
                    data: { label: relation, linkType: 'yaml' },
                };
                return addEdge(newEdge, eds);
            }
        });

        // Persist to YAML frontmatter
        try {
            const targetNode = nodes.find(n => n.id === targetId);
            const targetTitle = targetNode?.data?.label || targetId;
            await invoke('add_note_relation', {
                notePath: sourceId,
                relationType: relation,
                targetTitle,
                targetPath: targetId,
            });
            window.dispatchEvent(new CustomEvent('slash:reload-note'));
        } catch (e) {
            console.error('[KnowledgeGraph] Failed to add relation:', e);
            toast.error(`${t('graph.persist_link_failed', '连线持久化失败')}: ${String(e)}`);
        }
    }, [relationSelector, vaultPath, nodes, setEdges]);



    return (
        <div className="absolute inset-0 bg-(--slash-bg-primary)">
            {/* 🛡️ 终极 Stacking Context 提权魔弹：鼠标悬停在整个 Node 容器（含卡片和浮窗）的任何区域，即刻物理锁定 z-index */}
            <style>{`
                .react-flow__node:hover {
                    z-index: 99999 !important;
                }
            `}</style>
            {errorMsg && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 p-6 bg-red-100 text-red-900 border-2 border-red-500 rounded-xl max-w-2xl text-center shadow-2xl">
                    <h2 className="text-xl font-bold mb-4">{t('graph.crash_title', '知识图谱渲染崩溃')} 🚨</h2>
                    <pre className="text-sm text-left whitespace-pre-wrap overflow-auto max-h-96">{errorMsg}</pre>
                </div>
            )}
            {!errorMsg && (
                <>
                    <div className="absolute inset-0 z-40 bg-white dark:bg-[#0D0D0D] flex flex-col pt-8">


                        {/* Graph Canvas */}
                        <div className="flex-1 relative">
                            {loading ? (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="animate-spin rounded-full h-12 w-12 border-2 border-indigo-500 dark:border-blue-400 border-t-transparent dark:border-t-transparent" />
                                </div>
                            ) : (
                                <HoveredEdgeContext.Provider value={hoveredEdgeId}>
                                <LODContext.Provider value={lod}>
                                <ReactFlow
                                    nodes={renderedNodes}
                                    edges={renderedEdges}
                                    onNodesChange={handleNodesChangeWithCollision}
                                    onEdgesChange={onEdgesChange}
                                    onNodeClick={handleNodeClick}
                                    onNodeDoubleClick={handleNodeDoubleClick}
                                    onEdgeMouseEnter={handleEdgeMouseEnter}
                                    onEdgeMouseLeave={handleEdgeMouseLeave}
                                    onEdgeDoubleClick={handleEdgeDoubleClick}
                                    onDoubleClick={handlePaneDoubleClick}
                                    onViewportChange={handleViewportChange}
                                    zoomOnDoubleClick={false}
                                    nodeTypes={nodeTypes}
                                    edgeTypes={edgeTypes}
                                    onInit={(instance) => {
                                        // The Red Box is exactly mapped centrally around (0,0) in logical ReactFlow layout.
                                        instance.setCenter(0, 0, { zoom: 0.2 });
                                    }}
                                    minZoom={0.01}
                                    maxZoom={1.2}
                                    proOptions={{ hideAttribution: true }}
                                    className="bg-transparent!"
                                >



                                    <Panel position="bottom-left" style={{ zIndex: 100, pointerEvents: 'none' }}>
                                        <ZoomDebugger />
                                    </Panel>
                                    <Panel position="bottom-right" style={{ zIndex: 100 }}>
                                        <button
                                            onClick={() => setCenter(0, 0, { zoom: 0.2, duration: 600 })}
                                            className="p-2.5 mb-2 mr-2 rounded-full bg-white dark:bg-zinc-800 shadow-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors group cursor-pointer"
                                            title={t('graph.reset_view', '重置视图 / Reset View')}
                                        >
                                            <Focus className="w-5 h-5 text-zinc-500 dark:text-zinc-400 group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors" />
                                        </button>
                                    </Panel>
                                </ReactFlow>
                                </LODContext.Provider>
                                </HoveredEdgeContext.Provider>
                            )}
                        </div>

                        {/* Popover: New Node Input */}
                        {newNodeInput && (
                            <NewNodeInputPopup
                                position={newNodeInput.position}
                                initialFolder={newNodeInput.initialFolder}
                                folders={folders}
                                showFolderSelect={!newNodeInput.parentNodeId}
                                showRelation={false}
                                onSubmit={handleCreateNode}
                                onCancel={() => setNewNodeInput(null)}
                            />
                        )}

                        {/* Popover: Relation Selector */}
                        {relationSelector && (
                            <RelationSelectorPopup
                                position={relationSelector.position}
                                initialRelation={relationSelector.initialRelation}
                                onSelect={handleRelationSelect}
                                onCancel={() => setRelationSelector(null)}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ============================================================================
// Export with ReactFlowProvider wrapper
// ============================================================================

export const KnowledgeGraphPage = (props: KnowledgeGraphPageProps) => (
    <ReactFlowProvider>
        <KnowledgeGraphInner {...props} />
    </ReactFlowProvider>
);
