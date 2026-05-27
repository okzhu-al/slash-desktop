import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMediaScheduleStore } from '../../../stores/useMediaScheduleStore';

export interface EditorStatusBarProps {
    editor: Editor | null;
    incomingLinksCount: number;
    notePath: string;
}

interface MediaStatusResult {
    total: number;
    pending: number;
    done: number;
    failed: number;
}

export const EditorStatusBar = ({ editor, incomingLinksCount, notePath }: EditorStatusBarProps) => {
    const { t } = useTranslation();
    const [words, setWords] = useState(0);
    const [chars, setChars] = useState(0);
    const [outgoingLinks, setOutgoingLinks] = useState(0);

    const [globalConfig, setGlobalConfig] = useState<any>(null);
    const [selectedModel, setSelectedModel] = useState<string>(''); // 'local:modelName' or 'online:modelName'
    const [localModels, setLocalModels] = useState<string[]>([]);
    const [activeOnlineModel, setActiveOnlineModel] = useState<string>('');

    // 纯向量嵌入模型（不是 LLM，不能用于 Vision 任务）
    const EMBEDDING_ONLY_MODELS = ['bge-m3', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'];

    useEffect(() => {
        invoke('get_ai_provider_config').then(async (config: any) => {
            setGlobalConfig(config);

            // 从 online_providers 读取 active provider 的真实 model
            let resolvedOnlineModel = config.online_model || '';
            try {
                const providers = await invoke<{ id: string; model: string; active: boolean }[]>('get_online_providers');
                const active = providers.find(p => p.active);
                if (active) {
                    resolvedOnlineModel = active.model;
                }
            } catch { /* fallback */ }
            setActiveOnlineModel(resolvedOnlineModel);

            setSelectedModel(
                config.provider_type === 'online' && resolvedOnlineModel
                    ? `online:${resolvedOnlineModel}`
                    : `local:${config.generation_model}`
            );
            
            // 拉取本地模型列表，过滤掉纯 embedding 模型
            if (config.ollama_host) {
                invoke<string[]>('list_ollama_models', { host: config.ollama_host, port: config.ollama_port })
                    .then(models => {
                        setLocalModels(models.filter(m => !EMBEDDING_ONLY_MODELS.some(e => m.startsWith(e))));
                    })
                    .catch(() => {});
            }
        }).catch(() => {});
    }, []);

    // ── Phase 6: Media Pending 状态 ──
    const [mediaStatus, setMediaStatus] = useState<MediaStatusResult | null>(null);
    const [mediaProgress, setMediaProgress] = useState<{ current: number; total: number; path: string } | null>(null);

    // 订阅 Tauri 侧发出的多媒体转录实时进度事件
    useEffect(() => {
        let unlistenFn: (() => void) | null = null;
        listen<{ current: number; total: number; path: string }>('media:progress', (event) => {
            setMediaProgress(event.payload);
        }).then(unsub => {
            unlistenFn = unsub;
        });
        return () => {
            if (unlistenFn) unlistenFn();
        };
    }, []);

    // 轮询 media_pending 数量（低频，15 秒一次）
    useEffect(() => {
        let cancelled = false;

        const fetchMediaPending = async () => {
            if (!notePath) return;
            const vaultPath = localStorage.getItem('slash-last-vault');
            if (!vaultPath) return;
            try {
                const status = await invoke<MediaStatusResult | null>('get_note_media_status', { vaultPath, notePath });
                if (!cancelled) setMediaStatus(status);
            } catch {
                // 静默失败：DB 未初始化时不影响体验
            }
        };

        fetchMediaPending();
        const timer = setInterval(fetchMediaPending, 15_000);

        // 监听来自后端的立即刷新事件
        window.addEventListener('slash:media-pending-changed', fetchMediaPending);

        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener('slash:media-pending-changed', fetchMediaPending);
        };
    }, [notePath]);

    const { scheduledTasks, processingTasks, scheduleTask, clearTask } = useMediaScheduleStore();
    const scheduledTask = notePath ? scheduledTasks[notePath] : undefined;
    const isMediaProcessingGlobal = notePath ? processingTasks[notePath] : false;
    const [isMediaProcessingLocal, setIsMediaProcessingLocal] = useState(false);
    
    const isMediaProcessing = isMediaProcessingLocal || isMediaProcessingGlobal;

    // 当处理状态结束时，重置进度
    useEffect(() => {
        if (!isMediaProcessing) {
            setMediaProgress(null);
        }
    }, [isMediaProcessing]);
    
    const [timeLeftStr, setTimeLeftStr] = useState<string>('');
    const [customTime, setCustomTime] = useState<string>('');

    const handleCustomTimeSchedule = useCallback(() => {
        if (!customTime || !notePath) return;
        const [hours, minutes] = customTime.split(':').map(Number);
        const now = new Date();
        const targetTime = new Date();
        targetTime.setHours(hours, minutes, 0, 0);

        // If target time is in the past, assume it's for tomorrow
        if (targetTime.getTime() <= now.getTime()) {
            targetTime.setDate(targetTime.getDate() + 1);
        }

        const delayMinutes = (targetTime.getTime() - now.getTime()) / 60000;
        
        const vaultPath = localStorage.getItem('slash-last-vault');
        if (!vaultPath) return;
        
        scheduleTask(notePath, vaultPath, delayMinutes);
    }, [customTime, notePath, scheduleTask]);

    useEffect(() => {
        if (!scheduledTask) {
            setTimeLeftStr('');
            return;
        }

        const tick = () => {
            const diff = scheduledTask.targetTimestampMs - Date.now();
            if (diff <= 0) {
                setTimeLeftStr('');
            } else {
                const mins = Math.floor(diff / 60000);
                const secs = Math.floor((diff % 60000) / 1000);
                setTimeLeftStr(`${mins}:${secs.toString().padStart(2, '0')}`);
            }
        };

        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [scheduledTask]);

    // 手动触发媒体索引
    const handleTriggerMediaIndex = useCallback(async (delayMinutes: number = 0, forceReindex: boolean = false) => {
        if (isMediaProcessing || !notePath) return;
        
        const vaultPath = localStorage.getItem('slash-last-vault');
        if (!vaultPath) return;

        let visionConfig: any = undefined;
        if (globalConfig && selectedModel) {
            const [type, ...modelParts] = selectedModel.split(':');
            const modelName = modelParts.join(':');
            visionConfig = {
                baseUrl: type === 'local' 
                    ? `${globalConfig.ollama_host.replace(/\/$/, '')}:${globalConfig.ollama_port}/v1`
                    : globalConfig.online_base_url,
                apiKey: type === 'local' ? 'ollama' : globalConfig.online_api_key,
                model: modelName
            };
        }

        if (delayMinutes > 0) {
            scheduleTask(notePath, vaultPath, delayMinutes, visionConfig);
            return;
        }

        setIsMediaProcessingLocal(true);
        clearTask(notePath); // Clear any pending schedule if triggered manually
        
        try {
            const payload: any = { vaultPath, notePath, forceReindex };
            if (visionConfig) {
                payload.visionBaseUrl = visionConfig.baseUrl;
                payload.visionApiKey = visionConfig.apiKey;
                payload.visionModel = visionConfig.model;
            }
            await invoke<string>('trigger_media_embedding', payload);
            
            // 执行完毕后立即刷新计数
            try {
                const status = await invoke<MediaStatusResult | null>('get_note_media_status', { vaultPath, notePath });
                setMediaStatus(status);
            } catch { /* ignore */ }
        } catch (e) {
            console.error('[MediaIndex] Failed to trigger:', e);
        } finally {
            setIsMediaProcessingLocal(false);
        }
    }, [isMediaProcessingLocal, isMediaProcessingGlobal, notePath, scheduleTask, clearTask, globalConfig, selectedModel]);

    useEffect(() => {
        if (!editor || editor.isDestroyed) return;

        const updateStats = () => {
            if (editor.isDestroyed) return;

            // Custom accurate Character & Word Count for CJK
            const textContent = editor.state.doc.textContent || '';
            const currentChars = textContent.length;

            // Words calculation: 
            // 1. Each Chinese character is a word
            const chineseMatches = textContent.match(/[\u4e00-\u9fa5]/g);
            const chineseCount = chineseMatches ? chineseMatches.length : 0;

            // 2. Continuous English/Number characters form a word
            const nonChineseText = textContent.replace(/[\u4e00-\u9fa5]/g, ' ');
            const englishMatch = nonChineseText.match(/[a-zA-Z0-9_\-]+/g);
            const englishWordCount = englishMatch ? englishMatch.length : 0;

            setWords(chineseCount + englishWordCount);
            setChars(currentChars);

            // Calculate outgoing links
            // We need to count wikiLinks and unique link marks.
            // Contiguous text nodes with the same hyperlink should be counted once.
            let linkCount = 0;
            let currentLinkMarkRef: any = null;

            editor.state.doc.descendants((node) => {
                // Inline node wikiLink (e.g. [[Some Note]])
                if (node.type.name === 'wikiLink' || node.type.name === 'wikiLinkNode') {
                    linkCount++;
                    currentLinkMarkRef = null;
                    return false; // don't descend into wikiLink internals
                }

                // If it's a text node, check for 'link' mark
                if (node.isText) {
                    const linkMark = node.marks.find(m => m.type.name === 'link');
                    if (linkMark) {
                        // Using mark object reference or URL to deduplicate contiguous texts
                        // This prevents one link spanning across font styles from counting multiple times
                        if (currentLinkMarkRef !== linkMark) {
                            linkCount++;
                            currentLinkMarkRef = linkMark;
                        }
                    } else {
                        currentLinkMarkRef = null;
                    }
                } else if (!node.isInline) {
                    // Block boundary breaks the link streak
                    currentLinkMarkRef = null;
                }
            });

            setOutgoingLinks(linkCount);
        };

        // Initialize
        updateStats();

        // Listen for document updates
        editor.on('update', updateStats);

        return () => {
            if (!editor.isDestroyed) {
                editor.off('update', updateStats);
            }
        };
    }, [editor]);

    const portalTarget = useMemo(() => document.querySelector('main'), []);
    if (!editor || !portalTarget) return null;

    return createPortal(
        <div className="editor-status-bar absolute bottom-4 right-4 z-40 pointer-events-none">
            <div className="bg-zinc-50/90 dark:bg-zinc-800/90 backdrop-blur-md shadow-sm border border-zinc-200/50 dark:border-zinc-700/50 rounded-full px-4 py-2 flex gap-4 tracking-wide text-[11px] text-zinc-500 font-medium select-none pointer-events-auto transition-all duration-300 opacity-40 hover:opacity-100">
                <div className="flex gap-3 items-center">
                    <span>{words} {t('editor.words', '字')}</span>
                    <span>{chars} {t('editor.characters', '字符')}</span>
                    <div className="w-px h-3 bg-zinc-300 dark:bg-zinc-600 rounded"></div>
                    <span title={t('editor.incomingLinksTooltip', '文档被其他笔记引用的次数')}>
                        {t('editor.incomingLinks', '入链')}: {incomingLinksCount}
                    </span>
                    <span title={t('editor.outgoingLinksTooltip', '本文档中连向其他笔记或网页的链接数量')}>
                        {t('editor.outgoingLinks', '出链')}: {outgoingLinks}
                    </span>

                    {/* Phase 6: Media Status Indicator */}
                    {mediaStatus && mediaStatus.total > 0 && (
                        <>
                            <div className="w-px h-3 bg-zinc-300 dark:bg-zinc-600 rounded"></div>
                            {isMediaProcessing ? (
                                <button className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 disabled:opacity-50 pointer-events-none" disabled>
                                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
                                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                                    </svg>
                                    <span>
                                        {mediaProgress
                                            ? t('editor.mediaProcessingWithProgress', '索引中 ({{current}}/{{total}})...', { current: mediaProgress.current, total: mediaProgress.total })
                                            : t('editor.mediaProcessing', '索引中...')}
                                    </span>
                                </button>
                            ) : mediaStatus.pending > 0 ? (
                                timeLeftStr ? (
                                    <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 pointer-events-auto" title={t('editor.mediaScheduledTooltip', '计划在倒计时结束后自动开启索引')}>
                                        <svg className="w-3 h-3 animate-pulse" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                            <circle cx="8" cy="8" r="6" strokeLinecap="round" strokeLinejoin="round" />
                                            <path d="M8 4v4l2 2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                        <span>{t('editor.mediaPending', '{{count}} 媒体待索引', { count: mediaStatus.pending })} ({timeLeftStr})</span>
                                        <button 
                                            onClick={() => clearTask(notePath)}
                                            className="ml-1 hover:text-red-500 transition-colors"
                                            title={t('editor.cancelSchedule', '取消计划')}
                                        >
                                            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
                                            </svg>
                                        </button>
                                    </div>
                                ) : (
                                    <DropdownMenu.Root>
                                        <DropdownMenu.Trigger asChild>
                                            <button
                                                className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors duration-200 cursor-pointer pointer-events-auto"
                                                title={t('editor.mediaPendingTooltip', '有包含图片/音频的笔记未索引。点击开始 AI 提取。')}
                                            >
                                                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <rect x="2" y="2" width="12" height="12" rx="2" />
                                                    <circle cx="5.5" cy="5.5" r="1" />
                                                    <path d="M14 10l-3-3-7 7" />
                                                </svg>
                                                <span>{t('editor.mediaPending', '{{count}} 媒体待索引', { count: mediaStatus.pending })}</span>
                                            </button>
                                        </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                        <DropdownMenu.Content
                                            align="end"
                                            sideOffset={8}
                                            className="z-50 min-w-[176px] w-[176px] max-w-[200px] bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200/50 dark:border-zinc-700/50 p-1 animate-in fade-in zoom-in-95"
                                        >
                                            <DropdownMenu.Item 
                                                onClick={() => handleTriggerMediaIndex(0, false)}
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg cursor-pointer outline-none"
                                            >
                                                {t('editor.mediaStartNow', '立即开始')}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Separator className="h-px bg-zinc-200 dark:bg-zinc-700/50 my-1 mx-2" />
                                            <DropdownMenu.Item 
                                                onClick={() => handleTriggerMediaIndex(5, false)}
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg cursor-pointer outline-none"
                                            >
                                                {t('editor.mediaStartInMins', '{{mins}}分钟后开始', { mins: 5 })}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Item 
                                                onClick={() => handleTriggerMediaIndex(15, false)}
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg cursor-pointer outline-none"
                                            >
                                                {t('editor.mediaStartInMins', '{{mins}}分钟后开始', { mins: 15 })}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Item 
                                                onClick={() => handleTriggerMediaIndex(30, false)}
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg cursor-pointer outline-none"
                                            >
                                                {t('editor.mediaStartInMins', '{{mins}}分钟后开始', { mins: 30 })}
                                            </DropdownMenu.Item>

                                            <DropdownMenu.Separator className="h-px bg-zinc-200 dark:bg-zinc-700/50 my-1 mx-2" />
                                            
                                            <div className="px-3 py-2">
                                                <label className="text-[10px] font-semibold text-zinc-500 uppercase block mb-1">
                                                    {t('editor.visionModel', 'Vision Model')}
                                                </label>
                                                <select
                                                    value={selectedModel}
                                                    onChange={(e) => setSelectedModel(e.target.value)}
                                                    onKeyDown={(e) => e.stopPropagation()}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-full bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 outline-none focus:border-amber-500 mb-2"
                                                >
                                                    {localModels.length > 0 ? (
                                                        <optgroup label="Local (Ollama)">
                                                            {localModels.map(m => (
                                                                <option key={`local:${m}`} value={`local:${m}`}>{m}</option>
                                                            ))}
                                                        </optgroup>
                                                    ) : globalConfig?.generation_model && (
                                                        <optgroup label="Local (Ollama)">
                                                            <option value={`local:${globalConfig.generation_model}`}>{globalConfig.generation_model}</option>
                                                        </optgroup>
                                                    )}
                                                    
                                                    {activeOnlineModel && (
                                                        <optgroup label="Online API">
                                                            <option value={`online:${activeOnlineModel}`}>{activeOnlineModel}</option>
                                                        </optgroup>
                                                    )}
                                                </select>
                                                <div className="flex items-center gap-2">
                                                    <input 
                                                        type="time" 
                                                        value={customTime}
                                                        onChange={(e) => setCustomTime(e.target.value)}
                                                        onKeyDown={(e) => e.stopPropagation()}
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex-1 bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 outline-none focus:border-amber-500"
                                                    />
                                                    <button 
                                                        onClick={handleCustomTimeSchedule}
                                                        disabled={!customTime}
                                                        className="px-2 py-1 bg-amber-500 text-white text-xs rounded hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                    >
                                                        {t('editor.mediaScheduleSet', '设定')}
                                                    </button>
                                                </div>
                                            </div>
                                            
                                            <div className="px-3 py-2 mt-1 bg-red-50/50 dark:bg-red-900/10 rounded-lg border border-red-100/50 dark:border-red-800/20">
                                                <p className="text-[10px] leading-tight text-red-500/90 dark:text-red-400/90 whitespace-normal text-balance">
                                                    {t('editor.mediaScheduleWarning', '注意：关闭 Slash 或切换仓库将导致计划任务失败。')}
                                                </p>
                                            </div>
                                        </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                            )
                        ) : mediaStatus.failed > 0 ? (
                                <button
                                    onClick={() => handleTriggerMediaIndex(0, true)}
                                    className="flex items-center gap-1.5 text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300 transition-colors pointer-events-auto"
                                    title={t('editor.mediaPendingTooltip', '点击重试提取')}
                                >
                                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M8 2v4l3 3M14 8A6 6 0 112 8a6 6 0 0112 0z"/>
                                    </svg>
                                    <span>{t('editor.mediaFailed', '{{count}} 索引失败', { count: mediaStatus.failed })}</span>
                                </button>
                            ) : (
                                <DropdownMenu.Root>
                                    <DropdownMenu.Trigger asChild>
                                        <button 
                                            className="flex items-center gap-1.5 text-emerald-600/90 dark:text-emerald-400/90 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors pointer-events-auto cursor-pointer"
                                            title={t('editor.mediaReindexTooltip', '点击重新提取媒体内容')}
                                        >
                                            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M4 8l3 3 5-5" />
                                            </svg>
                                            <span>{t('editor.mediaIndexed', '{{count}} 媒体已索引', { count: mediaStatus.done })}</span>
                                        </button>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                        <DropdownMenu.Content
                                            align="end"
                                            sideOffset={8}
                                            className="z-50 min-w-[176px] w-[176px] max-w-[200px] bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200/50 dark:border-zinc-700/50 p-1 animate-in fade-in zoom-in-95"
                                        >
                                            <DropdownMenu.Item 
                                                onClick={() => handleTriggerMediaIndex(0, true)}
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg cursor-pointer outline-none font-medium"
                                            >
                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                                    <path d="M3 3v5h5" />
                                                </svg>
                                                {t('editor.mediaReindexNow', '重新提取')}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Separator className="h-px bg-zinc-200 dark:bg-zinc-700/50 my-1 mx-2" />
                                            <div className="px-3 py-2">
                                                <label className="text-[10px] font-semibold text-zinc-500 uppercase block mb-1">
                                                    {t('editor.visionModel', 'Vision Model')}
                                                </label>
                                                <select
                                                    value={selectedModel}
                                                    onChange={(e) => setSelectedModel(e.target.value)}
                                                    onKeyDown={(e) => e.stopPropagation()}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-full bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 outline-none focus:border-amber-500 mb-2"
                                                >
                                                    {localModels.length > 0 ? (
                                                        <optgroup label="Local (Ollama)">
                                                            {localModels.map(m => (
                                                                <option key={`local:${m}`} value={`local:${m}`}>{m}</option>
                                                            ))}
                                                        </optgroup>
                                                    ) : globalConfig?.generation_model && (
                                                        <optgroup label="Local (Ollama)">
                                                            <option value={`local:${globalConfig.generation_model}`}>{globalConfig.generation_model}</option>
                                                        </optgroup>
                                                    )}
                                                    
                                                    {activeOnlineModel && (
                                                        <optgroup label="Online Providers">
                                                            <option value={`online:${activeOnlineModel}`}>{activeOnlineModel}</option>
                                                        </optgroup>
                                                    )}
                                                </select>
                                            </div>
                                        </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>,
        portalTarget
    );
};
