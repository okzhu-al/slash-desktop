/**
 * Phase 6: Transfer Panel — 传输管理面板
 *
 * 一个从编辑器底栏触发的浮动面板，展示当前的上传/下载队列。
 * 设计原则：轻量、不阻塞编辑、提供透明的传输状态反馈。
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    ArrowUpFromLine,
    ArrowDownToLine,
    RotateCcw,
    Trash2,
    Loader2,
    CheckCircle2,
    XCircle,
    Clock,
    HardDrive,
} from 'lucide-react';
import { TransferService, TransferTask } from '../../services/TransferService';

/** 格式化字节为人类可读 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** 状态图标 */
function StatusIcon({ status }: { status: string }) {
    switch (status) {
        case 'pending':
            return <Clock size={14} className="text-zinc-400" />;
        case 'active':
            return <Loader2 size={14} className="text-blue-400 animate-spin" />;
        case 'completed':
            return <CheckCircle2 size={14} className="text-emerald-400" />;
        case 'failed':
            return <XCircle size={14} className="text-red-400" />;
        case 'paused':
            return <Clock size={14} className="text-amber-400" />;
        default:
            return <Clock size={14} className="text-zinc-400" />;
    }
}

interface TransferPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export function TransferPanel({ isOpen, onClose }: TransferPanelProps) {
    const { t } = useTranslation();
    const [tasks, setTasks] = useState<TransferTask[]>([]);
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const queue = await TransferService.getQueue();
            setTasks(queue);
        } catch (e) {
            console.error('[TransferPanel] Failed to load queue:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    // 打开时加载 + 定时刷新
    useEffect(() => {
        if (!isOpen) return;
        refresh();
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
    }, [isOpen, refresh]);

    const handleRetry = async (id: number) => {
        await TransferService.retryTask(id);
        refresh();
    };

    const handleClearCompleted = async () => {
        await TransferService.clearCompleted();
        refresh();
    };

    if (!isOpen) return null;

    const uploads = tasks.filter(t => t.direction === 'upload');
    const downloads = tasks.filter(t => t.direction === 'download');
    const hasCompleted = tasks.some(t => t.status === 'completed');

    return (
        <div
            className="transfer-panel"
            style={{
                position: 'fixed',
                bottom: '36px',
                right: '12px',
                width: '360px',
                maxHeight: '420px',
                zIndex: 999,
                borderRadius: '12px',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--transfer-panel-bg, rgba(24, 24, 27, 0.95))',
                backdropFilter: 'blur(16px)',
                border: '1px solid var(--transfer-panel-border, rgba(63, 63, 70, 0.6))',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255,255,255,0.05) inset',
            }}
        >
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderBottom: '1px solid rgba(63, 63, 70, 0.4)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <HardDrive size={16} className="text-blue-400" />
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--transfer-text, #e4e4e7)' }}>
                        {t('transfer.title', '资产传输')}
                    </span>
                    {tasks.length > 0 && (
                        <span style={{
                            fontSize: '11px',
                            padding: '1px 6px',
                            borderRadius: '8px',
                            background: 'rgba(59, 130, 246, 0.2)',
                            color: '#93c5fd',
                        }}>
                            {tasks.length}
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {hasCompleted && (
                        <button
                            onClick={handleClearCompleted}
                            title={t('transfer.clear_completed', '清除已完成')}
                            style={{
                                padding: '4px',
                                borderRadius: '4px',
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                color: '#a1a1aa',
                            }}
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        style={{
                            padding: '4px 8px',
                            borderRadius: '4px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#a1a1aa',
                            fontSize: '12px',
                        }}
                    >
                        ✕
                    </button>
                </div>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
                {loading && tasks.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#71717a' }}>
                        <Loader2 size={20} className="animate-spin" style={{ margin: '0 auto 8px' }} />
                        <div style={{ fontSize: '12px' }}>{t('common.loading', '加载中...')}</div>
                    </div>
                ) : tasks.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '32px 16px', color: '#52525b' }}>
                        <HardDrive size={28} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                        <div style={{ fontSize: '12px' }}>{t('transfer.empty', '暂无传输任务')}</div>
                    </div>
                ) : (
                    <>
                        {/* 上传区 */}
                        {uploads.length > 0 && (
                            <TaskSection
                                title={t('transfer.uploads', '上传')}
                                icon={<ArrowUpFromLine size={12} />}
                                tasks={uploads}
                                onRetry={handleRetry}
                            />
                        )}
                        {/* 下载区 */}
                        {downloads.length > 0 && (
                            <TaskSection
                                title={t('transfer.downloads', '下载')}
                                icon={<ArrowDownToLine size={12} />}
                                tasks={downloads}
                                onRetry={handleRetry}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/** 任务分区 */
function TaskSection({
    title,
    icon,
    tasks,
    onRetry,
}: {
    title: string;
    icon: React.ReactNode;
    tasks: TransferTask[];
    onRetry: (id: number) => void;
}) {
    return (
        <div style={{ marginBottom: '4px' }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 16px',
                fontSize: '11px',
                fontWeight: 600,
                color: '#71717a',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
            }}>
                {icon}
                {title}
                <span style={{ fontWeight: 400 }}>({tasks.length})</span>
            </div>
            {tasks.map(task => (
                <TaskRow key={task.id} task={task} onRetry={onRetry} />
            ))}
        </div>
    );
}

/** 单个任务行 */
function TaskRow({
    task,
    onRetry,
}: {
    task: TransferTask;
    onRetry: (id: number) => void;
}) {
    const { t } = useTranslation();
    const progress = task.total_bytes > 0
        ? Math.round((task.transferred_bytes / task.total_bytes) * 100)
        : 0;

    const filename = task.asset_path.split('/').pop() || task.asset_path;

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '6px 16px',
            transition: 'background 0.15s',
            cursor: 'default',
        }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(63, 63, 70, 0.3)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
            <StatusIcon status={task.status} />

            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                    fontSize: '12px',
                    color: '#d4d4d8',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}>
                    {filename}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                    <span style={{ fontSize: '10px', color: '#71717a' }}>
                        {formatBytes(task.transferred_bytes)} / {formatBytes(task.total_bytes)}
                    </span>
                    {task.status === 'active' && (
                        <div style={{
                            flex: 1,
                            height: '3px',
                            borderRadius: '2px',
                            background: 'rgba(63, 63, 70, 0.5)',
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                width: `${progress}%`,
                                height: '100%',
                                borderRadius: '2px',
                                background: 'linear-gradient(90deg, #3b82f6, #6366f1)',
                                transition: 'width 0.3s ease',
                            }} />
                        </div>
                    )}
                    {task.status === 'failed' && task.error_message && (
                        <span style={{ fontSize: '10px', color: '#ef4444' }} title={task.error_message}>
                            {t('transfer.failed', '失败')}
                        </span>
                    )}
                </div>
            </div>

            {/* 操作按钮 */}
            {task.status === 'failed' && task.retry_count < task.max_retries && (
                <button
                    onClick={() => onRetry(task.id)}
                    title={t('transfer.retry', '重试')}
                    style={{
                        padding: '4px',
                        borderRadius: '4px',
                        background: 'rgba(59, 130, 246, 0.15)',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#60a5fa',
                        flexShrink: 0,
                    }}
                >
                    <RotateCcw size={12} />
                </button>
            )}
        </div>
    );
}

/**
 * TransferIndicator — 编辑器底栏的传输状态指示器
 *
 * 显示当前活跃传输数量，点击展开 TransferPanel
 */
export function TransferIndicator() {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [activeCount, setActiveCount] = useState(0);

    useEffect(() => {
        let active = true;
        const check = async () => {
            try {
                const tasks = await TransferService.getQueue();
                if (active) {
                    setActiveCount(tasks.filter(t => t.status !== 'completed').length);
                }
            } catch {
                // 静默
            }
        };
        check();
        const timer = setInterval(check, 5000);
        return () => { active = false; clearInterval(timer); };
    }, []);

    if (activeCount === 0 && !isOpen) return null;

    return (
        <>
            <button
                onClick={() => setIsOpen(!isOpen)}
                title={t('transfer.title', '资产传输')}
                className="transfer-indicator"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: isOpen ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: activeCount > 0 ? '#60a5fa' : '#71717a',
                    fontSize: '11px',
                    transition: 'all 0.2s',
                }}
            >
                <HardDrive size={13} />
                {activeCount > 0 && <span>{activeCount}</span>}
            </button>
            <TransferPanel isOpen={isOpen} onClose={() => setIsOpen(false)} />
        </>
    );
}
