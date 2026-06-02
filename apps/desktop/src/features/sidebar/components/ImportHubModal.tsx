import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { CloudDownload, FileUp, Loader2, X, Cpu, Check, Link2 } from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import { importService } from '@/services/ImportService';
import { useFileSystemStore } from '@/core/fs/store';
import { getBasename } from '@/shared/utils/pathUtils';

export type LlmConfig = { baseUrl: string; apiKey?: string; model: string };

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = [
    'pdf', 'docx', 'doc', 'pptx', 'xlsx', 'xls',
    'csv', 'json', 'xml', 'html', 'htm', 'txt',
    'epub', 'zip', 'md',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma',
    'mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v'
];

interface ImportHubModalProps {
    vaultPath: string;
    onClose: () => void;
    onImported?: (notePath: string) => void;
}


export const ImportHubModal: React.FC<ImportHubModalProps> = ({ vaultPath, onClose, onImported }) => {
    const { t, i18n } = useTranslation();

    // UI State
    const [isImporting, setIsImporting] = useState(false);
    const [processLogs, setProcessLogs] = useState<string[]>([]);

    // Inputs
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [inputUrl, setInputUrl] = useState('');

    // AI Provider State
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [config, setConfig] = useState<any>(null);
    const [selectedModel, setSelectedModel] = useState<string>(''); // 'local:modelName', 'online:modelName'
    const [localModels, setLocalModels] = useState<string[]>([]);

    // Active online provider state (from online_providers, not stale provider_config)
    const [activeOnlineModel, setActiveOnlineModel] = useState<string>('');

    useEffect(() => {
        const fetchConfigs = async () => {
            try {
                const cfg = await invoke<any>('get_ai_provider_config');
                setConfig(cfg);

                // 从 online_providers 读取 active provider 的 model（最可靠来源）
                let resolvedOnlineModel = cfg.online_model || '';
                try {
                    const providers = await invoke<{ id: string; model: string; active: boolean; has_key: boolean }[]>('get_online_providers');
                    const active = providers.find(p => p.active);
                    if (active) {
                        resolvedOnlineModel = active.model;
                    }
                } catch {
                    // fallback to cfg.online_model
                }
                setActiveOnlineModel(resolvedOnlineModel);

                setSelectedModel(cfg.provider_type === 'online' && resolvedOnlineModel
                    ? `online:${resolvedOnlineModel}`
                    : `local:${cfg.generation_model}`);

                if (cfg.ollama_host) {
                    // 过滤掉纯向量嵌入模型（不是 LLM，不能用于文本生成/Vision 任务）
                    const EMBEDDING_ONLY_MODELS = ['bge-m3', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'];
                    invoke<string[]>('list_ollama_models', { host: cfg.ollama_host, port: cfg.ollama_port })
                        .then(models => setLocalModels(models.filter(m => !EMBEDDING_ONLY_MODELS.some(e => m.startsWith(e)))))
                        .catch(() => { });
                }
            } catch (err) {
                console.error("Failed to fetch AI configs", err);
            } finally {
                setLoadingConfig(false);
            }
        };
        fetchConfigs();
    }, []);

    // 模拟等待期间的进度日志
    useEffect(() => {
        if (!isImporting) {
            setProcessLogs([]);
            return;
        }

        const logsSequence = [
            t('import.log_init', '正在初始化提取引擎...'),
            t('import.log_read_media', '读取并切片媒体二进制流...'),
            t('import.log_analyze_meta', '分析文件元信息与嵌入资源...'),
            t('import.log_analyze_text', '分析常规文本与版面结构...'),
            t('import.log_extract_img', '提取内嵌图像与图表特征...'),
            t('import.log_trigger_llm', '触发大规模参数模型推理上下文...'),
            t('import.log_semantic_norm', '根据领域词典进行语义规范化...'),
            t('import.log_format_md', '校验输出格式并重组成 Markdown...'),
            t('import.log_queueing', '处理流程排队等待完成中...')
        ];

        let index = 0;
        let timeoutId: string | number | NodeJS.Timeout;

        const pushNextLog = () => {
            if (index < logsSequence.length) {
                setProcessLogs(prev => [...prev.slice(-3), logsSequence[index]]);
                index++;
                timeoutId = setTimeout(pushNextLog, Math.random() * 2500 + 1500);
            }
        };

        // 初始延迟1秒后开始打印
        timeoutId = setTimeout(pushNextLog, 1000);
        return () => clearTimeout(timeoutId);
    }, [isImporting, t]);


    const handleSelectFile = async () => {
        const selected = await open({
            multiple: false,
            filters: [{
                name: 'Documents',
                extensions: SUPPORTED_EXTENSIONS,
            }],
        });
        if (selected) {
            setSelectedFile(typeof selected === 'string' ? selected : selected[0]);
        }
    };

    const handleImportSubmit = async () => {
        if (!vaultPath || isImporting) return;
        if (!selectedFile && !inputUrl.trim()) return;

        const isAudioVideo = selectedFile ? [
            '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma',
            '.mp4', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.m4v'
        ].some(ext => selectedFile.toLowerCase().endsWith(ext)) : false;

        // Build Config
        let currentLlmConfig: LlmConfig | undefined = undefined;
        // 如果是音视频或者 URL，则跳过 Vision LLM 配置
        if (selectedFile && !isAudioVideo && config && selectedModel) {
            const [type, ...modelParts] = selectedModel.split(':');
            const modelName = modelParts.join(':');

            currentLlmConfig = {
                baseUrl: type === 'local'
                    ? `${config.ollama_host.replace(/\/$/, '')}:${config.ollama_port}/v1`
                    : config.online_base_url,
                apiKey: type === 'local' ? 'ollama' : config.online_api_key,
                model: modelName
            };
        }

        setIsImporting(true);
        try {
            const { toast } = await import('sonner');
            let newNotePath = '';

            if (selectedFile) {
                newNotePath = await importService.importFile(selectedFile, vaultPath, currentLlmConfig, undefined, i18n.language);
                const fileName = getBasename(selectedFile) || 'file';
                toast.success(t('import.success', { filename: fileName }));
            } else if (inputUrl.trim()) {
                // URLs NEVER use the Vision LLM config
                newNotePath = await importService.importUrl(inputUrl.trim(), vaultPath, undefined, undefined, i18n.language);
                toast.success(t('import.success', { filename: 'Web Link' }));
            }

            await useFileSystemStore.getState().loadRoot(vaultPath);
            useFileSystemStore.getState().expandToPath(newNotePath);
            onImported?.(newNotePath);
            onClose();
        } catch (err) {
            const { toast } = await import('sonner');
            toast.error(t('import.failed', { error: String(err) }));
        } finally {
            setIsImporting(false);
        }
    };

    const isReady = !!selectedFile || !!inputUrl.trim();
    const isAudioVideo = selectedFile ? [
        '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma',
        '.mp4', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.m4v'
    ].some(ext => selectedFile.toLowerCase().endsWith(ext)) : false;

    return (
        <div
            className="fixed inset-0 z-200 flex items-center justify-center p-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={!isImporting ? onClose : undefined}
        >
            <div
                className="relative w-full max-w-[520px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-6 pb-4 border-b border-zinc-100 dark:border-zinc-800/50">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-blue-400">
                            <CloudDownload className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 leading-none mb-1.5">
                                {t('import.hub_title', '文档解析引擎')}
                            </h2>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                {t('import.hub_desc', '将任意媒体或链接转化为 Markdown 笔记')}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content Body - Scalable */}
                {isImporting ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-12 text-center animate-in fade-in zoom-in duration-300">
                        <div className="relative mb-6">
                            <div className="absolute inset-0 bg-indigo-500/20 rounded-full blur-xl animate-pulse" />
                            <div className="relative w-16 h-16 bg-linear-to-tr from-indigo-500 to-purple-500 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-500/20">
                                <Cpu className="w-8 h-8 text-white animate-pulse" />
                            </div>
                        </div>
                        <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                            {t('import.reasoning', 'AI 引擎提取与推理中...')}
                        </h3>
                        <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">
                            {t('import.run_in_bg_hint', '您可以点击下方在后台运行，完成后将为您推送')}
                        </p>

                        <div
                            className="w-full max-w-[320px] h-24 mb-4 flex flex-col justify-end overflow-hidden relative"
                            style={{ WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 50%)' }}
                        >
                            <div className="flex flex-col gap-1.5 absolute bottom-0 left-0 w-full">
                                {processLogs.map((log, i) => (
                                    <div
                                        key={i}
                                        className="text-[13px] text-zinc-500 dark:text-zinc-400 font-mono text-left animate-in slide-in-from-bottom-2 fade-in duration-300"
                                    >
                                        <span className="text-indigo-400 dark:text-blue-300 font-bold mr-2">&gt;</span>{log}
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="flex gap-1.5 items-center">
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        {/* File & URL Inputs Container */}
                        <div className="flex flex-col gap-6">

                            {/* File Dropzone */}
                            <div
                                onClick={!inputUrl.trim() ? handleSelectFile : undefined}
                                className={cn(
                                    "flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl transition-all min-h-[140px]",
                                    inputUrl.trim()
                                        ? "opacity-50 cursor-not-allowed border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50"
                                        : selectedFile
                                            ? "border-indigo-500/50 dark:border-blue-400/50 bg-indigo-50/30 dark:bg-indigo-500/5 cursor-pointer"
                                            : "border-zinc-200 dark:border-zinc-800 hover:border-indigo-400 dark:hover:border-blue-400/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                                )}
                            >
                                {selectedFile ? (
                                    <div className="flex flex-col items-center text-center">
                                        <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-3">
                                            <Check className="w-6 h-6" />
                                        </div>
                                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 break-all max-w-[90%] line-clamp-2">
                                            {getBasename(selectedFile)}
                                        </span>
                                        <span className="text-xs text-zinc-500 mt-1">{t('import.click_to_reselect', '点击重新选择')}</span>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center text-center text-zinc-500 dark:text-zinc-400">
                                        <FileUp className="w-10 h-10 mb-3 opacity-50 text-indigo-500 dark:text-blue-400" />
                                        <span className="text-[15px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                                            {t('import.drop_zone_title', '点击选择文件')}
                                        </span>
                                        <span className="text-xs opacity-75 max-w-[300px] leading-relaxed">
                                            {t('import.drop_zone_desc', '支持 PDF, Office, 音视频, EPubs, 文本等格式。富媒体将自动提示使用大模型。')}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Divider */}
                            <div className="flex items-center gap-4">
                                <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-800/80"></div>
                                <span className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">OR</span>
                                <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-800/80"></div>
                            </div>

                            {/* URL Input */}
                            <div className="flex flex-col">
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                                        <Link2 className={cn("w-5 h-5", selectedFile ? "text-zinc-300 dark:text-zinc-600" : "text-indigo-500/70 dark:text-blue-400/80")} />
                                    </div>
                                    <input
                                        type="url"
                                        value={inputUrl}
                                        onChange={(e) => {
                                            setInputUrl(e.target.value);
                                            if (e.target.value.trim() && selectedFile) setSelectedFile(null); // Clear file if URL is typed
                                        }}
                                        disabled={!!selectedFile}
                                        placeholder={t('import.url_input_placeholder', 'https://youtube.com/... 或任意文章链接')}
                                        className={cn(
                                            "w-full pl-12 pr-4 py-3.5 bg-zinc-50 dark:bg-zinc-900/50 border rounded-xl outline-none text-sm transition-all text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500",
                                            selectedFile
                                                ? "border-zinc-200 dark:border-zinc-800 opacity-50 cursor-not-allowed"
                                                : "border-zinc-200 dark:border-zinc-800 focus:ring-2 focus:ring-indigo-500/20 dark:focus:ring-blue-400/20 focus:border-indigo-500 dark:focus:border-blue-400/60"
                                        )}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* AI Provider Config (Only visible if a file is selected and it's not AV) */}
                        {!isAudioVideo && selectedFile && (
                            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800/50">
                                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3 block">
                                    {t('import.vision_llm_title', '图片解析大模型 (Vision LLM)')}
                                </label>

                                {loadingConfig ? (
                                    <div className="flex items-center gap-2 text-zinc-400 text-sm py-2">
                                        <Loader2 className="w-4 h-4 animate-spin" /> Load config...
                                    </div>
                                ) : (
                                    <div className="relative">
                                        <select
                                            value={selectedModel}
                                            onChange={(e) => setSelectedModel(e.target.value)}
                                            className="w-full appearance-none px-4 py-3 pr-10 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:ring-2 focus:ring-indigo-500 dark:focus:ring-blue-400/30 focus:border-indigo-500 dark:focus:border-blue-400 outline-none text-sm transition-all text-zinc-900 dark:text-zinc-100 font-medium"
                                        >

                                            {localModels.length > 0 ? (
                                                <optgroup label="Local (Ollama)">
                                                    {localModels.map(m => (
                                                        <option key={`local:${m}`} value={`local:${m}`}>{m}</option>
                                                    ))}
                                                </optgroup>
                                            ) : config?.generation_model && (
                                                <optgroup label="Local (Ollama)">
                                                    <option value={`local:${config.generation_model}`}>{config.generation_model}</option>
                                                </optgroup>
                                            )}

                                            {activeOnlineModel && (
                                                <optgroup label="Online API">
                                                    <option value={`online:${activeOnlineModel}`}>{activeOnlineModel}</option>
                                                </optgroup>
                                            )}
                                        </select>
                                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-zinc-400">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Footer Action */}
                <div className="p-4 bg-zinc-50 dark:bg-zinc-900/80 border-t border-zinc-100 dark:border-zinc-800 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors"
                    >
                        {isImporting ? t('import.btn_run_in_background', '后台运行') : t('import.btn_cancel', '取消')}
                    </button>
                    {!isImporting && (
                        <button
                            onClick={handleImportSubmit}
                            disabled={!isReady || loadingConfig}
                            className="flex items-center gap-2 px-6 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 text-white shadow-sm disabled:opacity-50 transition-colors"
                        >
                            {t('import.btn_import', '导入')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
