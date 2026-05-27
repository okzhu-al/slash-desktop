import React, { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EditorContext } from '@slash/editor-core';
import { mediaService } from '@/core/media/MediaService';
import { LinkPreviewCard } from './LinkPreviewCard';
import { EnrichmentHoverCard } from './EnrichmentHoverCard';
import { SlashCommandList } from './SlashCommandList';
import { NoteContext } from '@/contexts/NoteContext';
import { ThemeProviderContext } from '@/core/theme/ThemeProvider';

interface EditorDependencyProviderProps {
    children: React.ReactNode;
    coreFsStore: any;
    dynamicCustomSkillService: any;
}

export const EditorDependencyProvider: React.FC<EditorDependencyProviderProps> = ({
    children,
    coreFsStore,
    dynamicCustomSkillService,
}) => {
    const value = useMemo(() => ({
        fileSystemStore: coreFsStore as any,
        mediaService: mediaService as any,
        customSkillService: dynamicCustomSkillService as any,
        noteService: {
            getNotes: () => invoke('get_notes'),
            checkNoteExists: (noteName: string) => invoke('check_note_exists', { noteName }),
            readFileContent: async (absolutePath: string) => {
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                return readTextFile(absolutePath);
            },
            inferRelation: (sourcePath: string, targetPath: string) => invoke('infer_wikilink_relation', { sourcePath, targetPath }),
            addRelation: (notePath: string, targetPath: string, targetTitle: string, relation: string) => invoke('add_note_relation', { notePath, targetTitle, targetPath, relationType: relation }),
            onRelationResult: async (callback: (payload: any) => void) => {
                const { listen } = await import('@tauri-apps/api/event');
                return listen('wikilink-relation-result', (event: any) => callback(event.payload));
            },
        },
        drawingStorageService: {
            saveDrawing: (vaultPath: string, pngData: number[], jsonData: string, existingPngPath: string | null, existingJsonPath: string | null) =>
                invoke('save_drawing', { vaultPath, pngData, jsonData, existingPngPath, existingJsonPath }),
            loadDrawingJson: (vaultPath: string, jsonPath: string) =>
                invoke('load_drawing_json', { vaultPath, jsonPath }),
            deleteDrawing: (vaultPath: string, pngPath: string, jsonPath: string) =>
                invoke('delete_drawing', { vaultPath, pngPath, jsonPath }),
        },
        LinkPreviewCard,
        EnrichmentHoverCard,
        SlashCommandList: SlashCommandList as any,
        NoteContext: NoteContext,
        EditorThemeType: ThemeProviderContext,
    }) as any, [coreFsStore, dynamicCustomSkillService]);

    return (
        <EditorContext.Provider value={value}>
            {children}
        </EditorContext.Provider>
    );
};
