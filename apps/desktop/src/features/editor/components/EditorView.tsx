
import { useState, useEffect, useCallback } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { AlertTriangle, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils/cn';
import { useTheme } from '@/core/theme/ThemeProvider';
import { NoteHeader } from './NoteHeader';
import { PropertiesSection } from './PropertiesSection';
import { FindInNote } from './FindInNote';
import { AIBubbleMenu } from './AIBubbleMenu';
import { AIRangeSelector } from './AIRangeSelector';
import { DocStatusBar } from './DocStatusBar';
import { CollabLockBadge } from './CollabLockBadge';
import { EditorStatusBar } from './EditorStatusBar';
import { EditorDependencyProvider } from './EditorDependencyProvider';
import type { EditorContainerState } from '../hooks/useEditorContainer';
import { useEditorZoomStore } from '@/stores/useEditorZoomStore';
import { useOutlineExtraction } from '../hooks/useOutlineExtraction';
import type { DynamicSkillConfig } from '@/services/CustomSkillService';

/**
 * 确保 editor focus 和 caret 在空节点中可见
 */
function forceCaretRepaint(editor: TiptapEditor | null) {
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    if (from !== to) return;
    requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const { from: f2, to: t2 } = editor.state.selection;
        if (f2 !== t2) return;
        editor.commands.focus(f2, { scrollIntoView: false });
    });
}

/** slash:ai-range-select 事件 detail */
interface AIRangeSelectEvent {
    skill: DynamicSkillConfig;
    from: number;
    to: number;
    insertPos?: number;
}

export const EditorView = (props: EditorContainerState) => {
    const { t } = useTranslation();
    const { editorWidth } = useTheme();
    const zoomLevel = useEditorZoomStore(state => state.zoomLevel);

    const {
        title,
        showProperties,
        setShowProperties,
        frontmatter,
        showFindBar,
        setShowFindBar,
        titleInputRef,
        editor,
        aiTags,
        aiSummary,
        hasSummaryUpdate,
        hasSummarySuggestion,
        titleBacklinks,
        isPropertiesAIRunning,
        isTitleAIRunning,
        noteId,
        activeNoteId,
        effectiveReadOnly,
        readOnlyReason,
        isTeamNote,
        isNoteEditor,
        isVaultOwner,
        noteDocStatus,
        collabLockState,
        collabLockedByName,
        localUser,
        canRequestCollabLock,
        isTeamOffline,
        coreFsStore,
        dynamicCustomSkillService,
        onNavigateToNote,
        fetchAIData,
        handleTitleChange,
        handleTitleKeyDown,
        handleTitleBlur,
        handleMetadataChange,
        handleRunSmartRename,
        handleRunPropertiesAI,
        handleEditorClick,
        reportActivity,
    } = props;

    // Use Outline Extraction (global TOC sync)
    useOutlineExtraction(editor, activeNoteId || noteId || null);

    // ── AIRangeSelector 状态 ──
    const [aiRangeState, setAiRangeState] = useState<AIRangeSelectEvent | null>(null);

    const handleAiRangeSelect = useCallback((e: Event) => {
        const detail = (e as CustomEvent<AIRangeSelectEvent>).detail;
        if (detail?.skill && typeof detail.from === 'number' && typeof detail.to === 'number') {
            setAiRangeState(detail);
        }
    }, []);

    useEffect(() => {
        window.addEventListener('slash:ai-range-select', handleAiRangeSelect);
        return () => window.removeEventListener('slash:ai-range-select', handleAiRangeSelect);
    }, [handleAiRangeSelect]);

    // Report explicit edit intent/activity to the pessimistic lock.
    // Opening, focusing, or selection changes should not acquire the lock.
    useEffect(() => {
        if (!editor || !canRequestCollabLock) return;
        
        const requestLock = () => reportActivity('request');
        const renewLock = () => reportActivity('renew');
        const editorDom = editor.view.dom;
        
        editor.on('update', renewLock);
        editorDom.addEventListener('mousedown', requestLock);
        editorDom.addEventListener('beforeinput', requestLock);
        editorDom.addEventListener('paste', requestLock);
        editorDom.addEventListener('drop', requestLock);
        
        return () => {
            editor.off('update', renewLock);
            editorDom.removeEventListener('mousedown', requestLock);
            editorDom.removeEventListener('beforeinput', requestLock);
            editorDom.removeEventListener('paste', requestLock);
            editorDom.removeEventListener('drop', requestLock);
        };
    }, [editor, canRequestCollabLock, reportActivity]);

    if (!editor) return null;

    // DocStatusBar 切换权限：仅非只读的编辑者或管理员可切换
    const canSwitchDocStatus = !effectiveReadOnly && !isTeamOffline && (isNoteEditor || isVaultOwner);
    // 是否展示协作锁胶囊（仅 collab 模式）
    const showCollabBadge = isTeamNote && noteDocStatus === 'collab';
    const statusPillSurfaceClass = 'border border-white/45 dark:border-white/10 shadow-[0_1px_2px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.45)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]';
    const readOnlyMessage = (() => {
        if (!effectiveReadOnly) return null;
        switch (readOnlyReason) {
            case 'collab_offline':
                return t('editor.readonly_reason_collab_offline', '离线模式下无法编辑团队协作文件，请检查网络或服务。');
            case 'collab_unavailable':
                return t('editor.readonly_reason_collab_unavailable', '暂时无法取得协作编辑锁，Slash 会自动重试。');
            case 'collab_locked_by_other':
                return collabLockedByName
                    ? t('editor.readonly_reason_collab_locked_by', { name: collabLockedByName, defaultValue: `${collabLockedByName} 正在编辑，暂时只读。` })
                    : t('editor.readonly_reason_collab_locked', '其他成员正在编辑，暂时只读。');
            case 'collab_lock_loading':
                return t('editor.readonly_reason_collab_loading', '正在取得协作编辑锁，请稍候。');
            case 'collab_lock_required':
                return t('editor.readonly_reason_collab_required', '协作模式需要先取得编辑锁，请点击正文后稍候。');
            case 'solo_not_editor':
                return t('editor.readonly_reason_solo_not_editor', { name: localUser || '', defaultValue: 'Solo 模式仅 Editor 可编辑。' });
            case 'solo_missing_editor':
                return t('editor.readonly_reason_solo_missing_editor', '该 Solo 团队笔记缺少 Editor 信息，已进入保护性只读。');
            case 'forced':
                return t('editor.readonly_reason_forced', '当前页面处于只读模式。');
            default:
                return t('editor.readonly_reason_team', '当前团队笔记处于只读保护状态。');
        }
    })();

    return (
        <>
        <div className={cn(
            "mx-auto px-8 pt-8 pb-4 transition-all duration-300 ease-in-out",
            editorWidth === "full" ? "max-w-6xl" : "max-w-3xl"
        )} style={zoomLevel === 1 ? undefined : ({ zoom: zoomLevel } as any)}>
            {/* Find in Note Bar */}
            <FindInNote
                editor={editor}
                isOpen={showFindBar}
                onClose={() => setShowFindBar(false)}
            />

            {/* 文档状态标签 + 协作锁胶囊 — 仅团队文档显示 */}
            {isTeamNote && (
                <div className="flex items-center gap-2 px-1 mb-1.5 mt-3.5">
                    <DocStatusBar
                        status={noteDocStatus}
                        canSwitch={canSwitchDocStatus}
                        onChange={(s) => handleMetadataChange({ doc_status: s } as any)}
                    />
                    {showCollabBadge && (
                        <CollabLockBadge
                            lockState={collabLockState}
                            lockedByName={collabLockedByName}
                            localUser={localUser}
                        />
                    )}
                    {effectiveReadOnly && (
                        <div 
                            className={cn(
                                'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 dark:bg-amber-500/10 border-amber-500/20 select-none shrink-0 transition-colors',
                                statusPillSurfaceClass
                            )}
                            title={readOnlyMessage || t('editor.readonly_mode', '团队空间为只读模式')}
                        >
                            <Lock size={12} className="text-amber-600 dark:text-amber-500" />
                            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{t('editor.readonly', '只读')}</span>
                        </div>
                    )}
                </div>
            )}

            {isTeamNote && effectiveReadOnly && readOnlyMessage && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span className="leading-5">{readOnlyMessage}</span>
                </div>
            )}

            {/* 始终渲染 NoteHeader — 只读状态通过 TipTap editable 控制 */}
            <NoteHeader
                title={title}
                titleInputRef={titleInputRef}
                onTitleChange={handleTitleChange}
                onTitleBlur={handleTitleBlur}
                onTitleKeyDown={handleTitleKeyDown}
                titleBacklinks={titleBacklinks}
                onNavigateToNote={onNavigateToNote}
                isAIRunning={isTitleAIRunning}
                onSmartRename={effectiveReadOnly ? undefined : handleRunSmartRename}
            />

            <PropertiesSection
                showProperties={showProperties}
                onToggle={() => setShowProperties(!showProperties)}
                hasSummaryUpdate={effectiveReadOnly ? false : hasSummaryUpdate}
                hasSummarySuggestion={effectiveReadOnly ? false : hasSummarySuggestion}
                frontmatter={frontmatter}
                onMetadataChange={effectiveReadOnly ? () => {} : handleMetadataChange}
                noteId={noteId ?? ''}
                aiTags={effectiveReadOnly ? [] : aiTags}
                aiSummary={effectiveReadOnly ? undefined : aiSummary}
                onAIDataChange={effectiveReadOnly ? () => {} : fetchAIData}
                noteContent={editor?.getText() || ''}
                isAIRunning={effectiveReadOnly ? false : isPropertiesAIRunning}
                onRunAI={effectiveReadOnly ? async () => {} : handleRunPropertiesAI}
            />

            <div
                className="relative min-h-[500px] editor-content-area mb-8"
                onClick={(event) => {
                    handleEditorClick(event);
                    forceCaretRepaint(editor);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={(e) => e.preventDefault()}
            >
                <EditorDependencyProvider
                    coreFsStore={coreFsStore}
                    dynamicCustomSkillService={dynamicCustomSkillService}
                >
                    <AIBubbleMenu editor={editor} canEdit={!effectiveReadOnly} notePath={activeNoteId || noteId || ''} isTeamNote={isTeamNote} />
                    <EditorContent editor={editor} />
                </EditorDependencyProvider>
                {/* 手柄 overlay — 独立于 ProseMirror DOM 树，避免列表更新时的 DOM 干扰 */}
                {aiRangeState && editor && (
                    <AIRangeSelector
                        editor={editor}
                        skill={aiRangeState.skill}
                        initialFrom={aiRangeState.from}
                        initialTo={aiRangeState.to}
                        insertPos={aiRangeState.insertPos}
                        onDone={() => setAiRangeState(null)}
                        customSkillService={dynamicCustomSkillService}
                        notePath={activeNoteId || noteId || ''}
                    />
                )}
            </div>
        </div>

        {/* StatusBar 在 zoom 容器外，不受缩放影响 */}
        <EditorStatusBar 
            editor={editor} 
            incomingLinksCount={titleBacklinks?.length || 0} 
            notePath={activeNoteId || noteId || ''}
        />
        </>
    );
};
