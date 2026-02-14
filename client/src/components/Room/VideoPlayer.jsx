import { useState, useRef, useCallback, useEffect } from 'react';
import { needsTransmux, transmuxToFMP4 } from '../../utils/mkvHandler.js';
import { fragmentMP4, isNativeMP4, probeMP4 } from '../../utils/mp4Fragmenter.js';
import { parseSubtitles } from '../../utils/subtitleParser.js';
import Controls from './Controls.jsx';

export default function VideoPlayer({
    isHost,
    peerPlayableReady = true,
    videoRef,
    movieBlobUrl,
    downloadProgress,
    transferSpeed,
    numPeers,
    isReceiving,
    onFileReady,
    onTimeUpdate,
    onSubtitlesLoaded,
    playbackSync,
    socket,
}) {
    const [localMovieUrl, setLocalMovieUrl] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [error, setError] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const [playbackNotice, setPlaybackNotice] = useState('');

    const fileInputRef = useRef(null);
    const subtitleInputRef = useRef(null);
    const selectedFileRef = useRef(null);
    const viewerPlayableAckSentRef = useRef(false);
    const pendingHostStartRef = useRef(false);

    const handleFileSelect = useCallback(
        async (file) => {
            if (!file) return;
            setError('');
            setIsLoading(true);
            setLoadProgress(0);

            try {
                let url;
                let processedFile = file;

                if (isNativeMP4(file)) {
                    console.log('[player] MP4 detected — using mp4box.js (fast path)');
                    setLoadProgress(5);

                    const probeResult = await probeMP4(file);
                    console.log('[player] Probe result:', probeResult);

                    if (probeResult.isHevc) {
                        const hevcSupported = MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
                        if (!hevcSupported) {
                            setError('This video uses HEVC/H.265 which your browser may not support. Try Chrome or Edge.');
                        }
                    }

                    if (!probeResult.hasAac) {
                        console.log('[player] Non-AAC audio detected, using ffmpeg for audio transcoding');
                        setLoadProgress(10);
                        const result = await transmuxToFMP4(file, (p) => setLoadProgress(p));
                        url = result.url;
                        const response = await fetch(url);
                        const blob = await response.blob();
                        const newName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                        processedFile = new File([blob], newName, { type: result.mime });
                    } else {
                        const result = await fragmentMP4(file, (p) => setLoadProgress(p));
                        url = result.url;
                        const response = await fetch(url);
                        const blob = await response.blob();
                        const newName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                        processedFile = new File([blob], newName, { type: result.mime });
                    }
                } else if (needsTransmux(file)) {
                    console.log('[player] MKV detected — using ffmpeg.wasm (remux path)');
                    setLoadProgress(5);

                    let result = await transmuxToFMP4(file, (p) => setLoadProgress(p));

                    if (result.isHevc) {
                        const hevcSupported = MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
                        if (!hevcSupported) {
                            console.log('[player] HEVC unsupported — transcoding video to H.264 for compatibility');
                            setLoadProgress(0);
                            result = await transmuxToFMP4(file, (p) => setLoadProgress(p), { forceH264: true });
                        }
                    }

                    url = result.url;

                    const response = await fetch(url);
                    const blob = await response.blob();
                    const newName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                    processedFile = new File([blob], newName, { type: result.mime });
                } else {
                    url = URL.createObjectURL(file);
                }

                setLocalMovieUrl(url);
                selectedFileRef.current = processedFile;
                setIsLoading(false);

                socket.current?.emit('movie-loaded', {
                    name: file.name,
                    duration: 0,
                });

                onFileReady?.(processedFile, url, { preTranscode: false });
            } catch (err) {
                setError(`Failed to load movie: ${err.message}`);
                setIsLoading(false);
            }
        },
        [socket, onFileReady]
    );

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

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };
    const handleDragLeave = () => setIsDragging(false);
    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (!file) return;

        if (file.name.match(/\.(srt|ass|ssa)$/i)) {
            handleSubtitleFile(file);
        } else {
            handleFileSelect(file);
        }
    };

    const handleLoadedMetadata = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        socket.current?.emit('movie-loaded', {
            name: localMovieUrl || movieBlobUrl ? 'Movie' : '',
            duration: video.duration,
        });
    }, [videoRef, localMovieUrl, movieBlobUrl, socket]);

    useEffect(() => {
        if (!isHost && movieBlobUrl && videoRef.current) {
            videoRef.current.src = movieBlobUrl;
        }
    }, [isHost, movieBlobUrl, videoRef]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTime = () => {
            onTimeUpdate?.(video.currentTime);
        };

        video.addEventListener('timeupdate', handleTime);
        return () => video.removeEventListener('timeupdate', handleTime);
    }, [videoRef, onTimeUpdate]);

    const handlePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        if (isHost && !peerPlayableReady) {
            pendingHostStartRef.current = true;
            setPlaybackNotice('Waiting for your partner player to become ready...');
            video.pause();
            return;
        }

        setPlaybackNotice('');
        pendingHostStartRef.current = false;
        playbackSync?.emitPlay(video.currentTime);
    }, [videoRef, playbackSync, isHost, peerPlayableReady]);

    const handlePause = useCallback(() => {
        const video = videoRef.current;
        if (video) playbackSync?.emitPause(video.currentTime);
    }, [videoRef, playbackSync]);

    const handleSeek = useCallback(() => {
        const video = videoRef.current;
        if (video) playbackSync?.emitSeek(video.currentTime);
    }, [videoRef, playbackSync]);

    useEffect(() => {
        if (!isHost || !peerPlayableReady) return;

        setPlaybackNotice('');

        if (pendingHostStartRef.current && videoRef.current) {
            videoRef.current.play().catch(() => { });
            pendingHostStartRef.current = false;
        }
    }, [isHost, peerPlayableReady, videoRef]);

    useEffect(() => {
        if (!isHost) {
            viewerPlayableAckSentRef.current = false;
        }
    }, [isHost, movieBlobUrl]);

    const handleCanPlay = useCallback(() => {
        console.log('[player] can play');

        if (!isHost && !viewerPlayableAckSentRef.current) {
            viewerPlayableAckSentRef.current = true;
            socket.current?.emit('viewer-playable', { timestamp: Date.now() });
        }
    }, [isHost, socket]);

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
                    <button className="player__browse-btn" onClick={() => fileInputRef.current?.click()}>
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

    if (!isHost && !movieBlobUrl && !isReceiving) {
        return (
            <div className="player__waiting">
                <div className="player__waiting-content">
                    <div className="player__pulse" />
                    <h3>Waiting for host...</h3>
                    <p>The host will select a movie to stream</p>
                </div>
            </div>
        );
    }

    const videoSrc = isHost ? localMovieUrl : movieBlobUrl;
    const hasDirectVideoSrc = Boolean(videoSrc);
    const videoSourceProps = hasDirectVideoSrc ? { src: videoSrc } : {};

    return (
        <div className="player" onDragOver={isHost ? handleDragOver : undefined} onDrop={isHost ? handleDrop : undefined}>
            <video
                ref={videoRef}
                className="player__video"
                {...videoSourceProps}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={handlePlay}
                onPause={handlePause}
                onSeeked={handleSeek}
                onError={(e) => console.error('[player] video error:', videoRef.current?.error, e)}
                onLoadStart={() => console.log('[player] load start, currentSrc:', videoRef.current?.currentSrc || null)}
                onCanPlay={handleCanPlay}
                playsInline
                autoPlay={!isHost && hasDirectVideoSrc}
                muted={!isHost}
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

            {(!isHost && isReceiving && !movieBlobUrl) && (
                <div className="player__error">
                    Downloading... {downloadProgress}%
                    {transferSpeed > 0 && ` — ${(transferSpeed / (1024 * 1024)).toFixed(1)} MB/s`}
                    {numPeers > 0 && ` • ${numPeers} peer${numPeers !== 1 ? 's' : ''}`}
                </div>
            )}

            {error && <div className="player__error">{error}</div>}
            {playbackNotice && <div className="player__error">{playbackNotice}</div>}
        </div>
    );
}
