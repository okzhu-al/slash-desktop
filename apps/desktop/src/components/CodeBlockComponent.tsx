import { NodeViewWrapper } from '@tiptap/react';
import { Check, Copy, Code, Eye } from 'lucide-react';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import mermaid from 'mermaid';
import { SUPPORTED_LANGUAGES } from '@slash/editor-core';

// Initialize mermaid with default config
mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
});

const writeClipboardText = async (text: string) => {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (error) {
        console.warn('[CodeBlock] navigator.clipboard.writeText failed, falling back.', error);
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (!copied) {
        throw new Error('Fallback clipboard copy failed');
    }
};

export const CodeBlockComponent: React.FC<any> = ({
    node: {
        attrs: { language: defaultLanguage },
    },
    node,
    updateAttributes,
    editor,
    getPos,
}) => {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🚀 Lazy NodeView: 渐进式渲染
    // Shell 阶段：仅渲染 <pre><code/> 骨架（~0.1ms）
    // Full 阶段：进入 viewport 后激活完整 UI（toolbar, mermaid 等）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const [isActivated, setIsActivated] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    // IntersectionObserver: viewport 内 200px 时激活，一次性不回退
    useEffect(() => {
        if (isActivated) return;
        const el = wrapperRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsActivated(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '200px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [isActivated]);

    // ━━━━━━━━━ 以下所有 hooks 保持调用顺序，用 isActivated 门控逻辑 ━━━━━━━━━

    const [copied, setCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [mermaidSvg, setMermaidSvg] = useState<string | null>(null);
    const [mermaidError, setMermaidError] = useState<string | null>(null);
    const mermaidRef = useRef<HTMLDivElement>(null);

    const isMermaid = defaultLanguage === 'mermaid';

    // Render mermaid diagram when content changes — 门控：仅激活后执行
    const currentMermaidId = useRef<string | null>(null);

    useEffect(() => {
        if (!isActivated) return; // 🚀 未激活时跳过
        if (!isMermaid) return;

        if (isEditing) {
            setMermaidSvg(prev => prev === null ? prev : null);
            setMermaidError(prev => prev === null ? prev : null);
            return;
        }

        const content = node.textContent?.trim();
        if (!content) {
            setMermaidSvg(prev => prev === null ? prev : null);
            setMermaidError(prev => prev === null ? prev : null);
            return;
        }

        let cancelled = false;

        const renderMermaid = async () => {
            try {
                let sanitizedContent = content;
                if (sanitizedContent.startsWith('```')) {
                    sanitizedContent = sanitizedContent.replace(/^```\w*\n?/, '');
                }
                if (sanitizedContent.endsWith('```')) {
                    sanitizedContent = sanitizedContent.replace(/```$/, '');
                }
                sanitizedContent = sanitizedContent.trim();

                if (!sanitizedContent) {
                    setMermaidSvg(prev => prev === null ? prev : null);
                    setMermaidError(prev => prev === null ? prev : null);
                    return;
                }

                const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;

                try {
                    await mermaid.parse(sanitizedContent);
                } catch (parseError: any) {
                    if (cancelled) return;
                    const errorMessage = parseError.message || parseError.toString() || 'Invalid diagram syntax';
                    setMermaidError(errorMessage.length > 200 ? errorMessage.substring(0, 200) + '...' : errorMessage);
                    setMermaidSvg(null);
                    return;
                }

                const { svg } = await mermaid.render(id, sanitizedContent);

                if (cancelled) return;

                if (currentMermaidId.current) {
                    const oldElement = document.getElementById(currentMermaidId.current);
                    oldElement?.remove();
                }

                currentMermaidId.current = id;
                setMermaidSvg(svg);
                setMermaidError(null);
            } catch (e: any) {
                if (cancelled) return;
                console.error('Mermaid render error:', e);
                const errorMessage = e.message || e.toString() || 'Failed to render diagram';
                setMermaidError(errorMessage.length > 200 ? errorMessage.substring(0, 200) + '...' : errorMessage);
                setMermaidSvg(null);
            }
        };

        renderMermaid();

        return () => {
            cancelled = true;
            if (currentMermaidId.current) {
                const element = document.getElementById(currentMermaidId.current);
                element?.remove();
                currentMermaidId.current = null;
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActivated, isMermaid, isEditing, isMermaid ? node.textContent : null]);

    const handleCopy = async (event?: React.MouseEvent) => {
        event?.preventDefault();
        event?.stopPropagation();

        const code = node.textContent || wrapperRef.current?.querySelector('code')?.textContent || '';
        if (code) {
            await writeClipboardText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const toggleEdit = () => {
        setIsEditing(!isEditing);
    };

    const [isSelected, setIsSelected] = useState(false);

    // 监控系统的光标是否命中当前 SVG 块 — 门控：仅激活后执行
    useEffect(() => {
        if (!isActivated) return; // 🚀 未激活时跳过
        if (!isMermaid || isEditing || !editor || typeof getPos !== 'function') return;

        const handleSelectionUpdate = () => {
            const { $anchor } = editor.state.selection;
            const pos = getPos();
            const inside = $anchor.pos >= pos && $anchor.pos <= pos + node.nodeSize;
            setIsSelected(inside);
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                const { $anchor } = editor.state.selection;
                const pos = getPos();
                if ($anchor.pos >= pos && $anchor.pos <= pos + node.nodeSize) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log(`[Mermaid] Caught ${e.key} while selected. Deleting node!`);
                    editor.commands.deleteNode('codeBlock');
                }
            }
        };

        editor.on('selectionUpdate', handleSelectionUpdate);
        handleSelectionUpdate();

        const editorDOM = editor.view.dom;
        editorDOM.addEventListener('keydown', handleKeyDown, true);

        return () => {
            editor.off('selectionUpdate', handleSelectionUpdate);
            editorDOM.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [isActivated, isMermaid, isEditing, editor, getPos, node]);

    const showMermaidOverlay = isMermaid && !isEditing && (mermaidSvg || mermaidError);

    // 🛡️ Memoized toolbar — 门控：仅激活后渲染
    const toolbarElement = useMemo(() => {
        if (!isActivated) return null; // 🚀 未激活时不渲染 Lucide 图标
        if (showMermaidOverlay) return null;
        return (
            <div
                className="code-block-toolbar absolute right-2 top-2 z-50 flex items-center gap-2"
                style={{
                    opacity: 0,
                    transition: 'opacity 0.15s ease',
                    pointerEvents: 'none'
                }}
                contentEditable={false}
            >
                {isMermaid && (
                    <button
                        onClick={toggleEdit}
                        className="bg-zinc-800/90 text-zinc-300 p-1.5 rounded border border-zinc-700 hover:bg-zinc-700 transition-colors flex items-center gap-1"
                        style={{ pointerEvents: 'auto' }}
                        title="Preview diagram"
                    >
                        <Eye size={14} />
                        <span className="text-xs">Preview</span>
                    </button>
                )}
                <select
                    contentEditable={false}
                    className="bg-zinc-800/90 text-zinc-300 text-xs rounded border border-zinc-700 px-2 py-1 outline-none hover:bg-zinc-700 transition-colors cursor-pointer appearance-none"
                    style={{ pointerEvents: 'auto' }}
                    value={defaultLanguage || ''}
                    onChange={event => updateAttributes({ language: event.target.value })}
                >
                    <option value="">auto</option>
                    <option disabled>—</option>
                    {SUPPORTED_LANGUAGES.map((lang: string, index: number) => (
                        <option key={index} value={lang}>
                            {lang}
                        </option>
                    ))}
                </select>

                <button
                    onClick={handleCopy}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    className="bg-zinc-800/90 text-zinc-300 p-1.5 rounded border border-zinc-700 hover:bg-zinc-700 transition-colors"
                    style={{ pointerEvents: 'auto' }}
                    title="Copy code"
                >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </button>
            </div>
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActivated, defaultLanguage, copied, isMermaid, isEditing, showMermaidOverlay]);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 单一 return 路径：<pre><code/> 始终在同一 DOM 位置
    // Shell 阶段仅隐藏 toolbar/mermaid，不改变 DOM 结构
    // 避免 React 卸载重建 contentDOM 导致 ProseMirror 丢失引用
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const activeShowMermaidOverlay = isActivated && showMermaidOverlay;

    return (
        <NodeViewWrapper
            ref={wrapperRef}
            className={activeShowMermaidOverlay
                ? `mermaid-block relative group my-4 rounded-xl transition-all bg-white dark:bg-zinc-900 border-2 ${isSelected ? 'border-blue-500' : 'border-transparent'}`
                : 'code-block relative group'
            }
            style={activeShowMermaidOverlay ? { caretColor: 'transparent' } : undefined}
        >
            {/* Mermaid rendered overlay — 仅激活后渲染 */}
            {activeShowMermaidOverlay && (
                <>
                    {/* 物理强制拦截鼠标光标点击原生映射，手动引导到安全位置 */}
                    <div
                        className="absolute inset-0 z-40 cursor-pointer"
                        onMouseDown={(e) => {
                            e.preventDefault();
                            if (typeof getPos === 'function') {
                                editor.commands.setTextSelection(getPos() + 1);
                            }
                        }}
                    />

                    {/* Mermaid Toolbar */}
                    <div
                        className="mermaid-toolbar absolute right-2 top-2 z-50 flex items-center gap-2"
                        style={{ opacity: 0, transition: 'opacity 0.15s ease' }}
                        contentEditable={false}
                    >
                        <button
                            onClick={toggleEdit}
                            className="bg-zinc-800/90 text-zinc-300 p-1.5 rounded border border-zinc-700 hover:bg-zinc-700 transition-colors flex items-center gap-1"
                            title="Edit code"
                        >
                            <Code size={14} />
                            <span className="text-xs">Edit</span>
                        </button>
                        <button
                            onClick={handleCopy}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            className="bg-zinc-800/90 text-zinc-300 p-1.5 rounded border border-zinc-700 hover:bg-zinc-700 transition-colors"
                            title="Copy code"
                        >
                            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        </button>
                    </div>

                    {/* Rendered diagram */}
                    <div
                        ref={mermaidRef}
                        className="mermaid-container overflow-auto"
                        contentEditable={false}
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                        {mermaidError ? (
                            <div className="text-red-500 text-sm p-2 bg-red-50 dark:bg-red-900/20 rounded">
                                <div className="font-medium mb-1">Diagram Error</div>
                                <pre className="text-xs whitespace-pre-wrap">{mermaidError}</pre>
                            </div>
                        ) : (
                            <div
                                className="mermaid-svg flex justify-center"
                                dangerouslySetInnerHTML={{ __html: mermaidSvg || '' }}
                            />
                        )}
                    </div>
                </>
            )}

            {/* 🛡️ Memoized toolbar — 仅激活后渲染 */}
            {isActivated && toolbarElement}

            {/* 唯一的内容出口：始终渲染，Mermaid 渲染模式下通过 CSS 隐藏 */}
            <pre
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={activeShowMermaidOverlay ? { position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0 } : undefined}
            >
                <code data-node-view-content="" />
            </pre>
        </NodeViewWrapper>
    );
};
