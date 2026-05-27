import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import { MathExtension, MathBlockExtension } from '@slash/editor-core';

const lowlight = createLowlight(common);

class MarkdownService {
    private editor: Editor;

    constructor() {
        // Initialize a headless Tiptap editor for structural transformations
        this.editor = new Editor({
            extensions: [
                StarterKit.configure({
                    codeBlock: false, // Using CodeBlockLowlight instead
                }),
                Table.configure({ resizable: true }),
                TableRow,
                TableHeader,
                TableCell,
                TaskList,
                TaskItem.configure({ nested: true }),
                CodeBlockLowlight.configure({ lowlight }),
                MathExtension,
                MathBlockExtension,
                Markdown.configure({
                    html: true, // Preserve HTML in markdown for safety
                    tightLists: true,
                    bulletListMarker: '-',
                    linkify: true,
                    // Note: tiptap-markdown 0.9.x uses prosemirror-markdown internally.
                    // We can customize the serializer here if needed.
                }),
            ],
        });
    }

    /**
     * Converts Tiptap HTML/JSON content to standard Markdown
     */
    toMarkdown(htmlOrJson: string | any): string {
        if (!htmlOrJson) return '';

        this.editor.commands.setContent(htmlOrJson);

        // Use the markdown storage provided by tiptap-markdown
        const markdown = (this.editor.storage as any).markdown.getMarkdown();

        return markdown;
    }

    /**
     * Converts Markdown text to Tiptap HTML
     */
    toHTML(markdown: string): string {
        if (!markdown) return '';

        // Setting content with 'markdown' format triggers the tiptap-markdown parser
        this.editor.commands.setContent(markdown);

        return this.editor.getHTML();
    }

    /**
     * Checks if the content is likely legacy HTML
     */
    isHTML(content: string): boolean {
        // Heuristic: check if it starts with common HTML tags
        const trimmed = content.trim();
        return trimmed.startsWith('<p>') || trimmed.startsWith('<div>') || trimmed.startsWith('<h1>');
    }
}

export const markdownService = new MarkdownService();
