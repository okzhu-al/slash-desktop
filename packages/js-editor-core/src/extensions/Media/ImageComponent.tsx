import { NodeViewWrapper } from '@tiptap/react';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorServices } from '../../EditorDI';
import { useMediaEnrichment } from '../../hooks/useMediaEnrichment';

export const ImageComponent = (props: any) => {
    const { node, updateAttributes } = props;
    const { src, alt, title, width, height: _height } = node.attrs;
    const [resolvedSrc, setResolvedSrc] = useState<string>('');
    const [resolvedForVault, setResolvedForVault] = useState<string | null>(null); // Track which vault this URL was resolved for
    const [currentWidth, setCurrentWidth] = useState<number | null>(width || null);
    const [resizing, setResizing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [failed, setFailed] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const widthRef = useRef<number | null>(currentWidth);
    const containerRef = useRef<HTMLDivElement>(null);

    const { fileSystemStore, mediaService, EnrichmentHoverCard } = useEditorServices();
    const { t } = useTranslation();
    const [vaultPath, setVaultPath] = useState(() => fileSystemStore?.root?.path || null);

    useEffect(() => {
        if (!fileSystemStore?.subscribe) return;
        const unsubscribe = fileSystemStore.subscribe((state: any) => {
            setVaultPath(state.root?.path || null);
        });
        return unsubscribe;
    }, [fileSystemStore]);

    const { enrichedText } = useMediaEnrichment(src);

    // 🛡️ Phase 6: 导入中/失败状态检测
    const isImporting = src?.includes('_importing_');
    const isImportFailed = src?.includes('_import_failed_');

    // 🛡️ Phase 6: Team asset 下载中检测（本地文件不存在，等待 TransferManager 下载）
    const isAssetPendingDownload = failed && src?.includes('assets/');

    // 提取 asset 相对路径
    const assetRelPath = useMemo(() => {
        if (!src) return '';
        const match = src.match(/(assets\/[^\s]+)/);
        return match ? match[1] : '';
    }, [src]);

    // ref 防止同一个 asset 重复 invoke
    const recoverAttemptedRef = useRef<string>('');

    // Keep ref in sync with state
    useEffect(() => {
        widthRef.current = currentWidth;
    }, [currentWidth]);

    // Sync with prop changes
    useEffect(() => {
        setCurrentWidth(width || null);
    }, [width]);

    // Resolve image URL - retry when vault becomes available
    useEffect(() => {
        // Skip resolution for importing/failed placeholders
        if (isImporting || isImportFailed) return;

        let isMounted = true;
        const currentVaultPath = vaultPath || null;

        // Immediately clear resolved URL when vault changes
        // This prevents the browser from requesting stale asset URLs
        setResolvedSrc('');
        setResolvedForVault(null);

        const resolve = async () => {
            if (!src || !currentVaultPath) return;

            // Skip resolution if this image doesn't belong to current vault
            // This prevents 500 errors when switching vaults while images are still mounted
            if (src.startsWith('/') && !src.startsWith(currentVaultPath)) {
                return;
            }

            try {
                let url = await mediaService.getAssetUrl(src, currentVaultPath);

                // Re-check: vault may have changed during async operation
                const nowVaultPath = fileSystemStore.root?.path;
                if (nowVaultPath !== currentVaultPath) {
                    console.log(`[ImageComponent] Vault changed during resolution, discarding result`);
                    return;
                }

                // Append timestamp on retry to bust any browser/WebView cache
                if (retryCount > 0 && url) {
                    const separator = url.includes('?') ? '&' : '?';
                    url = `${url}${separator}_retry=${Date.now()}`;
                }

                // Only set if it's a valid URL (blob:, asset:, or http)
                if (isMounted && (url.startsWith('blob:') || url.startsWith('asset:') || url.startsWith('http'))) {
                    setResolvedSrc(url);
                    setResolvedForVault(currentVaultPath);
                    setFailed(false);
                }
            } catch (e) {
                console.error("Failed to resolve image src:", src, e);
                if (isMounted) setFailed(true);
            }
        };

        resolve();
        return () => { isMounted = false; };
    }, [src, vaultPath, isImporting, isImportFailed, retryCount]);

    // 资产缺失时：主动调用 recoverMissingAsset + 监听 download-completed 事件
    useEffect(() => {
        if (!isAssetPendingDownload || !assetRelPath) return;

        // 首次进入 pending download 状态时，触发一次 recover
        if (recoverAttemptedRef.current !== assetRelPath && mediaService.recoverMissingAsset) {
            recoverAttemptedRef.current = assetRelPath;
            mediaService.recoverMissingAsset(assetRelPath)
                .then((action: string) => {
                    console.log(`[ImageComponent] recover triggered: path=${assetRelPath} action=${action}`);
                })
                .catch((err: any) => {
                    console.warn(`[ImageComponent] recover failed: path=${assetRelPath}`, err);
                });
        }

        // 监听 download completed → 精准刷新
        let unlistenFn: (() => void) | null = null;
        let isCancelled = false;

        if (mediaService.onTransferDownloadCompleted) {
            mediaService.onTransferDownloadCompleted((payload: any) => {
                if (payload.asset_path === assetRelPath) {
                    console.log(`[ImageComponent] download completed, refreshing: ${assetRelPath}`);
                    recoverAttemptedRef.current = ''; // 允许再次 recover
                    setFailed(false);
                    setRetryCount(prev => prev + 1);
                }
            }).then((fn: () => void) => {
                if (isCancelled) {
                    fn(); // 瞬间解绑防泄漏
                } else {
                    unlistenFn = fn;
                }
            });
        }

        // 兜底：30 秒后检测一次
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
    // Removing 'selected' prevents border showing when cursor is in other nodes like tables
    const isActive = isHovered || resizing;

    // Determine what to show: resolved image, or a placeholder state
    const hasValidUrl = resolvedSrc && (
        resolvedSrc.startsWith('http') ||
        resolvedSrc.startsWith('asset:') ||
        resolvedSrc.startsWith('blob:')
    );
    const showImage = !isImporting && !isImportFailed && hasValidUrl && resolvedForVault === vaultPath;

    // Determine placeholder variant
    const placeholderClass = isImportFailed ? 'media-placeholder--failed'
        : isImporting ? 'media-placeholder--importing'
        : isAssetPendingDownload ? 'media-placeholder--syncing'
        : 'media-placeholder--syncing';

    return (
        <NodeViewWrapper
            className="image-view"
            style={{ textAlign: 'left', display: 'block', clear: 'both' }}
        >
            <div
                ref={containerRef}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => !resizing && setIsHovered(false)}
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
            >
                {showImage ? (
                    <EnrichmentHoverCard content={enrichedText}>
                        <img
                            src={resolvedSrc}
                            alt={alt}
                            title={title}
                            draggable={false}
                            className="w-full rounded-lg"
                            style={{
                                display: 'block',
                                userSelect: 'none',
                                margin: 0,
                                padding: 0,
                            }}
                            onError={() => {
                                if (retryCount < 3) {
                                    setTimeout(() => setRetryCount(prev => prev + 1), 500 * Math.pow(2, retryCount));
                                } else {
                                    setFailed(true);
                                }
                            }}
                            onLoad={() => setFailed(false)}
                        />
                    </EnrichmentHoverCard>
                ) : failed && isAssetPendingDownload ? (
                    /* Asset 恢复中：显示等待恢复 UI */
                    <div className={`media-placeholder media-placeholder--syncing`}>
                        <div className="media-placeholder__icon">
                            <svg className="media-placeholder__spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                        </div>
                        <span className="media-placeholder__text">
                            {t('media.recovering_asset', '正在恢复媒体文件…')}
                        </span>
                    </div>
                ) : (
                    /* Importing / Failed / Syncing placeholder */
                    <div className={`media-placeholder ${placeholderClass}`}>
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
                                /* Image icon for syncing/loading state */
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <polyline points="21 15 16 10 5 21" />
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
                                : vaultPath ? t('media.resolving', '解析中...') : t('media.loading', '加载中...')
                            }
                        </span>
                    </div>
                )}
                {/* Circular drag handle at bottom-right */}
                {isActive && (
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
            </div>
        </NodeViewWrapper>
    );
};
