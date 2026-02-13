import { useState, useRef, useCallback, useEffect } from 'react';
import { needsTransmux, transmuxToFMP4 } from '../../utils/mkvHandler.js';
import { parseSubtitles } from '../../utils/subtitleParser.js';
import Controls from './Controls.jsx';

export default function VideoPlayer({
    isHost,
    videoRef,
    movieBlobUrl,       // Viewer: blob URL from data channel transfer
    downloadProgress,   // Viewer: 0-100 download progress
    isReceiving,        // Viewer: currently receiving file transfer
    onFileReady,        // Host: callback with (file, blobUrl) when movie is ready
    onTimeUpdate,
    onSubtitlesLoaded,
    playbackSync,
    socket,
    streamHandlersRef,
}) {

    const [localMovieUrl, setLocalMovieUrl] = useState(null);
    const [mediaSourceUrl, setMediaSourceUrl] = useState(null);
    const mediaSourceRef = useRef(null);
    const sourceBufferRef = useRef(null);
    const chunkQueueRef = useRef([]);

    // MSE Logic
    useEffect(() => {
        if (isHost || !streamHandlersRef?.current) return;

        streamHandlersRef.current.onMeta = (meta) => {
            // Use the MIME type sent by Host (includes codecs)
            // Note: meta.type is 'file-meta', we need meta.mimeType
            const mimeType = meta.mimeType || 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

            if (MediaSource.isTypeSupported(mimeType)) {
                console.log('[player] initializing MSE for streaming with type:', mimeType);
                const ms = new MediaSource();
                mediaSourceRef.current = ms;

                ms.addEventListener('sourceopen', () => {
                    try {
                        const sb = ms.addSourceBuffer(mimeType);
                        sourceBufferRef.current = sb;
                        sb.addEventListener('updateend', processQueue);
                        console.log('[player] source buffer ready');
                    } catch (e) {
                        console.error('[player] MSE addSourceBuffer error:', e);
                    }
                });

                const url = URL.createObjectURL(ms);
                setMediaSourceUrl(url);
            } else {
                console.warn('[player] MSE not supported for type:', mimeType);
            }
        };

        streamHandlersRef.current.onChunk = (chunk) => {
            chunkQueueRef.current.push(chunk);
            processQueue();
        };

        const processQueue = () => {
            const sb = sourceBufferRef.current;
            if (!sb || sb.updating || chunkQueueRef.current.length === 0) return;

            try {
                const chunk = chunkQueueRef.current.shift();
                sb.appendBuffer(chunk);
            } catch (e) {
                console.error('[player] appendBuffer error:', e);
            }
        };

        return () => {
            if (mediaSourceUrl) {
                URL.revokeObjectURL(mediaSourceUrl);
            }
            mediaSourceRef.current = null;
            sourceBufferRef.current = null;
            chunkQueueRef.current = [];
        };
    }, [isHost, streamHandlersRef]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [error, setError] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef(null);
    const subtitleInputRef = useRef(null);
    const selectedFileRef = useRef(null);

    // Handle file selection (host only)
    const handleFileSelect = useCallback(
        async (file) => {
            if (!file) return;
            setError('');
            setIsLoading(true);
            setLoadProgress(0);

            try {
                let url;
                let processedFile = file;

                if (needsTransmux(file)) {
                    setLoadProgress(5);
                    // transmuxToFMP4 returns { url, mime, isHevc }
                    const result = await transmuxToFMP4(file, (p) => setLoadProgress(p));
                    url = result.url;
                    const mime = result.mime;
                    const isHevc = result.isHevc;

                    if (isHevc) {
                        console.log('[player] HEVC detected. MSE support depends on browser/hardware.');
                    }

                    // Fetch blob for transfer
                    const response = await fetch(url);
                    const blob = await response.blob();

                    // Force .mp4 extension and use detected mime
                    const newName = file.name.replace(/\.[^/.]+$/, "") + ".mp4";
                    processedFile = new File([blob], newName, {
                        type: mime,
                    });
                } else {
                    url = URL.createObjectURL(file);
                }

                setLocalMovieUrl(url);
                selectedFileRef.current = processedFile;
                setIsLoading(false);

                // Notify room about the movie
                socket.current?.emit('movie-loaded', {
                    name: file.name,
                    duration: 0,
                });

                // Pass the file to parent for data channel transfer
                onFileReady?.(processedFile, url);
            } catch (err) {
                setError(`Failed to load movie: ${err.message}`);
                setIsLoading(false);
            }
        },
        [socket, onFileReady]
    );

    // Handle subtitle file
    const handleSubtitleFile = useCallback(
        async (file) => {
            if (!file) return;
            try {
                const text = await file.text();
                const cues = parseSubtitles(text, file.name);
                onSubtitlesLoaded?.(cues, file.name);
            } catch (err) {
                setError(`Failed to load subtitles: ${err.message}`);
            }
        },
        [onSubtitlesLoaded]
    );

    // Drag and drop
    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };
    const handleDragLeave = () => setIsDragging(false);
    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) {
            if (file.name.match(/\.(srt|ass|ssa)$/i)) {
                handleSubtitleFile(file);
            } else {
                handleFileSelect(file);
            }
        }
    };

    // When video metadata loads
    const handleLoadedMetadata = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        socket.current?.emit('movie-loaded', {
            name: localMovieUrl || movieBlobUrl ? 'Movie' : '',
            duration: video.duration,
        });
    }, [videoRef, localMovieUrl, movieBlobUrl, socket]);

    // Set viewer's video source from blob URL
    useEffect(() => {
        if (!isHost && movieBlobUrl && videoRef.current) {
            videoRef.current.src = movieBlobUrl;
        }
    }, [isHost, movieBlobUrl, videoRef]);

    // Time update handler
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTime = () => {
            onTimeUpdate?.(video.currentTime);
        };

        video.addEventListener('timeupdate', handleTime);
        return () => video.removeEventListener('timeupdate', handleTime);
    }, [videoRef, onTimeUpdate]);

    // Playback sync handlers
    const handlePlay = useCallback(() => {
        const video = videoRef.current;
        if (video) playbackSync?.emitPlay(video.currentTime);
    }, [videoRef, playbackSync]);

    const handlePause = useCallback(() => {
        const video = videoRef.current;
        if (video) playbackSync?.emitPause(video.currentTime);
    }, [videoRef, playbackSync]);

    const handleSeek = useCallback(() => {
        const video = videoRef.current;
        if (video) playbackSync?.emitSeek(video.currentTime);
    }, [videoRef, playbackSync]);

    // Host file picker area (when no movie loaded)
    if (isHost && !localMovieUrl && !isLoading) {
        return (
            <div
                className={`player__dropzone ${isDragging ? 'player__dropzone--active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <div className="player__dropzone-content">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <h3>Drop your movie here</h3>
                    <p>Supports MP4 and MKV files</p>
                    <button
                        className="player__browse-btn"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        Browse Files
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".mp4,.mkv,.webm,.mov"
                        onChange={(e) => handleFileSelect(e.target.files[0])}
                        style={{ display: 'none' }}
                    />
                </div>
                {error && <div className="player__error">{error}</div>}
            </div>
        );
    }

    // Loading state (MKV remuxing)
    if (isLoading) {
        return (
            <div className="player__loading">
                <div className="player__loading-content">
                    <div className="player__spinner-large" />
                    <h3>Processing movie...</h3>
                    <p>Converting MKV for browser playback</p>
                    <div className="player__progress-bar">
                        <div className="player__progress-fill" style={{ width: `${loadProgress}%` }} />
                    </div>
                    <span className="player__progress-text">{loadProgress}%</span>
                </div>
            </div>
        );
    }

    // Viewer: downloading file from host (only show waiting screen if NO streaming source is ready)
    if (!isHost && !movieBlobUrl && !mediaSourceUrl) {
        return (
            <div className="player__waiting">
                <div className="player__waiting-content">
                    {isReceiving ? (
                        <>
                            <div className="player__spinner-large" />
                            <h3>Downloading movie...</h3>
                            <p>Receiving file from host at full quality</p>
                            <div className="player__progress-bar">
                                <div className="player__progress-fill" style={{ width: `${downloadProgress}%` }} />
                            </div>
                            <span className="player__progress-text">{downloadProgress}%</span>
                        </>
                    ) : (
                        <>
                            <div className="player__pulse" />
                            <h3>Waiting for host...</h3>
                            <p>The host will select a movie to stream</p>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="player" onDragOver={isHost ? handleDragOver : undefined} onDrop={isHost ? handleDrop : undefined}>
            <video
                ref={videoRef}
                className="player__video"
                src={isHost ? localMovieUrl : (mediaSourceUrl || movieBlobUrl)}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={handlePlay}
                onPause={handlePause}
                onSeeked={handleSeek}
                onError={(e) => console.error('[player] video error:', videoRef.current?.error, e)}
                onLoadStart={() => console.log('[player] load start, src:', isHost ? localMovieUrl : movieBlobUrl)}
                onCanPlay={() => console.log('[player] can play')}
                playsInline
                autoPlay
                muted={!isHost} // Muted autoplay to ensure frame rendering
            />

            <Controls
                videoRef={videoRef}
                isHost={isHost}
                playbackSync={playbackSync}
                onSubtitleFile={() => subtitleInputRef.current?.click()}
            />

            {isHost && (
                <input
                    ref={subtitleInputRef}
                    type="file"
                    accept=".srt,.ass,.ssa"
                    onChange={(e) => handleSubtitleFile(e.target.files[0])}
                    style={{ display: 'none' }}
                />
            )}

            {error && <div className="player__error">{error}</div>}
        </div>
    );
}
