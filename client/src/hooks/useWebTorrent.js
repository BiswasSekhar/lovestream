import { useEffect, useRef, useState, useCallback } from 'react';
import WebTorrent from 'webtorrent';

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
export default function useWebTorrent({ socket, isHost, videoRef }) {
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

    const stopProgressUpdates = useCallback(() => {
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
    }, []);

    // Host: seed a file
    const seedFile = useCallback((file) => {
        const client = clientRef.current;
        const sock = socket?.current;
        if (!client || !sock) {
            console.error('[webtorrent] client or socket not ready');
            return;
        }

        // Remove any existing torrent
        if (torrentRef.current) {
            client.remove(torrentRef.current);
            torrentRef.current = null;
        }

        setIsSending(true);
        setDownloadProgress(0);
        console.log('[webtorrent] seeding file:', file.name, 'size:', file.size);

        client.seed(file, {
            announce: [trackerUrl],
        }, (torrent) => {
            torrentRef.current = torrent;
            console.log('[webtorrent] seeding! magnetURI:', torrent.magnetURI);

            // Share magnet URI with viewers via socket.io
            sock.emit('torrent-magnet', { magnetURI: torrent.magnetURI });

            setDownloadProgress(100);
            setIsSending(false);
            startProgressUpdates(torrent);

            torrent.on('wire', (wire) => {
                console.log('[webtorrent] new peer connected:', wire.peerId);
                setNumPeers(torrent.numPeers);
            });
        });
    }, [socket, trackerUrl, startProgressUpdates]);

    // Viewer: listen for magnet URI and start downloading
    useEffect(() => {
        if (isHost) return;
        const sock = socket?.current;
        if (!sock) return;

        const handleMagnet = ({ magnetURI }) => {
            const client = clientRef.current;
            if (!client) return;

            console.log('[webtorrent] received magnet URI:', magnetURI);

            // Remove any existing torrent
            if (torrentRef.current) {
                client.remove(torrentRef.current);
                torrentRef.current = null;
            }

            setIsReceiving(true);
            setDownloadProgress(0);

            client.add(magnetURI, {
                announce: [trackerUrl],
            }, (torrent) => {
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

                    // Stream to video element via MSE (WebTorrent handles this)
                    if (videoRef?.current) {
                        videoFile.renderTo(videoRef.current, {
                            autoplay: false,
                            controls: false,
                        }, (err, elem) => {
                            if (err) {
                                console.error('[webtorrent] renderTo error:', err.message);
                                // Fallback: create blob URL
                                videoFile.getBlobURL((err, url) => {
                                    if (err) {
                                        console.error('[webtorrent] getBlobURL error:', err);
                                        return;
                                    }
                                    setMovieBlobUrl(url);
                                });
                            } else {
                                console.log('[webtorrent] streaming to video element');
                            }
                        });
                    }
                }

                torrent.on('done', () => {
                    console.log('[webtorrent] download complete!');
                    setDownloadProgress(100);
                    setIsReceiving(false);
                    stopProgressUpdates();

                    // Also create blob URL as backup
                    if (videoFile) {
                        videoFile.getBlobURL((err, url) => {
                            if (!err) {
                                setMovieBlobUrl(url);
                            }
                        });
                    }
                });

                torrent.on('wire', () => {
                    setNumPeers(torrent.numPeers);
                });
            });
        };

        sock.on('torrent-magnet', handleMagnet);
        return () => {
            sock.off('torrent-magnet', handleMagnet);
        };
    }, [isHost, socket, trackerUrl, videoRef, startProgressUpdates, stopProgressUpdates]);

    return {
        seedFile,
        movieBlobUrl,
        movieFileName,
        downloadProgress,
        transferSpeed,
        numPeers,
        isSending,
        isReceiving,
    };
}
