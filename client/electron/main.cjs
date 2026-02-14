const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { });
