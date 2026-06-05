import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { useOutlineStore, OutlineHeading } from '@/stores/useOutlineStore';

export function useOutlineExtraction(editor: Editor | null, activeNoteId: string | null) {
    useEffect(() => {
        if (!editor || editor.isDestroyed) return;

        const updateOutline = () => {
            const headings: OutlineHeading[] = [];
            
            // Traverse the document tree to find all headings
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'heading') {
                    headings.push({
                        id: `heading-${pos}`,
                        level: node.attrs.level,
                        text: node.textContent, // Extracts all text inside the heading
                        pos,
                        noteId: activeNoteId,
                    });
                }
            });

            // Update global store
            useOutlineStore.getState().setHeadings(headings);
        };

        // 🎯 Scroll Spy: 根据光标位置更新活跃的目录项
        // 找到光标前方最近的 heading，即为当前章节
        const updateActiveHeading = () => {
            const { headings } = useOutlineStore.getState();
            if (headings.length === 0) return;

            const cursorPos = editor.state.selection.$head.pos;
            let activeIdx: number | null = null;

            // 从后往前找第一个 pos <= cursorPos 的 heading
            for (let i = headings.length - 1; i >= 0; i--) {
                if (headings[i].pos <= cursorPos) {
                    activeIdx = i;
                    break;
                }
            }

            useOutlineStore.getState().setActiveIndex(activeIdx);
        };

        // Initial extraction
        updateOutline();

        // Listen for doc changes → update headings
        editor.on('update', updateOutline);
        editor.on('selectionUpdate', updateOutline); // ⚡ Added: selectionUpdate guarantees outline rebuild on programmatically quiet note switches (setContent)

        // Listen for selection/cursor changes → update active heading
        editor.on('selectionUpdate', updateActiveHeading);

        // Initial active heading
        updateActiveHeading();

        // ⚡ Added: Listen to content loaded custom event to handle quiet updates / updateState completely
        window.addEventListener('slash:editor-content-loaded', updateOutline);
        window.addEventListener('slash:editor-content-loaded', updateActiveHeading);

        return () => {
            if (!editor.isDestroyed) {
                editor.off('update', updateOutline);
                editor.off('selectionUpdate', updateOutline);
                editor.off('selectionUpdate', updateActiveHeading);
            }
            window.removeEventListener('slash:editor-content-loaded', updateOutline);
            window.removeEventListener('slash:editor-content-loaded', updateActiveHeading);
        };
    }, [editor, activeNoteId]);
}
