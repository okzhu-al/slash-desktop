/**
 * VersionTimeline.tsx — Phase 3.4
 * 版本时间线面板：列出文件历史快照，支持预览内容和一键回退。
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { History, X, GitCommit } from 'lucide-react';
import { keepSnapshotsVisibleFromLocalState, snapshotService, SnapshotInfo, SnapshotContent, SnapshotListResult, extractAssetRefs } from '@/services/SnapshotService';
import { SnapshotReadonlyEditor } from './SnapshotReadonlyEditor';
import { syncService } from '@/services/SyncService';
import { useSessionStore } from '@/stores/useSessionStore';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { CloudOff } from 'lucide-react';
import { getBasename } from '@/shared/utils/pathUtils';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

function resolveFilePath(notePath: string | null): { vaultId: string; filePath: string; fileId: string | null } | null {
    if (!notePath) return null;
    const config = syncService.getConfig();
    if (!config) return null;

    const teamVaultId = useSessionStore.getState().teamVaultId;
    const vaultRoot = (window as any).__slashVaultPath || '';

    // 🛡️ team 笔记路径以 __team__/ 开头，直接剥离该前缀即得到 server 端 relative_path
    if (notePath.startsWith('__team__/')) {
        const parsed = parseTeamNoteId(notePath);
        return {
            vaultId: parsed.teamVaultId || teamVaultId || config.vaultId,
            filePath: parsed.filePath || '',
            fileId: parsed.fileId,
        };
    }

    // 个人笔记路径：始终使用个人 vaultId + 原始路径（不做 PARA_MAP 翻译）
    let filePath = notePath;
    if (vaultRoot) {
        // \ud83d\udee1\ufe0f Windows \u517c\u5bb9\uff1a\u7edf\u4e00\u6b63\u659c\u6760\u518d\u505a\u8def\u5f84\u622a\u53d6
        const normFile = filePath.replace(/\\/g, '/');
        const normVault = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '');
        filePath = normFile.startsWith(normVault + '/') 
            ? normFile.slice(normVault.length + 1) 
            : normFile;
    } else {
        filePath = filePath.replace(/\\/g, '/');
    }
    if (!filePath.endsWith('.md')) filePath += '.md';

    return {
        vaultId: config.vaultId,
        filePath,
        fileId: null,
    };
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


// ── 工具函数 ──
// 格式化时间：月-日 时:分（不用相对时间）
function formatTime(isoStr: string): string {
    const d = new Date(isoStr);
    const year = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// 快照类型标签
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typeLabel(type: string | null, t: any): { text: string; cls: string } {
    if (type === 'create') return { text: t('versions.type_create', { defaultValue: '创建' }), cls: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' };
    if (type === 'revert') return { text: t('versions.type_revert', { defaultValue: '回退' }), cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' };
    if (type === 'freeze') return { text: t('versions.type_freeze', { defaultValue: '冻结' }), cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' };
    if (type === 'rename') return { text: t('versions.type_rename', { defaultValue: '重命名' }), cls: 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400' };
    return { text: t('versions.type_sync', { defaultValue: '修改' }), cls: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400' };
}

function noteNameFromPath(filePath: string): string {
    const base = getBasename(filePath) || filePath;
    return base.endsWith('.md') ? base.slice(0, -3) : base;
}

// 剥离 YAML frontmatter（--- ... --- 包裹的头部）
function stripFrontmatter(raw: string): string {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith('---')) return raw;
    const endIdx = trimmed.indexOf('\n---', 3);
    if (endIdx === -1) return raw;
    return trimmed.slice(endIdx + 4).trimStart();
}

// ── Preview Modal ──
function PreviewModal({
    snap,
    onClose,
    canRevert,
    isPersonal,
    isLatestPersonal,
    notePath,
    onRevertSuccess,
}: {
    snap: SnapshotInfo;
    onClose: () => void;
    canRevert: boolean;
    isPersonal: boolean;
    isLatestPersonal?: boolean;
    notePath: string | null;
    onRevertSuccess?: () => void;
}) {
    const { t } = useTranslation();
    const [content, setContent] = useState<SnapshotContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [stale, setStale] = useState(false);
    const [reverting, setReverting] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const handleDelete = async () => {
        const confirmed = await confirm(
            t('versions.confirm_delete', '确定要永久删除这条快照记录吗？此操作无法撤销。'),
            { title: 'Slash', kind: 'warning' }
        );
        if (!confirmed) return;

        setDeleting(true);
        try {
            await snapshotService.deleteSnapshot(snap.id);
            await message(t('versions.delete_success', '删除成功！'), { title: 'Slash', kind: 'info' });
            onRevertSuccess?.();
            onClose();
        } catch (e) {
            await message(String(e), { title: 'Slash', kind: 'error' });
        } finally {
            setDeleting(false);
        }
    };

    const handleRevert = async () => {
        const confirmed = await confirm(
            t('versions.confirm_revert', '确定要将此文件回退到该版本吗？\n当前的更改将会被覆盖（并在历史中生成一条自动保存记录）。'),
            { title: 'Slash', kind: 'warning' }
        );
        if (!confirmed) return;

        setReverting(true);
        try {
            const assets = content?.content ? extractAssetRefs(content.content) : [];
            await snapshotService.revertToSnapshot(snap.id, assets);
            // 将快照内容写入本地文件，让编辑器能立即读到
            if (content?.content && notePath && !notePath.startsWith('__team__/')) {
                const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                await writeTextFile(notePath, content.content);
            }
            // 触发编辑器全量重载
            window.dispatchEvent(new CustomEvent('slash:reload-note'));
            await message(t('versions.revert_success', '回退成功！'), { title: 'Slash', kind: 'info' });
            // 触发后台同步，让 server 状态与本地一致，同时生成最新快照
            const vaultPath = (window as any).__slashVaultPath;
            if (vaultPath && syncService.isConfigured()) {
                syncService.syncVault(vaultPath).then(() => {
                    window.dispatchEvent(new CustomEvent('sync:completed'));
                }).catch(() => {});
            }
            onRevertSuccess?.();
            onClose();
        } catch (e) {
            await message(String(e), { title: 'Slash', kind: 'error' });
        } finally {
            setReverting(false);
        }
    };

    useEffect(() => {
        snapshotService.getSnapshotContent(snap.id)
            .then((value) => {
                if (value.content_hash !== snap.content_hash) {
                    setStale(true);
                    setContent(null);
                    return;
                }
                setContent(value);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [snap.id, snap.content_hash]);

    // PreviewModal header：笔记名 + 类型 + 作者 + 时间
    const noteName = noteNameFromPath(snap.file_path);
    const { text: typeText, cls: typeCls } = typeLabel(snap.snapshot_type, t);

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
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                    <div>
                        <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{noteName}</p>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${typeCls}`}>{typeText}</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5">
                            {snap.author_name && snap.author_name !== '__personal__' && (
                                <>{snap.author_name} · </>
                            )}
                            {formatTime(snap.created_at)}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {canRevert && isPersonal && (
                            <button
                                onClick={handleDelete}
                                disabled={deleting || reverting || loading}
                                className="px-3 py-1 text-xs font-medium rounded-md border border-red-200 dark:border-red-900/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                            >
                                {deleting ? t('versions.deleting_btn', '删除中...') : t('versions.delete_btn', '删除快照')}
                            </button>
                        )}
                        {isLatestPersonal ? (
                            <button
                                disabled
                                className="px-3 py-1 text-xs font-medium rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 cursor-not-allowed"
                            >
                                {t('versions.current_badge', '当前版本')}
                            </button>
                        ) : canRevert && (
                            <button
                                onClick={handleRevert}
                                disabled={reverting || deleting || loading || !content}
                                className="px-3 py-1 text-xs font-medium rounded-md bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white transition-colors disabled:opacity-50"
                            >
                                {reverting ? t('versions.reverting', '回退中...') : t('versions.revert_btn', '一键回退')}
                            </button>
                        )}
                        <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
                {/* Content — 只读 TipTap 渲染（与主编辑器共享同一序列化桥）*/}
                <div className="flex-1 overflow-auto px-6 py-4 bg-white dark:bg-zinc-900 rounded-b-xl">
                    {loading ? (
                        <div className="h-40 flex items-center justify-center text-zinc-400 text-sm">{t('versions.loading_content')}</div>
                    ) : stale ? (
                        <div className="h-40 flex items-center justify-center text-zinc-400 text-sm">{t('activity.waiting_for_sync', '等待同步完成后查看')}</div>
                    ) : content?.content ? (
                        <SnapshotReadonlyEditor
                            markdown={stripFrontmatter(content.content)}
                        />
                    ) : (
                        <p className="text-zinc-400 text-sm">（空内容）</p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Main Component ──
interface VersionTimelineProps {
    notePath: string | null;
}

export function VersionTimeline({ notePath }: VersionTimelineProps) {
    const { t } = useTranslation();
    const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
    const [canRevert, setCanRevert] = useState(false);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewSnap, setPreviewSnap] = useState<SnapshotInfo | null>(null);
    const [currentFileId, setCurrentFileId] = useState<string | null>(null);

    // everLoaded: 当前 notePath 下是否已完成一次有效加载（控制空状态显示时机）
    const [everLoaded, setEverLoaded] = useState(false);
    // 版本历史仅展示，不提供回退操作
    const [isConfigured, setIsConfigured] = useState(() => syncService.isConfigured());

    useEffect(() => {
        const handleConfigChanged = () => setIsConfigured(syncService.isConfigured());
        window.addEventListener('sync:config-changed', handleConfigChanged);
        return () => window.removeEventListener('sync:config-changed', handleConfigChanged);
    }, []);

    // notePath 变化 → 重置列表和加载状态（防止旧数据残留到新笔记）
    useEffect(() => {
        setSnapshots([]);
        setEverLoaded(false);
        setCurrentFileId(null);
    }, [notePath]);

    useEffect(() => {
        let cancelled = false;
        const resolved = resolveFilePath(notePath);
        resolveNoteFileId(notePath, resolved).then((fileId) => {
            if (!cancelled) setCurrentFileId(fileId);
        });
        return () => {
            cancelled = true;
        };
    }, [notePath]);

    // ── 后台无感拉取：有数据才替换，永远不清空 ──
    const silentRefresh = useCallback(async () => {
        const resolved = resolveFilePath(notePath);
        if (!resolved) return;
        try {
            const result: SnapshotListResult = await snapshotService.listSnapshots(resolved.vaultId, resolved.filePath, 50, currentFileId);
            const visibleSnapshots = await keepSnapshotsVisibleFromLocalState(result.snapshots, notePath);
            if (visibleSnapshots.length > 0) {
                setSnapshots(visibleSnapshots);
                setCanRevert(result.can_revert);
                setEverLoaded(true);
            }
        } catch { /* 静默失败 */ }
    }, [notePath, currentFileId]);

    // ── 主加载：notePath 切换时触发，stale-while-revalidate ──
    const loadSnapshots = useCallback(async () => {
        const resolved = resolveFilePath(notePath);
        if (!resolved) return;
        setLoading(true);
        setError(null);
        try {
            const result: SnapshotListResult = await snapshotService.listSnapshots(resolved.vaultId, resolved.filePath, 50, currentFileId);
            const visibleSnapshots = await keepSnapshotsVisibleFromLocalState(result.snapshots, notePath);
            if (visibleSnapshots.length > 0) {
                // 有数据：立即替换
                setSnapshots(visibleSnapshots);
                setCanRevert(result.can_revert);
                setEverLoaded(true);
            } else {
                // 服务端暂无数据（改名时序窗口期）：保留旧列表，等 sync:completed silentRefresh 更新
                // 如果旧列表本就为空，才真正显示为空（全新笔记）
                setSnapshots(prev => {
                    if (prev.length === 0) { setEverLoaded(true); }
                    return prev;
                });
            }
        } catch (e) {
            setError(String(e));
            setEverLoaded(true);
        } finally {
            setLoading(false);
        }
    }, [notePath, currentFileId]);

    useEffect(() => {
        if (isConfigured) {
            loadSnapshots();
        }
    }, [loadSnapshots, isConfigured]);

    // sync:completed → 无感刷新
    useEffect(() => {
        window.addEventListener('sync:completed', silentRefresh);
        return () => window.removeEventListener('sync:completed', silentRefresh);
    }, [silentRefresh]);


    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                <div className="flex items-center gap-2">
                    <History size={14} className="text-zinc-500" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                        {t('versions.panel_title', '版本')}
                    </span>
                    {snapshots.length > 0 && (
                        <span className="text-[10px] bg-zinc-200 dark:bg-zinc-700 text-zinc-500 px-1.5 py-0.5 rounded-full font-medium">
                            {snapshots.length}
                        </span>
                    )}
                </div>
            </div>

            {/* Success toast */}
            
            {/* Body */}
            <div className="flex-1 overflow-y-auto">
                {!isConfigured ? (
                    <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                        <div className="w-16 h-16 mb-4 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                            <CloudOff size={28} className="text-zinc-400 dark:text-zinc-500" strokeWidth={1.5} />
                        </div>
                        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mb-2">
                            {t('activity.feature_not_enabled', '功能未启用')}
                        </h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-6 text-balance leading-relaxed">
                            {t('activity.feature_requires_server', '历史快照功能需要绑定并连接服务端才可使用。')}
                        </p>
                        <button
                            onClick={() => window.dispatchEvent(new CustomEvent('app:open-settings', { detail: { tab: 'sync' } }))}
                            className="px-4 py-2 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 text-xs font-medium rounded-lg transition-colors cursor-pointer"
                        >
                            {t('activity.go_to_configure', '去配置服务端')}
                        </button>
                    </div>
                ) : !notePath ? (
                    <EmptyState icon={<History size={28} strokeWidth={1.2} />} text={t('versions.no_note', '请先选择一篇笔记')} />
                ) : (loading && !everLoaded) ? (
                    <div className="flex items-center justify-center h-40 text-zinc-400 text-sm">{t('versions.loading')}</div>
                ) : error ? (
                    <div className="px-4 py-3 text-xs text-red-500">{error}</div>
                ) : (everLoaded && snapshots.length === 0) ? (
                    <EmptyState
                        icon={<GitCommit size={28} strokeWidth={1.2} />}
                        text={t('versions.empty', '暂无版本记录')}
                        hint={t('versions.empty_hint', '文件同步时自动创建快照')}
                    />
                ) : (
                    <div className="px-3 py-3 space-y-0.5">
                        {snapshots.map((snap, idx) => {
                            const isLatest = idx === 0;
                            const noteName = noteNameFromPath(snap.file_path);
                            return (
                                <div
                                    key={snap.id}
                                    className="group relative flex items-start gap-2.5 px-2 py-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
                                    onClick={() => setPreviewSnap(snap)}
                                >
                                    {/* Timeline indicator */}
                                    <div className="flex flex-col items-center shrink-0 pt-1.5">
                                        <div className={`w-2 h-2 rounded-full shrink-0 ${
                                            snap.snapshot_type === 'create'
                                                ? 'bg-emerald-500'
                                                : snap.snapshot_type === 'revert'
                                                    ? 'bg-amber-500'
                                                    : snap.snapshot_type === 'rename'
                                                        ? 'bg-violet-500'
                                                        : isLatest ? 'bg-indigo-500' : 'bg-zinc-300 dark:bg-zinc-600'
                                        }`} />
                                        {idx < snapshots.length - 1 && (
                                            <div className="w-px bg-zinc-200 dark:bg-zinc-700 mt-1" style={{ height: '100%', minHeight: 20 }} />
                                        )}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        {/* 第一行：笔记名 */}
                                        <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate block">
                                            {noteName}
                                        </span>
                                        {/* 第二行：用户 动词 时间 */}
                                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                                            {snap.author_name && snap.author_name !== '__personal__' && (
                                                <>{snap.author_name} </>
                                            )}
                                            {snap.snapshot_type === 'create'
                                                ? t('versions.type_create', '创建')
                                                : snap.snapshot_type === 'revert'
                                                    ? (() => {
                                                        // 通过 content_hash 找到源快照的时间
                                                        const source = snapshots.find(
                                                            (s, j) => j > idx && s.content_hash === snap.content_hash && s.snapshot_type !== 'revert'
                                                        );
                                                        return source
                                                            ? t('versions.type_revert_from', '恢复自 {{time}}', { time: formatTime(source.created_at) })
                                                            : t('versions.type_revert', '恢复');
                                                    })()
                                                    : snap.snapshot_type === 'rename'
                                                        ? (() => {
                                                            // 解析 "Renamed: old -> new" 提取文件名
                                                            const match = snap.change_summary?.match(/^Renamed:\s*(.+?)\s*->\s*(.+)$/);
                                                            if (match) {
                                                                const oldName = getBasename(match[1]) || match[1];
                                                                const newName = getBasename(match[2]) || match[2];
                                                                return t('versions.renamed_detail', '重命名 {{oldName}} → {{newName}}', { oldName, newName });
                                                            }
                                                            return t('versions.type_rename', '重命名');
                                                        })()
                                                        : t('versions.type_sync', '修改')}
                                            {' '}
                                            {formatTime(snap.created_at)}
                                        </p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Preview Modal */}
            {previewSnap && (
                <PreviewModal
                    snap={previewSnap}
                    onClose={() => setPreviewSnap(null)}
                    canRevert={canRevert}
                    isPersonal={!notePath?.startsWith('__team__/')}
                    isLatestPersonal={previewSnap.id === snapshots[0]?.id && !notePath?.startsWith('__team__/')}
                    notePath={notePath}
                    onRevertSuccess={loadSnapshots}
                />
            )}
        </div>
    );
}

function EmptyState({ icon, text, hint }: { icon: React.ReactNode; text: string; hint?: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-52 gap-2 text-zinc-400 dark:text-zinc-500">
            {icon}
            <p className="text-sm">{text}</p>
            {hint && <p className="text-xs opacity-70 text-center px-4">{hint}</p>}
        </div>
    );
}
