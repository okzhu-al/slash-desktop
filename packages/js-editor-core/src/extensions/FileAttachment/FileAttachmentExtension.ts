import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { FileAttachmentComponent } from './FileAttachmentComponent';
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'];

// Helper to determine if a URL should be handled by this extension
// It handles everything that is NOT an image, video, or audio
function isFileAttachmentUrl(src: string | null): boolean {
    if (!src) return false;
    const ext = src.split('.').pop()?.toLowerCase() || '';
    if (!ext) return false;
    
    const isMedia = 
        IMAGE_EXTENSIONS.includes(ext) || 
        VIDEO_EXTENSIONS.includes(ext) || 
        AUDIO_EXTENSIONS.includes(ext);
        
    // It's a file attachment if it has an extension but is NOT media
    // We also only want to capture internal assets
    return !isMedia && (src.startsWith('assets/') || src.startsWith('http'));
}

export const FileAttachmentExtension = Node.create({
    name: 'fileAttachment',
    group: 'block',
    inline: false,
    atom: true,

    // Priority lower than Video/Audio but high enough to capture image syntax
    priority: 50,

    addAttributes() {
        return {
            src: {
                default: null,
                parseHTML: element => element.getAttribute('data-src'),
            },
            filename: {
                default: null,
                parseHTML: element => element.getAttribute('data-filename'),
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'div[data-file-attachment]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { src, filename, ...rest } = HTMLAttributes;
        return ['div', { 'data-file-attachment': true, 'data-src': src, 'data-filename': filename, ...rest }];
    },

    addNodeView() {
        return ReactNodeViewRenderer(FileAttachmentComponent);
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const src = node.attrs.src;
                    const filename = node.attrs.filename || src.split('/').pop();
                    state.write(`![${filename}](${src})`);
                    state.ensureNewLine();
                },
                parse: {
                    setup(markdownit: any) {
                        markdownit.use((md: any) => {
                            const defaultImageRule = md.renderer.rules.image || function (tokens: any, idx: any, options: any, _env: any, self: any) {
                                return self.renderToken(tokens, idx, options);
                            };

                            md.renderer.rules.image = (tokens: any, idx: number, options: any, _env: any, self: any) => {
                                const token = tokens[idx];
                                const src = token.attrGet('src');
                                const alt = token.content;

                                if (isFileAttachmentUrl(src)) {
                                    // Return fileAttachment HTML
                                    return `<div data-file-attachment="true" data-src="${src}" data-filename="${alt}"></div>`;
                                }

                                return defaultImageRule(tokens, idx, options, _env, self);
                            };
                        });
                    },
                },
            },
        };
    },
});
