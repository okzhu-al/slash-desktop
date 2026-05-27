import { useCommand } from '@/modules/keybindings/useCommand';
import type { Editor as TiptapEditor } from '@tiptap/core';

interface UseEditorKeybindingsProps {
    editor: TiptapEditor | null;
    setShowFindBar: React.Dispatch<React.SetStateAction<boolean>>;
    onForceSave?: () => Promise<void> | void;
}

export function useEditorKeybindings({ editor, setShowFindBar, onForceSave }: UseEditorKeybindingsProps) {
    useCommand('editor.bold', () => editor?.chain().focus().toggleBold().run());
    useCommand('editor.italic', () => editor?.chain().focus().toggleItalic().run());
    useCommand('editor.code', () => {
        if (!editor) return;
        const { from, to } = editor.state.selection;
        if (from === to) editor.chain().focus().insertContent('`').run();
        else editor.chain().focus().toggleCode().run();
    });
    useCommand('editor.strike', () => editor?.chain().focus().toggleStrike().run());
    useCommand('editor.highlight', () => editor?.chain().focus().toggleHighlight().run());
    useCommand('editor.insert_table', () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());

    // Find in note (Cmd+F) - toggle on/off
    useCommand('editor.find', () => setShowFindBar(prev => !prev));
    
    // Force Save (Cmd+S)
    useCommand('editor.save', () => onForceSave?.());
}
