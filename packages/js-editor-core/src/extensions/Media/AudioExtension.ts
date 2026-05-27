import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { AudioComponent } from './AudioComponent';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

function isAudioUrl(src: string | null): boolean {
    if (!src) return false;
    const ext = src.split('.').pop()?.toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext || '');
}

export const AudioExtension = Node.create({
    name: 'audio',
    group: 'block',
    inline: false,
    atom: true,

    // Higher priority than Image to capture audio files first
    priority: 60,

    addAttributes() {
        return {
            src: {
                default: null,
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'audio[src]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return ['audio', mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(AudioComponent);
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
                    state.write(`![audio](${src})`);
                    // Ensure newline after audio so subsequent blocks don't merge
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

                                if (isAudioUrl(src)) {
                                    // Return audio HTML directly instead of relying on defaultImageRule
                                    return `<audio src="${src}"></audio>`;
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
