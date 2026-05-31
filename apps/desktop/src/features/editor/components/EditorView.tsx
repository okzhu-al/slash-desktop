
import { useState, useEffect, useCallback } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { Lock } from 'lucide-react';
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
        isTeamNote,
        isNoteEditor,
        isVaultOwner,
        noteDocStatus,
        collabLockState,
        collabLockedByName,
        localUser,
        canRequestCollabLock,
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

    // 🔍 Bug 2 (待办列表回车光标不可见) DOM & Caret 选区焦点诊断监控
    useEffect(() => {
        if (!editor || !editor.view.dom) return;
        
        const dom = editor.view.dom;
        console.log('👀 [Bug 2 Debug] Registered DOM & Selection Monitor for active editor.');

        // 1. 监听 DOM 树变更 (以检测 task list/checkbox 的渲染变化)
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                console.log(`[Bug 2 Mutation] Type: ${mutation.type}, Target:`, mutation.target);
                if (mutation.addedNodes.length > 0) {
                    console.log(`  Added nodes count: ${mutation.addedNodes.length}`);
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof HTMLElement) {
                            console.log(`  Added: <${node.tagName.toLowerCase()}> class="${node.className}"`, node);
                        }
                    });
                }
            }
        });

        observer.observe(dom, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'contenteditable']
        });

        // 2. 监听全局选区/光标变化
        const handleSelectionChange = () => {
            const sel = window.getSelection();
            if (!sel || !dom.contains(sel.anchorNode)) return;
            
            console.log('📌 [Bug 2 Selection]', {
                anchorNode: sel.anchorNode,
                anchorOffset: sel.anchorOffset,
                focusNode: sel.focusNode,
                focusOffset: sel.focusOffset,
                isCollapsed: sel.isCollapsed,
                rangeCount: sel.rangeCount,
            });

            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const rects = range.getClientRects();
                console.log('  Caret ClientRects count:', rects.length);
                if (rects.length > 0) {
                    const rect = rects[0];
                    console.log('  Caret Rect:', { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
                }
            }
        };

        // 3. 监听编辑器 Focus/Blur
        const handleFocus = () => console.log('🔥 [Bug 2 Focus] Editor DOM focused');
        const handleBlur = (e: FocusEvent) => {
            console.group('💤 [Bug 2 Focus] Editor DOM blurred');
            console.log('- event.target:', e.target);
            console.log('- event.relatedTarget:', e.relatedTarget);
            console.log('- document.activeElement:', document.activeElement);
            if (document.activeElement) {
                console.log('  - tagName:', document.activeElement.tagName);
                console.log('  - className:', document.activeElement.className);
                console.log('  - role:', document.activeElement.getAttribute('role'));
                console.log('  - type:', (document.activeElement as any).type);
            }
            if (typeof e.composedPath === 'function') {
                console.log('- event.composedPath():', e.composedPath());
            }
            console.groupEnd();
        };

        const logIMEEvent = (eventName: string, e: any) => {
            const sel = window.getSelection();
            const anchorNode = sel?.anchorNode;
            let taskItemIndex = -1;
            if (anchorNode) {
                let curr: Node | null = anchorNode;
                while (curr && curr !== dom) {
                    if (curr instanceof HTMLElement && curr.tagName.toLowerCase() === 'li' && curr.getAttribute('data-type') === 'taskItem') {
                        const list = curr.parentElement;
                        if (list) {
                            taskItemIndex = Array.from(list.children).indexOf(curr);
                        }
                        break;
                    }
                    curr = curr.parentNode;
                }
            }
            console.log(`⌨️ [Bug 2 IME] Event: ${eventName}`, {
                data: e.data,
                inputType: e.inputType,
                isComposing: e.isComposing,
                editorComposing: editor.view.composing,
                anchorNode,
                taskItemIndex,
            });
        };

        const onCompStart = (e: Event) => logIMEEvent('compositionstart', e);
        const onCompUpdate = (e: Event) => logIMEEvent('compositionupdate', e);
        const onCompEnd = (e: Event) => logIMEEvent('compositionend', e);
        const onBeforeInput = (e: Event) => logIMEEvent('beforeinput', e);
        const onInput = (e: Event) => logIMEEvent('input', e);

        dom.addEventListener('compositionstart', onCompStart);
        dom.addEventListener('compositionupdate', onCompUpdate);
        dom.addEventListener('compositionend', onCompEnd);
        dom.addEventListener('beforeinput', onBeforeInput);
        dom.addEventListener('input', onInput);

        document.addEventListener('selectionchange', handleSelectionChange);
        dom.addEventListener('focus', handleFocus);
        dom.addEventListener('blur', handleBlur, true);

        return () => {
            observer.disconnect();
            dom.removeEventListener('compositionstart', onCompStart);
            dom.removeEventListener('compositionupdate', onCompUpdate);
            dom.removeEventListener('compositionend', onCompEnd);
            dom.removeEventListener('beforeinput', onBeforeInput);
            dom.removeEventListener('input', onInput);
            document.removeEventListener('selectionchange', handleSelectionChange);
            dom.removeEventListener('focus', handleFocus);
            dom.removeEventListener('blur', handleBlur);
            console.log('👀 [Bug 2 Debug] Selection Monitor cleaned up.');
        };
    }, [editor]);

    if (!editor) return null;

    // DocStatusBar 切换权限：仅非只读的编辑者或管理员可切换
    const canSwitchDocStatus = !effectiveReadOnly && (isNoteEditor || isVaultOwner);
    // 是否展示协作锁胶囊（仅 collab 模式）
    const showCollabBadge = isTeamNote && noteDocStatus === 'collab';

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
                            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 dark:bg-amber-500/10 border border-amber-500/20 shadow-sm select-none shrink-0 transition-colors" 
                            title={t('editor.readonly_mode', '团队空间为只读模式')}
                        >
                            <Lock size={12} className="text-amber-600 dark:text-amber-500" />
                            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{t('editor.readonly', '只读')}</span>
                        </div>
                    )}
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
                onClick={() => {
                    handleEditorClick();
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
