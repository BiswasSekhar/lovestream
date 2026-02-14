import { useEffect, useRef, useState, useCallback } from 'react';
import WebTorrent from 'webtorrent';
import renderMedia from 'render-media';
import { getTempMedia, saveTempMedia, updateTempMediaPosition, TEMP_MEDIA_TTL_MS } from '../utils/tempMediaCache.js';
import { findMovie, loadMovie } from '../utils/movieLibrary.js';
import { streamTorrentToMSE } from '../utils/mp4Fragmenter.js';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/**
 * Hook for P2P movie sharing via WebTorrent.
 *
 * New streaming architecture (modelled after Stremio / Webtor / torrent streaming sites):
 *
 *   Host: ALWAYS seeds the original file immediately — no waiting for transcode.
 *         Sends a `streamPath` alongside the magnet URI so the viewer knows
 *         which playback pipeline to use.
 *
 *   Viewer receives magnet + streamPath and picks the right strategy:
 *     - 'direct'    → render-media progressive MSE (works for MP4/WebM)
 *     - 'remux'     → mp4box.js on-the-fly fragmentation → MSE SourceBuffer
 *     - 'transcode' → waits for host's second (transcoded) magnet
 *
 * @param {object} params
 * @param {React.MutableRefObject} params.socket - Socket.IO ref
 * @param {boolean} params.isHost
 * @param {React.RefObject} params.videoRef - Reference to the <video> element
 */
export default function useWebTorrent({ socket, isHost, videoRef, roomCode, disableViewerTorrent = false }) {
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [transferSpeed, setTransferSpeed] = useState(0); // bytes/sec
    const [numPeers, setNumPeers] = useState(0);
    const [isSending, setIsSending] = useState(false);
    const [isReceiving, setIsReceiving] = useState(false);
    const [movieBlobUrl, setMovieBlobUrl] = useState(null);
    const [movieFileName, setMovieFileName] = useState('');
    const [completedDownload, setCompletedDownload] = useState(null); // {blob, fileName}

    const clientRef = useRef(null);
    const torrentRef = useRef(null);
    const progressIntervalRef = useRef(null);
    const renderMediaReadyRef = useRef(false);
    const currentTorrentTokenRef = useRef(0);
    const hasSentStreamReadyRef = useRef(false);
    const activeMagnetRef = useRef(null);
    const lastPersistedPositionRef = useRef(0);
    const seededFileKeyRef = useRef('');
    const mseAbortRef = useRef(null); // AbortController for MSE stream

    const buildFileKey = useCallback((file) => {
        if (!file) return '';
        const name = file.name || '';
        const size = Number(file.size || 0);
        const modified = Number(file.lastModified || 0);
        return `${name}::${size}::${modified}`;
    }, []);

    // Get tracker URL from server URL
    const trackerUrl = SERVER_URL.replace(/^http/, 'ws') + '/';

    // Create WebTorrent client on mount
    useEffect(() => {
        const client = new WebTorrent({
            tracker: {
                announce: [trackerUrl],
            },
        });

        client.on('error', (err) => {
            console.error('[webtorrent] client error:', err.message);
        });

        clientRef.current = client;
        console.log('[webtorrent] client created, tracker:', trackerUrl);

        return () => {
            stopProgressUpdates();
            mseAbortRef.current?.abort();
            if (clientRef.current) {
                clientRef.current.destroy();
                clientRef.current = null;
            }
        };
    }, [trackerUrl]);

    const startProgressUpdates = useCallback((torrent) => {
        stopProgressUpdates();
        progressIntervalRef.current = setInterval(() => {
            setDownloadProgress(Math.round(torrent.progress * 100));
            setTransferSpeed(torrent.downloadSpeed || torrent.uploadSpeed || 0);
            setNumPeers(torrent.numPeers);
        }, 500);
    }, []);

    const createBlobUrlFallback = useCallback(async (videoFile) => {
        if (!videoFile) return;

        try {
            let blob = null;

            if (typeof videoFile.arrayBuffer === 'function') {
                const buffer = await videoFile.arrayBuffer();
                const lower = (videoFile.name || '').toLowerCase();
                const mime = lower.endsWith('.webm')
                    ? 'video/webm'
                    : lower.endsWith('.mov')
                        ? 'video/quicktime'
                        : 'video/mp4';
                blob = new Blob([buffer], { type: mime });
                const url = URL.createObjectURL(blob);
                setMovieBlobUrl(url);

                if (!isHost && roomCode) {
                    try {
                        await saveTempMedia({
                            roomCode,
                            role: 'viewer',
                            blob,
                            fileName: videoFile.name || 'movie.mp4',
                            ttlMs: TEMP_MEDIA_TTL_MS,
                        });
                    } catch (cacheErr) {
                        console.warn('[webtorrent] temp cache save skipped (quota?):', cacheErr.message);
                    }
                }
                return;
            }

            if (typeof videoFile.getBlobURL === 'function') {
                videoFile.getBlobURL((err, url) => {
                    if (err) {
                        console.error('[webtorrent] getBlobURL error:', err);
                        return;
                    }
                    setMovieBlobUrl(url);
                });
                return;
            }

            console.warn('[webtorrent] No compatible blob fallback API on torrent file');
        } catch (err) {
            console.error('[webtorrent] blob fallback failed:', err);
        }
    }, [isHost, roomCode]);

    const stopProgressUpdates = useCallback(() => {
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
    }, []);

    const resetTransferState = useCallback(() => {
        const client = clientRef.current;
        if (client && torrentRef.current) {
            try {
                client.remove(torrentRef.current);
            } catch { }
            torrentRef.current = null;
        }

        // Abort any active MSE stream
        mseAbortRef.current?.abort();
        mseAbortRef.current = null;

        activeMagnetRef.current = null;
        currentTorrentTokenRef.current += 1;
        stopProgressUpdates();
        setIsSending(false);
        setIsReceiving(false);
        setDownloadProgress(0);
        setTransferSpeed(0);
        setNumPeers(0);
        setMovieFileName('');
        renderMediaReadyRef.current = false;
        hasSentStreamReadyRef.current = false;
        lastPersistedPositionRef.current = 0;
        seededFileKeyRef.current = '';
    }, [stopProgressUpdates]);

    useEffect(() => {
        if (isHost || !disableViewerTorrent) return;
        resetTransferState();
    }, [isHost, disableViewerTorrent, resetTransferState]);

    useEffect(() => {
        if (isHost || !roomCode) return;
        let cancelled = false;

        getTempMedia({ roomCode, role: 'viewer' })
            .then((cached) => {
                if (cancelled || !cached?.blob) return;
                const url = URL.createObjectURL(cached.blob);
                setMovieBlobUrl(url);
                setMovieFileName(cached.fileName || 'movie.mp4');
                setDownloadProgress(100);
                setIsReceiving(false);
                hasSentStreamReadyRef.current = true;

                socket?.current?.emit('viewer-stream-ready', {
                    progress: 100,
                    timestamp: Date.now(),
                });

                const resumeAt = Number(cached.lastPosition || 0);
                const video = videoRef?.current;
                if (video && resumeAt > 0) {
                    const applyResume = () => {
                        video.currentTime = resumeAt;
                        video.removeEventListener('loadedmetadata', applyResume);
                    };
                    video.addEventListener('loadedmetadata', applyResume);
                }
            })
            .catch((err) => {
                console.error('[webtorrent] failed to restore cached viewer media:', err);
            });

        return () => {
            cancelled = true;
        };
    }, [isHost, roomCode, socket, videoRef]);

    useEffect(() => {
        if (isHost || !roomCode) return;
        const video = videoRef?.current;
        if (!video) return;

        const persistPosition = () => {
            const current = Number(video.currentTime || 0);
            if (Math.abs(current - lastPersistedPositionRef.current) < 2) return;
            lastPersistedPositionRef.current = current;
            updateTempMediaPosition({ roomCode, role: 'viewer', position: current }).catch(() => { });
        };

        video.addEventListener('timeupdate', persistPosition);
        return () => video.removeEventListener('timeupdate', persistPosition);
    }, [isHost, roomCode, videoRef]);

    /* ═══════════════════════════════════════════════════════════
     *  Host: seed a file — ALWAYS seeds original immediately
     * ═══════════════════════════════════════════════════════════ */
    const seedFile = useCallback((file, options = {}) => {
        const client = clientRef.current;
        const sock = socket?.current;
        if (!client || !sock) {
            console.error('[webtorrent] client or socket not ready');
            return;
        }

        const streamPath = options.streamPath || 'direct';
        const isPreTranscodeSeed = Boolean(options.preTranscode);
        const fileKey = buildFileKey(file);

        if (!isPreTranscodeSeed && torrentRef.current && seededFileKeyRef.current === fileKey) {
            const existingMagnet = torrentRef.current.magnetURI;
            if (existingMagnet) {
                console.log('[webtorrent] same file already seeded, re-sharing existing magnet');
                sock.emit('torrent-magnet', {
                    magnetURI: existingMagnet,
                    preTranscode: false,
                    streamPath,
                    name: file.name,
                });
                startProgressUpdates(torrentRef.current);
                setIsSending(false);
                return;
            }
        }

        // Remove any existing torrent
        if (torrentRef.current) {
            try {
                client.remove(torrentRef.current);
            } catch (err) {
                console.warn('[webtorrent] failed to remove existing torrent before reseed:', err?.message || err);
            }
            torrentRef.current = null;
        }

        setIsSending(true);
        setDownloadProgress(0);
        console.log('[webtorrent] seeding file:', file.name, 'size:', file.size, 'streamPath:', streamPath);

        client.seed(file, {
            announce: [trackerUrl],
        }, (torrent) => {
            torrentRef.current = torrent;
            seededFileKeyRef.current = fileKey;
            console.log('[webtorrent] seeding! magnetURI:', torrent.magnetURI);

            // Share magnet URI with viewers via socket.io
            // Includes streamPath so viewer knows which playback pipeline to use
            sock.emit('torrent-magnet', {
                magnetURI: torrent.magnetURI,
                preTranscode: isPreTranscodeSeed,
                streamPath,
                name: file.name,
            });

            setDownloadProgress(100);
            setIsSending(false);
            startProgressUpdates(torrent);

            torrent.on('wire', (wire) => {
                console.log('[webtorrent] new peer connected:', wire.peerId);
                setNumPeers(torrent.numPeers);
            });
        });
    }, [socket, trackerUrl, startProgressUpdates, buildFileKey]);

    /* ═══════════════════════════════════════════════════════════
     *  Viewer: listen for magnet URI and start downloading
     *  Uses streamPath to pick the right playback pipeline
     * ═══════════════════════════════════════════════════════════ */
    useEffect(() => {
        if (isHost) return;
        const sock = socket?.current;
        if (!sock) return;

        const handleMagnet = async (payload) => {
            if (disableViewerTorrent) {
                return;
            }

            const client = clientRef.current;
            if (!client) return;

            const magnetURI = typeof payload === 'string' ? payload : payload?.magnetURI;
            const isPreTranscode = Boolean(payload?.preTranscode);
            const streamPath = payload?.streamPath || 'direct';
            const sharedName = payload?.name || '';
            if (!magnetURI) return;

            // Ignore duplicate finalized magnet replays
            if (!isPreTranscode && activeMagnetRef.current === magnetURI && torrentRef.current) {
                console.log('[webtorrent] duplicate finalized magnet ignored');
                return;
            }

            console.log('[webtorrent] received magnet URI:', magnetURI, 'streamPath:', streamPath, 'preTranscode:', isPreTranscode);

            // Check movie library before downloading
            if (!isPreTranscode && sharedName) {
                try {
                    const libEntry = await findMovie(sharedName);
                    if (libEntry) {
                        const cached = await loadMovie(libEntry.key);
                        if (cached?.blob) {
                            console.log('[webtorrent] found in library, skipping download:', sharedName);
                            const url = URL.createObjectURL(cached.blob);
                            setMovieBlobUrl(url);
                            setMovieFileName(cached.fileName);
                            setDownloadProgress(100);
                            setIsReceiving(false);
                            hasSentStreamReadyRef.current = true;
                            socket?.current?.emit('viewer-stream-ready', {
                                progress: 100,
                                timestamp: Date.now(),
                            });
                            return;
                        }
                    }
                } catch (err) {
                    console.warn('[webtorrent] library check failed:', err);
                }
            }

            // Remove any existing torrent
            if (torrentRef.current) {
                try {
                    await new Promise((resolve) => {
                        client.remove(torrentRef.current, {}, resolve);
                    });
                } catch { }
                torrentRef.current = null;
            }

            // Remove duplicate torrents
            const existingTorrent = client.torrents.find(
                (t) => t.magnetURI === magnetURI || t.infoHash === magnetURI.match(/btih:([a-fA-F0-9]+)/)?.[1]
            );
            if (existingTorrent) {
                try {
                    await new Promise((resolve) => {
                        client.remove(existingTorrent, {}, resolve);
                    });
                } catch { }
            }

            // Abort any previous MSE stream
            mseAbortRef.current?.abort();
            mseAbortRef.current = null;

            currentTorrentTokenRef.current += 1;
            const token = currentTorrentTokenRef.current;
            activeMagnetRef.current = magnetURI;

            setIsReceiving(true);
            setDownloadProgress(0);
            setMovieBlobUrl(null);
            setCompletedDownload(null);
            renderMediaReadyRef.current = false;
            hasSentStreamReadyRef.current = false;

            client.add(magnetURI, {
                announce: [trackerUrl],
            }, (torrent) => {
                if (token !== currentTorrentTokenRef.current) {
                    return;
                }

                torrentRef.current = torrent;
                console.log('[webtorrent] downloading:', torrent.name, 'files:', torrent.files.length, 'streamPath:', streamPath);

                startProgressUpdates(torrent);

                // Find the video file in the torrent
                const videoFile = torrent.files.find(f => {
                    const name = f.name.toLowerCase();
                    return name.endsWith('.mp4') || name.endsWith('.mkv') ||
                        name.endsWith('.webm') || name.endsWith('.mov');
                }) || torrent.files[0];

                if (videoFile) {
                    setMovieFileName(videoFile.name);

                    // Pre-transcode phase: prefetch only, don't attach to player
                    if (isPreTranscode) {
                        console.log('[webtorrent] pre-transcode prefetch phase; skipping player attach');
                    } else if (videoRef?.current) {
                        /* ─── Stream path routing (the torrent streaming site approach) ─── */

                        if (streamPath === 'remux') {
                            // MKV or non-native MP4: use on-the-fly remux via mp4box.js → MSE
                            // This is what Stremio/Webtor do: fragment as pieces arrive
                            console.log('[webtorrent] REMUX path: piping torrent → mp4box.js → MSE');

                            const abortCtrl = new AbortController();
                            mseAbortRef.current = abortCtrl;

                            streamTorrentToMSE(videoFile, videoRef.current, {
                                signal: abortCtrl.signal,
                                onProgress: (p) => {
                                    if (token !== currentTorrentTokenRef.current) return;
                                    setDownloadProgress(p);
                                },
                            }).then(({ mime }) => {
                                if (token !== currentTorrentTokenRef.current) return;
                                renderMediaReadyRef.current = true;
                                console.log('[webtorrent] MSE remux streaming active, mime:', mime);

                                const streamUrl = videoRef.current?.src;
                                if (streamUrl) {
                                    setMovieBlobUrl(streamUrl);
                                }
                            }).catch((err) => {
                                if (err.name === 'AbortError' || token !== currentTorrentTokenRef.current) return;
                                console.warn('[webtorrent] MSE remux failed, falling back to render-media:', err.message);

                                // Fallback to render-media
                                attachRenderMedia(videoFile, token);
                            });

                        } else {
                            // 'direct' or 'transcode' (transcoded file is already MP4)
                            // Use render-media for progressive MSE streaming (standard WebTorrent approach)
                            attachRenderMedia(videoFile, token);
                        }
                    }
                }

                torrent.on('done', async () => {
                    if (token !== currentTorrentTokenRef.current) return;

                    console.log('[webtorrent] download complete!');
                    setDownloadProgress(100);
                    setIsReceiving(false);
                    stopProgressUpdates();

                    if (!isPreTranscode) {
                        socket?.current?.emit('torrent-download-complete', {
                            name: videoFile?.name || sharedName || torrent.name,
                        });

                        // Create stable blob URL only if render-media / MSE did not attach
                        if (!renderMediaReadyRef.current) {
                            createBlobUrlFallback(videoFile);
                        }

                        // Expose for save-to-library prompt
                        if (videoFile) {
                            try {
                                const buf = await videoFile.arrayBuffer();
                                const lower = (videoFile.name || '').toLowerCase();
                                const mime = lower.endsWith('.webm') ? 'video/webm'
                                    : lower.endsWith('.mov') ? 'video/quicktime'
                                        : 'video/mp4';
                                const blob = new Blob([buf], { type: mime });
                                setCompletedDownload({ blob, fileName: videoFile.name || sharedName || torrent.name });
                            } catch (e) {
                                console.warn('[webtorrent] failed to prepare library save data:', e);
                            }
                        }
                    }
                });

                torrent.on('wire', () => {
                    if (token !== currentTorrentTokenRef.current) return;
                    setNumPeers(torrent.numPeers);
                });

                torrent.on('error', (err) => {
                    if (token !== currentTorrentTokenRef.current) return;
                    console.error('[webtorrent] torrent error:', err?.message || err);
                });

                torrent.on('download', () => {
                    if (token !== currentTorrentTokenRef.current) return;
                    if (isPreTranscode || hasSentStreamReadyRef.current) return;

                    const progressPercent = Math.round((torrent.progress || 0) * 100);
                    if (progressPercent >= 5) {
                        hasSentStreamReadyRef.current = true;
                        console.log('[webtorrent] stream-ready at 5%:', progressPercent + '%');

                        socket?.current?.emit('viewer-stream-ready', {
                            progress: progressPercent,
                            timestamp: Date.now(),
                        });

                        // Try to start playback
                        if (videoRef?.current?.src) {
                            videoRef.current.play().catch(() => { });
                        }
                    }
                });

            });
        };

        /** Helper: attach render-media for direct progressive streaming */
        const attachRenderMedia = (videoFile, token) => {
            if (!videoRef?.current) return;

            console.log('[webtorrent] DIRECT path: using render-media for progressive MSE');
            try {
                renderMedia.render(videoFile, videoRef.current, {
                    autoplay: false,
                    controls: false,
                }, (err) => {
                    if (token !== currentTorrentTokenRef.current) return;
                    if (err) {
                        console.warn('[webtorrent] renderMedia error (non-fatal):', err.message);
                        renderMediaReadyRef.current = false;
                        setMovieBlobUrl(null);
                    } else {
                        renderMediaReadyRef.current = true;
                        console.log('[webtorrent] streaming to video element via render-media');
                        const streamUrl = videoRef.current?.src;
                        if (streamUrl) {
                            setMovieBlobUrl(streamUrl);
                        }
                    }
                });
            } catch (renderErr) {
                console.warn('[webtorrent] render call failed (non-fatal):', renderErr.message);
                renderMediaReadyRef.current = false;
            }
        };

        sock.on('torrent-magnet', handleMagnet);
        return () => {
            sock.off('torrent-magnet', handleMagnet);
        };
    }, [isHost, socket, trackerUrl, videoRef, startProgressUpdates, stopProgressUpdates, createBlobUrlFallback, disableViewerTorrent]);

    return {
        seedFile,
        resetTransferState,
        movieBlobUrl,
        movieFileName,
        downloadProgress,
        transferSpeed,
        numPeers,
        isSending,
        isReceiving,
        completedDownload,
        clearCompletedDownload: () => setCompletedDownload(null),
    };
}
