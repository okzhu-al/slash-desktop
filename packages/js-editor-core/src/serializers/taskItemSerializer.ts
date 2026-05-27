/**
 * TaskItem Serializer - Markdown serialization for task items with metadata
 * 
 * Format: - [ ] Task content 📅YYYY-MM-DD @assignee #priority
 */

import type { Node } from '@tiptap/pm/model';

export interface TaskItemSerializerState {
    write: (text: string) => void;
    text: (text: string, escape?: boolean) => void;
    renderInline: (parent: Node) => void;
    ensureNewLine: () => void;
    wrapBlock?: (delim: string, firstDelim: string | null, node: Node, f: () => void) => void;
}

/**
 * Serialize task item to markdown with metadata
 */
export function serializeTaskItem(state: TaskItemSerializerState, node: Node) {
    // Checkbox marker
    const checked = node.attrs.checked;
    state.write(checked ? '- [x] ' : '- [ ] ');

    // Render task content (inline children)
    state.renderInline(node);

    // Append metadata markers
    const { dueDate, assignee, priority } = node.attrs;

    if (dueDate) {
        state.write(` 📅${dueDate}`);
    }

    if (assignee) {
        state.write(` @${assignee}`);
    }

    if (priority) {
        // Normalize priority to capitalized form
        const normalized = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
        state.write(` #${normalized}`);
    }

    state.ensureNewLine();
}

/**
 * Parse task metadata from text content
 * Returns cleaned content and extracted metadata
 */
export function parseTaskMetadata(text: string): {
    content: string;
    dueDate: string | null;
    assignee: string | null;
    priority: string | null;
} {
    let content = text;
    let dueDate: string | null = null;
    let assignee: string | null = null;
    let priority: string | null = null;

    // Extract date: 📅YYYY-MM-DD
    const dateMatch = content.match(/📅(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
        dueDate = dateMatch[1];
        content = content.replace(dateMatch[0], '').trim();
    }

    // Extract assignee: @username
    const assigneeMatch = content.match(/@(\w+)/);
    if (assigneeMatch) {
        assignee = assigneeMatch[1];
        content = content.replace(assigneeMatch[0], '').trim();
    }

    // Extract priority: #High, #Medium, #Low, #high, etc.
    const priorityMatch = content.match(/#(high|medium|low|High|Medium|Low|Med)/i);
    if (priorityMatch) {
        const p = priorityMatch[1].toLowerCase();
        priority = p === 'med' ? 'medium' : p;
        content = content.replace(priorityMatch[0], '').trim();
    }

    return { content: content.trim(), dueDate, assignee, priority };
}

export const taskItemSerializer = {
    serialize: serializeTaskItem,
    parse: parseTaskMetadata,
};
