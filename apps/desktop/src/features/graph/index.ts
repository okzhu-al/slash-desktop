/**
 * Knowledge Graph Module (v2 — ReactFlow)
 *
 * Exports all graph-related components, types, and utilities
 */

// Components
export { KnowledgeGraphPage } from './KnowledgeGraphPage';
export { LocalGraphPanel } from './LocalGraphPanel';

// Types
export type {
    GraphNode,
    GraphEdge,
    NoteGraph,
    KnowledgeNodeData,
    KnowledgeEdgeData,
    KnowledgeGraphPageProps,
    LocalGraphPanelProps,
} from './types';

// Constants
export {
    CATEGORY_COLORS,
    containsCJK,
    truncateLabel,
} from './constants';
