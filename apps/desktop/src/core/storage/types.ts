export interface Note {
    id: string;
    title: string;
    content: string; // HTML Body in memory, Markdown on disk (transcoded by Repository)
    path: string;
    metadata?: Record<string, any>;
    createdAt: number;
    updatedAt: number;
}

export interface NoteRepository {
    getNotes(): Promise<Note[]>;
    getNote(id: string): Promise<Note | null>;
    saveNote(note: Note): Promise<void>;
    createNote(title: string, parentPath?: string): Promise<Note>;
    deleteNote(id: string): Promise<void>;
    startResizing?: boolean; // Temporary hack if needed? No.
    // ...
    createFolder?(name: string, parentPath?: string): Promise<string>;
    renameNote(id: string, newTitle: string): Promise<string>;
    initialize(): Promise<void>; // Ensure root directory exists
}
