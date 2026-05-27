import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import tippy, { Instance as TippyInstance } from 'tippy.js';
import WikiLinkList, { type WikiLinkListRef } from './WikiLinkList';

// Helper to get vault path - uses global window value set by App.tsx
const getVaultPath = (): string | null => {
    // Primary: use global window value (most reliable, set by App.tsx)
    const globalPath = (window as any).__slashVaultPath;
    if (globalPath) return globalPath;

    // Fallback: try localStorage
    const lastVault = localStorage.getItem('last_vault_path');
    if (lastVault) return lastVault;

    // Last resort: vault history
    const stored = localStorage.getItem('slash-vaults-history');
    if (!stored) return null;
    try {
        const vaults = JSON.parse(stored);
        return vaults?.[0]?.path || null;
    } catch {
        return null;
    }
};

export interface SectionItem {
    id: string;
    title: string;
    path: string;
}

const sectionSuggestionKey = new PluginKey('sectionSuggestion');

/**
 * Section suggestion extension that triggers when # is typed after [[NoteName
 * Shows heading suggestions from the target note
 */
export const SectionSuggestion = Extension.create({
    name: 'sectionSuggestion',

    addOptions() {
        return {
            /** 获取笔记列表，由宿主注入 */
            getNotes: (() => Promise.resolve([])) as () => Promise<Array<{ id: number; path: string; title: string }>>,
            /** 读取文件内容，由宿主注入 */
            readFileContent: ((_path: string) => Promise.resolve('')) as (path: string) => Promise<string>,
        };
    },

    addProseMirrorPlugins() {
        const { getNotes, readFileContent } = this.options;
        let component: ReactRenderer<WikiLinkListRef> | null = null;
        let popup: TippyInstance[] | null = null;
        let currentItems: SectionItem[] = [];

        const destroyPopup = () => {
            popup?.[0]?.destroy();
            component?.destroy();
            popup = null;
            component = null;
            currentItems = [];
        };

        const showPopup = (items: SectionItem[], view: any, from: number) => {
            if (items.length === 0) {
                destroyPopup();
                return;
            }

            currentItems = items;

            const command = (item: SectionItem) => {
                // Insert section name at cursor position
                const { to } = view.state.selection;
                const tr = view.state.tr.replaceWith(
                    to,
                    to,
                    view.state.schema.text(item.path)
                );
                view.dispatch(tr);
                destroyPopup();
            };

            if (!component) {
                component = new ReactRenderer(WikiLinkList, {
                    props: { items, command },
                    editor: this.editor,
                });

                const coords = view.coordsAtPos(from);
                popup = tippy('body', {
                    getReferenceClientRect: () => ({
                        width: 0,
                        height: 20,
                        top: coords.top,
                        bottom: coords.bottom,
                        left: coords.left,
                        right: coords.left,
                    } as DOMRect),
                    appendTo: () => document.body,
                    content: component.element,
                    showOnCreate: true,
                    interactive: true,
                    trigger: 'manual',
                    placement: 'bottom-start',
                    theme: 'wiki-link',
                    maxWidth: 320,
                });
            } else {
                component.updateProps({ items, command });
            }
        };

        return [
            new Plugin({
                key: sectionSuggestionKey,

                props: {
                    handleKeyDown: (_view, event) => {
                        // Handle arrow keys and enter when popup is visible
                        if (!popup || currentItems.length === 0) return false;

                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            // Let WikiLinkList handle arrow navigation via its own handlers
                            return false;
                        }
                        if (event.key === 'Enter') {
                            // Let the popup handle enter key
                            return false;
                        }
                        if (event.key === 'Escape') {
                            destroyPopup();
                            return true;
                        }

                        return false;
                    },
                },

                view: () => ({
                    update: async (view) => {
                        const { state } = view;
                        const { selection, doc } = state;
                        const { from } = selection;

                        // Get text before cursor on current line
                        const $from = doc.resolve(from);
                        const textBefore = doc.textBetween(
                            Math.max(0, $from.start()),
                            from,
                            '\n'
                        );

                        // Check for [[NoteName# pattern
                        const match = textBefore.match(/\[\[([^\]#|]+)#([^\]|]*)$/);

                        if (!match) {
                            destroyPopup();
                            return;
                        }

                        const noteName = match[1];
                        const sectionQuery = match[2].toLowerCase();

                        const vaultPath = getVaultPath();
                        if (!vaultPath) {
                            destroyPopup();
                            return;
                        }

                        try {
                            // Find note by name
                            const notes = await getNotes();
                            const matchedNote = notes.find((n: any) =>
                                n.title === noteName ||
                                n.title?.toLowerCase() === noteName.toLowerCase()
                            );

                            if (!matchedNote) {
                                destroyPopup();
                                return;
                            }

                            // Read note content
                            const absolutePath = `${vaultPath}/${matchedNote.path}`;
                            const content = await readFileContent(absolutePath);

                            // Parse headings
                            const headingRegex = /^(#{1,6})\s+(.+)$/gm;
                            const headings: SectionItem[] = [];
                            let headingMatch;

                            while ((headingMatch = headingRegex.exec(content)) !== null) {
                                const headingText = headingMatch[2].trim();
                                const headingLevel = headingMatch[1].length;

                                if (!sectionQuery || headingText.toLowerCase().includes(sectionQuery)) {
                                    headings.push({
                                        id: `${matchedNote.path}#${headingText}`,
                                        title: `${'#'.repeat(headingLevel)} ${headingText}`,
                                        path: headingText,
                                    });
                                }
                            }

                            // Calculate position for popup
                            const matchStart = from - match[2].length - 1; // Position after #
                            showPopup(headings.slice(0, 10), view, matchStart);

                        } catch (e) {
                            console.warn('[SectionSuggestion] Error:', e);
                            destroyPopup();
                        }
                    },

                    destroy: () => {
                        destroyPopup();
                    },
                }),
            }),
        ];
    },
});
