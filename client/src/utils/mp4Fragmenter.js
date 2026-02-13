/**
 * MP4 Fragmenter using mp4box.js
 * Instantly fragments MP4 files for MSE streaming — no ffmpeg, no re-encoding.
 * Works by reading the MP4 structure (moov/mdat atoms) and outputting fMP4 segments.
 */
import { createFile as createMP4Box } from 'mp4box';

/**
 * Fragment an MP4 file for MSE streaming using mp4box.js
 * This is MUCH faster than ffmpeg.wasm because it only manipulates containers,
 * never touches the actual video/audio data.
 * 
 * @param {File} file - The MP4 file to fragment
 * @param {Function} onProgress - Progress callback (0-100)
 * @returns {Promise<{url: string, mime: string, isHevc: boolean}>}
 */
export async function fragmentMP4(file, onProgress) {
    return new Promise((resolve, reject) => {
        const mp4box = createMP4Box();
        const chunks = [];
        let mime = '';
        let isHevc = false;
        let initSegment = null;

        mp4box.onReady = (info) => {
            console.log('[mp4box] File info:', info);

            // Build codec string from actual tracks
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
                    console.log(`[mp4box] Video track: ${track.codec}, ${track.video.width}x${track.video.height}`);
                } else if (track.type === 'audio' && !audioTrackId) {
                    audioTrackId = track.id;
                    codecs.push(track.codec);
                    console.log(`[mp4box] Audio track: ${track.codec}, ${track.audio.sample_rate}Hz, ${track.audio.channel_count}ch`);
                }
            }

            mime = `video/mp4; codecs="${codecs.join(',')}"`;
            console.log('[mp4box] MIME type:', mime);

            // Check if MSE supports this combination
            if (!MediaSource.isTypeSupported(mime)) {
                console.warn('[mp4box] MSE does not support:', mime);
                // Try with just avc1 and mp4a fallback
                const fallbackMime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
                if (MediaSource.isTypeSupported(fallbackMime)) {
                    console.log('[mp4box] Falling back to:', fallbackMime);
                    mime = fallbackMime;
                }
            }

            // Set up segmentation for each track
            if (videoTrackId) {
                mp4box.setSegmentOptions(videoTrackId, null, {
                    nbSamples: 100, // samples per segment
                });
            }
            if (audioTrackId) {
                mp4box.setSegmentOptions(audioTrackId, null, {
                    nbSamples: 100,
                });
            }

            // Get initialization segment
            const initSegs = mp4box.initializeSegmentation();
            if (initSegs.length > 0) {
                // Combine all init segments
                const initBuffers = initSegs.map(s => new Uint8Array(s.buffer));
                const totalLen = initBuffers.reduce((sum, b) => sum + b.length, 0);
                initSegment = new Uint8Array(totalLen);
                let offset = 0;
                for (const buf of initBuffers) {
                    initSegment.set(buf, offset);
                    offset += buf.length;
                }
                chunks.push(initSegment);
            }

            mp4box.start();
        };

        mp4box.onSegment = (id, user, buffer, sampleNum, is_last) => {
            chunks.push(new Uint8Array(buffer));
        };

        mp4box.onError = (e) => {
            console.error('[mp4box] Error:', e);
            reject(new Error(`MP4Box error: ${e}`));
        };

        // Read file in chunks to avoid loading entirely into memory
        const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB read chunks
        const reader = file.stream().getReader();
        let offset = 0;
        let totalRead = 0;

        const readChunks = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    // mp4box expects ArrayBuffer with fileStart property
                    const buffer = value.buffer.slice(
                        value.byteOffset,
                        value.byteOffset + value.byteLength
                    );
                    buffer.fileStart = offset;
                    offset += buffer.byteLength;
                    totalRead += buffer.byteLength;

                    mp4box.appendBuffer(buffer);

                    const progress = Math.round((totalRead / file.size) * 100);
                    onProgress?.(progress);
                }

                // Signal end of file
                mp4box.flush();

                // Build final blob
                const blob = new Blob(chunks, { type: mime });
                const url = URL.createObjectURL(blob);

                resolve({ url, mime, isHevc });
            } catch (err) {
                reject(err);
            }
        };

        readChunks();
    });
}

/**
 * Quickly probe an MP4 file to extract codec info without full processing.
 * @param {File} file - The file to probe
 * @returns {Promise<{codecs: string[], mime: string, isHevc: boolean, hasAac: boolean}>}
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

        // Only need to read the first few MB to get moov atom
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
