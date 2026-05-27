// Task Service - Tauri API layer for task operations

import { invoke } from '@tauri-apps/api/core';

/** Task from database */
export interface Task {
    id: number;
    note_path: string;
    line_number: number;
    raw_text: string;
    is_completed: boolean;
    due_date: string | null;
    assignee: string | null;
    priority: string | null;
    created_at: number;
    updated_at: number;
}

/** Filter parameters for task queries */
export interface TaskFilter {
    due_date?: string;
    assignee?: string;
    priority?: string;
    is_completed?: boolean;
    note_path?: string;
}

export const taskService = {
    /** Get all tasks */
    getTasks: () => invoke<Task[]>('get_tasks'),

    /** Get tasks for a specific note */
    getNoteTasks: (notePath: string) => invoke<Task[]>('get_note_tasks', { notePath }),

    /** Get tasks matching filter */
    filterTasks: (filter: TaskFilter) => invoke<Task[]>('filter_tasks', { filter }),

    /** Scan a note for tasks and store in DB */
    scanNoteTasks: (notePath: string) => invoke<Task[]>('scan_note_tasks', { notePath }),

    /** Scan all notes for tasks (batch) */
    scanAllTasks: () => invoke<number>('scan_all_tasks'),

    /** Update task completion status (updates DB and source file by path and text) */
    updateTaskCompletion: (notePath: string, taskText: string, isCompleted: boolean) =>
        invoke<void>('update_task_completion', { notePath, taskText, isCompleted }),

    /** Get tasks for a project folder (all notes under folder) */
    getProjectTasks: async (projectPath: string): Promise<Task[]> => {
        // Get all tasks and filter by path prefix
        const allTasks = await invoke<Task[]>('get_tasks');
        return allTasks.filter(task => task.note_path.startsWith(projectPath));
    },
};

export default taskService;

