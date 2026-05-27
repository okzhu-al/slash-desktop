/**
 * HeadingBacklinks Plugin
 * 
 * Adds backlink badges after section headings that have incoming links.
 * Uses ProseMirror decorations to render badges inline with headings.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SectionBacklinks {
    [section: string]: Array<{
        source_path: string;
        source_title: string;
        target_anchor: string;
    }>;
}

export interface HeadingBacklinksStorage {
    backlinks: SectionBacklinks;
    onNavigate?: (path: string) => void;
}

const headingBacklinksPluginKey = new PluginKey('headingBacklinks');

export const HeadingBacklinks = Extension.create<{}, HeadingBacklinksStorage>({
    name: 'headingBacklinks',

    addStorage() {
        return {
            backlinks: {},
            onNavigate: undefined,
        };
    },

    addProseMirrorPlugins() {
        const storage = this.storage;

        return [
            new Plugin({
                key: headingBacklinksPluginKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply: (tr, oldDecorations, _oldState, newState) => {
                        // Only recalculate if document changed or backlinks changed
                        if (!tr.docChanged && oldDecorations !== DecorationSet.empty) {
                            return oldDecorations.map(tr.mapping, tr.doc);
                        }

                        const decorations: Decoration[] = [];
                        const backlinks = storage.backlinks;

                        // Find all headings and add badges
                        newState.doc.descendants((node, pos) => {
                            if (node.type.name === 'heading' && node.textContent) {
                                const headingText = node.textContent;

                                // Check if this section has backlinks
                                const sectionBacklinks = backlinks[headingText];
                                if (sectionBacklinks && sectionBacklinks.length > 0) {
                                    // Add decoration at the end of the heading
                                    const endPos = pos + node.nodeSize - 1;

                                    const widget = Decoration.widget(endPos, () => {
                                        const badge = document.createElement('span');
                                        badge.className = 'backlink-badge heading-backlink-badge';
                                        badge.textContent = String(sectionBacklinks.length);
                                        badge.title = `${sectionBacklinks.length} backlinks to this section`;

                                        // Add click handler
                                        badge.addEventListener('click', (e) => {
                                            e.stopPropagation();
                                            // Show popup with backlinks
                                            showBacklinksPopup(badge, sectionBacklinks, storage.onNavigate);
                                        });

                                        return badge;
                                    }, { side: 1 });

                                    decorations.push(widget);
                                }
                            }
                            return true;
                        });

                        return DecorationSet.create(newState.doc, decorations);
                    },
                },
                props: {
                    decorations(state) {
                        return this.getState(state);
                    },
                },
            }),
        ];
    },
});

// Simple popup for heading backlinks
function showBacklinksPopup(
    badge: HTMLElement,
    backlinks: Array<{ source_path: string; source_title: string; target_anchor: string }>,
    onNavigate?: (path: string) => void
) {
    // Remove any existing popup
    const existingPopup = document.querySelector('.heading-backlinks-popup');
    if (existingPopup) {
        existingPopup.remove();
    }

    const rect = badge.getBoundingClientRect();

    const popup = document.createElement('div');
    popup.className = 'backlink-popup heading-backlinks-popup';
    popup.style.cssText = `
        position: fixed;
        top: ${rect.bottom + 4}px;
        left: ${rect.left}px;
        z-index: 9999;
    `;

    popup.innerHTML = `
        <div class="backlink-popup-header">被以下笔记引用</div>
        <ul class="backlink-popup-list">
            ${backlinks.map((link, i) => `
                <li class="backlink-popup-item" data-index="${i}">
                    <span class="backlink-popup-icon">📝</span>
                    <span class="backlink-popup-title">${link.source_title}</span>
                </li>
            `).join('')}
        </ul>
    `;

    // Add click handlers
    popup.querySelectorAll('.backlink-popup-item').forEach((item) => {
        item.addEventListener('click', () => {
            const index = parseInt((item as HTMLElement).dataset.index || '0');
            const link = backlinks[index];
            if (link && onNavigate) {
                onNavigate(link.source_path);
            }
            popup.remove();
        });
    });

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node) && e.target !== badge) {
            popup.remove();
            document.removeEventListener('click', closeHandler);
        }
    };

    setTimeout(() => {
        document.addEventListener('click', closeHandler);
    }, 100);

    document.body.appendChild(popup);
}

// Helper to update backlinks from outside
export function setHeadingBacklinks(
    editor: any,
    backlinks: SectionBacklinks,
    onNavigate?: (path: string) => void
) {
    if (editor?.storage?.headingBacklinks) {
        editor.storage.headingBacklinks.backlinks = backlinks;
        editor.storage.headingBacklinks.onNavigate = onNavigate;
        // Force redraw
        editor.view.dispatch(editor.view.state.tr);
    }
}
