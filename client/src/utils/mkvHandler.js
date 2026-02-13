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
export async function transmuxToFMP4(file, onProgress) {
    const ffmpeg = await loadFFmpeg(onProgress);
    const { fetchFile } = await import('@ffmpeg/util');

    const ext = file.name.split('.').pop();
    const inputName = `input.${ext}`;
    const outputName = 'output.mp4';

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    let detectedCodec = 'avc1.42E01E, mp4a.40.2'; // Default to H.264 Main
    let isHevc = false;

    // Capture logs to detect codec
    ffmpeg.on('log', ({ message }) => {
        // Example: Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), ...
        if (message.includes('Video:')) {
            if (message.includes('h264')) {
                console.log('[ffmpeg] Detected H.264');
                // Detect Profile
                if (message.includes('High')) {
                    detectedCodec = 'avc1.640028,mp4a.40.2'; // High Profile Level 4.0
                } else if (message.includes('Main')) {
                    detectedCodec = 'avc1.4d401f,mp4a.40.2'; // Main Profile Level 3.1
                } else {
                    detectedCodec = 'avc1.42E01E,mp4a.40.2'; // Constrained Baseline
                }
            } else if (message.includes('hevc') || message.includes('h265')) {
                console.log('[ffmpeg] Detected HEVC');
                isHevc = true;
                detectedCodec = 'hvc1.1.6.L93.B0,mp4a.40.2'; // Generic HEVC
            }
        }
    });

    // Remux to fMP4 (fragmented)
    await ffmpeg.exec([
        '-i', inputName,
        '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);

    // Create blob with CORRECT codec string (or generic)
    // If HEVC, browser might still fail if no hardware support.
    const mime = `video/mp4; codecs="${detectedCodec}"`;
    const blob = new Blob([data.buffer], { type: mime });
    const url = URL.createObjectURL(blob);

    // Cleanup
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    return { url, isHevc, mime };
}

/**
 * Check if a file needs transmuxing (MKV or MP4).
 * Basically any container we want to stream via MSE.
 */
export function needsTransmux(file) {
    const name = file.name.toLowerCase();
    const type = file.type;
    return (
        name.endsWith('.mkv') ||
        name.endsWith('.mp4') ||
        type === 'video/x-matroska' ||
        type === 'video/mp4'
    );
}
