/**
 * AIBubbleMenu.tsx
 *
 * 文本选中时浮现的 💬 批注工具条。
 * AI 技能已统一到斜杠命令 + AIRangeSelector 流程。
 *
 * 不依赖 @tiptap/extension-bubble-menu，
 * 使用 ProseMirror selection 事件 + absolute positioning 自行实现。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import './AIBubbleMenu.css';
import { annotationService } from '@/services/AnnotationService';
import { syncService } from '@/services/SyncService';
import { useNoteContextOptional } from '@/contexts/NoteContext';
import { useSessionStore } from '@/stores/useSessionStore';
import { normalizePath } from '@/shared/utils/pathUtils';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

interface AIBubbleMenuProps {
    editor: Editor | null;
    /** 是否可编辑（false = Solo 模式只读用户）*/
    canEdit?: boolean;
    notePath?: string;
    /** 是否团队笔记（批注仅在团队笔记中可用）*/
    isTeamNote?: boolean;
}

function extractSlashId(raw: string): string | null {
    const match = raw.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
    const frontmatter = match?.[1] ?? '';
    return frontmatter.match(/^slash_id:\s*['"]?([0-9a-fA-F-]{36})['"]?\s*$/m)?.[1] ?? null;
}

export function AIBubbleMenu({ editor, canEdit: _canEdit = true, notePath: _notePath = '', isTeamNote = false }: AIBubbleMenuProps) {
    const { t } = useTranslation();
    const noteCtx = useNoteContextOptional();
    const [visible, setVisible] = useState(false);
    const [annotating, setAnnotating] = useState(false);
    const [annotationText, setAnnotationText] = useState('');
    const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const menuRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // ========== 选区检测 ==========
    const updatePosition = useCallback(() => {
        if (!editor) return;

        const { state } = editor;
        const { from, to, empty } = state.selection;

        if (empty || from === to) {
            setVisible(false);
            setAnnotating(false);
            setAnnotationText('');
            return;
        }

        const view = editor.view;
        const end = view.coordsAtPos(to);

        const editorEl = view.dom.closest('.editor-content-area') || view.dom;
        const editorRect = editorEl.getBoundingClientRect();

        // 位置：选区末尾右侧，垂直居中于末尾行
        const endY = end.top - editorRect.top + (end.bottom - end.top) / 2 - 14; // 垂直居中（按钮高28px）
        const endX = end.right - editorRect.left + 6; // 末尾右侧 6px 间距

        setPosition({ top: Math.max(endY, 4), left: Math.max(endX, 0) });
        setVisible(true);
    }, [editor]);

    useEffect(() => {
        if (!editor) return;

        editor.on('selectionUpdate', updatePosition);
        const handleBlur = () => {
            setTimeout(() => {
                if (!menuRef.current?.contains(document.activeElement)) {
                    setVisible(false);
                    setAnnotating(false);
                }
            }, 200);
        };
        editor.on('blur', handleBlur);

        return () => {
            editor.off('selectionUpdate', updatePosition);
            editor.off('blur', handleBlur);
        };
    }, [editor, updatePosition]);

    // ========== annotation:focus — 定位到批注位置 ==========
    useEffect(() => {
        const handleFocus = (e: Event) => {
            const detail = (e as CustomEvent).detail as {
                annotationId?: string;
                anchorPreview?: string;
            };

            let el: Element | null = null;
            if (detail.annotationId) {
                el = document.querySelector(`[data-annotation-id="${detail.annotationId}"]`);
            }
            if (!el && detail.anchorPreview) {
                const marks = document.querySelectorAll('.annotation-mark');
                const needle = detail.anchorPreview.slice(0, 10);
                for (const mark of marks) {
                    if (mark.textContent?.includes(needle)) { el = mark; break; }
                }
            }

            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('annotation-mark--flash');
            setTimeout(() => el?.classList.remove('annotation-mark--flash'), 1200);
        };

        window.addEventListener('annotation:focus', handleFocus);
        return () => window.removeEventListener('annotation:focus', handleFocus);
    }, []);

    // ========== 重启后恢复批注高亮 ==========
    useEffect(() => {
        if (!editor) return;

        const handleRestore = (e: Event) => {
            const { annotations } = (e as CustomEvent).detail as { annotations: Array<{ id: string; anchor_preview?: string }> };
            if (!annotations?.length) return;

            const annotationMark = editor.schema.marks.annotation;
            if (!annotationMark) return;

            requestAnimationFrame(() => {
                const { doc } = editor.state;
                const tr = editor.state.tr;
                let applied = 0;

                for (const ann of annotations) {
                    const preview = ann.anchor_preview;
                    if (!preview) continue;
                    let found = false;
                    doc.descendants((node, pos) => {
                        if (found || !node.isText) return;
                        const text = node.text || '';
                        const idx = text.indexOf(preview);
                        if (idx !== -1) {
                            const from = pos + idx;
                            const to = from + preview.length;
                            tr.addMark(from, to, annotationMark.create({ annotationId: ann.id }));
                            tr.setMeta('addToHistory', false);
                            applied++;
                            found = true;
                        }
                    });
                }

                if (applied > 0) {
                    editor.view.dispatch(tr);
                    console.log(`[Annotation] Restored ${applied} mark(s)`);
                }
            });
        };

        window.addEventListener('annotation:marks:restore', handleRestore);

        const handleClear = () => {
            const annotationMark = editor.schema.marks.annotation;
            if (!annotationMark) return;
            const { doc } = editor.state;
            const tr = editor.state.tr;
            let cleared = 0;
            doc.descendants((node, pos) => {
                if (!node.isText) return;
                node.marks.forEach(mark => {
                    if (mark.type === annotationMark) {
                        tr.removeMark(pos, pos + node.nodeSize, annotationMark);
                        cleared++;
                    }
                });
            });
            if (cleared > 0) {
                tr.setMeta('addToHistory', false);
                editor.view.dispatch(tr);
                console.log(`[Annotation] Cleared ${cleared} mark(s)`);
            }
        };
        window.addEventListener('annotation:marks:clear', handleClear);

        return () => {
            window.removeEventListener('annotation:marks:restore', handleRestore);
            window.removeEventListener('annotation:marks:clear', handleClear);
        };
    }, [editor]);

    // 添加批注
    const handleAddAnnotation = async () => {
        if (!editor || annotationSubmitting) return;
        const content = annotationText.trim();
        if (!content) return;

        const { state } = editor;
        const { from, to, empty } = state.selection;
        if (empty) return;
        const selectedText = state.doc.textBetween(from, to, ' ').trim();
        if (!selectedText) return;

        const config = syncService.getConfig();
        if (!config) { console.warn('[Annotation] syncService not configured'); return; }

        const anchorId = btoa(encodeURIComponent(selectedText.slice(0, 50))).replace(/=/g, '');
        const teamVaultId = useSessionStore.getState().teamVaultId;
        const vaultId = teamVaultId || config.vaultId;

        const PARA_MAP: Record<string, string> = {
            '01_Projects': '01_PROJECTS',
            '02_Areas': '02_AREAS',
            '03_Resources': '03_RESOURCE',
            '04_Archives': '04_ARCHIVE',
        };
        const vaultRoot = (window as any).__slashVaultPath || '';
        let rawPath: string = noteCtx?.noteIdRef.current || '';
        const parsedTeamNote = parseTeamNoteId(rawPath);
        let filePath = parsedTeamNote.filePath ?? normalizePath(rawPath);
        let fileId: string | null = null;
        if (filePath.startsWith('__team__/')) filePath = filePath.slice('__team__/'.length);
        if (vaultRoot && filePath.startsWith(normalizePath(vaultRoot) + '/')) filePath = filePath.slice(vaultRoot.length + 1);
        if (filePath && !filePath.endsWith('.md')) filePath += '.md';
        if (teamVaultId) {
            const firstDir = filePath.split('/')[0];
            const teamDir = PARA_MAP[firstDir];
            if (teamDir) filePath = teamDir + filePath.slice(firstDir.length);
        }
        try {
            if (rawPath.startsWith('__team__/')) {
                if (parsedTeamNote.fileId) {
                    const file = await syncService.getVaultFileById(parsedTeamNote.teamVaultId || vaultId, parsedTeamNote.fileId);
                    fileId = file.fileId;
                    filePath = file.filePath;
                } else {
                    fileId = extractSlashId(await syncService.getVaultFile(vaultId, filePath));
                }
            } else if (vaultRoot || rawPath) {
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                const absPath = rawPath.startsWith(vaultRoot) ? rawPath : `${vaultRoot.replace(/\/$/, '')}/${filePath}`;
                fileId = extractSlashId(await readTextFile(absPath));
            }
        } catch {
            fileId = null;
        }

        setAnnotationSubmitting(true);
        try {
            const id = await annotationService.createAnnotation(vaultId, filePath, anchorId, selectedText, content, undefined, fileId);

            const annotationMark = editor.schema.marks.annotation;
            if (annotationMark) {
                const tr = editor.state.tr;
                tr.addMark(from, to, annotationMark.create({ annotationId: id }));
                tr.setMeta('addToHistory', false);
                editor.view.dispatch(tr);
            }

            window.dispatchEvent(new CustomEvent('annotation:reload'));

            setAnnotating(false);
            setAnnotationText('');
            setVisible(false);
        } catch (e) {
            console.error('[AIBubbleMenu] Annotation submit failed:', e);
        } finally {
            setAnnotationSubmitting(false);
        }
    };

    if (!visible || !editor || !isTeamNote) return null;

    const selectedPreview = (() => {
        const { from, to, empty } = editor.state.selection;
        if (empty) return '';
        const text = editor.state.doc.textBetween(from, to, ' ');
        return text.length > 60 ? text.slice(0, 60) + '…' : text;
    })();

    return (
        <div
            ref={menuRef}
            className="ai-bubble-menu"
            style={{
                top: `${position.top}px`,
                left: `${position.left}px`,
            }}
            onMouseDown={(e) => e.preventDefault()}
        >
            <div className="ai-bubble-buttons">
                {/* 💬 批注按钮 */}
                <button
                    className={`ai-bubble-trigger ${annotating ? 'ai-bubble-trigger--active' : ''}`}
                    onClick={() => {
                        const next = !annotating;
                        setAnnotating(next);
                        if (next) setTimeout(() => textareaRef.current?.focus(), 50);
                    }}
                    title={t('annotations.add', '添加批注')}
                >
                    💬
                </button>
            </div>

            {/* 批注内联输入面板 */}
            {annotating && (
                <div className="ai-annotation-panel">
                    {selectedPreview && (
                        <div className="ai-annotation-preview">
                            "{selectedPreview}"
                        </div>
                    )}
                    <textarea
                        ref={textareaRef}
                        value={annotationText}
                        onChange={e => setAnnotationText(e.target.value)}
                        onMouseDown={e => e.stopPropagation()}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddAnnotation(); }
                            if (e.key === 'Escape') { setAnnotating(false); setAnnotationText(''); }
                        }}
                        placeholder={t('annotations.input_placeholder', '写一条批注... (Enter 提交)')}
                        className="ai-annotation-input"
                        rows={2}
                    />
                    <div className="ai-annotation-actions">
                        <button
                            className="ai-annotation-cancel"
                            onClick={() => { setAnnotating(false); setAnnotationText(''); }}
                        >
                            {t('annotations.cancel', '取消')}
                        </button>
                        <button
                            className="ai-annotation-submit"
                            onClick={handleAddAnnotation}
                            disabled={!annotationText.trim() || annotationSubmitting}
                        >
                            {annotationSubmitting ? '...' : t('annotations.send', '发送')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
