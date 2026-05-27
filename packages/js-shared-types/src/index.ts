export interface NoteMetadata {
    id?: string;
    title: string;
    created_at?: string;
    updated_at?: string;
    tags?: string[];
    summary?: string;
    [key: string]: any; // Allow other markdown frontmatter fields
}
