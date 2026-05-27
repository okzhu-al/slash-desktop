/**
 * Markdown Sanitization Utilities
 *
 * Pre-processing for markdown content before parsing.
 * Separates sanitization (cleaning) from parsing (tokenization).
 */

/**
 * Sanitize markdown content before parsing
 *
 * Handles:
 * 1. Legacy <p> wrapper cleanup from old saves
 * 2. HTML entity decoding (&lt; &gt; etc.)
 *
 * Note: Multiple consecutive blank lines (3+) will be collapsed to a single
 * blank line by ProseMirror. This is acceptable behavior.
 *
 * @param content Raw markdown content
 * @returns Sanitized markdown ready for parsing
 */
export function sanitizeMarkdown(content: string): string {
    let cleanContent = content || '';

    // 1. 🧹 Clean legacy <p> wrapper from old saves
    while (/^<p>.*<\/p>$/s.test(cleanContent.trim())) {
        cleanContent = cleanContent.trim().replace(/^<p>(.*?)<\/p>$/s, '$1');
    }

    // 2. Decode HTML entities if present
    if (cleanContent.includes('&lt;') || cleanContent.includes('&gt;')) {
        const txt = document.createElement("textarea");
        txt.innerHTML = cleanContent;
        cleanContent = txt.value;
    }

    return cleanContent.trim();
}
