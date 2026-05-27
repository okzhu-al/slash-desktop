import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

interface UseEditorAIEventsProps {
    noteId: string | null | undefined;
    noteIdRef: { current: string | null | undefined };
    setTitle: (title: string) => void;
    t: any;
}

export function useEditorAIEvents({
    noteId,
    noteIdRef,
    setTitle,
    t
}: UseEditorAIEventsProps) {
    const [isPropertiesAIRunning, setIsPropertiesAIRunning] = useState(false);
    const [isTitleAIRunning, setIsTitleAIRunning] = useState(false);

    // Flag: classification chain in progress (prerequisites → rename → classification)
    const classificationChainRef = useRef(false);

    useEffect(() => {
        // During classification chain, rename changes noteId — don't reset shimmer
        if (classificationChainRef.current) return;
        setIsPropertiesAIRunning(false);
        setIsTitleAIRunning(false);
    }, [noteId]);

    // Listen for smart-rename completion to end title shimmer & sync title
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const cleanup = await listen<{ old_path: string; new_path: string; ai_title: string; skipped?: boolean }>(
                'smart-rename:completed',
                (event) => {
                    setIsTitleAIRunning(false);
                    if (event.payload.skipped) {
                        toast.info(t('ai.contentUnchanged', '内容未变更，已跳过重命名'), { id: 'smart-rename-skip' });
                        return;
                    }
                    if (event.payload.ai_title) {
                        setTitle(event.payload.ai_title);
                    }
                }
            );
            if (cancelled) cleanup();
            else unlisten = cleanup;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [noteId, setTitle, t]);

    // Unified ai:skill-progress listener — drives per-area shimmer
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const cleanup = await listen<{ path: string; skill: string; status: string }>(
                'ai:skill-progress',
                (event) => {
                    // Use ref for matching — noteId may lag behind rename
                    const currentId = noteIdRef.current;
                    if (!currentId || !currentId.endsWith(event.payload.path)) return;
                    const { skill, status } = event.payload;

                    if (skill === 'summarization' && status === 'started') {
                        classificationChainRef.current = true;
                        setIsPropertiesAIRunning(true);
                    } else if (skill === 'tagging' && (status === 'completed' || status === 'failed' || status === 'skipped')) {
                        setIsPropertiesAIRunning(false);
                    } else if (skill === 'smart_rename' && status === 'started') {
                        setIsTitleAIRunning(true);
                    } else if (skill === 'smart_rename' && (status === 'completed' || status === 'failed' || status === 'skipped')) {
                        setIsTitleAIRunning(false);
                    } else if (skill === 'classification' && (status === 'completed' || status === 'failed' || status === 'skipped')) {
                        // Entire chain done
                        classificationChainRef.current = false;
                    }
                }
            );
            if (cancelled) cleanup();
            else unlisten = cleanup;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [noteId, noteIdRef]);

    return {
        isPropertiesAIRunning,
        setIsPropertiesAIRunning,
        isTitleAIRunning,
        setIsTitleAIRunning
    };
}
