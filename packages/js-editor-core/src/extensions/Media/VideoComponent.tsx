import { NodeViewWrapper } from '@tiptap/react';
import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorServices } from '../../EditorDI';
import { useMediaEnrichment } from '../../hooks/useMediaEnrichment';

// Global URL cache to prevent redundant async resolution
const urlCache = new Map<string, string>();

interface VideoComponentProps {
    node: any;
    updateAttributes: (attrs: any) => void;
}

const VideoComponentInner = ({ node, updateAttributes }: VideoComponentProps) => {
    const { src, width } = node.attrs;
    const [resolvedSrc, setResolvedSrc] = useState<string>(() => {
        // Check cache synchronously on mount
        return urlCache.get(src) || '';
    });
    const [currentWidth, setCurrentWidth] = useState<number | null>(width || null);
    const [retryCount, setRetryCount] = useState(0);
    const [resizing, setResizing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [failed, setFailed] = useState(false);
    const [, setZoomInfo] = useState('');
    const [, setRealZoom] = useState<number>(1);
    const [isInView, setIsInView] = useState(false);
    const widthRef = useRef<number | null>(currentWidth);
    const containerRef = useRef<HTMLDivElement>(null);
    const lastSrcRef = useRef<string>(src);

    // Keep ref in sync with state
    useEffect(() => {
        widthRef.current = currentWidth;
    }, [currentWidth]);

    // Sync with prop changes
    useEffect(() => {
        setCurrentWidth(width || null);
    }, [width]);

    const { fileSystemStore, mediaService, EnrichmentHoverCard } = useEditorServices();
    const { t } = useTranslation();
    const [root, setRoot] = useState(() => fileSystemStore?.root || null);

    useEffect(() => {
        if (!fileSystemStore?.subscribe) return;
        const unsubscribe = fileSystemStore.subscribe((state: any) => {
            setRoot(state.root || null);
        });
        return unsubscribe;
    }, [fileSystemStore]);

    const isTeamSpace = fileSystemStore.isTeamSpace;
    const { enrichedText } = useMediaEnrichment(src);

    // Helper function to check if a URL is valid (not a raw relative path)
    const isValidResolvedUrl = (url: string) => {
        return url && (
            url.startsWith('http') ||
            url.startsWith('asset:') ||
            url.startsWith('blob:')
        );
    };

    // Resolve video URL - only when src actually changes, root becomes available, or retry is triggered
    useEffect(() => {
        // Check if current resolvedSrc is actually valid
        const hasValidResolvedUrl = isValidResolvedUrl(resolvedSrc);

        if (!isInView && !hasValidResolvedUrl) {
            return; // Wait until component enters viewport to resolve
        }

        // Skip ONLY if we have a VALID resolved URL (not a raw relative path)
        if (lastSrcRef.current === src && hasValidResolvedUrl && retryCount === 0) {
            return;
        }

        // Force re-resolve if src changed, no valid resolved URL, or retrying
        const needsResolve = lastSrcRef.current !== src || !hasValidResolvedUrl || retryCount > 0;

        if (needsResolve) {
            lastSrcRef.current = src;

            // Check cache first (skip cache on retry to force fresh resolution)
            if (retryCount === 0) {
                const cached = urlCache.get(src);
                if (cached && isValidResolvedUrl(cached)) {
                    setResolvedSrc(cached);
                    return;
                }
            } else {
                // Clear cache on retry to force fresh resolution
                urlCache.delete(src);
            }

            let isMounted = true;
            const resolve = async () => {
                if (!src) return;

                // Wait for root to be available if using relative path
                if (!root && !src.startsWith('http') && !src.startsWith('asset')) {
                    // Clear any invalid resolved URL so we don't show the player
                    if (resolvedSrc && !isValidResolvedUrl(resolvedSrc)) {
                        setResolvedSrc('');
                    }
                    return;
                }

                try {
                    // Pass root.path explicitly to ensure MediaService has it
                    let url = await mediaService.getAssetUrl(src, root?.path);

                    // Validate the returned URL - if MediaService returned a raw path, it's invalid
                    if (!isValidResolvedUrl(url)) {
                        console.warn(`[Video] MediaService returned invalid URL: ${url}, waiting for root...`);
                        return;
                    }

                    // Append timestamp on retry to bust any browser/WebView cache
                    if (retryCount > 0) {
                        const separator = url.includes('?') ? '&' : '?';
                        url = `${url}${separator}_retry=${Date.now()}`;
                    }

                    if (isMounted) {
                        if (retryCount === 0) {
                            urlCache.set(src, url);
                        }
                        setResolvedSrc(url);
                    }
                } catch (e) {
                    console.error("❌ Failed to resolve video src:", src, e);
                }
            };
            resolve();
            return () => { isMounted = false; };
        }
    }, [src, root, retryCount, isInView]);

    // IntersectionObserver for lazy loading
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    setIsInView(true);
                    observer.disconnect(); // Only need to load once
                }
            },
            { rootMargin: '200px' } // Load slightly before it comes into view
        );

        observer.observe(container);

        // Track zoom dynamically
        const updateZoomInfo = () => {
            if (containerRef.current) {
                const style = window.getComputedStyle(containerRef.current);
                const cssZoom = style.zoom || style.getPropertyValue('zoom') || '1';
                
                const physicalWidth = containerRef.current.getBoundingClientRect().width;
                const layoutWidth = containerRef.current.offsetWidth;
                const realZoomCalc = layoutWidth > 0 ? physicalWidth / layoutWidth : 1;
                
                setZoomInfo(`CSS: ${cssZoom} | Real: ${realZoomCalc.toFixed(2)}`);
                setRealZoom(realZoomCalc);
            }
        };
        updateZoomInfo();
        const interval = setInterval(updateZoomInfo, 500);

        return () => {
            observer.disconnect();
            clearInterval(interval);
        };
    }, []);

    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const container = containerRef.current;
        if (!container) return;

        const startX = e.clientX;
        const startWidth = container.getBoundingClientRect().width;

        setResizing(true);

        const onMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const delta = moveEvent.clientX - startX;
            const newWidth = Math.max(100, startWidth + delta);
            setCurrentWidth(newWidth);
            widthRef.current = newWidth;
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            setResizing(false);
            if (widthRef.current !== null) {
                updateAttributes({ width: Math.round(widthRef.current) });
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }, [updateAttributes]);

    // Show border and handle when hovered or resizing (not when selected via editor selection)
    const isActive = isHovered || resizing;

    // Check if format is supported by browser
    const ext = src?.split('.').pop()?.toLowerCase() || '';
    const isSupported = ['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(ext);

    const handleOpenExternal = useCallback(async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        await mediaService.openAsset(src);
    }, [src]);

    // 🛡️ Phase 6: 导入中/失败状态检测
    const isImporting = src?.includes('_importing_');
    const isImportFailed = src?.includes('_import_failed_');

    // 🛡️ Phase 6: Team asset 下载中检测（本地文件不存在，等待 TransferManager 下载）
    const isAssetPendingDownload = failed && src?.includes('assets/');

    // 提取 asset 相对路径（去掉前缀路径）
    const assetRelPath = React.useMemo(() => {
        if (!src) return '';
        const match = src.match(/(assets\/[^\s]+)/);
        return match ? match[1] : '';
    }, [src]);

    // ref 防止同一个 asset 重复 invoke
    const recoverAttemptedRef = useRef<string>('');

    // 资产缺失时：主动调用 recoverMissingAsset + 监听 download-completed 事件
    useEffect(() => {
        if (!isAssetPendingDownload || !assetRelPath) return;

        // 首次进入 pending download 状态时，触发一次 recover
        if (recoverAttemptedRef.current !== assetRelPath && mediaService.recoverMissingAsset) {
            recoverAttemptedRef.current = assetRelPath;
            mediaService.recoverMissingAsset(assetRelPath)
                .catch((err) => {
                    console.warn(`[VideoComponent] recover failed: path=${assetRelPath}`, err);
                });
        }

        // 监听 download completed → 精准刷新
        let unlistenFn: (() => void) | null = null;
        let isCancelled = false;

        if (mediaService.onTransferDownloadCompleted) {
            mediaService.onTransferDownloadCompleted((payload) => {
                if (payload.asset_path === assetRelPath) {
                    recoverAttemptedRef.current = ''; // 允许再次 recover（如果未来再次丢失）
                    setFailed(false);
                    setRetryCount(prev => prev + 1);
                }
            }).then(fn => {
                if (isCancelled) {
                    fn(); // 瞬间解绑防泄漏
                } else {
                    unlistenFn = fn;
                }
            });
        }

        // 兜底：30 秒后检测一次（防止事件丢失）
        const fallbackTimer = setTimeout(() => {
            setFailed(false);
            setRetryCount(prev => prev + 1);
        }, 30000);

        return () => {
            isCancelled = true;
            clearTimeout(fallbackTimer);
            if (unlistenFn) unlistenFn();
        };
    }, [isAssetPendingDownload, assetRelPath, mediaService]);

    // Determine if we show the video player or a loader
    // Only show player when we have a valid resolved URL (not raw relative path)
    const hasValidUrl = resolvedSrc && (
        resolvedSrc.startsWith('http') ||
        resolvedSrc.startsWith('asset:') ||
        resolvedSrc.startsWith('blob:')
    );
    const showPlayer = !isImporting && !isImportFailed && (hasValidUrl || src.startsWith('http') || src.startsWith('asset:'));

    const [isPlaying, setIsPlaying] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);

    const togglePlay = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
            } else {
                videoRef.current.play();
            }
            setIsPlaying(!isPlaying);
        }
    };

    return (
        <NodeViewWrapper
            className="video-view"
            style={{ textAlign: 'left', display: 'block', clear: 'both' }}
        >
            <div
                ref={containerRef}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => !resizing && setIsHovered(false)}
                onClick={togglePlay}
                style={{
                    position: 'relative',
                    width: currentWidth !== null ? `${currentWidth}px` : 'fit-content',
                    display: 'flex',
                    flexDirection: 'column',
                    maxWidth: '100%',
                    cursor: 'pointer',
                    borderRadius: '8px',
                    boxShadow: isActive ? '0 0 0 2px rgb(99 102 241)' : 'none',
                    transition: 'box-shadow 0.15s ease',
                    lineHeight: 0,
                    fontSize: 0,
                }}
                className="group"
            >
                <EnrichmentHoverCard content={enrichedText}>
                {failed && isAssetPendingDownload ? (
                    /* Asset 恢复中：显示等待恢复 UI */
                    <div className="media-placeholder media-placeholder--syncing">
                        <div className="media-placeholder__icon">
                            <svg className="media-placeholder__spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                        </div>
                        <span className="media-placeholder__text">
                            {t('media.recovering_asset', '正在恢复媒体文件…')}
                        </span>
                    </div>
                ) : failed && isTeamSpace ? (
                    <div 
                        className="flex flex-col items-center justify-center p-6 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg text-amber-700 dark:text-amber-400"
                        style={{ width: '100%', minHeight: '120px', backgroundColor: 'transparent' }}
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mb-2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            <line x1="12" y1="9" x2="12" y2="13"/>
                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        <div className="text-sm font-medium text-center">
                            {t('media.team_size_limit_fallback', '视频文件超出团队文件大小限制，无法同步到团队空间')}
                        </div>
                    </div>
                ) : isSupported ? (
                    showPlayer ? (
                        <div className="relative flex flex-col w-full overflow-hidden rounded-lg bg-black" style={{ lineHeight: 0, fontSize: 0 }}>
                        <video
                            ref={videoRef}
                            src={(hasValidUrl ? resolvedSrc : src).includes('#') ? (hasValidUrl ? resolvedSrc : src) : `${hasValidUrl ? resolvedSrc : src}#t=0.001`}
                            controls={false}
                            preload="metadata"
                            style={{
                                width: '100%',
                                height: 'auto',
                                display: 'block',
                                backgroundColor: '#000', // Force black background
                                margin: 0,
                                padding: 0,
                                outline: 'none',
                                border: 'none',
                                lineHeight: 0,
                            }}
                            onEnded={() => setIsPlaying(false)}
                            onError={(e) => {
                                console.error(`❌ [VideoComponent] Playback error for ${resolvedSrc || src} (Retry: ${retryCount}):`, e.currentTarget.error);
                                if (retryCount < 3) {
                                    setTimeout(() => setRetryCount(prev => prev + 1), 500 * Math.pow(2, retryCount));
                                } else {
                                    setFailed(true);
                                }
                            }}
                            onLoadedMetadata={() => setFailed(false)}
                        />
                        
                        <div 
                            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100 bg-black/10'}`}
                        >
                            <div className="bg-black/60 text-white rounded-full p-4 backdrop-blur-md shadow-xl transform transition-transform hover:scale-110">
                                {isPlaying ? (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                                        <rect x="6" y="4" width="4" height="16" />
                                        <rect x="14" y="4" width="4" height="16" />
                                    </svg>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" className="ml-1">
                                        <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                )}
                            </div>
                        </div>
                        </div>
                    ) : (
                        <div className={`media-placeholder ${
                            isImportFailed ? 'media-placeholder--failed'
                            : isImporting ? 'media-placeholder--importing'
                            : 'media-placeholder--syncing'
                        }`}>
                            <div className="media-placeholder__icon">
                                {isImportFailed ? (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <path d="m15 9-6 6" />
                                        <path d="m9 9 6 6" />
                                    </svg>
                                ) : isImporting ? (
                                    <svg className="media-placeholder__spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                    </svg>
                                ) : (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="m22 8-6 4 6 4V8Z" />
                                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                    </svg>
                                )}
                            </div>
                            <span className="media-placeholder__text">
                                {isImportFailed
                                    ? t('media.import_failed_hint', '导入失败，请删除后重试')
                                    : isImporting
                                    ? t('media.importing', '导入中...')
                                    : src?.includes('assets/')
                                    ? t('media.syncing_asset', '正在同步资源...')
                                    : root ? t('media.resolving', '解析中...') : t('media.loading', '加载中...')
                                }
                            </span>
                        </div>
                    )
                ) : (
                    // Unsupported Format Card (e.g. MKV, AVI)
                    <div
                        onClick={handleOpenExternal}
                        className="group relative flex items-center gap-3 p-3 bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
                        style={{
                            boxShadow: isActive ? '0 0 0 2px rgb(99 102 241)' : 'none',
                            userSelect: 'none'
                        }}
                        title="Click to open in system player"
                    >
                        <div className="flex items-center justify-center w-10 h-10 bg-indigo-100 dark:bg-indigo-900/30 rounded-full text-indigo-600 dark:text-blue-400">
                            {/* File Video Icon */}
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                                <polyline points="14 2 14 8 20 8" />
                                <path d="m10 15 5-3-5-3v6z" />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                                {src.split('/').pop()}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                                Unsupported format • Click to external play
                            </div>
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400">
                            {/* External Link Icon */}
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </div>
                    </div>
                )}

                {/* Circular drag handle at bottom-right - Only for supported videos */}
                {isActive && isSupported && (
                    <div
                        onMouseDown={handleResizeStart}
                        style={{
                            position: 'absolute',
                            bottom: '-6px',
                            right: '-6px',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            backgroundColor: 'rgb(99 102 241)', // Brand color (indigo-500)
                            cursor: 'nwse-resize',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                            transition: 'transform 0.15s ease',
                            zIndex: 10,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'scale(1.2)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'scale(1)';
                        }}
                        title="拖动调整大小"
                    />
                )}
                </EnrichmentHoverCard>
            </div>
        </NodeViewWrapper>
    );
}; // Close VideoComponentInner

// React.memo with custom comparison - only re-render when src or width changes
export const VideoComponent = memo(VideoComponentInner, (prevProps, nextProps) => {
    return (
        prevProps.node.attrs.src === nextProps.node.attrs.src &&
        prevProps.node.attrs.width === nextProps.node.attrs.width
    );
});
