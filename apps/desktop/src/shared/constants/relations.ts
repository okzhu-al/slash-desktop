/**
 * Relation Taxonomy - Shared constants for relationship classification
 * 
 * 4 categories, 18 types. Used by:
 * - GhostLinkPanel (AI suggestion UI)
 * - LinkPreviewCard (hover relation badge)
 * - LocalGraphPanel (edge labels)
 * 
 * Codes (A1~D4) match the backend reasoning.rs taxonomy.
 */

/** All valid relation slugs */
export const RELATION_SLUGS = [
    // A. Cognitive
    'supports', 'contradicts', 'extends', 'example', 'precedes', 'partOf', 'analogy',
    // B. Practical
    'implements', 'applies', 'alternative', 'evolves',
    // C. Entity
    'creates', 'belongsTo', 'locatedIn', 'uses',
    // D. Social
    'collaborates', 'mentors', 'influences', 'opposes',
    // Meta
    'related', 'custom',
] as const;

export type RelationSlug = typeof RELATION_SLUGS[number];

/** Relation code → slug mapping (matches backend reasoning.rs) */
export const CODE_TO_SLUG: Record<string, RelationSlug> = {
    'A1': 'supports', 'A2': 'contradicts', 'A3': 'extends', 'A4': 'example',
    'A5': 'precedes', 'A6': 'partOf', 'A7': 'analogy',
    'B1': 'implements', 'B2': 'applies', 'B3': 'alternative', 'B4': 'evolves',
    'C1': 'creates', 'C2': 'belongsTo', 'C3': 'locatedIn', 'C4': 'uses',
    'D1': 'collaborates', 'D2': 'mentors', 'D3': 'influences', 'D4': 'opposes',
};

/** Chinese → slug mapping (backward compat with old AI output) */
export const CN_TO_SLUG: Record<string, RelationSlug> = {
    '支持': 'supports', '反驳': 'contradicts', '扩展': 'extends', '案例': 'example',
    '前置': 'precedes', '组成': 'partOf', '类比': 'analogy',
    '实现': 'implements', '应用': 'applies', '应用于': 'applies',
    '替代': 'alternative', '演化': 'evolves',
    '创建': 'creates', '作者': 'creates', '属于': 'belongsTo', '亲属': 'belongsTo',
    '位于': 'locatedIn', '使用': 'uses',
    '合作': 'collaborates', '师承': 'mentors', '师生': 'mentors',
    '影响': 'influences', '启发自': 'influences',
    '对立': 'opposes', '敌对': 'opposes',
    '相关': 'related',
};

/** Normalize any relation string (code, Chinese, or slug) to a canonical slug */
export function normalizeRelation(raw: string): RelationSlug {
    const trimmed = raw.trim();

    // 1. Try code (e.g. "A3")
    if (trimmed.length === 2 && CODE_TO_SLUG[trimmed.toUpperCase()]) {
        return CODE_TO_SLUG[trimmed.toUpperCase()];
    }

    // 2. Try Chinese
    if (CN_TO_SLUG[trimmed]) {
        return CN_TO_SLUG[trimmed];
    }

    // 3. Check if already a valid slug
    if ((RELATION_SLUGS as readonly string[]).includes(trimmed)) {
        return trimmed as RelationSlug;
    }

    // 4. Case-insensitive slug match
    const lower = trimmed.toLowerCase();
    const found = RELATION_SLUGS.find(s => s.toLowerCase() === lower);
    if (found) return found;

    return 'related';
}

/** Grouped relation keys for UI dropdowns */
export const RELATION_GROUPS = [
    {
        labelKey: 'relation.group.cognitive',
        label: '认知关系',
        keys: ['supports', 'contradicts', 'extends', 'example', 'precedes', 'partOf', 'analogy'] as RelationSlug[],
    },
    {
        labelKey: 'relation.group.practical',
        label: '实践关系',
        keys: ['implements', 'applies', 'alternative', 'evolves'] as RelationSlug[],
    },
    {
        labelKey: 'relation.group.entity',
        label: '实体关系',
        keys: ['creates', 'belongsTo', 'locatedIn', 'uses'] as RelationSlug[],
    },
    {
        labelKey: 'relation.group.social',
        label: '社会关系',
        keys: ['collaborates', 'mentors', 'influences', 'opposes'] as RelationSlug[],
    },
] as const;

/** Flat list of all relation keys for dropdowns (without 'related' and 'custom') */
export const RELATION_KEYS: RelationSlug[] = RELATION_GROUPS.flatMap(g => [...g.keys]);
