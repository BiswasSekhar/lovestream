const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let vlcInstance = null;
let createVlcFactory = null;

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
    registerVlcIpc();
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    stopVlcPlayback();
});
