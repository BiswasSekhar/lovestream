/**
 * MP4 Fragmenter & MSE Streamer using mp4box.js
 *
 * Three modes of operation:
 *   1. fragmentMP4()       — Fragment a full MP4 file into a blob (legacy, simpler)
 *   2. streamToMSE()       — Pipe mp4box.js segments directly to a <video> via MSE
 *   3. streamTorrentToMSE()— Read a WebTorrent file's stream and pipe to MSE on-the-fly
 *
 * Modes 2 & 3 are the "torrent streaming site" approach:
 *   - No full-file buffering in memory
 *   - Progressive playback as segments arrive
 *   - Works for MP4 files that need fragmentation for MSE
 */
import { createFile as createMP4Box } from 'mp4box';

/* ═══════════════════════════════════════════════════════════════════
 *  1. Full-file fragmentation (legacy path, kept for compatibility)
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Fragment an MP4 file for MSE streaming using mp4box.js.
 * Reads the entire file, fragments, returns a blob URL.
 *
 * @param {File} file - The MP4 file to fragment
 * @param {Function} onProgress - Progress callback (0-100)
 * @returns {Promise<{url: string, blob: Blob, mime: string, isHevc: boolean}>}
 */
export async function fragmentMP4(file, onProgress) {
    return new Promise((resolve, reject) => {
        const mp4box = createMP4Box();
        const chunks = [];
        let mime = '';
        let isHevc = false;

        mp4box.onReady = (info) => {
            const codecs = [];
            let videoTrackId = null;
            let audioTrackId = null;

            for (const track of info.tracks) {
                if (track.type === 'video' && !videoTrackId) {
                    videoTrackId = track.id;
                    codecs.push(track.codec);
                    if (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1')) {
                        isHevc = true;
                    }
                } else if (track.type === 'audio' && !audioTrackId) {
                    audioTrackId = track.id;
                    codecs.push(track.codec);
                }
            }

            mime = `video/mp4; codecs="${codecs.join(',')}"`;

            if (!MediaSource.isTypeSupported(mime)) {
                const fallbackMime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
                if (MediaSource.isTypeSupported(fallbackMime)) {
                    mime = fallbackMime;
                }
            }

            if (videoTrackId) {
                mp4box.setSegmentOptions(videoTrackId, null, { nbSamples: 100 });
            }
            if (audioTrackId) {
                mp4box.setSegmentOptions(audioTrackId, null, { nbSamples: 100 });
            }

            const initSegs = mp4box.initializeSegmentation();
            if (initSegs.length > 0) {
                const initBuffers = initSegs.map(s => new Uint8Array(s.buffer));
                const totalLen = initBuffers.reduce((sum, b) => sum + b.length, 0);
                const initSegment = new Uint8Array(totalLen);
                let offset = 0;
                for (const buf of initBuffers) {
                    initSegment.set(buf, offset);
                    offset += buf.length;
                }
                chunks.push(initSegment);
            }

            mp4box.start();
        };

        mp4box.onSegment = (_id, _user, buffer) => {
            chunks.push(new Uint8Array(buffer));
        };

        mp4box.onError = (e) => reject(new Error(`MP4Box error: ${e}`));

        const reader = file.stream().getReader();
        let offset = 0;
        let totalRead = 0;

        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const buffer = value.buffer.slice(
                        value.byteOffset,
                        value.byteOffset + value.byteLength,
                    );
                    buffer.fileStart = offset;
                    offset += buffer.byteLength;
                    totalRead += buffer.byteLength;

                    mp4box.appendBuffer(buffer);
                    onProgress?.(Math.round((totalRead / file.size) * 100));
                }

                mp4box.flush();

                const blob = new Blob(chunks, { type: mime });
                const url = URL.createObjectURL(blob);
                resolve({ url, blob, mime, isHevc });
            } catch (err) {
                reject(err);
            }
        })();
    });
}


/* ═══════════════════════════════════════════════════════════════════
 *  2. Incremental MSE Streaming — pipe mp4box segments to <video>
 *     This is the "torrent streaming site" approach.
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Stream an MP4 file directly to a <video> element via MSE.
 * Segments are fed to SourceBuffer as mp4box.js produces them — no full-file blob.
 *
 * @param {File} file — Local File object
 * @param {HTMLVideoElement} videoEl — Target video element
 * @param {object} [opts]
 * @param {Function} [opts.onProgress] — (0-100)
 * @param {AbortSignal} [opts.signal] — Cancel the stream
 * @returns {Promise<{mime: string, isHevc: boolean, mediaSource: MediaSource}>}
 */
export function streamToMSE(file, videoEl, opts = {}) {
    const { onProgress, signal } = opts;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

        const mp4box = createMP4Box();
        const mediaSource = new MediaSource();
        let sourceBuffer = null;
        let mime = '';
        let isHevc = false;
        let pendingBuffers = [];
        let initDone = false;

        videoEl.src = URL.createObjectURL(mediaSource);

        const appendNext = () => {
            if (!sourceBuffer || sourceBuffer.updating || pendingBuffers.length === 0) return;
            const next = pendingBuffers.shift();
            try {
                sourceBuffer.appendBuffer(next);
            } catch (err) {
                console.error('[mse-stream] appendBuffer error:', err.message);
            }
        };

        mediaSource.addEventListener('sourceopen', () => {
            mp4box.onReady = (info) => {
                const codecs = [];
                let videoTrackId = null;
                let audioTrackId = null;

                for (const track of info.tracks) {
                    if (track.type === 'video' && !videoTrackId) {
                        videoTrackId = track.id;
                        codecs.push(track.codec);
                        if (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1')) {
                            isHevc = true;
                        }
                    } else if (track.type === 'audio' && !audioTrackId) {
                        audioTrackId = track.id;
                        codecs.push(track.codec);
                    }
                }

                mime = `video/mp4; codecs="${codecs.join(',')}"`;

                if (!MediaSource.isTypeSupported(mime)) {
                    const fallback = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
                    if (MediaSource.isTypeSupported(fallback)) {
                        mime = fallback;
                    } else {
                        reject(new Error(`Unsupported codec combination: ${mime}`));
                        return;
                    }
                }

                try {
                    sourceBuffer = mediaSource.addSourceBuffer(mime);
                } catch (err) {
                    reject(new Error(`Failed to create SourceBuffer: ${err.message}`));
                    return;
                }

                sourceBuffer.addEventListener('updateend', appendNext);

                if (videoTrackId) {
                    mp4box.setSegmentOptions(videoTrackId, null, { nbSamples: 100 });
                }
                if (audioTrackId) {
                    mp4box.setSegmentOptions(audioTrackId, null, { nbSamples: 100 });
                }

                // Initialization segments
                const initSegs = mp4box.initializeSegmentation();
                for (const seg of initSegs) {
                    pendingBuffers.push(new Uint8Array(seg.buffer));
                }
                initDone = true;
                appendNext();

                mp4box.start();
                resolve({ mime, isHevc, mediaSource });
            };

            mp4box.onSegment = (_id, _user, buffer) => {
                pendingBuffers.push(new Uint8Array(buffer));
                appendNext();
            };

            mp4box.onError = (e) => reject(new Error(`MP4Box MSE error: ${e}`));

            // Read file progressively
            const reader = file.stream().getReader();
            let fileOffset = 0;
            let totalRead = 0;

            const pump = async () => {
                try {
                    while (true) {
                        if (signal?.aborted) {
                            reader.cancel();
                            return;
                        }
                        const { done, value } = await reader.read();
                        if (done) break;

                        const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                        ab.fileStart = fileOffset;
                        fileOffset += ab.byteLength;
                        totalRead += ab.byteLength;

                        mp4box.appendBuffer(ab);
                        onProgress?.(Math.round((totalRead / file.size) * 100));
                    }
                    mp4box.flush();

                    // Wait for all pending buffers to be appended, then end stream
                    const waitDrain = () => {
                        if (pendingBuffers.length === 0 && !sourceBuffer?.updating) {
                            try { mediaSource.endOfStream(); } catch { /* ignore */ }
                        } else {
                            setTimeout(waitDrain, 100);
                        }
                    };
                    waitDrain();
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('[mse-stream] pump error:', err);
                    }
                }
            };
            pump();
        });
    });
}


/* ═══════════════════════════════════════════════════════════════════
 *  3. Torrent File → MSE Streaming
 *     Reads a WebTorrent file's createReadStream() and pipes to MSE.
 *     This is the key function for the remux path on the viewer side.
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Stream a WebTorrent file to a <video> element via MSE on-the-fly.
 * As torrent pieces arrive, mp4box.js fragments them into fMP4 segments
 * and feeds them directly to SourceBuffer.
 *
 * @param {object} torrentFile — WebTorrent file object (has .createReadStream())
 * @param {HTMLVideoElement} videoEl
 * @param {object} [opts]
 * @param {Function} [opts.onProgress] — (0-100)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{mime: string, isHevc: boolean, mediaSource: MediaSource}>}
 */
export function streamTorrentToMSE(torrentFile, videoEl, opts = {}) {
    const { onProgress, signal } = opts;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

        const mp4box = createMP4Box();
        const mediaSource = new MediaSource();
        let sourceBuffer = null;
        let mime = '';
        let isHevc = false;
        const pendingBuffers = [];

        videoEl.src = URL.createObjectURL(mediaSource);

        const appendNext = () => {
            if (!sourceBuffer || sourceBuffer.updating || pendingBuffers.length === 0) return;
            const next = pendingBuffers.shift();
            try {
                sourceBuffer.appendBuffer(next);
            } catch (err) {
                console.error('[torrent-mse] appendBuffer error:', err.message);
            }
        };

        mediaSource.addEventListener('sourceopen', () => {
            mp4box.onReady = (info) => {
                const codecs = [];
                let videoTrackId = null;
                let audioTrackId = null;

                for (const track of info.tracks) {
                    if (track.type === 'video' && !videoTrackId) {
                        videoTrackId = track.id;
                        codecs.push(track.codec);
                        if (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1')) {
                            isHevc = true;
                        }
                    } else if (track.type === 'audio' && !audioTrackId) {
                        audioTrackId = track.id;
                        codecs.push(track.codec);
                    }
                }

                mime = `video/mp4; codecs="${codecs.join(',')}"`;

                if (!MediaSource.isTypeSupported(mime)) {
                    const fallback = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
                    if (MediaSource.isTypeSupported(fallback)) {
                        mime = fallback;
                    } else {
                        reject(new Error(`Unsupported codec combination: ${mime}`));
                        return;
                    }
                }

                try {
                    sourceBuffer = mediaSource.addSourceBuffer(mime);
                } catch (err) {
                    reject(new Error(`Failed to create SourceBuffer: ${err.message}`));
                    return;
                }

                sourceBuffer.addEventListener('updateend', appendNext);

                if (videoTrackId) {
                    mp4box.setSegmentOptions(videoTrackId, null, { nbSamples: 100 });
                }
                if (audioTrackId) {
                    mp4box.setSegmentOptions(audioTrackId, null, { nbSamples: 100 });
                }

                const initSegs = mp4box.initializeSegmentation();
                for (const seg of initSegs) {
                    pendingBuffers.push(new Uint8Array(seg.buffer));
                }
                appendNext();

                mp4box.start();
                resolve({ mime, isHevc, mediaSource });
            };

            mp4box.onSegment = (_id, _user, buffer) => {
                pendingBuffers.push(new Uint8Array(buffer));
                appendNext();
            };

            mp4box.onError = (e) => reject(new Error(`MP4Box torrent-MSE error: ${e}`));

            // Read from torrent file stream
            const stream = torrentFile.createReadStream();
            let fileOffset = 0;
            let totalRead = 0;
            const fileSize = torrentFile.length || 0;

            stream.on('data', (chunk) => {
                if (signal?.aborted) {
                    stream.destroy();
                    return;
                }

                // Convert Node Buffer to ArrayBuffer with fileStart
                const uint8 = new Uint8Array(chunk);
                const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
                ab.fileStart = fileOffset;
                fileOffset += ab.byteLength;
                totalRead += ab.byteLength;

                mp4box.appendBuffer(ab);

                if (fileSize > 0) {
                    onProgress?.(Math.round((totalRead / fileSize) * 100));
                }
            });

            stream.on('end', () => {
                try { mp4box.flush(); } catch { /* ignore */ }

                const waitDrain = () => {
                    if (pendingBuffers.length === 0 && !sourceBuffer?.updating) {
                        try { mediaSource.endOfStream(); } catch { /* ignore */ }
                    } else {
                        setTimeout(waitDrain, 100);
                    }
                };
                waitDrain();
            });

            stream.on('error', (err) => {
                console.error('[torrent-mse] stream error:', err);
            });
        });
    });
}


/* ═══════════════════════════════════════════════════════════════════
 *  Utility: probe + check
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Quickly probe an MP4 file to extract codec info without full processing.
 */
export async function probeMP4(file) {
    return new Promise((resolve, reject) => {
        const mp4box = createMP4Box();

        mp4box.onReady = (info) => {
            const codecs = [];
            let isHevc = false;
            let hasAac = false;

            for (const track of info.tracks) {
                codecs.push(track.codec);
                if (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1')) {
                    isHevc = true;
                }
                if (track.codec.startsWith('mp4a')) {
                    hasAac = true;
                }
            }

            const mime = `video/mp4; codecs="${codecs.join(',')}"`;
            resolve({ codecs, mime, isHevc, hasAac });
        };

        mp4box.onError = (e) => reject(new Error(`Probe error: ${e}`));

        const slice = file.slice(0, Math.min(file.size, 10 * 1024 * 1024));
        slice.arrayBuffer().then((buffer) => {
            buffer.fileStart = 0;
            mp4box.appendBuffer(buffer);
        }).catch(reject);
    });
}

/**
 * Check if a file is a native MP4 that can be handled by mp4box.js
 */
export function isNativeMP4(file) {
    const name = file.name.toLowerCase();
    const type = file.type;
    return (
        name.endsWith('.mp4') ||
        name.endsWith('.m4v') ||
        name.endsWith('.mov') ||
        type === 'video/mp4' ||
        type === 'video/quicktime'
    );
}
