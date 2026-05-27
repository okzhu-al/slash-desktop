/**
 * Editor.tsx - Container component orchestrating global Editor states
 * 
 * Phase 5 Final: Strict Container/Presenter Separation
 */


import { useEditorContainer } from '../hooks/useEditorContainer';
import { EditorView } from './EditorView';

export interface EditorProps {
    // noteId and title are now from NoteContext
    initialContent: string;
    initialMetadata: any;
    onSave: (targetNotePath: string, targetFileId: string | null, body: string, metadata: any, options?: { allowRename?: boolean }) => void;
    allowRename?: boolean;
    onTitleChange?: (newTitle: string) => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
    isNewNote?: boolean;
    shouldFocusBody?: boolean;
    onNavigateToNote?: (notePath: string) => void;
    readOnly?: boolean;
    activeNoteId?: string;
}

export const Editor = (props: EditorProps) => {
    // 注入全部逻辑引擎，获得最终的渲染模型
    const viewProps = useEditorContainer(props);

    // 如果初始化未完成，拦截渲染
    if (!viewProps.editor) return null;

    // 直接推给纯视觉组件进行渲染
    return <EditorView {...viewProps} />;
};

export default Editor;