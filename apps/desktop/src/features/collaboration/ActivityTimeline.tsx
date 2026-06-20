/**
 * ActivityTimeline — 协作历史统一时间轴 v2
 * 按日期智能分组，左侧时间列，统一图标，清晰信息层级
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
    History, RefreshCw, X, Send, Trash2, CornerDownRight,
    FilePlus, FileEdit, MessageCircle, MessageSquare, ChevronDown, ChevronRight, GitCommit, Save, CheckCheck,
} from 'lucide-react';
import { keepSnapshotsVisibleFromLocalState, snapshotService, SnapshotInfo, SnapshotContent } from '@/services/SnapshotService';
import { annotationService, AnnotationInfo } from '@/services/AnnotationService';
import { commentService, CommentInfo } from '@/services/CommentService';
import { syncService } from '@/services/SyncService';
import { collabService, CollabEvent, StatusEventInfo } from '@/services/CollabService';
import { useCollabNotifyStore } from '@/stores/useCollabNotifyStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { SnapshotReadonlyEditor } from './SnapshotReadonlyEditor';
import { message } from '@tauri-apps/plugin-dialog';
import type { DocStatus } from '@/features/editor/components/DocStatusBar';
import { normalizePath, getBasename } from '@/shared/utils/pathUtils';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

type RawEvent =
    | { kind: 'version';    ts: number; data: SnapshotInfo }
    | { kind: 'annotation'; ts: number; data: AnnotationInfo }
    | { kind: 'comment';    ts: number; data: CommentInfo }
    | { kind: 'status';     ts: number; data: StatusEventInfo }
    | { kind: 'system';     ts: number; data: CollabEvent };

// 组内节点：单条事件 or 折叠的多次修改
type DayItem =
    | { type: 'event'; event: RawEvent }
    | { type: 'group'; events: RawEvent[]; label: string };

type DayGroup = {
    dateLabel: string;
    items: DayItem[];
};

// ─────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────

const PARA_MAP: Record<string, string> = {
    '01_Projects': '01_PROJECTS', '02_Areas': '02_AREAS',
    '03_Resources': '03_RESOURCE', '04_Archives': '04_ARCHIVE',
};

function resolveTeamPath(notePath: string): { vaultId: string; filePath: string; fileId: string | null } | null {
    const config = syncService.getConfig();
    if (!config) return null;
    const teamVaultId = useSessionStore.getState().teamVaultId;
    if (notePath.startsWith('__team__/')) {
        const parsed = parseTeamNoteId(notePath);
        return {
            vaultId: parsed.teamVaultId || teamVaultId || config.vaultId,
            filePath: parsed.filePath || '',
            fileId: parsed.fileId,
        };
    }
    const vaultRoot = (window as any).__slashVaultPath || '';
    let fp = normalizePath(notePath);
    if (vaultRoot && fp.startsWith(normalizePath(vaultRoot) + '/')) fp = fp.slice(vaultRoot.length + 1);
    if (!fp.endsWith('.md')) fp += '.md';
    const firstDir = fp.split('/')[0];
    const teamDir = PARA_MAP[firstDir];
    const teamFp = teamDir ? teamDir + fp.slice(firstDir.length) : fp;
    return { vaultId: teamVaultId || config.vaultId, filePath: teamVaultId ? teamFp : fp, fileId: null };
}

function extractSlashId(raw: string): string | null {
    const match = raw.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
    const frontmatter = match?.[1] ?? '';
    return frontmatter.match(/^slash_id:\s*['"]?([0-9a-fA-F-]{36})['"]?\s*$/m)?.[1] ?? null;
}

async function resolveNoteFileId(
    notePath: string | null,
    resolved: { vaultId: string; filePath: string; fileId: string | null } | null,
): Promise<string | null> {
    if (!notePath) return null;
    try {
        if (notePath.startsWith('__team__/')) {
            if (!resolved) return null;
            const parsed = parseTeamNoteId(notePath);
            if (parsed.fileId) return parsed.fileId;
            return extractSlashId(await syncService.getVaultFile(resolved.vaultId, resolved.filePath));
        }

        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return extractSlashId(await readTextFile(notePath));
    } catch {
        return null;
    }
}

function hhmm(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function stripFrontmatter(raw: string): string {
    const t = raw.trimStart();
    if (!t.startsWith('---')) return raw;
    const end = t.indexOf('\n---', 3);
    return end === -1 ? raw : t.slice(end + 4).trimStart();
}

/** 智能日期 header：根据事件在时间轴中的跨度决定粒度 */
function smartDateLabel(ts: number, allTs: number[], t: any): string {
    const d = new Date(ts);
    const now = new Date();
    const todayStr = now.toDateString();
    const yestStr = new Date(now.getTime() - 86400000).toDateString();
    if (d.toDateString() === todayStr) return t('activity.today', '今天');
    if (d.toDateString() === yestStr) return t('activity.yesterday', '昨天');

    // 判断跨年范围
    const minYear = Math.min(...allTs.map(t => new Date(t).getFullYear()));
    const maxYear = Math.max(...allTs.map(t => new Date(t).getFullYear()));
    const showYear = minYear !== maxYear || d.getFullYear() !== now.getFullYear();

    const mo = d.getMonth() + 1;
    const day = d.getDate();
    return showYear
        ? t('activity.date_with_year', '{{year}} 年 {{month}} 月 {{day}} 日', { year: d.getFullYear(), month: mo, day })
        : t('activity.date_no_year', '{{month}} 月 {{day}} 日', { month: mo, day });
}

// ─────────────────────────────────────────
// Build day-grouped timeline
// ─────────────────────────────────────────

const H1 = 60 * 60 * 1000;

function isAnchor(e: RawEvent): boolean {
    return e.kind !== 'version' || e.data.snapshot_type === 'create' || e.data.snapshot_type === 'rename';
}

function buildDayGroups(events: RawEvent[], t: any): DayGroup[] {
    if (events.length === 0) return [];

    const sorted = [...events].sort((a, b) => b.ts - a.ts);
    const allTs = sorted.map(e => e.ts);

    // 按天分组
    const dayMap = new Map<string, RawEvent[]>();
    for (const ev of sorted) {
        const d = new Date(ev.ts);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!dayMap.has(key)) dayMap.set(key, []);
        dayMap.get(key)!.push(ev);
    }

    const groups: DayGroup[] = [];
    for (const [, dayEvents] of dayMap) {
        const items: DayItem[] = [];
        let run: RawEvent[] = [];

        const flush = () => {
            if (run.length === 0) return;
            if (run.length === 1) {
                items.push({ type: 'event', event: run[0] });
            } else {
                items.push({ type: 'group', events: run, label: t('activity.multiple_edits', '{{count}} 次修改', { count: run.length }) });
            }
            run = [];
        };

        for (const ev of dayEvents) {
            if (isAnchor(ev)) {
                flush();
                items.push({ type: 'event', event: ev });
            } else {
                // 连续 sync 事件：若与 run 头部间隔 < 1h 则合并
                if (run.length > 0 && (run[0].ts - ev.ts) < H1) {
                    run.push(ev);
                } else {
                    flush();
                    run = [ev];
                }
            }
        }
        flush();

        groups.push({
            dateLabel: smartDateLabel(dayEvents[0].ts, allTs, t),
            items,
        });
    }
    return groups;
}

// ─────────────────────────────────────────
// Snapshot Preview Modal
// ─────────────────────────────────────────

function SnapshotPreviewModal({ snap, onClose, t, vaultPath, isLatestSnapshot }: {
    snap: SnapshotInfo; onClose: () => void; t: any;
    isLatestSnapshot: boolean;
    vaultPath?: string | null;
}) {
    const [content, setContent] = useState<SnapshotContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [stale, setStale] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        snapshotService.getSnapshotContent(snap.id)
            .then((value) => {
                if (value.content_hash !== snap.content_hash) {
                    setStale(true);
                    setContent(null);
                    return;
                }
                setContent(value);
            }).catch(() => {}).finally(() => setLoading(false));
    }, [snap.id, snap.content_hash]);

    const noteName = getBasename(snap.file_path)?.replace(/\.md$/, '') ?? snap.file_path;
    const typeStr = snap.snapshot_type === 'create' ? t('activity.type_create', '创建') : t('activity.type_edit', '修改');

    const showSaveAs = !isLatestSnapshot;

    const handleSaveAs = async () => {
        if (!content?.content || !vaultPath) return;
        setSaving(true);
        try {
            const { writeTextFile, exists, mkdir } = await import('@tauri-apps/plugin-fs');
            const inboxPath = `${vaultPath}/00_Inbox`;
            // 确保 Inbox 存在
            if (!await exists(inboxPath)) await mkdir(inboxPath, { recursive: true });
            // 生成不冲突的文件名
            const baseName = `${noteName}_副本`;
            let fileName = `${baseName}.md`;
            let filePath = `${inboxPath}/${fileName}`;
            let counter = 1;
            while (await exists(filePath)) {
                counter++;
                fileName = `${baseName}${counter}.md`;
                filePath = `${inboxPath}/${fileName}`;
            }
            // 🛡️ 关键：给副本生成全新的 slash_id，防止与原文件共享 UUID
            // 共享 UUID 会导致服务端 rename 检测误判 → 无限 push 循环
            let finalContent = content.content;
            const newUuid = crypto.randomUUID();
            finalContent = finalContent.replace(
                /^(slash_id:\s*).+$/m,
                `$1${newUuid}`
            );
            await writeTextFile(filePath, finalContent);
            await message(
                t('versions.save_as_success', '已保存副本到 Inbox：{{name}}', { name: fileName }),
                { title: 'Slash', kind: 'info' }
            );
            onClose();
        } catch (e) {
            await message(String(e), { title: 'Slash', kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div 
            onClick={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
        >
            <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl overflow-hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-2xl">
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                    <div>
                        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{noteName}</p>
                        <p className="text-xs text-zinc-400 mt-0.5">{snap.author_name ?? '?'} {typeStr} {t('activity.time_at', '于')} {hhmm(new Date(snap.created_at).getTime())}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {showSaveAs && (
                            <button
                                onClick={handleSaveAs}
                                disabled={saving || loading || !content}
                                className="px-3 py-1 text-xs font-medium rounded-md border border-indigo-200 dark:border-blue-500/35 text-indigo-600 dark:text-blue-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                                <Save size={12} />
                                {saving ? t('versions.saving_btn', '保存中...') : t('versions.save_as_btn', '另存为副本')}
                            </button>
                        )}
                        {isLatestSnapshot && (
                            <button
                                disabled
                                className="px-3 py-1 text-xs font-medium rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 cursor-not-allowed"
                            >
                                {t('versions.current_badge', '当前版本')}
                            </button>
                        )}
                        <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
                        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400">
                            <X size={14} />
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-auto px-6 py-4 bg-white dark:bg-zinc-900 rounded-b-xl">
                    {loading ? (
                        <div className="h-40 flex items-center justify-center text-zinc-400 text-sm">{t('activity.loading', '加载中...')}</div>
                    ) : stale ? (
                        <div className="h-40 flex items-center justify-center text-zinc-400 text-sm">{t('activity.waiting_for_sync', '等待同步完成后查看')}</div>
                    ) : content?.content ? (
                        <SnapshotReadonlyEditor markdown={stripFrontmatter(content.content)} />
                    ) : (
                        <p className="text-zinc-400 text-sm">{t('activity.empty_content', '（空内容）')}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────
// Event Row
// ─────────────────────────────────────────

interface EventRowProps {
    t: any;
    event: RawEvent;
    currentUser: string;
    noteName: string;
    onPreviewVersion: (s: SnapshotInfo) => void;
    onDeleteComment: (id: string) => void;
    onDeleteAnnotation: (id: string) => void;
    replyingTo: string | null;
    onReply: (id: string) => void;
    onCancelReply: () => void;
    onSendReply: (parentId: string, parentType: string, text: string) => Promise<void>;
    allGlobalReplies: CommentInfo[];
    isNew?: boolean;
    onClickItem?: (tsList: number[]) => void;
    activeUnreadTsSet: Set<number>;
    clickedTs: Set<number>;
}


function FlatReplyNode({
    t,
    reply,
    parentReply,
    currentUser,
    replyingTo,
    onReply,
    onCancelReply,
    onSendReply,
    onDeleteReply,
    onClickItem,
    activeUnreadTsSet,
    clickedTs
}: {
    reply: CommentInfo;
    parentReply: CommentInfo | null;
    currentUser: string;
    replyingTo: string | null;
    onReply: (id: string) => void;
    onCancelReply: () => void;
    onSendReply: (pid: string, pType: string, text: string) => Promise<void>;
    onDeleteReply: (id: string) => void;
    onClickItem?: (ts: number[]) => void;
    t: any;
    activeUnreadTsSet: Set<number>;
    clickedTs: Set<number>;
}) {
    const rTs = new Date(reply.created_at).getTime();
    const isNew = activeUnreadTsSet.has(rTs) && !clickedTs.has(rTs);

    return (
        <div 
            className="group/reply mt-1.5 pt-1 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60 rounded px-1 -ml-1 transition-colors"
            onClick={(e) => {
                e.stopPropagation();
                onClickItem?.([rTs]);
            }}
        >
            <div className="flex items-start gap-2">
                <span className="text-[10px] text-zinc-400 tabular-nums w-9 shrink-0 text-right pt-[2px] leading-snug">{hhmm(rTs)}</span>
                
                {/* 极简的辅助线或标志，由于扁平化，只需一个统一的拐口 */}
                <CornerDownRight size={11} className="text-zinc-300 dark:text-zinc-600 shrink-0 mt-[3px]" />
                
                <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-700 dark:text-zinc-200 leading-snug wrap-break-word whitespace-pre-wrap flex flex-wrap items-center gap-x-1 gap-y-0.5">
                        <span className="font-medium text-zinc-800 dark:text-zinc-100">{reply.author_name || '?'}</span>
                        
                        {/* 如果回复的不是主楼，而是某个具体人的回复，就 @ 出来 */}
                        {parentReply && (
                            <span className="text-[10px] text-indigo-500 dark:text-blue-400 bg-indigo-50 dark:bg-indigo-900/30 px-1 py-px rounded-sm flex items-center h-4">
                                @{parentReply.author_name || '?'}
                            </span>
                        )}
                        
                        <span className="text-zinc-600 dark:text-zinc-300 ml-1">{reply.content}</span>
                        
                        {isNew && (
                            <span className="text-[9px] font-semibold px-1 rounded-sm bg-red-500 text-white shrink-0 shadow-sm ml-1 h-[14px] flex items-center">
                                NEW
                            </span>
                        )}
                    </p>
                    
                    {/* Reply Action */}
                    <div className="flex items-center gap-2 mt-0.5 opacity-0 group-hover/reply:opacity-100 transition-opacity">
                        {currentUser !== reply.author_name && (
                            <button onClick={e => { e.stopPropagation(); onReply(reply.id); }}
                                className="text-[10px] text-zinc-400 hover:text-indigo-500 dark:hover:text-blue-300 flex items-center gap-0.5">
                                <CornerDownRight size={9} /> {t('activity.reply', '回复')}
                            </button>
                        )}
                        {currentUser === reply.author_name && (
                            <button onClick={e => { e.stopPropagation(); onDeleteReply(reply.id); }}
                                className="text-[10px] text-zinc-400 hover:text-red-500 flex items-center gap-0.5 cursor-pointer">
                                <Trash2 size={9} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Nested Reply Input */}
            {replyingTo === reply.id && (
                <div className="ml-12 flex items-center gap-1.5 py-1.5 mt-1">
                    <input
                        autoFocus
                        placeholder={t('activity.reply_to', '回复 @{{name}}...', { name: reply.author_name || '?' })}
                        onMouseDown={e => e.stopPropagation()}
                        onKeyDown={async e => {
                            if (e.key === 'Enter') {
                                const v = (e.currentTarget as HTMLInputElement).value.trim();
                                if (v) await onSendReply(reply.id, 'comment', v);
                            }
                            if (e.key === 'Escape') onCancelReply();
                        }}
                        className="flex-1 text-[11px] border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 rounded px-2 py-1.5 text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 dark:focus:ring-blue-400/30"
                    />
                    <button onClick={onCancelReply} className="text-[10px] text-zinc-400 hover:text-zinc-600 px-1.5">{t('activity.cancel', '取消')}</button>
                </div>
            )}
        </div>
    );
}

function EventRow({ t, event, currentUser, noteName, onPreviewVersion,
    onDeleteComment, onDeleteAnnotation,
    replyingTo, onReply, onCancelReply, onSendReply, allGlobalReplies,
    isNew = false, onClickItem, activeUnreadTsSet, clickedTs, readOnly = false,
}: EventRowProps & { readOnly?: boolean }) {

    const isOwn = event.data.author_name === currentUser;
    const author = event.data.author_name || '?';

    // Icon + color
    let Icon = FileEdit;
    let iconCls = 'text-zinc-400';
    let actionText = '';
    let contentPreview: string | null = null;
    let isClickable = true;

    if (event.kind === 'version') {
        const snapName = event.data.file_path
            ? (getBasename(event.data.file_path)?.replace(/\.md$/, '') ?? noteName)
            : noteName;

        if (event.data.snapshot_type === 'create') {
            Icon = FilePlus;
            iconCls = 'text-emerald-500';
            actionText = t('activity.action_create', '{{author}} 创建了 {{note}}', { author, note: snapName });
        } else if (event.data.snapshot_type === 'rename') {
            Icon = FileEdit;
            iconCls = 'text-violet-500';
            const match = (event.data as any).change_summary?.match(/^Renamed:\s*(.+?)\s*->\s*(.+)$/);
            if (match) {
                const oldName = getBasename(match[1]) || match[1];
                const newName = getBasename(match[2]) || match[2];
                actionText = t('activity.action_rename_detail', '{{author}} 将 {{oldName}} 重命名为 {{newName}}', { author, oldName, newName });
            } else {
                actionText = t('activity.action_rename', '{{author}} 重命名了 {{note}}', { author, note: snapName });
            }
        } else {
            Icon = FileEdit;
            iconCls = 'text-zinc-400 dark:text-zinc-500';
            actionText = t('activity.action_edit', '{{author}} 修改了 {{note}}', { author, note: snapName });
        }
    } else if (event.kind === 'annotation') {
        Icon = MessageCircle;
        iconCls = 'text-amber-500';
        const anchor = event.data.anchor_preview ?? '';
        const anchorShort = anchor.length > 16 ? anchor.slice(0, 16) + '…' : anchor;
        actionText = anchor ? t('activity.action_annotate_anchor', '{{author}} 对 "{{anchor}}" 批注了', { author, anchor: anchorShort }) : t('activity.action_annotate', '{{author}} 批注了', { author });
        const body = event.data.content ?? '';
        contentPreview = body.length > 60 ? body.slice(0, 60) + '…' : body;
        isClickable = !!anchor;
    } else if (event.kind === 'comment') {
        Icon = MessageSquare;
        iconCls = 'text-sky-500';
        actionText = t('activity.action_comment', '{{author}} 发布评论', { author });
        contentPreview = event.data.content;
    } else if (event.kind === 'status') {
        Icon = RefreshCw;
        iconCls = 'text-purple-500';
        actionText = event.data.new_status === 'collab' ? t('activity.action_status_collab', '{{author}} 将笔记切换为协作模式', { author }) : t('activity.action_status_single', '{{author}} 将笔记切换为单人模式', { author });
    } else if (event.kind === 'system') {
        const systemName = getBasename(event.data.file_path)?.replace(/\.md$/, '') ?? noteName;
        if (event.data.kind === 'file_restored') {
            Icon = RefreshCw;
            iconCls = 'text-emerald-500';
            actionText = t('activity.action_file_restored', '{{author}} 恢复了 {{note}}', { author, note: systemName });
        } else {
            Icon = Trash2;
            iconCls = 'text-red-500';
            actionText = t('activity.action_file_deleted', '{{author}} 删除了 {{note}}', { author, note: systemName });
        }
        isClickable = false;
    }

    const eventId = (event.data as any).id;

    const flatReplies = useMemo(() => {
        const results: { reply: CommentInfo; parentReply: CommentInfo | null }[] = [];
        const replyMap = new Map(allGlobalReplies.map(r => [r.id, r]));

        const traverse = (parentId: string) => {
            const children = allGlobalReplies.filter((r: CommentInfo) => r.parent_id === parentId);
            // 本地排序保证同级时序
            children.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            for (const child of children) {
                const parentReply = parentId === eventId ? null : (replyMap.get(parentId) || null);
                results.push({ reply: child, parentReply });
                traverse(child.id);
            }
        };
        traverse(eventId as string);
        
        // 最终按照全局时间线强制拍平（无视从属深度）
        results.sort((a, b) => new Date(a.reply.created_at).getTime() - new Date(b.reply.created_at).getTime());
        return results;
    }, [allGlobalReplies, eventId]);

    return (
        <div className="group">
            {/* Main row */}
            <div
            className={`flex items-start gap-2.5 py-1.5 px-2 rounded-lg transition-colors ${!readOnly && isClickable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60' : ''}`}
                onClick={() => {
                    if (readOnly) return;
                    const tsList = [event.ts, ...flatReplies.map(r => new Date(r.reply.created_at).getTime())];
                    onClickItem?.(tsList);
                    if (event.kind === 'version') onPreviewVersion(event.data);
                    if (event.kind === 'annotation' && event.data.anchor_preview) {
                        window.dispatchEvent(new CustomEvent('annotation:focus', {
                            detail: {
                                annotationId: eventId,
                                anchorPreview: event.data.anchor_preview,
                            }
                        }));
                    }
                }}
            >
                {/* Time */}
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums w-9 shrink-0 pt-px text-right">
                    {hhmm(event.ts)}
                </span>

                {/* Icon */}
                <Icon size={13} className={`${iconCls} shrink-0 mt-px`} />

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <p className="text-xs text-zinc-700 dark:text-zinc-200 leading-snug flex-1">
                            {actionText}
                        </p>
                        {/* NEW 实心小红点/徽章 — 面板打开前的未读新事件 */}
                        {isNew && (
                            <span className="text-[9px] font-semibold px-1 rounded-sm bg-red-500 text-white shrink-0 shadow-sm">
                                NEW
                            </span>
                        )}
                    </div>
                    {contentPreview && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-snug truncate">
                            {contentPreview}
                        </p>
                    )}
                    {/* Universal reply actions */}
                    {!readOnly && (
                    <div className="flex items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={e => { e.stopPropagation(); onReply(eventId as string); }}
                            className="text-[10px] text-zinc-400 hover:text-indigo-500 dark:hover:text-blue-300 flex items-center gap-0.5">
                            <CornerDownRight size={9} /> {t('activity.reply', '回复')}
                        </button>
                        {event.kind === 'annotation' && isOwn && (
                            <button onClick={e => { e.stopPropagation(); onDeleteAnnotation(eventId as string); }}
                                className="text-[10px] text-zinc-400 hover:text-red-500">
                                <Trash2 size={9} />
                            </button>
                        )}
                        {event.kind === 'comment' && isOwn && (
                            <button onClick={e => { e.stopPropagation(); onDeleteComment(eventId as string); }}
                                className="text-[10px] text-zinc-400 hover:text-red-500">
                                <Trash2 size={9} />
                            </button>
                        )}
                    </div>
                    )}
                </div>
            </div>

            {/* Replies 扁平化渲染区 */}
            {flatReplies.length > 0 && (
                <div className="ml-10 border-l-[1.5px] border-zinc-100 dark:border-zinc-800 space-y-0 mt-0.5 pb-1">
                    {flatReplies.map(({ reply, parentReply }) => (
                        <FlatReplyNode key={reply.id} reply={reply} parentReply={parentReply} currentUser={currentUser}
                            replyingTo={replyingTo} onReply={onReply} onCancelReply={onCancelReply} onSendReply={onSendReply}
                            onDeleteReply={onDeleteComment} onClickItem={onClickItem} activeUnreadTsSet={activeUnreadTsSet} clickedTs={clickedTs} t={t} />
                    ))}
                </div>
            )}

            {/* Top-level Reply input */}
            {replyingTo === eventId && (
                <div className="ml-12 flex items-center gap-1.5 py-1.5 mt-1">
                    <input
                        autoFocus
                        placeholder={t('activity.reply_main', '回复主事件...')}
                        onMouseDown={e => e.stopPropagation()}
                        onKeyDown={async e => {
                            if (e.key === 'Enter') {
                                const v = (e.currentTarget as HTMLInputElement).value.trim();
                                if (v) await onSendReply(eventId as string, event.kind, v);
                            }
                            if (e.key === 'Escape') onCancelReply();
                        }}
                        className="flex-1 text-[11px] border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 rounded px-2 py-1.5 text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 dark:focus:ring-blue-400/30"
                    />
                    <button onClick={onCancelReply} className="text-[10px] text-zinc-400 hover:text-zinc-600 px-1.5">{t('activity.cancel', '取消')}</button>
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────
// Group Row (N 次修改，可展开)
// ─────────────────────────────────────────

function GroupRow({ item, onPreview, clickedTs, onItemClick, activeUnreadTsSet, readOnly = false, t }: {
    t: any;
    item: DayItem & { type: 'group' };
    onPreview: (s: SnapshotInfo) => void;
    clickedTs: Set<number>;
    onItemClick: (tsList: number[]) => void;
    activeUnreadTsSet: Set<number>;
    readOnly?: boolean;
}) {
    // 只要组内有属于 activeUnreadTsSet 范围、且尚未被 clickedTs 包含的事件，即判为新事件
    const newEvents = item.events.filter(ev => 
        activeUnreadTsSet.has(ev.ts) && !clickedTs.has(ev.ts)
    );
    const hasNew = newEvents.length > 0;
    const [expanded, setExpanded] = useState(hasNew); // 含 NEW 事件时默认展开
    const oldest = hhmm(item.events[item.events.length - 1].ts);
    const newest = hhmm(item.events[0].ts);

    return (
        <div>
            <button
                onClick={() => {
                    setExpanded(v => !v);
                    if (hasNew) onItemClick(newEvents.map(e => e.ts));
                }}
                className="flex items-center gap-2.5 py-1.5 px-2 w-full rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors text-left"
            >
                <span className="text-[10px] text-zinc-400 tabular-nums w-9 shrink-0 text-right">{newest}</span>
                {expanded ? <ChevronDown size={12} className="text-zinc-400 shrink-0" /> : <ChevronRight size={12} className="text-zinc-400 shrink-0" />}
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {item.label}
                    <span className="text-zinc-400 dark:text-zinc-600 ml-1 font-normal text-[10px]">{oldest} — {newest}</span>
                </span>
                {/* 有 NEW 事件时在标题按钒显示红点 */}
                {hasNew && !readOnly && !expanded && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 ml-auto" />
                )}
            </button>
            {expanded && (
                <div className="ml-12 border-l border-zinc-200 dark:border-zinc-700 pl-2 space-y-0">
                    {item.events.map((ev, i) => {
                        const isNewEv = activeUnreadTsSet.has(ev.ts) && !clickedTs.has(ev.ts);
                        return (
                            <div key={i}
                                className="flex items-center gap-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 rounded transition-colors"
                                onClick={() => {
                                    if (readOnly) return;
                                    onItemClick([ev.ts]);
                                    if (ev.kind === 'version') onPreview(ev.data);
                                }}
                            >
                                <span className="text-[10px] text-zinc-400 tabular-nums w-9 shrink-0 text-right">{hhmm(ev.ts)}</span>
                                <FileEdit size={11} className="text-zinc-400 shrink-0" />
                                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {ev.kind === 'version' ? t('activity.edited_note', '{{author}}修改了笔记', { author: ev.data.author_name || '?' }) : t('activity.edited_note', '修改了笔记', { author: '' })}
                                </span>
                                {!readOnly && isNewEv && (
                                    <span className="ml-1 px-1 py-0 rounded text-[9px] font-semibold bg-red-500 text-white leading-4">
                                        NEW
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────

export function ActivityTimeline({ notePath, docStatus: _docStatus = 'solo', vaultPath, readOnly = false }: { notePath: string | null; docStatus?: DocStatus; vaultPath?: string | null; readOnly?: boolean }) {
    const { t } = useTranslation();
    const { setLastRead, markRead, getUnreadEntry } = useCollabNotifyStore();
    const [snapshots,   setSnapshots]   = useState<SnapshotInfo[]>([]);
    const [annotations, setAnnotations] = useState<AnnotationInfo[]>([]);
    const [comments,    setComments]    = useState<CommentInfo[]>([]);
    const [statusEvents,setStatusEvents]= useState<StatusEventInfo[]>([]);
    const [systemEvents,setSystemEvents]= useState<CollabEvent[]>([]);
    const [loading,     setLoading]     = useState(false);
    const [everLoaded,  setEverLoaded]  = useState(false);
    const [previewSnap, setPreviewSnap] = useState<SnapshotInfo | null>(null);
    const [replyingTo,  setReplyingTo]  = useState<string | null>(null);
    const [showCompose, setShowCompose] = useState(false);
    const [composing,   setComposing]   = useState('');
    const [currentFileId, setCurrentFileId] = useState<string | null>(null);
    const [currentResolvedPath, setCurrentResolvedPath] = useState<string>('');
    // 记录由于交互已消除的事件时间戳
    const [clickedTs,   setClickedTs]   = useState<Set<number>>(new Set());
    const listEndRef = useRef<HTMLDivElement>(null);

    const currentUser = useSessionStore.getState().displayName || '';
    const resolved = notePath ? resolveTeamPath(notePath) : null;
    const noteName = notePath
        ? (getBasename(notePath)?.replace(/\.md$/, '') ?? notePath)
        : '';
        
    const unreadFiles = useCollabNotifyStore(s => s.unreadFiles);
    const relPath = notePath?.replace(/^__team__\//, '').replace(/^\/|^\.\//g, '') ?? '';
    const basename = getBasename(relPath) ?? '';
    const isVirtualTeamNote = notePath?.startsWith('__team__/') ?? false;

    const currentStoreUnreadSince = useMemo(() => {
        let entry = currentFileId
            ? (() => {
                for (const v of unreadFiles.values()) {
                    if (v.fileId === currentFileId) return v;
                }
                return undefined;
            })()
            : undefined;

        if (!entry && currentResolvedPath) {
            entry = getUnreadEntry(currentResolvedPath);
        }

        if (!entry && !isVirtualTeamNote && relPath) {
            entry = getUnreadEntry(relPath);
        }

        if (!entry && !isVirtualTeamNote && basename) {
            for (const v of unreadFiles.values()) {
                if (v.filePath === basename || v.filePath.endsWith('/' + basename)) {
                    entry = v;
                    break;
                }
            }
        }
        return entry?.unreadSince || 0;
    }, [relPath, basename, unreadFiles, getUnreadEntry, currentFileId, currentResolvedPath, isVirtualTeamNote]);

    const currentUnreadTarget = useMemo(() => {
        let matchedPath = currentResolvedPath || relPath;
        let matchedEntry = currentFileId
            ? (() => {
                for (const entry of unreadFiles.values()) {
                    if (entry.fileId === currentFileId) return entry;
                }
                return undefined;
            })()
            : undefined;

        if (!matchedEntry && currentResolvedPath) {
            matchedPath = currentResolvedPath;
            matchedEntry = getUnreadEntry(currentResolvedPath);
        }

        if (!matchedEntry && !isVirtualTeamNote && relPath) {
            matchedPath = relPath;
            matchedEntry = getUnreadEntry(relPath);
        }

        if (!matchedEntry && !isVirtualTeamNote && basename) {
            for (const entry of unreadFiles.values()) {
                if (entry.filePath === basename || entry.filePath.endsWith('/' + basename)) {
                    matchedEntry = entry;
                    matchedPath = entry.filePath;
                    break;
                }
            }
        }

        if (!matchedEntry) return null;
        return { path: matchedPath, entry: matchedEntry };
    }, [relPath, basename, unreadFiles, getUnreadEntry, currentFileId, currentResolvedPath, isVirtualTeamNote]);

    // 冻结当前会话的界定游标，防止 markRead 后界面 NEW 瞬间蒸发
    const [frozenUnreadSince, setFrozenUnreadSince] = useState(0);
    useEffect(() => {
        // 唯有当 Store 传来有效的未读标记时，我们将其冻结供面板渲染
        if (currentStoreUnreadSince > 0 && frozenUnreadSince === 0) {
            setFrozenUnreadSince(currentStoreUnreadSince);
        }
    }, [currentStoreUnreadSince, frozenUnreadSince]);

    const unreadSince = frozenUnreadSince > 0 ? frozenUnreadSince : currentStoreUnreadSince;

    useEffect(() => {
        setSnapshots([]); setAnnotations([]); setComments([]); setSystemEvents([]);
        setEverLoaded(false); setReplyingTo(null); setShowCompose(false);
        setClickedTs(new Set());
        setFrozenUnreadSince(0); // 切换笔记时强制解冻游标
        setCurrentFileId(null);
        setCurrentResolvedPath('');
    }, [notePath]); // eslint-disable-line

    useEffect(() => {
        let cancelled = false;
        const loadIdentity = async () => {
            if (resolved?.fileId && !resolved.filePath) {
                const file = await syncService.getVaultFileById(resolved.vaultId, resolved.fileId);
                return { fileId: file.fileId, filePath: file.filePath };
            }
            return { fileId: await resolveNoteFileId(notePath, resolved), filePath: resolved?.filePath ?? '' };
        };
        loadIdentity().then(({ fileId, filePath }) => {
            if (cancelled) return;
            setCurrentFileId(fileId);
            setCurrentResolvedPath(filePath || resolved?.filePath || '');
            if (resolved && !resolved.filePath && filePath) {
                resolved.filePath = filePath;
            }
        }).catch(() => {
            if (!cancelled) {
                setCurrentFileId(resolved?.fileId ?? null);
                setCurrentResolvedPath(resolved?.filePath ?? '');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [notePath, resolved?.vaultId, resolved?.filePath]);

    // Build groups
    const globalReplies = useMemo(() => comments.filter(c => !!c.parent_id), [comments]);
    const topLevelComments = useMemo(() => comments.filter(c => !c.parent_id), [comments]);

    // 过滤由 doc_status (YAML) 更新引发的伴生极近快照，将其视觉合并
    const filteredSnapshots = useMemo(() => {
        return snapshots.filter(s => {
            const sTs = new Date(s.created_at).getTime();
            // 在前后 3 秒内是否存在同一作者的状态切换事件
            const isYAMLOriented = statusEvents.some(se => 
                se.author_name === s.author_name && Math.abs(new Date(se.created_at).getTime() - sTs) < 3000
            );

            return !isYAMLOriented;
        });
    }, [snapshots, statusEvents]);

    const latestVisibleSnapshotId = useMemo(() => {
        return filteredSnapshots.reduce<SnapshotInfo | null>((latest, snap) => {
            if (!latest) return snap;
            return new Date(snap.created_at).getTime() > new Date(latest.created_at).getTime() ? snap : latest;
        }, null)?.id ?? null;
    }, [filteredSnapshots]);

    const rawEvents: RawEvent[] = [
        ...filteredSnapshots.map(s => ({ kind: 'version' as const, ts: new Date(s.created_at).getTime(), data: s })),
        ...annotations.map(a => ({ kind: 'annotation' as const, ts: new Date(a.created_at).getTime(), data: a })),
        ...topLevelComments.map(c => ({ kind: 'comment' as const, ts: new Date(c.created_at).getTime(), data: c })),
        ...statusEvents.map(se => ({ kind: 'status' as const, ts: new Date(se.created_at).getTime(), data: se })),
        ...systemEvents.map(se => ({ kind: 'system' as const, ts: new Date(se.created_at).getTime(), data: se }))
    ];
    const dayGroups = buildDayGroups(rawEvents, t);
    
    // The exact collection of domain events (including replies) for checking global read completion
    const allDomainEvents: RawEvent[] = useMemo(() => {
        return [
            ...filteredSnapshots.map(s => ({ kind: 'version' as const, ts: new Date(s.created_at).getTime(), data: s })),
            ...annotations.map(a => ({ kind: 'annotation' as const, ts: new Date(a.created_at).getTime(), data: a })),
            ...comments.map(c => ({ kind: 'comment' as const, ts: new Date(c.created_at).getTime(), data: c })),
            ...statusEvents.map(se => ({ kind: 'status' as const, ts: new Date(se.created_at).getTime(), data: se })),
            ...systemEvents.map(se => ({ kind: 'system' as const, ts: new Date(se.created_at).getTime(), data: se }))
        ].sort((a, b) => b.ts - a.ts);
    }, [filteredSnapshots, annotations, comments, statusEvents, systemEvents]);

    const activeUnreadEvents = useMemo(() => {
        if (unreadSince === 0) return [];
        let unread = allDomainEvents.filter(ev => ev.ts >= unreadSince - 5000 && ev.data.author_name !== currentUser);
        
        // 🛡️ 免疫快照闲置折叠时差漏洞：
        // 一旦后端的 Idle Merge 保留了最初始的旧时间戳，所有的事件可能会被严苛判定并落选，
        // 这将导致 `!hasUnread` 被错判为 true 并触发红点瞬间自毁。
        // 此刻自动降级：强行找到最近一条别人发出的记录将其升格为红点宿主！
        if (unread.length === 0) {
            const latestForeign = allDomainEvents.find(ev => ev.data.author_name !== currentUser);
            if (latestForeign) {
                unread = [latestForeign];
            }
        }
        
        return unread;
    }, [allDomainEvents, unreadSince, currentUser]);

    const activeUnreadTsSet = useMemo(() => new Set(activeUnreadEvents.map(e => e.ts)), [activeUnreadEvents]);

    // Watch unread completion to clear global red dot
    useEffect(() => {
        if (!everLoaded) return;
        const relPath = notePath?.replace(/^__team__\//, '').replace(/^\/|^\.\//g, '') ?? '';
        if (!relPath) return;

        const hasUnread = activeUnreadEvents.length > 0;
        const allClicked = hasUnread && activeUnreadEvents.every((ev: RawEvent) => clickedTs.has(ev.ts));

        const teamVaultId = useSessionStore.getState().teamVaultId ?? '';
        const hasGlobalRedDot = Boolean(currentUnreadTarget);
        const matchedPath = currentUnreadTarget?.path ?? relPath;

        if (hasGlobalRedDot) {
            // Only explicit user consumption should clear a file red dot.
            // On Windows, path resolution can briefly fail while the panel opens; treating
            // "!hasUnread" as read would optimistically clear unrelated red dots until the
            // next server refresh brings them back.
            if (allClicked && clickedTs.size > 0) {
                void markRead(matchedPath, teamVaultId);
                setLastRead(matchedPath, Date.now());
                if (matchedPath !== relPath) setLastRead(relPath, Date.now());
            }
        }
    }, [everLoaded, notePath, clickedTs, activeUnreadEvents, markRead, setLastRead, relPath, currentUnreadTarget]); // eslint-disable-line

    const loadAll = useCallback(async () => {
        if (!resolved) return;
        setLoading(true);
        try {
            const [sRes, aRes, cRes, stRes, sysRes] = await Promise.allSettled([
                snapshotService.listSnapshots(resolved.vaultId, resolved.filePath, 200, currentFileId),
                annotationService.listAnnotations(resolved.vaultId, resolved.filePath, currentFileId),
                commentService.listComments(resolved.vaultId, resolved.filePath, currentFileId),
                collabService.getStatusEvents(resolved.vaultId, resolved.filePath, currentFileId),
                collabService.getFileEvents(resolved.vaultId, resolved.filePath, currentFileId)
            ]);
            if (sRes.status === 'fulfilled') {
                setSnapshots(await keepSnapshotsVisibleFromLocalState(sRes.value.snapshots, notePath));
            }
            if (aRes.status === 'fulfilled') setAnnotations(aRes.value);
            if (cRes.status === 'fulfilled') setComments(cRes.value);
            if (stRes.status === 'fulfilled') setStatusEvents(stRes.value);
            if (sysRes.status === 'fulfilled') setSystemEvents(sysRes.value);
            setEverLoaded(true);
            const anns = aRes.status === 'fulfilled' ? aRes.value : [];
            window.dispatchEvent(new CustomEvent('annotation:marks:restore', { detail: { noteId: notePath, annotations: anns } }));
        } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [notePath, currentFileId]);

    useEffect(() => {
        loadAll();
    }, [loadAll]);

    useEffect(() => {
        const h = () => loadAll();
        window.addEventListener('sync:completed', h);
        window.addEventListener('annotation:reload', h);
        window.addEventListener('slash:editor-content-loaded', h);
        
        return () => { 
            window.removeEventListener('sync:completed', h); 
            window.removeEventListener('annotation:reload', h); 
            window.removeEventListener('slash:editor-content-loaded', h);
        };
    }, [loadAll, notePath]);

    useEffect(() => () => { window.dispatchEvent(new CustomEvent('annotation:marks:clear')); }, []);

    useEffect(() => () => { window.dispatchEvent(new CustomEvent('annotation:marks:clear')); }, []);

    // Handlers
    const handleDeleteComment = async (id: string) => {
        await commentService.deleteComment(id).catch(() => {});
        setComments(p => p.filter(c => c.id !== id));
    };
    const handleDeleteAnnotation = async (id: string) => {
        await annotationService.deleteAnnotation(id).catch(() => {});
        setAnnotations(p => p.filter(a => a.id !== id && a.parent_id !== id));
    };
    const handleSendReply = async (parentId: string, parentType: string, text: string) => {
        if (!resolved) return;
        await commentService.createComment(resolved.vaultId, resolved.filePath, text, parentId, parentType, currentFileId);
        setReplyingTo(null); await loadAll();
    };
    const handleSendComment = async () => {
        if (!resolved || !composing.trim()) return;
        await commentService.createComment(resolved.vaultId, resolved.filePath, composing.trim(), undefined, undefined, currentFileId);
        setComposing(''); setShowCompose(false); await loadAll();
        setTimeout(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    };


    const rowProps = {
        currentUser, noteName,
        t, onPreviewVersion: readOnly ? (() => {}) : setPreviewSnap,
        onDeleteComment: handleDeleteComment,
        onDeleteAnnotation: handleDeleteAnnotation,
        replyingTo: readOnly ? null : replyingTo,
        onReply: readOnly ? (() => {}) : (id: string) => setReplyingTo(r => r === id ? null : id),
        onCancelReply: () => setReplyingTo(null),
        onSendReply: handleSendReply,
        onClickItem: undefined, // default placeholder
    };

    const handleItemClick = useCallback((tsList: number[]) => {
        setClickedTs(prev => {
            const next = new Set(prev);
            tsList.forEach(ts => next.add(ts));
            return next;
        });
        if (!tsList.some(ts => activeUnreadTsSet.has(ts))) return;

        const teamVaultId = useSessionStore.getState().teamVaultId ?? '';
        if (!teamVaultId || !relPath) return;

        if (currentUnreadTarget) {
            void markRead(currentUnreadTarget.path, teamVaultId);
            setLastRead(currentUnreadTarget.path, Date.now());
            if (currentUnreadTarget.path !== relPath) setLastRead(relPath, Date.now());
        }
    }, [activeUnreadTsSet, markRead, relPath, setLastRead, currentUnreadTarget]);

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 h-12 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                <div className="flex items-center gap-2">
                    <History size={16} className="text-zinc-400" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('activity.panel_title', '协作历史')}</span>
                </div>
                <div className="flex items-center gap-1">
                    {currentUnreadTarget && (
                        <button
                            onClick={() => {
                                const vaultId = useSessionStore.getState().teamVaultId ?? '';
                                if (!vaultId) return;
                                void markRead(currentUnreadTarget.path, vaultId);
                                setLastRead(currentUnreadTarget.path, Date.now());
                                if (currentUnreadTarget.path !== relPath) {
                                    setLastRead(relPath, Date.now());
                                }
                            }}
                            title={t('activity.clear_all_unread', '全部标为已读')}
                            className="p-1 rounded-md transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 text-indigo-500 dark:text-blue-400"
                        >
                            <CheckCheck size={16} />
                        </button>
                    )}
                    {!readOnly && (
                        <button
                            onClick={() => setShowCompose(v => !v)}
                            title={t('activity.compose_comment', '发表评论')}
                            className={`p-1 rounded-md transition-colors ${showCompose ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-500 dark:text-blue-400' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400'}`}
                        >
                            <MessageSquare size={16} />
                        </button>
                    )}
                </div>
            </div>

            {/* Comment compose */}
            {!readOnly && showCompose && notePath && (
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                    <div className="flex items-end gap-2">
                        <textarea
                            value={composing}
                            onChange={e => setComposing(e.target.value)}
                            onMouseDown={e => e.stopPropagation()}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendComment(); } }}
                            placeholder={t('comments.input_placeholder', '写一条评论...')}
                            rows={2}
                            className="flex-1 text-xs resize-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2 text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 dark:focus:ring-blue-400/30"
                        />
                        <button onClick={handleSendComment} disabled={!composing.trim()}
                            className="p-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 transition-colors">
                            <Send size={12} />
                        </button>
                    </div>
                </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
                {!notePath ? (
                    <div className="flex items-center justify-center h-40 text-zinc-400 text-sm">{t('activity.no_note', '请先选择一篇笔记')}</div>
                ) : (loading && !everLoaded) ? (
                    <div className="flex items-center justify-center h-40 text-zinc-400 text-sm">{t('activity.loading', '加载中...')}</div>
                ) : (everLoaded && dayGroups.length === 0) ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400 dark:text-zinc-500">
                        <GitCommit size={28} strokeWidth={1.2} />
                        <span className="text-sm">暂无协作记录</span>
                        <span className="text-xs text-center">同步文件后自动生成历史</span>
                    </div>
                ) : (
                    <div className="px-2 py-3">
                        {dayGroups.map((group, gi) => (
                            <div key={gi} className="mb-4">
                                {/* Date header */}
                                <div className="flex items-center gap-2 px-2 mb-1">
                                    <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{group.dateLabel}</span>
                                    <div className="flex-1 h-px bg-zinc-100 dark:bg-zinc-800" />
                                </div>
                                {/* Items */}
                                <div className="space-y-0">
                                    {group.items.map((item, ii) =>
                                        item.type === 'event' ? (
                                            <EventRow key={ii} event={item.event} {...rowProps}
                                                allGlobalReplies={globalReplies}
                                                isNew={readOnly ? false : (activeUnreadTsSet.has(item.event.ts) && !clickedTs.has(item.event.ts))}
                                                activeUnreadTsSet={readOnly ? new Set() : activeUnreadTsSet}
                                                clickedTs={clickedTs}
                                                readOnly={readOnly}
                                                onClickItem={readOnly ? (() => {}) : ((tsList) => handleItemClick(tsList))} />
                                        ) : (
                                            <GroupRow key={ii} item={item} onPreview={readOnly ? (() => {}) : setPreviewSnap}
                                                activeUnreadTsSet={readOnly ? new Set() : activeUnreadTsSet}
                                                clickedTs={clickedTs} onItemClick={readOnly ? (() => {}) : handleItemClick} readOnly={readOnly} t={t} />
                                        )
                                    )}
                                </div>
                            </div>
                        ))}
                        <div ref={listEndRef} />
                    </div>
                )}
            </div>

            {/* Preview Modal */}
            {!readOnly && previewSnap && <SnapshotPreviewModal snap={previewSnap} onClose={() => setPreviewSnap(null)} t={t} vaultPath={vaultPath} isLatestSnapshot={previewSnap.id === latestVisibleSnapshotId} />}
        </div>
    );
}
