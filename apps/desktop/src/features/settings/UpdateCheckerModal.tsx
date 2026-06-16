import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ArrowUpCircle, AlertTriangle, CheckCircle, RefreshCw, X } from 'lucide-react';
import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

type UpdateState = 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';

interface UpdateCheckerModalProps {
    onClose: () => void;
}

export const UpdateCheckerModal = ({ onClose }: UpdateCheckerModalProps) => {
    const { t } = useTranslation();
    const [state, setState] = useState<UpdateState>('checking');
    const [errorMsg, setErrorMsg] = useState('');
    const [version, setVersion] = useState('');
    const [body, setBody] = useState('');
    const [progress, setProgress] = useState(0);
    const [downloadedSize, setDownloadedSize] = useState('0 KB');
    const [totalSize, setTotalSize] = useState('0 KB');
    const [updateInstance, setUpdateInstance] = useState<any>(null);

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const value = bytes / Math.pow(k, i);
        return `${i === 0 ? Math.round(value).toString() : value.toFixed(1)} ${sizes[i]}`;
    };

    const handleCheckUpdate = async () => {
        setState('checking');
        setErrorMsg('');
        try {
            const update = await check();
            if (update) {
                setUpdateInstance(update);
                setVersion(update.version);
                setBody(update.body || '');
                setState('available');
                window.dispatchEvent(new CustomEvent('slash:update-available', {
                    detail: { version: update.version },
                }));
            } else {
                setState('latest');
                setTimeout(() => {
                    onClose();
                }, 1500);
            }
        } catch (err) {
            console.error('Check update error:', err);
            setErrorMsg(String(err));
            setState('error');
        }
    };

    useEffect(() => {
        handleCheckUpdate();
    }, []);

    const handleStartUpdate = async () => {
        if (!updateInstance) return;
        setState('downloading');
        setProgress(0);
        setDownloadedSize('0 KB');
        setTotalSize('0 KB');
        
        try {
            let downloadedBytesValue = 0;
            let totalBytesValue = 0;

            await invoke('shutdown_sidecar_for_update');

            await updateInstance.downloadAndInstall((event: any) => {
                switch (event.event) {
                    case 'Started':
                        totalBytesValue = event.data.contentLength || 0;
                        setTotalSize(formatBytes(totalBytesValue));
                        break;
                    case 'Progress':
                        downloadedBytesValue += event.data.chunkLength;
                        setDownloadedSize(formatBytes(downloadedBytesValue));
                        if (totalBytesValue > 0) {
                            const pct = Math.round((downloadedBytesValue / totalBytesValue) * 100);
                            setProgress(pct);
                        }
                        break;
                    case 'Finished':
                        break;
                }
            });
            setState('ready');
        } catch (err) {
            console.error('Download and install error:', err);
            setErrorMsg(String(err));
            setState('error');
        }
    };

    const handleRelaunch = async () => {
        try {
            await invoke('relaunch_app');
        } catch (err) {
            console.error('Failed to relaunch:', err);
            setErrorMsg(t('settings.relaunch_failed_hint', '重启失败，请手动重新启动应用'));
            setState('error');
        }
    };

    return (
        <div
            className="fixed inset-0 z-[11000] flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs transition-opacity duration-300"
            data-update-modal-state={state}
        >
            <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/20 dark:border-zinc-800/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl shadow-2xl p-6 transition-all duration-300 transform scale-100 flex flex-col gap-4 text-center">
                
                {/* Close Button */}
                {state !== 'downloading' && (
                    <button 
                        onClick={onClose} 
                        className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                    >
                        <X size={15} />
                    </button>
                )}

                {/* Checking State */}
                {state === 'checking' && (
                    <div className="py-6 flex flex-col items-center gap-3.5">
                        <Loader2 size={36} className="animate-spin text-[#002FA7] dark:text-blue-400" />
                        <div>
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.checking_updates', '正在检查更新')}</h3>
                            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{t('settings.checking_updates_desc', '正在连接服务器检索最新版本...')}</p>
                        </div>
                    </div>
                )}

                {/* Latest State */}
                {state === 'latest' && (
                    <div className="py-6 flex flex-col items-center gap-3.5">
                        <CheckCircle size={36} className="text-emerald-500" />
                        <div>
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.up_to_date', '已是最新版本')}</h3>
                            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{t('settings.up_to_date_desc', '您当前使用的 Slash 已是最新版本！')}</p>
                        </div>
                    </div>
                )}

                {/* Error State */}
                {state === 'error' && (
                    <div className="py-4 flex flex-col items-center gap-3.5">
                        <AlertTriangle size={36} className="text-rose-500 animate-bounce" />
                        <div className="w-full">
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.update_error', '检查更新失败')}</h3>
                            <div className="mt-2.5 mx-auto max-h-24 overflow-y-auto bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/30 rounded-xl p-3 text-left">
                                <p className="text-[11px] font-mono text-rose-600 dark:text-rose-400 break-all leading-normal">{errorMsg}</p>
                            </div>
                        </div>
                        <div className="flex gap-2.5 w-full mt-2">
                            <button 
                                onClick={onClose} 
                                className="flex-1 px-4 py-2 text-xs font-semibold rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                            >
                                {t('settings.close', '关闭')}
                            </button>
                            <button 
                                onClick={handleCheckUpdate} 
                                className="flex-1 px-4 py-2 text-xs font-semibold rounded-xl bg-[#002FA7] hover:bg-[#002FA7] text-white transition-colors"
                            >
                                {t('settings.retry', '重试')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Available State */}
                {state === 'available' && (
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-11 h-11 rounded-full bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center border border-indigo-100 dark:border-blue-500/25">
                                <ArrowUpCircle size={22} className="text-[#002FA7] dark:text-blue-400" />
                            </div>
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.update_available', '发现新版本可用')}</h3>
                            <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-[#002FA7] dark:text-blue-400 border border-indigo-100/30 dark:border-blue-500/20 text-[11px] font-bold font-mono">
                                v{version}
                            </span>
                        </div>

                        {body && (
                            <div className="max-h-36 overflow-y-auto bg-zinc-50/50 dark:bg-zinc-800/30 rounded-xl p-3 border border-zinc-150 dark:border-zinc-800/40 text-left">
                                <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">{t('settings.release_notes', '更新说明')}</p>
                                <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed break-all font-medium">{body}</p>
                            </div>
                        )}

                        <div className="flex gap-2.5 w-full mt-1">
                            <button 
                                onClick={onClose} 
                                className="flex-1 px-4 py-2.5 text-xs font-semibold rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                            >
                                {t('settings.later', '稍后升级')}
                            </button>
                            <button 
                                onClick={handleStartUpdate} 
                                className="flex-1 px-4 py-2.5 text-xs font-semibold rounded-xl bg-[#002FA7] hover:bg-[#002FA7] text-white transition-colors shadow-md hover:shadow-lg"
                            >
                                {t('settings.update_now', '立即下载并升级')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Downloading State */}
                {state === 'downloading' && (
                    <div className="py-4 flex flex-col gap-4">
                        <div className="flex flex-col items-center gap-2">
                            <Loader2 size={32} className="animate-spin text-[#002FA7] dark:text-blue-400" />
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.downloading_update', '正在下载更新包')}</h3>
                            <div className="grid grid-cols-[5.5rem_1rem_auto] items-center justify-center text-xs text-zinc-400 dark:text-zinc-500 font-medium font-mono tabular-nums">
                                <span className="text-right">{downloadedSize}</span>
                                <span className="text-center">/</span>
                                <span className="text-left">{totalSize}</span>
                            </div>
                        </div>

                        {/* Premium Progress Bar */}
                        <div className="space-y-1.5">
                            <div className="h-2 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden border border-zinc-200/50 dark:border-zinc-800/50">
                                <div 
                                    className="h-full bg-linear-to-r from-[#002FA7] to-[#002FA7]/80 rounded-full transition-all duration-300 shadow-sm"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <div className="flex justify-end">
                                <span className="w-9 text-right text-[11px] font-bold text-[#002FA7] dark:text-blue-400 font-mono tabular-nums">{progress}%</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Ready State */}
                {state === 'ready' && (
                    <div className="py-4 flex flex-col items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center border border-emerald-100 dark:border-emerald-900/30 animate-pulse">
                            <RefreshCw size={24} className="text-emerald-500 animate-spin" style={{ animationDuration: '4s' }} />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white tracking-tight">{t('settings.update_ready', '升级准备就绪')}</h3>
                            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{t('settings.update_ready_desc', '新版本已成功下载并安全校验，点击重启完成升级！')}</p>
                        </div>
                        <button 
                            onClick={handleRelaunch} 
                            className="w-full px-4 py-2.5 text-xs font-semibold rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white transition-colors shadow-md hover:shadow-lg font-bold min-h-[40px]"
                        >
                            {t('settings.relaunch_now', '重启并应用')}
                        </button>
                    </div>
                )}

            </div>
        </div>
    );
};
