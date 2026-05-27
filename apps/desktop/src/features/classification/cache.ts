export interface ClassificationSuggestion {
    folder_path: string;
    similarity: number;
    reason: string;
    decision: 'select' | 'create';
}

export interface ClassificationResult {
    suggestions: ClassificationSuggestion[];
    has_pending_tasks: boolean;
    query_profile: string;
}

export const classificationResultCache = new Map<string, ClassificationResult>();

export function clearClassificationCache(notePath: string) {
    classificationResultCache.delete(notePath);
}
