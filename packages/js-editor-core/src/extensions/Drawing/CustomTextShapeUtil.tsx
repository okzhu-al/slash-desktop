/**
 * CustomTextShapeUtil - Override Tldraw's TextShapeUtil to fix WebKit foreignObject scaling bug
 * 
 * Problem: Tldraw uses <foreignObject> to render HTML text in SVG exports.
 * WebKit (used by Tauri on macOS) has a bug where foreignObject content
 * doesn't scale properly, causing text to appear stretched/wider than shapes.
 * 
 * Solution: Override toSvg() to render text using native SVG <text> elements
 * instead of foreignObject, ensuring consistent rendering across all browsers.
 */

import { TextShapeUtil, TLTextShape, SvgExportContext } from 'tldraw';

export class CustomTextShapeUtil extends TextShapeUtil {
    // Override toSvg to use native SVG text instead of foreignObject
    override toSvg(shape: TLTextShape, _ctx: SvgExportContext) {
        // Use parent's getText method to get text content
        const text = this.getText(shape) || '';
        const props = shape.props as { font: string; size: string; color: string; textAlign: string };
        const { font, size, color, textAlign } = props;
        const bounds = this.editor.getShapeGeometry(shape).bounds;

        // Map Tldraw font to CSS font-family
        const fontFamilyMap: Record<string, string> = {
            draw: 'tldraw_draw, LXGW WenKai, cursive',
            sans: 'tldraw_sans, sans-serif',
            serif: 'tldraw_serif, serif',
            mono: 'tldraw_mono, monospace',
        };

        // Map Tldraw size to font size
        const fontSizeMap: Record<string, number> = {
            s: 18,
            m: 28,
            l: 36,
            xl: 48,
        };

        // Map Tldraw color to actual color value
        const colorMap: Record<string, string> = {
            black: '#1d1d1d',
            grey: '#9ca3af',
            'light-violet': '#e879f9',
            violet: '#a855f7',
            blue: '#3b82f6',
            'light-blue': '#38bdf8',
            yellow: '#facc15',
            orange: '#f97316',
            green: '#22c55e',
            'light-green': '#84cc16',
            'light-red': '#fb7185',
            red: '#ef4444',
            white: '#ffffff',
        };

        // Map text alignment to SVG text-anchor
        const textAnchorMap: Record<string, 'start' | 'middle' | 'end'> = {
            start: 'start',
            middle: 'middle',
            end: 'end',
        };

        const fontFamily = fontFamilyMap[font] || 'sans-serif';
        const fontSize = fontSizeMap[size] || 28;
        const textColor = colorMap[color] || '#1d1d1d';
        const textAnchor = textAnchorMap[textAlign] || 'start';

        // Calculate x position based on alignment
        let x = 0;
        if (textAlign === 'middle') {
            x = bounds.width / 2;
        } else if (textAlign === 'end') {
            x = bounds.width;
        }

        // Split text into lines
        const lines = text.split('\n');
        const lineHeight = fontSize * 1.2;

        return (
            <g>
                {lines.map((line: string, index: number) => (
                    <text
                        key={index}
                        x={x}
                        y={(index + 1) * lineHeight}
                        fontFamily={fontFamily}
                        fontSize={fontSize}
                        fill={textColor}
                        textAnchor={textAnchor}
                        dominantBaseline="alphabetic"
                    >
                        {line}
                    </text>
                ))}
            </g>
        );
    }
}
