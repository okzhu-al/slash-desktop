/**
 * AIRangeSelector — AI 技能范围选择器
 *
 * 从斜杠命令选择 AI 技能后进入此模式：
 * 1. 高亮默认段落范围（ProseMirror Decoration）
 * 2. 首尾竖线手柄可拖动（段落级 snap）
 * 3. 浮窗显示技能名 + ✓确认 + ✕取消
 * 4. 确认后提取文本 → 执行 AI 流式输出
 */

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DynamicSkillConfig } from '@/services/CustomSkillService';
import { useTranslation } from 'react-i18next';
import './AIRangeSelector.css';

const AI_RANGE_PLUGIN_KEY = new PluginKey('aiRangeSelector');
const AI_RANGE_META = 'ai-range-update';

interface AIRangeSelectorProps {
    editor: Editor;
    skill: DynamicSkillConfig;
    initialFrom: number;
    initialTo: number;
    insertPos?: number;
    onDone: () => void;
    customSkillService: {
        executeCustomSkill: (id: string, content: string, notePath?: string) => Promise<any>;
        onSkillCompleted: (cb: (result: any) => void) => Promise<() => void>;
        onSkillChunk: (cb: (data: any) => void) => Promise<() => void>;
    };
    notePath?: string;
}

// ────────────────────────────────────────
// 段落级范围工具
/** 向上找 textblock 祖先；若 pos 在列表容器等非 textblock 位置，向前查找最近的 textblock */
function snapToParagraphStart(editor: Editor, pos: number): number {
    const doc = editor.state.doc;
    const resolved = doc.resolve(pos);

    // 1. 向上查找 textblock 祖先
    for (let d = resolved.depth; d > 0; d--) {
        if (resolved.node(d).isTextblock) {
            return resolved.before(d) + 1;
        }
    }

    // 2. 落在容器节点（如 bulletList）→ 向前找第一个 textblock
    let result = pos;
    const searchEnd = Math.min(pos + 200, doc.content.size);
    doc.nodesBetween(pos, searchEnd, (node, nodePos) => {
        if (node.isTextblock && result === pos) {
            result = nodePos + 1; // +1 跳过开标签
            return false;
        }
    });
    return result;
}

/** 向上找 textblock 祖先；若 pos 在列表容器等非 textblock 位置，向后查找最后一个 textblock */
function snapToParagraphEnd(editor: Editor, pos: number): number {
    const doc = editor.state.doc;
    const resolved = doc.resolve(pos);

    for (let d = resolved.depth; d > 0; d--) {
        if (resolved.node(d).isTextblock) {
            return resolved.after(d) - 1;
        }
    }

    // 落在容器节点 → 向前搜索最后一个 textblock（在 pos 之前）
    let result = pos;
    const searchStart = Math.max(0, pos - 200);
    doc.nodesBetween(searchStart, pos, (node, nodePos) => {
        if (node.isTextblock) {
            result = nodePos + node.nodeSize - 1; // -1 跳过闭标签
        }
    });
    return result;
}

function getParagraphPosAtCoords(editor: Editor, x: number, y: number, side: 'start' | 'end'): number | null {
    const posInfo = editor.view.posAtCoords({ left: x, top: y });
    if (!posInfo) return null;
    return side === 'start'
        ? snapToParagraphStart(editor, posInfo.pos)
        : snapToParagraphEnd(editor, posInfo.pos);
}

function getElementScale(element: Element) {
    const rect = element.getBoundingClientRect();
    const htmlElement = element as HTMLElement;
    return {
        x: htmlElement.offsetWidth ? rect.width / htmlElement.offsetWidth : 1,
        y: htmlElement.offsetHeight ? rect.height / htmlElement.offsetHeight : 1,
    };
}

export function AIRangeSelector({
    editor,
    skill,
    initialFrom,
    initialTo,
    insertPos,
    onDone,
    customSkillService,
    notePath = '',
}: AIRangeSelectorProps) {
    const { t } = useTranslation();
    const [rangeFrom, setRangeFrom] = useState(initialFrom);
    const [rangeTo, setRangeTo] = useState(initialTo);
    const [executing, setExecuting] = useState(false);
    const [dragging, setDragging] = useState<'start' | 'end' | null>(null);

    const [startHandlePos, setStartHandlePos] = useState({ top: 0, left: 0, height: 0 });
    const [endHandlePos, setEndHandlePos] = useState({ top: 0, left: 0, height: 0 });
    const [toolbarPos, setToolbarPos] = useState({ top: 0, left: 0 });
    const [positionsReady, setPositionsReady] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const pluginRef = useRef<Plugin | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const rangeRef = useRef({ from: initialFrom, to: initialTo });

    // 同步 ref（供事件回调读取最新值）
    rangeRef.current = { from: rangeFrom, to: rangeTo };

    // ── 稳定的 Decoration 插件：只注册一次，通过 meta 更新范围 ──
    useEffect(() => {
        if (!editor || editor.isDestroyed) return;

        const plugin = new Plugin({
            key: AI_RANGE_PLUGIN_KEY,
            state: {
                init() {
                    return { from: initialFrom, to: initialTo };
                },
                apply(tr, value) {
                    const meta = tr.getMeta(AI_RANGE_META);
                    if (meta) return meta;
                    if (tr.docChanged) {
                        return {
                            from: tr.mapping.map(value.from),
                            to: tr.mapping.map(value.to),
                        };
                    }
                    return value;
                },
            },
            props: {
                decorations(state) {
                    const pluginState = AI_RANGE_PLUGIN_KEY.getState(state) as { from: number; to: number } | undefined;
                    if (!pluginState) return DecorationSet.empty;
                    const { from, to } = pluginState;
                    const docSize = state.doc.content.size;
                    const sf = Math.max(0, Math.min(from, docSize));
                    const st = Math.max(sf, Math.min(to, docSize));
                    if (sf >= st) return DecorationSet.empty;
                    return DecorationSet.create(state.doc, [
                        Decoration.inline(sf, st, { class: 'ai-range-highlight' }),
                    ]);
                },
            },
        });

        pluginRef.current = plugin;
        editor.registerPlugin(plugin);

        return () => {
            if (pluginRef.current) {
                try { editor.unregisterPlugin(AI_RANGE_PLUGIN_KEY); } catch { /* ok */ }
                pluginRef.current = null;
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor]);

    // ── range 变化时通过 meta 更新 decoration（不再注销/重注册 Plugin）──
    useEffect(() => {
        if (!editor || editor.isDestroyed || !pluginRef.current) return;
        const tr = editor.state.tr;
        tr.setMeta(AI_RANGE_META, { from: rangeFrom, to: rangeTo });
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
    }, [editor, rangeFrom, rangeTo]);

    // ── 计算手柄和工具条位置 ──
    const updatePositions = useCallback(() => {
        if (!editor || editor.isDestroyed) return;
        const view = editor.view;
        const editorEl = view.dom.closest('.editor-content-area') || view.dom;
        const editorRect = editorEl.getBoundingClientRect();
        const scale = getElementScale(editorEl);
        const scaleX = scale.x || 1;
        const scaleY = scale.y || 1;

        const docSize = editor.state.doc.content.size;
        const safeFrom = Math.max(0, Math.min(rangeRef.current.from, docSize));
        const safeTo = Math.max(safeFrom, Math.min(rangeRef.current.to, docSize));

        try {
            const startCoords = view.coordsAtPos(safeFrom);
            const endCoords = view.coordsAtPos(safeTo);

            const sHeight = startCoords.bottom - startCoords.top;
            const eHeight = endCoords.bottom - endCoords.top;



            // 最小高度保护
            const minHeight = 16;
            setStartHandlePos({
                top: (startCoords.top - editorRect.top) / scaleY,
                left: (startCoords.left - editorRect.left) / scaleX,
                height: Math.max(sHeight / scaleY, minHeight),
            });
            setEndHandlePos({
                top: (endCoords.top - editorRect.top) / scaleY,
                left: (endCoords.right - editorRect.left) / scaleX,
                height: Math.max(eHeight / scaleY, minHeight),
            });

            const sLeft = (startCoords.left - editorRect.left) / scaleX;
            const eLeft = (endCoords.right - editorRect.left) / scaleX;
            const midX = (sLeft + eLeft) / 2;
            setToolbarPos({
                top: ((startCoords.top - editorRect.top) / scaleY) - 40,
                left: Math.max(0, Math.min(midX - 60, (editorRect.width / scaleX) - 180)),
            });
            setPositionsReady(true);
        } catch (err) {
            console.warn('[AIRange] ⚠️ updatePositions error:', err);
        }
    }, [editor]);

    // 首次 + range 变化时同步定位
    useLayoutEffect(() => {
        updatePositions();
    }, [updatePositions, rangeFrom, rangeTo]);

    // 滚动时更新
    useEffect(() => {
        const editorEl = editor?.view?.dom?.closest('.editor-content-area') || editor?.view?.dom?.parentElement;
        const scrollEl = editorEl?.closest('[style*="overflow"], .overflow-auto, .overflow-y-auto') || editorEl?.parentElement;
        if (scrollEl) {
            scrollEl.addEventListener('scroll', updatePositions, { passive: true });
            return () => scrollEl.removeEventListener('scroll', updatePositions);
        }
    }, [editor, updatePositions]);

    // ── 拖拽逻辑 ──
    const handleMouseDown = useCallback((side: 'start' | 'end') => (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(side);

        const onMouseMove = (ev: MouseEvent) => {
            const newPos = getParagraphPosAtCoords(editor, ev.clientX, ev.clientY, side);
            if (newPos === null) return;



            if (side === 'start') {
                setRangeFrom(Math.min(newPos, rangeRef.current.to - 1));
            } else {
                setRangeTo(Math.max(newPos, rangeRef.current.from + 1));
            }
        };

        const onMouseUp = () => {
            setDragging(null);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, [editor]);

    // ── 取消 ──
    const handleCancel = useCallback(() => {
        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        onDone();
    }, [onDone]);

    // Escape 取消
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !executing) handleCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handleCancel, executing]);

    // ── 确认执行 AI ──
    const handleConfirm = useCallback(async () => {
        if (!editor || executing) return;

        const safeFrom = Math.max(0, Math.min(rangeFrom, editor.state.doc.content.size));
        const safeTo = Math.max(safeFrom, Math.min(rangeTo, editor.state.doc.content.size));
        const selectedText = editor.state.doc.textBetween(safeFrom, safeTo, '\n');

        if (!selectedText.trim()) {
            handleCancel();
            return;
        }

        setExecuting(true);
        editor.setEditable(false);

        // 移除 decoration
        if (pluginRef.current) {
            try { editor.unregisterPlugin(AI_RANGE_PLUGIN_KEY); } catch { /* ok */ }
            pluginRef.current = null;
        }

        // shimmer
        const shimmerType = editor.schema.marks.aiShimmer;
        if (shimmerType) {
            const tr = editor.state.tr;
            tr.addMark(safeFrom, safeTo, shimmerType.create());
            tr.setMeta('addToHistory', false);
            editor.view.dispatch(tr);
        }

        // 流式输出
        let isFirstChunk = true;
        let fullText = '';
        let currentInsertPos = insertPos !== undefined ? insertPos : safeTo;

        const unlistenChunk = await customSkillService.onSkillChunk(({ skill_id, chunk }: any) => {
            if (skill_id !== skill.id) return;
            fullText += chunk;

            const tr = editor.state.tr;
            let safeInsert = Math.min(currentInsertPos, tr.doc.content.size);

            if (isFirstChunk) {
                // 不替换原文，只在光标位置开始附加
                tr.insertText(chunk, safeInsert);
                currentInsertPos = tr.mapping.map(safeInsert, 1);
                isFirstChunk = false;
            } else {
                tr.insertText(chunk, safeInsert);
                currentInsertPos = tr.mapping.map(safeInsert, 1);
            }
            tr.setMeta('addToHistory', false);
            editor.view.dispatch(tr);
        });

        const unlistenComplete = await customSkillService.onSkillCompleted((result: any) => {
            if (result.skill_id !== skill.id) return;

            if (result.status === 'error' && result.error) {
                console.error(`[AIRangeSelector] ${skill.name} failed:`, result.error);
                const tr = editor.state.tr;
                if (shimmerType) tr.removeMark(0, tr.doc.content.size, shimmerType);
                
                // 如果发生错误且不是首次块，意味着已插入部分乱码，需要清理掉已插入的内容
                if (!isFirstChunk) {
                    const originalPos = insertPos !== undefined ? insertPos : safeTo;
                    const endPos = Math.min(currentInsertPos, tr.doc.content.size);
                    if (endPos > originalPos) tr.delete(originalPos, endPos);
                }
                tr.setMeta('addToHistory', false);
                editor.view.dispatch(tr);
            } else if (fullText) {
                const tr1 = editor.state.tr;
                if (shimmerType) tr1.removeMark(0, tr1.doc.content.size, shimmerType);
                
                // 1. 删除流式追加的纯文本字符
                const originalPos = insertPos !== undefined ? insertPos : safeTo;
                const endPos = Math.min(currentInsertPos, tr1.doc.content.size);
                if (endPos > originalPos) {
                    tr1.delete(originalPos, endPos);
                }
                tr1.setMeta('addToHistory', false);
                editor.view.dispatch(tr1);

                // 2. 将最终的 Markdown 字符串以 Markdown 格式解析并插入，从而生成真正可渲染的 Mermaid 图节点等富文本
                editor.commands.insertContentAt(originalPos, fullText);
            }

            editor.setEditable(true);
            unlistenChunk();
            unlistenComplete();
            onDone();
        });

        unlistenRef.current = () => { unlistenChunk(); unlistenComplete(); };

        try {
            await customSkillService.executeCustomSkill(skill.id, selectedText, notePath);
        } catch (e) {
            console.error('[AIRangeSelector] Execute failed:', e);
            editor.setEditable(true);
            unlistenChunk();
            unlistenComplete();
            onDone();
        }
    }, [editor, rangeFrom, rangeTo, skill, executing, handleCancel, customSkillService, notePath, onDone]);

    const startHandleRef = useRef<HTMLDivElement>(null);
    const endHandleRef = useRef<HTMLDivElement>(null);



    // 执行中或位置未计算时不渲染
    if (executing || !positionsReady) return null;

    return (
        <>
            {dragging && <div className="ai-range-drag-overlay" />}

            {/* Start handle */}
            <div
                ref={startHandleRef}
                className={`ai-range-handle ${dragging === 'start' ? 'dragging' : ''}`}
                style={{
                    top: `${startHandlePos.top}px`,
                    left: `${startHandlePos.left}px`,
                    height: `${startHandlePos.height}px`,
                }}
                onMouseDown={handleMouseDown('start')}
            >
                <div className="ai-range-handle-dot-top" />
                <div className="ai-range-handle-dot-bottom" />
            </div>

            {/* End handle */}
            <div
                ref={endHandleRef}
                className={`ai-range-handle ${dragging === 'end' ? 'dragging' : ''}`}
                style={{
                    top: `${endHandlePos.top}px`,
                    left: `${endHandlePos.left}px`,
                    height: `${endHandlePos.height}px`,
                }}
                onMouseDown={handleMouseDown('end')}
            >
                <div className="ai-range-handle-dot-top" />
                <div className="ai-range-handle-dot-bottom" />
            </div>

            {/* Toolbar */}
            <div
                ref={containerRef}
                className="ai-range-toolbar"
                style={{
                    top: `${toolbarPos.top}px`,
                    left: `${toolbarPos.left}px`,
                }}
                onMouseDown={e => e.preventDefault()}
            >
                <span className="ai-range-toolbar-skill">
                    ✨ {skill.name}
                </span>
                <button
                    className="ai-range-toolbar-btn ai-range-toolbar-confirm"
                    onClick={handleConfirm}
                    title={t('aiRange.confirm', '确认施法')}
                >
                    ✓
                </button>
                <button
                    className="ai-range-toolbar-btn ai-range-toolbar-cancel"
                    onClick={handleCancel}
                    title={t('aiRange.cancel', '取消')}
                >
                    ✕
                </button>
            </div>
        </>
    );
}
