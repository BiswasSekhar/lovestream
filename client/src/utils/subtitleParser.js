/**
 * Parses SRT subtitle files into an array of cues.
 * @param {string} text - Raw SRT file content
 * @returns {Array<{id: number, start: number, end: number, text: string}>}
 */
export function parseSRT(rawText) {
    const cues = [];
    // Strip BOM and normalise all line-ending variants (\r\n, \r, \n)
    const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const blocks = text.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 2) continue;

        // Find the timestamp line — it may be line 0 (no index) or line 1
        let tsLineIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 2); i++) {
            if (/-->/.test(lines[i])) { tsLineIdx = i; break; }
        }
        if (tsLineIdx === -1) continue;

        const timeMatch = lines[tsLineIdx].match(
            /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;

        const id = tsLineIdx > 0 ? parseInt(lines[0], 10) || cues.length + 1 : cues.length + 1;
        const start = timeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
        const end = timeToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
        const cueText = lines.slice(tsLineIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();

        if (cueText) {
            cues.push({ id, start, end, text: cueText });
        }
    }

    return cues;
}

/**
 * Parses ASS/SSA subtitle files into an array of cues.
 * @param {string} text - Raw ASS file content
 * @returns {Array<{id: number, start: number, end: number, text: string, style: string}>}
 */
export function parseASS(rawText) {
    const cues = [];
    const lines = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    let inEvents = false;
    let formatFields = [];
    let id = 0;

    for (const line of lines) {
        if (line.startsWith('[Events]')) {
            inEvents = true;
            continue;
        }
        if (line.startsWith('[') && inEvents) {
            break; // Next section
        }
        if (!inEvents) continue;

        if (line.startsWith('Format:')) {
            formatFields = line
                .slice(7)
                .split(',')
                .map((f) => f.trim().toLowerCase());
            continue;
        }

        if (line.startsWith('Dialogue:')) {
            const values = line.slice(9).split(',');
            const startIdx = formatFields.indexOf('start');
            const endIdx = formatFields.indexOf('end');
            const styleIdx = formatFields.indexOf('style');
            const textIdx = formatFields.indexOf('text');

            if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;

            const startTime = parseASSTime(values[startIdx]?.trim());
            const endTime = parseASSTime(values[endIdx]?.trim());
            const style = values[styleIdx]?.trim() || 'Default';
            // Text field may contain commas, so join everything from textIdx onwards
            const subtitleText = values
                .slice(textIdx)
                .join(',')
                .trim()
                .replace(/\{[^}]+\}/g, '') // Remove ASS style overrides like {\b1}
                .replace(/\\N/g, '\n')      // Convert ASS newlines
                .replace(/\\n/g, '\n');

            cues.push({ id: ++id, start: startTime, end: endTime, text: subtitleText, style });
        }
    }

    return cues;
}

function parseASSTime(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/(\d+):(\d{2}):(\d{2})[.](\d{2})/);
    if (!match) return 0;
    return (
        parseInt(match[1], 10) * 3600 +
        parseInt(match[2], 10) * 60 +
        parseInt(match[3], 10) +
        parseInt(match[4], 10) / 100
    );
}

function timeToSeconds(h, m, s, ms) {
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
}

/**
 * Auto-detect format by filename extension and parse.
 */
export function parseSubtitles(text, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'srt') return parseSRT(text);
    if (ext === 'ass' || ext === 'ssa') return parseASS(text);
    throw new Error(`Unsupported subtitle format: .${ext}`);
}
