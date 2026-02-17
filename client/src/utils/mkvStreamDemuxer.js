/**
 * MKV Stream Demuxer — web-demuxer (WASM) + JMuxer → MSE Pipeline
 *
 * Demuxes MKV/WebM/AVI containers using Bilibili's web-demuxer (FFmpeg-based WASM)
 * and feeds raw H.264 NALUs + AAC ADTS to JMuxer for instant MSE playback.
 *
 * Pipeline:  File → web-demuxer (WASM) → raw packets → JMuxer → MSE → <video>
 *
 * This is MUCH faster than ffmpeg.wasm remuxing because:
 *   - web-demuxer only demuxes (reads container structure), no encoding
 *   - JMuxer creates fMP4 segments on-the-fly for MSE
 *   - Playback starts after the first keyframe (~1-3 seconds)
 */

import { WebDemuxer } from 'web-demuxer';
import JMuxer from 'jmuxer';

/* ═══════════════════════════════════════════════════════════════════
 *  MKV → JMuxer MSE Pipeline
 *  Works with H.264/H.265 video + AAC/Opus/AC3 audio
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Demux an MKV/WebM file and stream it to a <video> element via JMuxer + MSE.
 *
 * @param {File|Blob} file — The MKV/WebM file (complete, from torrent download)
 * @param {HTMLVideoElement} videoEl — Target video element
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] — Cancel the pipeline
 * @param {Function} [opts.onProgress] — (0-100) demux progress
 * @param {Function} [opts.onMediaInfo] — Called with media info when available
 * @returns {Promise<{ codec: string, duration: number, jmuxer: JMuxer, demuxer: WebDemuxer }>}
 */
export async function demuxMkvToMSE(file, videoEl, opts = {}) {
    const { signal, onProgress, onMediaInfo } = opts;

    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    // 1. Initialize web-demuxer
    const demuxer = new WebDemuxer({
        wasmFilePath: '/web-demuxer.wasm',
    });

    try {
        // 2. Load the file into demuxer
        console.log('[mkv-demuxer] Loading file into web-demuxer...');
        await demuxer.load(file);

        if (signal?.aborted) {
            demuxer.destroy();
            throw new DOMException('Aborted', 'AbortError');
        }

        // 3. Get media info
        const mediaInfo = await demuxer.getMediaInfo();
        console.log('[mkv-demuxer] Media info:', mediaInfo);
        onMediaInfo?.(mediaInfo);

        // Find video and audio streams
        const videoStream = mediaInfo.streams?.find(s => s.codec_type_string === 'video');
        const audioStream = mediaInfo.streams?.find(s => s.codec_type_string === 'audio');

        if (!videoStream) {
            throw new Error('No video stream found in file');
        }

        const videoCodec = videoStream.codec_name || 'h264';
        const isHevc = videoCodec === 'hevc' || videoCodec === 'h265';
        const duration = mediaInfo.duration || 0;

        // Determine JMuxer video codec
        let jmuxerVideoCodec = 'h264';
        if (isHevc) {
            // Check browser HEVC support
            const hevcSupported = typeof MediaSource !== 'undefined' &&
                MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
            if (hevcSupported) {
                jmuxerVideoCodec = 'h265';
            } else {
                // HEVC not supported — caller should fall back to ffmpeg.wasm
                demuxer.destroy();
                throw new Error('HEVC_NOT_SUPPORTED');
            }
        }

        // Determine FPS
        const fps = videoStream.r_frame_rate
            ? parseFraction(videoStream.r_frame_rate)
            : 30;

        console.log(`[mkv-demuxer] Video: ${videoCodec}, Audio: ${audioStream?.codec_name || 'none'}, FPS: ${fps}, Duration: ${duration}s`);

        // 4. Initialize JMuxer — creates MSE SourceBuffer and attaches to video element
        const jmuxer = new JMuxer({
            node: videoEl,
            mode: audioStream ? 'both' : 'video',
            videoCodec: jmuxerVideoCodec,
            flushingTime: 100,   // Flush buffers every 100ms for low latency
            maxDelay: 1000,      // Max delay before force-flush
            fps: fps,
            clearBuffer: true,   // Auto-clear played segments
            readFpsFromTrack: false,
            debug: false,
            onReady: () => {
                console.log('[mkv-demuxer] JMuxer MSE is ready');
            },
            onError: (err) => {
                console.error('[mkv-demuxer] JMuxer error:', err);
            },
        });

        if (signal?.aborted) {
            jmuxer.destroy();
            demuxer.destroy();
            throw new DOMException('Aborted', 'AbortError');
        }

        // 5. Read demuxed packets and feed to JMuxer
        // web-demuxer returns ReadableStream<WebAVPacket> via readMediaPacket()
        // We need RAW packets (not EncodedVideoChunk) for JMuxer
        const videoReader = demuxer.readMediaPacket('video');
        const audioReader = audioStream ? demuxer.readMediaPacket('audio') : null;

        // Feed video and audio streams concurrently
        const feedPromises = [];

        // Video feeding
        feedPromises.push(
            feedPacketStream(videoReader, 'video', jmuxer, {
                signal,
                totalDuration: duration,
                onProgress,
                fps,
            })
        );

        // Audio feeding
        if (audioReader) {
            feedPromises.push(
                feedPacketStream(audioReader, 'audio', jmuxer, {
                    signal,
                    totalDuration: duration,
                })
            );
        }

        // Don't await — let feeding happen in background while playback starts
        Promise.all(feedPromises).then(() => {
            console.log('[mkv-demuxer] All packets fed to JMuxer');
        }).catch((err) => {
            if (err.name !== 'AbortError') {
                console.error('[mkv-demuxer] Packet feeding error:', err);
            }
        });

        // Playback will auto-start once JMuxer has enough data
        return {
            codec: videoCodec,
            isHevc,
            duration,
            fps,
            jmuxer,
            demuxer,
            cleanup: () => {
                try { jmuxer.destroy(); } catch { /* ignore */ }
                try { demuxer.destroy(); } catch { /* ignore */ }
            },
        };
    } catch (err) {
        try { demuxer.destroy(); } catch { /* ignore */ }
        throw err;
    }
}


/* ═══════════════════════════════════════════════════════════════════
 *  Internal: Feed a ReadableStream of packets to JMuxer
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Reads packets from a web-demuxer ReadableStream and feeds them to JMuxer.
 *
 * @param {ReadableStream} packetStream — ReadableStream<WebAVPacket>
 * @param {'video'|'audio'} type — Stream type
 * @param {JMuxer} jmuxer — JMuxer instance
 * @param {object} opts
 */
async function feedPacketStream(packetStream, type, jmuxer, opts = {}) {
    const { signal, totalDuration, onProgress, fps } = opts;
    const reader = packetStream.getReader();
    let lastProgressTime = 0;

    try {
        while (true) {
            if (signal?.aborted) {
                reader.cancel();
                throw new DOMException('Aborted', 'AbortError');
            }

            const { done, value: packet } = await reader.read();
            if (done) break;

            if (!packet || !packet.data) continue;

            // Build feed object for JMuxer
            const feedData = {};
            const packetData = packet.data instanceof Uint8Array
                ? packet.data
                : new Uint8Array(packet.data);

            if (type === 'video') {
                feedData.video = packetData;
            } else {
                feedData.audio = packetData;
            }

            // Duration in ms — use packet duration if available, else estimate from fps
            if (packet.duration !== undefined && packet.duration > 0) {
                // web-demuxer duration is in microseconds
                feedData.duration = packet.duration / 1000;
            } else if (type === 'video' && fps > 0) {
                feedData.duration = 1000 / fps;
            }

            jmuxer.feed(feedData);

            // Report progress based on timestamp
            if (type === 'video' && onProgress && totalDuration > 0 && packet.timestamp !== undefined) {
                // timestamp is in microseconds
                const currentTime = packet.timestamp / 1_000_000;
                if (currentTime - lastProgressTime >= 1) {
                    lastProgressTime = currentTime;
                    const pct = Math.min(100, Math.round((currentTime / totalDuration) * 100));
                    onProgress(pct);
                }
            }
        }
    } catch (err) {
        reader.cancel().catch(() => { });
        throw err;
    }
}


/* ═══════════════════════════════════════════════════════════════════
 *  WebCodecs Path — Alternative for HEVC or when JMuxer fails
 *  Uses web-demuxer → VideoDecoder → Canvas rendering
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Demux and decode an MKV file using WebCodecs.
 * This path is faster for HEVC since it uses hardware decoding.
 *
 * @param {File|Blob} file — The MKV/WebM file
 * @param {HTMLCanvasElement} canvas — Target canvas for rendering
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ demuxer: WebDemuxer, decoder: VideoDecoder }>}
 */
export async function demuxMkvWebCodecs(file, canvas, opts = {}) {
    const { signal } = opts;

    const demuxer = new WebDemuxer({
        wasmFilePath: '/web-demuxer.wasm',
    });

    await demuxer.load(file);

    if (signal?.aborted) {
        demuxer.destroy();
        throw new DOMException('Aborted', 'AbortError');
    }

    // Get decoder config directly from web-demuxer
    const videoConfig = await demuxer.getDecoderConfig('video');
    console.log('[mkv-webcodecs] VideoDecoderConfig:', videoConfig);

    // Check if codec is supported
    const support = await VideoDecoder.isConfigSupported(videoConfig);
    if (!support.supported) {
        demuxer.destroy();
        throw new Error(`Unsupported video codec: ${videoConfig.codec}`);
    }

    const ctx = canvas.getContext('2d');

    // Set canvas size from config
    canvas.width = videoConfig.codedWidth || videoConfig.displayWidth || 1920;
    canvas.height = videoConfig.codedHeight || videoConfig.displayHeight || 1080;

    const decoder = new VideoDecoder({
        output: (frame) => {
            // Render frame to canvas
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            frame.close();
        },
        error: (err) => {
            console.error('[mkv-webcodecs] Decoder error:', err);
        },
    });

    decoder.configure(videoConfig);

    // Read encoded video chunks and decode
    const videoStream = demuxer.read('video');
    const reader = videoStream.getReader();

    (async () => {
        try {
            while (true) {
                if (signal?.aborted) {
                    reader.cancel();
                    break;
                }
                const { done, value: chunk } = await reader.read();
                if (done) break;
                decoder.decode(chunk);
            }
            await decoder.flush();
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[mkv-webcodecs] Stream error:', err);
            }
        }
    })();

    return { demuxer, decoder };
}


/* ═══════════════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Parse a fractional frame rate string like "30/1" → 30
 */
function parseFraction(str) {
    if (!str || str === 'N/A' || str === '0/0') return 30;
    const parts = str.split('/');
    if (parts.length === 2) {
        const num = parseInt(parts[0], 10);
        const den = parseInt(parts[1], 10);
        if (den > 0 && num > 0) return num / den;
    }
    return parseFloat(str) || 30;
}

/**
 * Check if a file can be handled by the MKV stream demuxer.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
export function isMkvStreamable(fileName) {
    const lower = (fileName || '').toLowerCase();
    return lower.endsWith('.mkv') || lower.endsWith('.webm') || lower.endsWith('.avi');
}
