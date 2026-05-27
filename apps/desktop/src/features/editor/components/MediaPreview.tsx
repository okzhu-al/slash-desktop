import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MediaPreviewProps {
    path: string;
    filename: string;
}

export const MediaPreview = ({ path, filename }: MediaPreviewProps) => {
    const { t } = useTranslation();
    const [src, setSrc] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [mediaType, setMediaType] = useState<'image' | 'video' | 'unknown'>('unknown');

    useEffect(() => {
        let active = true;
        const loadMedia = async () => {
            setLoading(true);
            setError(null);
            try {
                const extension = path.split('.').pop()?.toLowerCase();

                if (['mp4', 'webm', 'mov', 'mkv'].includes(extension || '')) {
                    setMediaType('video');
                } else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(extension || '')) {
                    setMediaType('image');
                } else {
                    setMediaType('unknown');
                    throw new Error("Unsupported media type");
                }

                // Try Blob URL first for better compatibility (similar to MediaService)
                try {
                    const bytes = await readFile(path);
                    const mime = getMimeType(extension || '');
                    const blob = new Blob([bytes], { type: mime });
                    const blobUrl = URL.createObjectURL(blob);
                    if (active) setSrc(blobUrl);
                } catch (e) {
                    console.warn("Failed to create blob for media, falling back to asset://", e);
                    const assetUrl = convertFileSrc(path);
                    if (active) setSrc(assetUrl);
                }
            } catch (e: any) {
                if (active) setError(e.message || "Failed to load media");
            } finally {
                if (active) setLoading(false);
            }
        };

        loadMedia();

        return () => {
            active = false;
            // potential cleanup if we tracked blob urls to revoke them
        };
    }, [path]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-400">
                <Loader2 className="animate-spin mr-2" />
                {t('common.loading', 'Loading...')}
            </div>
        );
    }

    if (error || !src) {
        return (
            <div className="flex items-center justify-center h-full flex-col text-zinc-500">
                <p className="mb-2">⚠️ {error || "Could not display media"}</p>
                <p className="text-xs opacity-70">{path}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center h-full bg-zinc-50/50 dark:bg-zinc-900/50 p-8 overflow-hidden">
            <div className="relative max-w-full max-h-full shadow-lg rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-[url('/transparent-grid.png')]">
                {mediaType === 'video' ? (
                    <video
                        src={src}
                        controls
                        autoPlay={false}
                        className="max-w-full max-h-[80vh] object-contain block"
                    />
                ) : (
                    <img
                        src={src}
                        alt={filename}
                        className="max-w-full max-h-[80vh] object-contain block"
                    />
                )}
            </div>
            <div className="mt-4 text-sm text-zinc-500 font-mono select-text bg-zinc-100 dark:bg-zinc-800 px-3 py-1 rounded">
                {filename}
            </div>
        </div>
    );
};

function getMimeType(ext: string): string {
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'svg': return 'image/svg+xml';
        case 'mp4': return 'video/mp4';
        case 'webm': return 'video/webm';
        case 'mov': return 'video/quicktime';
        default: return 'application/octet-stream';
    }
}
