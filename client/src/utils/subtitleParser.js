/**
 * Parses SRT subtitle files into an array of cues.
 * @param {string} text - Raw SRT file content
 * @returns {Array<{id: number, start: number, end: number, text: string}>}
 */
export function parseSRT(text) {
    const cues = [];
    const blocks = text.trim().replace(/\r\n/g, '\n').split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 3) continue;

        const id = parseInt(lines[0], 10);
        const timeMatch = lines[1].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;

        const start = timeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
        const end = timeToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
        const text = lines.slice(2).join('\n').replace(/<[^>]+>/g, ''); // Strip HTML tags

        cues.push({ id, start, end, text });
    }

    return cues;
}

/**
 * Parses ASS/SSA subtitle files into an array of cues.
 * @param {string} text - Raw ASS file content
 * @returns {Array<{id: number, start: number, end: number, text: string, style: string}>}
 */
export function parseASS(text) {
    const cues = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');

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
