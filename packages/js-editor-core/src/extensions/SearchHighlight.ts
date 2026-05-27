/**
 * SearchHighlight Extension
 * 
 * Provides text search decoration for TipTap editor
 * Highlights all matches and tracks current match for navigation
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SearchHighlightOptions {
    searchTerm: string;
    currentMatchIndex: number;
    caseSensitive: boolean;
}

export interface SearchHighlightStorage {
    searchTerm: string;
    currentMatchIndex: number;
    caseSensitive: boolean;
    matchCount: number;
    matchPositions: Array<{ from: number; to: number }>;
}

const searchHighlightPluginKey = new PluginKey('searchHighlight');

// Helper to get typed storage from editor
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getStorage(editor: { storage: any }): SearchHighlightStorage {
    return editor.storage.searchHighlight as SearchHighlightStorage;
}

export const SearchHighlight = Extension.create<SearchHighlightOptions, SearchHighlightStorage>({
    name: 'searchHighlight',

    addOptions() {
        return {
            searchTerm: '',
            currentMatchIndex: 0,
            caseSensitive: false,
        };
    },

    addStorage() {
        return {
            searchTerm: '',
            currentMatchIndex: 0,
            caseSensitive: false,
            matchCount: 0,
            matchPositions: [],
        };
    },

    addCommands() {
        return {
            setSearchTerm: (searchTerm: string, caseSensitive = false) => ({ editor }) => {
                const storage = getStorage(editor);
                storage.searchTerm = searchTerm;
                storage.caseSensitive = caseSensitive;
                storage.currentMatchIndex = 0;
                // Force view update
                editor.view.dispatch(editor.state.tr);
                return true;
            },
            clearSearch: () => ({ editor }) => {
                const storage = getStorage(editor);
                storage.searchTerm = '';
                storage.currentMatchIndex = 0;
                storage.matchCount = 0;
                storage.matchPositions = [];
                editor.view.dispatch(editor.state.tr);
                return true;
            },
            goToNextMatch: () => ({ editor }) => {
                const storage = getStorage(editor);
                if (storage.matchCount === 0) return false;
                storage.currentMatchIndex = (storage.currentMatchIndex + 1) % storage.matchCount;

                // Scroll to current match
                const pos = storage.matchPositions[storage.currentMatchIndex];
                if (pos) {
                    // Set selection
                    editor.chain().setTextSelection(pos.from).run();

                    // Use DOM API to scroll the highlight into view
                    setTimeout(() => {
                        const highlightEl = editor.view.dom.querySelector('.search-highlight-current');
                        if (highlightEl) {
                            highlightEl.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center',
                            });
                        }
                    }, 20);
                } else {
                    editor.view.dispatch(editor.state.tr);
                }
                return true;
            },
            goToPrevMatch: () => ({ editor }) => {
                const storage = getStorage(editor);
                if (storage.matchCount === 0) return false;
                storage.currentMatchIndex = (storage.currentMatchIndex - 1 + storage.matchCount) % storage.matchCount;

                // Scroll to current match
                const pos = storage.matchPositions[storage.currentMatchIndex];
                if (pos) {
                    // Set selection
                    editor.chain().setTextSelection(pos.from).run();

                    // Use DOM API to scroll the highlight into view
                    setTimeout(() => {
                        const highlightEl = editor.view.dom.querySelector('.search-highlight-current');
                        if (highlightEl) {
                            highlightEl.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center',
                            });
                        }
                    }, 20);
                } else {
                    editor.view.dispatch(editor.state.tr);
                }
                return true;
            },
        };
    },

    addProseMirrorPlugins() {
        const extension = this;

        return [
            new Plugin({
                key: searchHighlightPluginKey,
                state: {
                    init() {
                        return DecorationSet.empty;
                    },
                    apply(_tr, _oldDecorations, _oldState, newState) {
                        const storage = extension.storage;
                        const searchTerm = storage.searchTerm;

                        if (!searchTerm) {
                            storage.matchCount = 0;
                            storage.matchPositions = [];
                            return DecorationSet.empty;
                        }

                        const decorations: Decoration[] = [];
                        const positions: Array<{ from: number; to: number }> = [];

                        // Get text content and find matches
                        newState.doc.descendants((node, pos) => {
                            if (!node.isText || !node.text) return;

                            const text = storage.caseSensitive
                                ? node.text
                                : node.text.toLowerCase();
                            const term = storage.caseSensitive
                                ? searchTerm
                                : searchTerm.toLowerCase();

                            let index = 0;
                            while ((index = text.indexOf(term, index)) !== -1) {
                                const from = pos + index;
                                const to = from + searchTerm.length;
                                positions.push({ from, to });
                                index += 1;
                            }
                        });

                        storage.matchCount = positions.length;
                        storage.matchPositions = positions;

                        // Create decorations for all matches
                        positions.forEach((p, idx) => {
                            const isCurrent = idx === storage.currentMatchIndex;
                            decorations.push(
                                Decoration.inline(p.from, p.to, {
                                    class: isCurrent
                                        ? 'search-highlight-current'
                                        : 'search-highlight',
                                })
                            );
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

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        searchHighlight: {
            setSearchTerm: (searchTerm: string, caseSensitive?: boolean) => ReturnType;
            clearSearch: () => ReturnType;
            goToNextMatch: () => ReturnType;
            goToPrevMatch: () => ReturnType;
        };
    }
}
