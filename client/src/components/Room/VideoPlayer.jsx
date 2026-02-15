import { useState, useRef, useCallback, useEffect } from 'react';
import { classifyFile } from '../../utils/streamRouter.js';
import { transmuxToFMP4 } from '../../utils/mkvHandler.js';
import { probeMP4 } from '../../utils/mp4Fragmenter.js';
import { parseSubtitles } from '../../utils/subtitleParser.js';
import { getTempMedia, removeTempMedia, saveTempMedia, TEMP_MEDIA_TTL_MS } from '../../utils/tempMediaCache.js';
import { saveMovie, findMovie, loadMovie, listMovies, removeMovie, formatSize } from '../../utils/movieLibrary.js';
import Controls from './Controls.jsx';

export default function VideoPlayer({
    roomCode,
    isHost,
    movieName,
    peerPlayableReady = true,
    allowHostSoloPlayback = false,
    videoRef,
    movieBlobUrl,
    downloadProgress,
    transferSpeed,
    numPeers,
    isSending,
    isReceiving,
    resetTransferState,
    usingLocalPlayback,
    onLocalPlaybackToggle,
    onFileReady,
    onTimeUpdate,
    onSubtitlesLoaded,
    playbackSync,
    socket,
    completedDownload,
    clearCompletedDownload,
}) {
    const [localMovieUrl, setLocalMovieUrl] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [error, setError] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const [playbackNotice, setPlaybackNotice] = useState('');
    const [cachedPrompt, setCachedPrompt] = useState(null);
    const [libraryMovies, setLibraryMovies] = useState([]);
    const [showSaveOffer, setShowSaveOffer] = useState(null); // {blob, fileName}
    const [savedToLibNotice, setSavedToLibNotice] = useState('');
    const [loadingLabel, setLoadingLabel] = useState('Processing movie...');

    const fileInputRef = useRef(null);
    const subtitleInputRef = useRef(null);
    const viewerFileInputRef = useRef(null);
    const selectedFileRef = useRef(null);
    const pendingHostStartRef = useRef(false);
    const checkedCachePromptRef = useRef(false);

    const restoreHostCachedMedia = useCallback(async (cached) => {
        if (!cached?.blob) return;

        try {
            const restoredFile = new File([cached.blob], cached.fileName || 'movie.mp4', {
                type: cached.mimeType || cached.blob.type || 'video/mp4',
            });

            const url = URL.createObjectURL(restoredFile);
            setLocalMovieUrl(url);
            selectedFileRef.current = restoredFile;

            socket.current?.emit('movie-loaded', {
                name: restoredFile.name,
                duration: 0,
            });

            onFileReady?.(restoredFile, url, { preTranscode: false, restored: true, streamPath: 'direct' });
        } catch (err) {
            console.error('[player] failed to restore cached host media:', err);
        }
    }, [socket, onFileReady]);

    const discardHostCachedMedia = useCallback(async () => {
        if (!roomCode) return;
        try {
            await removeTempMedia({ roomCode, role: 'host' });
        } catch (err) {
            console.error('[player] failed to clear cached host media:', err);
        } finally {
            setCachedPrompt(null);
        }
    }, [roomCode]);

    useEffect(() => {
        if (!isHost || !roomCode || localMovieUrl || isLoading) return;
        if (checkedCachePromptRef.current) return;

        checkedCachePromptRef.current = true;
        getTempMedia({ roomCode, role: 'host' })
            .then((cached) => {
                if (!cached?.blob) return;
                setCachedPrompt(cached);
            })
            .catch((err) => {
                console.error('[player] failed to check cached host media:', err);
            });
    }, [isHost, roomCode, localMovieUrl, isLoading]);

    // Load library list for host file-selection screen
    const refreshLibrary = useCallback(() => {
        listMovies().then(setLibraryMovies).catch(() => setLibraryMovies([]));
    }, []);

    useEffect(() => {
        refreshLibrary();
    }, [refreshLibrary]);

    // Viewer: show save offer when download completes
    useEffect(() => {
        if (isHost || !completedDownload) return;
        findMovie(completedDownload.fileName)
            .then((existing) => {
                if (!existing) {
                    setShowSaveOffer(completedDownload);
                }
            })
            .catch(() => {
                setShowSaveOffer(completedDownload);
            });
    }, [isHost, completedDownload]);

    // Handle saving to library
    const handleSaveToLibrary = useCallback(async (data) => {
        if (!data?.blob || !data?.fileName) return;
        try {
            await saveMovie(data.blob, data.fileName);
            setSavedToLibNotice(`Saved "${data.fileName}" to library`);
            setTimeout(() => setSavedToLibNotice(''), 3000);
            setShowSaveOffer(null);
            clearCompletedDownload?.();
            refreshLibrary();
        } catch (err) {
            console.error('[player] failed to save to library:', err);
            const isQuota = /quota|blob|IOError/i.test(err?.message || '');
            setError(isQuota
                ? 'File too large to save — browser storage quota exceeded'
                : `Failed to save to library: ${err.message}`);
            setShowSaveOffer(null);
        }
    }, [clearCompletedDownload, refreshLibrary]);

    const handleDismissSaveOffer = useCallback(() => {
        setShowSaveOffer(null);
        clearCompletedDownload?.();
    }, [clearCompletedDownload]);

    // Viewer: load their own copy of the movie for synced playback
    const handleViewerLoadLocal = useCallback((file) => {
        if (!file || isHost) return;
        setError('');
        const url = URL.createObjectURL(file);
        setLocalMovieUrl(url);
        resetTransferState?.();
        onLocalPlaybackToggle?.(true);
        socket.current?.emit('viewer-stream-ready', {
            progress: 100,
            timestamp: Date.now(),
        });
    }, [isHost, resetTransferState, socket, onLocalPlaybackToggle]);

    useEffect(() => {
        if (isHost) return;
        if (localMovieUrl) return;
        if (movieBlobUrl || isReceiving) {
            onLocalPlaybackToggle?.(false);
        }
    }, [isHost, localMovieUrl, movieBlobUrl, isReceiving, onLocalPlaybackToggle]);

    // Load movie from library
    const handleLoadFromLibrary = useCallback(async (movie) => {
        try {
            setIsLoading(true);
            setLoadProgress(10);
            setLoadingLabel('Loading from library...');
            const cached = await loadMovie(movie.key);
            if (!cached?.blob) {
                setError('Library movie not found or corrupted');
                setIsLoading(false);
                return;
            }

            const file = new File([cached.blob], cached.fileName, { type: cached.mimeType || 'video/mp4' });
            const url = URL.createObjectURL(file);
            setLocalMovieUrl(url);
            selectedFileRef.current = file;
            setIsLoading(false);
            setLoadProgress(100);

            socket.current?.emit('movie-loaded', {
                name: cached.fileName,
                duration: 0,
            });

            onFileReady?.(file, url, { preTranscode: false, restored: true, streamPath: 'direct' });
        } catch (err) {
            setError(`Failed to load from library: ${err.message}`);
            setIsLoading(false);
        }
    }, [socket, onFileReady]);

    const handleRemoveFromLibrary = useCallback(async (movie) => {
        try {
            await removeMovie(movie.key);
            refreshLibrary();
        } catch (err) {
            console.error('[player] failed to remove from library:', err);
        }
    }, [refreshLibrary]);

    /* ═══════════════════════════════════════════════════════════════
     *  handleFileSelect — NEW: Uses streamRouter for smart routing
     *
     *  The key insight from torrent streaming sites:
     *    - 'direct'    → Zero processing! Just play and seed immediately
     *    - 'remux'     → Seed original immediately, viewer handles remux
     *    - 'transcode' → Only path that waits for processing
     * ═══════════════════════════════════════════════════════════════ */
    const handleFileSelect = useCallback(
        async (file) => {
            if (!file) return;
            setError('');
            setIsLoading(true);
            setLoadProgress(0);

            try {
                const hasNativeTranscoder = Boolean(window?.electron?.nativeTranscoder?.processFile);

                /* ─── Step 1: Classify the file ─── */
                const classification = await classifyFile(file);
                console.log('[player] File classification:', classification);

                let url;
                let processedFile = file;
                let streamPath = classification.path;
                let wasProcessed = false;

                /* ─── check library for cached processed version ─── */
                if (streamPath !== 'direct') {
                    const expectedName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                    try {
                        const libEntry = await findMovie(expectedName);
                        if (libEntry) {
                            console.log('[player] Found processed version in library:', expectedName);
                            const cached = await loadMovie(libEntry.key);
                            if (cached?.blob) {
                                const cachedFile = new File([cached.blob], cached.fileName, { type: cached.mimeType || 'video/mp4' });
                                url = URL.createObjectURL(cachedFile);
                                processedFile = cachedFile;
                                streamPath = 'direct'; // cached version is already processed
                                setLoadProgress(100);

                                setLocalMovieUrl(url);
                                selectedFileRef.current = processedFile;
                                setIsLoading(false);

                                socket.current?.emit('movie-loaded', { name: file.name, duration: 0 });
                                onFileReady?.(processedFile, url, { preTranscode: false, restored: true, streamPath });
                                return;
                            }
                        }
                    } catch (err) {
                        console.warn('[player] library check failed:', err);
                    }
                }

                /* ───── helper: resolve input path for native transcoder ───── */
                const resolveInputPath = async (inputFile) => {
                    let inputPath = inputFile.path || null;
                    if (!inputPath) {
                        console.log('[transcoder] No file.path — saving to temp…');
                        const buf = await inputFile.arrayBuffer();
                        const saved = await window.electron.nativeTranscoder.saveTempFile(
                            new Uint8Array(buf),
                            inputFile.name,
                        );
                        if (!saved?.success) throw new Error(saved?.error || 'Failed to save temp file');
                        inputPath = saved.filePath;
                    }
                    return inputPath;
                };

                /* ───── helper: read transcoder output into a File ───── */
                const readTranscoderOutput = async (outputPath, originalName) => {
                    const fileData = await window.electron.nativeTranscoder.readFile(outputPath);
                    if (!fileData?.success || (!fileData.bytes && !fileData.data)) {
                        throw new Error('Failed to read transcoder output');
                    }
                    const bytes = fileData.bytes
                        ? new Uint8Array(fileData.bytes)
                        : new Uint8Array(fileData.data);
                    const blob = new Blob([bytes], { type: 'video/mp4' });
                    const newName = originalName.replace(/\.[^/.]+$/, '') + '.mp4';
                    const outFile = new File([blob], newName, { type: 'video/mp4' });
                    return { url: URL.createObjectURL(blob), file: outFile };
                };

                /* ═══════════════════════════════════════════
                 *  PATH 1: DIRECT — Zero processing (instant!)
                 *  In Electron: uses local HTTP streaming server for any format.
                 *  In browser:  uses blob URL (only for natively playable formats).
                 * ═══════════════════════════════════════════ */
                if (streamPath === 'direct') {
                    console.log('[player] ✅ DIRECT path — zero processing, instant seed');

                    // In Electron with a real file path → use local HTTP streaming server
                    // This enables progressive playback of MKV, HEVC, etc.
                    if (window.electron?.streamServer && file.path) {
                        try {
                            const result = await window.electron.streamServer.register(file.path);
                            if (result?.success && result.url) {
                                console.log('[player] Using Electron stream server:', result.url);
                                url = result.url;
                            } else {
                                url = URL.createObjectURL(file);
                            }
                        } catch (err) {
                            console.warn('[player] Stream server failed, falling back to blob URL:', err.message);
                            url = URL.createObjectURL(file);
                        }
                    } else {
                        url = URL.createObjectURL(file);
                    }
                    setLoadProgress(100);
                }

                /* ═══════════════════════════════════════════
                 *  PATH 2: REMUX — Process first, then seed processed MP4
                 *  MKV/non-native containers must be remuxed to MP4 before
                 *  seeding because mp4box.js/render-media can't parse MKV.
                 *  The viewer receives a standard MP4 via torrent (streamPath='direct').
                 * ═══════════════════════════════════════════ */
                else if (streamPath === 'remux') {
                    console.log('[player] 🔄 REMUX path — process then seed processed MP4');

                    if (hasNativeTranscoder) {
                        /* Electron: native FFmpeg smart process */
                        setLoadingLabel('Remuxing to MP4 (fast)…');
                        setLoadProgress(10);

                        const inputPath = await resolveInputPath(file);
                        let result = await window.electron.nativeTranscoder.processFile(inputPath, false);
                        if (!result?.success || !result.outputPath) {
                            console.warn('[transcoder] Remux failed, falling back to full transcode');
                            setLoadingLabel('Transcoding (native FFmpeg)…');
                            result = await window.electron.nativeTranscoder.processFile(inputPath, true);
                            if (!result?.success || !result.outputPath) {
                                throw new Error(result?.error || 'Native transcode failed');
                            }
                        }

                        setLoadProgress(60);
                        const out = await readTranscoderOutput(result.outputPath, file.name);

                        // Check if HEVC
                        const probeResult = await probeMP4(out.file);
                        const hevcSupported = MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');

                        if (probeResult.isHevc && !hevcSupported) {
                            console.log('[transcoder] HEVC detected — full transcode to H.264…');
                            setLoadingLabel('Transcoding HEVC → H.264…');
                            setLoadProgress(10);
                            URL.revokeObjectURL(out.url);
                            result = await window.electron.nativeTranscoder.processFile(inputPath, true);
                            if (!result?.success || !result.outputPath) {
                                throw new Error(result?.error || 'Native transcode failed');
                            }
                            setLoadProgress(80);
                            const out2 = await readTranscoderOutput(result.outputPath, file.name);
                            url = out2.url;
                            processedFile = out2.file;
                            wasProcessed = true;
                        } else {
                            url = out.url;
                            processedFile = out.file;
                            wasProcessed = true;
                        }
                    } else {
                        /* Browser fallback: ffmpeg.wasm */
                        setLoadingLabel('Remuxing to MP4 (browser)…');
                        setLoadProgress(5);

                        let result = await transmuxToFMP4(file, (p) => setLoadProgress(p));

                        if (result.isHevc) {
                            const hevcSupported = MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
                            if (!hevcSupported) {
                                console.log('[player] HEVC unsupported — transcoding to H.264');
                                setLoadProgress(0);
                                setLoadingLabel('Transcoding HEVC → H.264…');
                                result = await transmuxToFMP4(file, (p) => setLoadProgress(p), { forceH264: true });
                            }
                        }

                        url = result.url;
                        const response = await fetch(url);
                        const blob = await response.blob();
                        const newName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                        processedFile = new File([blob], newName, { type: result.mime });
                        wasProcessed = true;
                    }

                    setLoadingLabel('Processing movie...');
                    setLoadProgress(100);
                    // Remuxed output is a standard MP4 — viewer can play it directly
                    streamPath = 'direct';
                }

                /* ═══════════════════════════════════════════
                 *  PATH 3: TRANSCODE — Full re-encode (last resort)
                 *  Only for truly incompatible codecs (HEVC, etc).
                 * ═══════════════════════════════════════════ */
                else if (streamPath === 'transcode') {
                    console.log('[player] ⚠️ TRANSCODE path —', classification.reason);

                    if (hasNativeTranscoder) {
                        setLoadingLabel('Transcoding to H.264 (native)…');
                        setLoadProgress(10);

                        const inputPath = await resolveInputPath(file);
                        const result = await window.electron.nativeTranscoder.processFile(inputPath, true);
                        if (!result?.success || !result.outputPath) {
                            throw new Error(result?.error || 'Native transcode failed');
                        }

                        setLoadProgress(80);
                        const out = await readTranscoderOutput(result.outputPath, file.name);
                        url = out.url;
                        processedFile = out.file;
                        wasProcessed = true;
                        streamPath = 'direct'; // transcoded file is now directly playable
                    } else {
                        setError('This video uses HEVC/H.265 which your browser may not support. Try Chrome or Edge, or use the desktop app.');
                        setLoadingLabel('Transcoding (browser)…');
                        setLoadProgress(10);
                        const result = await transmuxToFMP4(file, (p) => setLoadProgress(p), { forceH264: true });
                        url = result.url;
                        const response = await fetch(url);
                        const blob = await response.blob();
                        const newName = file.name.replace(/\.[^/.]+$/, '') + '.mp4';
                        processedFile = new File([blob], newName, { type: result.mime });
                        wasProcessed = true;
                        streamPath = 'direct'; // transcoded file is now directly playable
                    }

                    setLoadingLabel('Processing movie...');
                    setLoadProgress(100);
                }

                setLocalMovieUrl(url);
                selectedFileRef.current = processedFile;
                setIsLoading(false);

                try {
                    await saveTempMedia({
                        roomCode,
                        role: 'host',
                        blob: processedFile,
                        fileName: processedFile.name,
                        sourcePath: file.path || null,
                        ttlMs: TEMP_MEDIA_TTL_MS,
                    });
                } catch (cacheErr) {
                    console.warn('[player] temp cache save skipped (quota?):', cacheErr.message);
                }

                socket.current?.emit('movie-loaded', {
                    name: file.name,
                    duration: 0,
                });

                // Always seed the processed file — viewers need a browser-playable MP4.
                // mp4box.js can NOT parse non-MP4 containers (MKV, AVI, etc.),
                // so seeding the raw original for viewer-side remux doesn't work.
                onFileReady?.(processedFile, url, { preTranscode: false, streamPath });

                // Offer to save to library if the file was transcoded/remuxed
                if (wasProcessed && isHost) {
                    setShowSaveOffer({ blob: processedFile, fileName: processedFile.name });
                }
            } catch (err) {
                setError(`Failed to load movie: ${err.message}`);
                setIsLoading(false);
            }
        },
        [socket, onFileReady, roomCode]
    );

    const handleSubtitleFile = useCallback(
        async (file) => {
            if (!file) return;
            try {
                const text = await file.text();
                const cues = parseSubtitles(text, file.name);
                const localOnly = !isHost && usingLocalPlayback;
                onSubtitlesLoaded?.(cues, file.name, { localOnly });
            } catch (err) {
                setError(`Failed to load subtitles: ${err.message}`);
            }
        },
        [onSubtitlesLoaded, isHost, usingLocalPlayback]
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
            if (videoRef.current.src !== movieBlobUrl) {
                videoRef.current.src = movieBlobUrl;
            }
        }
    }, [isHost, movieBlobUrl, videoRef]);

    const handleVideoTimeUpdate = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        onTimeUpdate?.(video.currentTime);
    }, [videoRef, onTimeUpdate]);

    const handlePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        if (isHost && !peerPlayableReady && !allowHostSoloPlayback) {
            pendingHostStartRef.current = true;
            setPlaybackNotice('Waiting for your partner player to become ready...');
            video.pause();
            return;
        }

        setPlaybackNotice('');
        pendingHostStartRef.current = false;
        playbackSync?.emitPlay(video.currentTime);
    }, [videoRef, playbackSync, isHost, peerPlayableReady, allowHostSoloPlayback]);

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

    const handleCanPlay = useCallback(() => {
        console.log('[player] can play');
    }, []);

    if (isHost && !localMovieUrl && !isLoading) {
        return (
            <div
                className={`player__dropzone ${isDragging ? 'player__dropzone--active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <div className="player__dropzone-content">
                    {cachedPrompt && (
                        <div className="player__error" style={{ marginBottom: 12, textAlign: 'left' }}>
                            <div style={{ marginBottom: 8 }}>
                                Resume cached movie: <strong>{cachedPrompt.fileName || 'movie.mp4'}</strong>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="player__browse-btn" onClick={() => restoreHostCachedMedia(cachedPrompt)}>
                                    Resume
                                </button>
                                <button className="player__browse-btn" onClick={discardHostCachedMedia}>
                                    Start Fresh
                                </button>
                            </div>
                        </div>
                    )}
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <h3>Drop your movie here</h3>
                    <p>Supports MP4, MKV, and WebM files</p>
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

                    {/* Movie Library */}
                    {libraryMovies.length > 0 && (
                        <div className="player__library" style={{ marginTop: 16, width: '100%', maxWidth: 400 }}>
                            <h4 style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 13 }}>My Library</h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {libraryMovies.map((m) => (
                                    <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '6px 10px' }}>
                                        <button
                                            className="player__browse-btn"
                                            style={{ flex: 1, textAlign: 'left', fontSize: 12, padding: '4px 8px' }}
                                            onClick={() => handleLoadFromLibrary(m)}
                                            title={`${m.fileName} (${formatSize(m.fileSize)})`}
                                        >
                                            {m.fileName.length > 35 ? m.fileName.slice(0, 32) + '…' : m.fileName}
                                            <span style={{ opacity: 0.5, marginLeft: 6 }}>{formatSize(m.fileSize)}</span>
                                        </button>
                                        <button
                                            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.4, fontSize: 14, padding: '2px 6px' }}
                                            onClick={() => handleRemoveFromLibrary(m)}
                                            title="Remove from library"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
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
                    <h3>{loadingLabel}</h3>
                    <p>This only happens for non-native formats</p>
                    <div className="player__progress-bar">
                        <div className="player__progress-fill" style={{ width: `${loadProgress}%` }} />
                    </div>
                    <span className="player__progress-text">{loadProgress}%</span>
                </div>
            </div>
        );
    }

    if (!isHost && !movieBlobUrl && !localMovieUrl && !isReceiving) {
        return (
            <div className="player__waiting">
                <div className="player__waiting-content">
                    <div className="player__pulse" />
                    <h3>Waiting for host...</h3>
                    <p>The host will select a movie to stream</p>
                    {movieName && (
                        <div className="player__local-option">
                            <p className="player__local-label">Now playing: <strong>{movieName}</strong></p>
                            <p style={{ fontSize: '0.85rem', opacity: 0.6, margin: '4px 0 8px' }}>Have this movie? Load your copy for instant synced playback</p>
                            <button className="player__browse-btn" onClick={() => viewerFileInputRef.current?.click()}>
                                Load My Copy
                            </button>
                            <input
                                ref={viewerFileInputRef}
                                type="file"
                                accept=".mp4,.mkv,.webm,.mov"
                                onChange={(e) => { handleViewerLoadLocal(e.target.files[0]); e.target.value = ''; }}
                                style={{ display: 'none' }}
                            />
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const videoSrc = isHost ? localMovieUrl : (localMovieUrl || movieBlobUrl);
    const hasDirectVideoSrc = Boolean(videoSrc);
    const videoSourceProps = hasDirectVideoSrc ? { src: videoSrc } : {};

    return (
        <div className="player" onDragOver={isHost ? handleDragOver : undefined} onDrop={isHost ? handleDrop : undefined}>
            <video
                ref={videoRef}
                className="player__video"
                {...videoSourceProps}
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleVideoTimeUpdate}
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

            <input
                ref={subtitleInputRef}
                type="file"
                accept=".srt,.ass,.ssa"
                onChange={(e) => handleSubtitleFile(e.target.files[0])}
                style={{ display: 'none' }}
            />

            {(!isHost && isReceiving && !movieBlobUrl && !localMovieUrl) && (
                <div className="player__download-bar">
                    <span>
                        Downloading... {downloadProgress}%
                        {transferSpeed > 0 && ` — ${(transferSpeed / (1024 * 1024)).toFixed(1)} MB/s`}
                        {numPeers > 0 && ` • ${numPeers} peer${numPeers !== 1 ? 's' : ''}`}
                    </span>
                    <button className="player__browse-btn player__local-btn" onClick={() => viewerFileInputRef.current?.click()}>
                        Load My Copy
                    </button>
                    <input
                        ref={viewerFileInputRef}
                        type="file"
                        accept=".mp4,.mkv,.webm,.mov"
                        onChange={(e) => { handleViewerLoadLocal(e.target.files[0]); e.target.value = ''; }}
                        style={{ display: 'none' }}
                    />
                </div>
            )}

            {error && <div className="player__error">{error}</div>}
            {playbackNotice && <div className="player__error">{playbackNotice}</div>}

            {/* Host seeding spinner */}
            {isHost && isSending && (
                <div className="player__seeding-overlay">
                    <div className="player__spinner-large" />
                    <span>Seeding to partner…</span>
                </div>
            )}

            {/* Save to Library offer */}
            {showSaveOffer && (
                <div className="player__error" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                    <span>Save to library for next time?</span>
                    <button className="player__browse-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => handleSaveToLibrary(showSaveOffer)}>
                        Save
                    </button>
                    <button className="player__browse-btn" style={{ padding: '3px 10px', fontSize: 12, opacity: 0.6 }} onClick={handleDismissSaveOffer}>
                        No thanks
                    </button>
                </div>
            )}

            {savedToLibNotice && (
                <div className="player__error" style={{ background: 'rgba(34,197,94,0.15)' }}>
                    {savedToLibNotice}
                </div>
            )}
        </div>
    );
}
