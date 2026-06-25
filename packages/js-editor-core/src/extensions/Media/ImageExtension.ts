import { Image } from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageComponent } from './ImageComponent';

export const CustomImageExtension = Image.extend({
    group: 'block',
    inline: false,

    addAttributes() {
        return {
            ...this.parent?.(),
            width: {
                default: null,
            },
        };
    },

    addNodeView() {
        return ReactNodeViewRenderer(ImageComponent);
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: any) {
                    const { alt, src, width } = node.attrs;
                    // 🛡️ Phase 6: 导入中/失败的占位节点不持久化到 Markdown（约束 #3）
                    if (src?.includes('_importing_') || src?.includes('_import_failed_')) {
                        return;
                    }
                    let altText = alt || '';
                    if (width) {
                        altText += `|${width}`;
                    }
                    state.write(`![${altText}](${src})`);
                    // Ensure newline after image so subsequent blocks don't merge with image link
                    state.ensureNewLine();
                },
                parse: {
                    setup(markdownit: any) {
                        markdownit.use((md: any) => {
                            const defaultImageRule = md.renderer.rules.image;
                            md.renderer.rules.image = (tokens: any, idx: number, options: any, _env: any, self: any) => {
                                const token = tokens[idx];
                                const alt = token.content;

                                // Regex to match |width at the end of alt text
                                const widthMatch = /\|(\d+)$/.exec(alt);
                                if (widthMatch) {
                                    token.attrSet('width', widthMatch[1]);
                                    // Clean up alt text to not show |width
                                    token.content = alt.replace(/\|\d+$/, '');
                                }

                                return defaultImageRule(tokens, idx, options, _env, self);
                            };
                        });
                    },
                },
            },
        };
    },
}).configure({
    inline: false,
    allowBase64: true,
});
