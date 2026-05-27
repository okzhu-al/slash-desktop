/**
 * useGhostLinkManager — GhostLink 数据加载、reasoning 触发、smart-rename 事件监听
 *
 * 职责：
 * 1. ghost-link-reasons 事件监听（挂载一次，使用 ref 获取最新路径）
 * 2. smart-rename:started/completed 事件监听
 * 3. 笔记切换时加载缓存的 ghost links + 自动触发 reasoning
 * 4. triggerReasoning debounce 管理
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { normalizeRelation } from '@/shared/constants/relations';
import { thresholdCache, DEFAULT_THRESHOLD } from '@/features/graph/cache';
import type { GhostLink } from '@/features/graph/types';
import type { Note } from '@/core/storage/types';

interface UseGhostLinkManagerOptions {
    selectedNote: Note | null;
    vaultPath: string | null;
    setSelectedNote: React.Dispatch<React.SetStateAction<Note | null>>;
    setContent: React.Dispatch<React.SetStateAction<string | null>>;
    setIsNewNote: (v: boolean) => void;
}

interface GhostLinkManagerReturn {
    ghostLinksData: GhostLink[];
    setGhostLinksData: React.Dispatch<React.SetStateAction<GhostLink[]>>;
    ghostLinkReasons: Map<string, { relation: string; reason: string }>;
    setGhostLinkReasons: React.Dispatch<React.SetStateAction<Map<string, { relation: string; reason: string }>>>;
    triggerReasoning: (notePath: string, links: GhostLink[]) => void;
    prevGhostLinksRef: React.MutableRefObject<Set<string>>;
}

export function useGhostLinkManager({
    selectedNote,
    vaultPath,
    setSelectedNote,
    setContent,
    setIsNewNote,
}: UseGhostLinkManagerOptions): GhostLinkManagerReturn {
    const [ghostLinksData, setGhostLinksData] = useState<GhostLink[]>([]);
    const [ghostLinkReasons, setGhostLinkReasons] = useState<Map<string, { relation: string; reason: string }>>(new Map());

    // Stable refs
    const currentNotePathRef = useRef<string | undefined>(selectedNote?.id);
    const vaultPathRef = useRef(vaultPath);
    useEffect(() => { currentNotePathRef.current = selectedNote?.id; }, [selectedNote?.id]);
    useEffect(() => { vaultPathRef.current = vaultPath; }, [vaultPath]);

    // Track previous ghost links for novelty detection
    const prevGhostLinksRef = useRef<Set<string>>(new Set());
    const lastReasoningRequestRef = useRef<string>('');
    const reasoningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isRenamingRef = useRef(false);

    // Helper: trigger reasoning for ghost links (debounced)
    const triggerReasoning = useCallback((notePath: string, links: GhostLink[]) => {
        if (reasoningTimerRef.current) {
            clearTimeout(reasoningTimerRef.current);
            reasoningTimerRef.current = null;
        }

        reasoningTimerRef.current = setTimeout(() => {
            const targetPaths = links.map(n => n.note_path);
            const targetMtimes = links.map(n => n.mtime || 0);
            const requestHash = `${notePath}:${targetPaths.join(',')}`;
            if (requestHash === lastReasoningRequestRef.current) return;
            lastReasoningRequestRef.current = requestHash;


            invoke('get_ghost_link_reasons', {
                sourcePath: notePath,
                targetPaths,
                targetMtimes,
                targetSimilarities: links.map(n => n.similarity || 0),
            }).catch(e => console.error('[GhostLink] Failed to trigger reasoning:', e));
        }, 1000);
    }, []);

    // 🧠 Global ghost-link-reasons listener — mounted ONCE
    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let cancelled = false;

        const setupListener = async () => {
            const cleanup = await listen<{ source_path: string; results: { target_path: string; relation: string; reason: string }[]; error?: string; all_cached?: boolean }>(
                'ghost-link-reasons',
                (event) => {
                    const { source_path, results, error, all_cached } = event.payload;
                    const notePath = currentNotePathRef.current;

                    if (!notePath || source_path !== notePath) return;

                    if (all_cached) {
                        toast.info('内容未变更，已跳过关联分析', { id: 'ghostlink-skip' });
                    }

                    if (error) {
                        console.error('🧠 [GhostLink] Reasoning error:', error);
                    }

                    if (results && results.length > 0) {
                        setGhostLinkReasons(prev => {
                            const next = new Map(prev);
                            for (const r of results) {
                                if (r.target_path) {
                                    next.set(r.target_path, {
                                        relation: normalizeRelation(r.relation || 'related'),
                                        reason: r.reason || ''
                                    });
                                }
                            }
                            return next;
                        });
                    }
                }
            );
            if (cancelled) cleanup();
            else unlisten = cleanup;
        };

        setupListener();
        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, []);

    // 📝 Smart Rename listener — mounted ONCE
    useEffect(() => {
        let unlistenCompleted: UnlistenFn | null = null;
        let unlistenStarted: UnlistenFn | null = null;
        let cancelled = false;

        const setupListener = async () => {
            const cleanupStarted = await listen<{ path: string }>('smart-rename:started', (event) => {
                const { path } = event.payload;
                const currentPath = currentNotePathRef.current;
                if (currentPath && (currentPath === path || currentPath.endsWith(path) || path.endsWith(currentPath))) {

                    isRenamingRef.current = true;
                }
            });
            if (cancelled) cleanupStarted();
            else unlistenStarted = cleanupStarted;

            const cleanupCompleted = await listen<{ old_path: string; new_path: string; ai_title: string; skipped?: boolean }>('smart-rename:completed', async (event) => {
                const { old_path, new_path, ai_title, skipped } = event.payload;
                const currentPath = currentNotePathRef.current;

                if (currentPath && currentPath.endsWith(old_path)) {
                    if (skipped) {
                        isRenamingRef.current = false;
                        return;
                    }

                    const vault = vaultPathRef.current;
                    const newAbsolutePath = vault ? `${vault}/${new_path}` : new_path;

                    isRenamingRef.current = true;

                    // Migrate threshold cache
                    const oldThreshold = thresholdCache.get(currentPath);
                    if (oldThreshold !== undefined) {
                        thresholdCache.set(newAbsolutePath, oldThreshold);
                        thresholdCache.delete(currentPath);
                    }

                    currentNotePathRef.current = newAbsolutePath;

                    setSelectedNote(prev => {
                        if (!prev) return prev;
                        return { ...prev, id: newAbsolutePath, path: newAbsolutePath, title: ai_title };
                    });

                    setIsNewNote(false);

                    // Cancel pending reasoning
                    if (reasoningTimerRef.current) {
                        clearTimeout(reasoningTimerRef.current);
                        reasoningTimerRef.current = null;
                    }
                    lastReasoningRequestRef.current = '';

                    setContent(prev => prev); // Force re-render
                }
            });
            if (cancelled) cleanupCompleted();
            else unlistenCompleted = cleanupCompleted;
        };

        setupListener();
        return () => {
            cancelled = true;
            if (unlistenCompleted) unlistenCompleted();
            if (unlistenStarted) unlistenStarted();
        };
    }, []);

    // Load ghost links when note changes
    useEffect(() => {
        if (isRenamingRef.current) {
            isRenamingRef.current = false;
            lastReasoningRequestRef.current = '';
            return;
        }

        setGhostLinksData([]);
        setGhostLinkReasons(new Map());
        prevGhostLinksRef.current = new Set();
        lastReasoningRequestRef.current = '';
        if (reasoningTimerRef.current) {
            clearTimeout(reasoningTimerRef.current);
            reasoningTimerRef.current = null;
        }

        const notePath = selectedNote?.id;
        if (!notePath) return;

        const loadCachedGhostLinks = async () => {
            try {
                const result = await invoke<{ notes: GhostLink[] }>('get_ghost_links', { notePath, threshold: thresholdCache.get(notePath) ?? DEFAULT_THRESHOLD });
                if (result.notes.length > 0) {
                    prevGhostLinksRef.current = new Set(result.notes.map(n => n.note_path));
                    setGhostLinksData(result.notes);

                    try {
                        const cachedReasons = await invoke<{ target_path: string; relation: string; reason: string }[]>(
                            'get_cached_ghost_link_reasons',
                            {
                                sourcePath: notePath,
                                targetPaths: result.notes.map(n => n.note_path),
                                targetMtimes: result.notes.map(n => n.mtime || 0),
                            }
                        );
                        if (cachedReasons.length > 0) {
                            const reasonsMap = new Map<string, { relation: string; reason: string }>();
                            for (const r of cachedReasons) {
                                reasonsMap.set(r.target_path, { relation: r.relation, reason: r.reason });
                            }
                            setGhostLinkReasons(prev => {
                                const merged = new Map(prev);
                                for (const [k, v] of reasonsMap) merged.set(k, v);
                                return merged;
                            });

                            const uncachedLinks = result.notes.filter(n => !reasonsMap.has(n.note_path));
                            if (uncachedLinks.length > 0) {
                                triggerReasoning(notePath, result.notes);
                            }
                        } else {
                            triggerReasoning(notePath, result.notes);
                        }
                    } catch {
                        triggerReasoning(notePath, result.notes);
                    }
                }
            } catch {
                // Silent - no ghost links available yet
            }
        };

        loadCachedGhostLinks();
    }, [selectedNote?.id]);

    return {
        ghostLinksData,
        setGhostLinksData,
        ghostLinkReasons,
        setGhostLinkReasons,
        triggerReasoning,
        prevGhostLinksRef,
    };
}
