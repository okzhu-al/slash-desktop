/**
 * DrawingExtension - Inline Infinite Canvas using Tldraw
 * 
 * A block-level node that embeds a Tldraw canvas directly in the document.
 * Implements dual-mode storage: PNG for viewing, JSON (.tldr) for editing.
 * 
 * Markdown format: ![alt](assets/drawing.png "tldraw:assets/drawing.tldr")
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DrawingNodeView } from './DrawingNodeView.js';

export interface DrawingOptions {
    HTMLAttributes: Record<string, unknown>;
    onSave?: (data: { png: Blob; json: string; width: number; height: number }, existingPngPath?: string, existingJsonPath?: string) => Promise<{ pngPath: string; jsonPath: string }>;
    onLoad?: (jsonPath: string) => Promise<string>;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        drawing: {
            insertDrawing: () => ReturnType;
        };
    }
}

export const DrawingExtension = Node.create<DrawingOptions>({
    name: 'drawing',

    group: 'block',

    atom: true,

    selectable: true,

    // draggable: false — Drawing nodes must NOT be ProseMirror-draggable.
    // ProseMirror sets DOM draggable="true" on NodeView wrappers when this is true.
    // In WebKit/macOS, mouse drag inside the canvas (arrows, resize handles)
    // triggers native HTML5 drag-and-drop → Tauri OS-level screenshot → ~2s freeze.
    draggable: false,

    addOptions() {
        return {
            HTMLAttributes: {
                'data-type': 'drawing',
            },
            onSave: undefined,
            onLoad: undefined,
        };
    },

    addAttributes() {
        return {
            // PNG path for viewing (relative to note)
            src: {
                default: null,
                parseHTML: element => element.getAttribute('data-src'),
                renderHTML: attributes => ({
                    'data-src': attributes.src,
                }),
            },
            // JSON path for editing (relative to note)
            json: {
                default: null,
                parseHTML: element => element.getAttribute('data-json'),
                renderHTML: attributes => ({
                    'data-json': attributes.json,
                }),
            },
            // Alt text for accessibility
            alt: {
                default: 'drawing',
                parseHTML: element => element.getAttribute('data-alt'),
                renderHTML: attributes => ({
                    'data-alt': attributes.alt,
                }),
            },
            // Container height (default 500px, adjustable via drag handle)
            height: {
                default: 500,
                parseHTML: element => {
                    const h = element.getAttribute('data-height');
                    return h ? parseInt(h, 10) : 500;
                },
                renderHTML: attributes => ({
                    'data-height': attributes.height,
                }),
            },
            // Edit mode flag (not persisted to markdown)
            isEditing: {
                default: false,
                rendered: false, // Don't render to HTML
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'div[data-type="drawing"]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(DrawingNodeView, {
            stopEvent: ({ event }) => {
                const target = event.target as HTMLElement;
                // Stop ProseMirror from handling events inside the editing canvas
                if (target.closest('.drawing-container.is-editing')) return true;
                // Also stop events from Tldraw portals (menus, color palettes, popups)
                // rendered at document.body level, outside .drawing-container
                if (target.closest('[class*="tlui-"]')) return true;
                if (target.closest('[class*="tl-"]')) return true;
                if (target.closest('[data-radix-popper-content-wrapper]')) return true;
                if (target.closest('[data-radix-dialog-content]')) return true;
                return false;
            }
        });
    },

    addProseMirrorPlugins() {
        return [];
    },

    addCommands() {
        return {
            insertDrawing:
                () =>
                    ({ tr }) => {
                        // Insert drawing AFTER current paragraph.
                        // Cursor stays in the paragraph above → scrollIntoView
                        // naturally shows the top of the drawing, not the bottom.
                        const { $from } = tr.selection;
                        const insertPos = $from.after($from.depth);
                        const drawingNode = this.type.create({ isEditing: true });
                        tr.insert(insertPos, drawingNode);
                        return true;
                    },
        };
    },

    // Markdown serialization for tiptap-markdown
    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const { src, json, alt, height } = node.attrs;

                    if (!src) {
                        // Unsaved drawing - don't serialize
                        return;
                    }

                    // Format: ![alt|height](src "tldraw:json")
                    let altText = alt || 'drawing';
                    if (height && height !== 500) {
                        altText += `|${height}`;
                    }

                    const title = json ? `tldraw:${json}` : '';
                    state.write(`![${altText}](${src}${title ? ` "${title}"` : ''})`);
                    state.ensureNewLine();
                },
                parse: {
                    setup(markdownit: any) {
                        markdownit.use((md: any) => {
                            // Store the previous image rule (could be ImageExtension's or default)
                            const previousImageRule = md.renderer.rules.image;

                            md.renderer.rules.image = (tokens: any, idx: number, options: any, env: any, self: any) => {
                                const token = tokens[idx];
                                const title = token.attrGet('title') || '';

                                // Check if this is a tldraw drawing (must check BEFORE ImageExtension processes it)
                                if (title.startsWith('tldraw:')) {
                                    const jsonPath = title.slice(7); // Remove 'tldraw:' prefix
                                    const src = token.attrGet('src') || '';
                                    const alt = token.content || 'drawing';

                                    // Parse height from alt text (format: alt|height)
                                    let height = 500;
                                    let cleanAlt = alt;
                                    const heightMatch = /\|(\d+)$/.exec(alt);
                                    if (heightMatch) {
                                        height = parseInt(heightMatch[1], 10);
                                        cleanAlt = alt.replace(/\|\d+$/, '');
                                    }

                                    // Return custom drawing element (intercept before ImageExtension)
                                    return `<div data-type="drawing" data-src="${src}" data-json="${jsonPath}" data-alt="${cleanAlt}" data-height="${height}"></div>`;
                                }

                                // Fall back to previous image rule (ImageExtension or default)
                                if (previousImageRule) {
                                    return previousImageRule(tokens, idx, options, env, self);
                                }
                                // Final fallback: use self.renderToken
                                return self.renderToken(tokens, idx, options);
                            };
                        });
                    },
                },
            },
        };
    },
});
