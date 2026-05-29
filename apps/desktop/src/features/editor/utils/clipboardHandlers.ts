/**
 * clipboardHandlers.ts
 * 
 * Extracted clipboard (paste) and drag-and-drop OS interactions for the Tiptap editor.
 * Moved from useSlashEditor.ts to reduce hook bloating.
 */

import { EditorView } from '@tiptap/pm/view';
import { mediaService } from '@/core/media/MediaService';
import { getMediaType, insertMediaNode, updateMediaSrc, IMPORTING_PREFIX, IMPORT_FAILED_PREFIX, IMMEDIATE_FEEDBACK_THRESHOLD } from './mediaUtils';
import { toast } from 'sonner';
import i18next from 'i18next';
import { getMaxSyncFileSize, formatFileSize } from '@/core/sync/capabilities';

/**
 * Parse Markdown table text into 2D array of cell contents
 * @param text - Markdown table text
 * @returns 2D array of cell contents (excluding separator row)
 */
function parseMarkdownTable(text: string): string[][] {
    const lines = text.trim().split('\n');
    const result: string[][] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip separator row (|---|---|)
        if (/^\|[\s-:|]+\|$/.test(trimmed)) continue;
        // Skip if not a table row
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        // Parse cells: split by | and trim each cell
        const cells = trimmed
            .slice(1, -1) // Remove leading and trailing |
            .split('|')
            .map(cell => cell.trim());

        if (cells.length > 0) {
            result.push(cells);
        }
    }

    return result;
}

/**
 * Strip code fence markers (```) from clipboard text
 * ProseMirror's clipboard serializer wraps code block content in fence syntax
 * e.g. "```\ncontent\n```" → "content"
 */
function stripCodeFences(text: string): string {
    if (!text) return text;
    const lines = text.split('\n');

    // Check if text starts with ``` and ends with ```
    const firstLine = lines[0].trim();
    const lastLine = lines[lines.length - 1].trim();

    if (firstLine.startsWith('```') && lastLine === '```') {
        // Remove first line (```language) and last line (```)
        return lines.slice(1, -1).join('\n');
    }

    return text;
}

/**
 * Extract text content from HTML <code> tags
 * Used to get clean content from ProseMirror's clipboard HTML
 * e.g. '<pre data-pm-slice="1 1 []"><code>content</code></pre>' → 'content'
 */
function extractCodeContent(html: string): string {
    const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (match?.[1]) {
        // Decode HTML entities
        const div = document.createElement('div');
        div.innerHTML = match[1];
        return div.textContent || '';
    }
    return '';
}


// --- Exported Handlers ---

export const createEditorDropHandler = () => {
    return (view: EditorView, event: DragEvent, _slice: any, _moved: boolean) => {
        // Check for external file drop
        if (event.dataTransfer?.files?.length) {
            const files = Array.from(event.dataTransfer.files);
            const mediaFiles = files.filter(f => getMediaType(f) !== null);

            if (mediaFiles.length > 0) {
                event.preventDefault();
                console.log(`📁 [handleDrop] Processing ${mediaFiles.length} media file(s)`);

                mediaFiles.forEach(async (file) => {
                    try {
                        const filePath = (file as any).path;

                        const maxLimitBytes = await getMaxSyncFileSize();
                        if (file.size > maxLimitBytes) {
                            console.warn(`⚠️ [handleDrop] Space: File too large: ${file.size} bytes`);
                            toast.error(i18next.t('media.team_size_limit_title', '文件超出限制'), {
                                description: i18next.t('media.team_size_limit_block', '此文件 ({{size}}) 超出当前空间 {{limit}} 大小限制，无法引入', { size: formatFileSize(file.size), limit: formatFileSize(maxLimitBytes) }),
                            });
                            return;
                        }

                        const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
                        const pos = coordinates?.pos ?? view.state.selection.from;
                        const mediaType = getMediaType(file);

                        // 大文件 + 有原生路径 → placeholder-first 模式
                        if (filePath && file.size > IMMEDIATE_FEEDBACK_THRESHOLD && mediaType) {
                            const ext = filePath.split('.').pop()?.toLowerCase() || 'bin';
                            const placeholderSrc = `assets/${IMPORTING_PREFIX}${crypto.randomUUID()}.${ext}`;
                            console.log(`[MediaImport] placeholder inserted: placeholder=${placeholderSrc} size=${file.size} source=${filePath}`);

                            insertMediaNode(view, mediaType, placeholderSrc, pos);

                            const startMs = performance.now();
                            mediaService.saveAssetFromPath(filePath).then((realPath) => {
                                const elapsedMs = Math.round(performance.now() - startMs);
                                console.log(`[MediaImport] complete: elapsed_ms=${elapsedMs} placeholder=${placeholderSrc} → ${realPath}`);
                                updateMediaSrc(view, placeholderSrc, realPath);
                            }).catch((err) => {
                                console.error(`❌ [MediaImport] failed:`, err);
                                const failedSrc = placeholderSrc.replace(IMPORTING_PREFIX, IMPORT_FAILED_PREFIX);
                                updateMediaSrc(view, placeholderSrc, failedSrc);
                                toast.error(i18next.t('media.import_error', '文件导入失败'));
                            });
                            return;
                        }

                        // 小文件 → 同步模式
                        let relativePath;
                        if (filePath) {
                            relativePath = await mediaService.saveAssetFromPath(filePath);
                        } else {
                            relativePath = await mediaService.saveAsset(file, false);
                        }

                        if (mediaType) {
                            insertMediaNode(view, mediaType, relativePath, pos);
                        }
                    } catch (e) {
                        console.error("❌ [handleDrop] Failed:", e);
                    }
                });
                return true;
            }
        }
        return false;
    };
};

// Helper to check if we're inside code or math
const isInsideCodeOrMath = (state: any, pos: number, matchedText?: string): boolean => {
    const $pos = state.doc.resolve(pos);
    const marks = $pos.marks();
    if (marks.some((m: any) => m.type.name === 'code')) return true;

    for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type.name === 'codeBlock' || node.type.name === 'math') {
            return true;
        }
    }

    if (matchedText && (matchedText.includes('`') || matchedText.includes('$'))) {
        return true;
    }

    return false;
};

// Helper to determine if a string looks like a valid URL to auto-link
const isUrl = (text: string): boolean => {
    const trimmed = text.trim();
    if (/\s/.test(trimmed)) return false;
    if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return true;
    try {
        const url = new URL('https://' + trimmed);
        return url.hostname.includes('.') && url.hostname.split('.').pop()!.length >= 2;
    } catch {
        return false;
    }
};

export const createEditorPasteHandler = (editorRef: React.MutableRefObject<any>) => {
    return (view: EditorView, event: ClipboardEvent) => {
        // === 0. Hyperlink Paste Handling (High Priority URL pasting) ===
        const plainText = event.clipboardData?.getData('text/plain') || '';
        if (plainText && isUrl(plainText)) {
            const { state } = view;
            const { selection } = state;
            
            // Skip if inside code or math block
            if (!isInsideCodeOrMath(state, selection.from)) {
                event.preventDefault();
                
                let href = plainText.trim();
                if (href.startsWith('www.')) {
                    href = 'https://' + href;
                }
                if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:')) {
                    href = 'https://' + href;
                }
                
                const { tr } = state;
                const linkMarkType = state.schema.marks.link;
                if (linkMarkType) {
                    if (selection.empty) {
                        const { from } = selection;
                        tr.insertText(plainText.trim());
                        const to = from + plainText.trim().length;
                        tr.addMark(from, to, linkMarkType.create({ href }));
                    } else {
                        // Wrap selection text with the link mark
                        const { from, to } = selection;
                        tr.addMark(from, to, linkMarkType.create({ href }));
                    }
                    view.dispatch(tr.scrollIntoView());
                    return true;
                }
            }
        }

        // === 0. Code block paste handling ===
        const pasteState = view.state;
        const paste$from = pasteState.selection.$from;

        // Check if cursor is inside a code block
        let inCodeBlock = false;
        for (let d = paste$from.depth; d > 0; d--) {
            if (paste$from.node(d).type.name === 'codeBlock') {
                inCodeBlock = true;
                break;
            }
        }

        const clipboardHtml = event.clipboardData?.getData('text/html') || '';
        const clipboardText = event.clipboardData?.getData('text/plain') || '';

        // Case A: Pasting INTO a code block → force plain text (strip fences if present)
        if (inCodeBlock) {
            const cleanText = stripCodeFences(clipboardText);
            if (cleanText) {
                event.preventDefault();
                view.dispatch(pasteState.tr.insertText(cleanText));
                return true;
            }
        }

        // Case B: Pasting FROM a code block → extract content without fence syntax
        // 🛡️ 极致安全守卫：必须确保剪贴板 HTML 中除了代码块标签之外，没有其他普通的富文本块节点（如段落、列表、标题等），
        // 且独立代码块的数量不能大于 1（防止连续复制多个独立代码块时发生数据级联截断丢失），
        // 否则这属于一个“混合多节点段落”，必须跳过强制提取，放行由默认粘贴器完整渲染（保留原本的段落与代码块混合结构）。
        const preTagCount = (clipboardHtml.match(/<pre[\s>]/gi) || []).length;
        const isMixedRichText = preTagCount > 1 || /<(p|li|h[1-6]|ol|ul|table|blockquote|span[^>]*class="wikilink"|span[^>]*data-type="wikilink"|a\s+href)[>\s]/i.test(clipboardHtml);

        if (!isMixedRichText &&
            clipboardHtml.includes('data-pm-slice') &&
            (clipboardHtml.includes('codeBlock') || clipboardHtml.includes('code_block') || /<pre[\s>]/.test(clipboardHtml))) {
            // 从 HTML <code> 标签中提取纯文本内容
            const codeContent = extractCodeContent(clipboardHtml);
            const cleanText = codeContent || stripCodeFences(clipboardText);
            if (cleanText) {
                event.preventDefault();
                view.dispatch(pasteState.tr.insertText(cleanText));
                return true;
            }
        }



        // === 0.5 Check for table nesting prevention ===
        // If we're inside a table cell and pasting content from another table cell,
        // extract just the text to prevent nested tables
        const { state } = view;
        const { selection } = state;
        const { $from } = selection;

        // Check if cursor is inside a table cell
        let inTableCell = false;
        for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                inTableCell = true;
                break;
            }
        }

        if (inTableCell) {
            // Check if clipboard HTML contains table structure in data-pm-slice
            const htmlData = event.clipboardData?.getData('text/html') || '';
            const hasTableInSlice = /data-pm-slice="[^"]*&quot;table&quot;|data-pm-slice="[^"]*&quot;tableRow&quot;|data-pm-slice="[^"]*&quot;tableCell&quot;|data-pm-slice="[^"]*&quot;tableHeader&quot;/.test(htmlData);

            if (hasTableInSlice) {
                console.log('[handlePaste] Table content detected in table cell, extracting text from HTML');

                // Extract text from HTML (not from text/plain which may have table formatting)
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = htmlData;
                const extractedText = tempDiv.textContent || '';

                if (extractedText) {
                    event.preventDefault();
                    const tr = state.tr.insertText(extractedText);
                    view.dispatch(tr);
                    console.log('[handlePaste] Inserted text:', extractedText);
                    return true;
                }
            }
        }

        // === 1. Check for Markdown table in plain text ===


        // Detect Markdown table pattern: 
        // - Lines starting with | and ending with |
        // - Has a separator row containing only |, -, :, and spaces
        const lines = plainText.trim().split('\n');
        const hasSeparatorRow = lines.some(line => {
            const trimmed = line.trim();
            // Separator row: starts and ends with |, contains only -, :, |, and spaces
            return trimmed.startsWith('|') &&
                trimmed.endsWith('|') &&
                /^\|[-:\s|]+\|$/.test(trimmed);
        });

        const isMarkdownTable = lines.length >= 2 &&
            lines[0].trim().startsWith('|') &&
            lines[0].trim().endsWith('|') &&
            hasSeparatorRow;

        if (isMarkdownTable) {
            // Parse the markdown table BEFORE preventDefault
            const tableData = parseMarkdownTable(plainText);

            // Only proceed if we successfully parsed the table
            if (tableData && tableData.length > 0 && tableData[0].length > 0) {
                event.preventDefault();

                // Function to insert table when editor is ready
                const insertTableWhenReady = (retryCount = 0) => {
                    const editor = editorRef.current;

                    // Check if editor is available
                    if (!editor || !editor.view) {
                        return;
                    }

                    // Check if editor is ready (has focus or can take focus)
                    try {
                        if (!editor.isFocused && retryCount < 5) {
                            // Try to focus editor DOM element
                            const editorElement = editor.view.dom;
                            if (editorElement) {
                                editorElement.focus();
                            }
                            requestAnimationFrame(() => insertTableWhenReady(retryCount + 1));
                            return;
                        }

                        // Force focus using view.focus() if still not focused
                        if (!editor.isFocused) {
                            try {
                                editor.view.focus();
                            } catch {
                                // Ignore focus errors
                            }
                        }

                        // Insert table at current position
                        const result = editor.commands.insertTable({
                            rows: tableData.length,
                            cols: tableData[0].length,
                            withHeaderRow: true
                        });

                        if (!result) {
                            return;
                        }

                        // Fill table content after table is created
                        setTimeout(() => {
                            let cellIndex = 0;
                            for (let rowIdx = 0; rowIdx < tableData.length; rowIdx++) {
                                for (let colIdx = 0; colIdx < tableData[rowIdx].length; colIdx++) {
                                    const cellContent = tableData[rowIdx][colIdx];
                                    if (cellContent) {
                                        editor.commands.insertContent(cellContent);
                                    }
                                    // Move to next cell (except for last cell)
                                    cellIndex++;
                                    if (cellIndex < tableData.length * tableData[0].length) {
                                        editor.commands.goToNextCell();
                                    }
                                }
                            }
                        }, 50);
                    } catch {
                        // Silently handle errors
                    }
                };

                // Start with 200ms delay to allow editor to stabilize
                setTimeout(insertTableWhenReady, 200);

                return true;
            }
            // Table parsing failed, fall back to default paste
        }

        // === 2. Handle media files ===
        const items = Array.from(event.clipboardData?.items || []);
        const fileItems = items.filter(item => item.kind === 'file');

        // CRITICAL: Collect all files SYNCHRONOUSLY before any async operations
        const filesToProcess: { file: File; path?: string }[] = [];

        for (const item of fileItems) {
            const file = item.getAsFile();
            if (file && getMediaType(file) !== null) {
                filesToProcess.push({
                    file,
                    path: (file as any).path
                });
            }
        }

        if (filesToProcess.length === 0) return false;

        event.preventDefault();

        // 🛡️ Phase 6: 优先从 Rust 读取 macOS 剪贴板文件路径
        // Finder 中 Cmd+C 拷贝的文件，剪贴板包含 file URL
        // 直接走 saveAssetFromPath（Rust 流式拷贝），完全绕过 JS 内存
        const processWithClipboardPaths = async () => {
            let clipboardPaths: string[] = [];
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                clipboardPaths = await invoke<string[]>('get_clipboard_file_paths');
                if (clipboardPaths.length > 0) {
                    console.log(`📋 [handlePaste] Got ${clipboardPaths.length} clipboard file path(s) from Rust`);
                }
            } catch (e) {
                console.warn('📋 [handlePaste] get_clipboard_file_paths failed, fallback to JS:', e);
            }

            for (let i = 0; i < filesToProcess.length; i++) {
                const { file, path } = filesToProcess[i];
                try {
                    const maxLimitBytes = await getMaxSyncFileSize();
                    if (file.size > maxLimitBytes) {
                        console.warn(`⚠️ [handlePaste] Space: File too large: ${file.size} bytes`);
                        toast.error(i18next.t('media.team_size_limit_title', '文件超出限制'), {
                            description: i18next.t('media.team_size_limit_block', '此文件 ({{size}}) 超出当前空间 {{limit}} 大小限制，无法引入', { size: formatFileSize(file.size), limit: formatFileSize(maxLimitBytes) }),
                        });
                        continue;
                    }

                    const nativePath = path || clipboardPaths[i];
                    const pos = view.state.selection.from;
                    const mediaType = getMediaType(file);

                    // 大文件 + 有原生路径 → placeholder-first 模式（约束 #1: 异步不阻塞）
                    if (nativePath && file.size > IMMEDIATE_FEEDBACK_THRESHOLD && mediaType) {
                        const ext = nativePath.split('.').pop()?.toLowerCase() || 'bin';
                        const placeholderSrc = `assets/${IMPORTING_PREFIX}${crypto.randomUUID()}.${ext}`;
                        console.log(`[MediaImport] placeholder inserted: placeholder=${placeholderSrc} size=${file.size} source=${nativePath}`);

                        // 立即插入占位节点
                        insertMediaNode(view, mediaType, placeholderSrc, pos);

                        // 后台异步执行 — fire & forget，不阻塞 paste handler
                        const startMs = performance.now();
                        mediaService.saveAssetFromPath(nativePath).then((realPath) => {
                            const elapsedMs = Math.round(performance.now() - startMs);
                            console.log(`[MediaImport] complete: elapsed_ms=${elapsedMs} placeholder=${placeholderSrc} → ${realPath}`);
                            updateMediaSrc(view, placeholderSrc, realPath);
                        }).catch((err) => {
                            console.error(`❌ [MediaImport] failed:`, err);
                            // 约束 #4: 失败不静默删除，改为 import_failed 占位
                            const failedSrc = placeholderSrc.replace(IMPORTING_PREFIX, IMPORT_FAILED_PREFIX);
                            updateMediaSrc(view, placeholderSrc, failedSrc);
                            toast.error(i18next.t('media.import_error', '文件导入失败'));
                        });
                        continue;
                    }

                    // 小文件或无原生路径 → 同步模式（原行为）
                    let relativePath: string;
                    if (nativePath) {
                        console.log(`📋 [handlePaste] Using native path (zero JS memory): ${nativePath}`);
                        relativePath = await mediaService.saveAssetFromPath(nativePath);
                    } else {
                        const JS_MEMORY_HARD_LIMIT = 100 * 1024 * 1024;
                        if (file.size > JS_MEMORY_HARD_LIMIT) {
                            console.error(`🚫 [handlePaste] File too large for JS memory (${(file.size / 1024 / 1024).toFixed(0)}MB), skipping`);
                            toast.error(i18next.t('media.paste_too_large', '文件过大'), {
                                description: i18next.t('media.paste_too_large_hint', '请使用拖拽方式导入超大文件'),
                            });
                            continue;
                        }
                        relativePath = await mediaService.saveAsset(file, false);
                    }

                    if (mediaType) {
                        insertMediaNode(view, mediaType, relativePath, pos);
                    }
                } catch (e) {
                    console.error("❌ [handlePaste] Failed:", e);
                }
            }
        };

        processWithClipboardPaths();

        return true;
    };
};
