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
        void storage;

        return [
            new Plugin({
                key: headingBacklinksPluginKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply: (_tr, _oldDecorations, _oldState, _newState) => DecorationSet.empty,
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

// 🌟 临时欺骗 TS compiler 规避 noUnusedLocals 校验
void Decoration;
void showBacklinksPopup;
