/**
 * SnapshotReadonlyEditor — 只读 TipTap 渲染组件（简化版）
 *
 * 专为历史版本快照预览设计，使用无 React NodeView 的纯原生扩展集，
 * 避免因缺少 EditorContext.Provider 导致的 ReactNodeViewRenderer 崩溃。
 *
 * 注意：Mermaid、数学公式等复杂 NodeView 扩展均被排除，退化为代码块显示。
 */

import { useEffect, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Highlight from '@tiptap/extension-highlight';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createMarkdownExtension } from '@/features/editor/config/markdownBridge';
import {
    CustomParagraph,
    CustomHeading,
    CustomBold,
    CustomItalic,
    CustomInlineCode,
    CustomStrike,
    CustomLink,
} from '@slash/editor-core';
import Image from '@tiptap/extension-image';
import { all, createLowlight } from 'lowlight';

import { convertFileSrc } from '@tauri-apps/api/core';

const lowlight = createLowlight(all);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);

function stripVideoEmbeds(markdown: string): string {
    return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt: string, rawSrc: string) => {
        const cleanSrc = rawSrc.trim().replace(/^<|>$/g, '');
        const fileName = decodeURIComponent(cleanSrc.split(/[\\/]/).pop() || cleanSrc);
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const isVideo = alt.toLowerCase().startsWith('video') || VIDEO_EXTENSIONS.has(ext);
        return isVideo ? `\n> 视频已省略：${fileName}\n` : full;
    });
}

const NativeImageWithTauriSrc = Image.extend({
    renderHTML({ HTMLAttributes }) {
        let src = HTMLAttributes.src;
        if (src && !src.startsWith('http') && !src.startsWith('asset:') && !src.startsWith('data:')) {
            const vaultRoot = (window as any).__slashVaultPath;
            if (vaultRoot) {
                const relPath = src.startsWith('/') ? src.slice(1) : src;
                const sep = vaultRoot.includes('\\') ? '\\' : '/';
                const absPath = vaultRoot + sep + decodeURIComponent(relPath);
                src = convertFileSrc(absPath);
            }
        }
        return ['img', { ...HTMLAttributes, src, style: 'max-width: 100%; border-radius: 6px; margin: 12px 0;' }];
    }
});
/**
 * 快照预览专用样式 — 通过 <style> 注入确保优先级
 *
 * 原生 TipTap TaskItem NodeView 的 DOM 结构：
 *   <li data-checked="true/false">
 *     <label contenteditable="false">
 *       <input type="checkbox">
 *       <span></span>
 *     </label>
 *     <div>  ← contentDOM
 *       <p>text</p>
 *     </div>
 *   </li>
 */
const SNAPSHOT_STYLES = `
/* 去掉编辑器 50vh 底部填充和 placeholder */
.snapshot-readonly.ProseMirror {
    padding-bottom: 0 !important;
    min-height: auto !important;
    cursor: default !important;
}
.snapshot-readonly .is-empty::before,
.snapshot-readonly :is(h1,h2,h3,h4,h5,h6)::before {
    content: none !important;
}

/* ── TaskList 容器 ── */
.snapshot-readonly ul[data-type="taskList"] {
    list-style: none !important;
    padding-left: 24px !important;
    margin: 0 !important;
}

/* ── TaskItem 容器：block + relative ── */
.snapshot-readonly ul[data-type="taskList"] > li {
    display: block !important;
    position: relative !important;
    list-style: none !important;
    padding-left: 0 !important;
    margin-bottom: 0.35rem !important;
    min-height: 27px;
}
.snapshot-readonly ul[data-type="taskList"] > li::marker {
    display: none !important;
    content: "" !important;
}

/* ── Checkbox label：绝对定位到左侧 ── */
.snapshot-readonly ul[data-type="taskList"] > li > label {
    position: absolute !important;
    left: -1.5rem !important;
    top: 6.5px !important;
    margin: 0 !important;
    padding: 0 !important;
    line-height: 1 !important;
    user-select: none !important;
}

/* ── Checkbox input 对齐样式 ── */
.snapshot-readonly ul[data-type="taskList"] > li > label input[type="checkbox"] {
    width: 14px !important;
    height: 14px !important;
    margin: 0 !important;
    border-radius: 3px;
    cursor: default !important;
    accent-color: #22C55E;
    vertical-align: top !important;
}

/* ── Content div：block 布局 ── */
.snapshot-readonly ul[data-type="taskList"] > li > div {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    margin: 0 !important;
}

/* ── 已完成任务：删除线 + 变灰 ── */
.snapshot-readonly ul[data-type="taskList"] > li[data-checked="true"] > div {
    color: #9CA3AF !important;
}
.snapshot-readonly ul[data-type="taskList"] > li[data-checked="true"] > div p {
    text-decoration: line-through !important;
    text-decoration-color: #9CA3AF !important;
}

/* ── Dark mode 覆盖 ── */
.dark .snapshot-readonly ul[data-type="taskList"] > li[data-checked="true"] > div {
    color: #6B7280 !important;
}
.dark .snapshot-readonly ul[data-type="taskList"] > li[data-checked="true"] > div p {
    text-decoration-color: #6B7280 !important;
}
`;

interface SnapshotReadonlyEditorProps {
    /** 快照 Markdown 内容（已剥离 YAML frontmatter） */
    markdown: string;
    className?: string;
}

export function SnapshotReadonlyEditor({ markdown, className }: SnapshotReadonlyEditorProps) {
    const previewMarkdown = useMemo(() => stripVideoEmbeds(markdown), [markdown]);

    // 扩展列表仅创建一次（不可变），所有扩展均为原生 TipTap 扩展
    const extensions = useMemo(() => [
        StarterKit.configure({
            codeBlock: false,
            bold: false,
            italic: false,
            paragraph: false,
            heading: false,
            code: false,
            strike: false,
        }),
        CustomParagraph,
        CustomHeading,
        CustomBold,
        CustomItalic,
        CustomInlineCode,
        CustomStrike,
        CustomLink.configure({ openOnClick: false, autolink: true }),
        Highlight,
        NativeImageWithTauriSrc.configure({
            inline: true,
            allowBase64: true,
        }),

        // 原生 TipTap TaskList/TaskItem（自带原生 JS NodeView）
        TaskList,
        TaskItem.configure({ nested: true }),

        // 内置 Table 系列
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,

        TextAlign.configure({
            types: ['heading', 'paragraph', 'tableCell', 'tableHeader'],
            alignments: ['left', 'center', 'right', 'justify'],
        }),

        CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),

        // 核心：共用同一个 markdown 序列化桥
        createMarkdownExtension(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ], []);

    const editor = useEditor({
        editable: false,
        extensions,
        content: previewMarkdown,
        editorProps: {
            attributes: {
                class: 'prose dark:prose-invert max-w-none outline-none snapshot-readonly',
            },
        },
    });

    // markdown 内容变化时（切换快照）同步更新
    useEffect(() => {
        if (!editor || editor.isDestroyed) return;
        const current = (editor.storage as any)?.markdown?.getMarkdown?.() ?? '';
        if (current !== previewMarkdown) {
            editor.commands.setContent(previewMarkdown);
        }
    }, [editor, previewMarkdown]);

    // 卸载时销毁编辑器实例
    useEffect(() => {
        return () => { editor?.destroy(); };
    }, [editor]);

    if (!editor) {
        return (
            <div className="h-40 flex items-center justify-center text-zinc-400 text-sm">
                渲染中…
            </div>
        );
    }

    return (
        <>
            <style>{SNAPSHOT_STYLES}</style>
            <EditorContent
                editor={editor}
                className={className}
            />
        </>
    );
}
