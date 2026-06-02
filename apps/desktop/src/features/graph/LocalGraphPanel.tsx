/**
 * LocalGraphPanel — Right sidebar tab showing the local graph for the active note
 *
 * Displays the current note as center node with its direct connections.
 * Supports node click to navigate, and drag-to-create new edges.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    ReactFlow,
    Background,
    BackgroundVariant,
    useNodesState,
    useEdgesState,
    addEdge,
    ReactFlowProvider,
    Handle,
    Position,
    type OnConnect,
    type Node,
    type Edge,
    type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';
import { useFileSystemStore } from '@/core/fs/store';

import type { LocalGraphPanelProps, KnowledgeNodeData, KnowledgeEdgeData } from './types';
import { NoteNode } from './components/NoteNode';
import { RelationEdge } from './components/RelationEdge';
import { useGraphData } from './hooks/useGraphData';


const nodeTypes = { noteNode: NoteNode, folderNode: LocalFolderNode };
const edgeTypes = { relationEdge: RelationEdge };

function LocalFolderNode({ data, selected }: { data: any, selected: boolean }) {
    return (
        <div
            className={`px-4 py-2 border rounded shadow-sm text-center min-w-[120px] transition-colors antialiased
                        ${selected ? 'border-[#002FA7] dark:border-blue-500 ring-1 ring-[#002FA7]' : 'border-zinc-300 dark:border-zinc-500'}
                        bg-white dark:bg-[#EFE0CC]`}
            style={{ transform: 'translateZ(0)', backfaceVisibility: 'hidden' }}
        >
            <span className="text-black text-[12px] font-medium block">{data.label}</span>
            <Handle type="target" position={Position.Top} className="w-1.5! h-1.5! bg-zinc-400! border-none!" />
            <Handle type="source" position={Position.Bottom} className="w-1.5! h-1.5! bg-zinc-400! border-none!" />
        </div>
    );
}

function LocalGraphInner({ notePath, onNavigate, refreshKey }: LocalGraphPanelProps) {
    const { t } = useTranslation();
    const vaultPath = useFileSystemStore(state => state.root?.path);

    const { nodes: initialNodes, edges: initialEdges, loading } = useGraphData({
        mode: 'local',
        notePath,
        vaultPath,
        refreshKey
    });

    const [nodes, setNodes, onNodesChange] = useNodesState<Node<KnowledgeNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<KnowledgeEdgeData>>([]);

    // Collapsed nodes
    const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

    // Sync data
    useEffect(() => {
        if (initialNodes.length > 0) {
            setNodes(initialNodes as Node<KnowledgeNodeData>[]);
            setEdges(initialEdges);
            setCollapsedNodes(new Set());
        } else {
            setNodes([]);
            setEdges([]);
        }
    }, [initialNodes, initialEdges, setNodes, setEdges]);

    // Collapse toggle
    useEffect(() => {
        const handler = (e: Event) => {
            const nodeId = (e as CustomEvent).detail.nodeId;
            setCollapsedNodes(prev => {
                const next = new Set(prev);
                next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
                return next;
            });
        };
        window.addEventListener('graph:toggle-collapse', handler);
        return () => window.removeEventListener('graph:toggle-collapse', handler);
    }, []);

    // Apply collapse
    const visibleNodes = useMemo(() => {
        if (collapsedNodes.size === 0) return nodes;
        const childrenOf = new Map<string, Set<string>>();
        for (const edge of edges) {
            if (edge.data?.linkType === 'structural') {
                if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, new Set());
                childrenOf.get(edge.source)!.add(edge.target);
            }
        }
        const hidden = new Set<string>();
        function hideChildren(parentId: string) {
            const children = childrenOf.get(parentId);
            if (!children) return;
            for (const childId of children) {
                hidden.add(childId);
                hideChildren(childId);
            }
        }
        for (const id of collapsedNodes) hideChildren(id);

        return nodes
            .filter(n => !hidden.has(n.id))
            .map(n => ({
                ...n,
                data: { ...n.data, collapsed: collapsedNodes.has(n.id) }
            }));
    }, [nodes, edges, collapsedNodes]);

    const visibleEdges = useMemo(() => {
        const ids = new Set(visibleNodes.map(n => n.id));
        return edges.filter(e => ids.has(e.source) && ids.has(e.target));
    }, [edges, visibleNodes]);

    // Single click node → select only
    const handleNodeClick: NodeMouseHandler<Node<KnowledgeNodeData>> = useCallback((_event, _node) => {
        // Select only, navigation on double-click
    }, []);

    // Double-click node → navigate
    const handleNodeDoubleClick: NodeMouseHandler<Node<KnowledgeNodeData>> = useCallback((_event, node) => {
        if (!node.data || node.data.isCenter) return;
        onNavigate?.(node.id);
    }, [onNavigate]);

    // Edge connection
    const onConnect: OnConnect = useCallback((connection) => {
        if (connection.source && connection.target) {
            const newEdge: Edge<KnowledgeEdgeData> = {
                id: `e-local-${connection.source}-${connection.target}`,
                source: connection.source,
                target: connection.target,
                type: 'relationEdge',
                data: { label: 'related', linkType: 'explicit' },
            };
            setEdges(eds => addEdge(newEdge, eds));
        }
    }, [setEdges]);

    if (!notePath) {
        return (
            <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
                {t('graph.select_note', '选择一篇笔记查看关联图谱')}
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 h-12 border-b border-zinc-200 dark:border-zinc-700">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex-1 truncate">
                    {t('graph.local_title', '关联图谱')}
                </span>
                <span className="text-[11px] text-zinc-400">
                    {visibleNodes.length} {t('graph.nodes_count', '节点')}
                </span>
            </div>

            {/* Graph */}
            <div className="flex-1 min-h-0">
                {loading ? (
                    <div className="flex-1 flex items-center justify-center h-full">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 dark:border-blue-400 border-t-transparent dark:border-t-transparent" />
                    </div>
                ) : visibleNodes.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center h-full text-zinc-400 text-sm">
                        {t('graph.noData', '暂无关联数据')}
                    </div>
                ) : (
                    <ReactFlow
                        nodes={visibleNodes}
                        edges={visibleEdges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeClick={handleNodeClick}
                        onNodeDoubleClick={handleNodeDoubleClick}
                        zoomOnDoubleClick={false}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.3 }}
                        minZoom={0.3}
                        maxZoom={2}
                        proOptions={{ hideAttribution: true }}
                        className="local-graph-flow bg-transparent!"
                        panOnDrag
                        zoomOnScroll
                    >
                        <Background
                            variant={BackgroundVariant.Dots}
                            gap={16}
                            size={0.8}
                            color="var(--graph-dot-color, rgba(0,0,0,0.04))"
                        />
                    </ReactFlow>
                )}
            </div>

        </div>
    );
}

export const LocalGraphPanel = (props: LocalGraphPanelProps) => (
    <ReactFlowProvider>
        <LocalGraphInner {...props} />
    </ReactFlowProvider>
);
