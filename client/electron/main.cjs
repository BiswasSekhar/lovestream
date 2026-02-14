const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let vlcInstance = null;
let createVlcFactory = null;

/* ── Locate bundled VLC binary from vlc-static ── */
function findVlcBinary() {
    const possibleBases = [];

    if (app.isPackaged) {
        possibleBases.push(
            path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'vlc-static')
        );
    }
    possibleBases.push(
        path.join(__dirname, '..', 'node_modules', 'vlc-static')
    );

    const platform = process.platform === 'win32' ? 'windows'
        : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'x64' ? 'x64' : 'ia32';
    const exeName = process.platform === 'win32' ? 'vlc.exe' : 'vlc';

    for (const base of possibleBases) {
        try {
            const binDir = path.join(base, 'bin', platform, arch);
            if (!fs.existsSync(binDir)) continue;

            const entries = fs.readdirSync(binDir);
            const vlcDir = entries.find((e) => e.startsWith('vlc-'));
            if (!vlcDir) continue;

            const vlcPath = path.join(binDir, vlcDir, exeName);
            if (fs.existsSync(vlcPath)) {
                console.log('[vlc] Found binary:', vlcPath);
                return vlcPath;
            }
        } catch { }
    }
    return null;
}

async function ensureVlc() {
    if (vlcInstance) return vlcInstance;

    if (!createVlcFactory) {
        const module = await import('@richienb/vlc');
        createVlcFactory = module.default;
    }

    vlcInstance = await createVlcFactory();
    return vlcInstance;
}

async function stopVlcPlayback() {
    if (!vlcInstance) return;
    try {
        await vlcInstance.command('pl_stop');
    } catch { }
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

function registerVlcIpc() {
    ipcMain.handle('native-vlc:is-available', async () => {
        try {
            await ensureVlc();
            return { available: true };
        } catch (error) {
            return { available: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-vlc:play-file', async (_event, payload = {}) => {
        const { filePath, startTime = 0 } = payload;
        if (!filePath) {
            return { success: false, error: 'Missing filePath' };
        }

        try {
            const vlc = await ensureVlc();
            await vlc.command('in_play', { input: filePath });
            if (Number(startTime) > 0) {
                await vlc.command('seek', { val: Math.floor(Number(startTime)) });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-vlc:play-buffer', async (_event, payload = {}) => {
        const { bytes, fileName = 'movie.mp4', startTime = 0 } = payload;
        if (!bytes) {
            return { success: false, error: 'Missing bytes payload' };
        }

        try {
            const tempDir = path.join(os.tmpdir(), 'lovestream-vlc-cache');
            fs.mkdirSync(tempDir, { recursive: true });
            const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
            const tempPath = path.join(tempDir, `${Date.now()}-${safeName}`);

            const buffer = Buffer.from(bytes);
            fs.writeFileSync(tempPath, buffer);

            const vlc = await ensureVlc();
            await vlc.command('in_play', { input: tempPath });
            if (Number(startTime) > 0) {
                await vlc.command('seek', { val: Math.floor(Number(startTime)) });
            }

            return { success: true, filePath: tempPath };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-vlc:command', async (_event, payload = {}) => {
        const { name, options } = payload;
        if (!name) return { success: false, error: 'Missing command name' };

        try {
            const vlc = await ensureVlc();
            await vlc.command(name, options);
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('native-vlc:info', async () => {
        try {
            const vlc = await ensureVlc();
            const info = await vlc.info();
            return { success: true, info };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    /* ── VLC smart process: remux (fast) or full transcode ── */
    ipcMain.handle('native-vlc:process-file', async (_event, { inputPath, forceVideoTranscode = false }) => {
        const vlcBin = findVlcBinary();
        if (!vlcBin) return { success: false, error: 'VLC binary not found' };
        if (!inputPath || !fs.existsSync(inputPath))
            return { success: false, error: 'Input file not found: ' + inputPath };

        const tempDir = path.join(os.tmpdir(), 'lovestream-vlc');
        fs.mkdirSync(tempDir, { recursive: true });
        const outputPath = path.join(tempDir, `${Date.now()}.mp4`);
        const outputPathForVlc = outputPath.replace(/\\/g, '/');

        const mode = forceVideoTranscode ? 'full transcode (H.264+AAC)' : 'fast remux (copy video, AAC audio)';
        console.log(`[vlc] ${mode}`);
        console.log('[vlc] Input :', inputPath);
        console.log('[vlc] Output:', outputPath);

        return new Promise((resolve) => {
            let sout;
            if (forceVideoTranscode) {
                // Full transcode: re-encode video to H.264, audio to AAC
                sout = [
                    '#transcode{vcodec=h264,venc=x264{preset=ultrafast},',
                    'acodec=aac,ab=192,channels=2,samplerate=48000}',
                    `:standard{access=file,mux=mp4,dst='${outputPathForVlc}'}`
                ].join('');
            } else {
                // Fast remux: copy video streams as-is, only transcode audio to AAC
                sout = [
                    '#transcode{vcodec=copy,acodec=aac,ab=192,channels=2,samplerate=48000,scodec=none}',
                    `:standard{access=file,mux=mp4,dst='${outputPathForVlc}'}`
                ].join('');
            }

            const args = [
                '-I', 'dummy',
                '--no-video-title-show',
                '--no-repeat',
                '--no-loop',
                inputPath,
                '--sout', sout,
                'vlc://quit'
            ];

            console.log('[vlc] Spawning VLC…');
            const child = spawn(vlcBin, args, { stdio: 'pipe', windowsHide: true });
            const timeoutMs = forceVideoTranscode ? 10 * 60 * 1000 : 3 * 60 * 1000;
            let settled = false;
            const finalize = (payload) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(payload);
            };

            let stderr = '';
            let stdout = '';
            child.stdout?.on('data', (d) => { stdout += d.toString(); });
            child.stderr?.on('data', (d) => { stderr += d.toString(); });

            const timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { }
                console.error('[vlc] Timeout waiting for process-file to complete');
                finalize({ success: false, error: `VLC timed out after ${Math.round(timeoutMs / 1000)}s` });
            }, timeoutMs);

            child.on('close', (code) => {
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                    console.log('[vlc] Done —', fs.statSync(outputPath).size, 'bytes');
                    finalize({ success: true, outputPath });
                } else {
                    console.error('[vlc] Failed. code:', code, stderr.slice(-500) || stdout.slice(-500));
                    const details = (stderr || stdout).slice(-300);
                    const message = details
                        ? `VLC exited ${code}: ${details}`
                        : `VLC exited ${code} without producing output file`;
                    finalize({ success: false, error: message });
                }
            });

            child.on('error', (err) => {
                console.error('[vlc] Spawn error:', err);
                finalize({ success: false, error: err.message });
            });
        });
    });

    /* ── Read a local file and return its bytes (for transcoded output) ── */
    ipcMain.handle('native-vlc:read-file', async (_event, { filePath }) => {
        try {
            if (!filePath || !fs.existsSync(filePath))
                return { success: false, error: 'File not found' };
            const data = fs.readFileSync(filePath);
            const bytes = Uint8Array.from(data);
            return { success: true, bytes };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    /* ── Save bytes to a temp file (for blobs without file.path) ── */
    ipcMain.handle('native-vlc:save-temp-file', async (_event, { bytes, fileName }) => {
        try {
            const tempDir = path.join(os.tmpdir(), 'lovestream-vlc');
            fs.mkdirSync(tempDir, { recursive: true });
            const safeName = String(fileName || 'input').replace(/[^a-zA-Z0-9._-]/g, '_');
            const tempPath = path.join(tempDir, `${Date.now()}-${safeName}`);
            fs.writeFileSync(tempPath, Buffer.from(bytes));
            return { success: true, filePath: tempPath };
        } catch (err) {
            return { success: false, error: err.message };
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
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { });
