import { Extension, Range, Editor } from '@tiptap/core';
import Suggestion, { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { Instance, Props } from 'tippy.js';
// Editor DI will be passed via editor storage or options since this is not a React component
export interface SlashCommandOptions {
    suggestion: any;
    SlashCommandList: any;
    customSkillService: {
        listCustomSkills: () => Promise<any[]>;
        executeCustomSkill: (id: string, context: any) => Promise<any>;
        onSkillCompleted: (cb: (result: any) => void) => Promise<() => void>;
        onSkillChunk: (cb: (data: any) => void) => Promise<() => void>;
    };
}

export interface CommandItemProps {
    id: string;           // Unique identifier
    category: string;     // Grouping bucket ("标题", "格式", "列表", "区块", "组件", "AI 技能")
    title: string;        // Fallback title (English)
    i18nKey: string;      // i18n key for translation
    iconType: string;     // String referring to icon (e.g., 'Heading1', 'Bold', 'Table')
    shortcut?: string;    // Mac shortcut representation
    command: ({ editor, range }: { editor: Editor; range: Range }) => void;
}

const CommandItems: CommandItemProps[] = [
    // --- 标题 (Headings) ---
    { id: 'h1', category: 'heading', title: 'Heading 1', i18nKey: 'slashCommands.h1', iconType: 'Heading1', shortcut: '#', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run() },
    { id: 'h2', category: 'heading', title: 'Heading 2', i18nKey: 'slashCommands.h2', iconType: 'Heading2', shortcut: '##', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run() },
    { id: 'h3', category: 'heading', title: 'Heading 3', i18nKey: 'slashCommands.h3', iconType: 'Heading3', shortcut: '###', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run() },
    { id: 'h4', category: 'heading', title: 'Heading 4', i18nKey: 'slashCommands.h4', iconType: 'Heading4', shortcut: '####', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 4 }).run() },
    { id: 'h5', category: 'heading', title: 'Heading 5', i18nKey: 'slashCommands.h5', iconType: 'Heading5', shortcut: '#####', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 5 }).run() },
    { id: 'h6', category: 'heading', title: 'Heading 6', i18nKey: 'slashCommands.h6', iconType: 'Heading6', shortcut: '######', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 6 }).run() },
    
    // --- 格式 (Formatting) ---
    { id: 'bold', category: 'formatting', title: 'Bold', i18nKey: 'slashCommands.bold', iconType: 'Bold', shortcut: '⌘B', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBold().run() },
    { id: 'italic', category: 'formatting', title: 'Italic', i18nKey: 'slashCommands.italic', iconType: 'Italic', shortcut: '⌘I', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleItalic().run() },
    { id: 'strikethrough', category: 'formatting', title: 'Strikethrough', i18nKey: 'slashCommands.strikethrough', iconType: 'Strikethrough', shortcut: '⌘⇧S', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleStrike().run() },
    { id: 'highlight', category: 'formatting', title: 'Highlight', i18nKey: 'slashCommands.highlight', iconType: 'Highlighter', shortcut: '⌘⇧H', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHighlight().run() },

    // --- 列表 (Lists) ---
    { id: 'bulletList', category: 'list', title: 'Bullet List', i18nKey: 'slashCommands.bulletList', iconType: 'List', shortcut: '-', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
    { id: 'orderedList', category: 'list', title: 'Ordered List', i18nKey: 'slashCommands.orderedList', iconType: 'ListOrdered', shortcut: '1.', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
    { id: 'taskList', category: 'list', title: 'Task List', i18nKey: 'slashCommands.taskList', iconType: 'CheckSquare', shortcut: '[]', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },

    // --- 区块 (Blocks) ---
    { id: 'table', category: 'block', title: 'Table', i18nKey: 'slashCommands.table', iconType: 'Table', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'codeBlock', category: 'block', title: 'Code Block', i18nKey: 'slashCommands.codeBlock', iconType: 'Code', shortcut: '```', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
    { 
        id: 'blockquote', 
        category: 'block', 
        title: 'Quote', 
        i18nKey: 'slashCommands.blockquote', 
        iconType: 'Quote', 
        shortcut: '>', 
        command: ({ editor, range }) => {
            return (editor.chain().focus().deleteRange(range) as any)
                .toggleBlockquote()
                .run();
        }
    },
    { id: 'math', category: 'block', title: 'Math Block', i18nKey: 'slashCommands.math', iconType: 'Sigma', shortcut: '$$', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertMathBlock().run() },
    { id: 'drawing', category: 'block', title: 'Drawing', i18nKey: 'slashCommands.drawing', iconType: 'PenTool', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertDrawing().run() },

    // --- 组件 (Components) ---
    { id: 'comp_person', category: 'component', title: 'Person', i18nKey: 'slashCommands.person', iconType: 'User', shortcut: '@', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertContent({ type: 'userChip', attrs: { isDraft: true } }).run() },
    { id: 'comp_date', category: 'component', title: 'Date', i18nKey: 'slashCommands.date', iconType: 'Calendar', shortcut: '&', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertContent({ type: 'dateChip', attrs: { isDraft: true } }).run() },
    { id: 'comp_priority', category: 'component', title: 'Priority', i18nKey: 'slashCommands.priority', iconType: 'Zap', shortcut: '!', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertContent({ type: 'priorityChip', attrs: { isDraft: true } }).run() },
];

// ============================================================================
// AI Skill → Slash Command 动态转换
// ============================================================================

/** 缓存已加载的 skills，避免每次输入 / 都请求后端 */
let cachedSkillItems: CommandItemProps[] = [];
let cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5 秒缓存
let cacheLoading = false;
/** 首次加载 Promise — 永不置空，供 items() await */
let loadPromise: Promise<void> | null = null;

/** 后台刷新缓存 */
function refreshSkillCache(service: any) {
    if (cacheLoading || !service) return;
    cacheLoading = true;
    const p =
        service.listCustomSkills()
            .then((skills: any[]) => {
                cachedSkillItems = skills.map((skill): CommandItemProps => ({
                    id: `ai_${skill.id}`,
                    category: 'ai',
                    title: `${skill.name}`,
                    i18nKey: `customSkill.${skill.id}`,
                    iconType: 'Sparkles',
                    command: ({ editor: ed, range }) => {
                        // 删除斜杠命令文本（静默）
                        const trDel = ed.state.tr;
                        trDel.delete(range.from, range.to);
                        trDel.setMeta('addToHistory', false);
                        ed.view.dispatch(trDel);

                        // ── 计算默认段落范围（向上回溯到空行） ──
                        const { state } = ed;
                        const pos = range.from;

                        // 收集 pos 之前所有 textblock 的位置信息
                        const blockInfos: { from: number; to: number; text: string }[] = [];
                        state.doc.nodesBetween(0, pos, (node, nodePos) => {
                            if (node.isTextblock && nodePos + node.nodeSize <= pos) {
                                blockInfos.push({
                                    from: nodePos + 1,  // skip opening token
                                    to: nodePos + node.nodeSize - 1, // skip closing token
                                    text: node.textContent.trim(),
                                });
                            }
                            return true;
                        });

                        // 从后往前，找到连续非空段落组成的范围
                        let rangeFrom = pos;
                        let rangeTo = pos;
                        for (let i = blockInfos.length - 1; i >= 0; i--) {
                            const b = blockInfos[i];
                            if (b.text.length === 0) {
                                if (rangeTo !== pos) break; // 遇到空行，停止
                                continue; // 跳过尾部空行
                            }
                            rangeFrom = b.from;
                            if (rangeTo === pos) rangeTo = b.to; // 第一个非空段落设定 rangeTo
                        }

                        // 安全边界
                        const docSize = ed.state.doc.content.size;
                        rangeFrom = Math.max(0, Math.min(rangeFrom, docSize));
                        rangeTo = Math.max(rangeFrom, Math.min(rangeTo, docSize));

                        console.log('[SlashCommand] 🎯 AI range-select:', { skill: skill.name, rangeFrom, rangeTo });

                        // 触发范围选择模式（由 AIRangeSelector 接收）
                        window.dispatchEvent(new CustomEvent('slash:ai-range-select', {
                            detail: { skill, from: rangeFrom, to: rangeTo, insertPos: pos },
                        }));
                    },
                }));
                cacheTimestamp = Date.now();
            })
            .catch((e: Error) => {
                console.warn('[SlashCmd] Failed to load custom skills:', e);
            })
            .finally(() => {
                cacheLoading = false;
            });
    loadPromise = p;
}

// 应用启动时预加载交给外部调用
// refreshSkillCache();

export const SlashCommand = Extension.create<SlashCommandOptions>({
    name: 'slashCommand',

    addOptions() {
        return {
            suggestion: {
                char: '/',
                allowSpaces: false,
                allowedPrefixes: null,
                // `/` 直接触发命令面板；`/ `（加空格）取消并输入字面量
                // 仅在行首或空格后触发，防止 URL 中的 `/` 误触发（如 https://）
                allow: ({ state, range }: { state: any; range: any }) => {
                    const text = state.doc.textBetween(range.from, state.selection.from, '\0');
                    // / + 空格 = 输入字面 `/`
                    if (text.length >= 2 && text[1] === ' ') return false;
                    // 检查 `/` 前的字符：仅在行首或空格后触发
                    if (range.from > 0) {
                        const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, '\0');
                        if (before && !/\s/.test(before)) return false;
                    }
                    return true;
                },
                command: ({ editor, range, props }: { editor: Editor; range: Range; props: any }) => {
                    props.command({ editor, range });
                },
            },
            SlashCommandList: null,
            customSkillService: {
                listCustomSkills: async () => [],
                executeCustomSkill: async () => { },
                onSkillCompleted: async () => () => { },
                onSkillChunk: async () => () => { },
            }
        };
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                ...this.options.suggestion,
                items: async ({ query }: { query: string }) => {
                    const ctxService = this.options.customSkillService;
                    // 首次加载未完成时等待
                    if (cachedSkillItems.length === 0 && loadPromise) {
                        await loadPromise;
                    }
                    if (cachedSkillItems.length === 0 || Date.now() - cacheTimestamp > CACHE_TTL) {
                        refreshSkillCache(ctxService);
                        if (loadPromise) await loadPromise;
                    }
                    // query 是 `/` 后面的文本，直接用于筛选
                    const cleanQuery = query.trimStart();
                    const teamMembers = (window as any).__slashTeamMembers || [];
                    let allItems = [...CommandItems, ...cachedSkillItems];
                    if (teamMembers.length === 0) {
                        allItems = allItems.filter(item => item.id !== 'comp_person');
                    }
                    return allItems.filter(item =>
                        item.title.toLowerCase().includes(cleanQuery.toLowerCase())
                    );
                },
                render: () => {
                    let component: ReactRenderer<any>;
                    let popup: Instance<Props>[];
                    const ListComponent = this.options.SlashCommandList;

                    if (!ListComponent) {
                        console.warn('SlashCommandList component missing in options');
                        return {};
                    }

                    return {
                        onStart: (props: SuggestionProps) => {
                            component = new ReactRenderer(ListComponent, {
                                props,
                                editor: props.editor,
                            });

                            if (!props.clientRect) {
                                return;
                            }

                            // 找到编辑器的滚动容器
                            let scrollParent: HTMLElement | null = props.editor.view.dom.parentElement;
                            while (scrollParent && scrollParent !== document.body) {
                                const ov = window.getComputedStyle(scrollParent).overflowY;
                                if (ov === 'auto' || ov === 'scroll') break;
                                scrollParent = scrollParent.parentElement;
                            }

                            // @ts-ignore
                            popup = tippy('body', {
                                getReferenceClientRect: props.clientRect as any,
                                appendTo: () => scrollParent || document.body,
                                content: component.element,
                                showOnCreate: true,
                                interactive: true,
                                trigger: 'manual',
                                placement: 'bottom-start',
                                popperOptions: {
                                    strategy: 'absolute',
                                },
                            });
                        },

                        onUpdate(props: SuggestionProps) {
                            component?.updateProps(props);

                            if (!props.clientRect) {
                                return;
                            }

                            popup?.[0]?.setProps({
                                getReferenceClientRect: props.clientRect as any,
                            });
                        },

                        onKeyDown(props: SuggestionKeyDownProps) {
                            if (props.event.key === 'Escape') {
                                popup?.[0]?.hide();
                                return true;
                            }

                            return component?.ref?.onKeyDown(props) ?? false;
                        },

                        onExit() {
                            popup?.[0]?.destroy();
                            component?.destroy();
                        },
                    };
                },
            }),
        ];
    },
});
