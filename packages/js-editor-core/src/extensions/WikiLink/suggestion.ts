import { ReactRenderer } from '@tiptap/react';
import tippy, { Instance as TippyInstance } from 'tippy.js';
import { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import WikiLinkList, { type WikiLinkListRef } from './WikiLinkList';
import { PluginKey } from '@tiptap/pm/state';

// Unique plugin key to avoid collision with other suggestion plugins
const wikiLinkSuggestionKey = new PluginKey('wikiLinkSuggestion');

export interface SuggestionItem {
    id: string;
    title: string;
    path: string;
}

/** getNotes 回调类型，由宿主（Desktop/Mobile）注入 */
export type GetNotesCallback = () => Promise<Array<{ id: number; path: string; title: string }>>;

export const createSuggestion = (getNotes: GetNotesCallback): Omit<SuggestionOptions<SuggestionItem>, 'editor'> => ({
    pluginKey: wikiLinkSuggestionKey,
    char: '[[',
    allowSpaces: true,
    startOfLine: false,
    allowedPrefixes: null,

    allow: ({ state, range }) => {
        const $from = state.doc.resolve(range.from);

        // Check if inside code block or math block
        const parentNode = $from.parent;
        if (parentNode.type.name === 'codeBlock' || parentNode.type.name === 'math') {
            return false;
        }

        // Check for inline code mark
        const marks = $from.marks();
        if (marks.some(mark => mark.type.name === 'code')) {
            return false;
        }

        // Check for unclosed inline code/math in the text before cursor
        // This catches cases where user is typing inside `...` or $...$
        const textBefore = parentNode.textBetween(0, $from.parentOffset, '\0', ' ');

        // Count backticks - odd count means we're inside inline code
        const backtickCount = (textBefore.match(/`/g) || []).length;
        if (backtickCount % 2 === 1) {
            return false;
        }

        // Count $ for inline math - odd count means we're inside math
        // But skip $$ (display math is a block, handled above)
        const dollarMatches = textBefore.match(/\$/g) || [];
        const doubleDollarMatches = textBefore.match(/\$\$/g) || [];
        const singleDollarCount = dollarMatches.length - (doubleDollarMatches.length * 2);
        if (singleDollarCount % 2 === 1) {
            return false;
        }

        return $from.depth > 0;
    },

    items: async ({ query }): Promise<SuggestionItem[]> => {
        try {
            // If query contains #, let SectionSuggestion extension handle it
            if (query.includes('#')) {
                return [];
            }

            // Normal note suggestion mode — use injected getNotes callback
            const notes = await getNotes();
            const queryLower = query.toLowerCase().trim();

            const filtered = notes
                .filter((note: any) => {
                    if (!queryLower) return true;
                    const titleMatch = note.title?.toLowerCase().includes(queryLower);
                    const pathMatch = note.path?.toLowerCase().includes(queryLower);
                    return titleMatch || pathMatch;
                })
                .slice(0, 50) // 增加显示数量
                .map((note: any) => ({
                    id: note.path,
                    title: note.title || note.path.split('/').pop()?.replace('.md', '') || note.path,
                    path: note.path,
                }));

            return filtered;
        } catch (e) {
            console.error('[WikiLink] Failed to fetch notes:', e);
            return [];
        }
    },

    render: () => {
        let component: ReactRenderer<WikiLinkListRef> | null = null;
        let popup: TippyInstance[] | null = null;

        return {
            onStart: (props: SuggestionProps<SuggestionItem>) => {
                // Don't create popup if no items (e.g., during edit mode or # pattern)
                if (props.items.length === 0) {
                    return;
                }

                component = new ReactRenderer(WikiLinkList, {
                    props: {
                        items: props.items,
                        command: props.command,
                    },
                    editor: props.editor,
                });

                if (!props.clientRect) return;

                popup = tippy('body', {
                    getReferenceClientRect: props.clientRect as () => DOMRect,
                    appendTo: () => document.body,
                    content: component.element,
                    showOnCreate: true,
                    interactive: true,
                    trigger: 'manual',
                    placement: 'bottom-start',
                    theme: 'wiki-link',
                    maxWidth: 'none',
                    popperOptions: {
                        modifiers: [
                            { name: 'flip', options: { fallbackPlacements: ['top-start'] } },
                            { name: 'preventOverflow', options: { padding: 8 } },
                        ],
                    },
                });
            },

            onUpdate: (props: SuggestionProps<SuggestionItem>) => {
                // Hide popup if no items (e.g., when # triggers SectionSuggestion instead)
                if (props.items.length === 0) {
                    popup?.[0]?.hide();
                    return;
                }

                popup?.[0]?.show();
                component?.updateProps({
                    items: props.items,
                    command: props.command,
                });

                if (!props.clientRect) return;

                popup?.[0]?.setProps({
                    getReferenceClientRect: props.clientRect as () => DOMRect,
                });
            },

            onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === 'Escape') {
                    popup?.[0]?.hide();
                    return true;
                }

                return component?.ref?.onKeyDown?.(props) ?? false;
            },

            onExit: () => {
                popup?.[0]?.destroy();
                component?.destroy();
            },
        };
    },
});
