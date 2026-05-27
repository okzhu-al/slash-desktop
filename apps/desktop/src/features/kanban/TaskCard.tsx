// TaskCard - Draggable task card for Kanban board

import { useDraggable } from '@dnd-kit/core';
import { Calendar, User, FileText, AlertTriangle } from 'lucide-react';
import { Task } from './taskService';
import { cn } from '@/shared/utils/cn';

interface TaskCardProps {
    task: Task;
    onNavigateToNote?: (notePath: string) => void;
    /** If true, render as overlay (no drag handlers) */
    isOverlay?: boolean;
}

/** Extract clean title from raw_text (remove metadata markers) */
function extractTitle(rawText: string): string {
    return rawText
        .replace(/📅\d{4}-\d{2}-\d{2}/g, '')  // Remove date
        .replace(/@\S+/g, '')                  // Remove @mentions
        .replace(/[🚩#](High|Medium|Low|Med|高|中|低)/gi, '')  // Remove priority
        .trim();
}

/** Render inline markdown (bold/italic) as React elements */
function renderInlineMarkdown(text: string): React.ReactNode {
    // Split by **bold** and *italic* patterns
    const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/);
    return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
            return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return part;
    });
}

/** Format filename from path */
function getFilename(path: string): string {
    const parts = path.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/\.md$/, '');
}

/** Check if task is overdue */
function isOverdue(dueDate: string | null, isCompleted: boolean): boolean {
    if (!dueDate || isCompleted) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate);
    return due < today;
}

export function TaskCard({ task, onNavigateToNote, isOverlay = false }: TaskCardProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        isDragging,
    } = useDraggable({
        id: `task-${task.id}`,
        data: { task },
        disabled: isOverlay,
    });

    const title = extractTitle(task.raw_text);
    const assignees = task.assignee?.split(',') || [];
    const overdue = isOverdue(task.due_date, task.is_completed);

    // Overlay card (dragging preview)
    if (isOverlay) {
        return (
            <div
                className={cn(
                    "p-3 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border-2",
                    overdue
                        ? "border-red-400 dark:border-red-500"
                        : "border-indigo-400 dark:border-indigo-500",
                    "rotate-3 scale-105"
                )}
            >
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                    {renderInlineMarkdown(title || task.raw_text)}
                </div>
                {task.due_date && (
                    <div className={cn(
                        "flex items-center gap-1 text-xs",
                        overdue ? "text-red-500" : "text-zinc-500 dark:text-zinc-400"
                    )}>
                        <Calendar size={12} />
                        <span>{task.due_date}</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            className={cn(
                "p-3 rounded-lg shadow-sm border transition-all duration-150",
                "cursor-grab active:cursor-grabbing",
                // Overdue styling
                overdue
                    ? "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700"
                    : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:shadow-md",
                isDragging && "opacity-30 scale-95"
            )}
        >
            {/* Title with overdue icon */}
            <div className="flex items-start gap-2">
                {overdue && (
                    <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                )}
                <div className={cn(
                    "text-sm font-medium mb-2",
                    overdue
                        ? "text-red-700 dark:text-red-400"
                        : "text-zinc-900 dark:text-zinc-100"
                )}>
                    {renderInlineMarkdown(title || task.raw_text)}
                </div>
            </div>

            {/* Metadata row */}
            <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                {/* Due date */}
                {task.due_date && (
                    <div className={cn(
                        "flex items-center gap-1",
                        overdue && "text-red-500 font-medium"
                    )}>
                        <Calendar size={12} />
                        <span>{task.due_date}</span>
                    </div>
                )}

                {/* Assignees */}
                {assignees.length > 0 && (
                    <div className="flex items-center gap-1">
                        <User size={12} />
                        <span>{assignees.join(', ')}</span>
                    </div>
                )}

                {/* Priority badge */}
                {task.priority && (
                    <span className={cn(
                        "px-1.5 py-0.5 rounded text-xs font-medium",
                        task.priority === 'high' && "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
                        task.priority === 'medium' && "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
                        task.priority === 'low' && "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
                    )}>
                        {task.priority}
                    </span>
                )}
            </div>

            {/* Source note link */}
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onNavigateToNote?.(task.note_path);
                }}
                className="mt-2 flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600 hover:underline"
            >
                <FileText size={12} />
                <span>{getFilename(task.note_path)}</span>
            </button>
        </div>
    );
}

export default TaskCard;

