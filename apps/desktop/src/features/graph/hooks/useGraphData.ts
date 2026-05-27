import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type {
    NoteGraph, GhostLink,
    KnowledgeNodeData, KnowledgeEdgeData,
} from '../types';
import { calculateLayout } from './useAutoLayout';

export type GraphMode = 'local' | 'global';

export interface MapLayout {
    w: number;
    h: number;
    yTop: number;
    yBot: number;
    xLeft: number;
    xRight: number;
}

interface UseGraphDataOptions {
    mode: GraphMode;
    notePath?: string | null;
    vaultPath?: string;
    refreshKey?: number;
    ghostLinks?: GhostLink[];
    layout?: MapLayout;
}

export interface ZoneBounds {
    minX: number; maxX: number; minY: number; maxY: number;
}

interface UseGraphDataResult {
    nodes: Node<KnowledgeNodeData>[];
    edges: Edge<KnowledgeEdgeData>[];
    zoneBoundsMap: Record<string, ZoneBounds>;
    loading: boolean;
    errorMsg: string | null;
}

function parseTags(raw: string | string[] | null | undefined): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.slice(0, 5);
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map(String).slice(0, 5);
            }
        } catch (e) {
            // fallback if not valid JSON
        }
        return raw.split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).slice(0, 5);
    }
    return [];
}

function performMacroLayout(nodes: Node<KnowledgeNodeData>[], edges: Edge<KnowledgeEdgeData>[], mode: GraphMode, layout?: MapLayout) {
    const structuralEdges = edges.filter(e => e.data?.linkType === 'structural');
    const layoutPartition = (partitionNodes: Node<KnowledgeNodeData>[], opts: any) => {
        if (partitionNodes.length === 0) return [];
        const partitionIds = new Set(partitionNodes.map(n => n.id));
        const partitionEdges = structuralEdges.filter(e => partitionIds.has(e.source) && partitionIds.has(e.target));
        return calculateLayout(partitionNodes, partitionEdges, opts);
    };

    if (mode === 'local') {
        const layoutEdges = structuralEdges.length > 0 ? structuralEdges : edges;
        const layoutedNodes = calculateLayout(nodes, layoutEdges, { direction: 'TB', rankSep: 80, nodeSep: 40 });
        layoutedNodes.forEach(n => {
            n.position.x = Math.round(n.position.x);
            n.position.y = Math.round(n.position.y);
        });
        return { nodes: layoutedNodes, zoneBoundsMap: {} };
    }

    const partitions = {
        inbox: nodes.filter(n => n.data.category === 'inbox'),
        project: nodes.filter(n => n.data.category === 'project'),
        area: nodes.filter(n => n.data.category === 'area'),
        resource: nodes.filter(n => n.data.category === 'resource'),
        archive: nodes.filter(n => n.data.category === 'archive'),
    };

    // ─── Zone Layout Strategies ─────────────────────────────────────────
    // Each PARA zone gets its own "visual grammar" for node arrangement.

    // 1. PROJECTS — Top-to-Bottom Tree (TB), directory structure visualization
    let projectNodes = layoutPartition(partitions.project, {
        direction: 'TB', rankSep: 140, nodeSep: 100
    });

    // ─── Shared Radial Hub Layout Engine ──────────────────────────────────
    // Reusable for Areas, Resources, Archives with different "personality" params.
    const NODE_W = 260;
    const NODE_H = 60;

    // Deterministic hash for stable randomness across renders
    const hashCode = (s: string) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h;
    };
    const hashNorm = (s: string, seed: number) => {
        const h = hashCode(s + String(seed));
        return ((h & 0x7FFFFFFF) % 1000) / 1000;
    };

    interface RadialConfig {
        radiusFixed: number;        // Fixed radius (used when jitter=false)
        radiusMin: number;          // Min radius (used when jitter=true)
        radiusMax: number;          // Max radius cap (used when jitter=true)
        radiusPerNode: number;      // Extra radius per child node
        jitter: boolean;            // Enable organic randomness?
        jitterRadiusMinFactor?: number; // Configurable fraction of radius for max stretch variance
        angleJitter: number;        // Angular wobble in radians (only if jitter=true)
        clusterGap: number;         // Gap between clusters in grid arrangement
    }

    function radialHubLayout(
        zoneNodes: Node<KnowledgeNodeData>[],
        zoneEdges: Edge<KnowledgeEdgeData>[],
        config: RadialConfig,
    ): Node<KnowledgeNodeData>[] {
        if (zoneNodes.length === 0) return [];

        const folders = zoneNodes.filter(n => n.data.nodeType === 'folder');
        const folderIds = new Set(folders.map(f => f.id));
        const nodeById = new Map(zoneNodes.map(n => [n.id, n]));

        // Build hub → children mapping
        const hubChildren = new Map<string, Node<KnowledgeNodeData>[]>();
        const claimed = new Set<string>();
        for (const f of folders) { hubChildren.set(f.id, []); claimed.add(f.id); }

        for (const e of zoneEdges) {
            if (folderIds.has(e.source) && !folderIds.has(e.target)) {
                hubChildren.get(e.source)?.push(nodeById.get(e.target)!);
                claimed.add(e.target);
            } else if (folderIds.has(e.target) && !folderIds.has(e.source)) {
                hubChildren.get(e.target)?.push(nodeById.get(e.source)!);
                claimed.add(e.source);
            }
        }

        const orphans = zoneNodes.filter(n => !claimed.has(n.id));

        type Cluster = { nodes: Node<KnowledgeNodeData>[]; radius: number };
        const clusters: Cluster[] = [];

        for (const [folderId, children] of hubChildren) {
            const folder = nodeById.get(folderId)!;
            const n = children.length;

            const laid: Node<KnowledgeNodeData>[] = [
                { ...folder, position: { x: -NODE_W / 2, y: -NODE_H / 2 } }
            ];

            if (config.jitter) {
                // Organic firework: varied radius + angular wobble
                const maxR = Math.min(config.radiusMax, config.radiusMin + n * config.radiusPerNode);
                children.forEach((child, i) => {
                    const baseAngle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
                    // Dynamically set jitter spread based on config
                    const minSpread = config.jitterRadiusMinFactor ?? 0.2;
                    const rFactor = minSpread + (1 - minSpread) * hashNorm(child.id, 1);
                    const r = config.radiusMin * 0.5 + (maxR - config.radiusMin * 0.5) * rFactor;
                    const aJitter = (hashNorm(child.id, 2) - 0.5) * 2 * config.angleJitter;
                    const angle = baseAngle + aJitter;
                    laid.push({ ...child, position: {
                        x: Math.cos(angle) * r - NODE_W / 2,
                        y: Math.sin(angle) * r - NODE_H / 2,
                    }});
                });
                clusters.push({ nodes: laid, radius: maxR });
            } else {
                // Clean fixed-radius circle: all children equidistant from hub
                const r = config.radiusFixed + n * config.radiusPerNode;
                children.forEach((child, i) => {
                    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
                    laid.push({ ...child, position: {
                        x: Math.cos(angle) * r - NODE_W / 2,
                        y: Math.sin(angle) * r - NODE_H / 2,
                    }});
                });
                clusters.push({ nodes: laid, radius: r });
            }
        }

        // Orphans → simple grid
        if (orphans.length > 0) {
            const COLS = Math.max(2, Math.ceil(Math.sqrt(orphans.length)));
            const orphanLaid = orphans.map((n, i) => ({
                ...n,
                position: {
                    x: (i % COLS) * (NODE_W + 40),
                    y: Math.floor(i / COLS) * (NODE_H + 30),
                },
            }));
            clusters.push({ nodes: orphanLaid, radius: 200 });
        }

        // Arrange clusters in grid
        const allNodes: Node<KnowledgeNodeData>[] = [];
        const COLS = Math.max(2, Math.ceil(Math.sqrt(clusters.length)));
        let cursorX = 0, cursorY = 0, maxRowH = 0, col = 0;

        for (const cluster of clusters) {
            const cMinX = Math.min(...cluster.nodes.map(n => n.position.x));
            const cMinY = Math.min(...cluster.nodes.map(n => n.position.y));
            const cMaxX = Math.max(...cluster.nodes.map(n => n.position.x)) + NODE_W;
            const cMaxY = Math.max(...cluster.nodes.map(n => n.position.y)) + NODE_H;
            const cW = cMaxX - cMinX;
            const cH = cMaxY - cMinY;

            cluster.nodes.forEach(n => {
                n.position.x = n.position.x - cMinX + cursorX;
                n.position.y = n.position.y - cMinY + cursorY;
            });
            allNodes.push(...cluster.nodes);

            maxRowH = Math.max(maxRowH, cH);
            cursorX += cW + config.clusterGap;
            col++;
            if (col >= COLS) { col = 0; cursorX = 0; cursorY += maxRowH + config.clusterGap; maxRowH = 0; }
        }

        return allNodes;
    }

    // 2. AREAS — Organic firework: varied radius + angular jitter = alive & growing
    const areaIds = new Set(partitions.area.map(n => n.id));
    let areaNodes = radialHubLayout(
        partitions.area,
        structuralEdges.filter(e => areaIds.has(e.source) && areaIds.has(e.target)),
        { radiusFixed: 0, radiusMin: 180, radiusMax: 500, radiusPerNode: 25, jitter: true, jitterRadiusMinFactor: 0.2, angleJitter: 0.22, clusterGap: 150 }
    );

    // 3. RESOURCES — Orderly but dynamic. Halfway between fluid Area fireworks and rigid Archive rings
    const resIds = new Set(partitions.resource.map(n => n.id));
    let resourceNodes = radialHubLayout(
        partitions.resource,
        structuralEdges.filter(e => resIds.has(e.source) && resIds.has(e.target)),
        { radiusFixed: 0, radiusMin: 150, radiusMax: 350, radiusPerNode: 20, jitter: true, jitterRadiusMinFactor: 0.7, angleJitter: 0.08, clusterGap: 120 }
    );

    // 4. ARCHIVES — Short fixed radius, no randomness = compact, quiet, retired
    const archIds = new Set(partitions.archive.map(n => n.id));
    let archiveNodes = radialHubLayout(
        partitions.archive,
        structuralEdges.filter(e => archIds.has(e.source) && archIds.has(e.target)),
        { radiusFixed: 100, radiusMin: 0, radiusMax: 0, radiusPerNode: 15, jitter: false, angleJitter: 0, clusterGap: 100 }
    );

    // 5. INBOX — Chaotic: "messy desk" feel. Large random scatter to break any grid/hierarchy.
    const uncategorizedNodes = nodes.filter(n => !n.data.category || !(['project', 'area', 'resource', 'archive', 'inbox'].includes(n.data.category)));
    let mergedInboxNodes = (() => {
        const inboxN = [...partitions.inbox, ...uncategorizedNodes];
        if (inboxN.length === 0) return [];

        const COLS = Math.max(3, Math.ceil(Math.sqrt(inboxN.length)));
        // Generous cell size to allow overlapping but prevent complete unreadability
        const CELL_W = 320;
        const CELL_H = 140;
        // Huge jitter relative to cell size for organic messiness
        const JITTER_X = 160; 
        const JITTER_Y = 80;

        return inboxN.map((n, i) => {
            const h = hashCode(n.id);
            // Math.sin on hash to get pseudo-random -1 to 1 based on ID
            const jx = Math.sin(h) * JITTER_X;
            const jy = Math.cos(h) * JITTER_Y;
            
            return {
                ...n,
                position: {
                    x: (i % COLS) * CELL_W + jx,
                    y: Math.floor(i / COLS) * CELL_H + jy,
                },
            };
        });
    })();

    const getBoundsCenter = (ns: Node[]) => {
        if (ns.length === 0) return { cx: 0, cy: 0 };
        const NODE_WIDTH = 260; // Estimated physical width
        const NODE_HEIGHT = 60; // Estimated physical height (plus padding)
        const minX = Math.min(...ns.map(n => n.position.x));
        const maxX = Math.max(...ns.map(n => n.position.x)) + NODE_WIDTH;
        const minY = Math.min(...ns.map(n => n.position.y));
        const maxY = Math.max(...ns.map(n => n.position.y)) + NODE_HEIGHT;
        return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    };

    const cProj = getBoundsCenter(projectNodes);
    const cArea = getBoundsCenter(areaNodes);
    const cInbox = getBoundsCenter(mergedInboxNodes);
    const cRes = getBoundsCenter(resourceNodes);
    const cArch = getBoundsCenter(archiveNodes);

    // Holy Grail Map Coordinates (Relative to React Flow's 0,0 center which maps to SVG 750,750)
    const L = layout || { w: 4000, h: 3000, yTop: 1000, yBot: 2750, xLeft: 1300, xRight: 2700 };
    const CX = L.w / 2;
    const CY = L.h / 2;

    const TARGETS = {
        project:  { x: 0, y: (L.yTop / 2) - CY },
        inbox:    { x: 0, y: (L.yBot + (L.h - L.yBot) / 2) - CY },
        resource: { x: (L.xLeft / 2) - CX, y: (L.yTop + (L.yBot - L.yTop) / 2) - CY },
        area:     { x: (L.xLeft + (L.xRight - L.xLeft) / 2) - CX, y: (L.yTop + (L.yBot - L.yTop) / 2) - CY },
        archive:  { x: (L.xRight + (L.w - L.xRight) / 2) - CX, y: (L.yTop + (L.yBot - L.yTop) / 2) - CY }
    };

    const applyOffset = (ns: Node[], dx: number, dy: number) => {
        return ns.map(n => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
    };

    const layoutedNodes = [
        ...applyOffset(mergedInboxNodes, TARGETS.inbox.x - cInbox.cx, TARGETS.inbox.y - cInbox.cy),
        ...applyOffset(projectNodes, TARGETS.project.x - cProj.cx, TARGETS.project.y - cProj.cy),
        ...applyOffset(areaNodes, TARGETS.area.x - cArea.cx, TARGETS.area.y - cArea.cy),
        ...applyOffset(resourceNodes, TARGETS.resource.x - cRes.cx, TARGETS.resource.y - cRes.cy),
        ...applyOffset(archiveNodes, TARGETS.archive.x - cArch.cx, TARGETS.archive.y - cArch.cy),
    ];

    // Zone clamping — ensure every node stays within its PARA zone boundaries
    // Node positions are in ReactFlow coords (centered at 0,0), zone coords are offset
    const PAD = 50; // Padding from zone edge
    const EXT = 50000; // Infinite expanse outward
    const ZONE_BOUNDS: Record<string, { minX: number; maxX: number; minY: number; maxY: number }> = {
        project:  { minX: -EXT, maxX: L.w + EXT, minY: -EXT, maxY: L.yTop - PAD - CY },
        inbox:    { minX: -EXT, maxX: L.w + EXT, minY: L.yBot + PAD - CY, maxY: L.h + EXT },
        resource: { minX: -EXT, maxX: L.xLeft - PAD - CX, minY: L.yTop + PAD - CY, maxY: L.yBot - PAD - CY },
        area:     { minX: L.xLeft + PAD - CX, maxX: L.xRight - PAD - CX, minY: L.yTop + PAD - CY, maxY: L.yBot - PAD - CY },
        archive:  { minX: L.xRight + PAD - CX, maxX: L.w + EXT, minY: L.yTop + PAD - CY, maxY: L.yBot - PAD - CY },
    };

    for (const n of layoutedNodes) {
        const cat = (n.data as KnowledgeNodeData)?.category || 'inbox';
        const bounds = ZONE_BOUNDS[cat] || ZONE_BOUNDS.inbox;
        n.position.x = Math.round(Math.max(bounds.minX, Math.min(bounds.maxX, n.position.x)));
        n.position.y = Math.round(Math.max(bounds.minY, Math.min(bounds.maxY, n.position.y)));
    }

    // Content-aware zone bounds: compute cluster bounding box per category
    const categories = ['project', 'inbox', 'resource', 'area', 'archive'] as const;
    const zoneBoundsMap: Record<string, ZoneBounds> = {};
    for (const cat of categories) {
        const catNodes = layoutedNodes.filter(n => (n.data as KnowledgeNodeData)?.category === cat);
        if (catNodes.length === 0) {
            // Fallback to the target center point with a minimum extent
            const t = TARGETS[cat];
            zoneBoundsMap[cat] = { minX: t.x - 200, maxX: t.x + 200, minY: t.y - 150, maxY: t.y + 150 };
        } else {
            zoneBoundsMap[cat] = {
                minX: Math.min(...catNodes.map(n => n.position.x)),
                maxX: Math.max(...catNodes.map(n => n.position.x + NODE_W)),
                minY: Math.min(...catNodes.map(n => n.position.y)),
                maxY: Math.max(...catNodes.map(n => n.position.y + NODE_H)),
            };
        }
    }

    return { nodes: layoutedNodes, zoneBoundsMap };
}

function transformToReactFlow(graph: NoteGraph): { nodes: Node<KnowledgeNodeData>[]; edges: Edge<KnowledgeEdgeData>[] } {
    const nodes: Node<KnowledgeNodeData>[] = [];
    const edges: Edge<KnowledgeEdgeData>[] = [];

    // Root-level PARA directories are represented by the map zones, not as nodes
    const ROOT_PARA_PREFIXES = ['00_', '01_', '02_', '03_', '04_'];
    const isRootParaDir = (id: string, nodeType: string) => {
        if (nodeType !== 'folder') return false;
        const basename = id.split('/').pop() || '';
        return ROOT_PARA_PREFIXES.some(p => basename.startsWith(p));
    };

    const rootIds = new Set<string>();
    let centerId: string | undefined = undefined;
    
    for (const node of graph.nodes || []) {
        if (isRootParaDir(node.id, node.node_type)) rootIds.add(node.id);
        if (node.is_center) centerId = node.id;
    }

    // Build relation map from the center node
    const centerRelations = new Map<string, string>();
    if (centerId) {
        for (const link of graph.edges || []) {
            const relText = link.label || (link.link_type === 'ghost' ? 'ghost' : link.link_type); // ensure we grab link type if label is null
            if (relText && relText !== 'structural') {
                if (link.source === centerId) centerRelations.set(link.target, relText);
                else if (link.target === centerId) centerRelations.set(link.source, relText);
            }
        }
    }

    for (const node of graph.nodes || []) {
        if (rootIds.has(node.id)) continue; // Skip root PARA dirs
        const isFolder = node.node_type === 'folder';
        nodes.push({
            id: node.id,
            type: isFolder ? 'folderNode' : 'noteNode',
            position: { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 },
            data: {
                label: node.label,
                tags: parseTags(node.tags),
                category: node.category || 'other',
                exists: node.exists ?? true,
                isCenter: node.is_center ?? false,
                inDegree: node.in_degree || 0,
                nodeType: node.node_type || 'note',
                noteCount: node.note_count || 0,
                summary: node.summary || null,
                notePath: node.id,
                collapsed: false,
                relationToCenter: centerRelations.get(node.id),
            },
        });
    }

    for (const link of graph.edges || []) {
        // Skip edges that connect to filtered root PARA dirs
        if (rootIds.has(link.source) || rootIds.has(link.target)) continue;
        edges.push({
            id: `e-${link.source}-${link.target}`,
            source: link.source,
            target: link.target,
            type: 'relationEdge',
            animated: link.link_type === 'citation',
            data: {
                linkType: link.link_type || 'citation',
                label: link.label || null,
            },
            markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20 },
        });
    }

    return { nodes, edges };
}

export function useGraphData(options: UseGraphDataOptions): UseGraphDataResult {
    const [graph, setGraph] = useState<Omit<UseGraphDataResult, 'loading' | 'errorMsg'>>({
        nodes: [],
        edges: [],
        zoneBoundsMap: {}
    });
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    useEffect(() => {
        async function load() {
            setLoading(true);
            setErrorMsg(null);
            try {
                const isGlobal = options.mode === 'global';
                
                const data: NoteGraph = await invoke(isGlobal ? 'get_global_graph' : 'get_note_graph', {
                    vaultPath: options.vaultPath,
                    notePath: isGlobal ? undefined : options.notePath,
                });

                const { nodes, edges } = transformToReactFlow(data);

                // Inject ghosts
                if (options.ghostLinks && options.ghostLinks.length > 0) {
                    options.ghostLinks.forEach(ghost => {
                        if (!nodes.find(n => n.id === ghost.note_path)) {
                            nodes.push({
                                id: ghost.note_path,
                                type: 'noteNode',
                                position: { x: Math.random() * 200, y: Math.random() * 200 },
                                data: {
                                    label: ghost.title || 'Ghost',
                                    tags: [],
                                    category: 'inbox',
                                    exists: false,
                                    isCenter: false,
                                    inDegree: 1,
                                    nodeType: 'note',
                                    noteCount: 0,
                                    summary: null,
                                    notePath: ghost.note_path,
                                    collapsed: false,
                                    relationToCenter: ghost.relation,
                                },
                            });
                        }
                        const edgeId = `e-${options.notePath}-${ghost.note_path}`;
                        if (!edges.find(e => e.id === edgeId)) {
                            edges.push({
                                id: edgeId,
                                source: options.notePath!,
                                target: ghost.note_path,
                                type: 'relationEdge',
                                animated: true,
                                data: { linkType: 'citation', label: null },
                                markerEnd: { type: MarkerType.ArrowClosed },
                                style: { strokeDasharray: '5 5' }
                            });
                        }
                    });
                }

                const { nodes: layoutedNodes, zoneBoundsMap } = performMacroLayout(
                    nodes,
                    edges,
                    options.mode,
                    options.layout
                );

                setGraph({
                    nodes: layoutedNodes as Node<KnowledgeNodeData>[],
                    edges,
                    zoneBoundsMap
                });
            } catch (err) {
                console.error("Failed to load graph data", err);
                setErrorMsg(String(err));
            } finally {
                setLoading(false);
            }
        }

        if (options.vaultPath) {
            load();
        }
    }, [options.mode, options.notePath, options.vaultPath, options.refreshKey, options.ghostLinks, options.layout]);

    return { ...graph, loading, errorMsg };
}
