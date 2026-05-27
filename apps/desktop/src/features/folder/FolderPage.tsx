// FolderPage — 统一的双空间目录管理页面
// 负责解析跨空间映射，并呈现：任务统计 + AI配置 + 团队目录面板

import { useState, useEffect, useCallback } from 'react';
import { Bot, ChevronRight, Loader2, CheckSquare, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/shared/utils/cn';
import { ProjectKanban } from '@/features/kanban/ProjectKanban';
import { TeamDirPanel } from '@/features/team/TeamDirPanel';
import { taskService } from '@/features/kanban/taskService';
import { useSessionStore } from '@/stores/useSessionStore';
import { PARA_TEAM_TO_PERSONAL } from '@/features/sidebar/hooks/useTeamDirectoryMapping';

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
    const [providerChoice, setProviderChoice] = useState<ProviderChoice>('local');
    const [resolving, setResolving] = useState(true);
    
    // 是否加入了团队（具有 Team Vault ID）
    const hasTeamVault = !!useSessionStore.getState().teamVaultId;

    // ── 任务统计 ──
    const [taskStats, setTaskStats] = useState<{ todo: number; done: number; total: number }>({ todo: 0, done: 0, total: 0 });
    const [kanbanExpanded, setKanbanExpanded] = useState(true);

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

                try {
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
                }
            } catch (e) {
                console.error('[FolderPage] Failed to resolve path mappings:', e);
            } finally {
                if (isMounted) setResolving(false);
            }
        })();
        return () => { isMounted = false; };
    }, [initialRelativePath, mode, vaultPath, refreshKey]);

    const isProjectFolder = localRelPath ? (localRelPath === '01_Projects' || localRelPath.startsWith('01_Projects/')) : false;
    const resolvedLocalAbsPath = localRelPath ? `${vaultPath}/${localRelPath}` : folderPath;

    // ── 加载任务统计 ──
    useEffect(() => {
        if (!isProjectFolder || !localRelPath) return;
        const relPath = localRelPath;
        (async () => {
            try {
                const allTasks = await taskService.getTasks();
                const projectTasks = allTasks.filter(task => task.note_path.startsWith(relPath));
                const todo = projectTasks.filter(t => !t.is_completed).length;
                const done = projectTasks.filter(t => t.is_completed).length;
                setTaskStats({ todo, done, total: projectTasks.length });
            } catch (e) {
                console.error('[FolderPage] Failed to load task stats:', e);
            }
        })();
    }, [isProjectFolder, localRelPath]);

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

    const donePercent = taskStats.total > 0 ? Math.round((taskStats.done / taskStats.total) * 100) : 0;

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
                            <Bot size={14} className={cn(providerChoice === 'online' ? 'text-indigo-500' : 'text-zinc-400')} />
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
                        {/* 1. Task Stats Card (可折叠，点击展开看板) */}
                        {isProjectFolder && localRelPath && (
                            <div className="border-b border-zinc-200 dark:border-zinc-700">
                                <button
                                    onClick={() => setKanbanExpanded(v => !v)}
                                    className="w-full px-6 py-4 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                                >
                                    <ChevronRight size={14} className={cn('shrink-0 transition-transform text-zinc-400', kanbanExpanded && 'rotate-90')} />
                                    
                                    {/* 统计数据 */}
                                    <div className="flex items-center gap-4 flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                            <Square size={14} className="text-zinc-500" />
                                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                                {t('kanban.todo')}
                                            </span>
                                            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                                {taskStats.todo}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <CheckSquare size={14} className="text-green-500" />
                                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                                {t('kanban.done')}
                                            </span>
                                            <span className="text-sm font-semibold text-green-600 dark:text-green-400">
                                                {taskStats.done}
                                            </span>
                                        </div>
                                    </div>

                                    {/* 进度条 */}
                                    {taskStats.total > 0 && (
                                        <div className="flex items-center gap-2 shrink-0">
                                            <div className="w-24 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-green-500 rounded-full transition-all duration-500"
                                                    style={{ width: `${donePercent}%` }}
                                                />
                                            </div>
                                            <span className="text-xs text-zinc-400 w-8 text-right">{donePercent}%</span>
                                        </div>
                                    )}
                                </button>

                                {/* 展开的看板 */}
                                {kanbanExpanded && (
                                    <ProjectKanban
                                        projectPath={`${vaultPath}/${localRelPath}`}
                                        projectName={folderName}
                                        vaultPath={vaultPath}
                                        onNavigateToNote={onNavigateToNote}
                                    />
                                )}
                            </div>
                        )}

                        {/* 2. Team Collaboration (如果有团队映射) */}
                        {teamRelPath && hasTeamVault && (
                            <div className="p-6">
                                <TeamDirPanel
                                    directoryPath={teamRelPath}
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
