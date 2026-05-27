import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { VideoComponent } from './VideoComponent';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'avi'];

function isVideoUrl(src: string | null): boolean {
    if (!src) return false;
    const ext = src.split('.').pop()?.toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext || '');
}

export const VideoExtension = Node.create({
    name: 'video',
    group: 'block',
    inline: false,
    atom: true,

    // Higher priority than Image to capture video files first
    priority: 60,

    addAttributes() {
        return {
            src: {
                default: null,
            },
            width: {
                default: null,
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'video[src]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const { src, ...rest } = HTMLAttributes;
        return ['video', { src, ...rest }];
    },

    addNodeView() {
        return ReactNodeViewRenderer(VideoComponent);
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const src = node.attrs.src;
                    // 🛡️ Phase 6: 导入中/失败的占位节点不持久化到 Markdown（约束 #3）
                    if (src?.includes('_importing_') || src?.includes('_import_failed_')) {
                        return;
                    }
                    const width = node.attrs.width;
                    let alt = 'video';
                    if (width) {
                        alt += `|${width}`;
                    }
                    state.write(`![${alt}](${src})`);
                    // Ensure newline after video so subsequent blocks don't merge
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

                                if (isVideoUrl(src)) {
                                    // Extract width from alt if present
                                    const widthMatch = /\|(\d+)$/.exec(alt);
                                    const width = widthMatch ? widthMatch[1] : '';
                                    const widthAttr = width ? ` width="${width}"` : '';
                                    // Return video HTML directly
                                    return `<video src="${src}"${widthAttr}></video>`;
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
