// FolderPage — 统一的双空间目录管理页面
// 负责解析跨空间映射，并呈现：目录任务概览 + AI配置 + 团队目录面板

import { useState, useEffect, useCallback } from 'react';
import { Bot, ChevronDown, ChevronRight, CheckSquare, FileText, Loader2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/shared/utils/cn';
import { TeamDirPanel } from '@/features/team/TeamDirPanel';
import { taskService, type Task } from '@/features/kanban/taskService';
import { useSessionStore } from '@/stores/useSessionStore';
import { PARA_TEAM_TO_PERSONAL } from '@/features/sidebar/hooks/useTeamDirectoryMapping';

interface TeamDirectoryMappingEntry {
    directory_id?: string;
    local_path?: string;
    remote_path?: string;
    status?: string;
}

// 反向映射：个人 PARA 路径 → 团队 PARA 路径
const PARA_PERSONAL_TO_TEAM: Record<string, string> = Object.fromEntries(
    Object.entries(PARA_TEAM_TO_PERSONAL).map(([team, personal]) => [personal, team])
);

interface FolderAIConfig {
    provider_type: string;
    ollama_host: string;
    ollama_port: number;
    generation_model: string;
    embedding_model: string;
    online_api_key: string;
    online_base_url: string;
    online_model: string;
}

interface FolderPageProps {
    folderPath: string; // 在 personal 是绝对路径，在 team 是相对路径
    folderName: string;
    vaultPath: string;
    mode?: 'personal' | 'team';
    /** 团队目录的相对路径 (旧版遗留，现作为初始参考) */
    teamDirPath?: string;
    onClose?: () => void;
    onNavigateToNote?: (notePath: string) => void;
}

type ProviderChoice = 'local' | 'online';

const normalizeRelPath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');

interface ChildTaskSummary {
    path: string;
    name: string;
    todo: number;
    done: number;
    total: number;
}

function getTaskTitle(rawText: string): string {
    return rawText
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
        .replace(/👤\s*\S+/g, '')
        .replace(/@[\S]+/g, '')
        .replace(/[🚩#](High|Medium|Low|Med|高|中|低)/gi, '')
        .trim();
}

function getTaskNoteName(notePath: string): string {
    return notePath.split('/').pop()?.replace(/\.md$/, '') || notePath;
}

function sortTasks(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
        if (a.is_completed !== b.is_completed) {
            return a.is_completed ? 1 : -1;
        }
        if (a.due_date && b.due_date && a.due_date !== b.due_date) {
            return a.due_date.localeCompare(b.due_date);
        }
        if (a.due_date && !b.due_date) return -1;
        if (!a.due_date && b.due_date) return 1;
        return (b.updated_at || 0) - (a.updated_at || 0);
    });
}

function buildFolderTaskSections(allTasks: Task[], relPath: string): {
    currentDirTasks: Task[];
    childSummaries: ChildTaskSummary[];
    childTasksByPath: Record<string, Task[]>;
} {
    const directTasks: Task[] = [];
    const childSummaryMap = new Map<string, ChildTaskSummary>();
    const childTasksMap = new Map<string, Task[]>();

    for (const task of allTasks) {
        const taskPath = normalizeRelPath(task.note_path);
        if (!taskPath.startsWith(`${relPath}/`)) continue;

        const suffix = taskPath.slice(relPath.length + 1);
        if (!suffix) continue;

        const segments = suffix.split('/');
        if (segments.length === 1) {
            directTasks.push(task);
            continue;
        }

        const childName = segments[0];
        const childPath = `${relPath}/${childName}`;
        const summary = childSummaryMap.get(childPath) || {
            path: childPath,
            name: childName,
            todo: 0,
            done: 0,
            total: 0,
        };
        summary.total += 1;
        if (task.is_completed) {
            summary.done += 1;
        } else {
            summary.todo += 1;
        }
        childSummaryMap.set(childPath, summary);

        const childTasks = childTasksMap.get(childPath) || [];
        childTasks.push(task);
        childTasksMap.set(childPath, childTasks);
    }

    return {
        currentDirTasks: sortTasks(directTasks),
        childSummaries: Array.from(childSummaryMap.values()).sort((a, b) => {
            if (b.todo !== a.todo) return b.todo - a.todo;
            if (b.total !== a.total) return b.total - a.total;
            return a.name.localeCompare(b.name);
        }),
        childTasksByPath: Object.fromEntries(
            Array.from(childTasksMap.entries()).map(([path, tasks]) => [path, sortTasks(tasks)])
        ),
    };
}

export function FolderPage({
    folderPath,
    folderName,
    vaultPath,
    mode = 'personal',
    teamDirPath,
    onClose: _onClose,
    onNavigateToNote,
}: FolderPageProps) {
    const { t } = useTranslation();
    const isPersonal = mode === 'personal';

    // \ud83d\udee1\ufe0f Windows \u517c\u5bb9\uff1a\u7edf\u4e00\u6b63\u659c\u6760\u518d\u505a\u8def\u5f84\u622a\u53d6
    const initialRelativePath = isPersonal
        ? (() => {
            const normFolder = folderPath.replace(/\\/g, '/');
            const normVault = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
            return normFolder.startsWith(normVault + '/')
                ? normFolder.slice(normVault.length + 1)
                : normFolder;
        })()
        : (teamDirPath || folderPath);

    const [localRelPath, setLocalRelPath] = useState<string | null>(null);
    const [teamRelPath, setTeamRelPath] = useState<string | null>(null);
    const [teamDirectoryId, setTeamDirectoryId] = useState<string | null>(null);
    const [providerChoice, setProviderChoice] = useState<ProviderChoice>('local');
    const [resolving, setResolving] = useState(true);
    
    // 是否加入了团队（具有 Team Vault ID）
    const hasTeamVault = !!useSessionStore.getState().teamVaultId;

    // ── 目录任务概览 ──
    const [taskBoardLoading, setTaskBoardLoading] = useState(false);
    const [currentDirTasks, setCurrentDirTasks] = useState<Task[]>([]);
    const [childSummaries, setChildSummaries] = useState<ChildTaskSummary[]>([]);
    const [childTasksByPath, setChildTasksByPath] = useState<Record<string, Task[]>>({});
    const [expandedChildPath, setExpandedChildPath] = useState<string | null>(null);

    // 使目录空间映射能够响应 Promote 后立即重新解析
    const [refreshKey, setRefreshKey] = useState(0);
    useEffect(() => {
        const handleRefresh = () => setRefreshKey(prev => prev + 1);
        window.addEventListener('team:directories-changed', handleRefresh);
        return () => window.removeEventListener('team:directories-changed', handleRefresh);
    }, []);

    // 解析跨空间映射
    useEffect(() => {
        let isMounted = true;
        (async () => {
            setResolving(true);
            try {
                const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
                let foundLocal = mode === 'personal' ? initialRelativePath : null;
                let foundTeam = mode === 'team' ? initialRelativePath : null;
                let foundTeamDirectoryId: string | null = null;

                try {
                    let v3Mappings: TeamDirectoryMappingEntry[] = [];
                    try {
                        const rawV3 = await readTextFile(`${vaultPath}/.slash/team_directory_mappings.json`);
                        const dataV3 = JSON.parse(rawV3);
                        for (const team of Object.values(dataV3?.teams || {}) as Array<any>) {
                            for (const entry of Object.values(team?.directories || {}) as TeamDirectoryMappingEntry[]) {
                                if (entry?.status === 'active' && entry.local_path && entry.remote_path) {
                                    v3Mappings.push(entry);
                                }
                            }
                        }
                    } catch {
                        // v3 mapping is optional for legacy vaults.
                    }

                    const normalizedInitialPath = normalizeRelPath(initialRelativePath);

                    for (const entry of v3Mappings) {
                        const localPath = entry.local_path ? normalizeRelPath(entry.local_path) : null;
                        const remotePath = entry.remote_path ? normalizeRelPath(entry.remote_path) : null;
                        if (!localPath || !remotePath) continue;
                        if (mode === 'personal') {
                            if (localPath === normalizedInitialPath) {
                                foundTeam = remotePath;
                                foundTeamDirectoryId = entry.directory_id || null;
                                break;
                            }
                        } else {
                            if (remotePath === normalizedInitialPath) {
                                foundLocal = localPath;
                                foundTeamDirectoryId = entry.directory_id || null;
                                break;
                            }
                        }
                    }

                    if (!foundTeamDirectoryId) {
                        for (const entry of v3Mappings) {
                            const localPath = entry.local_path ? normalizeRelPath(entry.local_path) : null;
                            const remotePath = entry.remote_path ? normalizeRelPath(entry.remote_path) : null;
                            if (!localPath || !remotePath) continue;
                            if (mode === 'personal') {
                                if (!foundTeam && normalizedInitialPath.startsWith(`${localPath}/`)) {
                                    const suffix = normalizedInitialPath.slice(localPath.length);
                                    foundTeam = `${remotePath}${suffix}`;
                                    // 子目录可以继承父 mapping 的路径关系，但不能继承父 directory_id。
                                    foundTeamDirectoryId = null;
                                    break;
                                }
                            } else if (!foundLocal && normalizedInitialPath.startsWith(`${remotePath}/`)) {
                                const suffix = normalizedInitialPath.slice(remotePath.length);
                                foundLocal = `${localPath}${suffix}`;
                                // 子目录可以继承父 mapping 的路径关系，但不能继承父 directory_id。
                                foundTeamDirectoryId = null;
                                break;
                            }
                        }
                    }

                    const raw = await readTextFile(`${vaultPath}/.slash/team_path_mappings.json`);
                    const data = JSON.parse(raw);

                    let allMappings: Record<string, string> = {};
                    if (data.teams) {
                        for (const teamId of Object.keys(data.teams)) {
                            Object.assign(allMappings, data.teams[teamId]);
                        }
                    } else if (data.mappings) {
                        allMappings = data.mappings;
                    } else {
                        allMappings = data;
                    }

                    if (mode === 'personal') {
                        // 以个人为起点，查找有无映射到团队 (source -> target)
                        for (const [source, target] of Object.entries(allMappings)) {
                            if (source === initialRelativePath) {
                                foundTeam = target;
                                break;
                            }
                            if (initialRelativePath.startsWith(source + '/')) {
                                const suffix = initialRelativePath.slice(source.length);
                                foundTeam = target + suffix;
                                break;
                            }
                        }
                    } else {
                        // 以团队为起点，查找有无映射到个人 (source -> target)
                        for (const [source, target] of Object.entries(allMappings)) {
                            if (target === initialRelativePath) {
                                foundLocal = source;
                                break;
                            }
                            if (initialRelativePath.startsWith(target + '/')) {
                                const suffix = initialRelativePath.slice(target.length);
                                foundLocal = source + suffix;
                                break;
                            }
                        }
                    }
                } catch {
                    // 没有映射文件或解析失败
                }

                // PARA 根目录双向映射 Fallback（仅限 PARA 根目录精确匹配）
                // ⚠️ 子目录不走 fallback 推断！必须依赖 team_path_mappings.json 中的显式记录。
                // 否则同名子目录（如删除后重建的 A1）会被强行接管前朝的团队身份与遗产。
                if (mode === 'personal' && !foundTeam) {
                    // 个人 → 团队：如 01_Projects → 01_PROJECTS（仅根级精确匹配）
                    for (const [personal, team] of Object.entries(PARA_PERSONAL_TO_TEAM)) {
                        if (initialRelativePath === personal) {
                            foundTeam = team;
                            break;
                        }
                    }
                }
                if (mode === 'team' && !foundLocal) {
                    // 团队 → 个人：如 01_PROJECTS → 01_Projects
                    for (const [team, personal] of Object.entries(PARA_TEAM_TO_PERSONAL)) {
                        if (initialRelativePath === team || initialRelativePath.startsWith(team + '/')) {
                            const suffix = initialRelativePath === team ? '' : initialRelativePath.slice(team.length);
                            const candidate = personal + suffix;
                            const localDir = `${vaultPath}/${candidate}`;
                            if (await exists(localDir)) {
                                foundLocal = candidate;
                            }
                            break;
                        }
                    }
                }

                if (isMounted) {
                    setLocalRelPath(foundLocal);
                    setTeamRelPath(foundTeam);
                    setTeamDirectoryId(foundTeam ? foundTeamDirectoryId : null);
                }
            } catch (e) {
                console.error('[FolderPage] Failed to resolve path mappings:', e);
            } finally {
                if (isMounted) setResolving(false);
            }
        })();
        return () => { isMounted = false; };
    }, [initialRelativePath, mode, vaultPath, refreshKey]);

    const resolvedLocalAbsPath = localRelPath ? `${vaultPath}/${localRelPath}` : folderPath;

    // ── 加载目录任务概览 ──
    useEffect(() => {
        if (!localRelPath) {
            setCurrentDirTasks([]);
            setChildSummaries([]);
            setChildTasksByPath({});
            setExpandedChildPath(null);
            return;
        }
        const relPath = normalizeRelPath(localRelPath);
        let isMounted = true;
        setTaskBoardLoading(true);
        (async () => {
            try {
                const allTasks = await taskService.getTasks();
                const {
                    currentDirTasks: nextCurrentDirTasks,
                    childSummaries: nextChildSummaries,
                    childTasksByPath: nextChildTasksByPath,
                } = buildFolderTaskSections(allTasks, relPath);

                if (!isMounted) return;
                setCurrentDirTasks(nextCurrentDirTasks);
                setChildSummaries(nextChildSummaries);
                setChildTasksByPath(nextChildTasksByPath);
                setExpandedChildPath(prev => (prev && nextChildTasksByPath[prev] ? prev : null));
            } catch (e) {
                console.error('[FolderPage] Failed to load folder tasks:', e);
                if (!isMounted) return;
                setCurrentDirTasks([]);
                setChildSummaries([]);
                setChildTasksByPath({});
                setExpandedChildPath(null);
            } finally {
                if (isMounted) setTaskBoardLoading(false);
            }
        })();
        const handleRefresh = () => {
            setTaskBoardLoading(true);
            taskService.getTasks()
                .then(allTasks => {
                    const {
                        currentDirTasks: nextCurrentDirTasks,
                        childSummaries: nextChildSummaries,
                        childTasksByPath: nextChildTasksByPath,
                    } = buildFolderTaskSections(allTasks, relPath);

                    if (!isMounted) return;
                    setCurrentDirTasks(nextCurrentDirTasks);
                    setChildSummaries(nextChildSummaries);
                    setChildTasksByPath(nextChildTasksByPath);
                    setExpandedChildPath(prev => (prev && nextChildTasksByPath[prev] ? prev : null));
                })
                .catch(e => {
                    console.error('[FolderPage] Failed to refresh folder tasks:', e);
                    if (!isMounted) return;
                    setCurrentDirTasks([]);
                    setChildSummaries([]);
                    setChildTasksByPath({});
                    setExpandedChildPath(null);
                })
                .finally(() => {
                    if (isMounted) setTaskBoardLoading(false);
                });
        };

        window.addEventListener('sync:completed', handleRefresh);
        return () => {
            isMounted = false;
            window.removeEventListener('sync:completed', handleRefresh);
        };
    }, [localRelPath]);

    // Load current folder config
    const loadConfig = useCallback(async () => {
        if (!localRelPath) return; // 如果找不到本地映射，无法读取AI配置
        try {
            const folder = await invoke<FolderAIConfig>('get_folder_ai_config', { folderPath: resolvedLocalAbsPath });
            setProviderChoice(folder.provider_type === 'online' ? 'online' : 'local');
        } catch (e) {
            console.error('[FolderPage] Failed to load AI config:', e);
        }
    }, [resolvedLocalAbsPath, localRelPath]);

    useEffect(() => {
        if (!resolving) {
            loadConfig();
        }
    }, [loadConfig, resolving]);

    const handleProviderChange = async (val: ProviderChoice) => {
        if (!localRelPath) return;
        setProviderChoice(val);
        try {
            await invoke('save_folder_ai_config', {
                folderPath: resolvedLocalAbsPath,
                provider: val,
                model: null,
            });
        } catch (e) {
            console.error('[FolderPage] Failed to save AI config:', e);
        }
    };

    const hasCurrentDirTasks = currentDirTasks.length > 0;
    const hasChildSummary = childSummaries.length > 0;
    const showTaskBoard = !!localRelPath && (taskBoardLoading || hasCurrentDirTasks || hasChildSummary);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-zinc-900">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
                <div>
                    <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                        {folderName}
                    </h1>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {teamRelPath || localRelPath || initialRelativePath}
                    </p>
                </div>
                <div id="folder-page-header-actions" className="flex items-center gap-3">
                    {/* AI Config switch (个人空间) */}
                    {isPersonal && localRelPath && !resolving && (
                        <div className="flex items-center gap-2 hover:bg-zinc-100/50 dark:hover:bg-white/5 pl-3 pr-2 py-1.5 rounded-full transition-colors" title={t('folder.inherit_hint', '子文件夹无配置时将继承父文件夹的配置')}>
                            <Bot size={14} className={cn(providerChoice === 'online' ? 'text-indigo-500 dark:text-blue-400' : 'text-zinc-400')} />
                            <span className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
                                {providerChoice === 'online' ? 'Online' : 'Local'}
                            </span>
                            <button
                                onClick={() => handleProviderChange(providerChoice === 'online' ? 'local' : 'online')}
                                className={cn(
                                    "relative w-9 h-5 rounded-full transition-colors outline-none",
                                    providerChoice === 'online' ? "bg-indigo-500 dark:bg-indigo-600" : "bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600"
                                )}
                            >
                                <span
                                    className={cn(
                                        "absolute top-[2px] left-[2px] w-4 h-4 bg-white rounded-full transition-transform duration-300 shadow-sm",
                                        providerChoice === 'online' ? "translate-x-4" : "translate-x-0"
                                    )}
                                />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {resolving ? (
                    <div className="flex items-center justify-center h-32 text-zinc-400">
                        <Loader2 size={20} className="animate-spin mr-2" />
                        {t('common.loading', 'Loading...')}
                    </div>
                ) : (
                    <div className="flex flex-col">
                        {/* 1. Folder Task Board */}
                        {showTaskBoard && (
                            <div className="border-b border-zinc-200 dark:border-zinc-700">
                                <div className="px-6 py-5 space-y-5">
                                    <div className="flex items-center gap-2">
                                        <CheckSquare size={16} className="text-zinc-500 dark:text-zinc-400" />
                                        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t('folder.task_board_title', '目录任务看板')}
                                        </h2>
                                    </div>

                                    {taskBoardLoading && (
                                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                                            <Loader2 size={16} className="animate-spin" />
                                            {t('common.loading', 'Loading...')}
                                        </div>
                                    )}

                                    {!taskBoardLoading && hasChildSummary && (
                                        <div className="space-y-3">
                                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
                                                <ChevronRight size={12} />
                                                <span>{t('folder.child_task_summary', '子目录任务清单')}</span>
                                            </div>
                                            <div className="space-y-2">
                                                {childSummaries.map(summary => {
                                                    const expanded = expandedChildPath === summary.path;
                                                    const childTasks = childTasksByPath[summary.path] || [];
                                                    return (
                                                        <div key={summary.path} className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900">
                                                            <button
                                                                onClick={() => setExpandedChildPath(prev => prev === summary.path ? null : summary.path)}
                                                                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                                                            >
                                                                {expanded ? (
                                                                    <ChevronDown size={14} className="shrink-0 text-zinc-400" />
                                                                ) : (
                                                                    <ChevronRight size={14} className="shrink-0 text-zinc-400" />
                                                                )}
                                                                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 text-left flex-1 min-w-0 truncate">
                                                                    {summary.name}
                                                                </span>
                                                                <div className="flex items-center gap-3 shrink-0 text-xs">
                                                                    <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
                                                                        <Square size={12} />
                                                                        {summary.todo}
                                                                    </span>
                                                                    <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                                                                        <CheckSquare size={12} />
                                                                        {summary.done}
                                                                    </span>
                                                                </div>
                                                            </button>

                                                            {expanded && (
                                                                <div className="border-t border-zinc-200 dark:border-zinc-700 px-4 py-3 bg-zinc-50/70 dark:bg-zinc-800/30 space-y-2">
                                                                    {childTasks.length > 0 ? childTasks.map(task => (
                                                                        <button
                                                                            key={`${task.note_path}:${task.line_number}:${task.raw_text}`}
                                                                            onClick={() => onNavigateToNote?.(task.note_path)}
                                                                            className="w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
                                                                        >
                                                                            <div className="flex items-start gap-2">
                                                                                {task.is_completed ? (
                                                                                    <CheckSquare size={14} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                                                                                ) : (
                                                                                    <Square size={14} className="mt-0.5 shrink-0 text-zinc-400" />
                                                                                )}
                                                                                <div className="min-w-0 flex-1">
                                                                                    <div className={cn(
                                                                                        "text-sm",
                                                                                        task.is_completed
                                                                                            ? "text-zinc-400 dark:text-zinc-500 line-through"
                                                                                            : "text-zinc-800 dark:text-zinc-100"
                                                                                    )}>
                                                                                        {getTaskTitle(task.raw_text) || task.raw_text}
                                                                                    </div>
                                                                                    <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                                                                                        <FileText size={12} />
                                                                                        <span className="truncate">{getTaskNoteName(task.note_path)}</span>
                                                                                        {task.due_date && <span>· {task.due_date}</span>}
                                                                                    </div>
                                                                                </div>
                                                                            </div>
                                                                        </button>
                                                                    )) : (
                                                                        <div className="text-sm text-zinc-400 py-2">
                                                                            {t('folder.no_tasks_in_child', '该子目录下暂无任务')}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {!taskBoardLoading && hasCurrentDirTasks && (
                                        <div className="space-y-3">
                                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
                                                <FileText size={12} />
                                                <span>{t('folder.current_dir_tasks', '当前目录任务清单')}</span>
                                            </div>
                                            <div className="space-y-2">
                                                {currentDirTasks.map(task => (
                                                    <button
                                                        key={`${task.note_path}:${task.line_number}:${task.raw_text}`}
                                                        onClick={() => onNavigateToNote?.(task.note_path)}
                                                        className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
                                                    >
                                                        <div className="flex items-start gap-2">
                                                            {task.is_completed ? (
                                                                <CheckSquare size={14} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                                                            ) : (
                                                                <Square size={14} className="mt-0.5 shrink-0 text-zinc-400" />
                                                            )}
                                                            <div className="min-w-0 flex-1">
                                                                <div className={cn(
                                                                    "text-sm",
                                                                    task.is_completed
                                                                        ? "text-zinc-400 dark:text-zinc-500 line-through"
                                                                        : "text-zinc-800 dark:text-zinc-100"
                                                                )}>
                                                                    {getTaskTitle(task.raw_text) || task.raw_text}
                                                                </div>
                                                                <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                                                                    <FileText size={12} />
                                                                    <span className="truncate">{getTaskNoteName(task.note_path)}</span>
                                                                    {task.due_date && <span>· {task.due_date}</span>}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* 2. Team Collaboration (如果有团队映射) */}
                        {teamRelPath && hasTeamVault && (
                            <div className="p-6">
                                <TeamDirPanel
                                    directoryPath={teamRelPath}
                                    directoryId={teamDirectoryId}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default FolderPage;
