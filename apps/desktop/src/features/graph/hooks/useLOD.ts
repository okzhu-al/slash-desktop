/**
 * useLOD — Zoom-based Level-of-Detail system for knowledge graph nodes.
 * 
 * L0 (zoom < 0.4): Ultra-far. Dots only, no text.
 * L1 (zoom < 0.6): Far. Minimal shapes, short labels.
 * L2 (zoom < 0.8): Mid. Normal info, hover reveals detail.
 * L3 (zoom >= 0.8): Close. Full detail, rich hover.
 */

import { createContext, useContext } from 'react';

export const LODContext = createContext<number>(2);

export function useLOD(): number {
    return useContext(LODContext);
}

/** Compute LOD level from zoom value */
export function zoomToLOD(zoom: number): number {
    if (zoom < 0.4) return 0;
    if (zoom < 0.6) return 1;
    if (zoom < 0.8) return 2;
    return 3;
}
