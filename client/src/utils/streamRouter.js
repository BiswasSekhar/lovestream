/**
 * Stream Router — Format Decision Engine
 *
 * Determines the optimal streaming path for a given video file:
 *   - 'direct'    → Browser can play natively, zero processing needed
 *   - 'remux'     → Container is non-native but codecs are supported, container-only change
 *   - 'transcode' → Codecs are truly incompatible, must re-encode
 *
 * This is modelled after how torrent streaming sites (Stremio, Webtor, Butter)
 * work: stream-first, transcode-never (unless absolutely necessary).
 */
import { probeMP4 } from './mp4Fragmenter.js';

/* ───────── browser capability checks ───────── */

const HEVC_MIME = 'video/mp4; codecs="hvc1.1.6.L93.B0"';

let _hevcSupported = null;
export function isHevcSupported() {
    if (_hevcSupported === null) {
        try {
            _hevcSupported = MediaSource.isTypeSupported(HEVC_MIME);
        } catch {
            _hevcSupported = false;
        }
    }
    return _hevcSupported;
}

/* ───────── container + extension helpers ───────── */

const DIRECT_PLAYABLE_TYPES = new Set([
    'video/mp4',
    'video/webm',
]);

const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);
const MKV_EXTENSIONS = new Set(['.mkv']);
const WEBM_EXTENSIONS = new Set(['.webm']);
const NEVER_NATIVE = new Set(['.avi', '.wmv', '.flv', '.ts', '.m2ts', '.rmvb']);

function getExtension(name) {
    const dot = (name || '').lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/* ───────── main classifier ───────── */

/**
 * Quickly classify a file into the optimal streaming path.
 * This only looks at container / extension for the fast path.
 * For MP4 files it also probes codecs.
 *
 * @param {File} file
 * @returns {Promise<{path: 'direct'|'remux'|'transcode', reason: string, probeResult?: object}>}
 */
export async function classifyFile(file) {
    const ext = getExtension(file.name);
    const mimeType = file.type || '';

    /* ─── 1. Never-native containers → transcode ─── */
    if (NEVER_NATIVE.has(ext)) {
        return {
            path: 'transcode',
            reason: `Container "${ext}" is not browser-playable — requires full transcode`,
        };
    }

    /* ─── 2. WebM → usually direct ─── */
    if (WEBM_EXTENSIONS.has(ext) || mimeType === 'video/webm') {
        // WebM with VP8/VP9 + Opus/Vorbis is natively supported in all modern browsers
        return {
            path: 'direct',
            reason: 'WebM is natively playable in browsers',
        };
    }

    /* ─── 3. MP4 / MOV → probe codecs ─── */
    if (MP4_EXTENSIONS.has(ext) || mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
        try {
            const probe = await probeMP4(file);
            const hasSupportedVideo = !probe.isHevc || isHevcSupported();
            const hasSupportedAudio = probe.hasAac; // AAC is universally supported in MP4

            if (hasSupportedVideo && hasSupportedAudio) {
                return {
                    path: 'direct',
                    reason: 'MP4 with browser-compatible codecs — zero processing needed',
                    probeResult: probe,
                };
            }

            if (hasSupportedVideo && !hasSupportedAudio) {
                // Video is fine but audio needs remux (e.g. DTS/AC3 → AAC)
                return {
                    path: 'remux',
                    reason: `Audio codec not natively supported (need AAC), video OK — remux only`,
                    probeResult: probe,
                };
            }

            // HEVC with no browser support → full transcode
            return {
                path: 'transcode',
                reason: 'HEVC/H.265 not supported by this browser — requires transcode to H.264',
                probeResult: probe,
            };
        } catch (err) {
            // Probe failed — assume it's playable and let the browser try
            console.warn('[streamRouter] MP4 probe failed, assuming direct:', err.message);
            return {
                path: 'direct',
                reason: 'MP4 probe failed — attempting direct playback',
            };
        }
    }

    /* ─── 4. MKV → remux (container change only, codecs usually fine) ─── */
    if (MKV_EXTENSIONS.has(ext) || mimeType === 'video/x-matroska') {
        // MKV typically contains H.264/H.265 video + AAC/AC3/DTS audio.
        // Browsers can't play MKV containers, but the VIDEO codecs inside are usually H.264.
        // We need to remux (change container) without re-encoding.
        // If it turns out to be HEVC inside, the remux path will detect and escalate.
        return {
            path: 'remux',
            reason: 'MKV container not natively playable — needs remux to MP4 (no re-encoding)',
        };
    }

    /* ─── 5. Unknown → try direct, browser will error if it can't ─── */
    return {
        path: 'direct',
        reason: `Unknown format "${ext}" — attempting direct playback`,
    };
}

/**
 * Simple sync check: can the browser probably play this file directly?
 * Faster than classifyFile() but less accurate — no codec probing.
 */
export function isLikelyDirectPlayable(file) {
    const ext = getExtension(file.name);
    const mime = file.type || '';
    if (DIRECT_PLAYABLE_TYPES.has(mime)) return true;
    if (MP4_EXTENSIONS.has(ext) || WEBM_EXTENSIONS.has(ext)) return true;
    return false;
}

/**
 * Check if a file needs full transcoding (truly incompatible).
 * This replaces the old `needsTransmux()` for the transcode decision.
 */
export function isNeverNative(file) {
    return NEVER_NATIVE.has(getExtension(file.name));
}
