import { useEffect, MutableRefObject } from 'react';

/**
 * Listens for 'scroll-to-line' custom events (usually emitted by global search or tasks panel) 
 * and navigates the ProseMirror view to the specific markdown line.
 */
export function useEditorScrollToLine(editorRef: MutableRefObject<any>) {
    useEffect(() => {
        const handleScrollToLine = (e: Event) => {
            const customEvent = e as CustomEvent<{ lineNumber: number }>;
            const lineNumber = customEvent.detail?.lineNumber;
            if (!lineNumber || lineNumber < 1) return;

            console.log('[Editor] scroll-to-line event received:', lineNumber);

            // Retry mechanism - try multiple times as content loads
            let attempts = 0;
            const maxAttempts = 20;
            const attemptScroll = () => {
                attempts++;
                const currentEditor = editorRef.current;

                if (!currentEditor || currentEditor.isDestroyed) {
                    if (attempts < maxAttempts) {
                        setTimeout(attemptScroll, 150);
                    }
                    return;
                }

                // Get MARKDOWN content for accurate line numbers (matches backend)
                const markdownContent = (currentEditor.storage as { markdown?: { getMarkdown?: () => string } })?.markdown?.getMarkdown?.() || '';
                const lines = markdownContent.split('\n');

                console.log('[Editor] Attempt', attempts, '- markdown lines:', lines.length, 'target:', lineNumber);

                // If we don't have enough lines yet and we have retries left, wait
                if (lines.length < lineNumber && attempts < maxAttempts) {
                    setTimeout(attemptScroll, 150);
                    return;
                }

                // Get the target line content
                const targetLineContent = lines[lineNumber - 1] || '';
                console.log('[Editor] Target line content:', targetLineContent.substring(0, 50) + '...');

                // Find the position of this line in the ProseMirror document
                // Simple approach: count textblocks to approximate line position
                // Since markdown lines map roughly to textblocks (paragraphs, headings, list items)
                let targetPos = 1;
                let textblockCount = 0;
                let found = false;

                // Count total textblocks first
                let totalTextblocks = 0;
                currentEditor.state.doc.descendants((node: { isTextblock: boolean }) => {
                    if (node.isTextblock) totalTextblocks++;
                    return true;
                });

                // Calculate approximate target textblock based on line ratio
                const targetBlockIndex = Math.round((lineNumber / lines.length) * totalTextblocks);
                console.log('[Editor] Total textblocks:', totalTextblocks, 'target block:', targetBlockIndex);

                currentEditor.state.doc.descendants((node: { isTextblock: boolean }, pos: number) => {
                    if (found) return false;
                    if (node.isTextblock) {
                        textblockCount++;
                        if (textblockCount >= targetBlockIndex) {
                            targetPos = pos + 1;
                            found = true;
                            return false;
                        }
                    }
                    return true;
                });

                console.log('[Editor] Final: line', lineNumber, '-> textblock', textblockCount, 'pos:', targetPos);

                // Scroll to position using TipTap's built-in scrollIntoView
                try {
                    currentEditor.chain()
                        .focus()
                        .setTextSelection(targetPos)
                        .scrollIntoView()
                        .run();

                    // Also force DOM-level scroll after a short delay
                    setTimeout(() => {
                        try {
                            const { view } = currentEditor;
                            // Get the DOM node at the cursor position
                            const domAtPos = view.domAtPos(targetPos);
                            if (domAtPos && domAtPos.node) {
                                // Find the nearest block element to scroll to
                                const element = domAtPos.node.nodeType === 1
                                    ? domAtPos.node as Element
                                    : domAtPos.node.parentElement;

                                if (element) {
                                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    console.log('[Editor] DOM scrollIntoView executed on:', element.nodeName);
                                }
                            }
                        } catch (scrollErr) {
                            console.warn('[Editor] DOM scroll error:', scrollErr);
                        }
                    }, 50);

                    console.log('[Editor] Scrolled to pos', targetPos, 'via scrollIntoView');
                } catch (err) {
                    console.warn('[Editor] Failed to scroll to line:', err);
                }
            };

            // Start first attempt after a delay to let content load
            setTimeout(attemptScroll, 50);
        };

        window.addEventListener('scroll-to-line', handleScrollToLine);
        return () => window.removeEventListener('scroll-to-line', handleScrollToLine);
    }, [editorRef]);
}
