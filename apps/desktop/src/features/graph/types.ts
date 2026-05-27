/**
 * Shared type definitions for Knowledge Graph components
 * V2: ReactFlow-based bidirectional knowledge network
 */

// ============================================================================
// Backend Response Types (from Tauri commands)
// ============================================================================

/** Node in the knowledge graph */
export interface GraphNode {
    id: string;
    label: string;
    is_center: boolean;
    exists: boolean;
    category: string;     // PARA category: inbox/project/area/resource/archive
    in_degree: number;    // Number of incoming links
    node_type: string;    // "folder" | "note"
    depth: number;        // Directory depth
    note_count: number;   // Number of notes in folder
    last_active: number;  // Most recent mtime
    summary: string | null;
    tags: string | null;  // Comma-separated tags
}

/** Edge in the knowledge graph */
export interface GraphEdge {
    source: string;
    target: string;
    label: string | null;
    link_type: string;     // explicit/yaml/ghost/structural
}

/** Complete graph data returned by backend */
export interface NoteGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

/** Ghost link from AI similarity search */
export interface GhostLink {
    note_path: string;
    title: string;
    similarity: number;
    mtime: number;
    relation?: string;
}

// ============================================================================
// ReactFlow Node/Edge Data Types
// ============================================================================

/** Data attached to each ReactFlow node */
export interface KnowledgeNodeData extends Record<string, unknown> {
    label: string;
    tags: string[];
    category: string;
    exists: boolean;
    isCenter: boolean;
    inDegree: number;
    nodeType: string;       // "folder" | "note"
    noteCount: number;
    summary: string | null;
    isNew?: boolean;        // Draft node created in graph
    collapsed?: boolean;    // Whether child nodes are hidden
    notePath: string;       // Full path for navigation
    taskProgress?: { done: number; total: number };  // For project folder ring
    hopTier?: number;  // 1=selected+1hop, 2=2hop, 3=beyond/unselected
    relationToCenter?: string; // e.g. 'related', 'parent', 'child'
}

/** Data attached to each ReactFlow edge */
export interface KnowledgeEdgeData extends Record<string, unknown> {
    label: string | null;
    linkType: string;
    hopTier?: number;  // 1=selected+1hop, 2=2hop, 3=beyond/unselected
    hovered?: boolean; // Set by parent when mouse enters edge
}

// ============================================================================
// Component Props Types
// ============================================================================

/** explicit background zone calculated from node clusters */
export interface KnowledgeGraphZone {
    id: string;
    category: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Props for KnowledgeGraphPage (global graph) */
export interface KnowledgeGraphPageProps {
    onClose: () => void;
    onNavigate?: (path: string) => void;
    onFolderClick?: (folderPath: string, folderName: string) => void;
    vaultName?: string;
    vaultPath?: string;
    refreshKey?: number;
    isGlobal?: boolean;
    notePath?: string | null;
}

/** Props for LocalGraphPanel (right sidebar tab) */
export interface LocalGraphPanelProps {
    notePath: string | null;
    onNavigate?: (path: string) => void;
    refreshKey?: number;
}
