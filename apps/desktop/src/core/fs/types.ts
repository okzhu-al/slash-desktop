export type FileSystemItemType = 'file' | 'folder';

export interface FileSystemItem {
    id: string; // Absolute path or unique ID
    name: string;
    path: string; // Absolute path
    type: FileSystemItemType;
    children?: FileSystemItem[]; // For folders
    isOpen?: boolean; // For folders (expanded/collapsed) - UI state could be here or separate
    content?: string; // Optional content buffer
    createdAt?: number; // Unix timestamp in ms
    updatedAt?: number; // Unix timestamp in ms
    title?: string; // Cached title from frontmatter
    tags?: string[]; // Cached tags from frontmatter
}
