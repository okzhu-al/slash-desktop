/**
 * AnnotationPanel — 段落级批注面板
 * Phase 3.2③: 显示/添加/回复/解决批注
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Trash2, RefreshCw, CornerDownRight, ChevronDown, ChevronRight } from 'lucide-react';
import { annotationService, AnnotationInfo } from '@/services/AnnotationService';
import { useSessionStore } from '@/stores/useSessionStore';
import { syncService } from '@/services/SyncService';

interface AnnotationPanelProps {
    notePath: string | null;
    /** 离线状态下禁用所有交互操作 */
    disabled?: boolean;
}

const PARA_MAP: Record<string, string> = {
    '01_Projects': '01_PROJECTS',
    '02_Areas': '02_AREAS',
    '03_Resources': '03_RESOURCE',
    '04_Archives': '04_ARCHIVE',
};

function timeAgo(isoStr: string): string {
    const now = Date.now();
    const then = new Date(isoStr).getTime();
    const diff = now - then;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min}分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}小时前`;
    const d = Math.floor(hr / 24);
    if (d < 30) return `${d}天前`;
    return `${Math.floor(d / 30)}个月前`;
}

function avatarColor(name: string): string {
    const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-purple-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-pink-500'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return colors[Math.abs(h) % colors.length];
}

/** 将批注按 parent_id 分组为线程 */
interface AnnotationThread {
    root: AnnotationInfo;
    replies: AnnotationInfo[];
}

function groupIntoThreads(annotations: AnnotationInfo[]): AnnotationThread[] {
    const roots: AnnotationInfo[] = [];
    const replyMap = new Map<string, AnnotationInfo[]>();

    for (const a of annotations) {
        if (!a.parent_id) {
            roots.push(a);
        } else {
            const list = replyMap.get(a.parent_id) || [];
            list.push(a);
            replyMap.set(a.parent_id, list);
        }
    }

    return roots.map(root => ({
        root,
        replies: replyMap.get(root.id) || [],
    }));
}

export const AnnotationPanel = ({ notePath, disabled = false }: AnnotationPanelProps) => {
    const { t } = useTranslation();
    const [annotations, setAnnotations] = useState<AnnotationInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [replyContent, setReplyContent] = useState('');
    const [sending, setSending] = useState(false);
    const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

    const currentUser = useSessionStore.getState().displayName || '';

    const resolveFilePath = useCallback((): { vaultId: string; filePath: string } | null => {
        if (!notePath) return null;
        const config = syncService.getConfig();
        if (!config) return null;

        const teamVaultId = useSessionStore.getState().teamVaultId;

        // 🛡️ team 笔记路径以 __team__/ 开头，直接剥离即得 server relative_path
        if (notePath.startsWith('__team__/')) {
            return {
                vaultId: teamVaultId || config.vaultId,
                filePath: notePath.slice('__team__/'.length),
            };
        }

        const vaultRoot = (window as any).__slashVaultPath || '';
        let filePath = notePath;
        if (vaultRoot && filePath.startsWith(vaultRoot + '/')) {
            filePath = filePath.slice(vaultRoot.length + 1);
        }
        if (!filePath.endsWith('.md')) filePath += '.md';

        const firstDir = filePath.split('/')[0];
        const teamDir = PARA_MAP[firstDir];
        const teamFilePath = teamDir ? teamDir + filePath.slice(firstDir.length) : filePath;

        return {
            vaultId: teamVaultId || config.vaultId,
            filePath: teamVaultId ? teamFilePath : filePath,
        };
    }, [notePath]);

    const loadAnnotations = useCallback(async () => {
        const resolved = resolveFilePath();
        if (!resolved) return;
        console.log('[Annotation] Loading:', resolved);
        setLoading(true);
        setError(null);
        try {
            const result = await annotationService.listAnnotations(resolved.vaultId, resolved.filePath);
            setAnnotations(result);
            // 通知编辑器重新施加高亮 mark（重启后恢复）
            window.dispatchEvent(new CustomEvent('annotation:marks:restore', { detail: { annotations: result } }));
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    }, [resolveFilePath]);

    useEffect(() => { loadAnnotations(); }, [loadAnnotations]);
    useEffect(() => { setAnnotations([]); setReplyingTo(null); }, [notePath]);

    // 监听来自 AIBubbleMenu 的刷新事件以及编辑器的内容重载
    useEffect(() => {
        const handleReload = () => { loadAnnotations(); };
        window.addEventListener('annotation:reload', handleReload);
        window.addEventListener('slash:editor-content-loaded', handleReload);
        return () => {
            window.removeEventListener('annotation:reload', handleReload);
            window.removeEventListener('slash:editor-content-loaded', handleReload);
        };
    }, [loadAnnotations]);

    const handleReply = async (parentId: string) => {
        if (!replyContent.trim() || sending) return;
        const resolved = resolveFilePath();
        if (!resolved) return;

        // 找到父批注的 anchor 信息
        const parent = annotations.find(a => a.id === parentId);
        if (!parent) return;

        setSending(true);
        try {
            await annotationService.createAnnotation(
                resolved.vaultId, resolved.filePath,
                parent.anchor_id, parent.anchor_preview || '', replyContent.trim(), parentId
            );
            setReplyContent('');
            setReplyingTo(null);
            await loadAnnotations();
        } catch (err) {
            console.error('Failed to reply:', err);
        } finally {
            setSending(false);
        }
    };


    const handleDelete = async (id: string) => {
        try {
            await annotationService.deleteAnnotation(id);
            setAnnotations(prev => prev.filter(a => a.id !== id && a.parent_id !== id));
        } catch (err) {
            console.error('Failed to delete:', err);
        }
    };

    const toggleThread = (id: string) => {
        setExpandedThreads(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const threads = groupIntoThreads(annotations);

    if (!notePath) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-sm">
                {t('annotations.no_note', '请先选择一篇笔记')}
            </div>
        );
    }

    const renderAnnotation = (ann: AnnotationInfo, isReply = false) => {
        const author = ann.author_name || '?';
        const isOwn = author === currentUser;

        return (
            <div key={ann.id} className={`${isReply ? 'ml-6 pl-3 border-l-2 border-zinc-200 dark:border-zinc-700' : ''}`}>
                <div className="group py-2">
                    <div className="flex items-start gap-2">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-medium shrink-0 ${avatarColor(author)}`}>
                            {author[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">{author}</span>
                                <span className="text-[10px] text-zinc-400">{timeAgo(ann.created_at)}</span>
                            </div>
                            {!isReply && ann.anchor_preview && (
                                <div
                                    className="mt-1 px-2 py-1 bg-amber-50 dark:bg-amber-900/10 border-l-2 border-amber-400 text-[10px] text-zinc-600 dark:text-zinc-400 italic truncate rounded-r cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors"
                                    title={t('annotations.click_to_focus', '点击定位到原文')}
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent('annotation:focus', {
                                            detail: { anchorPreview: ann.anchor_preview }
                                        }));
                                    }}
                                >
                                    "{ann.anchor_preview}"
                                </div>
                            )}
                            <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1 whitespace-pre-wrap leading-relaxed">
                                {ann.content}
                            </p>
                            {/* Actions — 离线时隐藏 */}
                            {!disabled && (
                            <div className="flex items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {!isReply && (
                                    <button
                                        onClick={() => setReplyingTo(replyingTo === ann.id ? null : ann.id)}
                                        className="text-[10px] text-zinc-400 hover:text-indigo-500 flex items-center gap-0.5"
                                    >
                                        <CornerDownRight size={10} /> {t('annotations.reply', '回复')}
                                    </button>
                                )}
                                {isOwn && (
                                    <button
                                        onClick={() => handleDelete(ann.id)}
                                        className="text-[10px] text-zinc-400 hover:text-red-500 flex items-center gap-0.5"
                                    >
                                        <Trash2 size={10} />
                                    </button>
                                )}
                            </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5">
                    <MessageCircle size={14} />
                    {t('annotations.panel_title', '批注')}
                    {annotations.filter(a => !a.parent_id).length > 0 && (
                        <span className="text-[10px] bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 rounded-full px-1.5 py-0.5">
                            {annotations.filter(a => !a.parent_id).length}
                        </span>
                    )}
                </h3>
                <button
                    onClick={loadAnnotations}
                    className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            {/* Annotations List */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
                {loading && annotations.length === 0 ? (
                    <div className="flex items-center justify-center py-12 text-zinc-400 text-sm">
                        {t('annotations.loading', '加载中...')}
                    </div>
                ) : error ? (
                    <div className="text-center text-sm text-red-500 py-8">{error}</div>
                ) : threads.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400 dark:text-zinc-500">
                        <MessageCircle size={32} strokeWidth={1} />
                        <span className="text-sm">{t('annotations.empty', '暂无批注')}</span>
                        <span className="text-xs text-center">{t('annotations.empty_hint', '选中文本后点击工具栏的批注按钮')}</span>
                    </div>
                ) : (
                    <div className="space-y-1">
                        {threads.map(thread => (
                            <div key={thread.root.id} className="border-b border-zinc-100 dark:border-zinc-800 pb-2 last:border-0">
                                {renderAnnotation(thread.root)}

                                {/* Replies */}
                                {thread.replies.length > 0 && (
                                    <div className="ml-3">
                                        <button
                                            onClick={() => toggleThread(thread.root.id)}
                                            className="text-[10px] text-zinc-400 hover:text-zinc-600 flex items-center gap-0.5 mb-1"
                                        >
                                            {expandedThreads.has(thread.root.id)
                                                ? <ChevronDown size={10} />
                                                : <ChevronRight size={10} />
                                            }
                                            {thread.replies.length} {t('annotations.replies_count', '条回复')}
                                        </button>
                                        {expandedThreads.has(thread.root.id) && (
                                            <div>{thread.replies.map(r => renderAnnotation(r, true))}</div>
                                        )}
                                    </div>
                                )}

                                {/* Reply input — 离线时隐藏 */}
                                {!disabled && replyingTo === thread.root.id && (
                                    <div className="ml-6 mt-1 flex items-end gap-1.5">
                                        <input
                                            value={replyContent}
                                            onChange={e => setReplyContent(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReply(thread.root.id); } }}
                                            placeholder={t('annotations.reply_placeholder', '回复...')}
                                            className="flex-1 text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 rounded px-2 py-1 text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                                            autoFocus
                                        />
                                        <button
                                            onClick={() => handleReply(thread.root.id)}
                                            disabled={!replyContent.trim() || sending}
                                            className="text-[10px] px-2 py-1 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-40"
                                        >
                                            {t('annotations.send', '发送')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Hint */}
            <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 text-center">
                <span className="text-[10px] text-zinc-400">
                    {t('annotations.hint', '选中文本后使用工具栏添加批注')}
                </span>
            </div>
        </div>
    );
};
