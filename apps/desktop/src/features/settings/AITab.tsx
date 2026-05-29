import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, RefreshCw, CheckCircle2, XCircle, Globe, HardDrive, Eye, EyeOff, Check, Copy, Download, ChevronDown, ChevronUp, Mic, Settings, Tag, FileText, Search, Ghost, PenLine, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { CustomSkillsTab } from "./CustomSkillsTab";

import { useAiSettingsManager } from './hooks/useAiSettingsManager';
interface OllamaModelCheck {
    available: boolean;
    error: string | null;
}

interface PullProgress {
    model: string;
    status: string;
    completed: number;
    total: number;
    done: boolean;
    error: string | null;
}

export interface AITabProps {
    aiState: ReturnType<typeof useAiSettingsManager>['state'];
    aiActions: ReturnType<typeof useAiSettingsManager>['actions'];
}

const FIXED_EMBEDDING_MODEL = 'bge-m3';

export const AITab = ({
    aiState,
    aiActions
}: AITabProps) => {
    // Destructure to avoid changing the rest of the component
    const { configLoaded, ollamaHost, ollamaPort, generationModel, onlineApiKey, onlineBaseUrl, onlineModel, showApiKey, providerSaving, providerTestResult, availableModels, modelsFetching, savedProviderConfig, savedProviders } = aiState;
    const { setOllamaHost, setOllamaPort, setGenerationModel, setOnlineApiKey, setOnlineBaseUrl, setOnlineModel, setShowApiKey, setProviderTestResult, setAvailableModels, setModelsFetching, handleSaveProvider, handleSaveOnlineProvider, handleActivateProvider, handleDeleteProvider } = aiActions;
    const { t } = useTranslation();

    // Copy notification state
    const [copyNotification, setCopyNotification] = useState<string | null>(null);

    // Model readiness states (auto-detected, no manual "test" button)
    const [genModelReady, setGenModelReady] = useState<boolean | null>(null);
    const [ebdModelReady, setEbdModelReady] = useState<boolean | null>(null);

    // Local model list (for combo-box dropdown)
    const [localModels, setLocalModels] = useState<string[]>([]);
    const [localModelsLoading, setLocalModelsLoading] = useState(false);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    
    // Engine state
    const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
    const [showEngineSettings, setShowEngineSettings] = useState(false);

    // Pull (download) progress states
    const [genPulling, setGenPulling] = useState(false);
    const [genPullProgress, setGenPullProgress] = useState<{ status: string; completed: number; total: number } | null>(null);
    const [genPullError, setGenPullError] = useState<string | null>(null);
    const [ebdPulling, setEbdPulling] = useState(false);
    const [ebdPullProgress, setEbdPullProgress] = useState<{ status: string; completed: number; total: number } | null>(null);
    const [ebdPullError, setEbdPullError] = useState<string | null>(null);

    // Online provider selection state
    const [selectedOnlineId, setSelectedOnlineId] = useState<string | null>(null);

    // ── Helpers ──
    const isModelLocal = (name: string) => localModels.some(m => m === name || m === `${name}:latest` || name === m.replace(/:latest$/, ''));

    const fetchLocalModels = async () => {
        if (localModelsLoading) return [];
        setLocalModelsLoading(true);
        try {
            const models = await invoke<string[]>('list_ollama_models', { host: ollamaHost, port: ollamaPort });
            setOllamaConnected(true);
            setLocalModels(models);
            return models;
        } catch (e) {
            console.error('Failed to list local models:', e);
            setOllamaConnected(false);
            setLocalModels([]);
            return [];
        } finally {
            setLocalModelsLoading(false);
        }
    };

    const autoCheckModel = async (modelName: string): Promise<boolean> => {
        try {
            const result = await invoke<OllamaModelCheck>('check_ollama_model', { host: ollamaHost, port: ollamaPort, modelName });
            return result.available;
        } catch {
            return false;
        }
    };

    // Auto-save + auto-check: called when user selects a model or finishes downloading
    const commitModel = async (model: string, target: 'gen' | 'ebd') => {
        if (target === 'gen') setGenerationModel(model);
        // auto-check readiness
        const ready = await autoCheckModel(model);
        if (target === 'gen') setGenModelReady(ready);
        else setEbdModelReady(ready);
        // auto-save
        if (ready) handleSaveProvider('local', target === 'gen' ? { generationModel: model } : { embeddingModel: model });
    };

    // ── Auto-select first downloaded model if none is set ──
    const hasAutoSelectedGen = useRef(false);
    useEffect(() => {
        if (configLoaded && ollamaConnected !== null && !hasAutoSelectedGen.current) {
            hasAutoSelectedGen.current = true;
            if (localModels.length > 0 && !generationModel) {
                // Find the first model that isn't the fixed embedding model
                const firstGenModel = localModels.find(m => m !== FIXED_EMBEDDING_MODEL) || localModels[0];
                commitModel(firstGenModel, 'gen');
            }
        }
    }, [configLoaded, ollamaConnected, localModels, generationModel]);

    // ── Load local models on mount (always, since embedding always needs Ollama) ──
    useEffect(() => {
        fetchLocalModels().then(models => {
            // Auto-check current models on load
            if (generationModel) {
                const exists = models.some(m => m === generationModel || m === `${generationModel}:latest` || generationModel === m.replace(/:latest$/, ''));
                if (exists) autoCheckModel(generationModel).then(setGenModelReady);
            }
            autoCheckModel(FIXED_EMBEDDING_MODEL).then(setEbdModelReady);
        });
    }, [ollamaHost, ollamaPort]);

    // ── Initialize online provider selection ──
    useEffect(() => {
        if (savedProviders.length > 0 && selectedOnlineId === null) {
            const active = savedProviders.find(p => p.active);
            if (active) {
                setSelectedOnlineId(active.id);
                setOnlineBaseUrl(active.base_url);
                setOnlineModel(active.model);
                setProviderTestResult({ ok: true, msg: t('settings.online_connected') });
            } else {
                setOnlineBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai');
            }
        }
    }, [savedProviders]);

    // ── Pull model (download) ──
    const pullModel = async (
        modelName: string,
        setPulling: (v: boolean) => void,
        setProgress: (v: { status: string; completed: number; total: number } | null) => void,
        setPullError: (v: string | null) => void,
        target: 'gen' | 'ebd',
    ) => {
        setPulling(true);
        setProgress(null);
        setPullError(null);

        let unlisten: UnlistenFn | null = null;
        try {
            unlisten = await listen<PullProgress>('ollama:pull-progress', (event) => {
                const p = event.payload;
                if (p.model !== modelName) return;

                if (p.error) {
                    setPullError(p.error);
                    setPulling(false);
                    setProgress(null);
                    return;
                }
                if (p.done) {
                    setPulling(false);
                    setProgress(null);
                    // Auto-check + auto-save + refresh list
                    fetchLocalModels();
                    commitModel(modelName, target);
                    return;
                }
                setProgress({ status: p.status, completed: p.completed, total: p.total });
            });

            await invoke('pull_ollama_model', { host: ollamaHost, port: ollamaPort, modelName });
        } catch (e) {
            setPullError(`${e}`);
            setPulling(false);
            setProgress(null);
        } finally {
            if (unlisten) unlisten();
        }
    };

    const copyToClipboard = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopyNotification(t('settings.copied_label', { label }));
            setTimeout(() => setCopyNotification(null), 3000);
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    };



    // ── Model readiness badge ──
    const ReadyBadge = ({ ready, labelReady, labelNotReady }: { ready: boolean | null, labelReady?: string, labelNotReady?: string }) => {
        if (ready === null) return null;
        return ready ? (
            <span className="flex items-center gap-1 text-[10px] text-[#006540] dark:text-[#006540]">
                <CheckCircle2 size={10} /> {labelReady || t('settings.ready')}
            </span>
        ) : (
            <span className="flex items-center gap-1 text-[10px] text-[#A42227] dark:text-[#A42227]">
                <XCircle size={10} /> {labelNotReady || t('settings.not_ready')}
            </span>
        );
    };

    // ── Progress bar helper ──
    const ProgressBar = ({ progress, error }: { progress: { status: string; completed: number; total: number } | null; error: string | null }) => {
        if (error) {
            return (
                <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
                    ❌ {error}
                </div>
            );
        }
        if (!progress) return null;
        const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
        return (
            <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between text-[10px] text-[#545454] dark:text-[#545454]">
                    <span className="truncate max-w-[200px]">{progress.status}</span>
                    {progress.total > 0 && <span>{pct}%</span>}
                </div>
                {progress.total > 0 && (
                    <div className="h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                )}
            </div>
        );
    };

    // ── Online Providers (without Kimi & Groq) ──
    const PROVIDERS = [
        { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash', keyPrefix: 'AIza...' },
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', keyPrefix: 'sk-...' },
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com', defaultModel: 'gpt-4o-mini', keyPrefix: 'sk-...' },
        { id: 'qwen', label: `${t('settings.online_qwen')} (Qwen)`, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', defaultModel: 'qwen-plus', keyPrefix: 'sk-...' },
        { id: 'custom', label: t('settings.online_custom'), baseUrl: '', defaultModel: '', keyPrefix: 'sk-...' },
    ];

    const getSavedInfo = (presetId: string) => savedProviders.find(sp => sp.id === presetId);

    // Resolve selected online provider
    const effectiveOnlineId = selectedOnlineId || 'gemini';
    const selectedPreset = PROVIDERS.find(p => p.id === effectiveOnlineId) || PROVIDERS[0];

    const handleSelectOnlineProvider = (p: typeof PROVIDERS[0]) => {
        setSelectedOnlineId(p.id);
        // Cache current form data based on current provider ID
        if (effectiveOnlineId && onlineApiKey) {
            savedProviderConfig.current?.set(effectiveOnlineId, { apiKey: onlineApiKey, model: onlineModel });
        }
        setOnlineBaseUrl(p.baseUrl);
        setAvailableModels([]);

        const saved = getSavedInfo(p.id);
        if (saved) {
            setOnlineModel(saved.model);
            setOnlineApiKey('');
            if (saved.active || saved.has_key) {
                setProviderTestResult({ ok: true, msg: t('settings.online_connected') });
            } else {
                setProviderTestResult(null);
            }
        } else {
            const cached = savedProviderConfig.current?.get(p.id);
            if (cached && cached.apiKey) {
                setOnlineApiKey(cached.apiKey);
                setOnlineModel(cached.model);
            } else {
                setOnlineApiKey('');
                setOnlineModel(p.defaultModel || '');
            }
            // Always clear test result since it's just unsaved cached values
            setProviderTestResult(null);
        }
    };

    return (
        <div className="space-y-6 pb-12">
            {/* ══════════════════════════════════════════════════════════
                Section 1: Local Model Group (Ollama Host + Embedding + Generation)
               ══════════════════════════════════════════════════════════ */}
            <div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <HardDrive size={16} className="text-[#545454]" />
                    {t('settings.local_section_title') || '本地模型 (Ollama)'}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#545454] mb-3">
                    {t('settings.local_section_desc_combined', { defaultValue: '配置本地模型驱动引擎及用于知识发现的向量嵌入模型与用于生成的默认语言模型。' })}
                </p>
                <div className="p-4 bg-[#C8C8C8]/10 dark:bg-zinc-800/50 rounded-xl border border-[#C8C8C8] dark:border-[#C8C8C8]/30 space-y-4">
                    
                    {/* 1. Model Engine */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#545454]">{t('settings.model_engine_title', { defaultValue: '模型驱动引擎' })}</label>
                            <div className="flex items-center gap-2">
                                <ReadyBadge ready={ollamaConnected} labelReady={t('settings.engine_ready', '就绪')} labelNotReady={t('settings.engine_not_detected', '未检测到（请在本机安装或设置远程地址）')} />
                                <button
                                    onClick={() => setShowEngineSettings(!showEngineSettings)}
                                    className="flex items-center gap-1 text-[10px] text-[#545454] hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors bg-zinc-200/50 dark:bg-zinc-700/50 px-2 py-0.5 rounded"
                                    title={t('settings.settings_btn', '设置')}
                                >
                                    {showEngineSettings ? <ChevronUp size={10} /> : <Settings size={10} />} {t('settings.settings_btn', '设置')}
                                </button>
                            </div>
                        </div>
                        <p className="text-[10px] text-[#545454] dark:text-[#545454] mb-2">
                            {t('settings.model_engine_desc_new', { defaultValue: '私有化模型驱动引擎，如需使用语义搜索与知识发现必须安装' })}
                        </p>
                        
                        {showEngineSettings && (
                            <div className="mt-2 pt-2 border-t border-[#C8C8C8]/50 dark:border-[#C8C8C8]/30/50">
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="text-[10px] text-[#545454]">{t('settings.ollama_address', 'Ollama 地址')}</label>
                                    <button
                                        onClick={() => copyToClipboard(`curl ${ollamaHost}:${ollamaPort}`, 'curl 命令')}
                                        className="flex items-center gap-1 text-[10px] text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 transition-colors"
                                        title={t('settings.copy_test_cmd_title')}
                                    >
                                        <Copy size={10} /> {t('settings.copy_test_cmd')}
                                    </button>
                                </div>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={ollamaHost}
                                        onChange={e => { setOllamaHost(e.target.value); setGenModelReady(null); setEbdModelReady(null); }}
                                        placeholder="http://localhost"
                                        className="flex-1 px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 placeholder:text-[#545454]"
                                    />
                                    <input
                                        type="number"
                                        value={ollamaPort}
                                        onChange={e => { setOllamaPort(Number(e.target.value)); setGenModelReady(null); setEbdModelReady(null); }}
                                        placeholder="11434"
                                        className="w-24 px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 placeholder:text-[#545454]"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="border-t border-[#C8C8C8] dark:border-[#C8C8C8]/30" />
                    {/* Embedding block */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#545454]">{t('settings.embedding_model_label', { defaultValue: '向量嵌入模型' })}</label>
                            <ReadyBadge ready={ebdModelReady} />
                        </div>
                        <p className="text-[10px] text-[#545454] dark:text-[#545454] mb-2">
                             {t('settings.embedding_section_desc') || '语义搜索与知识发现的基础。无论生成模型使用本地还是在线服务，嵌入始终通过本地 Ollama 运行。'}
                        </p>
                        <div className="flex items-center gap-2">
                            <div className="flex-1 flex items-center gap-2 px-3 py-2 text-sm bg-[#C8C8C8]/20 dark:bg-zinc-800 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg text-zinc-600 dark:text-zinc-300 font-mono">
                                {FIXED_EMBEDDING_MODEL}
                                <span className="text-[10px] text-[#545454] ml-auto font-sans">{t('settings.fixed_model')}</span>
                            </div>
                            {ebdModelReady === false && !ebdPulling && (
                                <button
                                    onClick={() => pullModel(FIXED_EMBEDDING_MODEL, setEbdPulling, setEbdPullProgress, setEbdPullError, 'ebd')}
                                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#006540] hover:bg-[#005030] text-white rounded-lg transition-colors whitespace-nowrap"
                                >
                                    <Download size={12} /> {t('settings.download')}
                                </button>
                            )}
                            {ebdPulling && (
                                <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#006540]/80 text-white rounded-lg whitespace-nowrap">
                                    <Loader2 size={12} className="animate-spin" /> {t('settings.downloading')}
                                </div>
                            )}
                        </div>
                        {(ebdPulling || ebdPullError) && <ProgressBar progress={ebdPullProgress} error={ebdPullError} />}
                    </div>

                    {/* ── Generation Model (LLM) — combo-box ── */}
                    <div className="border-t border-[#C8C8C8] dark:border-[#C8C8C8]/30 pt-4">
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#545454]">{t('settings.generation_model')}</label>
                            <ReadyBadge ready={genModelReady} />
                        </div>
                        <p className="text-[10px] text-[#545454] dark:text-[#545454] mb-2">
                            {t('settings.generation_model_desc_new', { defaultValue: '生成式模型服务，可根据需求选择安装或使用云服务商模型服务' })}
                        </p>
                        {/* Combo-box: input + optional download button */}
                        <div className="relative">
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <input
                                        type="text"
                                        value={generationModel}
                                        onChange={e => { setGenerationModel(e.target.value); setGenModelReady(null); setGenPullError(null); }}
                                        onFocus={() => { if (localModels.length > 0) setShowModelDropdown(true); }}
                                        placeholder={t('settings.generation_model_placeholder', '选择或填写模型名称下载')}
                                        className="w-full px-3 py-2 pr-8 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 placeholder:text-[#545454]"
                                    />
                                    <button
                                        onClick={() => {
                                            if (localModels.length === 0 && !localModelsLoading) fetchLocalModels();
                                            setShowModelDropdown(!showModelDropdown);
                                        }}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[#545454] hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                                    >
                                        {localModelsLoading ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={14} />}
                                    </button>
                                </div>
                                {/* Download button — only when model is not local */}
                                {generationModel && !isModelLocal(generationModel) && !genPulling && (
                                    <button
                                        onClick={() => pullModel(generationModel, setGenPulling, setGenPullProgress, setGenPullError, 'gen')}
                                        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#006540] hover:bg-[#005030] text-white rounded-lg transition-colors whitespace-nowrap"
                                    >
                                        <Download size={12} /> {t('settings.download')}
                                    </button>
                                )}
                                {genPulling && (
                                    <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#006540]/80 text-white rounded-lg whitespace-nowrap">
                                        <Loader2 size={12} className="animate-spin" /> {t('settings.downloading')}
                                    </div>
                                )}
                            </div>
                            {/* Dropdown */}
                            {showModelDropdown && localModels.length > 0 && (
                                <div className="absolute z-10 w-full mt-1 bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                                    {localModels.map(m => (
                                        <button
                                            key={m}
                                            onClick={() => {
                                                setShowModelDropdown(false);
                                                setGenPullError(null);
                                                commitModel(m, 'gen');
                                            }}
                                            className={cn(
                                                "w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors",
                                                generationModel === m
                                                    ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/10"
                                                    : "text-zinc-700 dark:text-zinc-300"
                                            )}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        {/* Close dropdown on click outside */}
                        {showModelDropdown && <div className="fixed inset-0 z-5" onClick={() => setShowModelDropdown(false)} />}
                        {/* Pull progress */}
                        {(genPulling || genPullError) && <ProgressBar progress={genPullProgress} error={genPullError} />}
                    </div>

                    {/* Copy notification */}
                    {copyNotification && (
                        <div className="p-2 bg-[#006540]/20 dark:bg-[#006540]/30 text-[#006540] dark:text-[#006540] text-xs rounded-md">
                            {copyNotification}
                        </div>
                    )}
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════
                Section 3: Online API (Generation Model)
               ══════════════════════════════════════════════════════════ */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Globe size={16} className="text-[#545454]" />
                    {t('settings.online_section_title') || '在线 API 模型'}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#545454] mb-3">
                    {t('settings.online_section_desc') || '连接 OpenAI 兼容的在线 API 服务，用于生成模型。'}
                </p>
                <div className="p-4 bg-[#C8C8C8]/10 dark:bg-zinc-800/50 rounded-xl border border-[#C8C8C8] dark:border-[#C8C8C8]/30 space-y-3">
                    {/* Provider preset selector */}
                    <div>
                        <label className="block text-xs font-medium text-[#545454] dark:text-[#545454] mb-1.5">{t('settings.online_provider')}</label>
                        <div className="flex flex-wrap gap-1.5">
                            {PROVIDERS.map(p => {
                                const saved = getSavedInfo(p.id);
                                const isActive = saved?.active ?? false;
                                const isConfigured = !!saved;

                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => handleSelectOnlineProvider(p)}
                                        className={cn(
                                            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                                            selectedPreset.id === p.id
                                                ? 'bg-indigo-500 text-white shadow-sm'
                                                : 'bg-[#C8C8C8]/20 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                                        )}
                                    >
                                        {/* Active/Configured indicator */}
                                        {isActive && (
                                            <span className="w-2 h-2 rounded-full bg-[#006540] shadow-[0_0_4px_rgba(0,101,64,0.6)]" title={t('settings.active') || '已启用'} />
                                        )}
                                        {isConfigured && !isActive && (
                                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-[#C8C8C8]/100" title={t('settings.configured') || '已配置'} />
                                        )}
                                        {p.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Custom URL */}
                    {selectedPreset.id === 'custom' && (
                        <div>
                            <label className="block text-xs font-medium text-[#545454] dark:text-[#545454] mb-1">API Base URL</label>
                            <input
                                type="text"
                                value={onlineBaseUrl}
                                onChange={e => setOnlineBaseUrl(e.target.value)}
                                placeholder="https://api.example.com"
                                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 placeholder:text-[#545454]"
                            />
                        </div>
                    )}

                    {/* API Key */}
                    <div>
                        <label className="block text-xs font-medium text-[#545454] dark:text-[#545454] mb-1">API Key</label>
                        <div className="relative">
                            <input
                                type={showApiKey ? 'text' : 'password'}
                                value={onlineApiKey}
                                onChange={e => { setOnlineApiKey(e.target.value); setProviderTestResult(null); }}
                                placeholder={getSavedInfo(selectedPreset.id)?.has_key ? '••••••••' : selectedPreset.keyPrefix}
                                className="w-full px-3 py-2 pr-10 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 placeholder:text-[#545454] font-mono"
                            />
                            <button
                                type="button"
                                onClick={() => setShowApiKey(!showApiKey)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#545454] hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                            >
                                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                        </div>
                    </div>

                    {/* Model */}
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#545454]">{t('settings.online_model')}</label>
                            {((onlineBaseUrl || selectedPreset.baseUrl) && (onlineApiKey || getSavedInfo(selectedPreset.id)?.has_key)) && (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        setModelsFetching(true);
                                        setAvailableModels([]);
                                        try {
                                            let models: string[];
                                            const saved = getSavedInfo(selectedPreset.id);
                                            if (saved?.has_key && !onlineApiKey) {
                                                // Use stored key from keychain
                                                models = await invoke<string[]>('fetch_saved_provider_models', {
                                                    providerId: selectedPreset.id,
                                                });
                                            } else {
                                                // Use the key user just entered
                                                models = await invoke<string[]>('fetch_online_models', {
                                                    baseUrl: onlineBaseUrl || selectedPreset.baseUrl,
                                                    apiKey: onlineApiKey,
                                                });
                                            }
                                            setAvailableModels(models);
                                            // Preserve current model if it's in fetched list, or find best match
                                            if (models.length > 0 && onlineModel) {
                                                if (!models.includes(onlineModel)) {
                                                    const match = models.find(m => m === onlineModel || m.endsWith('/' + onlineModel) || onlineModel.endsWith('/' + m));
                                                    if (match) setOnlineModel(match);
                                                }
                                            }
                                        } catch (e) {
                                            console.error('Failed to fetch models:', e);
                                            setAvailableModels([]);
                                        } finally {
                                            setModelsFetching(false);
                                        }
                                    }}
                                    disabled={modelsFetching}
                                    className="flex items-center gap-1 text-[10px] text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 transition-colors disabled:opacity-50"
                                >
                                    {modelsFetching
                                        ? <><Loader2 size={10} className="animate-spin" /> {t('settings.online_fetching')}</>
                                        : <><RefreshCw size={10} /> {t('settings.online_fetch_models')}</>
                                    }
                                </button>
                            )}
                        </div>
                        <select
                            value={onlineModel}
                            onChange={e => { setOnlineModel(e.target.value); setProviderTestResult(null); }}
                            disabled={availableModels.length === 0 && !onlineModel}
                            className="w-full h-9 px-3 text-sm bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-zinc-900 dark:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <option value="">{t('settings.online_select_model')}</option>
                            {/* If the current model is set but not in the fetched list, include it as an option */}
                            {onlineModel && !availableModels.includes(onlineModel) && (
                                <option value={onlineModel}>{onlineModel}</option>
                            )}
                            {availableModels.map(m => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                    </div>

                    {/* Action / Status bar */}
                    <div className="flex items-center gap-2 pt-1">
                        {providerTestResult?.ok ? (
                            /* ── Saved state: status badge + delete button ── */
                            <>
                                <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#006540] dark:text-[#006540] bg-[#006540]/10 dark:bg-[#006540]/20 rounded-lg">
                                    <CheckCircle2 size={12} />
                                    {providerTestResult.msg}
                                </span>
                                <button
                                    onClick={async () => {
                                        await handleDeleteProvider(selectedPreset.id);
                                        setOnlineModel('');
                                        setAvailableModels([]);
                                    }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 hover:text-red-600 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                >
                                    <XCircle size={12} />
                                    {t('settings.delete_config') || '删除配置'}
                                </button>
                            </>
                        ) : (
                            /* ── Unconfigured / failed state: save button + optional quick activate ── */
                            <>
                                <button
                                    onClick={() => {
                                        const id = selectedPreset.id;
                                        const label = selectedPreset.label;
                                        const baseUrl = selectedPreset.id === 'custom' ? onlineBaseUrl : selectedPreset.baseUrl;
                                        handleSaveOnlineProvider(id, label, baseUrl, onlineModel, onlineApiKey);
                                    }}
                                    disabled={providerSaving || !(selectedPreset.id === 'custom' ? onlineBaseUrl : selectedPreset.baseUrl) || !onlineModel || (!onlineApiKey && !getSavedInfo(selectedPreset.id)?.has_key)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                                        providerSaving
                                            ? 'bg-zinc-200 dark:bg-zinc-700 text-[#545454] cursor-not-allowed'
                                            : 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-sm',
                                        (!(selectedPreset.id === 'custom' ? onlineBaseUrl : selectedPreset.baseUrl) || !onlineModel) && 'opacity-50 cursor-not-allowed'
                                    )}
                                >
                                    {providerSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                    {providerSaving ? t('settings.online_saving') : t('settings.online_save_test')}
                                </button>

                                {/* Quick activate for configured but inactive providers */}
                                {getSavedInfo(selectedPreset.id) && !getSavedInfo(selectedPreset.id)?.active && (
                                    <button
                                        onClick={() => handleActivateProvider(selectedPreset.id)}
                                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 rounded-lg transition-colors"
                                    >
                                        <Check size={10} />
                                        {t('settings.quick_activate') || '快速启用'}
                                    </button>
                                )}

                                {/* Failed test result */}
                                {providerTestResult && !providerTestResult.ok && (
                                    <span className="text-xs flex items-center gap-1 text-red-500">
                                        <XCircle size={12} />
                                        {providerTestResult.msg}
                                    </span>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════
                Section 4: Whisper 语音模型管理
               ══════════════════════════════════════════════════════════ */}
            <WhisperModelPanel />

            {/* ── 内置技能介绍（只读） ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1">
                    {t('settings.builtin_skills_title') || '内置 AI 技能'}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#545454] mb-4">
                    {t('settings.builtin_skills_desc') || '以下技能通过编辑器中的魔术棒手动触发。'}
                </p>
                <div className="grid gap-2">
                    {[
                        { icon: <Tag size={18} className="text-[#545454]" />, name: t('settings.skill_tagging'), desc: t('settings.skill_tagging_desc') },
                        { icon: <FileText size={18} className="text-[#545454]" />, name: t('settings.skill_summary'), desc: t('settings.skill_summary_desc') },
                        { icon: <Search size={18} className="text-[#545454]" />, name: t('settings.skill_embedding'), desc: t('settings.skill_embedding_desc') },
                        { icon: <Ghost size={18} className="text-[#545454]" />, name: t('settings.skill_ghostlink'), desc: t('settings.skill_ghostlink_desc') },
                        { icon: <PenLine size={18} className="text-[#545454]" />, name: t('settings.skill_smart_rename'), desc: t('settings.skill_smart_rename_desc') },
                        { icon: <Package size={18} className="text-[#545454]" />, name: t('settings.skill_classification'), desc: t('settings.skill_classification_desc') },
                    ].map(skill => (
                        <div
                            key={skill.name}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#C8C8C8]/10 dark:bg-zinc-800/40"
                        >
                            <span className="text-base shrink-0">{skill.icon}</span>
                            <div className="min-w-0">
                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{skill.name}</span>
                                <p className="text-xs text-[#545454] dark:text-[#545454] truncate">{skill.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── 自定义技能 ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <CustomSkillsTab />
            </div>


        </div>
    );
};

// ── Whisper 语音模型管理面板 ──

const DEFAULT_WHISPER_MODELS = [
    { name: "tiny", size_mb: 75, description: "最快速度，适合简单对话", downloaded: false, active: false, download_status: null, download_progress: 0, download_error: null },
    { name: "base", size_mb: 145, description: "平衡速度与质量", downloaded: false, active: false, download_status: null, download_progress: 0, download_error: null },
    { name: "small", size_mb: 488, description: "较好质量，适合大多数场景", downloaded: false, active: false, download_status: null, download_progress: 0, download_error: null },
    { name: "medium", size_mb: 1460, description: "高质量，适合专业转写", downloaded: false, active: false, download_status: null, download_progress: 0, download_error: null },
    { name: "large-v3", size_mb: 3090, description: "最高质量，需要较多资源", downloaded: false, active: false, download_status: null, download_progress: 0, download_error: null },
] as const;

const WhisperModelPanel = () => {
    const { t } = useTranslation();
    const [models, setModels] = useState<Array<{
        name: string; size_mb: number; description: string;
        downloaded: boolean; active: boolean;
        download_status: string | null; download_progress: number;
        download_error: string | null;
    }>>([]);
    const [loading, setLoading] = useState(false);
    const [activating, setActivating] = useState<string | null>(null);
    const [sidecarReady, setSidecarReady] = useState<boolean>(true);

    const fetchModels = useCallback(async () => {
        setLoading(true);
        try {
            const { getWhisperModels } = await import('@/services/WhisperService');
            const data = await getWhisperModels();
            // Defense-in-depth: enforce active only if downloaded (shields from old cached sidecar binary returning true)
            const sanitizedModels = (data.models || []).map((m: any) => ({
                ...m,
                active: m.active && m.downloaded
            }));
            setModels(sanitizedModels);
            setSidecarReady(true);
        } catch (e) {
            console.error('Failed to load whisper models:', e);
            setModels([...DEFAULT_WHISPER_MODELS]);
            setSidecarReady(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchModels(); }, [fetchModels]);

    // 轮询下载中的模型进度，或在 Sidecar 未就绪时不断尝试连接
    useEffect(() => {
        const downloading = models.some(m => m.download_status === 'downloading');
        if (!downloading && sidecarReady) return;
        const interval = setInterval(fetchModels, 3000);
        return () => clearInterval(interval);
    }, [models, sidecarReady, fetchModels]);

    const handleDownload = async (name: string) => {
        try {
            const { downloadWhisperModel } = await import('@/services/WhisperService');
            await downloadWhisperModel(name);
            fetchModels();
        } catch (e) {
            console.error('Download failed:', e);
        }
    };

    const handleActivate = async (name: string) => {
        setActivating(name);
        try {
            const { activateWhisperModel } = await import('@/services/WhisperService');
            await activateWhisperModel(name);
            fetchModels();
        } catch (e) {
            console.error('Activate failed:', e);
        } finally {
            setActivating(null);
        }
    };

    const formatSize = (mb: number) => mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

    return (
        <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Mic size={16} className="text-[#545454]" />
                    {t('settings.whisper_title')}
                </h3>
                <button
                    onClick={fetchModels}
                    disabled={loading}
                    className="flex items-center gap-1 text-[10px] text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 transition-colors disabled:opacity-50"
                >
                    {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    {t('settings.refresh')}
                </button>
            </div>
            <p className="text-sm text-[#545454] dark:text-[#545454] mb-3">
                {t('settings.whisper_desc')}
            </p>

            {!sidecarReady && !loading && (
                <div className="p-3 mb-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-xl text-xs text-[#A42227] flex items-center gap-2">
                    <XCircle size={14} />
                    {t('settings.whisper_unavailable')}
                </div>
            )}

            <div className="space-y-2">
                {models.map(m => (
                    <div
                        key={m.name}
                        className={cn(
                            "flex items-center gap-3 px-4 py-3 rounded-xl border transition-all",
                            m.active
                                ? "bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800"
                                : "bg-[#C8C8C8]/10 dark:bg-zinc-800/50 border-[#C8C8C8] dark:border-[#C8C8C8]/30"
                        )}
                    >
                        {/* 模型信息 */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{m.name}</span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-[#545454] dark:text-[#545454]">
                                    {formatSize(m.size_mb)}
                                </span>
                                {m.active && (
                                    <span className="flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400 font-medium">
                                        <CheckCircle2 size={10} />
                                        {t('settings.whisper_active')}
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-[#545454] dark:text-[#545454] mt-0.5">{t(`settings.whisper_model_${m.name.replace('-', '_')}`, { defaultValue: m.description })}</p>

                            {/* 下载进度 */}
                            {m.download_status === 'downloading' && (
                                <div className="mt-2 flex items-center gap-2">
                                    <Loader2 size={10} className="animate-spin text-indigo-500" />
                                    <div className="flex-1 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                                            style={{ width: `${m.download_progress}%` }}
                                        />
                                    </div>
                                    <span className="text-[10px] text-[#545454]">{m.download_progress}%</span>
                                </div>
                            )}
                            {m.download_status === 'error' && (
                                <p className="mt-1 text-[10px] text-red-500">❌ {m.download_error}</p>
                            )}
                        </div>

                        {/* 操作按钮 */}
                        <div className="shrink-0">
                            {!m.downloaded && m.download_status !== 'downloading' && (
                                <button
                                    onClick={() => handleDownload(m.name)}
                                    disabled={!sidecarReady}
                                    className={cn(
                                        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors",
                                        !sidecarReady ? "bg-[#006540]/50 cursor-not-allowed" : "bg-[#006540] hover:bg-[#005030]"
                                    )}
                                >
                                    <Download size={12} /> {t('settings.download')}
                                </button>
                            )}
                            {m.downloaded && !m.active && (
                                <button
                                    onClick={() => handleActivate(m.name)}
                                    disabled={activating === m.name || !sidecarReady}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {activating === m.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                    {t('settings.whisper_activate')}
                                </button>
                            )}
                        </div>
                    </div>
                ))}

            </div>
        </div>
    );
};
