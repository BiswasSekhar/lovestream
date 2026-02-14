import { useEffect, useRef, useState, useCallback } from 'react';
import WebTorrent from 'webtorrent';
import renderMedia from 'render-media';
import { getTempMedia, saveTempMedia, updateTempMediaPosition, TEMP_MEDIA_TTL_MS } from '../utils/tempMediaCache.js';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/**
 * Hook for P2P movie sharing via WebTorrent.
 * Replaces the old useFileStream (WebRTC DataChannel) approach.
 *
 * Host: seeds a file → shares magnetURI via socket.io → viewers download P2P
 * Viewers: receive magnetURI → download from host (and each other) → stream to <video>
 *
 * @param {object} params
 * @param {React.MutableRefObject} params.socket - Socket.IO ref
 * @param {boolean} params.isHost
 * @param {React.RefObject} params.videoRef - Reference to the <video> element
 */
export default function useWebTorrent({ socket, isHost, videoRef, roomCode }) {
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [transferSpeed, setTransferSpeed] = useState(0); // bytes/sec
    const [numPeers, setNumPeers] = useState(0);
    const [isSending, setIsSending] = useState(false);
    const [isReceiving, setIsReceiving] = useState(false);
    const [movieBlobUrl, setMovieBlobUrl] = useState(null);
    const [movieFileName, setMovieFileName] = useState('');

    const clientRef = useRef(null);
    const torrentRef = useRef(null);
    const progressIntervalRef = useRef(null);
    const renderMediaReadyRef = useRef(false);
    const currentTorrentTokenRef = useRef(0);
    const hasSentStreamReadyRef = useRef(false);
    const activeMagnetRef = useRef(null);
    const lastPersistedPositionRef = useRef(0);
    const seededFileKeyRef = useRef('');

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
                    await saveTempMedia({
                        roomCode,
                        role: 'viewer',
                        blob,
                        fileName: videoFile.name || 'movie.mp4',
                        ttlMs: TEMP_MEDIA_TTL_MS,
                    });
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

        activeMagnetRef.current = null;
        currentTorrentTokenRef.current += 1;
        stopProgressUpdates();
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

    // Host: seed a file
    const seedFile = useCallback((file, options = {}) => {
        const client = clientRef.current;
        const sock = socket?.current;
        if (!client || !sock) {
            console.error('[webtorrent] client or socket not ready');
            return;
        }

        const isPreTranscodeSeed = Boolean(options.preTranscode);
        const fileKey = buildFileKey(file);

        if (!isPreTranscodeSeed && torrentRef.current && seededFileKeyRef.current === fileKey) {
            const existingMagnet = torrentRef.current.magnetURI;
            if (existingMagnet) {
                console.log('[webtorrent] same file already seeded, re-sharing existing magnet');
                sock.emit('torrent-magnet', {
                    magnetURI: existingMagnet,
                    preTranscode: false,
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
        console.log('[webtorrent] seeding file:', file.name, 'size:', file.size);

        client.seed(file, {
            announce: [trackerUrl],
        }, (torrent) => {
            torrentRef.current = torrent;
            seededFileKeyRef.current = fileKey;
            console.log('[webtorrent] seeding! magnetURI:', torrent.magnetURI);

            // Share magnet URI with viewers via socket.io
            sock.emit('torrent-magnet', {
                magnetURI: torrent.magnetURI,
                preTranscode: isPreTranscodeSeed,
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

    // Viewer: listen for magnet URI and start downloading
    useEffect(() => {
        if (isHost) return;
        const sock = socket?.current;
        if (!sock) return;

        const handleMagnet = (payload) => {
            const client = clientRef.current;
            if (!client) return;

            const magnetURI = typeof payload === 'string' ? payload : payload?.magnetURI;
            const isPreTranscode = Boolean(payload?.preTranscode);
            const sharedName = payload?.name || '';
            if (!magnetURI) return;

            // Ignore duplicate finalized magnet replays to avoid restarting/losing current progress.
            if (!isPreTranscode && activeMagnetRef.current === magnetURI && torrentRef.current) {
                console.log('[webtorrent] duplicate finalized magnet ignored');
                return;
            }

            console.log('[webtorrent] received magnet URI:', magnetURI, 'preTranscode:', isPreTranscode, 'name:', sharedName);

            // Remove any existing torrent
            if (torrentRef.current) {
                client.remove(torrentRef.current);
                torrentRef.current = null;
            }

            currentTorrentTokenRef.current += 1;
            const token = currentTorrentTokenRef.current;
            activeMagnetRef.current = magnetURI;

            setIsReceiving(true);
            setDownloadProgress(0);
            setMovieBlobUrl(null);
            renderMediaReadyRef.current = false;
            hasSentStreamReadyRef.current = false;

            client.add(magnetURI, {
                announce: [trackerUrl],
            }, (torrent) => {
                if (token !== currentTorrentTokenRef.current) {
                    return;
                }

                torrentRef.current = torrent;
                console.log('[webtorrent] downloading:', torrent.name, 'files:', torrent.files.length);

                startProgressUpdates(torrent);

                // Find the video file in the torrent
                const videoFile = torrent.files.find(f => {
                    const name = f.name.toLowerCase();
                    return name.endsWith('.mp4') || name.endsWith('.mkv') ||
                        name.endsWith('.webm') || name.endsWith('.mov');
                }) || torrent.files[0];

                if (videoFile) {
                    setMovieFileName(videoFile.name);

                    // Pre-transcode phase is prefetch-only: do NOT attach to video element.
                    if (isPreTranscode) {
                        console.log('[webtorrent] pre-transcode prefetch phase active; skipping player attach');
                    } else if (videoRef?.current) {
                        try {
                            renderMedia.render(videoFile, videoRef.current, {
                                autoplay: false,
                                controls: false,
                            }, (err, elem) => {
                                if (token !== currentTorrentTokenRef.current) return;

                                if (err) {
                                    console.error('[webtorrent] renderMedia error:', err.message);
                                    renderMediaReadyRef.current = false;
                                    createBlobUrlFallback(videoFile);
                                } else {
                                    renderMediaReadyRef.current = true;
                                    console.log('[webtorrent] streaming to video element via render-media');
                                }
                            });
                        } catch (renderErr) {
                            console.error('[webtorrent] render call failed:', renderErr);
                            renderMediaReadyRef.current = false;
                            createBlobUrlFallback(videoFile);
                        }
                    }
                }

                torrent.on('done', () => {
                    if (token !== currentTorrentTokenRef.current) return;

                    console.log('[webtorrent] download complete!');
                    setDownloadProgress(100);
                    setIsReceiving(false);
                    stopProgressUpdates();

                    if (!isPreTranscode) {
                        socket?.current?.emit('torrent-download-complete', {
                            name: videoFile?.name || sharedName || torrent.name,
                        });

                        // Persist local playable source for post-download stability.
                        createBlobUrlFallback(videoFile);
                    }

                    // Create blob fallback only if render-media never became ready.
                    if (videoFile && !isPreTranscode && !renderMediaReadyRef.current) {
                        createBlobUrlFallback(videoFile);
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

                        if (videoRef?.current) {
                            videoRef.current.play().catch(() => { });
                        }
                    }
                });

            });
        };

        sock.on('torrent-magnet', handleMagnet);
        return () => {
            sock.off('torrent-magnet', handleMagnet);
        };
    }, [isHost, socket, trackerUrl, videoRef, startProgressUpdates, stopProgressUpdates, createBlobUrlFallback]);

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
    };
}
