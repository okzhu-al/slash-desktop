import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditorServices } from '../EditorDI';

/** 索引完成后的惰性轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 10_000;
/** 最大轮询次数（10s × 30 = 5 分钟后停止） */
const MAX_POLLS = 30;

export function useMediaEnrichment(src: string | null) {
    const [enrichedText, setEnrichedText] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const { mediaService } = useEditorServices();
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollCountRef = useRef(0);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!src) return;

        // Try to parse hash from src
        const hashMatch = src.match(/([a-f0-9]{32,64})/i);
        if (!hashMatch || !mediaService.getEnrichedContent) return;

        const hash = hashMatch[1];

        let isMounted = true;
        pollCountRef.current = 0;
        stopPolling();
        setIsLoading(true);
        setEnrichedText(null);

        const fetchOnce = async (): Promise<boolean> => {
            try {
                const result = await mediaService.getEnrichedContent!(hash);
                if (isMounted) {
                    setEnrichedText(result || null);
                    setIsLoading(false);
                    return !!result;
                }
            } catch (err) {
                console.error(`[useMediaEnrichment] Failed to fetch content for ${hash}`, err);
                if (isMounted) setIsLoading(false);
            }
            return false;
        };

        // 首次查询
        fetchOnce().then((found) => {
            if (found || !isMounted) return;

            // 未找到 → 启动惰性轮询（索引可能还在后台进行）
            pollTimerRef.current = setInterval(async () => {
                pollCountRef.current++;
                if (!isMounted || pollCountRef.current > MAX_POLLS) {
                    stopPolling();
                    return;
                }
                const found = await fetchOnce();
                if (found) {
                    stopPolling();
                }
            }, POLL_INTERVAL_MS);
        });

        return () => {
            isMounted = false;
            stopPolling();
        };
    }, [src, stopPolling]);

    return { enrichedText, isLoading };
}
