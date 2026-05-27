/**
 * CommentPanel — 文档评论面板
 * Phase 3.2②: 显示/发表/删除文档级评论
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, Trash2, RefreshCw } from 'lucide-react';
import { commentService, CommentInfo } from '@/services/CommentService';
import { useSessionStore } from '@/stores/useSessionStore';
import { syncService } from '@/services/SyncService';

interface CommentPanelProps {
    notePath: string | null;
}

/** PARA 映射 */
const PARA_MAP: Record<string, string> = {
    '01_Projects': '01_PROJECTS',
    '02_Areas': '02_AREAS',
    '03_Resources': '03_RESOURCE',
    '04_Archives': '04_ARCHIVE',
};

/** 相对时间 */
function timeAgo(isoStr: string): string {
    const now = Date.now();
    const then = new Date(isoStr).getTime();
    const diffMs = now - then;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return `${Math.floor(days / 30)}个月前`;
}

/** 首字母头像颜色 */
function avatarColor(name: string): string {
    const colors = [
        'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500',
        'bg-purple-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-pink-500',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
}

export const CommentPanel = ({ notePath }: CommentPanelProps) => {
    const { t } = useTranslation();
    const [comments, setComments] = useState<CommentInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [newComment, setNewComment] = useState('');
    const [sending, setSending] = useState(false);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const listEndRef = useRef<HTMLDivElement>(null);

    const currentUser = useSessionStore.getState().displayName || '';

    /** 解析文件路径 → 团队 vault 路径 */
    const resolveFilePath = useCallback((): { vaultId: string; filePath: string } | null => {
        if (!notePath) return null;
        const config = syncService.getConfig();
        if (!config) return null;

        const vaultRoot = (window as any).__slashVaultPath || '';
        let filePath = notePath;
        if (vaultRoot && filePath.startsWith(vaultRoot + '/')) {
            filePath = filePath.slice(vaultRoot.length + 1);
        }
        if (!filePath.endsWith('.md')) filePath += '.md';

        const firstDir = filePath.split('/')[0];
        const teamDir = PARA_MAP[firstDir];
        const teamFilePath = teamDir ? teamDir + filePath.slice(firstDir.length) : filePath;

        const teamVaultId = useSessionStore.getState().teamVaultId;
        return {
            vaultId: teamVaultId || config.vaultId,
            filePath: teamVaultId ? teamFilePath : filePath,
        };
    }, [notePath]);

    const loadComments = useCallback(async () => {
        const resolved = resolveFilePath();
        if (!resolved) return;

        setLoading(true);
        setError(null);
        try {
            const result = await commentService.listComments(resolved.vaultId, resolved.filePath);
            setComments(result);
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    }, [resolveFilePath]);

    useEffect(() => { loadComments(); }, [loadComments]);
    useEffect(() => { setComments([]); setNewComment(''); }, [notePath]);

    // 自动滚动到底部
    useEffect(() => {
        listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [comments.length]);

    const handleSend = async () => {
        if (!newComment.trim() || sending) return;
        const resolved = resolveFilePath();
        if (!resolved) return;

        setSending(true);
        try {
            await commentService.createComment(resolved.vaultId, resolved.filePath, newComment.trim());
            setNewComment('');
            await loadComments();
        } catch (err) {
            console.error('Failed to send comment:', err);
        } finally {
            setSending(false);
        }
    };

    const handleDelete = async (commentId: string) => {
        try {
            await commentService.deleteComment(commentId);
            setComments(prev => prev.filter(c => c.id !== commentId));
        } catch (err) {
            console.error('Failed to delete comment:', err);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!notePath) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-sm">
                {t('comments.no_note', '请先选择一篇笔记')}
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5">
                    <MessageSquare size={14} />
                    {t('comments.panel_title', '评论')}
                    {comments.length > 0 && (
                        <span className="text-[10px] bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 rounded-full px-1.5 py-0.5">
                            {comments.length}
                        </span>
                    )}
                </h3>
                <button
                    onClick={loadComments}
                    className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            {/* Comments List */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
                {loading && comments.length === 0 ? (
                    <div className="flex items-center justify-center py-12 text-zinc-400 text-sm">
                        {t('comments.loading', '加载中...')}
                    </div>
                ) : error ? (
                    <div className="text-center text-sm text-red-500 py-8">{error}</div>
                ) : comments.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400 dark:text-zinc-500">
                        <MessageSquare size={32} strokeWidth={1} />
                        <span className="text-sm">{t('comments.empty', '暂无评论')}</span>
                        <span className="text-xs">{t('comments.empty_hint', '发表第一条评论吧')}</span>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {comments.map((comment) => {
                            const authorName = comment.author_name || '?';
                            const isOwn = authorName === currentUser;
                            return (
                                <div
                                    key={comment.id}
                                    className="group relative"
                                    onMouseEnter={() => setHoveredId(comment.id)}
                                    onMouseLeave={() => setHoveredId(null)}
                                >
                                    <div className="flex items-start gap-2">
                                        {/* Avatar */}
                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-medium shrink-0 ${avatarColor(authorName)}`}>
                                            {authorName[0].toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                                    {authorName}
                                                </span>
                                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                                    {timeAgo(comment.created_at)}
                                                </span>
                                            </div>
                                            <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-0.5 whitespace-pre-wrap break-all leading-relaxed">
                                                {comment.content}
                                            </p>
                                        </div>
                                        {/* Delete button */}
                                        {isOwn && hoveredId === comment.id && (
                                            <button
                                                onClick={() => handleDelete(comment.id)}
                                                className="absolute top-0 right-0 p-1 text-zinc-400 hover:text-red-500 transition-colors"
                                                title={t('comments.delete', '删除')}
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={listEndRef} />
                    </div>
                )}
            </div>

            {/* Input Area */}
            <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-700">
                <div className="flex items-end gap-2">
                    <textarea
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('comments.input_placeholder', '写一条评论...')}
                        className="flex-1 text-xs resize-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2 text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 min-h-[36px] max-h-[100px]"
                        rows={1}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!newComment.trim() || sending}
                        className="p-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Send size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
};
