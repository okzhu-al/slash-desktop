import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, FileText, Sparkles, X, FileSearch, Wand2, Brain, CheckSquare, Square, ChevronDown, ChevronRight } from 'lucide-react';
import { DeepSearchAnswer } from './DeepSearchAnswer';

// Types matching Rust backend
export interface SearchResult {
    path: string;
    title: string;
    snippet: string;
    score: number;
    match_type: 'keyword' | 'semantic' | 'both' | 'hyde';
    match_source: string;
}

export interface HybridSearchResult {
    results: SearchResult[];
    tasks: TaskSearchResult[];
    keyword_count: number;
    semantic_count: number;
    fallback_count: number;
    task_count: number;
    total_time_ms: number;
}

export interface TaskSearchResult {
    id: number;
    note_path: string;
    note_title: string;
    raw_text: string;
    is_completed: boolean;
    due_date: string | null;
    line_number: number;
}

interface HyDeSearchResult {
    results: SearchResult[];
    hypothetical_document: string;
    total_time_ms: number;
}

interface NoteReference {
    path: string;
    title: string;
    excerpt: string | null;
}

interface DeepSearchResultType {
    answer: string;
    references: NoteReference[];
    total_time_ms: number;
    context_notes_count: number;
}

interface SearchPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectNote: (notePath: string, lineNumber?: number) => void;
    vaultPath: string;
}

// -- Grouped note type --
interface NoteSearchGroup {
    path: string;
    title: string;
    bestScore: number;
    matches: SearchResult[];
}

// -- Unified result item --
type UnifiedItem =
    | { kind: 'note'; group: NoteSearchGroup }
    | { kind: 'task'; task: TaskSearchResult };

// -- Helpers --
// Detect media reference in snippet and extract asset path
// Also handles truncated snippets where the closing ) may be missing
const MEDIA_REGEX = /!\[.*?\]\((assets\/[^)\s]+)/;

function extractMediaAssetPath(snippet: string): string | null {
    const match = snippet.match(MEDIA_REGEX);
    return match ? match[1] : null;
}

function isMediaFile(path: string): 'image' | 'video' | null {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video';
    return null;
}

/** Render media thumbnail or text snippet */
function MediaSnippet({ snippet, vaultPath, query, matchSource, highlightKeywords, highlightFtsMarkers }: {
    snippet: string;
    vaultPath: string;
    query: string;
    matchSource: string;
    highlightKeywords: (text: string, q: string) => React.ReactNode;
    highlightFtsMarkers: (text: string) => React.ReactNode;
}) {
    const assetRel = extractMediaAssetPath(snippet);
    if (assetRel) {
        const mediaType = isMediaFile(assetRel);
        const absPath = `${vaultPath}/${assetRel}`;
        const src = convertFileSrc(absPath);

        if (mediaType === 'image') {
            return (
                <div className="mt-1.5 rounded-md overflow-hidden bg-black/20 border border-white/5" style={{ maxWidth: 160 }}>
                    <img
                        src={src}
                        alt="media result"
                        className="w-full h-auto object-cover"
                        style={{ maxHeight: 100 }}
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                </div>
            );
        }
        if (mediaType === 'video') {
            return (
                <div className="mt-1.5 rounded-md overflow-hidden bg-black/20 border border-white/5" style={{ maxWidth: 160 }}>
                    <video
                        src={src}
                        className="w-full h-auto object-cover"
                        style={{ maxHeight: 100 }}
                        muted
                        preload="metadata"
                        onError={(e) => { (e.target as HTMLVideoElement).style.display = 'none'; }}
                    />
                </div>
            );
        }
    }

    // Text fallback
    return (
        <div className="text-xs text-gray-400 line-clamp-2 mt-1">
            {matchSource === 'content' ? highlightKeywords(snippet, query) : highlightFtsMarkers(snippet)}
        </div>
    );
}

function getMatchSourceLabel(source: string, t: (key: string) => string) {
    switch (source) {
        case 'summary': return t('search.source_summary');
        case 'content': return t('search.source_content');
        case 'title': return t('search.source_title');
        case 'embedding': return t('search.source_embedding');
        case 'profile': return t('search.source_profile');
        case 'paragraph': return t('search.source_paragraph');
        case 'media': return '🖼️ Media';
        default: return source;
    }
}

function getMatchTypeBadge(matchType: string, t: (key: string) => string) {
    const base = "inline-flex items-center gap-0.5 px-1.5 h-5 text-[10px] rounded font-medium shrink-0";
    switch (matchType) {
        case 'keyword':
            return <span className={`${base} bg-blue-500/20 text-blue-400`}>{t('search.match_keyword')}</span>;
        case 'semantic':
            return <span className={`${base} bg-violet-500/20 text-violet-400`}><Sparkles className="w-2.5 h-2.5" />{t('search.match_semantic')}</span>;
        case 'both':
            return <span className={`${base} bg-emerald-500/20 text-emerald-400`}><Sparkles className="w-2.5 h-2.5" />{t('search.match_both')}</span>;
        case 'hyde':
            return <span className={`${base} bg-amber-500/20 text-amber-400`}><Wand2 className="w-2.5 h-2.5" />HyDE</span>;
        default: return null;
    }
}

function StrengthDots({ score }: { score: number }) {
    const level = score > 0.75 ? 4 : score > 0.5 ? 3 : score > 0.3 ? 2 : 1;
    return (
        <div className="flex gap-0.5">
            {[1, 2, 3, 4].map(i => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full ${i <= level ? 'bg-violet-400' : 'bg-gray-600'}`} />
            ))}
        </div>
    );
}

export function SearchPanel({ isOpen, onClose, onSelectNote, vaultPath }: SearchPanelProps) {
    const { t, i18n } = useTranslation();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [tasks, setTasks] = useState<TaskSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [hydeLoading, setHydeLoading] = useState(false);
    const [searchStats, setSearchStats] = useState<{ keyword: number; semantic: number; hyde: number; fallback: number; tasks: number; time: number } | null>(null);
    const [, setSelectedIndex] = useState(0);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [showLowConfidence, setShowLowConfidence] = useState(false);

    // Deep search state
    const [deepSearchResult, setDeepSearchResult] = useState<DeepSearchResultType | null>(null);
    const [deepSearchLoading, setDeepSearchLoading] = useState(false);
    const [deepSearchError, setDeepSearchError] = useState<string | null>(null);

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<NodeJS.Timeout | null>(null);
    const hydeAbortRef = useRef<boolean>(false);
    const lastQueryRef = useRef<string>('');

    // Focus input when panel opens
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    // Reset state when panel closes
    useEffect(() => {
        if (!isOpen) {
            setQuery('');
            setResults([]);
            setTasks([]);
            setSearchStats(null);
            setSelectedIndex(0);
            setHydeLoading(false);
            setExpandedPaths(new Set());
            setShowLowConfidence(false);
            setDeepSearchResult(null);
            setDeepSearchLoading(false);
            setDeepSearchError(null);
            hydeAbortRef.current = true;
        }
    }, [isOpen]);

    // Listen for HyDE results
    useEffect(() => {
        const unlisten = listen<SearchResult[]>('search:hyde-results', (event) => {
            const hydeResults = event.payload;
            if (hydeResults.length > 0) {
                setResults(prev => {
                    const existingPaths = new Set(prev.map(r => r.path));
                    const newResults = hydeResults.filter(r => !existingPaths.has(r.path));
                    return [...prev, ...newResults];
                });
                setSearchStats(prev => prev ? { ...prev, hyde: hydeResults.length } : null);
            }
        });
        return () => { unlisten.then(fn => fn()); };
    }, []);

    // Build unified items from results + tasks, split into high/low confidence
    const { highConfidenceItems, lowConfidenceItems } = useMemo(() => {
        // Group notes by path
        const groups = new Map<string, NoteSearchGroup>();
        for (const r of results) {
            const existing = groups.get(r.path);
            if (existing) {
                existing.bestScore = Math.max(existing.bestScore, r.score);
                existing.matches.push(r);
            } else {
                groups.set(r.path, { path: r.path, title: r.title, bestScore: r.score, matches: [r] });
            }
        }
        // Sort matches within each group: keyword first, then semantic, then hyde; within same type by score desc
        const typePriority: Record<string, number> = { keyword: 0, both: 1, semantic: 2, hyde: 3 };
        for (const group of groups.values()) {
            group.matches.sort((a, b) => {
                const pa = typePriority[a.match_type] ?? 9;
                const pb = typePriority[b.match_type] ?? 9;
                if (pa !== pb) return pa - pb;
                return b.score - a.score;
            });
        }
        const noteItems: UnifiedItem[] = Array.from(groups.values())
            .sort((a, b) => b.bestScore - a.bestScore)
            .map(g => ({ kind: 'note' as const, group: g }));

        const taskItems: UnifiedItem[] = tasks.map(t => ({ kind: 'task' as const, task: t }));

        // Interleave: merge by score. Tasks get fixed score 0.5
        const merged: UnifiedItem[] = [];
        let ni = 0, ti = 0;
        while (ni < noteItems.length || ti < taskItems.length) {
            const noteScore = ni < noteItems.length ? (noteItems[ni] as { kind: 'note'; group: NoteSearchGroup }).group.bestScore : -1;
            const taskScore = ti < taskItems.length ? 0.5 : -1;
            if (noteScore >= taskScore && ni < noteItems.length) {
                merged.push(noteItems[ni++]);
            } else if (ti < taskItems.length) {
                merged.push(taskItems[ti++]);
            }
        }

        // Score gap detection: find the largest drop between consecutive sorted groups
        // and fold everything below that drop if it's significant enough
        if (merged.length <= 1) {
            return { highConfidenceItems: merged, lowConfidenceItems: [] as UnifiedItem[] };
        }

        const getScore = (item: UnifiedItem) =>
            item.kind === 'note' ? item.group.bestScore : 0.5;

        // Find the largest gap between consecutive items
        let maxGap = 0;
        let splitIndex = -1;
        for (let i = 0; i < merged.length - 1; i++) {
            const gap = getScore(merged[i]) - getScore(merged[i + 1]);
            if (gap > maxGap) {
                maxGap = gap;
                splitIndex = i + 1; // fold from this index onwards
            }
        }

        // Only fold if the gap is meaningful (>= 0.10) and we'd keep at least 1 item
        if (maxGap < 0.10 || splitIndex <= 0) {
            return { highConfidenceItems: merged, lowConfidenceItems: [] as UnifiedItem[] };
        }

        const high = merged.slice(0, splitIndex);
        const low = merged.slice(splitIndex);

        return { highConfidenceItems: high, lowConfidenceItems: low };
    }, [results, tasks]);

    // Combined items for rendering (high + optionally low)
    const unifiedItems = useMemo(() => {
        if (showLowConfidence || lowConfidenceItems.length === 0) {
            return [...highConfidenceItems, ...lowConfidenceItems];
        }
        return highConfidenceItems;
    }, [highConfidenceItems, lowConfidenceItems, showLowConfidence]);

    // Deep search
    const performDeepSearch = useCallback(async (searchQuery: string, searchResults: SearchResult[]) => {
        if (searchResults.length === 0 || !searchQuery.trim()) return;
        setDeepSearchLoading(true);
        setDeepSearchError(null);
        setDeepSearchResult(null);
        try {
            // Deduplicate paths, keep order by score (best first), limit to top 5 unique notes
            const seen = new Set<string>();
            const contextPaths = searchResults.filter(r => {
                if (seen.has(r.path)) return false;
                seen.add(r.path);
                return true;
            }).slice(0, 5).map(r => r.path);
            const response = await invoke<DeepSearchResultType>('deep_search', { query: searchQuery, contextNotePaths: contextPaths, vaultPath, locale: i18n.language });
            setDeepSearchResult(response);
        } catch (e) {
            console.error('Deep search failed:', e);
            setDeepSearchError(String(e));
        } finally {
            setDeepSearchLoading(false);
        }
    }, [vaultPath, i18n.language]);

    // HyDE search
    const performHydeSearch = useCallback(async (searchQuery: string, existingPaths: string[]) => {
        if (!searchQuery.trim() || hydeAbortRef.current) return;
        setHydeLoading(true);
        try {
            const response = await invoke<HyDeSearchResult>('hyde_search', { query: searchQuery, limit: 10, existingPaths, vaultPath });
            if (lastQueryRef.current === searchQuery && !hydeAbortRef.current) {
                if (response.results.length > 0) {
                    setResults(prev => {
                        const existingPathSet = new Set(prev.map(r => r.path));
                        const newResults = response.results.filter(r => !existingPathSet.has(r.path));
                        return [...prev, ...newResults];
                    });
                    setSearchStats(prev => prev ? { ...prev, hyde: response.results.length } : null);
                }
            }
        } catch (e) {
            console.error('HyDE search failed:', e);
        } finally {
            setHydeLoading(false);
        }
    }, []);

    // Main search
    const performSearch = useCallback(async (searchQuery: string) => {
        if (!searchQuery.trim()) {
            setResults([]); setTasks([]); setSearchStats(null); setDeepSearchResult(null); setExpandedPaths(new Set());
            return;
        }
        hydeAbortRef.current = false;
        lastQueryRef.current = searchQuery;
        setLoading(true);
        setDeepSearchResult(null);
        setExpandedPaths(new Set());
        setShowLowConfidence(false);
        try {
            const response = await invoke<HybridSearchResult>('hybrid_search', { query: searchQuery, vaultPath, limit: 20 });
            setResults(response.results);
            setTasks(response.tasks);
            setSearchStats({ keyword: response.keyword_count, semantic: response.semantic_count, fallback: response.fallback_count, tasks: response.task_count, hyde: 0, time: response.total_time_ms });
            setSelectedIndex(0);
            // Quality gate: discard pure-noise results
            // Short queries have higher noise floor in embedding space, require stricter threshold
            const hasKeywordHits = response.keyword_count > 0;
            const bestScore = response.results.length > 0 ? Math.max(...response.results.map(r => r.score)) : 0;
            const wordCount = searchQuery.trim().split(/\s+/).length;
            // CJK characters carry high semantic density (e.g. "鲜花" = "flowers"),
            // so they should NOT use the strict single-word threshold meant for low-info
            // English words like "yes"/"no". Treat CJK input as multi-word.
            const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(searchQuery);
            const effectiveWordCount = hasCJK ? Math.max(wordCount, searchQuery.trim().length) : wordCount;
            const scoreThreshold = effectiveWordCount <= 1 ? 0.35 : 0.28; // cosine ~0.58 vs ~0.47
            const isConfident = hasKeywordHits || bestScore >= scoreThreshold;
            if (!isConfident) {
                // All results are low-score semantic noise — treat as "no results"
                setResults([]);
            }
            // Auto-trigger deep search when confident
            if (response.results.length > 0 && searchQuery.length >= 2 && isConfident) {
                performDeepSearch(searchQuery, response.results);
            }
            // HyDE: fallback only — skip when high-confidence results already exist
            // Trigger conditions: query long enough, no keyword hits, best semantic score weak
            const hasStrongResults = hasKeywordHits || bestScore >= 0.4;
            if (searchQuery.length >= 3 && !hasStrongResults && response.results.length > 0) {
                performHydeSearch(searchQuery, response.results.map(r => r.path));
            }
        } catch (e) {
            console.error('Search failed:', e);
            setResults([]); setTasks([]);
        } finally {
            setLoading(false);
        }
    }, [performHydeSearch, performDeepSearch]);

    const isComposingRef = useRef(false);

    const handleCompositionStart = useCallback(() => {
        isComposingRef.current = true;
        // Cancel any pending search during composition
        if (debounceRef.current) clearTimeout(debounceRef.current);
    }, []);

    const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
        isComposingRef.current = false;
        // Trigger search with the final composed text
        const value = e.currentTarget.value;
        setQuery(value);
        hydeAbortRef.current = true;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => performSearch(value), 200);
    }, [performSearch]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);
        // Skip search during IME composition (prevents half-pinyin queries like "bo l")
        if (isComposingRef.current) return;
        hydeAbortRef.current = true;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => performSearch(value), 200);
    }, [performSearch]);

    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { onClose(); }
    }, [onClose]);

    // Highlight helpers
    const highlightKeywords = useCallback((text: string, searchQuery: string) => {
        if (!searchQuery.trim() || !text) return text;
        const terms = searchQuery.split(/\s+/).filter(t => t.length > 0).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (terms.length === 0) return text;
        const regex = new RegExp(`(${terms.join('|')})`, 'gi');
        const parts = text.split(regex);
        return parts.map((part, index) => {
            const isMatch = terms.some(term => new RegExp(`^${term}$`, 'i').test(part));
            if (isMatch) return <mark key={index} className="bg-amber-400/30 text-amber-200 rounded px-0.5">{part}</mark>;
            return part;
        });
    }, []);

    const highlightFtsMarkers = useCallback((text: string) => {
        if (!text) return text;
        const parts = text.split(/(【[^】]+】)/g);
        return parts.map((part, index) => {
            if (part.startsWith('【') && part.endsWith('】')) {
                return <mark key={index} className="bg-amber-400/40 text-amber-200 rounded px-0.5 font-medium">{part.slice(1, -1)}</mark>;
            }
            return part;
        });
    }, []);

    const toggleExpand = (path: string) => {
        setExpandedPaths(prev => {
            const s = new Set(prev);
            if (s.has(path)) s.delete(path); else s.add(path);
            return s;
        });
    };

    if (!isOpen) return null;

    const noteCount = new Set(results.map(r => r.path)).size;
    const taskCount = tasks.length;
    const hasResults = unifiedItems.length > 0;

    return (
        <div className="fixed inset-0 z-10001 flex items-start justify-center pt-[10vh]">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

            {/* Search Panel */}
            <div className="relative w-full max-w-2xl mx-4 bg-[#1e1e2e] rounded-xl shadow-2xl border border-white/10 overflow-hidden max-h-[80vh] flex flex-col [&_*::selection]:bg-violet-500/40 [&_*::selection]:text-white">
                {/* Search Input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0">
                    {loading ? <Loader2 className="w-5 h-5 text-gray-400 animate-spin" /> : <Search className="w-5 h-5 text-gray-400" />}
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleCompositionStart}
                        onCompositionEnd={handleCompositionEnd}
                        placeholder={t('search.placeholder')}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="flex-1 bg-transparent text-white text-lg placeholder-gray-500 outline-none"
                    />
                    {hydeLoading && (
                        <div className="flex items-center gap-1.5 text-amber-400 text-xs">
                            <Wand2 className="w-3.5 h-3.5 animate-pulse" />
                            <span>HyDE</span>
                        </div>
                    )}
                    {query && (
                        <button
                            onClick={() => {
                                setQuery(''); setResults([]); setTasks([]); setSearchStats(null);
                                setDeepSearchResult(null); setExpandedPaths(new Set());
                                hydeAbortRef.current = true; inputRef.current?.focus();
                            }}
                            className="p-1 hover:bg-white/10 rounded transition-colors cursor-pointer"
                        >
                            <X className="w-4 h-4 text-gray-400" />
                        </button>
                    )}
                </div>


                {/* Content */}
                <div className="overflow-y-auto flex-1">
                    {query && !loading && hasResults ? (
                        <>
                            {/* Overall title */}
                            {(deepSearchResult || deepSearchLoading || deepSearchError) && (
                                <div className="px-4 pt-3 pb-1">
                                    <p className="text-xs text-gray-400">{t('search.ai_context_hint')}</p>
                                </div>
                            )}

                            {/* AI Answer Section (auto-triggered) */}
                            {(deepSearchResult || deepSearchLoading || deepSearchError) && (
                                <DeepSearchAnswer
                                    result={deepSearchResult}
                                    loading={deepSearchLoading}
                                    error={deepSearchError}
                                    onOpenNote={(path) => { onSelectNote(path); onClose(); }}
                                    vaultPath={vaultPath}
                                    t={t}
                                />
                            )}

                            {/* Divider + stats */}
                            <div className="px-4 py-2 flex items-center justify-between border-b border-white/5">
                                <span className="text-xs text-gray-500">
                                    {t('search.search_results')}
                                    {noteCount > 0 && <span className="ml-1">{t('search.notes_count', { count: noteCount })}</span>}
                                    {taskCount > 0 && <span className="ml-1">{t('search.tasks_count', { count: taskCount })}</span>}
                                </span>
                                {searchStats && <span className="text-[10px] text-gray-600">{searchStats.time}ms</span>}
                            </div>

                            {/* Unified Results */}
                            <div className="py-1">
                                {unifiedItems.map((item, _index) => {
                                    if (item.kind === 'task') {
                                        const task = item.task;
                                        return (
                                            <button
                                                key={`task-${task.id}`}
                                                onClick={() => { onSelectNote(`${vaultPath}/${task.note_path}`, task.line_number); onClose(); }}
                                                className="w-full px-4 py-2.5 flex items-start gap-3 text-left transition-colors cursor-pointer hover:bg-white/5"
                                            >
                                                {task.is_completed
                                                    ? <CheckSquare className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                                                    : <Square className="w-4 h-4 text-gray-500 mt-0.5 shrink-0" />
                                                }
                                                <div className="flex-1 min-w-0">
                                                    <div className={`text-sm ${task.is_completed ? 'text-gray-500 line-through' : 'text-white'}`}>
                                                        {highlightKeywords(task.raw_text, query)}
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        <span className="text-[10px] text-gray-500 truncate">{t('search.from_note', { title: task.note_title })}</span>
                                                        {task.due_date && <span className="text-[10px] text-amber-500">{task.due_date}</span>}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    }

                                    // Note group card
                                    const group = item.group;
                                    const hasProfile = group.matches.some((m: SearchResult) => m.match_source === 'profile');
                                    const contentMatches = group.matches.filter((m: SearchResult) => m.match_source !== 'profile');
                                    const best = contentMatches[0] || group.matches[0];
                                    const extraMatches = contentMatches.slice(1);
                                    const extraCount = extraMatches.length;
                                    const isExpanded = expandedPaths.has(group.path);

                                    // Aggregate match type counts for badges
                                    const keywordCount = contentMatches.filter((m: SearchResult) => m.match_type === 'keyword').length;
                                    const semanticCount = contentMatches.filter((m: SearchResult) => m.match_type === 'semantic' || m.match_type === 'both').length;
                                    const hydeCount = contentMatches.filter((m: SearchResult) => m.match_type === 'hyde').length;

                                    return (
                                        <div key={`note-${group.path}`} className="transition-colors hover:bg-white/5">
                                            <button
                                                onClick={() => { onSelectNote(`${vaultPath}/${group.path}`); onClose(); }}
                                                className="w-full px-4 py-2.5 flex items-start gap-3 text-left cursor-pointer"
                                            >
                                                <FileText className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className="text-white font-medium truncate text-sm">{highlightKeywords(group.title, query)}</span>
                                                        {hasProfile && <span className="inline-flex items-center h-5 px-1.5 text-[10px] rounded bg-pink-500/20 text-pink-400 font-medium shrink-0">{t('search.badge_profile')}</span>}
                                                        {keywordCount > 0 && <span className="inline-flex items-center h-5 px-1.5 text-[10px] rounded bg-blue-500/20 text-blue-400 font-medium shrink-0">{t('search.badge_keyword')}{keywordCount > 1 ? ` ×${keywordCount}` : ''}</span>}
                                                        {semanticCount > 0 && <span className="inline-flex items-center h-5 px-1.5 text-[10px] rounded bg-violet-500/20 text-violet-400 font-medium shrink-0">{t('search.badge_semantic')}{semanticCount > 1 ? ` ×${semanticCount}` : ''}</span>}
                                                        {hydeCount > 0 && <span className="inline-flex items-center h-5 px-1.5 text-[10px] rounded bg-amber-500/20 text-amber-400 font-medium shrink-0">HyDE{hydeCount > 1 ? ` ×${hydeCount}` : ''}</span>}
                                                    </div>
                                                    <div className="text-[11px] text-gray-500 truncate mt-0.5">{group.path}</div>
                                                    {best.snippet && (
                                                        <MediaSnippet
                                                            snippet={best.snippet}
                                                            vaultPath={vaultPath}
                                                            query={query}
                                                            matchSource={best.match_source}
                                                            highlightKeywords={highlightKeywords}
                                                            highlightFtsMarkers={highlightFtsMarkers}
                                                        />
                                                    )}
                                                </div>
                                                <StrengthDots score={group.bestScore} />
                                            </button>

                                            {/* Expandable extra matches (excludes profile) */}
                                            {extraCount > 0 && (
                                                <div className="pl-11 pr-4 pb-2">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); toggleExpand(group.path); }}
                                                        className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
                                                    >
                                                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                                        {t('search.extra_matches', { count: extraCount })}
                                                    </button>
                                                    {isExpanded && (
                                                        <div className="mt-1.5 space-y-1">
                                                            {extraMatches.map((m: SearchResult, mi: number) => (
                                                                <button
                                                                    key={mi}
                                                                    onClick={(e) => { e.stopPropagation(); onSelectNote(`${vaultPath}/${group.path}`); onClose(); }}
                                                                    className="flex items-center gap-2 text-xs text-gray-400 pl-3 py-1 border-l-2 border-white/5 hover:border-violet-500/50 hover:bg-white/5 rounded-r transition-colors cursor-pointer w-full text-left"
                                                                >
                                                                    {getMatchTypeBadge(m.match_type, t)}
                                                                    <span className="text-[9px] text-gray-500 shrink-0">{getMatchSourceLabel(m.match_source, t)}</span>
                                                                    {m.snippet && (
                                                                        extractMediaAssetPath(m.snippet)
                                                                            ? <span className="text-violet-400 text-[10px]">🖼️ Media</span>
                                                                            : <span className="truncate text-gray-400">{m.match_source === 'content' ? highlightKeywords(m.snippet, query) : highlightFtsMarkers(m.snippet)}</span>
                                                                    )}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Show more / collapse button for low-confidence results */}
                            {lowConfidenceItems.length > 0 && (
                                <div className="px-4 py-2 border-t border-white/5">
                                    <button
                                        onClick={() => setShowLowConfidence(prev => !prev)}
                                        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer w-full justify-center py-1"
                                    >
                                        {showLowConfidence ? (
                                            <>
                                                <ChevronDown className="w-3 h-3" />
                                                {t('search.collapse_low_relevance')}
                                            </>
                                        ) : (
                                            <>
                                                <ChevronRight className="w-3 h-3" />
                                                {t('search.show_more_results', { count: lowConfidenceItems.length })}
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </>
                    ) : query && !loading ? (
                        <div className="py-8 px-6">
                            {/* Knowledge gap insight */}
                            <div className="rounded-lg bg-violet-500/5 border border-violet-500/10 p-4 mb-4">
                                <div className="flex items-center gap-2 text-violet-400 mb-2">
                                    <Brain className="w-4 h-4" />
                                    <span className="text-xs font-medium">{t('search.insight_title')}</span>
                                </div>
                                <p className="text-sm text-gray-300">
                                    {t('search.no_results_title', { query })}
                                </p>
                                <p className="text-xs text-gray-500 mt-1.5">
                                    {t('search.no_results_hint')}
                                </p>
                            </div>
                            <div className="text-center">
                                <FileSearch className="w-8 h-8 mx-auto mb-2 text-gray-600 opacity-50" />
                                <p className="text-xs text-gray-600">{t('search.no_results_detail')}</p>
                            </div>
                        </div>
                    ) : !query ? (
                        <div className="py-12 text-center text-gray-500">
                            <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
                            <p>{t('search.empty_hint')}</p>
                            <p className="text-sm mt-1 text-gray-600">{t('search.empty_hint_detail')}</p>
                        </div>
                    ) : null}
                </div>


            </div>
        </div>
    );
}
