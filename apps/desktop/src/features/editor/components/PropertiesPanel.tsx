import { useState, useMemo, useRef, useEffect } from 'react';
import matter from 'gray-matter';
import { useTranslation } from 'react-i18next';
import { Tag, FileText, Pencil, Users } from 'lucide-react';
import TextareaAutosize from 'react-textarea-autosize';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/shared/utils/cn';
import { TagBadge } from './TagBadge';

interface PropertiesPanelProps {
    frontmatter: string;
    onMetadataChange: (metadata: Partial<NoteMetadata>) => void;
    // AI data from SQLite (passed from Editor/parent)
    notePath?: string;
    aiTags?: string[];
    aiSummary?: string;
    hasSummaryUpdate?: boolean; // AI has newer summary than user-edited one
    hasSummarySuggestion?: boolean; // AI has a pending summary suggestion (user hasn't confirmed)
    onAIDataChange?: () => void; // Callback to refresh AI data after accept/reject
    // For AI feedback logging
    noteContent?: string; // Note content for input_snapshot (will be truncated to 4k chars)
    modelName?: string;   // AI model name (e.g., "qwen2.5:3b")
}

import { NoteMetadata } from '@slash/shared-types';
export type { NoteMetadata };

export const PropertiesPanel = ({
    frontmatter,
    onMetadataChange,
    notePath,
    aiTags = [],
    aiSummary,
    hasSummaryUpdate,
    hasSummarySuggestion,
    onAIDataChange,
    noteContent,
    modelName
}: PropertiesPanelProps) => {
    const tagInputRef = useRef<HTMLInputElement>(null);
    const summaryInputRef = useRef<HTMLTextAreaElement>(null);
    const { t } = useTranslation();
    const [tagInput, setTagInput] = useState('');

    const [isEditingSummary, setIsEditingSummary] = useState(false); // Track active summary editing
    void [hasSummarySuggestion, isEditingSummary];
    const originalAISummaryRef = useRef<string | null>(null); // Track original AI summary for feedback logging

    // Parse for display ONLY. Parent logic handles the merge.
    const metadata = useMemo(() => {
        try {
            const wrapped = `---\n${frontmatter}\n---`;
            const parsed = matter(wrapped).data as NoteMetadata;
            // 防御：强制 tags 为数组（gray-matter 可能返回 string / number 等）
            if (parsed.tags != null && !Array.isArray(parsed.tags)) {
                const raw = String(parsed.tags).replace(/^\[|\]$/g, '');
                parsed.tags = raw.split(',').map(t => t.trim()).filter(Boolean);
            } else if (!parsed.tags) {
                parsed.tags = undefined; // 统一为 undefined 而非 null
            }
            return parsed;
        } catch (e) {
            return {} as NoteMetadata;
        }
    }, [frontmatter]);

    // 安全获取 tags 数组（防御性 helper）
    const safeTags = Array.isArray(metadata.tags) ? metadata.tags : [];

    // === Tags Handlers ===
    const handleAddTag = () => {
        const tag = tagInput.trim();
        if (!tag) return;

        const currentTags = safeTags;
        if (!currentTags.includes(tag)) {
            const newTags = [...currentTags, tag];
            onMetadataChange({ tags: newTags });
            // Log tag_correction when user manually adds a tag
            logTagCorrection(newTags);
        }
        setTagInput('');
    };

    const handleRemoveTag = (tagToRemove: string) => {
        const currentTags = safeTags;
        const newTags = currentTags.filter((t: string) => t !== tagToRemove);
        onMetadataChange({ tags: newTags });
        // Log tag_correction when user manually removes a tag
        logTagCorrection(newTags);
    };

    const handleTagKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddTag();
        }
    };

    // === AI Tag Handlers ===
    // Helper: Truncate content to 4k chars for input_snapshot
    const getInputSnapshot = () => noteContent?.substring(0, 4000) || null;

    // Log tag_correction: records final state of all tags for training
    const logTagCorrection = async (currentUserTags: string[]) => {
        if (!notePath) return;  // Only skip if no note path
        try {
            await invoke('log_tag_correction', {
                notePath,
                aiTags,
                userTags: currentUserTags,
                inputSnapshot: getInputSnapshot(),
                modelName: modelName || null
            });
        } catch (e) {
            console.error('[PropertiesPanel] Failed to log tag correction:', e);
        }
    };

    const handleAcceptAITag = async (tag: string) => {
        if (!notePath) return;
        try {
            // Add to user tags in frontmatter first
            const currentTags = safeTags;
            const newTags = currentTags.includes(tag) ? currentTags : [...currentTags, tag];
            if (!currentTags.includes(tag)) {
                onMetadataChange({ tags: newTags });
            }
            // Then update SQLite with complete feedback data
            await invoke('accept_ai_tag', {
                notePath,
                tag,
                inputSnapshot: getInputSnapshot(),
                modelName: modelName || null
            });
            // Log tag_correction with final tag state
            await logTagCorrection(newTags);
            onAIDataChange?.();
        } catch (e) {
            console.error('[PropertiesPanel] Failed to accept AI tag:', e);
        }
    };

    const handleRejectAITag = async (tag: string) => {
        if (!notePath) return;
        try {
            await invoke('reject_ai_tag', {
                notePath,
                tag,
                inputSnapshot: getInputSnapshot(),
                modelName: modelName || null
            });
            // Log tag_correction with current user tags (unchanged)
            await logTagCorrection(safeTags);
            onAIDataChange?.();
        } catch (e) {
            console.error('[PropertiesPanel] Failed to reject AI tag:', e);
        }
    };

    // === Summary Handlers ===
    const handleSummaryChange = (value: string) => {
        // Pass undefined for empty string to remove the field from frontmatter
        // This allows AI summary to show again after user clears and regenerates
        onMetadataChange({ summary: value || undefined });
    };

    // 一旦 AI Summary 生成且用户还未定义 summary 时，直接自动采纳写入 Frontmatter，彻底去除冗余交互卡片
    useEffect(() => {
        if (metadata.summary === undefined && aiSummary) {
            onMetadataChange({ summary: aiSummary });
            if (notePath) {
                const inputSnapshot = noteContent?.substring(0, 4000) || null;
                invoke('accept_ai_summary', {
                    notePath,
                    editedSummary: null,
                    inputSnapshot,
                    modelName: modelName || null
                }).then(() => {
                    onAIDataChange?.();
                }).catch((e: any) => {
                    console.error('[PropertiesPanel] Failed to auto-accept AI summary:', e);
                });
            }
        }
    }, [metadata.summary, aiSummary, onMetadataChange, notePath, noteContent, modelName, onAIDataChange]);

    return (
        <div className="space-y-1 mb-6 animate-in fade-in slide-in-from-top-2">
            {/* Tags Row */}
            <div className="flex flex-row rounded-lg border border-white dark:border-[#161616] hover:border-zinc-200 dark:hover:border-zinc-800 -ml-2 pl-2">
                <div className="flex flex-row items-center gap-2 shrink-0 mr-2">
                    <Tag size={16} strokeWidth={1.5} />
                    <div className="text-sm font-medium text-zinc-500">{t("editor.tags")}</div>
                </div>

                <div
                    className="flex-1 min-w-0 flex flex-wrap items-center gap-2 p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-r-md transition-all cursor-text"
                    onClick={() => tagInputRef.current?.focus()}
                >
                    {/* User Tags (solid style) */}
                    {safeTags.map((tag: string) => (
                        <TagBadge
                            key={`user-${tag}`}
                            tag={tag}
                            isAI={false}
                            onDelete={() => handleRemoveTag(tag)}
                        />
                    ))}

                    {/* AI Tags (outline style with sparkle) - exclude those already in user tags */}
                    {aiTags
                        .filter((tag: string) => !safeTags.includes(tag))
                        .map((tag: string) => (
                            <TagBadge
                                key={`ai-${tag}`}
                                tag={tag}
                                isAI={true}
                                onAccept={() => handleAcceptAITag(tag)}
                                onReject={() => handleRejectAITag(tag)}
                            />
                        ))}

                    <input
                        ref={tagInputRef}
                        className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-zinc-400 text-zinc-900 dark:text-zinc-100 p-0"
                        placeholder={!safeTags.length && !aiTags.length ? t("editor.add_tag") : ""}
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={handleTagKeyDown}
                    />
                </div>
            </div>

            {/* Summary Row */}
            <div className="flex flex-row rounded-lg border border-white dark:border-[#161616] hover:border-zinc-200 dark:hover:border-zinc-800 -ml-2 pl-2">
                <div className="flex flex-row items-center gap-2 shrink-0 mr-2">
                    <FileText size={16} strokeWidth={1.5} />
                    <div className="text-sm font-medium text-zinc-500">{t("editor.summary")}</div>
                    {/* AI Update Suggestion Badge */}
                    {hasSummaryUpdate && (
                        <button
                            onClick={() => {
                                // User wants to see AI's new suggestion - clear user summary to show AI version
                                onMetadataChange({ summary: undefined });
                            }}
                            className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors flex items-center gap-1 animate-pulse"
                            title={t("editor.ai_has_update")}
                        >
                            ✨ AI 有新建议
                        </button>
                    )}
                </div>

                <div className="flex-1 min-w-0 p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-r-md transition-all">
                    <TextareaAutosize
                        ref={summaryInputRef}
                        minRows={1}
                        className={cn(
                            "w-full bg-transparent border-none outline-none font-bold text-sm placeholder:text-zinc-400 text-zinc-900 dark:text-zinc-100 p-0",
                            "resize-none",
                            "block",
                            "overflow-hidden"
                        )}
                        placeholder={t("editor.add_summary")}
                        value={metadata.summary || ''}
                        onChange={(e) => handleSummaryChange(e.target.value)}
                        onFocus={() => {
                            setIsEditingSummary(true);
                            if (aiSummary && metadata.summary === aiSummary) {
                                originalAISummaryRef.current = aiSummary;
                            }
                        }}
                        onBlur={async () => {
                            setIsEditingSummary(false);
                            if (originalAISummaryRef.current && notePath) {
                                const editedContent = metadata.summary || '';
                                if (editedContent !== originalAISummaryRef.current) {
                                    try {
                                        const inputSnapshot = noteContent?.substring(0, 4000) || null;
                                        await invoke('accept_ai_summary', {
                                            notePath,
                                            editedSummary: editedContent || null,
                                            inputSnapshot,
                                            modelName: modelName || null
                                        });
                                        onAIDataChange?.();
                                    } catch (e) {
                                        console.error('[PropertiesPanel] Failed to log summary edit:', e);
                                    }
                                }
                                originalAISummaryRef.current = null;
                            }
                        }}
                    />
                </div>
            </div>
            {/* Editor Row (团队笔记编辑者信息) */}
            {metadata.editor && (
                <div className="flex flex-row rounded-lg border border-white dark:border-[#161616] hover:border-zinc-200 dark:hover:border-zinc-800 -ml-2 pl-2 mt-1">
                    <div className="flex flex-row items-center gap-2 shrink-0 mr-2">
                        <Pencil size={16} strokeWidth={1.5} />
                        <div className="text-sm font-medium text-zinc-500">Editor</div>
                    </div>
                    <div className="flex-1 min-w-0 p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-r-md transition-all">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">{metadata.editor}</span>
                    </div>
                </div>
            )}

            {/* Contributors Row (团队笔记协作者) */}
            {metadata.contributors && (
                <div className="flex flex-row rounded-lg border border-white dark:border-[#161616] hover:border-zinc-200 dark:hover:border-zinc-800 -ml-2 pl-2 mt-1">
                    <div className="flex flex-row items-center gap-2 shrink-0 mr-2">
                        <Users size={16} strokeWidth={1.5} />
                        <div className="text-sm font-medium text-zinc-500">Contributors</div>
                    </div>
                    <div className="flex-1 min-w-0 p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-r-md transition-all">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">
                            {Array.isArray(metadata.contributors) ? metadata.contributors.join(', ') : metadata.contributors}
                        </span>
                    </div>
                </div>
            )}

        </div>
    );
};
