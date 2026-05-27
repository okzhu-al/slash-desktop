import { Component, ErrorInfo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { Download, IterationCcw, AlertOctagon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

class GlobalErrorBoundaryInner extends Component<Props & { t: any }, State> {
    public state: State = {
        hasError: false,
        error: null,
        errorInfo: null
    };

    public static getDerivedStateFromError(error: Error): State {
        // Update state so the next render will show the fallback UI.
        return { hasError: true, error, errorInfo: null };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
        this.setState({ errorInfo });
    }

    private handleExportDiagnostics = async () => {
        const { t } = this.props;
        try {
            const defaultPath = `slash_crash_diagnostics_${new Date().toISOString().split('T')[0]}.zip`;
            const savePath = await save({
                defaultPath,
                filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
            });

            if (!savePath) return;

            const result = await invoke<{ success: boolean; path: string | null; error: string | null }>('export_diagnostics', { targetPath: savePath });

            if (result.success) {
                alert(t('settings.export_diagnostics_success', { path: result.path }) || `导出成功: ${result.path}`);
            } else {
                alert(t('settings.export_diagnostics_error', { error: result.error }) || `导出失败: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to export diagnostics:', error);
            alert(typeof error === 'string' ? error : (error as Error).message || 'Unknown error');
        }
    };

    private handleReload = () => {
        window.location.reload();
    };

    public render() {
        if (this.state.hasError) {
            const { t } = this.props;
            return (
                <div className="fixed inset-0 z-9999 flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-8">
                    <div className="max-w-xl w-full bg-white dark:bg-zinc-900 overflow-hidden shadow-2xl rounded-2xl border border-red-200 dark:border-red-900/50">
                        <div className="p-6 md:p-8 flex flex-col items-center text-center border-b border-zinc-100 dark:border-zinc-800">
                            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-6">
                                <AlertOctagon size={32} className="text-red-600 dark:text-red-500" />
                            </div>
                            <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                                {t('error.crash_title') || 'Application Crashed'}
                            </h2>
                            <p className="text-zinc-500 dark:text-zinc-400">
                                {t('error.crash_desc') || 'The application encountered an unexpected error. Please export the diagnostic report and reload the app.'}
                            </p>
                        </div>
                        
                        <div className="p-6 md:p-8 bg-zinc-50 dark:bg-zinc-950/50 space-y-4">
                            <div className="p-4 bg-zinc-100 dark:bg-zinc-800/80 rounded-lg overflow-x-auto text-left">
                                <p className="font-mono text-sm text-red-600 dark:text-red-400 font-semibold mb-2">
                                    {this.state.error?.toString()}
                                </p>
                                <pre className="font-mono text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
                                    {this.state.errorInfo?.componentStack || this.state.error?.stack}
                                </pre>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-3 pt-4">
                                <button
                                    onClick={this.handleExportDiagnostics}
                                    className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white transition-colors"
                                >
                                    <Download size={18} />
                                    {t("settings.export_diagnostics_button") || "Export Diagnostics"}
                                </button>
                                <button
                                    onClick={this.handleReload}
                                    className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
                                >
                                    <IterationCcw size={18} />
                                    {t("error.reload_app") || "Reload App"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

// Wrapper to provide translation hook into class component
export const GlobalErrorBoundary = (props: Props) => {
    const { t } = useTranslation();
    return <GlobalErrorBoundaryInner {...props} t={t} />;
};
