import { useState, useEffect } from "react";
import { Loader2, RefreshCw, CheckCircle2, Trash2, Download, Activity, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { cleanUnusedAssets, formatBytes, rebuildAssetIndex } from "@/core/media/AssetCleanupService";
import { vaultService } from "@/core/vault/VaultService";

interface EmbeddingStats {
    total_embeddings: number;
    completed: number;
    pending: number;
    processing: number;
    failed: number;
    abandoned: number;
    needs_rebuild: number;
    unique_notes: number;
    current_model_version: string;
    current_pipeline_version: number;
}

export const MaintenanceTab = () => {
    const { t } = useTranslation();
    const [cleanupStatus, setCleanupStatus] = useState<'idle' | 'loading' | 'done'>('idle');
    const [cleanupResult, setCleanupResult] = useState<{ count: number; space: string } | null>(null);
    const [rebuildStatus, setRebuildStatus] = useState<'idle' | 'loading' | 'done'>('idle');
    const [rebuildResult, setRebuildResult] = useState<number | null>(null);

    const [embeddingStats, setEmbeddingStats] = useState<EmbeddingStats | null>(null);
    const [embeddingLoading, setEmbeddingLoading] = useState(false);
    const [embeddingVersionMismatch, setEmbeddingVersionMismatch] = useState(false);
    const [embeddingActionStatus, setEmbeddingActionStatus] = useState<'idle' | 'loading' | 'done'>('idle');
    const [embeddingActionResult, setEmbeddingActionResult] = useState<string | null>(null);

    const loadEmbeddingStats = async () => {
        setEmbeddingLoading(true);
        try {
            const stats = await invoke<EmbeddingStats>('get_embedding_stats');
            setEmbeddingStats(stats);
            const hasMismatch = await invoke<boolean>('check_embedding_version_mismatch');
            setEmbeddingVersionMismatch(hasMismatch);
        } catch (e) {
            console.error('Failed to load embedding stats:', e);
        } finally {
            setEmbeddingLoading(false);
        }
    };

    const handleEmbeddingRebuild = async () => {
        setEmbeddingActionStatus('loading');
        try {
            const count = await invoke<number>('trigger_embedding_rebuild', { batchSize: 100 });
            setEmbeddingActionResult(t('settings.embedding_rebuilt', { count }));
            setEmbeddingActionStatus('done');
            loadEmbeddingStats();
        } catch (e) {
            console.error('Failed to trigger rebuild:', e);
            setEmbeddingActionStatus('idle');
        }
    };

    const handleEmbeddingClear = async () => {
        setEmbeddingActionStatus('loading');
        try {
            const count = await invoke<number>('clear_embedding_cache');
            setEmbeddingActionResult(t('settings.embedding_cleared', { count }));
            setEmbeddingActionStatus('done');
            loadEmbeddingStats();
        } catch (e) {
            console.error('Failed to clear cache:', e);
            setEmbeddingActionStatus('idle');
        }
    };

    useEffect(() => {
        loadEmbeddingStats();
    }, []);

    const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
    const [exportMessage, setExportMessage] = useState<string | null>(null);

    const handleExportDiagnostics = async () => {
        try {
            setExportStatus('loading');
            setExportMessage(null);
            
            // 1. Prompt user for save location
            const defaultPath = `slash_diagnostics_${new Date().toISOString().split('T')[0]}.zip`;
            const savePath = await save({
                defaultPath,
                filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
            });

            if (!savePath) {
                setExportStatus('idle');
                return; // User cancelled
            }

            // 2. Call Rust backend to export
            const result = await invoke<{success: boolean; path: string | null; error: string | null}>('export_diagnostics', { targetPath: savePath });
            
            if (result.success) {
                setExportStatus('done');
                setExportMessage(t('settings.export_diagnostics_success', { path: result.path }) || `导出成功: ${result.path}`);
            } else {
                setExportStatus('error');
                setExportMessage(t('settings.export_diagnostics_error', { error: result.error }) || `导出失败: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to export diagnostics:', error);
            setExportStatus('error');
            setExportMessage(typeof error === 'string' ? error : (error as Error).message || 'Unknown error');
        }
    };

    return (
        <div className="space-y-6">
            {/* ── Export Diagnostics Section ── */}
            <div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Activity size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t('settings.export_diagnostics_title') || '导出诊断报告'}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t('settings.export_diagnostics_desc') || '打包最近的系统日志与配置文件，以便在内测群或 GitHub 上反馈问题。所有日志均会在本地脱敏（屏蔽个人 API Key 等信息）。'}
                </p>
                <div className="space-y-4">
                    <button
                        onClick={handleExportDiagnostics}
                        disabled={exportStatus === 'loading'}
                        className={cn(
                            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                            exportStatus === 'loading'
                                ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                : "bg-[#002FA7] hover:bg-[#002FA7]/90 text-white shadow-sm"
                        )}
                    >
                        {exportStatus === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                        {exportStatus === 'loading'
                            ? (t("settings.export_diagnostics_packing") || "打包中...")
                            : (t("settings.export_diagnostics_button") || "一键打包")}
                    </button>

                    {exportMessage && (
                        <div className={cn(
                            "mt-4 p-3 border rounded-lg",
                            exportStatus === 'done' 
                                ? "bg-[#006540]/10 border-[#006540]/30" 
                                : "bg-[#A42227]/10 border-[#A42227]/30"
                        )}>
                            <p className={cn(
                                "text-sm break-all",
                                exportStatus === 'done' ? "text-[#006540] dark:text-[#006540]" : "text-[#A42227] dark:text-[#A42227]"
                            )}>
                                {exportMessage}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Storage Cleanup Section ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Trash2 size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t("settings.cleanup_title") || "Storage Cleanup"}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.cleanup_desc") || "Remove unused assets that are no longer referenced in any notes. Files will be moved to .trash folder."}
                </p>

                <div className="space-y-4">
                    <button
                        onClick={async () => {
                            setCleanupStatus('loading');
                            setCleanupResult(null);
                            try {
                                const result = await cleanUnusedAssets();
                                setCleanupResult({
                                    count: result.moved_count,
                                    space: formatBytes(result.space_saved_bytes)
                                });
                                setCleanupStatus('done');
                            } catch (e) {
                                console.error('Cleanup failed:', e);
                                setCleanupStatus('idle');
                            }
                        }}
                        disabled={cleanupStatus === 'loading'}
                        className={cn(
                            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                            cleanupStatus === 'loading'
                                ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                : "bg-[#002FA7] hover:bg-[#002FA7]/90 text-white shadow-sm"
                        )}
                    >
                        {cleanupStatus === 'loading' && <Loader2 size={16} className="animate-spin" />}
                        {cleanupStatus === 'loading'
                            ? (t("settings.cleanup_scanning") || "Scanning...")
                            : (t("settings.cleanup_button") || "Clean Unused Assets")}
                    </button>

                    {cleanupStatus === 'done' && cleanupResult && (
                        <div className="mt-4 p-3 bg-[#006540]/10 border border-[#006540]/30 rounded-lg">
                            <p className="text-sm text-[#006540] dark:text-[#006540]">
                                {cleanupResult.count === 0
                                    ? t("settings.cleanup_none")
                                    : t("settings.cleanup_done", { count: cleanupResult.count, space: cleanupResult.space })
                                }
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Rebuild Index Section ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <RefreshCw size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t("settings.rebuild_title") || "Rebuild Asset Index"}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.rebuild_desc") || "Rescan all assets if files were modified outside the app."}
                </p>

                <div className="space-y-4">
                    <button
                        onClick={async () => {
                            setRebuildStatus('loading');
                            setRebuildResult(null);
                            try {
                                const result = await rebuildAssetIndex();
                                setRebuildResult(result.files_indexed);
                                setRebuildStatus('done');
                            } catch (e) {
                                console.error('Rebuild failed:', e);
                                setRebuildStatus('idle');
                            }
                        }}
                        disabled={rebuildStatus === 'loading'}
                        className={cn(
                            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                            rebuildStatus === 'loading'
                                ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                : "bg-[#545454] hover:bg-[#545454]/90 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-white shadow-sm"
                        )}
                    >
                        {rebuildStatus === 'loading' && <Loader2 size={16} className="animate-spin" />}
                        {rebuildStatus === 'loading'
                            ? (t("settings.rebuild_scanning") || "Scanning...")
                            : (t("settings.rebuild_button") || "Rebuild Index")}
                    </button>

                    {rebuildStatus === 'done' && rebuildResult !== null && (
                        <div className="mt-4 p-3 bg-[#002FA7]/10 border border-[#002FA7]/30 rounded-lg">
                            <p className="text-sm text-[#002FA7] dark:text-blue-400">
                                {t("settings.rebuild_done", { count: rebuildResult })}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Embedding Index Section ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                        <Brain size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                        {t("settings.embedding_title") || "Embedding Index"}
                    </h3>
                    <button
                        onClick={() => loadEmbeddingStats()}
                        className="flex items-center gap-1 px-2 py-1.5 text-xs text-[#545454] hover:text-zinc-900 dark:text-[#C8C8C8] dark:hover:text-white bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-md transition-colors shadow-sm"
                    >
                        <RefreshCw size={12} className={embeddingLoading ? "animate-spin" : ""} />
                        {t("settings.refresh") || "Refresh"}
                    </button>
                </div>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.embedding_desc") || "Semantic vectors for note similarity and search."}
                </p>

                <div className="space-y-4">
                    {/* Stats Display */}
                    {embeddingStats && (
                        <div className="p-3 bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 rounded-lg space-y-2">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-[#545454] dark:text-[#C8C8C8]">{t('settings.embedding_total_count')}</span>
                                <span className="font-medium text-zinc-900 dark:text-zinc-100">{embeddingStats.total_embeddings}</span>
                            </div>
                            <div className="text-xs text-[#545454] dark:text-[#C8C8C8]">
                                Model: {embeddingStats.current_model_version} | Pipeline v{embeddingStats.current_pipeline_version}
                            </div>
                        </div>
                    )}

                    {/* Version Mismatch Warning */}
                    {embeddingVersionMismatch && embeddingStats && embeddingStats.needs_rebuild > 0 && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                            <p className="text-sm text-amber-700 dark:text-amber-300">
                                ⚠️ {t("settings.embedding_version_mismatch", { count: embeddingStats.needs_rebuild })}
                            </p>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex gap-2 flex-wrap">
                        {/* Rebuild All */}
                        <button
                            onClick={async () => {
                                const confirmMsg = t("settings.embedding_rebuild_all_confirm") || "确定重建所有笔记的向量索引？这会将所有记录重置为待处理状态。";
                                const confirmed = await window.confirm(confirmMsg);
                                if (!confirmed) return;
                                setEmbeddingActionStatus('loading');
                                setEmbeddingActionResult('🚀 正在启动重建...');

                                const vaultPath = vaultService.getLastOpenedVault();
                                if (!vaultPath) {
                                    setEmbeddingActionResult('❌ 无法获取 Vault 路径');
                                    setEmbeddingActionStatus('idle');
                                    return;
                                }

                                let unlisten: UnlistenFn | null = null;
                                try {
                                    unlisten = await listen<{ current: number; total: number; current_note: string; status: string }>(
                                        'embedding:rebuild-progress',
                                        (event) => {
                                            const { current_note, status } = event.payload;
                                            if (status === 'completed') {
                                                setEmbeddingActionResult('✅ 重建完成！');
                                                setEmbeddingActionStatus('done');
                                                loadEmbeddingStats();
                                                if (unlisten) unlisten();
                                            } else if (current_note) {
                                                setEmbeddingActionResult(`🔄 处理中: ${current_note}`);
                                            }
                                        }
                                    );

                                    await invoke<string>('process_all_embeddings', { vaultPath });
                                    setEmbeddingActionStatus('done');
                                } catch (e) {
                                    console.error('Failed to rebuild all:', e);
                                    setEmbeddingActionResult(`❌ 重建失败: ${e}`);
                                    setEmbeddingActionStatus('idle');
                                    if (unlisten) unlisten();
                                }
                            }}
                            disabled={embeddingActionStatus === 'loading'}
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                                embeddingActionStatus === 'loading'
                                    ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                    : "bg-[#006540] hover:bg-[#005030] text-white shadow-sm"
                            )}
                        >
                            {embeddingActionStatus === 'loading' && <Loader2 size={16} className="animate-spin" />}
                            {t("settings.embedding_rebuild_all") || "重建全部"}
                        </button>
                        <button
                            onClick={handleEmbeddingRebuild}
                            disabled={embeddingActionStatus === 'loading' || !embeddingVersionMismatch}
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                                embeddingActionStatus === 'loading' || !embeddingVersionMismatch
                                    ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                    : "bg-[#002FA7] hover:bg-[#002FA7]/90 text-white shadow-sm"
                            )}
                        >
                            {embeddingActionStatus === 'loading' && <Loader2 size={16} className="animate-spin" />}
                            {embeddingActionStatus === 'loading'
                                ? (t("settings.embedding_rebuilding") || "Rebuilding...")
                                : (t("settings.embedding_rebuild_button") || "Rebuild Outdated")}
                        </button>
                        <button
                            onClick={async () => {
                                const confirmMsg = t("settings.embedding_clear_confirm", { count: embeddingStats?.total_embeddings || 0 }) || `⚠️ 确定清空所有向量索引？这将删除 ${embeddingStats?.total_embeddings || 0} 条记录，需要重新生成。`;
                                const confirmed = await window.confirm(confirmMsg);
                                if (confirmed) {
                                    handleEmbeddingClear();
                                }
                            }}
                            disabled={embeddingActionStatus === 'loading'}
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                                embeddingActionStatus === 'loading'
                                    ? "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8] cursor-not-allowed"
                                    : "bg-[#A42227] hover:bg-[#A42227]/90 text-white shadow-sm"
                            )}
                        >
                            <Trash2 size={14} />
                            {t("settings.embedding_clear") || "Clear Cache"}
                        </button>
                    </div>

                    {/* Action Result */}
                    {embeddingActionStatus === 'done' && embeddingActionResult && (
                        <div className="p-3 bg-[#006540]/10 border border-[#006540]/30 rounded-lg">
                            <p className="text-sm text-[#006540] dark:text-[#006540]">
                                {embeddingActionResult}
                            </p>
                        </div>
                    )}

                    {/* Up to date message */}
                    {!embeddingVersionMismatch && embeddingStats && embeddingStats.completed > 0 && embeddingStats.needs_rebuild === 0 && embeddingStats.pending === 0 && embeddingStats.failed === 0 && (
                        <div className="p-3 bg-[#006540]/10 border border-[#006540]/30 rounded-lg">
                            <p className="text-sm text-[#006540] dark:text-[#006540] flex items-center gap-2">
                                <CheckCircle2 size={16} />
                                {t("settings.embedding_up_to_date") || "All embeddings up to date"}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
