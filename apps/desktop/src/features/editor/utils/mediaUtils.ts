/**
 * Media utility functions for Editor file handling
 * Extracted from Editor.tsx for reusability
 */

/** Image file extensions */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

/** Video file extensions */
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v'];

/** Audio file extensions */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'];

/**
 * Detect media type from file (MIME type or extension fallback)
 * @param file - File object to check
 * @returns 'image' | 'video' | 'audio' | null
 */
export function getMediaType(file: File): 'image' | 'video' | 'audio' | null {
    // Try MIME type first
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';

    // Fallback to extension for files without MIME type
    const ext = file.name.split('.').pop()?.toLowerCase() || '';

    if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';

    return null;
}

/**
 * Detect media type from file path/extension
 * @param path - File path to check
 * @returns 'image' | 'video' | 'audio' | null
 */
export function getMediaTypeFromPath(path: string): 'image' | 'video' | 'audio' | null {
    const ext = path.split('.').pop()?.toLowerCase() || '';

    if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';

    return null;
}

/** Media type union */
export type MediaType = 'image' | 'video' | 'audio';

/**
 * Insert a media node into the ProseMirror editor
 * @param view - ProseMirror EditorView
 * @param mediaType - Type of media to insert
 * @param src - Relative path to the media file
 * @param pos - Position to insert at (defaults to current selection)
 */
export function insertMediaNode(
    view: { state: any; dispatch: (tr: any) => void },
    mediaType: MediaType,
    src: string,
    pos?: number
): void {
    const insertPos = pos ?? view.state.selection.from;
    const schema = view.state.schema;

    const nodeType = schema.nodes[mediaType];
    if (!nodeType) {
        console.error(`[insertMediaNode] Unknown node type: ${mediaType}`);
        return;
    }

    const node = nodeType.create({ src });
    view.dispatch(view.state.tr.insert(insertPos, node));

    console.log(`✅ [insertMediaNode] Inserted ${mediaType} at pos ${insertPos}: ${src}`);
}

/** 导入中占位路径前缀 */
export const IMPORTING_PREFIX = '_importing_';
/** 导入失败占位路径前缀 */
export const IMPORT_FAILED_PREFIX = '_import_failed_';
/** 大文件即时反馈阈值（5MB 以上先插占位） */
export const IMMEDIATE_FEEDBACK_THRESHOLD = 5 * 1024 * 1024;

/**
 * 替换编辑器中已有 media 节点的 src 属性
 * 用于占位节点完成导入后更新为真实路径
 * 约束 #5: 找不到节点视为正常（用户可能已删除），不报错
 */
export function updateMediaSrc(
    view: { state: any; dispatch: (tr: any) => void },
    oldSrc: string,
    newSrc: string
): boolean {
    const { doc, tr } = view.state;
    let found = false;
    doc.descendants((node: any, pos: number) => {
        if (found) return false;
        if (['image', 'video', 'audio'].includes(node.type.name) && node.attrs.src === oldSrc) {
            tr.setNodeMarkup(pos, null, { ...node.attrs, src: newSrc });
            found = true;
            return false;
        }
    });
    if (found) {
        view.dispatch(tr);
        console.log(`✅ [EditorMedia] transfer state updated: ${oldSrc} → ${newSrc}`);
    } else {
        console.log(`ℹ️ [EditorMedia] node not found for update (user may have deleted): ${oldSrc}`);
    }
    return found;
}
