/**
 * StorageDashboard — Admin 存储空间综合看板
 */
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    FileText, Image, Clock, Trash2, Archive,
    Loader2, Cloud, RefreshCw, Users, User, AlertTriangle
} from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import { syncService } from '@/services/SyncService';
import {
    teamService,
    type StorageStatsResponse,
    type CleanupTarget,
    type MemberUsage,
    type CategoryStats
} from '@/services/TeamService';
import { toast } from 'sonner';
import { useSessionStore } from '@/stores/useSessionStore';

// ── Helpers ──

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}


// ── Main Component ──

export function StorageDashboard() {
    const { t } = useTranslation();
    const teamVaultId = useSessionStore(s => s.teamVaultId);

    const [stats, setStats] = useState<StorageStatsResponse | null>(null);
    const [loading, setLoading] = useState(true);

    // ── Cleanup modal state ──
    const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget | null>(null);
    const [cleanupDays, setCleanupDays] = useState(30);
    const [previewCount, setPreviewCount] = useState(0);
    const [previewSize, setPreviewSize] = useState(0);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [cleanupExecuting, setCleanupExecuting] = useState(false);

    const loadStats = useCallback(async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setLoading(true);
        try {
            const data = await teamService.getStorageStats(config.serverUrl, config.accessToken, teamVaultId);
            setStats(data);
        } catch (err) {
            toast.error(t('team.storage_load_failed'));
            console.error('[StorageDashboard] load failed:', err);
        } finally {
            setLoading(false);
        }
    }, [teamVaultId, t]);

    useEffect(() => { loadStats(); }, [loadStats]);

    // ── Preview ──
    const handleOpenCleanup = async (target: CleanupTarget) => {
        setCleanupTarget(target);
        setCleanupDays(30);
        await loadPreview(target, 30);
    };

    const loadPreview = async (target: CleanupTarget, days: number) => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId) return;
        setPreviewLoading(true);
        try {
            const resp = await teamService.cleanupPreview(
                config.serverUrl, config.accessToken, teamVaultId, target, days
            );
            setPreviewCount(resp.deleted_count);
            setPreviewSize(resp.freed_bytes);
        } catch {
            setPreviewCount(0);
            setPreviewSize(0);
        } finally {
            setPreviewLoading(false);
        }
    };

    const handleDaysChange = (days: number) => {
        setCleanupDays(days);
        if (cleanupTarget) loadPreview(cleanupTarget, days);
    };

    // ── Execute ──
    const handleExecuteCleanup = async () => {
        const config = syncService.getConfig();
        if (!config || !teamVaultId || !cleanupTarget) return;
        setCleanupExecuting(true);
        try {
            const resp = await teamService.cleanup(
                config.serverUrl, config.accessToken, teamVaultId, cleanupTarget, cleanupDays
            );
            toast.success(t('team.storage_cleanup_success', {
                count: resp.deleted_count,
                size: formatBytes(resp.freed_bytes),
            }));
            setCleanupTarget(null);
            loadStats(); // refresh
        } catch (err) {
            toast.error(t('team.storage_cleanup_failed', { error: err instanceof Error ? err.message : err }));
        } finally {
            setCleanupExecuting(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 size={20} className="animate-spin text-zinc-300" />
                <span className="ml-3 text-sm text-[#545454]">{t('team.storage_loading')}</span>
            </div>
        );
    }

    if (!stats) {
        return (
            <div className="text-center py-24 text-sm text-[#545454]">{t('team.storage_no_data')}</div>
        );
    }

    const { team_space, personal_space, snapshots, legacy_files, by_member, total_bytes } = stats;

    const teamSpaceSize = team_space.markdown.size_bytes + team_space.media.size_bytes + team_space.trash.size_bytes;
    const personalSpaceSize = personal_space.markdown.size_bytes + personal_space.media.size_bytes;
    const snapshotsSize = snapshots.team.size_bytes + snapshots.personal.size_bytes;

    return (
        <div className="space-y-8">
            {/* ── 头部 ── */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Cloud size={18} className="text-[#002FA7]" />
                    <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">{t('team.storage_title', '云端存储空间')}</h2>
                </div>
                <button
                    onClick={loadStats}
                    className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                    <RefreshCw size={14} className="text-[#545454]" />
                </button>
            </div>

            {/* ── 总量进度条 ── */}
            <div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-6 space-y-4 bg-white dark:bg-zinc-900 shadow-sm">
                <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium text-[#545454] dark:text-[#545454]">{t('team.storage_total_usage')}</span>
                    <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 font-mono tracking-tight">{formatBytes(total_bytes)}</span>
                </div>

                <div className="h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden flex">
                    {teamSpaceSize > 0 && <div className="h-full bg-[#002FA7] transition-all duration-700 hover:brightness-110" style={{ width: `${Math.max((teamSpaceSize / total_bytes) * 100, 1)}%` }} title={`团队空间 - ${formatBytes(teamSpaceSize)}`} />}
                    {personalSpaceSize > 0 && <div className="h-full bg-[#006540] transition-all duration-700 hover:brightness-110" style={{ width: `${Math.max((personalSpaceSize / total_bytes) * 100, 1)}%` }} title={`个人空间 - ${formatBytes(personalSpaceSize)}`} />}
                    {snapshotsSize > 0 && <div className="h-full bg-[#EFE0CC] transition-all duration-700 hover:brightness-110" style={{ width: `${Math.max((snapshotsSize / total_bytes) * 100, 1)}%` }} title={`快照 - ${formatBytes(snapshotsSize)}`} />}
                    {legacy_files.size_bytes > 0 && <div className="h-full bg-[#A42227] transition-all duration-700 hover:brightness-110" style={{ width: `${Math.max((legacy_files.size_bytes / total_bytes) * 100, 1)}%` }} title={`旧版文件 - ${formatBytes(legacy_files.size_bytes)}`} />}
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-2 mt-2">
                    <LegendItem color="bg-[#002FA7]" label={`A. ${t('team.storage_team_space')}`} bytes={teamSpaceSize} />
                    <LegendItem color="bg-[#006540]" label={`B. ${t('team.storage_personal_backup')}`} bytes={personalSpaceSize} />
                    <LegendItem color="bg-[#EFE0CC]" label={`C. ${t('team.storage_snapshots_legacy')}`} bytes={snapshotsSize} />
                    {legacy_files.size_bytes > 0 && <LegendItem color="bg-[#A42227]" label={t('team.storage_legacy')} bytes={legacy_files.size_bytes} />}
                </div>
            </div>

            {/* ── 明细版块 (A / B / C 平行布局) ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* A. Team Space */}
                <div className="rounded-xl border border-[#002FA7]/30 dark:border-blue-500/35 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#002FA7] shadow-sm flex flex-col">
                    <div className="flex items-center gap-2 mb-2">
                        <Users size={16} className="text-[#002FA7]" />
                        <h3 className="font-semibold text-[#002FA7] dark:text-blue-400">A. {t('team.storage_team_space')}</h3>
                    </div>
                    <div className="flex-1 space-y-3">
                        <StatItem icon={<FileText size={14} />} label={t('team.storage_team_markdown')} stats={team_space.markdown} color="text-[#002FA7] dark:text-blue-400" />
                        <StatItem icon={<Image size={14} />} label={t('team.storage_team_media')} stats={team_space.media} color="text-[#002FA7] dark:text-blue-400" />
                        <StatItem icon={<Trash2 size={14} />} label={t('team.storage_team_trash')} stats={team_space.trash} color="text-[#A42227]" />
                    </div>
                    {team_space.trash.size_bytes > 0 && (
                        <button onClick={() => handleOpenCleanup('trash')} className="w-full mt-4 py-2 bg-[#A42227]/10 hover:bg-[#A42227]/20 dark:bg-[#A42227]/20 dark:hover:bg-[#A42227]/30 text-[#A42227] dark:text-[#A42227] text-xs font-semibold rounded-lg transition-colors cursor-pointer">
                            {t('team.storage_team_trash_clean')}
                        </button>
                    )}
                </div>

                {/* B. Personal Space */}
                <div className="rounded-xl border border-[#006540]/30 dark:border-[#006540]/50 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#006540] shadow-sm flex flex-col">
                    <div className="flex items-center gap-2 mb-2">
                        <User size={16} className="text-[#006540]" />
                        <h3 className="font-semibold text-[#006540] dark:text-[#006540]">B. {t('team.storage_personal_backup')}</h3>
                    </div>
                    <div className="flex-1 space-y-3">
                        <StatItem icon={<FileText size={14} />} label={t('team.storage_personal_markdown')} stats={personal_space.markdown} color="text-[#006540] dark:text-[#006540]" />
                        <StatItem icon={<Image size={14} />} label={t('team.storage_personal_media')} stats={personal_space.media} color="text-[#006540] dark:text-[#006540]" />
                    </div>
                </div>

                {/* C. Snapshots */}
                <div className="rounded-xl border border-[#EFE0CC]/50 dark:border-[#EFE0CC]/50 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#EFE0CC] shadow-sm flex flex-col">
                    <div className="flex items-center gap-2 mb-2">
                        <Clock size={16} className="text-[#B38F5A]" />
                        <h3 className="font-semibold text-[#B38F5A] dark:text-[#B38F5A]">C. {t('team.storage_snapshots_legacy')}</h3>
                    </div>
                    <div className="flex-1 space-y-3">
                        <StatItem icon={<Archive size={14} />} label={t('team.storage_snapshots_team')} stats={snapshots.team} color="text-[#B38F5A] dark:text-[#B38F5A]" />
                        <StatItem icon={<Archive size={14} />} label={t('team.storage_snapshots_personal')} stats={snapshots.personal} color="text-[#B38F5A] dark:text-[#B38F5A]" />
                    </div>
                    {snapshotsSize > 0 && (
                        <button onClick={() => handleOpenCleanup('snapshots')} className="w-full mt-4 py-2 bg-[#A42227]/10 hover:bg-[#A42227]/20 dark:bg-[#A42227]/20 dark:hover:bg-[#A42227]/30 text-[#A42227] dark:text-[#A42227] text-xs font-semibold rounded-lg transition-colors cursor-pointer">
                            {t('team.storage_snapshots_clean')}
                        </button>
                    )}
                </div>

            </div>

            {/* Legacy Cleanup */}
            {legacy_files.size_bytes > 0 && (
                <div className="rounded-xl border border-[#A42227] dark:border-[#A42227]/50 p-4 bg-[#A42227]/10 dark:bg-[#A42227]/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#A42227] dark:bg-[#A42227]/40 flex items-center justify-center text-[#A42227]">
                            <Archive size={16} />
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('team.storage_legacy')}</p>
                            <p className="text-xs text-[#545454]">{formatBytes(legacy_files.size_bytes)} · {legacy_files.count} {t('team.storage_type_other')}</p>
                        </div>
                    </div>
                    <button onClick={() => handleOpenCleanup('legacy_files')} className="px-4 py-1.5 bg-[#A42227]/10 hover:bg-[#A42227]/20 dark:bg-[#A42227]/20 dark:hover:bg-[#A42227]/30 text-[#A42227] dark:text-[#A42227] text-xs font-semibold rounded-lg transition-colors cursor-pointer">
                        {t('team.storage_cleanup_btn')}
                    </button>
                </div>
            )}

            {/* ── 按成员占用排行 ── */}
            {by_member.length > 0 && (
                <div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-900 shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-zinc-50 dark:bg-zinc-800/40 border-b border-[#C8C8C8] dark:border-zinc-800">
                        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                            {t('team.storage_member_usage_title')}
                        </h3>
                    </div>
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-800/50">
                        {(() => {
                            const maxBytes = Math.max(...by_member.map(m => m.total_bytes));
                            return by_member.map((member) => (
                                <MemberRow key={member.user_id} member={member} maxBytes={maxBytes} />
                            ));
                        })()}
                    </div>
                </div>
            )}

            {/* ── 清理弹窗 ── */}
            {cleanupTarget && (
                <CleanupPanel
                    target={cleanupTarget}
                    days={cleanupDays}
                    previewCount={previewCount}
                    previewSize={previewSize}
                    previewLoading={previewLoading}
                    executing={cleanupExecuting}
                    onDaysChange={handleDaysChange}
                    onExecute={handleExecuteCleanup}
                    onCancel={() => setCleanupTarget(null)}
                />
            )}
        </div>
    );
}

// ── Components ──

function LegendItem({ color, label, bytes }: { color: string, label: string, bytes: number }) {
    return (
        <div className="flex items-center gap-1.5 text-xs">
            <div className={cn('w-2 h-2 rounded-full', color)} />
            <span className="text-[#545454] dark:text-[#545454]">{label}</span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300 ml-1">{formatBytes(bytes)}</span>
        </div>
    );
}

function StatItem({ icon, label, stats, color }: { icon: React.ReactNode, label: string, stats: CategoryStats, color: string }) {
    return (
        <div className="flex flex-col p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-100 dark:border-zinc-800/60 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/80">
            <div className={cn("flex items-center gap-1.5 text-xs font-semibold mb-1", color)}>
                {icon}
                <span>{label}</span>
            </div>
            <div className="flex items-end justify-between mt-1">
                <span className="text-lg font-bold text-zinc-800 dark:text-zinc-100 font-mono tracking-tight">{formatBytes(stats.size_bytes)}</span>
                <span className="text-xs text-[#545454] font-medium">{stats.count} files</span>
            </div>
        </div>
    );
}

function MemberRow({ member, maxBytes }: { member: MemberUsage; maxBytes: number }) {
    const mdSize = member.markdown.size_bytes;
    const mediaSize = member.media.size_bytes;
    const totalPct = maxBytes > 0 ? (member.total_bytes / maxBytes) * 100 : 0;
    const mdInnerPct = member.total_bytes > 0 ? (mdSize / member.total_bytes) * 100 : 0;
    const mediaInnerPct = member.total_bytes > 0 ? (mediaSize / member.total_bytes) * 100 : 0;

    return (
        <div className="px-5 py-4 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
            {/* Avatar */}
            <div className="w-8 h-8 rounded-full bg-[#002FA7]/10 dark:bg-[#002FA7]/20 flex items-center justify-center text-xs font-bold text-[#002FA7] dark:text-blue-400 shrink-0 uppercase shadow-sm border border-[#002FA7]/30 dark:border-blue-500/35">
                {member.display_name.charAt(0)}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{member.display_name}</span>
                    <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 font-mono tracking-tight">{formatBytes(member.total_bytes)}</span>
                </div>

                {/* Bar chart (no quota background) */}
                <div className="flex items-center w-full">
                    <div
                        className="h-1.5 rounded-full overflow-hidden flex isolate"
                        style={{ width: `${Math.max(totalPct, 1)}%` }}
                    >
                        {mdSize > 0 && (
                            <div
                                className="h-full bg-[#006540] transition-all duration-500 first:rounded-l-full last:rounded-r-full"
                                style={{ width: `${mdInnerPct}%` }}
                                title={`MD: ${formatBytes(mdSize)}`}
                            />
                        )}
                        {mediaSize > 0 && (
                            <div
                                className="h-full bg-[#EFE0CC] transition-all duration-500 first:rounded-l-full last:rounded-r-full"
                                style={{ width: `${mediaInnerPct}%` }}
                                title={`Media: ${formatBytes(mediaSize)}`}
                            />
                        )}
                    </div>
                </div>

                {/* Type breakdown */}
                <div className="flex gap-4 text-[10px] text-[#545454] mt-1">
                    <span className="flex items-center gap-1"><FileText size={10} className="text-[#006540]" /> {formatBytes(member.markdown.size_bytes)} Markdown</span>
                    <span className="flex items-center gap-1"><Image size={10} className="text-[#B38F5A]" /> {formatBytes(member.media.size_bytes)} Media</span>
                </div>
            </div>
        </div>
    );
}

// ── Cleanup Panel ──

function CleanupPanel({
    target,
    days,
    previewCount,
    previewSize,
    previewLoading,
    executing,
    onDaysChange,
    onExecute,
    onCancel,
}: {
    target: CleanupTarget;
    days: number;
    previewCount: number;
    previewSize: number;
    previewLoading: boolean;
    executing: boolean;
    onDaysChange: (d: number) => void;
    onExecute: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const [inputValue, setInputValue] = useState(String(days));

    const titleMap: Record<string, string> = {
        snapshots: t('team.storage_cleanup_title_snapshots'),
        trash: t('team.storage_cleanup_title_trash'),
        legacy_files: t('team.storage_cleanup_title_legacy'),
    };
    const titleText = titleMap[target] ?? t('team.storage_cleanup_title_legacy');

    const skipDays = target === 'legacy_files';
    const borderColor = target === 'snapshots' ? 'border-[#EFE0CC] dark:border-[#EFE0CC]/60'
        : target === 'trash' ? 'border-[#A42227] dark:border-[#A42227]/60'
            : target === 'legacy_files' ? 'border-[#A42227] dark:border-[#A42227]/60'
                : 'border-[#A42227] dark:border-[#A42227]/60';
    const bgColor = target === 'snapshots' ? 'bg-[#EFE0CC] dark:bg-[#EFE0CC]/10'
        : target === 'trash' ? 'bg-[#A42227]/10 dark:bg-[#A42227]/10'
            : target === 'legacy_files' ? 'bg-[#A42227]/10 dark:bg-[#A42227]/10'
                : 'bg-[#A42227]/10 dark:bg-[#A42227]/10';

    return (
        <div className="fixed inset-0 z-100 flex items-center justify-center" onClick={onCancel}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity" />

            {/* Modal Card */}
            <div
                className={cn('relative w-full max-w-md mx-4 rounded-xl border p-6 space-y-5 shadow-2xl transition-all scale-100', borderColor, bgColor, 'bg-white dark:bg-zinc-900')}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b pb-3 border-black/5 dark:border-white/5">
                    <div className="flex items-center gap-2">
                        {target === 'trash' ? <Trash2 size={18} className="text-[#A42227]" /> : <Archive size={18} className={target === 'snapshots' ? 'text-[#B38F5A]' : 'text-[#A42227]'} />}
                        <p className="text-base font-bold text-zinc-800 dark:text-zinc-200">{titleText}</p>
                    </div>
                </div>

                {!skipDays && (
                    <div className="flex items-center justify-between gap-3 bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-black/5 dark:border-white/5">
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('team.storage_cleanup_keep_days')}</span>
                        <div className="flex items-center">
                            <input
                                type="number"
                                min={0}
                                max={365}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onBlur={() => {
                                    const val = parseInt(inputValue);
                                    if (!isNaN(val) && val >= 0) {
                                        onDaysChange(val);
                                    } else {
                                        setInputValue(String(days));
                                    }
                                }}
                                className="w-16 px-2 py-1 text-center text-sm font-semibold rounded box-border border-[#C8C8C8] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#002FA7]"
                            />
                            <span className="ml-2 text-sm text-[#545454] font-medium">{t('team.storage_cleanup_days')}</span>
                        </div>
                    </div>
                )}

                <div className="bg-white/80 dark:bg-zinc-900/80 rounded-lg p-5 border border-black/5 dark:border-white/5 shadow-inner">
                    <p className="text-sm text-[#545454] dark:text-[#545454] font-medium mb-3">{t('team.storage_cleanup_preview_title')}</p>
                    {previewLoading ? (
                        <div className="flex items-center text-[#545454] py-2">
                            <Loader2 size={16} className="animate-spin mr-2" />
                            <span className="text-sm">{t('team.storage_cleanup_calculating')}</span>
                        </div>
                    ) : (
                        <div className="flex items-end gap-3">
                            <span className="text-3xl font-black text-zinc-900 dark:text-zinc-100 font-mono tracking-tighter">
                                {formatBytes(previewSize)}
                            </span>
                            <span className="text-sm text-[#545454] font-medium mb-1 border-l border-[#C8C8C8] dark:border-zinc-700 pl-3">
                                {previewCount} {t('team.storage_cleanup_objects')}
                            </span>
                        </div>
                    )}
                </div>

                {/* Warning Text */}
                <div className="flex items-start gap-2 text-[#A42227] dark:text-[#A42227] bg-[#A42227]/10 dark:bg-[#A42227]/10 p-3 rounded-lg border border-[#A42227] dark:border-[#A42227]/30">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <p className="text-xs font-medium leading-relaxed">
                        {target === 'snapshots'
                            ? t('team.storage_cleanup_danger_snapshots')
                            : target === 'trash'
                                ? t('team.storage_cleanup_danger_trash')
                                : t('team.storage_cleanup_danger_legacy')}
                    </p>
                </div>

                <div className="flex gap-3 justify-end pt-2">
                    <button
                        onClick={onCancel}
                        disabled={executing}
                        className="px-4 py-2 text-sm font-semibold text-[#545454] dark:text-[#545454] bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
                    >
                        {t('team.storage_cleanup_cancel')}
                    </button>
                    <button
                        onClick={onExecute}
                        disabled={previewLoading || executing || previewCount === 0}
                        className={cn(
                            "px-6 py-2 text-sm font-bold rounded-lg transition-all cursor-pointer shadow-md",
                            target === 'snapshots' ? 'bg-[#A42227] hover:brightness-95 shadow-[#A42227]/20 text-white'
                                : target === 'trash' ? 'bg-[#A42227] hover:brightness-95 shadow-[#A42227]/20 text-white'
                                    : 'bg-[#A42227] hover:brightness-95 shadow-[#A42227]/20 text-white',
                            "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 hover:scale-[1.02]"
                        )}
                    >
                        {executing ? (
                            <span className="flex items-center gap-2">
                                <Loader2 size={14} className="animate-spin" />
                                {t('team.storage_cleanup_processing')}
                            </span>
                        ) : t('team.storage_cleanup_confirm')}
                    </button>
                </div>
            </div>
        </div>
    );
}
