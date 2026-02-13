import { useEffect, useRef, useState, useCallback } from 'react';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const CHANNEL_LABEL = 'movie-file';

/**
 * Hook for streaming a movie file over WebRTC data channel.
 * Host sends file bytes in chunks; viewer receives and assembles a Blob URL.
 *
 * @param {object} params
 * @param {React.MutableRefObject} params.peer - SimplePeer ref from useWebRTC
 * @param {boolean} params.isHost
 * @param {function} [params.onChunk] - Callback for progressive streaming (receives Uint8Array)
 * @param {function} [params.onMeta] - Callback when file metadata is received
 */
export default function useFileStream({ peer, isHost, onChunk, onMeta }) {
    const [downloadProgress, setDownloadProgress] = useState(0); // 0-100
    const [movieBlobUrl, setMovieBlobUrl] = useState(null);
    const [movieFileName, setMovieFileName] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [isReceiving, setIsReceiving] = useState(false);

    const chunksRef = useRef([]);
    const expectedSizeRef = useRef(0);
    const receivedSizeRef = useRef(0);
    const metaReceivedRef = useRef(false);
    const channelRef = useRef(null);

    // Viewer: listen for incoming data channel
    useEffect(() => {
        const p = peer.current;
        if (!p || p.destroyed || isHost) return;

        const handleData = (rawData) => {
            let data = rawData;

            // Try to decode binary as text if we're expecting metadata
            if (!metaReceivedRef.current && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
                try {
                    const text = new TextDecoder().decode(data);
                    // Check if it looks like our metadata JSON
                    if (text.includes('file-meta') && text.trim().startsWith('{')) {
                        console.log('[filestream] decoded binary metadata message');
                        data = text;
                    }
                } catch (e) {
                    // Not text, proceed as binary
                }
            }

            // First message is the metadata header (JSON string)
            if (typeof data === 'string') {
                try {
                    const meta = JSON.parse(data);
                    if (meta.type === 'file-meta') {
                        console.log('[filestream] receiving file:', meta.name, 'size:', meta.size);
                        expectedSizeRef.current = meta.size;
                        receivedSizeRef.current = 0;
                        chunksRef.current = [];
                        metaReceivedRef.current = true;
                        setMovieFileName(meta.name);
                        setIsReceiving(true);
                        setDownloadProgress(0);

                        // Notify parent about metadata (for MediaSource init)
                        onMeta?.(meta);

                        // Revoke old URL if any
                        if (movieBlobUrl) {
                            console.log('[filestream] revoking old url');
                            URL.revokeObjectURL(movieBlobUrl);
                            setMovieBlobUrl(null);
                        }
                    }
                } catch (e) {
                    // Not JSON, ignore
                }
                return;
            }

            // Ignore binary if we haven't received metadata yet
            if (!metaReceivedRef.current) {
                console.warn('[filestream] received binary before metadata, ignoring');
                return;
            }

            // Binary chunk
            const chunk = rawData instanceof ArrayBuffer ? new Uint8Array(rawData) : rawData;
            chunksRef.current.push(chunk);
            receivedSizeRef.current += chunk.byteLength;

            // Streaming callback
            onChunk?.(chunk);

            const progress = Math.min(
                99,
                Math.round((receivedSizeRef.current / expectedSizeRef.current) * 100)
            );
            setDownloadProgress(progress);

            // Check if complete
            if (receivedSizeRef.current >= expectedSizeRef.current) {
                console.log('[filestream] file transfer complete!');
                const blob = new Blob(chunksRef.current, { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                console.log('[filestream] file transfer complete! blob size:', blob.size, 'url:', url);
                setMovieBlobUrl(url);
                setDownloadProgress(100);
                setIsReceiving(false);
                chunksRef.current = []; // Free memory
            }
        };

        p.on('data', handleData);
        return () => {
            p.off('data', handleData);
        };
    }, [peer.current, isHost]); // eslint-disable-line react-hooks/exhaustive-deps

    // Host: send a file over the data channel
    const sendFile = useCallback(
        async (file) => {
            const p = peer.current;
            if (!p || p.destroyed) {
                console.warn('[filestream] no active peer connection');
                return;
            }

            setIsSending(true);
            setDownloadProgress(0);

            try {
                // Send metadata header
                const meta = JSON.stringify({
                    type: 'file-meta',
                    name: file.name,
                    size: file.size,
                    mimeType: file.type || 'video/mp4',
                });
                p.send(meta);

                // Read and send file in chunks
                const arrayBuffer = await file.arrayBuffer();
                const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
                let sent = 0;

                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
                    const chunk = arrayBuffer.slice(start, end);

                    // Backpressure: wait if buffer is getting full
                    while (p._channel && p._channel.bufferedAmount > 1024 * 1024) {
                        await new Promise((r) => setTimeout(r, 50));
                    }

                    // Check if connection is still alive
                    if (!p || p.destroyed || !p._channel || p._channel.readyState !== 'open') {
                        console.warn('[filestream] connection lost during transfer');
                        setIsSending(false);
                        return;
                    }

                    p.send(new Uint8Array(chunk));
                    sent += chunk.byteLength;

                    const progress = Math.round((sent / arrayBuffer.byteLength) * 100);
                    setDownloadProgress(progress);
                }

                console.log('[filestream] file sent successfully!');
                setIsSending(false);
            } catch (err) {
                console.error('[filestream] send error:', err);
                setIsSending(false);
            }
        },
        [peer]
    );

    // Cleanup blob URL on unmount
    useEffect(() => {
        return () => {
            if (movieBlobUrl) {
                console.log('[filestream] revoking blob url:', movieBlobUrl);
                URL.revokeObjectURL(movieBlobUrl);
            }
        };
    }, [movieBlobUrl]);

    return {
        sendFile,
        movieBlobUrl,
        movieFileName,
        downloadProgress,
        isSending,
        isReceiving,
    };
}
