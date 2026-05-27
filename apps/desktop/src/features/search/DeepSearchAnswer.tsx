import { Brain, Clock, FileText, Loader2, ExternalLink } from 'lucide-react';
import React from 'react';

// Types matching Rust backend
interface NoteReference {
    path: string;
    title: string;
    excerpt: string | null;
}

interface DeepSearchResult {
    answer: string;
    references: NoteReference[];
    total_time_ms: number;
    context_notes_count: number;
}

interface DeepSearchAnswerProps {
    result: DeepSearchResult | null;
    loading: boolean;
    error: string | null;
    onOpenNote: (notePath: string) => void;
    vaultPath: string;
    t: (key: string) => string;
}

/**
 * Lightweight inline renderer: handles **bold**, [[note links]], and plain text.
 * No external markdown library needed.
 */
function renderInline(
    text: string,
    references: NoteReference[],
    onOpenNote: (path: string) => void,
    vaultPath: string,
): React.ReactNode[] {
    // Match **bold** and [[note]] patterns
    const pattern = /(\*\*.+?\*\*|\[\[.+?\]\])/g;
    const parts = text.split(pattern);
    return parts.map((part, i) => {
        // Bold
        const boldMatch = part.match(/^\*\*(.+?)\*\*$/);
        if (boldMatch) {
            return <strong key={i} className="text-white">{boldMatch[1]}</strong>;
        }
        // Note link
        const linkMatch = part.match(/^\[\[(.+?)\]\]$/);
        if (linkMatch) {
            const noteTitle = linkMatch[1].trim();
            const ref = references.find(
                r => r.title === noteTitle || r.title.includes(noteTitle) || noteTitle.includes(r.title)
            );
            if (ref) {
                return (
                    <button
                        key={i}
                        onClick={() => onOpenNote(`${vaultPath}/${ref.path}`)}
                        className="inline-flex items-center align-text-bottom text-violet-400 hover:text-violet-300 cursor-pointer mx-0.5"
                        title={noteTitle}
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                );
            }
            // No matching ref found — render as plain icon without click
            return (
                <span key={i} className="inline-flex items-center align-text-bottom text-gray-500 mx-0.5" title={noteTitle}>
                    <ExternalLink className="w-3.5 h-3.5" />
                </span>
            );
        }
        return <span key={i}>{part}</span>;
    });
}

/**
 * Render answer text as structured blocks: paragraphs, headings, and list items.
 */
function renderAnswer(
    text: string,
    references: NoteReference[],
    onOpenNote: (path: string) => void,
    vaultPath: string,
): React.ReactNode[] {
    const lines = text.split('\n');
    const blocks: React.ReactNode[] = [];
    let listItems: string[] = [];
    let key = 0;

    const flushList = () => {
        if (listItems.length === 0) return;
        blocks.push(
            <ul key={key++} className="list-disc pl-5 space-y-1 mb-2">
                {listItems.map((item, i) => (
                    <li key={i} className="text-sm text-gray-300">
                        {renderInline(item, references, onOpenNote, vaultPath)}
                    </li>
                ))}
            </ul>
        );
        listItems = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            flushList();
            continue;
        }

        // Heading (## or ###)
        const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            flushList();
            const level = headingMatch[1].length;
            const cls = level <= 2
                ? 'text-sm font-semibold text-white mt-3 mb-1'
                : 'text-sm font-medium text-gray-200 mt-2 mb-1';
            blocks.push(
                <div key={key++} className={cls}>
                    {renderInline(headingMatch[2], references, onOpenNote, vaultPath)}
                </div>
            );
            continue;
        }

        // List item (- or *)
        const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (listMatch) {
            listItems.push(listMatch[1]);
            continue;
        }

        // Numbered list (1. 2. etc.)
        const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (numberedMatch) {
            listItems.push(numberedMatch[1]);
            continue;
        }

        // Plain paragraph
        flushList();
        blocks.push(
            <p key={key++} className="text-sm text-gray-300 mb-2 last:mb-0">
                {renderInline(trimmed, references, onOpenNote, vaultPath)}
            </p>
        );
    }

    flushList();
    return blocks;
}

export function DeepSearchAnswer({
    result,
    loading,
    error,
    onOpenNote,
    vaultPath,
    t,
}: DeepSearchAnswerProps) {

    if (loading) {
        return (
            <div className="px-4 py-4 bg-gradient-to-b from-violet-500/5 to-transparent">
                <div className="flex items-center gap-3 text-violet-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <div>
                        <p className="text-sm font-medium">{t('search.insight_loading')}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                            {t('search.insight_loading_hint')}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="px-4 py-3 bg-red-500/5">
                <div className="flex items-center gap-2 text-red-400 text-sm">
                    <Brain className="w-4 h-4" />
                    <p>{t('search.insight_error')}</p>
                </div>
            </div>
        );
    }

    if (!result) {
        return null;
    }

    return (
        <div className="px-4 py-4 bg-gradient-to-b from-violet-500/5 to-transparent">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-violet-400">
                    <Brain className="w-4 h-4" />
                    <span className="text-xs font-medium">{t('search.insight_title')}</span>
                </div>
                <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <Clock className="w-3 h-3" />
                    {result.total_time_ms}ms
                </span>
            </div>

            {/* Answer Content - lightweight renderer */}
            <div className="leading-relaxed">
                {renderAnswer(result.answer, result.references, onOpenNote, vaultPath)}
            </div>

            {/* References - horizontal pill row */}
            {result.references.length > 0 && (() => {
                const seen = new Set<string>();
                const uniqueRefs = result.references.filter(r => {
                    if (seen.has(r.path)) return false;
                    seen.add(r.path);
                    return true;
                });
                return (
                <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-white/5">
                    <span className="text-[10px] text-gray-500 mr-1">{t('search.insight_references')}</span>
                    {uniqueRefs.map((ref) => (
                        <button
                            key={ref.path}
                            onClick={() => onOpenNote(`${vaultPath}/${ref.path}`)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 text-[11px] hover:bg-violet-500/20 transition-colors cursor-pointer"
                            title={ref.excerpt || ref.title}
                        >
                            <FileText className="w-3 h-3" />
                            {ref.title}
                        </button>
                    ))}
                </div>
                );
            })()}
        </div>
    );
}
