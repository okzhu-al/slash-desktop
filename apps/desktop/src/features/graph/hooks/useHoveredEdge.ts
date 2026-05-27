/**
 * HoveredEdgeContext — Shares the currently hovered edge ID with edge components
 *
 * Uses React Context instead of injecting into edge data to avoid
 * recreating all edge objects on every hover event (which defeats React.memo).
 * Only the edge whose hover state actually changes will re-render.
 */

import { createContext, useContext } from 'react';

export const HoveredEdgeContext = createContext<string | null>(null);

export function useHoveredEdge(edgeId: string): boolean {
    const hoveredId = useContext(HoveredEdgeContext);
    return hoveredId === edgeId;
}
