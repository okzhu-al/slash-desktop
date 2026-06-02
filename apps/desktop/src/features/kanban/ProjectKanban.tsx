// ProjectKanban - Main Kanban board for project folders

import { useState, useEffect, useCallback } from 'react';
import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import { Task, taskService } from './taskService';
import { KanbanColumn, ColumnId } from './KanbanColumn';
import { TaskCard } from './TaskCard';
import { syncService } from '@/services/SyncService';
import { extractContentHash } from '@/shared/utils/taskHash';
import { useSessionStore } from '@/stores/useSessionStore';
import { executeTaskBypass, resolveLocalReadPath } from '@/services/TaskBypassDetector';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

interface ProjectKanbanProps {
    /** Absolute path to the project folder */
    projectPath: string;
    /** Project name for display */
    projectName: string;
    /** Vault path for relative path calculation */
    vaultPath: string;
    /** Callback to close Kanban and return to editor */
    onClose?: () => void;
    /** Callback to navigate to a note */
    onNavigateToNote?: (notePath: string) => void;
}

export function ProjectKanban({
    projectPath,
    projectName: _projectName,
    vaultPath,
    onClose: _onClose,
    onNavigateToNote,
}: ProjectKanbanProps) {
    const { t } = useTranslation();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTask, setActiveTask] = useState<Task | null>(null);

    // dnd-kit sensors with touch delay for better UX
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5, // Reduced for smoother start
            },
        })
    );

    // \ud83d\udee1\ufe0f Windows \u517c\u5bb9\uff1a\u7edf\u4e00\u6b63\u659c\u6760\u518d\u505a\u76f8\u5bf9\u8def\u5f84\u622a\u53d6
    const normProject = projectPath.replace(/\\/g, '/');
    const normVault = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
    const relativeProjectPath = normProject.startsWith(normVault + '/')
        ? normProject.slice(normVault.length + 1)
        : normProject;

    const normalizeTaskPath = useCallback((path: string | null | undefined) => {
        if (!path) return '';
        const normalized = path.replace(/\\/g, '/');
        const vault = (vaultPath || localStorage.getItem('slash_vault_path') || '').replace(/\\/g, '/').replace(/\/$/, '');
        if (vault && normalized.startsWith(vault + '/')) {
            return normalized.slice(vault.length + 1);
        }
        return normalized;
    }, [vaultPath]);

    // Load tasks on mount
    const loadTasks = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const allTasks = await taskService.getTasks();
            // Filter tasks under this project folder
            const projectTasks = allTasks.filter(task =>
                task.note_path.startsWith(relativeProjectPath)
            );
            setTasks(projectTasks);
        } catch (e) {
            setError(`${t('kanban.load_failed')}: ${e}`);
            console.error('[ProjectKanban] Failed to load tasks:', e);
        } finally {
            setIsLoading(false);
        }
    }, [relativeProjectPath, t]);

    useEffect(() => {
        loadTasks();
    }, [loadTasks]);

    useEffect(() => {
        const handleRemoteTaskToggle = (event: Event) => {
            const detail = (event as CustomEvent<{
                notePath?: string;
                lineNumber?: number;
                rawText?: string;
                isCompleted?: boolean;
            }>).detail;
            if (!detail?.rawText || typeof detail.isCompleted !== 'boolean') return;

            const detailPath = normalizeTaskPath(detail.notePath);
            const detailText = detail.rawText.trim();
            const isCompleted = detail.isCompleted;

            setTasks(prev => prev.map(task => {
                const taskPath = normalizeTaskPath(task.note_path);
                const samePath = detailPath
                    ? taskPath === detailPath || detailPath.endsWith(`/${taskPath}`) || taskPath.endsWith(`/${detailPath}`)
                    : true;
                const sameText = task.raw_text.trim() === detailText;
                // Remote task events may carry the server-side physical line while local
                // task rows can use editor/frontmatter-adjusted line numbers. Path + text
                // is the stable identity for immediate Kanban rendering.
                const sameLine = true;

                if (samePath && sameText && sameLine) {
                    return { ...task, is_completed: isCompleted };
                }
                return task;
            }));
        };

        const handleSyncCompleted = () => {
            loadTasks();
            window.setTimeout(loadTasks, 500);
        };

        window.addEventListener('slash:remote-task-toggle', handleRemoteTaskToggle);
        window.addEventListener('sync:completed', handleSyncCompleted);
        return () => {
            window.removeEventListener('slash:remote-task-toggle', handleRemoteTaskToggle);
            window.removeEventListener('sync:completed', handleSyncCompleted);
        };
    }, [loadTasks, normalizeTaskPath]);

    // Split tasks by completion status
    const todoTasks = tasks.filter(t => !t.is_completed);
    const doneTasks = tasks.filter(t => t.is_completed);

    // Handle drag start - track active task for overlay
    const handleDragStart = (event: DragStartEvent) => {
        const taskData = event.active.data.current?.task as Task | undefined;
        if (taskData) {
            setActiveTask(taskData);
        }
    };

    // Handle drag end - update task completion status
    const handleDragEnd = async (event: DragEndEvent) => {
        setActiveTask(null);  // Clear overlay

        const { active, over } = event;
        if (!over) return;

        const taskData = active.data.current?.task as Task | undefined;
        const targetColumn = over.data.current?.columnId as ColumnId | undefined;

        if (!taskData || !targetColumn) {
            return;
        }

        // Determine new completion status
        const newCompleted = targetColumn === 'done';
        if (taskData.is_completed === newCompleted) return; // No change

        try {
            // Check whether the task belongs to a locally mapped team file. Task checkbox
            // state is allowed through task-bypass even when the note body is solo/locked.
            let isMappedTeamFile = false;
            if (!taskData.note_path.startsWith('__team__/')) {
                const vaultPathStr = vaultPath || localStorage.getItem('slash_vault_path') || '';
                if (vaultPathStr) {
                    try {
                        const { isTeamNoteAsync } = await import('@/hooks/useIsTeamNote');
                        isMappedTeamFile = await isTeamNoteAsync(vaultPathStr, taskData.note_path);
                    } catch { /* ignore */ }
                }
            }

            // Perform optimistic update ONLY AFTER passing all permission checks
            setTasks(prev => prev.map(t => 
                t.id === taskData.id ? { ...t, is_completed: newCompleted } : t
            ));

            if (taskData.note_path.startsWith('__team__/')) {
                // Collab Mode virtual paths: Use bypass to update server directly
                const parsedTeamNote = parseTeamNoteId(taskData.note_path);
                const teamVaultId = parsedTeamNote.teamVaultId || useSessionStore.getState().teamVaultId;
                let relativePath = parsedTeamNote.filePath || '';
                let fileId = parsedTeamNote.fileId;

                if (!teamVaultId || !fileId) {
                    throw new Error('Sync not configured for team space');
                }
                if (!relativePath) {
                    const file = await syncService.getVaultFileById(teamVaultId, fileId);
                    relativePath = file.filePath;
                    fileId = file.fileId;
                }

                const prefix = newCompleted ? '- [x] ' : '- [ ] '; 
                const mockLineStr = prefix + taskData.raw_text;
                let contentHash = "";
                if (extractContentHash) {
                    contentHash = await extractContentHash(mockLineStr);
                }

                await syncService.taskBypass({
                    vault_id: teamVaultId,
                    file_path: relativePath,
                    file_id: fileId,
                    line_number: taskData.line_number,
                    line_content_hash: contentHash,
                    checked: newCompleted,
                    toggled_by: useSessionStore.getState().userId || 'unknown'
                });
            } else if (isMappedTeamFile) {
                const fallbackPrefix = newCompleted ? '- [ ] ' : '- [x] ';
                let originalLine = fallbackPrefix + taskData.raw_text;
                try {
                    const { readTextFile } = await import('@tauri-apps/plugin-fs');
                    const readPath = resolveLocalReadPath(taskData.note_path);
                    if (readPath) {
                        const content = await readTextFile(readPath);
                        originalLine = content.split('\n')[Math.max(0, taskData.line_number - 1)] ?? originalLine;
                    }
                } catch { /* use fallback */ }

                const count = await executeTaskBypass(taskData.note_path, [{
                    lineNumber: taskData.line_number,
                    originalLine,
                    checked: newCompleted,
                }]);
                if (count <= 0) {
                    throw new Error('Task bypass did not update any checkbox');
                }
            } else {
                // Local Editor/Solo notes: Use disk-based update
                await taskService.updateTaskCompletion(taskData.note_path, taskData.raw_text, newCompleted);
            }

            console.log(`✅ [Kanban] Task moved to ${targetColumn}`);
        } catch (e) {
            // Rollback on error
            console.error('[Kanban] Failed to update task:', e);
            setTasks(prev =>
                prev.map(t =>
                    t.id === taskData.id ? { ...t, is_completed: taskData.is_completed } : t
                )
            );
        }
    };

    const handleDragCancel = () => {
        setActiveTask(null);
    };

    return (
        <div className="p-6">
            {error && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center h-32 text-zinc-400">
                    {t('common.loading')}
                </div>
            ) : (
                <DndContext
                    sensors={sensors}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                >
                    <div className="flex gap-6 min-h-[200px]">
                        <KanbanColumn
                            id="todo"
                            title={t('kanban.todo')}
                            tasks={todoTasks}
                            onNavigateToNote={onNavigateToNote}
                        />
                        <KanbanColumn
                            id="done"
                            title={t('kanban.done')}
                            tasks={doneTasks}
                            onNavigateToNote={onNavigateToNote}
                        />
                    </div>

                    {/* Drag Overlay - renders the dragging card */}
                    <DragOverlay dropAnimation={{
                        duration: 200,
                        easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
                    }}>
                        {activeTask ? (
                            <TaskCard task={activeTask} isOverlay />
                        ) : null}
                    </DragOverlay>
                </DndContext>
            )}
        </div>
    );
}

export default ProjectKanban;
