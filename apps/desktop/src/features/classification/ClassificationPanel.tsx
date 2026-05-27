import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { FolderArchive, Check, Loader2, Sparkles, FolderPlus, ChevronDown, ChevronUp, Search, Plus, Wand2 } from 'lucide-react';
import { cn } from '@/shared/utils/cn';

// Ref for auto-scrolling to custom folder section


import { classificationResultCache, type ClassificationSuggestion, type ClassificationResult } from '@/features/classification/cache';

interface SkillProgress {
    skill: string;
    status: 'pending' | 'running' | 'completed';
    preview?: string;
}

import { runSkillChain } from '@/features/ai/orchestrator';

interface ClassificationPanelProps {
    notePath: string;
    noteTitle: string;
    noteContent: string;
    vaultPath: string;
    onClose: () => void;
    onMoved?: (newPath: string) => void;
}

export function ClassificationPanel({
    notePath,
    noteTitle,
    noteContent,
    vaultPath,
    onClose,
    onMoved,
}: ClassificationPanelProps) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ClassificationResult | null>(null);
    const [movingIndex, setMovingIndex] = useState<number | null>(null);
    const [skillProgress, setSkillProgress] = useState<SkillProgress[]>([]);

    // Custom folder selection state
    const [showCustomFolder, setShowCustomFolder] = useState(false);
    const customFolderRef = useRef<HTMLDivElement>(null);
    const [allFolders, setAllFolders] = useState<string[]>([]);
    const [folderSearch, setFolderSearch] = useState('');
    const [newFolderPath, setNewFolderPath] = useState('');
    const [isMovingCustom, setIsMovingCustom] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);

    // Get relative path for display
    const relativePath = notePath.startsWith(vaultPath)
        ? notePath.slice(vaultPath.length).replace(/^\//, '')
        : notePath;

    const currentFolder = relativePath.split('/').slice(0, -1).join('/') || t('classification.root_folder');

    // Filtered folders based on search
    const filteredFolders = useMemo(() => {
        if (!folderSearch) return allFolders;
        const search = folderSearch.toLowerCase();
        return allFolders.filter(f => f.toLowerCase().includes(search));
    }, [allFolders, folderSearch]);

    // Autocomplete suggestions for new folder path
    const pathSuggestions = useMemo(() => {
        if (!newFolderPath) return [];
        const input = newFolderPath.toLowerCase();
        return allFolders
            .filter(f => f.toLowerCase().startsWith(input))
            .slice(0, 5);
    }, [allFolders, newFolderPath]);

    // Guard: track current request ID (counter) to prevent stale results
    // Path-based stale check fails when smart_rename changes the path mid-flight
    const loadingRequestRef = useRef<number>(0);

    // Always-current notePath ref — closures read this instead of stale prop
    const notePathRef = useRef(notePath);
    notePathRef.current = notePath;

    useEffect(() => {
        if (loadingRequestRef.current > 0) {
            // An active request is in flight (rename changed path mid-flight) — keep progress intact
            // The loadSuggestions closure will cache under the NEW notePath when it completes
            return;
        }
        // Genuine note switch — reset transient state
        setMovingIndex(null);
        setSkillProgress([]);

        // Restore cached result: try memory first, then DB
        const cached = classificationResultCache.get(notePath);
        if (cached) {
            setResult(cached);
            setLoading(false);
        } else {
            // Try loading from backend DB cache (persists across app restarts)
            setResult(null);
            setLoading(false);
            invoke<ClassificationResult | null>('get_cached_classification', { notePath })
                .then((dbCached) => {
                    console.debug('📦 [Classification] DB cache result:', dbCached ? `${dbCached.suggestions.length} suggestions` : 'null');
                    if (dbCached && dbCached.suggestions.length > 0) {
                        setResult(dbCached);
                        // Also populate memory cache for quick access
                        classificationResultCache.set(notePath, dbCached);
                    }
                })
                .catch((e) => {
                    console.error('📦 [Classification] Cache load failed:', e);
                });
        }
    }, [notePath]);

    // Listen for real backend queue events
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            unlisten = await listen<{ note_path: string; skill: string; status: string; message?: string | null }>(
                'ai:job-status',
                (event) => {
                    const { note_path, skill, status, message } = event.payload;
                    if (!note_path.endsWith(notePath.split('/').pop() || '')) return; // Simple safety check for current note
                    
                    if (status === 'queued' || status === 'processing') {
                        setSkillProgress(prev => {
                            if (prev.length === 0) {
                                return [
                                    { skill: 'summarization', status: skill === 'summarization' ? (status === 'processing' ? 'running' : 'pending') : 'pending' },
                                    { skill: 'tagging', status: skill === 'tagging' ? (status === 'processing' ? 'running' : 'pending') : 'pending' },
                                    { skill: 'smart_rename', status: skill === 'smart_rename' ? (status === 'processing' ? 'running' : 'pending') : 'pending' },
                                    { skill: 'classification', status: skill === 'classification' ? (status === 'processing' ? 'running' : 'pending') : 'pending' },
                                ];
                            }
                            return prev.map(s =>
                                s.skill === skill ? { ...s, status: status === 'processing' ? 'running' : 'pending' } : s
                            );
                        });
                    } else if (status === 'success') {
                        setSkillProgress(prev => prev.map(s =>
                            s.skill === skill
                                ? { ...s, status: 'completed' as const }
                                : s
                        ));
                    } else if (status === 'failed') {
                        setSkillProgress(prev => prev.map(s =>
                            s.skill === skill
                                ? { ...s, status: 'completed' as const, preview: message ? `⚠️ ${message}` : '⚠️ Failed' }
                                : s
                        ));
                    }
                }
            );
        })();
        return () => { unlisten?.(); };
    }, [notePath]);

    async function loadSuggestions() {
        // Increment request ID — counter survives rename mid-flight (unlike path comparison)
        const requestId = ++loadingRequestRef.current;

        setLoading(true);
        setError(null);

        try {
            // Orchestrate prerequisites chain (Summary -> Tag -> Rename -> Classify)
            // This ensures we have fresh data for classification
            // Note: runSkillChain might trigger rename!
            const resolvedPath = await runSkillChain(notePathRef.current, noteContent, 'classify');

            // Stale check: if a newer request was started, discard this result
            if (requestId !== loadingRequestRef.current) return;

            // Update ref in case rename happened invisible to props yet
            notePathRef.current = resolvedPath;

            await invoke('refresh_folder_embeddings');

            // Mark classification step as running before the LLM call
            setSkillProgress(prev => prev.map(s =>
                s.skill === 'classification' ? { ...s, status: 'running' as const } : s
            ));

            const res = await invoke<ClassificationResult>('get_classification_suggestions', {
                notePath: resolvedPath,
            });

            // Stale check again after LLM
            if (requestId !== loadingRequestRef.current) return;

            // Mark classification step as completed
            setSkillProgress(prev => prev.map(s =>
                s.skill === 'classification' ? { ...s, status: 'completed' as const } : s
            ));
            setResult(res);
            // Cache under CURRENT path (notePathRef survives rename mid-flight)
            classificationResultCache.set(notePathRef.current, res);
            // If result is cached (no LLM was called), show toast
            if (res.query_profile === '[Cached]') {
                toast.info('内容未变更，已跳过归档分析', { id: 'classification-skip' });
            }
            // Properties refresh handled by ai:note-updated event
        } catch (e) {
            if (requestId === loadingRequestRef.current) {
                setError(String(e));
            }
        } finally {
            if (requestId === loadingRequestRef.current) {
                setLoading(false);
                // Notify Editor that the entire chain (prerequisites + classification) is done
                emit('ai:skill-progress', {
                    path: notePathRef.current.split('/').slice(-2).join('/'),
                    skill: 'classification',
                    status: 'completed',
                });
                loadingRequestRef.current = 0; // Mark no active request
            }
        }
    }

    async function loadAllFolders() {
        try {
            const folders = await invoke<string[]>('get_all_available_folders');
            setAllFolders(folders);
        } catch (e) {
            console.error('Failed to load folders:', e);
        }
    }

    async function handleAccept(suggestion: ClassificationSuggestion, index: number) {
        setMovingIndex(index);
        try {
            const newPath = await invoke<string>('accept_classification', {
                notePath,
                targetFolder: suggestion.folder_path,
                createIfNotExists: suggestion.decision === 'create',
            });
            onMoved?.(newPath);
            onClose();
        } catch (e) {
            setError(String(e));
            setMovingIndex(null);
        }
    }

    async function handleCustomMove(folderPath: string, createNew: boolean) {
        setIsMovingCustom(true);
        setError(null);
        try {
            const newPath = await invoke<string>('accept_classification', {
                notePath,
                targetFolder: folderPath,
                createIfNotExists: createNew,
            });
            onMoved?.(newPath);
            onClose();
        } catch (e) {
            setError(String(e));
            setIsMovingCustom(false);
        }
    }

    function handleToggleCustomFolder() {
        const newState = !showCustomFolder;
        setShowCustomFolder(newState);
        if (newState && allFolders.length === 0) {
            loadAllFolders();
        }
        // Auto-scroll to make the custom folder section visible after expanding
        if (newState) {
            setTimeout(() => {
                customFolderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }

    // Handle Tab key for autocomplete
    const handleNewFolderKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Tab' && pathSuggestions.length > 0) {
            e.preventDefault();
            // Complete to the first matching suggestion
            const suggestion = pathSuggestions[0];
            setNewFolderPath(suggestion + '/');
            setShowSuggestions(false);
        } else if (e.key === 'Enter' && newFolderPath.trim()) {
            e.preventDefault();
            handleCustomMove(newFolderPath.trim(), true);
        } else if (e.key === 'Escape') {
            setShowSuggestions(false);
        }
    }, [pathSuggestions, newFolderPath]);

    // Select a suggestion and append to path
    const handleSelectSuggestion = useCallback((suggestion: string) => {
        setNewFolderPath(suggestion + '/');
        setShowSuggestions(false);
    }, []);

    return (
        <div className="flex flex-col h-full bg-(--bg-primary)">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 h-12 border-b border-zinc-200 dark:border-zinc-700">
                <div className="flex items-center gap-2">
                    <FolderArchive className="w-4 h-4 text-(--accent-primary)" />
                    <span className="font-medium text-sm">{t('classification.title')}</span>
                </div>
                <button
                    onClick={() => {
                        loadSuggestions();
                    }}
                    disabled={loading || isMovingCustom}
                    className={cn(
                        "p-1 rounded-md transition-all duration-300 disabled:opacity-50",
                        "text-[#002FA7] dark:text-[#002FA7]",
                        "magic-wand-breathe"
                    )}
                    title={t('classification.reanalyze')}
                >
                    <Wand2 size={16} />
                </button>
            </div>

            {/* Note Info */}
            <div className="px-4 py-3 border-b border-(--border-secondary) bg-(--bg-secondary)">
                <div className="text-sm font-medium text-(--text-primary) truncate">
                    {noteTitle}
                </div>
                <div className="text-xs text-(--text-tertiary) mt-1">
                    {t('classification.current_location')}: {currentFolder}
                </div>
                {result?.has_pending_tasks && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-amber-500">
                        <Sparkles className="w-3 h-3" />
                        <span>{t('classification.has_pending_tasks')}</span>
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-scroll p-4">
                {loading && (
                    <div className="flex flex-col gap-2 py-4">
                        {skillProgress.length > 0 ? (
                            skillProgress.map((step) => (
                                <div key={step.skill} className="flex items-start gap-2 px-1">
                                    {step.status === 'completed' ? (
                                        <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                                    ) : step.status === 'running' ? (
                                        <Loader2 className="w-4 h-4 text-[#002FA7] dark:text-[#002FA7] animate-spin mt-0.5 shrink-0" />
                                    ) : (
                                        <div className="w-4 h-4 rounded-full border border-zinc-200 dark:border-zinc-700 mt-0.5 shrink-0" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <span className={`text-sm ${step.status === 'completed' ? 'text-(--text-primary)' :
                                            step.status === 'running' ? 'text-(--text-primary) title-shimmer' :
                                                'text-(--text-tertiary)'
                                            }`}>
                                            {step.skill === 'summarization' ? t('classification.step_summary') :
                                                step.skill === 'tagging' ? t('classification.step_tagging') :
                                                    step.skill === 'smart_rename' ? t('classification.step_rename') :
                                                        t('classification.step_classification')}
                                        </span>
                                        {step.status === 'completed' && step.preview && (
                                            <div className="text-xs text-(--text-tertiary) mt-0.5 typing-reveal truncate">
                                                {step.preview}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-(--text-secondary)">
                                <Loader2 className="w-6 h-6 animate-spin mb-2" />
                                <span className="text-sm">{t('classification.analyzing')}</span>
                            </div>
                        )}
                    </div>
                )}

                {error && (
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                        {error}
                    </div>
                )}

                {!loading && !error && result && (
                    <div className="space-y-3">
                        <div className="text-xs text-(--text-tertiary) mb-2">
                            {t('classification.ai_recommend')}
                        </div>

                        {result.suggestions.length === 0 ? (
                            <div className="text-sm text-(--text-secondary) text-center py-4">
                                {t('classification.no_results')}
                            </div>
                        ) : (
                            result.suggestions.map((suggestion, index) => (
                                <div
                                    key={index}
                                    className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-(--bg-secondary)"
                                >
                                    <div className="flex items-start gap-2">
                                        {suggestion.decision === 'create' ? (
                                            <FolderPlus className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                                        ) : (
                                            <FolderArchive className="w-4 h-4 text-(--accent-primary) mt-0.5 shrink-0" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-(--text-primary) break-all">
                                                {suggestion.folder_path}
                                            </div>
                                            {suggestion.similarity > 0 && (
                                                <div className="text-xs text-(--text-tertiary) mt-1">
                                                    {t('classification.similarity')}: {Math.round(suggestion.similarity * 100)}%
                                                </div>
                                            )}
                                            <div className="text-xs text-(--text-secondary) mt-1">
                                                {suggestion.reason}
                                            </div>
                                            {suggestion.decision === 'create' && (
                                                <div className="text-xs text-emerald-400 mt-1">
                                                    {t('classification.will_create')}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex gap-2 mt-3 pt-2 border-t border-(--border-secondary)">
                                        <button
                                            onClick={() => handleAccept(suggestion, index)}
                                            disabled={movingIndex !== null || isMovingCustom}
                                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-violet-500 text-white text-xs font-medium hover:bg-violet-600 transition-colors disabled:opacity-50"
                                        >
                                            {movingIndex === index ? (
                                                <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                                <Check className="w-3 h-3" />
                                            )}
                                            {movingIndex === index ? t('classification.moving') : t('classification.confirm_move')}
                                        </button>
                                        <button
                                            onClick={async () => {
                                                if (!result) return;
                                                const updatedSuggestions = result.suggestions.filter((_, i) => i !== index);
                                                const updatedResult = {
                                                    ...result,
                                                    suggestions: updatedSuggestions,
                                                };
                                                setResult(updatedResult);

                                                // 1. 同步更新前端内存缓存
                                                classificationResultCache.set(notePath, updatedResult);

                                                // 2. 调用后端持久化回写 SQLite classification_cache 表
                                                try {
                                                    await invoke('save_classification_suggestions', {
                                                        notePath,
                                                        result: updatedResult,
                                                    });
                                                } catch (e) {
                                                    console.error('Failed to save classification cache after ignore:', e);
                                                }
                                            }}
                                            disabled={movingIndex !== null || isMovingCustom}
                                            className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-(--text-secondary) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-50"
                                        >
                                            {t('classification.ignore')}
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}

                        {/* Custom Folder Selection */}
                        {/* ref for auto-scroll on expand */}
                        <div ref={customFolderRef} className="mt-4 pt-3 border-t border-(--border-secondary)">
                            <button
                                onClick={handleToggleCustomFolder}
                                disabled={movingIndex !== null || isMovingCustom}
                                className="w-full flex items-center justify-between px-3 py-2 rounded border border-zinc-200 dark:border-zinc-700 text-(--text-secondary) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-50"
                            >
                                <span>{t('classification.custom_folder')}</span>
                                {showCustomFolder ? (
                                    <ChevronUp className="w-4 h-4" />
                                ) : (
                                    <ChevronDown className="w-4 h-4" />
                                )}
                            </button>

                            {showCustomFolder && (
                                <div className="mt-3 space-y-3">
                                    {/* Search existing folders */}
                                    <div className="relative">
                                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-(--text-tertiary)" />
                                        <input
                                            type="text"
                                            value={folderSearch}
                                            onChange={(e) => setFolderSearch(e.target.value)}
                                            placeholder={t('classification.search_folders')}
                                            className="w-full pl-7 pr-3 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 bg-(--bg-secondary) text-sm text-(--text-primary) placeholder:text-(--text-tertiary) focus:outline-none focus:border-(--accent-primary)"
                                        />
                                    </div>

                                    {/* Folder list */}
                                    <div className="max-h-40 overflow-y-auto space-y-1 rounded border border-(--border-secondary) p-1">
                                        {filteredFolders.length === 0 ? (
                                            <div className="text-xs text-(--text-tertiary) text-center py-2">
                                                {folderSearch ? t('classification.no_matching') : t('classification.loading_folders')}
                                            </div>
                                        ) : (
                                            filteredFolders.map((folder) => (
                                                <button
                                                    key={folder}
                                                    onClick={() => handleCustomMove(folder, false)}
                                                    disabled={isMovingCustom}
                                                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs text-(--text-primary) hover:bg-(--bg-tertiary) transition-colors disabled:opacity-50"
                                                >
                                                    <FolderArchive className="w-3 h-3 text-(--text-tertiary) shrink-0" />
                                                    <span className="truncate" title={folder}>{folder}</span>
                                                </button>
                                            ))
                                        )}
                                    </div>

                                    {/* Create new folder with Tab autocomplete */}
                                    <div className="space-y-2">
                                        <div className="text-xs text-(--text-tertiary)">
                                            {t('classification.create_new')} <span className="text-(--text-quaternary)">{t('classification.create_hint')}</span>
                                        </div>
                                        <div className="relative">
                                            <Plus className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-(--text-tertiary)" />
                                            <input
                                                type="text"
                                                value={newFolderPath}
                                                onChange={(e) => {
                                                    setNewFolderPath(e.target.value);
                                                    setShowSuggestions(true);
                                                }}
                                                onKeyDown={handleNewFolderKeyDown}
                                                onFocus={() => setShowSuggestions(true)}
                                                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                                                placeholder={t('classification.path_placeholder')}
                                                className="w-full pl-7 pr-3 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 bg-(--bg-secondary) text-sm text-(--text-primary) placeholder:text-(--text-tertiary) focus:outline-none focus:border-(--accent-primary)"
                                            />
                                        </div>

                                        {/* Inline autocomplete suggestions */}
                                        {showSuggestions && pathSuggestions.length > 0 && (
                                            <div className="space-y-0.5">
                                                {pathSuggestions.map((suggestion) => (
                                                    <button
                                                        key={suggestion}
                                                        onMouseDown={(e) => {
                                                            e.preventDefault();
                                                            handleSelectSuggestion(suggestion);
                                                        }}
                                                        className="w-full flex items-center gap-2 px-2 py-1 text-left text-xs text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-tertiary) rounded transition-colors"
                                                    >
                                                        <FolderArchive className="w-3 h-3 text-(--text-tertiary) shrink-0" />
                                                        <span className="truncate" title={suggestion}>{suggestion}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>


        </div>
    );
}
