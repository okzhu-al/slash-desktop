import { Mark, mergeAttributes, getMarkRange } from '@tiptap/core';
import { InputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';

export interface CustomLinkOptions {
    openOnClick: boolean;
    autolink: boolean;
    HTMLAttributes: Record<string, any>;
    onLocalLinkClick?: (href: string) => void;
    onExternalLinkClick?: (href: string) => void;
}

/**
 * Custom Link extension with InputRule for markdown-style links
 * Supports: [text](url) syntax that auto-converts to clickable links
 * Backspace at right edge enters edit mode showing [text](url)
 */
export const CustomLink = Mark.create<CustomLinkOptions>({
    name: 'link',

    priority: 1000,

    inclusive: false,

    addOptions() {
        return {
            openOnClick: true,
            autolink: true,
            onLocalLinkClick: undefined,
            onExternalLinkClick: undefined,
            HTMLAttributes: {
                class: 'text-blue-600 dark:text-blue-400 underline cursor-pointer',
                rel: 'noopener noreferrer',
            },
        };
    },

    addAttributes() {
        return {
            href: {
                default: null,
            },
            rel: {
                default: this.options.HTMLAttributes.rel,
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'a[href]',
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const href = HTMLAttributes.href || '';
        // Only inject target="_blank" for true external URLs.
        // This prevents Tauri's WebView from eagerly routing local `assets/` links to the system's Web Browser.
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
            HTMLAttributes.target = '_blank';
        } else {
            delete HTMLAttributes.target;
        }
        
        return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
    },

    addInputRules() {
        // Helper to check if we're inside code or math
        const isInsideCodeOrMath = (state: any, pos: number, matchedText?: string): boolean => {
            const $pos = state.doc.resolve(pos);
            // Check for code or math marks on current position
            const marks = $pos.marks();
            if (marks.some((m: any) => m.type.name === 'code')) return true;

            // Check parent for code block
            for (let d = $pos.depth; d > 0; d--) {
                const node = $pos.node(d);
                if (node.type.name === 'codeBlock' || node.type.name === 'math') {
                    return true;
                }
            }

            // Check if the matched text itself starts with a backtick or dollar sign
            if (matchedText && (matchedText.startsWith('`') || matchedText.startsWith('$'))) {
                return true;
            }

            // Check if character right before pos is a backtick or dollar sign
            if (pos > 0) {
                const charBefore = state.doc.textBetween(pos - 1, pos);
                if (charBefore === '`' || charBefore === '$') {
                    return true;
                }
            }

            // Check for unclosed backticks or dollar signs in the text before cursor
            const textBefore = state.doc.textBetween(0, pos, '\n');

            // Count backticks - odd count means we're inside inline code
            let backtickCount = 0;
            for (let i = 0; i < textBefore.length; i++) {
                if (textBefore[i] === '`') {
                    backtickCount++;
                }
            }
            if (backtickCount % 2 === 1) {
                return true;
            }

            // Count $ for inline math - odd count means we're inside math
            let dollarCount = 0;
            for (let i = 0; i < textBefore.length; i++) {
                if (textBefore[i] === '$') {
                    // Skip double dollars ($$)
                    if (i + 1 < textBefore.length && textBefore[i + 1] === '$') {
                        i++;
                        continue;
                    }
                    dollarCount++;
                }
            }
            if (dollarCount % 2 === 1) {
                return true;
            }

            return false;
        };

        return [
            // Match [text](url) pattern and convert to link
            new InputRule({
                find: /\[([^\]]+)\]\(([^)]+)\)$/,
                handler: ({ state, range, match, chain }) => {
                    // Skip if inside code or math block - pass matched text to check for leading backtick/$
                    if (isInsideCodeOrMath(state, range.from, match[0])) return;

                    const text = match[1];
                    let url = match[2];

                    // Validate URL - 支持 http://, https://, mailto:, www.
                    if (!url) return;
                    // www. 开头自动补全 https://
                    if (url.startsWith('www.')) {
                        url = 'https://' + url;
                    }
                    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
                        return;
                    }

                    chain()
                        .deleteRange(range)
                        .insertContent({
                            type: 'text',
                            text: text,
                            marks: [
                                {
                                    type: 'link',
                                    attrs: { href: url },
                                },
                            ],
                        })
                        .run();
                },
            }),
        ];
    },

    addKeyboardShortcuts() {
        return {
            // Backspace at right edge of link enters edit mode
            // Shows "[text](url)" for editing
            Backspace: ({ editor }) => {
                const { state } = editor;
                const { selection } = state;

                // Only handle collapsed cursor
                if (!selection.empty) return false;

                const { $from } = selection;
                const pos = $from.pos;

                // Check if cursor is at the end of a link mark
                const linkMark = state.doc.resolve(pos - 1).marks().find(m => m.type.name === 'link');
                if (!linkMark) return false;

                // Check if we're at the right edge of the link
                const afterMark = pos < state.doc.content.size
                    ? state.doc.resolve(pos).marks().find(m => m.type.name === 'link')
                    : null;

                // We're at the right edge if the character before has the mark but character after doesn't
                if (afterMark) return false;

                // Use robust getMarkRange from TipTap core instead of looping backwards
                const linkRange = getMarkRange(state.doc.resolve(pos - 1), state.schema.marks.link);
                if (!linkRange) return false;

                const { from: linkStart, to: linkEnd } = linkRange;

                // Get the link text
                const linkText = state.doc.textBetween(linkStart, linkEnd);

                // Get the link's href
                const href = linkMark.attrs.href;
                if (!href) return false;

                // Build the markdown syntax: [text](url)
                const markdownLink = `[${linkText}](${href})`;

                // Replace the link with markdown syntax
                const { tr } = state;
                tr.delete(linkStart, linkEnd);
                
                // Using tr.insert avoids inadvertently triggering ProseMirror input rules on the generated syntax string
                tr.insert(linkStart, state.schema.text(markdownLink));

                // Position cursor at the end (before the closing paren)
                const newPos = linkStart + markdownLink.length - 1;
                tr.setSelection(TextSelection.create(tr.doc, newPos));

                editor.view.dispatch(tr);
                return true;
            },
        };
    },

    addProseMirrorPlugins() {
        const { openOnClick, onLocalLinkClick, onExternalLinkClick } = this.options;

        return [
            new Plugin({
                key: new PluginKey('customLinkClick'),
                props: {
                    handleClick: (_view, _pos, event) => {
                        if (!openOnClick) return false;

                        const targetElement = event.target as HTMLElement;
                        const aTag = targetElement.closest('a');
                        
                        if (aTag && aTag.hasAttribute('href')) {
                            event.preventDefault();
                            const href = aTag.getAttribute('href');
                            if (href) {
                                if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                                    if (onExternalLinkClick) {
                                        onExternalLinkClick(href);
                                    } else {
                                        window.open(href, '_blank', 'noopener,noreferrer');
                                    }
                                } else if (onLocalLinkClick) {
                                    onLocalLinkClick(href);
                                }
                            }
                            return true;
                        }

                        return false;
                    },
                },
            }),
        ];
    },
});
