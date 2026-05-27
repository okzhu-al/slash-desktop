// Dependency Injection Context for @slash/editor-core
import { createContext, useContext } from 'react';

export interface FileSystemStore {
    root?: { path: string };
    /** OPT-04: 当前编辑器是否处于团队空间，用于 UI 降级判断 */
    isTeamSpace?: boolean;
    [key: string]: any;
}

export interface MediaService {
    getAssetUrl: (path: string, vaultPath?: string | null) => Promise<string>;
    getEnrichedContent?: (hash: string) => Promise<string | null>;
    /** 恢复缺失的本地 asset（前端 404 时调用） */
    recoverMissingAsset?: (assetPath: string) => Promise<string>;
    /** 监听 transfer:download-completed 事件 */
    onTransferDownloadCompleted?: (
        callback: (payload: { asset_path: string; vault_id: string }) => void
    ) => Promise<() => void>;
    [key: string]: any;
}

export interface CustomSkillService {
    listCustomSkills: () => Promise<any[]>;
    executeCustomSkill: (id: string, context: any) => Promise<any>;
    onSkillCompleted: (cb: (result: any) => void) => Promise<() => void>;
    onSkillChunk: (cb: (data: any) => void) => Promise<() => void>;
}

/**
 * NoteService — 笔记相关的平台操作
 * 解耦 WikiLink/SectionSuggestion 中的 Tauri invoke 调用
 */
export interface NoteService {
    /** 获取所有笔记列表（用于 WikiLink 自动补全） */
    getNotes: () => Promise<Array<{ id: number; path: string; title: string }>>;
    /** 检查笔记是否存在（用于链接样式判断） */
    checkNoteExists: (noteName: string) => Promise<boolean>;
    /** 读取笔记文本内容（用于提取标题列表） */
    readFileContent: (absolutePath: string) => Promise<string>;
    /** 推理 WikiLink 关系（AI 功能） */
    inferRelation: (sourcePath: string, targetPath: string) => Promise<void>;
    /** 保存笔记关系 */
    addRelation: (notePath: string, targetPath: string, targetTitle: string, relation: string) => Promise<void>;
    /** 监听关系推理结果事件，返回取消监听函数 */
    onRelationResult: (callback: (payload: { target_path?: string; relation?: string; reason?: string }) => void) => Promise<() => void>;
}

/**
 * DrawingStorageService — 画板文件存储
 * 解耦 DrawingService 中的 Tauri invoke 调用
 */
export interface DrawingStorageService {
    saveDrawing: (vaultPath: string, pngData: number[], jsonData: string, existingPngPath?: string | null, existingJsonPath?: string | null) => Promise<{ png_path: string; json_path: string }>;
    loadDrawingJson: (vaultPath: string, jsonPath: string) => Promise<string>;
    deleteDrawing: (vaultPath: string, pngPath?: string | null, jsonPath?: string | null) => Promise<void>;
}

export interface LinkPreviewProps {
    noteName: string;
    section?: string;
    [key: string]: any;
}

export interface SlashCommandListProps {
    items: any[];
    command: (item: any) => void;
}

export interface EnrichmentHoverCardProps {
    content: string | null;
    children: React.ReactNode;
}

export interface EditorContextType {
    fileSystemStore: FileSystemStore;
    mediaService: MediaService;
    customSkillService: CustomSkillService;
    noteService: NoteService;
    drawingStorageService: DrawingStorageService;
    LinkPreviewCard: React.ComponentType<LinkPreviewProps>;
    EnrichmentHoverCard: React.ComponentType<EnrichmentHoverCardProps>;
    SlashCommandList: React.ComponentType<SlashCommandListProps>;
    NoteContext?: React.Context<any>;
    EditorThemeType?: React.Context<any>;
}

export const EditorContext = createContext<EditorContextType | null>(null);

export const useEditorServices = () => {
    const context = useContext(EditorContext);
    if (!context) {
        throw new Error('useEditorServices must be used within an EditorContextProvider');
    }
    return context;
};
