import { NodeViewWrapper } from '@tiptap/react';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useEditorServices } from '../../EditorDI';
import { useMediaEnrichment } from '../../hooks/useMediaEnrichment';

export const AudioComponent = (props: any) => {
    const { node } = props;
    const { src } = node.attrs;
    const [resolvedSrc, setResolvedSrc] = useState<string>('');
    const [isHovered, setIsHovered] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState<number | null>(null);
    const { fileSystemStore, mediaService, EnrichmentHoverCard } = useEditorServices();
    const [root, setRoot] = useState(() => fileSystemStore?.root || null);

    useEffect(() => {
        if (!fileSystemStore?.subscribe) return;
        const unsubscribe = fileSystemStore.subscribe((state: any) => {
            setRoot(state.root || null);
        });
        return unsubscribe;
    }, [fileSystemStore]);
    const [waveformBars, setWaveformBars] = useState<number[]>([]);
    const { enrichedText } = useMediaEnrichment(src);

    const audioRef = useRef<HTMLAudioElement>(null);
    const isImporting = src?.includes('_importing_');
    const isImportFailed = src?.includes('_import_failed_');

    // Generate random waveform bars (simplified visualization)
    useEffect(() => {
        const bars: number[] = [];
        const barCount = 50;
        for (let i = 0; i < barCount; i++) {
            // Create natural-looking wave pattern
            const base = 0.3;
            const variation = Math.random() * 0.7;
            bars.push(base + variation);
        }
        setWaveformBars(bars);
    }, [src]);

    // Resolve audio URL
    useEffect(() => {
        if (isImporting || isImportFailed) {
            setResolvedSrc('');
            return;
        }

        let isMounted = true;
        const resolve = async () => {
            if (!src) return;

            // Wait for root to be available if using relative path
            if (!root && !src.startsWith('http') && !src.startsWith('asset')) {
                return;
            }

            try {
                const url = await mediaService.getAssetUrl(src, root?.path);
                if (isMounted) setResolvedSrc(url);
            } catch (e) {
                console.error("Failed to resolve audio src:", src, e);
            }
        };
        resolve();
        return () => { isMounted = false; };
    }, [src, root, isImporting, isImportFailed]);

    // Audio time update
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleLoadedMetadata = () => setDuration(audio.duration);
        const handleEnded = () => setIsPlaying(false);

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('ended', handleEnded);

        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [resolvedSrc]);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;

        if (isPlaying) {
            audio.pause();
        } else {
            audio.play();
        }
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    const handleWaveformClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const audio = audioRef.current;
        const waveform = e.currentTarget;
        if (!audio || !waveform || !duration) return;

        const rect = waveform.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;
        audio.currentTime = percentage * duration;
        setCurrentTime(percentage * duration);
    }, [duration]);

    const formatTime = (time: number) => {
        if (!isFinite(time)) return '0:00';
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    // Show border when hovered (not when selected via editor selection)
    const isActive = isHovered;
    const progress = (duration && duration > 0) ? (currentTime / duration) : 0;

    if (isImporting || isImportFailed) {
        const placeholderClass = isImportFailed ? 'media-placeholder--failed' : 'media-placeholder--importing';
        return (
            <NodeViewWrapper
                className="audio-view"
                style={{ textAlign: 'left', display: 'block', clear: 'both' }}
            >
                <div className={`media-placeholder ${placeholderClass}`}>
                    <div className="media-placeholder__icon">♪</div>
                    <div className="media-placeholder__text">
                        {isImportFailed ? 'Audio import failed' : 'Importing audio...'}
                    </div>
                </div>
            </NodeViewWrapper>
        );
    }

    return (
        <NodeViewWrapper
            className="audio-view"
            style={{ textAlign: 'left', display: 'block', clear: 'both' }}
        >
            {/* Hidden audio element */}
            <audio ref={audioRef} src={resolvedSrc || undefined} preload="metadata" />

            <EnrichmentHoverCard content={enrichedText}>
                <div
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                            style={{
                                width: '100%',
                                minWidth: '200px',
                                maxWidth: '600px',
                            }}
                        >
                            {/* Main player container */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px 16px',
                        backgroundColor: '#f8f9fa',
                        borderRadius: '12px',
                        boxShadow: isActive ? '0 0 0 2px rgb(99 102 241)' : 'none',
                        transition: 'box-shadow 0.15s ease',
                    }}
                    className="dark:bg-zinc-800"
                >
                    {/* Play/Pause button */}
                    <button
                        onClick={togglePlay}
                        style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '50%',
                            backgroundColor: 'rgb(99 102 241)',
                            border: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            flexShrink: 0,
                            transition: 'transform 0.15s ease, background-color 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgb(79 70 229)';
                            e.currentTarget.style.transform = 'scale(1.05)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgb(99 102 241)';
                            e.currentTarget.style.transform = 'scale(1)';
                        }}
                    >
                        {isPlaying ? (
                            // Pause icon
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                                <rect x="2" y="1" width="3.5" height="12" rx="1" />
                                <rect x="8.5" y="1" width="3.5" height="12" rx="1" />
                            </svg>
                        ) : (
                            // Play icon
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                                <path d="M3 1.5v11l9-5.5-9-5.5z" />
                            </svg>
                        )}
                    </button>

                    {/* Waveform visualization */}
                    <div
                        onClick={handleWaveformClick}
                        style={{
                            flex: 1,
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '2px',
                            cursor: 'pointer',
                            position: 'relative',
                        }}
                    >
                        {waveformBars.map((height, idx) => {
                            const barProgress = idx / waveformBars.length;
                            const isPlayed = barProgress <= progress;
                            return (
                                <div
                                    key={idx}
                                    style={{
                                        flex: 1,
                                        height: `${height * 100}%`,
                                        backgroundColor: isPlayed ? 'rgb(99 102 241)' : 'rgba(99, 102, 241, 0.25)',
                                        borderRadius: '1px',
                                        transition: 'background-color 0.1s ease',
                                        minWidth: '2px',
                                    }}
                                />
                            );
                        })}
                    </div>

                    {/* Time display */}
                    <div
                        style={{
                            fontSize: '12px',
                            color: '#6b7280',
                            fontFamily: 'var(--font-mono)',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                        }}
                        className="dark:text-zinc-400"
                    >
                        {formatTime(currentTime)} / {formatTime(duration || 0)}
                    </div>
                </div>
            </div>
            </EnrichmentHoverCard>
        </NodeViewWrapper>
    );
};
