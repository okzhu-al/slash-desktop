/**
 * Shared constants for Knowledge Graph components (v2)
 * Cleaned up: force-directed physics constants removed, only visual/utility constants remain.
 */

// ============================================================================
// Category Colors (PARA)
// ============================================================================

export const CATEGORY_COLORS: Record<string, string> = {
    inbox: '#f59e0b',     // amber-500
    project: '#10b981',   // emerald-500
    area: '#3b82f6',      // blue-500
    resource: '#8b5cf6',  // violet-500
    archive: '#64748b',   // slate-500
    center: '#ec4899',    // pink-500
};

// ============================================================================
// 3-Tier Edge Colors (per category, solid, zero transparency)
// Tier 1: selected + 1-hop (vivid)
// Tier 2: 2-hop (medium)
// Tier 3: ≥3-hop / unselected (subtle)
// ============================================================================

export const EDGE_TIER_COLORS: Record<string, [string, string, string]> = {
    // Light mode tiers: T1 (500), T2 (400), T3 (300) to ensure visibility even with opacity:0.4
    inbox:    ['#f59e0b', '#fbbf24', '#fcd34d'],
    project:  ['#10b981', '#34d399', '#6ee7b7'],
    area:     ['#3b82f6', '#60a5fa', '#93c5fd'],
    resource: ['#8b5cf6', '#a78bfa', '#c4b5fd'],
    archive:  ['#64748b', '#94a3b8', '#cbd5e1'],
    center:   ['#ec4899', '#f472b6', '#f9a8d4'],
};

export const EDGE_TIER_COLORS_DARK: Record<string, [string, string, string]> = {
    // Dark mode requires boosting brightness on the active tier to pop: T1 (400), T2 (500), T3 (600)
    inbox:    ['#fbbf24', '#f59e0b', '#d97706'],
    project:  ['#34d399', '#10b981', '#059669'],
    area:     ['#60a5fa', '#3b82f6', '#2563eb'],
    resource: ['#a78bfa', '#8b5cf6', '#7c3aed'],
    archive:  ['#94a3b8', '#64748b', '#475569'],
    center:   ['#f472b6', '#ec4899', '#db2777'],
};

// ============================================================================
// 3-Tier Node Styles (black/white, solid, zero transparency)
// ============================================================================

export const NODE_TIERS_LIGHT = [
    { bg: '#ffffff', text: '#000000', shadow: '0 4px 12px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05)' },  // T1
    { bg: '#fafafa', text: '#27272a', shadow: '0 2px 6px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.08)' },  // T2
    { bg: '#f4f4f5', text: '#52525b', shadow: '0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.12)' },  // T3 (Zinc 100 bg, 12% ring makes it crisp)
];

export const NODE_TIERS_DARK = [
    { bg: '#3f3f46', text: '#ffffff', shadow: '0 4px 12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.25)' },  // T1 (Zinc 700)
    { bg: '#27272a', text: '#e4e4e7', shadow: '0 2px 8px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.15)' },  // T2 (Zinc 800)
    { bg: '#18181b', text: '#a1a1aa', shadow: '0 1px 4px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)' },   // T3 (Zinc 900 bg, 10% ring makes it visible)
];

// ============================================================================
// CJK & Label Utilities
// ============================================================================

/** Maximum characters for truncated labels (Latin) */
export const LABEL_MAX_CHARS = 15;
/** Maximum characters for truncated labels (CJK) */
export const LABEL_MAX_CHARS_CJK = 8;

/** Detect if a string contains CJK characters */
export function containsCJK(str: string): boolean {
    return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(str);
}

/** Smart truncation for labels respecting CJK vs Latin text length */
export function truncateLabel(label: string, forceFullName: boolean = false): string {
    if (forceFullName) return label;
    const maxChars = containsCJK(label) ? LABEL_MAX_CHARS_CJK : LABEL_MAX_CHARS;
    if (label.length <= maxChars) return label;
    return label.slice(0, maxChars - 1) + '…';
}
