const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
/* ── Locate FFmpeg binary ── */
let ffmpegPath;
try {
    ffmpegPath = require('ffmpeg-static');
} catch {
    ffmpegPath = null;
}

function runFfmpegJob({ inputPath, outputPath, forceVideoTranscode }) {
    const timeoutMs = forceVideoTranscode ? 12 * 60 * 1000 : 4 * 60 * 1000;

    const args = forceVideoTranscode
        ? [
            '-y',
            '-i', inputPath,
            '-map', '0:v:0?',
            '-map', '0:a:0?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', '+faststart',
            '-sn',
            outputPath,
        ]
        : [
            '-y',
            '-i', inputPath,
            '-map', '0:v:0?',
            '-map', '0:a:0?',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', '+faststart',
            '-sn',
            outputPath,
        ];

    return new Promise((resolve) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: 'pipe' });
        let stderr = '';
        let stdout = '';
        let settled = false;

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(payload);
        };

        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { }
            finish({ success: false, error: `FFmpeg timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);

        child.on('error', (error) => {
            finish({ success: false, error: error?.message || String(error) });
        });

        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                finish({ success: true, outputPath });
                return;
            }
            const details = (stderr || stdout).slice(-600);
            finish({
                success: false,
                error: details
                    ? `FFmpeg exited ${code}: ${details}`
                    : `FFmpeg exited ${code} without producing output file`,
            });
        });
    });
}

/* ═══════════════════════════════════════════════════════════════════
 *  Local File Streaming Server
 *
 *  Creates a localhost HTTP server that serves local files with
 *  proper Content-Range support. This enables progressive playback:
 *  the <video> element can start playing immediately while still
 *  downloading, and can seek by requesting byte ranges.
 *
 *  This is the same technique Stremio uses: torrent data is served
 *  via a local HTTP server, and the video player connects to
 *  http://localhost:PORT/stream
 * ═══════════════════════════════════════════════════════════════════ */

let streamServer = null;
let streamServerPort = null;
let activeStreams = new Map(); // id -> { filePath, mimeType }
let nextStreamId = 1;
let jitStreams = new Map(); // id -> { child, clients, history, historyBytes, ended, stderrTail }
let nextJitStreamId = 1;
const JIT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

function buildJitFfmpegArgs(mode = 'remux') {
    const videoArgs = mode === 'transcode'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'copy'];

    return [
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+genpts',
        '-i', 'pipe:0',
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        ...videoArgs,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1',
    ];
}

function spawnJitStreamSession(mode = 'remux') {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        return { error: 'FFmpeg binary not found' };
    }

    const id = nextJitStreamId++;
    const args = buildJitFfmpegArgs(mode);
    const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session = {
        id,
        mode,
        child,
        clients: new Set(),
        history: [],
        historyBytes: 0,
        ended: false,
        stderrTail: '',
    };

    child.stdout.on('data', (chunk) => {
        const buffer = Buffer.from(chunk);

        if (session.historyBytes < JIT_HISTORY_MAX_BYTES) {
            const remaining = JIT_HISTORY_MAX_BYTES - session.historyBytes;
            const capped = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
            session.history.push(capped);
            session.historyBytes += capped.length;
        }

        for (const res of session.clients) {
            if (!res.writableEnded) {
                try { res.write(buffer); } catch { }
            }
        }
    });

    child.stderr.on('data', (chunk) => {
        session.stderrTail = (session.stderrTail + chunk.toString()).slice(-1200);
    });

    const handleExit = (code, signal) => {
        session.ended = true;
        for (const res of session.clients) {
            if (!res.writableEnded) {
                try { res.end(); } catch { }
            }
        }
        session.clients.clear();
        jitStreams.delete(id);

        if (code !== 0) {
            const detail = session.stderrTail ? ` | ${session.stderrTail}` : '';
            console.warn(`[jit-stream] session ${id} exited code=${code} signal=${signal || 'none'}${detail}`);
        }
    };

    child.on('error', (err) => {
        session.stderrTail = (session.stderrTail + ` | spawn error: ${err?.message || err}`).slice(-1200);
    });
    child.on('close', handleExit);

    jitStreams.set(id, session);
    return { session };
}

function destroyJitStreamSession(streamId) {
    const id = Number(streamId);
    const session = jitStreams.get(id);
    if (!session) return false;

    session.ended = true;
    for (const res of session.clients) {
        if (!res.writableEnded) {
            try { res.end(); } catch { }
        }
    }
    session.clients.clear();
    jitStreams.delete(id);

    try { session.child.stdin.destroy(); } catch { }
    try { session.child.stdout.destroy(); } catch { }
    try { session.child.stderr.destroy(); } catch { }
    try { session.child.kill('SIGKILL'); } catch { }
    return true;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimes = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.ts': 'video/mp2t',
        '.wmv': 'video/x-ms-wmv',
    };
    return mimes[ext] || 'application/octet-stream';
}

function ensureStreamServer() {
    return new Promise((resolve, reject) => {
        if (streamServer && streamServerPort) {
            resolve(streamServerPort);
            return;
        }

        streamServer = http.createServer((req, res) => {
            // CORS headers for Electron renderer
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Range');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            // URL format: /jit/<id> (FFmpeg stdin->stdout live stream)
            const jitMatch = req.url.match(/^\/jit\/(\d+)/);
            if (jitMatch) {
                const jitId = parseInt(jitMatch[1], 10);
                const session = jitStreams.get(jitId);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('JIT stream not found');
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive',
                    'Accept-Ranges': 'none',
                });

                // Replay early initialization bytes (fMP4 headers/moov) for late attach.
                for (const chunk of session.history) {
                    try { res.write(chunk); } catch { }
                }

                session.clients.add(res);

                req.on('close', () => {
                    session.clients.delete(res);
                });

                if (session.ended && !res.writableEnded) {
                    try { res.end(); } catch { }
                }
                return;
            }

            // URL format: /stream/<id>
            const match = req.url.match(/^\/stream\/(\d+)/);
            if (!match) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
                return;
            }

            const streamId = parseInt(match[1], 10);
            const entry = activeStreams.get(streamId);
            if (!entry || !fs.existsSync(entry.filePath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Stream not found');
                return;
            }

            const stat = fs.statSync(entry.filePath);
            const fileSize = stat.size;
            const mime = entry.mimeType || getMimeType(entry.filePath);

            // Handle Range requests for seeking
            const rangeHeader = req.headers.range;
            if (rangeHeader) {
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mime,
                });

                const stream = fs.createReadStream(entry.filePath, { start, end });
                stream.pipe(res);
                stream.on('error', () => { try { res.end(); } catch { } });
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': mime,
                    'Accept-Ranges': 'bytes',
                });

                const stream = fs.createReadStream(entry.filePath);
                stream.pipe(res);
                stream.on('error', () => { try { res.end(); } catch { } });
            }
        });

        // Listen on random port on localhost only
        streamServer.listen(0, '127.0.0.1', () => {
            streamServerPort = streamServer.address().port;
            console.log(`[stream-server] Local streaming server on http://127.0.0.1:${streamServerPort}`);
            resolve(streamServerPort);
        });

        streamServer.on('error', (err) => {
            console.error('[stream-server] Error:', err.message);
            reject(err);
        });
    });
}

function registerStreamServerIpc() {
    // Register a local file for streaming. Returns a URL the renderer can use as <video src>.
    ipcMain.handle('stream-server:register', async (_event, { filePath }) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'File not found' };
            }

            const port = await ensureStreamServer();
            const id = nextStreamId++;
            activeStreams.set(id, {
                filePath,
                mimeType: getMimeType(filePath),
            });

            const url = `http://127.0.0.1:${port}/stream/${id}`;
            console.log(`[stream-server] Registered stream #${id}: ${filePath} → ${url}`);
            return { success: true, url, streamId: id };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    // Update an existing stream entry to a new backing file path.
    // This keeps the same /stream/<id> URL stable for the renderer.
    ipcMain.handle('stream-server:update', async (_event, { streamId, filePath }) => {
        try {
            const id = Number(streamId);
            if (!Number.isFinite(id) || !activeStreams.has(id)) {
                return { success: false, error: 'Stream not found' };
            }
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'File not found' };
            }

            const existing = activeStreams.get(id);
            activeStreams.set(id, {
                ...existing,
                filePath,
                mimeType: getMimeType(filePath),
            });

            const port = await ensureStreamServer();
            const url = `http://127.0.0.1:${port}/stream/${id}`;
            return { success: true, url, streamId: id };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    // Unregister a stream
    ipcMain.handle('stream-server:unregister', async (_event, { streamId }) => {
        activeStreams.delete(streamId);
        return { success: true };
    });
}

function registerJitStreamIpc() {
    ipcMain.handle('jit-stream:create', async (_event, { mode } = {}) => {
        try {
            const normalizedMode = mode === 'transcode' ? 'transcode' : 'remux';
            const port = await ensureStreamServer();
            const created = spawnJitStreamSession(normalizedMode);
            if (created.error || !created.session) {
                return { success: false, error: created.error || 'Failed to create JIT stream session' };
            }

            const streamId = created.session.id;
            const url = `http://127.0.0.1:${port}/jit/${streamId}`;
            return { success: true, streamId, url, mode: normalizedMode };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('jit-stream:push', async (_event, { streamId, bytes }) => {
        const id = Number(streamId);
        const session = jitStreams.get(id);
        if (!session || session.ended) {
            return { success: false, error: 'JIT stream session not found' };
        }

        try {
            if (!session.child.stdin || session.child.stdin.destroyed || !session.child.stdin.writable) {
                return { success: false, error: 'JIT stdin is not writable' };
            }
            const buffer = Buffer.from(bytes);
            const ok = session.child.stdin.write(buffer);
            return { success: true, backpressure: !ok };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('jit-stream:end', async (_event, { streamId }) => {
        const id = Number(streamId);
        const session = jitStreams.get(id);
        if (!session || session.ended) {
            return { success: false, error: 'JIT stream session not found' };
        }

        try {
            if (session.child.stdin && !session.child.stdin.destroyed) {
                session.child.stdin.end();
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('jit-stream:destroy', async (_event, { streamId }) => {
        const destroyed = destroyJitStreamSession(streamId);
        if (!destroyed) {
            return { success: false, error: 'JIT stream session not found' };
        }
        return { success: true };
    });
}

function registerNativeTranscoderIpc() {
    ipcMain.handle('native-transcoder:is-available', async () => {
        try {
            const available = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
            return {
                available,
                binary: available ? ffmpegPath : null,
            };
        } catch (error) {
            return { available: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-transcoder:process-file', async (_event, { inputPath, forceVideoTranscode = false }) => {
        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
            return { success: false, error: 'FFmpeg binary not found' };
        }
        if (!inputPath || !fs.existsSync(inputPath)) {
            return { success: false, error: `Input file not found: ${inputPath || 'missing'}` };
        }

        const tempDir = path.join(os.tmpdir(), 'lovestream-transcoder');
        fs.mkdirSync(tempDir, { recursive: true });
        const outputPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);

        const mode = forceVideoTranscode ? 'full-transcode-h264-aac' : 'fast-remux-copyvideo-aacaudio';
        console.log('[transcoder] mode:', mode);
        console.log('[transcoder] input:', inputPath);
        console.log('[transcoder] output:', outputPath);

        const result = await runFfmpegJob({ inputPath, outputPath, forceVideoTranscode });

        if (!result.success && !forceVideoTranscode) {
            console.log('[transcoder] remux failed, retrying full transcode');
            return await runFfmpegJob({ inputPath, outputPath, forceVideoTranscode: true });
        }

        return result;
    });

    ipcMain.handle('native-transcoder:read-file', async (_event, { filePath }) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'File not found' };
            }
            const data = fs.readFileSync(filePath);
            return { success: true, bytes: Uint8Array.from(data) };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-transcoder:save-temp-file', async (_event, { bytes, fileName }) => {
        try {
            const tempDir = path.join(os.tmpdir(), 'lovestream-transcoder');
            fs.mkdirSync(tempDir, { recursive: true });
            const safeName = String(fileName || 'input').replace(/[^a-zA-Z0-9._-]/g, '_');
            const tempPath = path.join(tempDir, `${Date.now()}-${safeName}`);
            fs.writeFileSync(tempPath, Buffer.from(bytes));
            return { success: true, filePath: tempPath };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });
}

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        autoHideMenuBar: true,
        icon: path.join(__dirname, '../public/favicon.ico')
    });

    // In development mode, load from localhost
    // In production, load from the built files
    const isDev = !app.isPackaged;

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Handle external links (open in browser)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https:')) {
            require('electron').shell.openExternal(url);
        }
        return { action: 'deny' };
    });
}

app.whenReady().then(() => {
    registerNativeTranscoderIpc();
    registerStreamServerIpc();
    registerJitStreamIpc();
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    for (const streamId of Array.from(jitStreams.keys())) {
        destroyJitStreamSession(streamId);
    }
    // Clean up stream server
    if (streamServer) {
        try { streamServer.close(); } catch { }
    }
});
