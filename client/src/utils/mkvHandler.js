/**
 * MKV to MP4 remuxing using ffmpeg.wasm.
 * Only remuxes (container change), no re-encoding — very fast.
 */
let ffmpegInstance = null;
let ffmpegLoading = false;

export async function loadFFmpeg(onProgress) {
    if (ffmpegInstance) return ffmpegInstance;
    if (ffmpegLoading) {
        // Wait for existing load
        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (ffmpegInstance) {
                    clearInterval(check);
                    resolve(ffmpegInstance);
                }
            }, 100);
        });
    }

    ffmpegLoading = true;

    try {
        const { FFmpeg } = await import('@ffmpeg/ffmpeg');
        const { toBlobURL } = await import('@ffmpeg/util');

        const ffmpeg = new FFmpeg();

        ffmpeg.on('progress', ({ progress }) => {
            onProgress?.(Math.round(progress * 100));
        });

        // Load ffmpeg core from CDN
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
        await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });

        ffmpegInstance = ffmpeg;
        return ffmpeg;
    } catch (err) {
        ffmpegLoading = false;
        throw new Error(`Failed to load ffmpeg: ${err.message}`);
    }
}

/**
 * Remux a video file (MKV, MP4) to Fragmented MP4 (fMP4) for MSE streaming.
 * @param {File} file - The input file
 * @param {Function} onProgress - Progress callback (0-100)
 * @returns {Promise<{url: string, isHevc: boolean, mime: string}>} Result object
 */
export async function transmuxToFMP4(file, onProgress, options = {}) {
    const ffmpeg = await loadFFmpeg(onProgress);
    const { fetchFile } = await import('@ffmpeg/util');
    const forceH264 = Boolean(options.forceH264);

    const ext = file.name.split('.').pop();
    const inputName = `input.${ext}`;
    const outputName = 'output.mp4';

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    let detectedVideoCodec = 'avc1.42E01E'; // Default to H.264 Baseline
    let detectedAudioCodec = 'mp4a.40.2'; // Default to AAC-LC
    let isHevc = false;
    let audioNeedsTranscode = false;

    // Capture logs to detect codec
    ffmpeg.on('log', ({ message }) => {
        // Example: Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), ...
        if (message.includes('Video:')) {
            if (message.includes('h264')) {
                console.log('[ffmpeg] Detected H.264');
                // Detect Profile
                if (message.includes('High')) {
                    detectedVideoCodec = 'avc1.640028'; // High Profile Level 4.0
                } else if (message.includes('Main')) {
                    detectedVideoCodec = 'avc1.4d401f'; // Main Profile Level 3.1
                } else {
                    detectedVideoCodec = 'avc1.42E01E'; // Constrained Baseline
                }
            } else if (message.includes('hevc') || message.includes('h265')) {
                console.log('[ffmpeg] Detected HEVC');
                isHevc = true;
                detectedVideoCodec = 'hvc1.1.6.L93.B0'; // Generic HEVC
            }
        }
        // Detect audio codec
        if (message.includes('Audio:')) {
            console.log('[ffmpeg] Audio info:', message);
            if (message.includes('aac')) {
                detectedAudioCodec = 'mp4a.40.2'; // AAC-LC
                audioNeedsTranscode = false;
            } else if (message.includes('ac3') || message.includes('eac3') || message.includes('dts') || message.includes('truehd')) {
                console.log('[ffmpeg] Non-AAC audio detected, will transcode to AAC');
                detectedAudioCodec = 'mp4a.40.2'; // Will be transcoded to AAC
                audioNeedsTranscode = true;
            } else if (message.includes('opus') || message.includes('vorbis') || message.includes('flac')) {
                console.log('[ffmpeg] Non-AAC audio detected, will transcode to AAC');
                detectedAudioCodec = 'mp4a.40.2';
                audioNeedsTranscode = true;
            } else {
                // Unknown audio codec — transcode to AAC to be safe
                console.log('[ffmpeg] Unknown audio codec, will transcode to AAC');
                detectedAudioCodec = 'mp4a.40.2';
                audioNeedsTranscode = true;
            }
        }
    });

    // Remux/transcode to fMP4 (fragmented)
    // Always transcode audio to AAC for MSE compatibility.
    // Video: copy by default (fast), or transcode to H.264 when forceH264 is enabled.
    const ffmpegArgs = forceH264
        ? [
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            outputName,
        ]
        : [
            '-i', inputName,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            outputName,
        ];

    await ffmpeg.exec(ffmpegArgs);

    const data = await ffmpeg.readFile(outputName);

    // Create blob with CORRECT codec string (or generic)
    // If HEVC, browser might still fail if no hardware support.
    const detectedCodec = forceH264 ? `avc1.640028,${detectedAudioCodec}` : `${detectedVideoCodec},${detectedAudioCodec}`;
    const mime = `video/mp4; codecs="${detectedCodec}"`;
    const blob = new Blob([data.buffer], { type: mime });
    const url = URL.createObjectURL(blob);

    // Cleanup
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    return { url, isHevc, mime, transcodedVideo: forceH264 };
}

/**
 * Check if a file needs transmuxing via ffmpeg (MKV, WebM, etc).
 * MP4 files are handled by mp4box.js instead (much faster).
 */
export function needsTransmux(file) {
    const name = file.name.toLowerCase();
    const type = file.type;
    return (
        name.endsWith('.mkv') ||
        name.endsWith('.webm') ||
        name.endsWith('.avi') ||
        type === 'video/x-matroska' ||
        type === 'video/webm'
    );
}
