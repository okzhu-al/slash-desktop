/**
 * NoteTaskPanel - Display tasks from current note
 * 
 * Features:
 * - Shows tasks extracted from the current note (from tasks table)
 * - Click task card to scroll to task position in editor
 * - Toggle completion status (syncs with note content)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ListChecks, Loader2, CheckCircle2, Circle, Calendar, User, Flag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/shared/utils/cn';
import { syncService } from '@/services/SyncService';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';
import { extractContentHash } from '@/shared/utils/taskHash';
import { useSessionStore } from '@/stores/useSessionStore';

// Removed PARA_MAP as it's no longer used

interface Task {
    id: number;
    note_path: string;
    line_number: number;
    raw_text: string;
    is_completed: boolean;
    due_date: string | null;
    assignee: string | null;
    priority: string | null;
    created_at: number | null;
    updated_at: number | null;
}

interface NoteTaskPanelProps {
    notePath: string | null;
    markdownContent?: string | null;
    projectPath?: string | null;
}

interface EditorTasksUpdatedDetail {
    notePath: string;
    tasks: Task[];
}

/**
 * 从 markdown 内容中解析任务项
 * 匹配 `- [ ] text` 和 `- [x] text` 格式
 */
function parseTasksFromMarkdown(content: string): Task[] {
    const lines = content.split('\n');
    const tasks: Task[] = [];
    const taskRegex = /^(\s*)-\s+\[([ xX])\]\s+(.+)$/;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(taskRegex);
        if (match) {
            const rawText = match[3].trim();
            const isCompleted = match[2].toLowerCase() === 'x';

            // 解析可选的元数据标记
            let dueDate: string | null = null;
            let assignee: string | null = null;
            let priority: string | null = null;

            const dueDateMatch = rawText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
            if (dueDateMatch) dueDate = dueDateMatch[1];

            const assigneeMatch = rawText.match(/👤\s*(\S+)/);
            if (assigneeMatch) assignee = assigneeMatch[1];

            const priorityMatch = rawText.match(/🔴|⚠️|🟢|#high|#medium|#low/i);
            if (priorityMatch) {
                const p = priorityMatch[0].toLowerCase();
                if (p === '🔴' || p === '#high') priority = 'high';
                else if (p === '⚠️' || p === '#medium') priority = 'medium';
                else if (p === '🟢' || p === '#low') priority = 'low';
            }

            tasks.push({
                id: i + 1, // 使用行号作为伪 ID
                note_path: '',
                line_number: i + 1,
                raw_text: rawText,
                is_completed: isCompleted,
                due_date: dueDate,
                assignee,
                priority,
                created_at: null,
                updated_at: null,
            });
        }
    }
    return tasks;
}

export const NoteTaskPanel = ({ notePath, markdownContent, projectPath }: NoteTaskPanelProps) => {
    const { t } = useTranslation();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(false);
    const lastNotePathRef = useRef<string | null>(null);
    const liveTaskSnapshotsRef = useRef<Map<string, Task[]>>(new Map());

    // 团队查看模式：从 markdown 内容实时解析任务
    const isTeamViewer = !!(notePath?.startsWith('__team__/') && markdownContent);

    const getLiveSnapshot = useCallback((path: string | null) => {
        if (!path) return null;
        return liveTaskSnapshotsRef.current.get(path) ?? null;
    }, []);

    // Fetch tasks when note changes
    useEffect(() => {
        if (!notePath) {
            if (projectPath) {
                setLoading(true);
                invoke<Task[]>('get_tasks')
                    .then(result => {
                        const projectTasks = result.filter(task =>
                            task.note_path.startsWith(projectPath)
                        );
                        setTasks(projectTasks);
                    })
                    .catch(() => setTasks([]))
                    .finally(() => setLoading(false));
            } else {
                setTasks([]);
            }
            lastNotePathRef.current = null;
            return;
        }

        // Only fetch if note changed
        if (notePath === lastNotePathRef.current) {
            return;
        }

        lastNotePathRef.current = notePath;

        // 团队查看模式：直接从 markdown 解析
        if (isTeamViewer) {
            setTasks(parseTasksFromMarkdown(markdownContent!));
            return;
        }

        const liveSnapshot = getLiveSnapshot(notePath);
        if (liveSnapshot) {
            setTasks(liveSnapshot);
            setLoading(false);
        } else {
            setLoading(true);
        }

        // 虚拟团队路径不走磁盘扫描，直接查询已有任务
        if (notePath.startsWith('__team__/')) {
            invoke<Task[]>('get_note_tasks', { notePath })
                .then(result => setTasks(getLiveSnapshot(notePath) ?? result))
                .catch(() => setTasks([]))
                .finally(() => setLoading(false));
            return;
        }

        // First scan note for tasks, then fetch from DB
        invoke<Task[]>('scan_note_tasks', { notePath })
            .then(scannedTasks => {
                // Use scanned tasks directly (they are already stored in DB)
                setTasks(getLiveSnapshot(notePath) ?? scannedTasks);
            })
            .catch(e => {
                console.error('Failed to scan tasks:', e);
                // Fallback: try to get existing tasks from DB
                return invoke<Task[]>('get_note_tasks', { notePath })
                    .then(result => setTasks(getLiveSnapshot(notePath) ?? result))
                    .catch(() => setTasks([]));
            })
            .finally(() => {
                setLoading(false);
            });
    }, [notePath, projectPath, isTeamViewer, markdownContent, getLiveSnapshot]);

    // Listen for live task snapshots from the active editor and persisted task updates.
    useEffect(() => {
        if (!notePath) {
            // 项目模式下也监听保存和同步事件来刷新任务列表
            if (projectPath) {
                const mergeLiveProjectTasks = (baseTasks: Task[]) => {
                    const liveSnapshots = liveTaskSnapshotsRef.current;
                    const tasksWithoutLiveNotes = baseTasks.filter(task => !liveSnapshots.has(task.note_path));
                    const liveTasks: Task[] = [];

                    liveSnapshots.forEach((snapshot, snapshotNotePath) => {
                        if (snapshotNotePath.startsWith(projectPath)) {
                            liveTasks.push(...snapshot);
                        }
                    });

                    return [...tasksWithoutLiveNotes, ...liveTasks];
                };

                const handleProjectTasksUpdate = () => {
                    invoke<Task[]>('get_tasks')
                        .then(result => {
                            const projectTasks = result.filter(task =>
                                task.note_path.startsWith(projectPath)
                            );
                            setTasks(mergeLiveProjectTasks(projectTasks));
                        })
                        .catch(console.error);
                };

                const handleEditorTasksUpdated = (e: Event) => {
                    const detail = (e as CustomEvent<EditorTasksUpdatedDetail>).detail;
                    if (!detail?.notePath || !Array.isArray(detail.tasks)) return;
                    if (!detail.notePath.startsWith(projectPath)) return;

                    liveTaskSnapshotsRef.current.set(detail.notePath, detail.tasks);
                    setTasks(prev => mergeLiveProjectTasks(prev));
                    setLoading(false);
                };

                window.addEventListener('slash:note-saved', handleProjectTasksUpdate);
                window.addEventListener('sync:completed', handleProjectTasksUpdate);
                window.addEventListener('slash:editor-tasks-updated', handleEditorTasksUpdated);
                window.dispatchEvent(new CustomEvent('slash:request-editor-tasks'));
                return () => {
                    window.removeEventListener('slash:note-saved', handleProjectTasksUpdate);
                    window.removeEventListener('sync:completed', handleProjectTasksUpdate);
                    window.removeEventListener('slash:editor-tasks-updated', handleEditorTasksUpdated);
                };
            }
            return;
        }

        const handleTaskUpdate = () => {
            if (notePath.startsWith('__team__/')) {
                invoke<Task[]>('get_note_tasks', { notePath }).then(setTasks).catch(console.error);
                return;
            }
            // Re-scan tasks when note content changes
            invoke<Task[]>('scan_note_tasks', { notePath })
                .then(setTasks)
                .catch(console.error);
        };

        const handleEditorTasksUpdated = (e: Event) => {
            const detail = (e as CustomEvent<EditorTasksUpdatedDetail>).detail;
            if (!detail?.notePath || !Array.isArray(detail.tasks)) return;
            if (detail.notePath !== notePath) return;

            liveTaskSnapshotsRef.current.set(detail.notePath, detail.tasks);
            setTasks(detail.tasks);
            setLoading(false);
        };

        const handleRemoteToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const parsedNote = parseTeamNoteId(notePath);
            if (!detail || (detail.notePath !== notePath && (!parsedNote.fileId || detail.fileId !== parsedNote.fileId))) return;

            setTasks(prev => prev.map(t => {
                // Match by line number and text to ensure we modify the right task when IDs are volatile
                if (t.raw_text.trim() === detail.rawText.trim() && t.line_number === detail.lineNumber) {
                    return { ...t, is_completed: detail.isCompleted };
                }
                return t;
            }));
        };

        // Listen for note save events
        window.addEventListener('slash:note-saved', handleTaskUpdate);
        window.addEventListener('sync:completed', handleTaskUpdate);
        window.addEventListener('slash:remote-task-toggle', handleRemoteToggle);
        window.addEventListener('slash:editor-tasks-updated', handleEditorTasksUpdated);
        window.dispatchEvent(new CustomEvent('slash:request-editor-tasks'));

        return () => {
            window.removeEventListener('slash:note-saved', handleTaskUpdate);
            window.removeEventListener('sync:completed', handleTaskUpdate);
            window.removeEventListener('slash:remote-task-toggle', handleRemoteToggle);
            window.removeEventListener('slash:editor-tasks-updated', handleEditorTasksUpdated);
        };
    }, [notePath, projectPath]);

    // Toggle task completion
    const handleToggleComplete = useCallback(async (task: Task, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation(); // Don't trigger card click if click was from toggle button itself
        }
        
        const targetNotePath = task.note_path || notePath;
        const activeEditorNotePath = notePath || targetNotePath;
        if (!targetNotePath) return;

        // Check team space read-only rules
        const isTaskTeamNote = targetNotePath.startsWith('__team__/');
        if (isTaskTeamNote) {
            toast.error(t('sidebar.team_readonly'));
            return;
        }

        // Use line_number as fallback identifier if id is null
        const taskId = task.id;
        if (!taskId) {
            console.warn('Task has no ID, cannot update via API');
            return;
        }

        const newStatus = !task.is_completed;
        let dispatchedVisualToggle = false;
        console.debug('📋 [NoteTaskPanel] Toggling task:', taskId, '->', newStatus);

        try {
            const dispatchVisualToggle = () => {
                if (!activeEditorNotePath || dispatchedVisualToggle) return;
                window.dispatchEvent(new CustomEvent('slash:toggle-task', {
                    detail: {
                        notePath: activeEditorNotePath,
                        lineNumber: task.line_number,
                        rawText: task.raw_text,
                        isCompleted: newStatus
                    }
                }));
                dispatchedVisualToggle = true;
            };

            if (targetNotePath.startsWith('__team__/')) {
                // Collab Mode virtual paths: use remote bypass directly to avoid write/push conflicts
                const parsedTeamNote = parseTeamNoteId(targetNotePath);
                const teamVaultId = parsedTeamNote.teamVaultId || useSessionStore.getState().teamVaultId;
                let relativePath = parsedTeamNote.filePath || '';
                let fileId = parsedTeamNote.fileId;

                if (!teamVaultId) {
                    throw new Error('Sync not configured for team space');
                }
                if (!relativePath && fileId) {
                    const file = await syncService.getVaultFileById(teamVaultId, fileId);
                    relativePath = file.filePath;
                    fileId = file.fileId;
                }
                
                // Construct the full line string to hash since we only mapped raw_text
                // Checkbox format is standard "- [ ] " or "- [x] "
                const prefix = newStatus ? '- [ ] ' : '- [x] '; 
                const mockLineStr = prefix + task.raw_text;
                let contentHash = "";
                if (extractContentHash) {
                    contentHash = await extractContentHash(mockLineStr);
                }

                await syncService.taskBypass({
                    vault_id: teamVaultId,
                    file_path: relativePath,
                    file_id: fileId,
                    line_number: task.line_number,
                    line_content_hash: contentHash, // Send even if empty, server expects it
                    checked: newStatus,
                    toggled_by: useSessionStore.getState().userId || 'unknown'
                });
            } else if (taskId < 0 && activeEditorNotePath) {
                dispatchVisualToggle();
            } else {
                dispatchVisualToggle();
                // Local notes: traditional disk-based update (safe from missing IDs)
                await invoke('update_task_completion', {
                    notePath: targetNotePath,
                    taskText: task.raw_text,
                    isCompleted: newStatus
                });
            }

            // Update local UI state
            setTasks(prev => prev.map(t =>
                t.id === taskId ? { ...t, is_completed: newStatus } : t
            ));

            // Notify Editor to visually sync the checkbox without reloading from disk
            dispatchVisualToggle();

        } catch (e) {
            console.error('Failed to update task:', e);
        }
    }, [notePath]);

    // Priority badge color
    const getPriorityColor = (priority: string | null) => {
        switch (priority?.toLowerCase()) {
            case 'high': return 'bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400';
            case 'medium': return 'bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400';
            case 'low': return 'bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-400';
            default: return '';
        }
    };

    // Count stats
    const completedCount = tasks.filter(t => t.is_completed).length;
    const totalCount = tasks.length;

    if (!notePath && !projectPath) return null;

    return (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 h-12 border-b border-zinc-200 dark:border-zinc-700">
                <ListChecks size={16} className={cn(
                    totalCount > 0 ? "text-indigo-500" : "text-zinc-400"
                )} />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {totalCount > 0
                        ? t('tasks.completed_count', { completed: completedCount, total: totalCount })
                        : t('tasks.panel_title')
                    }
                </span>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-2">
                {loading ? (
                    <div className="flex items-center justify-center h-24 text-zinc-400">
                        <Loader2 size={20} className="animate-spin" />
                    </div>
                ) : tasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-24 text-zinc-400 text-sm">
                        <ListChecks size={24} className="mb-2 opacity-50" />
                        <span>{t('tasks.no_tasks')}</span>
                        <span className="text-xs mt-1 opacity-75">
                            {t('tasks.create_hint')}
                        </span>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {tasks.map((task, index) => (
                            <div
                                key={task.id ?? `task-${index}-${task.line_number}`}
                                onClick={() => handleToggleComplete(task)}
                                className={cn(
                                    "group p-3 rounded-lg border cursor-pointer transition-all",
                                    task.is_completed
                                        ? "bg-zinc-50 dark:bg-zinc-800/30 border-zinc-200 dark:border-zinc-700/50"
                                        : "bg-white dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 hover:border-indigo-300 dark:hover:border-indigo-600"
                                )}
                            >
                                <div className="flex items-start gap-2">
                                    {/* Completion toggle */}
                                    <button
                                        onClick={(e) => handleToggleComplete(task, e)}
                                        className={cn(
                                            "flex-shrink-0 mt-[2px] transition-colors",
                                            task.is_completed
                                                ? "text-green-500 hover:text-green-600"
                                                : "text-zinc-400 hover:text-indigo-500"
                                        )}
                                    >
                                        {task.is_completed ? (
                                            <CheckCircle2 size={18} />
                                        ) : (
                                            <Circle size={18} />
                                        )}
                                    </button>

                                    {/* Task content */}
                                    <div className="flex-1 min-w-0">
                                        <div className={cn(
                                            "text-sm",
                                            task.is_completed
                                                ? "text-zinc-400 line-through"
                                                : "text-zinc-700 dark:text-zinc-300"
                                        )}>
                                            {task.raw_text}
                                        </div>

                                        {/* Metadata badges */}
                                        {(task.due_date || task.priority || task.assignee) && (
                                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                                {task.due_date && (
                                                    <span className={cn(
                                                        "flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded",
                                                        "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400"
                                                    )}>
                                                        <Calendar size={10} />
                                                        {task.due_date}
                                                    </span>
                                                )}
                                                {task.priority && (
                                                    <span className={cn(
                                                        "flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded",
                                                        getPriorityColor(task.priority)
                                                    )}>
                                                        <Flag size={10} />
                                                        {task.priority}
                                                    </span>
                                                )}
                                                {task.assignee && (
                                                    <span className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-600 dark:bg-purple-900/50 dark:text-purple-400">
                                                        <User size={10} />
                                                        {task.assignee}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default NoteTaskPanel;
