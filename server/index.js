import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { Server as TrackerServer } from 'bittorrent-tracker';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { createReadStream, promises as fs } from 'fs';
import RoomManager from './roomManager.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import registerSocketHandlers from './socketHandlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const PORT = process.env.PORT || 3001;
const upload = multer({
    dest: join(__dirname, '.tmp-transcode'),
    limits: {
        fileSize: 1024 * 1024 * 1024, // 1GB
    },
});

// CORS — allow any origin for tunnel/remote access
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});

// Socket.IO
const io = new Server(httpServer, {
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// Room manager
const roomManager = new RoomManager();

// Register socket handlers
registerSocketHandlers(io, roomManager);

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', rooms: roomManager.rooms.size });
});

// ICE server config endpoint
app.get('/ice-servers', (_req, res) => {
    const servers = [
        { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];

    if (process.env.TURN_URL) {
        servers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || '',
        });
    }

    res.json(servers);
});

app.post('/transcode', upload.single('video'), async (req, res) => {
    const uploaded = req.file;
    if (!uploaded) {
        res.status(400).json({ error: 'No video file uploaded' });
        return;
    }

    if (!ffmpegPath) {
        await fs.unlink(uploaded.path).catch(() => { });
        res.status(500).json({ error: 'FFmpeg binary is not available on server' });
        return;
    }

    const inputPath = uploaded.path;
    const outputPath = `${uploaded.path}.streamable.mp4`;
    const outputName = `${(uploaded.originalname || 'video').replace(/\.[^/.]+$/, '')}.streamable.mp4`;

    const args = [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '24',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
    ];

    let stderr = '';

    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });
    ffmpeg.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    ffmpeg.on('error', async (err) => {
        await fs.unlink(inputPath).catch(() => { });
        await fs.unlink(outputPath).catch(() => { });
        res.status(500).json({ error: `Failed to start ffmpeg: ${err.message}` });
    });

    ffmpeg.on('close', async (code) => {
        if (code !== 0) {
            await fs.unlink(inputPath).catch(() => { });
            await fs.unlink(outputPath).catch(() => { });
            res.status(500).json({ error: `Transcode failed (${code}): ${stderr.slice(-1200)}` });
            return;
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);

        const stream = createReadStream(outputPath);
        stream.pipe(res);

        stream.on('close', async () => {
            await fs.unlink(inputPath).catch(() => { });
            await fs.unlink(outputPath).catch(() => { });
        });
    });
});

// Serve static files from the React client build
app.use(express.static(join(__dirname, '../client/dist')));

// Handle React routing, return all requests to React app
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../client/dist', 'index.html'));
});

// WebTorrent tracker (peer discovery for P2P movie sharing)
const tracker = new TrackerServer({
    http: false,  // no HTTP tracker
    udp: false,   // no UDP tracker
    ws: true,     // WebSocket tracker only
});

tracker.on('error', (err) => {
    console.error('[tracker] error:', err.message);
});

tracker.on('warning', (err) => {
    console.warn('[tracker] warning:', err.message);
});

httpServer.listen(PORT, () => {
    console.log(`🚀 Lovestream server running on port ${PORT}`);
    console.log(`   Accepting connections from: ${CLIENT_URL}`);

    // ─── Manual Upgrade Handling ────────────────────────────
    // Socket.IO and WebTorrent tracker both want to handle WebSockets on the same port.
    // We must manually route the upgrade requests to prevent conflicts.

    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
        // Pass the WebSocket connection to the tracker
        tracker.onWebSocketConnection(ws);
    });

    httpServer.on('upgrade', (req, socket, head) => {
        if (req.url.startsWith('/socket.io/')) {
            // Let Socket.IO handle it (it attaches its own listener)
            return;
        }

        // Otherwise, handle as WebTorrent tracker request
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    console.log(`   WebTorrent tracker ready on ws://localhost:${PORT}`);

    // Keep alive — prevent Render free-tier idle shutdown (~15 min inactivity spin-down)
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`).catch(() => { });
    }, 10 * 60 * 1000); // every 10 minutes
});
