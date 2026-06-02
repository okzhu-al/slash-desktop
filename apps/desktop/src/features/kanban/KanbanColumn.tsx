// KanbanColumn - Droppable column for Kanban board

import { useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import { Task } from './taskService';
import { TaskCard } from './TaskCard';
import { cn } from '@/shared/utils/cn';

export type ColumnId = 'todo' | 'done';

interface KanbanColumnProps {
    id: ColumnId;
    title: string;
    tasks: Task[];
    onNavigateToNote?: (notePath: string) => void;
}

const columnStyles: Record<ColumnId, { bg: string; header: string }> = {
    todo: {
        bg: 'bg-zinc-100 dark:bg-zinc-800/30',
        header: 'text-zinc-700 dark:text-zinc-400',
    },
    done: {
        bg: 'bg-green-100 dark:bg-green-800/30',
        header: 'text-green-700 dark:text-green-400',
    },
};

export function KanbanColumn({ id, title, tasks, onNavigateToNote }: KanbanColumnProps) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({
        id: `column-${id}`,
        data: { columnId: id },
    });

    const styles = columnStyles[id];

    return (
        <div
            ref={setNodeRef}
            className={cn(
                "flex-1 min-w-[280px] max-w-[400px] rounded-xl p-4 transition-all duration-150",
                styles.bg,
                isOver && "ring-2 ring-indigo-500 dark:ring-blue-400 ring-offset-2 scale-[1.02]"
            )}
        >
            {/* Column header */}
            <div className="flex items-center justify-between mb-4">
                <h3 className={cn("font-semibold", styles.header)}>
                    {title}
                </h3>
                <span className="text-sm text-zinc-400 dark:text-zinc-500">
                    {tasks.length}
                </span>
            </div>

            {/* Tasks */}
            <div className="space-y-3">
                {tasks.map(task => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        onNavigateToNote={onNavigateToNote}
                    />
                ))}

                {tasks.length === 0 && (
                    <div className="text-center text-zinc-400 dark:text-zinc-500 text-sm py-8">
                        {t('kanban.no_tasks')}
                    </div>
                )}
            </div>
        </div>
    );
}

export default KanbanColumn;

