/**
 * useFileDrop Hook
 * Handles Tauri native file drop events for the editor.
 * Extracted from Editor.tsx to improve modularity.
 */

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getMediaTypeFromPath, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMPORTING_PREFIX, IMPORT_FAILED_PREFIX, IMMEDIATE_FEEDBACK_THRESHOLD } from '../utils/mediaUtils';
import { getBasename } from '@/shared/utils/pathUtils';
import { mediaService } from '@/core/media/MediaService';

/** TipTap Editor interface (minimal for type safety) */
interface TipTapEditor {
    isDestroyed: boolean;
    chain: () => {
        focus: () => {
            setImage: (attrs: { src: string }) => { run: () => void };
            insertContent: (content: any) => { run: () => void };
        };
    };
}

/** Options for useFileDrop hook */
export interface UseFileDropOptions {
    /** TipTap editor instance (can be null during initialization) */
    editor: TipTapEditor | null;
}

/**
 * Hook to handle Tauri native file drops into the editor.
 * - Listens for `tauri://file-drop` and `slash://file-drop` events
 * - Deduplicates drops within a 3-second window
 * - Queues drops if editor is not ready
 * - Processes pending drops when editor becomes available
 */
export function useFileDrop({ editor }: UseFileDropOptions): void {
    // Queue for drops received before editor is ready
    const pendingDropPaths = useRef<string[]>([]);

    // Deduplication map (persists across StrictMode double-invoke)
    const processedDropsRef = useRef(new Map<string, number>());

    // Track editor instance for async operations
    const editorRef = useRef(editor);
    useEffect(() => {
        editorRef.current = editor;
    }, [editor]);

    // Process pending drops when editor becomes available
    useEffect(() => {
        if (editor && !editor.isDestroyed && pendingDropPaths.current.length > 0) {
            console.log(`📦 [useFileDrop] Processing ${pendingDropPaths.current.length} queued drops...`);
            const pathsToProcess = [...pendingDropPaths.current];
            pendingDropPaths.current = [];

            (async () => {
                for (const path of pathsToProcess) {
                    try {
                        // 体积拦截（与 processDrop 一致）
                        const { stat } = await import('@tauri-apps/plugin-fs');
                        const { getMaxSyncFileSize } = await import('@/core/sync/capabilities');
                        const fileStat = await stat(path);
                        const maxLimitBytes = await getMaxSyncFileSize();
                        if (fileStat.size > maxLimitBytes) {
                            console.warn(`⚠️ [useFileDrop] Queued file too large: ${fileStat.size} bytes`);
                            continue;
                        }

                        const relativePath = await mediaService.saveAssetFromPath(path);
                        const mediaType = getMediaTypeFromPath(path);

                        if (mediaType === 'image') {
                            editor.chain().focus().setImage({ src: relativePath }).run();
                            console.log(`✅ [useFileDrop] Queued Image inserted: ${relativePath}`);
                        } else if (mediaType === 'video') {
                            editor.chain().focus().insertContent({
                                type: 'video',
                                attrs: { src: relativePath }
                            }).run();
                            console.log(`✅ [useFileDrop] Queued Video inserted: ${relativePath}`);
                        } else if (mediaType === 'audio') {
                            editor.chain().focus().insertContent({
                                type: 'audio',
                                attrs: { src: relativePath }
                            }).run();
                            console.log(`✅ [useFileDrop] Queued Audio inserted: ${relativePath}`);
                        } else {
                            editor.chain().focus().insertContent({
                                type: 'fileAttachment',
                                attrs: { src: relativePath, filename: getBasename(path) }
                            }).run();
                            console.log(`✅ [useFileDrop] Queued File inserted: ${relativePath}`);
                        }
                    } catch (e) {
                        console.error(`❌ [useFileDrop] Failed queued drop: ${path}`, e);
                    }
                }
            })();
        }
    }, [editor]);

    // Listen for Tauri native file drops
    useEffect(() => {


        let unlisteners: (() => void)[] = [];

        const setupListener = async () => {
            try {
                const processedDrops = processedDropsRef.current;
                const DEDUP_WINDOW_MS = 500; // 0.5 second window to better handle batches

                // Cleanup old entries (called periodically)
                const cleanupOldEntries = (now: number) => {
                    if (processedDrops.size > 20) {
                        const cutoff = now - DEDUP_WINDOW_MS;
                        for (const [key, time] of processedDrops) {
                            if (time < cutoff) processedDrops.delete(key);
                        }
                    }
                };

                // Handler function to reuse for both events
                const handleDropEvent = async (event: { payload: string[] }) => {
                    const paths = event.payload;
                    const now = Date.now();

                    // ATOMIC check-and-set: synchronously filter AND mark in one pass
                    const newPaths: string[] = [];
                    for (const path of paths) {
                        // Skip .md files - handled by Sidebar
                        if (path.endsWith('.md')) {
                            console.log(`📄 [useFileDrop] Skipping .md file: ${path}`);
                            continue;
                        }

                        const lastProcessed = processedDrops.get(path);
                        if (lastProcessed && (now - lastProcessed) < DEDUP_WINDOW_MS) {
                            console.log(`🔄 [useFileDrop] Skipping duplicate: ${path}`);
                            continue;
                        }
                        processedDrops.set(path, now);
                        newPaths.push(path);
                    }

                    if (newPaths.length === 0) return;

                    cleanupOldEntries(now);
                    console.log('📦 [useFileDrop] Received paths:', newPaths);

                    if (!editorRef.current || editorRef.current.isDestroyed) {
                        console.log('⏳ [useFileDrop] Editor not ready, queueing...');
                        pendingDropPaths.current.push(...newPaths);
                        return;
                    }

                    // Process drops
                    // Important: Iterate sequentially to avoid race conditions with editor focus/state
                    await processDrop(newPaths);
                };

                // Drop processing logic
                const processDrop = async (paths: string[]) => {
                    if (!editorRef.current || editorRef.current.isDestroyed) {
                        console.warn('⚠️ [useFileDrop] Editor destroyed during processing');
                        return;
                    }

                    for (const path of paths) {
                        console.log(`⏳ [useFileDrop] Processing: ${path}`);
                        try {
                            // 体积拦截：使用 stat 获取文件大小，避免加载文件到内存
                            const { stat } = await import('@tauri-apps/plugin-fs');
                            const { getMaxSyncFileSize, formatFileSize } = await import('@/core/sync/capabilities');
                            const fileStat = await stat(path);
                            const maxLimitBytes = await getMaxSyncFileSize();
                            if (fileStat.size > maxLimitBytes) {
                                const { toast } = await import('sonner');
                                const i18next = (await import('i18next')).default;
                                console.warn(`⚠️ [useFileDrop] File too large: ${fileStat.size} bytes (limit: ${maxLimitBytes})`);
                                toast.error(i18next.t('media.team_size_limit_title', '文件超出限制'), {
                                    description: i18next.t('media.team_size_limit_block', '此文件 ({{size}}) 超出当前空间 {{limit}} 大小限制，无法引入', { size: formatFileSize(fileStat.size), limit: formatFileSize(maxLimitBytes) }),
                                });
                                continue;
                            }

                            const ext = path.split('.').pop()?.toLowerCase() || '';
                            const isImage = IMAGE_EXTENSIONS.includes(ext);
                            const isVideo = VIDEO_EXTENSIONS.includes(ext);
                            const isAudio = AUDIO_EXTENSIONS.includes(ext);
                            const isMedia = isImage || isVideo || isAudio;

                            // 大文件 + 媒体类型 → placeholder-first 模式（约束 #1: 异步不阻塞）
                            if (fileStat.size > IMMEDIATE_FEEDBACK_THRESHOLD && isMedia) {
                                const nodeType = isVideo ? 'video' : isAudio ? 'audio' : 'image';
                                const placeholderSrc = `assets/${IMPORTING_PREFIX}${crypto.randomUUID()}.${ext}`;
                                console.log(`[MediaImport] placeholder inserted: placeholder=${placeholderSrc} size=${fileStat.size} source=${path}`);

                                // 立即插入占位节点
                                editorRef.current!.chain().focus().insertContent([
                                    { type: nodeType, attrs: { src: placeholderSrc } },
                                    { type: 'text', text: ' ' }
                                ]).run();

                                // 后台异步 — fire & forget
                                const startMs = performance.now();
                                mediaService.saveAssetFromPath(path).then((realPath: string) => {
                                    const elapsedMs = Math.round(performance.now() - startMs);
                                    console.log(`[MediaImport] complete: elapsed_ms=${elapsedMs} placeholder=${placeholderSrc} → ${realPath}`);
                                    // 需要通过 TipTap chain 更新，因为 useFileDrop 没有直接的 view
                                    if (editorRef.current && !editorRef.current.isDestroyed) {
                                        // 遍历文档找到占位节点并替换 src
                                        const editor = editorRef.current as any;
                                        const { state } = editor.view;
                                        const { doc, tr } = state;
                                        let found = false;
                                        doc.descendants((node: any, pos: number) => {
                                            if (found) return false;
                                            if (['image', 'video', 'audio'].includes(node.type.name) && node.attrs.src === placeholderSrc) {
                                                tr.setNodeMarkup(pos, null, { ...node.attrs, src: realPath });
                                                found = true;
                                                return false;
                                            }
                                        });
                                        if (found) {
                                            editor.view.dispatch(tr);
                                            console.log(`✅ [EditorMedia] transfer state updated: ${placeholderSrc} → ${realPath}`);
                                        } else {
                                            console.log(`ℹ️ [EditorMedia] node not found for update (user may have deleted): ${placeholderSrc}`);
                                        }
                                    }
                                }).catch(async (err: any) => {
                                    console.error(`❌ [MediaImport] failed:`, err);
                                    const { toast } = await import('sonner');
                                    const i18next = (await import('i18next')).default;
                                    // 约束 #4: 失败不静默删除，改为 import_failed 占位
                                    if (editorRef.current && !editorRef.current.isDestroyed) {
                                        const editor = editorRef.current as any;
                                        const { state } = editor.view;
                                        const { doc, tr } = state;
                                        const failedSrc = placeholderSrc.replace(IMPORTING_PREFIX, IMPORT_FAILED_PREFIX);
                                        let found = false;
                                        doc.descendants((node: any, pos: number) => {
                                            if (found) return false;
                                            if (['image', 'video', 'audio'].includes(node.type.name) && node.attrs.src === placeholderSrc) {
                                                tr.setNodeMarkup(pos, null, { ...node.attrs, src: failedSrc });
                                                found = true;
                                                return false;
                                            }
                                        });
                                        if (found) editor.view.dispatch(tr);
                                    }
                                    toast.error(i18next.t('media.import_error', '文件导入失败'));
                                });
                                continue;
                            }

                            // 小文件或非媒体 → 同步模式（原行为）
                            const filename = getBasename(path) || 'file';
                            const { toast } = await import('sonner');
                            const i18next = (await import('i18next')).default;

                            const savePromise = mediaService.saveAssetFromPath(path);

                            // 小型媒体文件的 toast 提醒（>10MB 但 <5MB threshold 不会到这里）
                            if (fileStat.size > 10 * 1024 * 1024) {
                                toast.promise(savePromise, {
                                    loading: i18next.t('media.importing', '导入中...'),
                                    success: i18next.t('media.import_success', { filename, defaultValue: `导入成功: ${filename}` }),
                                    error: i18next.t('media.import_error', '文件导入失败')
                                });
                            }
                            
                            const relativePath = await savePromise;

                            if (isImage) {
                                editorRef.current.chain().focus().insertContent([
                                    { type: 'image', attrs: { src: relativePath } },
                                    { type: 'text', text: ' ' }
                                ]).run();
                                console.log(`✅ [useFileDrop] Inserted Image: ${relativePath}`);
                            } else if (isVideo) {
                                editorRef.current.chain().focus().insertContent([
                                    { type: 'video', attrs: { src: relativePath } },
                                    { type: 'text', text: ' ' }
                                ]).run();
                                console.log(`✅ [useFileDrop] Inserted Video: ${relativePath}`);
                            } else if (isAudio) {
                                editorRef.current.chain().focus().insertContent([
                                    { type: 'audio', attrs: { src: relativePath } },
                                    { type: 'text', text: ' ' }
                                ]).run();
                                console.log(`✅ [useFileDrop] Inserted Audio: ${relativePath}`);
                            } else if (ext !== 'md') {
                                editorRef.current.chain().focus().insertContent([
                                    { type: 'fileAttachment', attrs: { src: relativePath, filename: getBasename(path) } },
                                    { type: 'text', text: ' ' }
                                ]).run();
                                console.log(`✅ [useFileDrop] Inserted File: ${relativePath}`);
                            }
                        } catch (e) {
                            console.error(`❌ [useFileDrop] Failed: ${path}`, e);
                        }
                    }
                };

                // Listen for Tauri drop events
                const unlistenStandard = await listen<string[]>('tauri://file-drop', handleDropEvent);
                unlisteners.push(unlistenStandard);

                const unlistenCustom = await listen<string[]>('slash://file-drop', handleDropEvent);
                unlisteners.push(unlistenCustom);


            } catch (e) {
                console.error('❌ [useFileDrop] Setup failed', e);
            }
        };

        setupListener();

        return () => {
            // console.log('🎧 [useFileDrop] Cleanup...');
            unlisteners.forEach(u => u());
        };
    }, []);
}
