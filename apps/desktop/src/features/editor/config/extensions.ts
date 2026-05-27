/**
 * TipTap Editor Extensions Configuration
 * Extracted from Editor.tsx for modularity
 */

import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Extension } from '@tiptap/core';

import Placeholder from '@tiptap/extension-placeholder';

// 🛡️ Disable native underline behavior (Cmd+U) to block browser's default contenteditable underline
const DisableUnderline = Extension.create({
    name: 'disableUnderline',
    addKeyboardShortcuts() {
        return {
            'Mod-u': () => true,
            'Mod-U': () => true,
        };
    },
});
import { createMarkdownExtension } from './markdownBridge';
import { all, createLowlight } from 'lowlight';

// Custom extensions
import {
    CustomLink,
    SuperTableExtension, TableRow, TableHeader, TableCell,
    MixedListItem, MixedTaskItem, MixedTaskList, MixedListKeymap,
    CustomCodeBlock,
    SlashCommand,
    MathExtension,
    MathBlockExtension,
    CustomImageExtension,
    VideoExtension,
    AudioExtension,
    FileAttachmentExtension,
    WikiLink, createSuggestion,
    SectionSuggestion,
    CustomParagraph,
    CustomHeading,
    CustomBlockquote,
    CustomBold,
    CustomItalic,
    CustomInlineCode,
    CustomHighlight,
    CustomStrike,
    TabKeyHandler,
    HeadingBacklinks,
    DateChip, UserChip, PriorityChip,
    SearchHighlight,
    SelectionHighlight,
    AiShimmerMark,
    AnnotationMark,
    DrawingExtension,
    drawingService, // Imported singleton instance
    InputTelemetry
} from '@slash/editor-core';

// Note: TableStyles and DrawingStyles are now imported at the app level (main.tsx or App.tsx) globally from @slash/editor-core/dist/style.css if they exist,
// or we can import them directly if the package provides them. Since we are in a monorepo, Vite will resolve direct css imports.
import '@slash/editor-core/src/extensions/Table/TableStyles.css';
import '@slash/editor-core/src/extensions/Drawing/DrawingStyles.css';
import '@slash/editor-core/src/extensions/AnnotationMark.css';


// Import host services for editor-core DI
import { mediaService } from '@/core/media/MediaService';
import { useFileSystemStore } from '@/core/fs/store';

// Tauri APIs — only used in Desktop host injection, NOT in editor-core
import { invoke } from '@tauri-apps/api/core';
import { readTextFile } from '@tauri-apps/plugin-fs';

// Create lowlight instance for syntax highlighting
const lowlight = createLowlight(all);

/** Options for creating editor extensions */
export interface EditorExtensionOptions {
    /** Placeholder text for empty editor */
    placeholder: string;
    CodeBlockComponent?: any;
    SlashCommandList?: any;
    customSkillService?: any;
}

/**
 * Create the full array of TipTap extensions for the editor
 */
export function createEditorExtensions(options: EditorExtensionOptions) {
    const { placeholder, CodeBlockComponent, SlashCommandList, customSkillService } = options;

    // Immediately wire up static singletons that the core extensions rely on
    drawingService.resolveAssetUrlFallback = (path: string, vault: string) => mediaService.getAssetUrl(path, vault);
    drawingService.storageBackend = {
        saveDrawing: (vaultPath, pngData, jsonData, existingPngPath, existingJsonPath) =>
            invoke('save_drawing', { vaultPath, pngData, jsonData, existingPngPath, existingJsonPath }),
        loadDrawingJson: (vaultPath, jsonPath) =>
            invoke('load_drawing_json', { vaultPath, jsonPath }),
        deleteDrawing: (vaultPath, pngPath, jsonPath) =>
            invoke('delete_drawing', { vaultPath, pngPath, jsonPath }),
    };

    /** Desktop getNotes 回调 — 桥接 Tauri invoke */
    const getNotes = () => invoke<Array<{ id: number; path: string; title: string }>>('get_notes');

    return [

        // Core StarterKit with disabled features we customize
        StarterKit.configure({
            blockquote: false, // Use CustomBlockquote
            codeBlock: false,
            listItem: false,
            bold: false,
            italic: false,
            paragraph: false,
            heading: false,  // Use CustomHeading
            code: false,  // Use CustomInlineCode
            strike: false,  // Use CustomStrike
            link: false,   // Use CustomLink instead of StarterKit's built-in Link
        }),

        // Custom paragraph and heading
        CustomParagraph,
        CustomHeading,
        CustomBlockquote,

        // Heading backlinks decoration
        HeadingBacklinks,

        // Custom Bold/Italic/Code/Highlight/Strike with InputRules and Backspace behavior
        CustomBold,
        CustomItalic,
        CustomInlineCode,
        CustomHighlight,
        CustomStrike,

        // Tab key handling (insert spaces in non-list contexts)
        TabKeyHandler,

        // File attachments node
        FileAttachmentExtension,

        // External links - [text](url)
        CustomLink.configure({
            openOnClick: true,
            autolink: true,
            onLocalLinkClick: (href) => {
                if (href) {
                    mediaService.openAsset(href);
                }
            },
            onExternalLinkClick: (href) => {
                if (href) {
                    invoke('plugin:opener|open_url', { url: href }).catch(e => {
                        console.error("Failed to open external link:", e);
                        window.open(href, '_blank', 'noopener,noreferrer');
                    });
                }
            }
        }),

        // Lists
        MixedListItem,
        MixedTaskList,
        MixedTaskItem.configure({ nested: true }),
        MixedListKeymap,

        // Task metadata chips (inline nodes)
        DateChip,
        UserChip,
        PriorityChip,

        // Tables
        SuperTableExtension.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,

        // Text alignment
        TextAlign.configure({
            types: ['heading', 'paragraph', 'tableCell', 'tableHeader'],
            alignments: ['left', 'center', 'right', 'justify'],
        }),

        // Code blocks with syntax highlighting
        CustomCodeBlock.configure({
            lowlight,
            defaultLanguage: null,
            CodeBlockComponent,
        }),

        // Slash commands
        SlashCommand.configure({
            SlashCommandList,
            customSkillService,
        }),

        // Math and diagrams
        MathExtension,
        MathBlockExtension,

        // Markdown support with custom serializers
        createMarkdownExtension(),

        // Placeholder
        Placeholder.configure({
            placeholder,
            // includeChildren: false（默认值）→ 仅在编辑器完全空时显示占位符
            // 防止列表/引用内的子段落也显示占位符导致重叠
        }),

        // Media extensions
        CustomImageExtension.configure({
            inline: true,
            allowBase64: true,
        }),
        VideoExtension,
        AudioExtension,

        // WikiLinks with navigation
        WikiLink.configure({
            suggestion: createSuggestion(getNotes),
            onNavigate: (path, section) => {
                window.dispatchEvent(new CustomEvent('slash:navigate-note', {
                    detail: { path, section }
                }));
            },
        }),
        SectionSuggestion.configure({
            getNotes,
            readFileContent: (absolutePath: string) => readTextFile(absolutePath),
        }),


        // Search highlight for Cmd+F find-in-note
        SearchHighlight,
        SelectionHighlight,


        // AI Skill loading shimmer effect
        AiShimmerMark,

        // Annotation mark for collaborative annotations
        AnnotationMark,

        DisableUnderline,

        (() => {
            drawingService.resolveAssetUrlFallback = (path: string, vault: string) => mediaService.getAssetUrl(path, vault);
            return DrawingExtension.configure({
                onSave: async (data, existingPngPath?: string, existingJsonPath?: string) => {
                    const dynamicVaultPath = useFileSystemStore.getState().root?.path || '';
                    if (!dynamicVaultPath) throw new Error('No vault path available in store');
                    return drawingService.saveDrawing(data, dynamicVaultPath, existingPngPath, existingJsonPath);
                },
                onLoad: async (jsonPath) => {
                    const dynamicVaultPath = useFileSystemStore.getState().root?.path || '';
                    if (!dynamicVaultPath) throw new Error('No vault path available in store');
                    return drawingService.loadDrawingJson(jsonPath, dynamicVaultPath);
                },
            });
        })(),

        InputTelemetry,
    ];
}

/**
 * 只读扩展子集 — 供快照预览、移动端等只读视图使用
 * 排除所有 Tauri/交互/文件系统依赖扩展，只保留纯渲染能力
 */
export function createReadonlyExtensions() {
    return [
        StarterKit.configure({
            codeBlock: false,
            listItem: false,
            bold: false,
            italic: false,
            paragraph: false,
            heading: false,
            code: false,
            strike: false,
            link: false,
        }),

        CustomParagraph,
        CustomHeading,
        CustomBold,
        CustomItalic,
        CustomInlineCode,
        CustomHighlight,
        CustomStrike,

        DisableUnderline,

        CustomLink.configure({ openOnClick: false, autolink: true }),

        MixedListItem,
        MixedTaskList,
        MixedTaskItem.configure({ nested: true }),

        SuperTableExtension.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,

        TextAlign.configure({
            types: ['heading', 'paragraph', 'tableCell', 'tableHeader'],
            alignments: ['left', 'center', 'right', 'justify'],
        }),

        CustomCodeBlock.configure({ lowlight, defaultLanguage: null }),

        // MermaidExtension 和 MathExtension 使用 React NodeView，
        // 在无 EditorContext.Provider 的只读环境下会崩溃，故不引入
        // （图表和数学公式在快照预览里退化为代码块，可接受）

        // 核心：共用同一个 markdown 序列化桥
        createMarkdownExtension(),
    ];
}

// 🛡️ Vite-HMR-Cache-Breaker: Force full extensions module resolution refresh - 2026-05-24T12:00:00

