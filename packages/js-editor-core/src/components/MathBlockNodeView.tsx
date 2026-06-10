import React, { useState, useEffect, useRef } from 'react';
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '../utils/cn';
import { Sigma, Check, X, Keyboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * MathBlockNodeView - Interactive Math Block Component
 * 
 * Features:
 * 1. Double click or click blank placeholder to enter edit mode.
 * 2. Real-time KaTeX rendering preview.
 * 3. HSL fine-tuned modern visual aesthetics.
 * 4. Cmd/Ctrl + Enter to save, Esc to cancel.
 * 5. Smooth micro-animations and transition states.
 */
export const MathBlockNodeView: React.FC<NodeViewProps> = ({ node, updateAttributes, selected }) => {
    const { t } = useTranslation();
    const latex = node.attrs.latex || '';
    const [isEditing, setIsEditing] = useState(false);
    const [tempValue, setTempValue] = useState(latex);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const stopEditorMouseEvent = (e: React.SyntheticEvent) => {
        e.stopPropagation();
    };

    useEffect(() => {
        if (selected && !latex.trim()) {
            setIsEditing(true);
        }
    }, [selected, latex]);

    // Focus textarea when editing starts
    useEffect(() => {
        if (isEditing) {
            setTempValue(latex);
            // Wait for DOM update
            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.focus();
                    textareaRef.current.select();
                }
            }, 50);
        }
    }, [isEditing, latex]);

    const handleSave = () => {
        updateAttributes({ latex: tempValue });
        setIsEditing(false);
    };

    const handleCancel = () => {
        setTempValue(latex);
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    };

    // Render KaTeX formula for display/preview
    const renderMath = (text: string, inline = false) => {
        if (!text || text.trim() === '') {
            return '';
        }
        try {
            return katex.renderToString(text, {
                throwOnError: false,
                strict: false,
                trust: false,
                displayMode: !inline,
            });
        } catch (e) {
            return `<span class="text-red-500 font-bold text-sm">Error: ${(e as Error).message}</span>`;
        }
    };

    return (
        <NodeViewWrapper className="my-6 w-full select-none block" contentEditable={false}>
            {isEditing ? (
                <div 
                    className={cn(
                        "w-full rounded-xl p-4 border transition-all duration-300",
                        "bg-zinc-50/80 dark:bg-zinc-900/60 backdrop-blur-md",
                        "border-zinc-200 dark:border-zinc-800",
                        "shadow-lg shadow-zinc-200/50 dark:shadow-none"
                    )}
                    contentEditable={false}
                    onPointerDownCapture={stopEditorMouseEvent}
                    onMouseDownCapture={stopEditorMouseEvent}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                            <Sigma size={14} className="text-blue-500" />
                            <span>{t('editor.math.editTitle') || '编辑 LaTeX 公式'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleCancel}
                                className={cn(
                                    "p-1 rounded-md transition-colors",
                                    "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200",
                                    "hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                                )}
                                title={t('common.cancel') || '取消 (Esc)'}
                            >
                                <X size={15} />
                            </button>
                            <button
                                onClick={handleSave}
                                className={cn(
                                    "p-1 rounded-md transition-colors",
                                    "bg-blue-500 hover:bg-blue-600 text-white shadow-sm"
                                )}
                                title={t('common.confirm') || '确认 (Cmd+Enter)'}
                            >
                                <Check size={15} />
                            </button>
                        </div>
                    </div>

                    {/* Textarea */}
                    <textarea
                        ref={textareaRef}
                        value={tempValue}
                        onChange={(e) => setTempValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPointerDownCapture={stopEditorMouseEvent}
                        onMouseDownCapture={stopEditorMouseEvent}
                        contentEditable={false}
                        placeholder={t('editor.math.placeholder') || '输入 LaTeX 公式，例如: \\sum_{i=1}^n i = \\frac{n(n+1)}{2}'}
                        className={cn(
                            "w-full min-h-[80px] max-h-[180px] p-3 rounded-lg border font-mono text-sm resize-none outline-none transition-all duration-200",
                            "bg-white dark:bg-zinc-950",
                            "border-zinc-200 dark:border-zinc-850",
                            "text-zinc-800 dark:text-zinc-200",
                            "focus:border-blue-500 dark:focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        )}
                    />

                    {/* Preview Section */}
                    {tempValue.trim() && (
                        <div className="mt-4 pt-3 border-t border-dashed border-zinc-200 dark:border-zinc-800">
                            <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-2">
                                {t('editor.math.preview') || '实时预览'}
                            </div>
                            <div 
                                className="w-full max-h-[220px] overflow-auto py-2 flex justify-center tiptap-math-render"
                                dangerouslySetInnerHTML={{ __html: renderMath(tempValue) }}
                            />
                        </div>
                    )}

                    {/* Tips */}
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-zinc-400">
                        <Keyboard size={12} />
                        <span>{t('editor.math.keyboardTip') || '按 Ctrl+Enter 保存，Esc 取消'}</span>
                    </div>
                </div>
            ) : (
                <div
                    onDoubleClick={() => setIsEditing(true)}
                    className={cn(
                        "w-full rounded-xl border transition-all duration-300 group cursor-pointer relative",
                        selected 
                            ? "border-blue-500 ring-2 ring-blue-500/10 bg-blue-50/5 dark:bg-blue-950/5" 
                            : "border-transparent hover:border-zinc-200 dark:hover:border-zinc-850",
                        "hover:shadow-md hover:shadow-zinc-100/50 dark:hover:shadow-none"
                    )}
                >
                    {latex.trim() ? (
                        <div className="p-6 flex flex-col items-center justify-center">
                            <div 
                                className="w-full overflow-x-auto py-3 flex justify-center tiptap-math-render transition-transform duration-300 group-hover:scale-[1.01]"
                                dangerouslySetInnerHTML={{ __html: renderMath(latex) }}
                            />
                            
                            {/* Hover Edit Hint overlay */}
                            <div className={cn(
                                "absolute bottom-2 right-3 text-[10px] font-semibold text-zinc-400 bg-white/80 dark:bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-250/20 shadow-sm transition-all duration-200",
                                "opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0"
                            )}>
                                {t('editor.math.doubleClickEdit') || '双击编辑公式'}
                            </div>
                        </div>
                    ) : (
                        /* Empty Placeholder styling */
                        <div 
                            onClick={() => setIsEditing(true)}
                            className={cn(
                                "p-6 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all duration-300",
                                "border-zinc-200 dark:border-zinc-800",
                                "text-zinc-400 hover:text-blue-500 hover:border-blue-300 hover:bg-blue-50/5 dark:hover:bg-blue-950/5"
                            )}
                        >
                            <Sigma size={24} className="animate-pulse" />
                            <span className="text-sm font-medium">{t('editor.math.emptyBlock') || '插入数学公式块'}</span>
                            <span className="text-[10px] text-zinc-400">{t('editor.math.clickToEdit') || '点击以输入 LaTeX'}</span>
                        </div>
                    )}
                </div>
            )}
        </NodeViewWrapper>
    );
};
