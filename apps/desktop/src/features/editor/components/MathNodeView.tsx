import React from 'react';
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '@/shared/utils/cn';

/**
 * MathNodeView - Display-only math formula component
 * 
 * Editing is handled via Backspace which converts the node to $latex$ text.
 * This component only renders the KaTeX formula.
 */
export const MathNodeView: React.FC<NodeViewProps> = ({ node, selected }) => {
    const latex = node.attrs.latex || '';

    // Render KaTeX formula
    const renderedMath = () => {
        if (!latex || latex.trim() === '') {
            return `<span class="text-gray-500 font-mono text-xs">Empty Math</span>`;
        }
        try {
            return katex.renderToString(latex, {
                throwOnError: false,
                displayMode: false,
            });
        } catch (e) {
            return `<span class="text-red-500 font-bold text-xs">Error: ${(e as Error).message}</span>`;
        }
    };

    return (
        <NodeViewWrapper className="inline-flex items-center align-middle mx-1 relative select-none">
            <span
                className={cn(
                    "inline-block min-w-[10px] min-h-[1em] rounded px-0.5 transition-colors",
                    selected
                        ? "bg-blue-100 dark:bg-blue-900/40"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                )}
                dangerouslySetInnerHTML={{ __html: renderedMath() }}
            />
        </NodeViewWrapper>
    );
};