import { NodeViewWrapper } from '@tiptap/react';
import { useCallback, useState } from 'react';
import { useEditorServices } from '../../EditorDI';

interface FileAttachmentProps {
    node: any;
}

// Map extensions to color themes
const getFileTheme = (ext: string) => {
    switch (ext) {
        case 'pdf':
            return {
                icon: 'text-red-500',
                bg: 'bg-red-50 dark:bg-red-900/20',
                border: 'border-red-200 dark:border-red-900/30',
                hover: 'hover:bg-red-100 dark:hover:bg-red-900/40'
            };
        case 'doc':
        case 'docx':
            return {
                icon: 'text-blue-500',
                bg: 'bg-blue-50 dark:bg-blue-900/20',
                border: 'border-blue-200 dark:border-blue-900/30',
                hover: 'hover:bg-blue-100 dark:hover:bg-blue-900/40'
            };
        case 'xls':
        case 'xlsx':
        case 'csv':
            return {
                icon: 'text-green-500',
                bg: 'bg-green-50 dark:bg-green-900/20',
                border: 'border-green-200 dark:border-green-900/30',
                hover: 'hover:bg-green-100 dark:hover:bg-green-900/40'
            };
        case 'ppt':
        case 'pptx':
            return {
                icon: 'text-orange-500',
                bg: 'bg-orange-50 dark:bg-orange-900/20',
                border: 'border-orange-200 dark:border-orange-900/30',
                hover: 'hover:bg-orange-100 dark:hover:bg-orange-900/40'
            };
        case 'zip':
        case 'rar':
        case '7z':
        case 'tar':
        case 'gz':
            return {
                icon: 'text-amber-500',
                bg: 'bg-amber-50 dark:bg-amber-900/20',
                border: 'border-amber-200 dark:border-amber-900/30',
                hover: 'hover:bg-amber-100 dark:hover:bg-amber-900/40'
            };
        case 'js':
        case 'ts':
        case 'py':
        case 'json':
        case 'html':
        case 'css':
        case 'rs':
        case 'go':
            return {
                icon: 'text-indigo-500',
                bg: 'bg-indigo-50 dark:bg-indigo-900/20',
                border: 'border-indigo-200 dark:border-indigo-900/30',
                hover: 'hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
            };
        case 'txt':
        case 'md':
            return {
                icon: 'text-zinc-500',
                bg: 'bg-zinc-50 dark:bg-zinc-900/20',
                border: 'border-zinc-200 dark:border-zinc-900/30',
                hover: 'hover:bg-zinc-100 dark:hover:bg-zinc-900/40'
            };
        default:
            return {
                icon: 'text-gray-500',
                bg: 'bg-gray-50 dark:bg-gray-900/20',
                border: 'border-gray-200 dark:border-gray-900/30',
                hover: 'hover:bg-gray-100 dark:hover:bg-gray-900/40'
            };
    }
};

export const FileAttachmentComponent = ({ node }: FileAttachmentProps) => {
    const { src, filename } = node.attrs;
    const { mediaService } = useEditorServices();
    const [isOpening, setIsOpening] = useState(false);

    const getCleanExt = (path: string | undefined | null) => {
        if (!path) return '';
        const cleanPath = path.split('?')[0].split('#')[0];
        const parts = cleanPath.split('.');
        if (parts.length > 1) {
            const possibleExt = parts.pop()?.toLowerCase() || '';
            // Valid extensions are usually alphanumeric and short
            if (/^[a-z0-9]{1,5}$/.test(possibleExt)) {
                return possibleExt;
            }
        }
        return '';
    };

    let ext = getCleanExt(src);
    if (!ext) {
        ext = getCleanExt(filename);
    }

    const isHttpLink = src?.startsWith('http://') || src?.startsWith('https://');

    let displayExt = ext ? ext.toUpperCase() : 'FILE';
    let displayName = filename || (src ? decodeURIComponent(src.split('/').pop() || '') : '') || 'Unknown File';
    let theme = getFileTheme(ext);
    
    // DEBUG: Always show what we actually received if it's unknown or missing extension
    if (!ext || displayName === 'Unknown File') {
        displayName = `DEBUG: src=[${src}], filename=[${filename}]`;
    }

    // Special handling for HTTP links that don't look like files
    if (isHttpLink && !ext) {
        displayExt = 'LINK';
        theme = {
            icon: 'text-indigo-500',
            bg: 'bg-indigo-50 dark:bg-indigo-900/20',
            border: 'border-indigo-200 dark:border-indigo-900/30',
            hover: 'hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
        };
        try {
            const urlObj = new URL(src);
            displayName = filename || urlObj.hostname || 'External Link';
        } catch (e) {
            displayName = filename || 'External Link';
        }
    } else if (!ext && !displayName) {
        displayName = 'Unknown File';
    }

    const handleClick = useCallback(async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!src) return;
        
        setIsOpening(true);
        try {
            await mediaService.openAsset(src);
        } catch (error) {
            console.error("Failed to open file attachment:", error);
        } finally {
            setTimeout(() => setIsOpening(false), 500); // Visual feedback
        }
    }, [src, mediaService]);

    return (
        <NodeViewWrapper as="span" className="inline-block align-middle mx-1 my-1">
            <span
                onClick={handleClick}
                className={`group inline-flex items-center gap-2.5 px-3 py-1.5 rounded-lg border cursor-pointer transition-all ${theme.bg} ${theme.border} ${theme.hover} select-none`}
                title={isHttpLink ? "点击在浏览器中打开" : "点击在默认程序中打开"}
            >
                <span className={`flex items-center justify-center ${theme.icon} ${isOpening ? 'animate-pulse' : ''}`}>
                    {ext === 'pdf' ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                            <polyline points="14 2 14 8 20 8" />
                            <path d="M8 13h2" />
                            <path d="M8 17h2" />
                            <path d="M14 13h2" />
                            <path d="M14 17h2" />
                        </svg>
                    ) : displayExt === 'LINK' ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                    ) : ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 8v13H3V8" />
                            <path d="M1 3h22v5H1z" />
                            <path d="M10 12h4v4h-4z" />
                        </svg>
                    ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                            <polyline points="14 2 14 8 20 8" />
                        </svg>
                    )}
                </span>
                <span className="flex flex-col">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 max-w-[200px] truncate leading-tight">
                        {displayName}
                    </span>
                    <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 leading-none mt-0.5 tracking-wide">
                        {displayExt}
                    </span>
                </span>
                <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-gray-500">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                </span>
            </span>
        </NodeViewWrapper>
    );
};
