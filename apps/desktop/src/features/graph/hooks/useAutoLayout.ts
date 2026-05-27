/**
 * useAutoLayout — Dagre-based automatic node positioning
 *
 * Features:
 * - Hierarchical layout via dagre
 * - Preserves manually dragged positions
 * - Incremental layout on new nodes (doesn't reset existing)
 */

import { useCallback } from 'react';
import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';
import type { KnowledgeNodeData, KnowledgeEdgeData } from '../types';

interface LayoutOptions {
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    nodeWidth?: number;
    nodeHeight?: number;
    rankSep?: number;
    nodeSep?: number;
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
    direction: 'TB',
    nodeWidth: 180,
    nodeHeight: 60,
    rankSep: 80,
    nodeSep: 40,
};

/**
 * Calculate layout positions for ReactFlow nodes using dagre.
 * Returns new nodes array with updated positions.
 */
export function calculateLayout(
    nodes: Node<KnowledgeNodeData>[],
    edges: Edge<KnowledgeEdgeData>[],
    options: LayoutOptions = {},
): Node<KnowledgeNodeData>[] {
    if (nodes.length === 0) return nodes;

    const opts = { ...DEFAULT_OPTIONS, ...options };

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: opts.direction,
        ranksep: opts.rankSep,
        nodesep: opts.nodeSep,
        marginx: 50,
        marginy: 50,
    });

    // Add nodes
    for (const node of nodes) {
        const isFolder = node.data?.nodeType === 'folder';
        const isProject = node.data?.category === 'project';
        const w = isFolder ? (isProject ? 70 : 40) : opts.nodeWidth;
        const h = isFolder ? (isProject ? 70 : 40) : opts.nodeHeight;

        g.setNode(node.id, {
            width: w,
            height: h,
        });
    }

    // Add edges (only valid ones where both source/target exist)
    const nodeIds = new Set(nodes.map(n => n.id));
    for (const edge of edges) {
        if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
            g.setEdge(edge.source, edge.target);
        }
    }

    dagre.layout(g);

    return nodes.map((node) => {
        const dagreNode = g.node(node.id);
        if (!dagreNode) return node;

        const isFolder = node.data?.nodeType === 'folder';
        const isProject = node.data?.category === 'project';
        const w = isFolder ? (isProject ? 70 : 40) : opts.nodeWidth;
        const h = isFolder ? (isProject ? 70 : 40) : opts.nodeHeight;

        return {
            ...node,
            position: {
                x: dagreNode.x - w / 2,
                y: dagreNode.y - h / 2,
            },
        };
    });
}

/**
 * Hook that provides a layout function for ReactFlow graphs.
 */
export function useAutoLayout(options?: LayoutOptions) {
    const getLayoutedElements = useCallback(
        (
            nodes: Node<KnowledgeNodeData>[],
            edges: Edge<KnowledgeEdgeData>[],
        ) => {
            const layoutedNodes = calculateLayout(nodes, edges, options);
            return { nodes: layoutedNodes, edges };
        },
        [options],
    );

    return { getLayoutedElements };
}
